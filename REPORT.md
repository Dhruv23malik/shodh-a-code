# Stage 4 Verification Report — Shodh a Code

18 Nov 2026. All figures below come from commands actually run on this machine (PostgreSQL 16.15, Node 24.22, Ubuntu 24.04). Execution mode is labelled on every result. Nothing here is invented; where verification was impossible, it says so.

## 1. Architecture (as built)

NestJS API (`src/api`, `src/auth`) + PostgreSQL 16 + judge worker (`src/worker`) + Python runner in a sandboxed container (`src/judge/runner.py`, `judge/Dockerfile.runner`). The API runs migrations on boot; the worker runs them too (advisory-locked, idempotent). Dev auth only: `Bearer dev:<user-uuid>`.

## 2. Transaction boundaries

- **Submission creation** (`submissions.service.createSubmission`): one transaction inserts the submission and attempt 1 (`queued`), pinned to the problem's current version + suite. Idempotency is a DB unique key `(contest_id, author_id, idempotency_key)` with `ON CONFLICT DO NOTHING` + a payload comparison on replay (same payload → 200 with the same id; different code → `409 IDEMPOTENCY_CONFLICT`). Authorization runs *before* the idempotency lookup, so a key can never leak another user's submission.
- **Verdict application** (`worker.applyVerdict`): one transaction, conditional on `(status='running', worker_id)`; the submission is completed only if `current_attempt_no` still matches. 0 rows affected ⇒ a newer attempt superseded this one and the submission is untouched.
- **Rejudge**: one transaction inserts attempt N+1, bumps `current_attempt_no`, and marks any live prior attempt (`queued`/`running`) `superseded`. A stale worker's late verdict then affects 0 rows (`applyVerdict` requires `status='running'`); completed attempts are history and stay untouched.
- **Reaper**: per stale attempt, one transaction (row locked, re-checked inside): requeue while `requeue_count < 3`, else fail as `judge_error`.
- **Problem/version creation**: one transaction (problem + version + suite + cases).

## 3. Retry / rejudge behaviour

A judge infra failure never writes a student verdict: the attempt is left `running`, its heartbeat goes stale, and the reaper requeues it (max 3 times, then `judge_error`, which never reduces a score — it is excluded from authoritative attempts). A rejudge's new attempt becomes authoritative only once it completes; the old attempt's result cannot overwrite the submission: rejudge supersedes live prior attempts in the same transaction, so a late verdict affects 0 rows (test (c)).

## 4. Isolation choices

Per-attempt fresh container as uid 10001, `--network none`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, read-only rootfs, 64 MB `/tmp` tmpfs, `--cpus 0.5`, `--memory 128m`, `--pids-limit 64`; in-runner `RLIMIT_CPU/AS/FSIZE/NPROC` + wall-clock kill. Docker socket is mounted read-only into the trusted worker only. The runner never prints test data or student output; the API never selects `input`/`expected_output` for participant reads (verified by test: participant problem views contain only `position`/`name`/`isHidden`). Limits: Python only; no per-user rate limiting; dev-auth is a fixture, not production auth.

## 5. Performance evidence

### Double-mode workload (real API + real worker, `JUDGE_MODE=double`, local PostgreSQL)

Command: `npx ts-node -T scripts/workload.ts --mode double --users 10 --subs 30 --concurrency 5`
Full file: `results/results-double-2026-11-18T15-18-58-127Z.json` (dataset: seed Acme Weekly #1 / Add Two Numbers; mix: 30 submissions cycling correct/wrong/runtime_error + 1 leaderboard read each + status polling).

| Op | p50 | p95 | p99 | count | errors |
| --- | --- | --- | --- | --- | --- |
| submit | 13.9 ms | 142.1 ms | 143.1 ms | 30 | 0 |
| status | 5.7 ms | 18.5 ms | 34.0 ms | 85 | 0 |
| leaderboard | 12.8 ms | 25.5 ms | 29.9 ms | 30 | 0 |

Throughput 24.19 req/s over 5.99 s (145 requests, 0 errors). Queue delay (submit accepted → attempt completed) p50 1,030 ms / p95 1,175 ms / max 1,176 ms (n=30) — dominated by the worker's 1 s claim poll interval, not by judging. Judge runtime (program execution, excluding API) p50/p95 5 ms (n=90 cases — the double returns immediately). API overhead and program execution are therefore cleanly separated: the API answers in ~6–14 ms at p50; end-to-end latency is the poll interval.

### Leaderboard query plan (real PostgreSQL, `EXPLAIN ANALYZE`)

Data: seed + generated bulk load — 1,084 submissions, 1,444 attempts, 66 participants. Plans: `results/explain-before-002.txt`, `results/explain-after-002.txt`.

- **Before 002:** 5.526 / 5.375 / 5.445 ms (median 5.445 ms). The `auth` CTE does a **Seq Scan on attempts (1,443 rows) + quicksort (132 kB)** for the `DISTINCT ON (submission_id) ... ORDER BY attempt_no DESC`; the per-user aggregation + ranking sort is the larger share (~5 ms total).
- **After 002** (partial index `attempts (submission_id, attempt_no DESC) WHERE status='completed' AND verdict IS NOT NULL AND verdict <> 'judge_error'`): 5.355 / 5.529 / 7.691 ms (median 5.529 ms). The planner **still chooses Seq Scan + Sort** — at 1,444 rows an index scan is not cheaper than scanning the table.
- **Honest conclusion: no measured improvement at this scale, and no bottleneck was measurable** — the query is ~5.4 ms end to end. The index is kept as a scale bet (it matches the authoritative-attempt predicate exactly, so it should remove the sort once attempts grow into the 100k+ range), but it is **not** a demonstrated win here. To reproduce at larger scale: load more attempts, then `EXPLAIN (ANALYZE, BUFFERS)` the query in `results/explain-before-002.txt` before/after `DROP/CREATE INDEX idx_attempts_auth_leaderboard`, and re-run `scripts/workload.ts --mode real`.

### pg-mem benchmark (emulator only — not database evidence)

`results/pgmem-benchmark-2026-11-18T15-07-11-503Z.json`: 60 users, 900 submissions, 1,260 attempts. Aggregates SQL median 2,636 ms before 002 → 2,558 ms after (pg-mem does not model index scans; the difference is noise). The aggregates SQL matched an independent JS simulation of the seed data exactly (180 rows). pg-mem cannot run the full leaderboard SQL (`EXTRACT(EPOCH FROM (timestamptz − timestamptz))` is unsupported there), so SQL-leaderboard equality was checked on real PostgreSQL instead (§7).

## 6. One investigated failure: crash before verdict (reaper recovery)

**Injected:** `DoubleRunner` behaviour `failpoint: 'crash_before_verdict'` on one submission (test `test/double/worker.test.ts` (b)). The runner computes the verdict, emits `judgeDone`, then throws `JudgeInfraError` — exactly like a real crash between judging and ack. (The worker-level failpoint of the same name calls `process.exit(1)` and is deliberately not used in tests.)
**Observed:** the worker emitted `infraError`, wrote nothing, and left the attempt `running` with a stale heartbeat. The reaper (1 s stale threshold in the test) emitted `requeue`; the worker re-claimed the attempt and judged it cleanly.
**Final stored outcome:** exactly one completed attempt, verdict `accepted`, score 100, submission `completed`, one `ack` total, one `requeue`; standings `100 points / 1 penalty minute`. No duplicate score, no lost verdict.

**Two divergences found while testing — both fixed during integration (not hidden):**
1. **Rejudge late result (test (c)) — FIXED.** The brief requires a stale worker's late verdict update to affect 0 rows. As first landed, neither the rejudge service nor the worker superseded attempt 1, so a late attempt-1 verdict was written (standings stayed correct only via the latest-attempt-no rule). Fix: `submissions.service.rejudge` now marks any live prior attempt `superseded` in the same transaction that creates attempt N+1; `applyVerdict`'s `(status='running', worker_id)` condition then yields 0 rows and emits `superseded`. Test (c) now asserts attempt 1 ends `superseded` with `verdict: null` and standings unchanged.
2. **`requeue_count` did not survive — FIXED.** The reaper stored it in `attempt.detail`, but `applyVerdict` overwrote `detail` wholesale. `APPLY_VERDICT_SQL` now merges (`detail = detail || $3::jsonb`), preserving `requeue_count` while the new verdict detail overwrites same-named keys.
3. **Test-design fix:** a 4 s judge with a 1 s stale threshold is (correctly) requeued mid-judge by the reaper — the first version of test (c)/(d) was flaky for exactly this reason. Stale thresholds in those tests are now 30 s (production: heartbeat 15 s, stale 120 s).

## 7. Verification results

- `npx tsc --noEmit`: clean. `npm test` (`--runInBand`): **48 passed, 0 failed, twice in a row**, against real PostgreSQL 16: 33 unit (scoring hand-computed cases incl. tie-breaks and the 0 floor; errors; pagination clamping), 5 pg-mem contract-invariant tests, 4 real-worker integration tests (a) exactly-one claim, (b) reaper recovery, (c) rejudge, (d) out-of-order completion with SQL-leaderboard == `computeStandings`, 6 API supertest tests (flow, idempotency 200/409, cross-org 404, participant-organizer 403, hidden-data, organizer-cannot-submit, unauthenticated 401). DB-dependent suites skip gracefully (with a printed reason) when `DATABASE_URL` is unreachable.
- `scripts/rebuild-standings.ts --contest <acme>`: exit 0 via the SQL fallback **and** via the live HTTP leaderboard (after the workload's 30 judged submissions).
- `npm run openapi`: `docs/openapi.json` parses; 14 paths, all endpoints from the controllers.
- `npm run migrate` applied `001_init.sql` + `002_leaderboard_auth_attempts_idx.sql`; `npm run seed` completed.

## 8. Known limitations / not verified on this VM

- **Docker / real runner: not verified.** The VM's Docker daemon cannot start via systemd (iptables permission denied — this VM lacks NET_ADMIN), and although a manually started `dockerd --iptables=false --bridge=none` runs, image pulls from Docker Hub time out (TLS handshake timeout, twice) and no base images are cached — so `docker compose up --build`, `RealRunner`, and the real-mode workload could not run here. `src/judge/runner.py` itself was executed directly (no container): `correct.py` → `accepted` (all cases pass, exit 0); the worker agent also smoke-tested wrong output, timeout, compile error and output-limit cases the same way. Double-mode evidence covers the API/worker/scoring paths; only container execution is unverified.
- **Migration 002: no measured benefit** at the tested scale (§5); kept as a scale bet.
- **Workload scale:** 30 submissions is a smoke-sized run; the script supports larger `--users/--subs/--concurrency`.
- **Local DB state:** this VM's `shodh` database currently holds the seed data plus 2 worker-test users and 4 leftover test submissions (the ~1,080 bulk EXPLAIN rows were truncated by the worker test fixtures, which wipe all tables). Reset before a clean demo: `DROP DATABASE shodh; CREATE DATABASE shodh;` then `npm run migrate && npm run seed`.
- The §6 divergences (rejudge late result, `requeue_count` overwrite) were both fixed during integration and are re-tested by test (c) and the reaper-recovery test.
