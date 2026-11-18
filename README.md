# Shodh a Code

A coding-contest platform backend: NestJS API + PostgreSQL + a Docker-sandboxed judge worker. Students submit Python programs; each submission is judged in a fresh, throwaway container; leaderboards are computed deterministically from the stored attempts.

## Architecture

```
                    ┌──────────────┐   claim (FOR UPDATE SKIP LOCKED)
                    │    worker    │   conditional verdict write
                    │  (Nest-free  │────────────────────────────┐
                    │   TS process)│   reaper (stale heartbeat) │
                    └──────┬───────┘                            │
                           │ spawns per attempt                 ▼
                    ┌──────▼───────┐   ┌─────────────────────────────────┐
                    │ runner       │   │  PostgreSQL 16                  │
                    │ container    │   │  organizations, users, org_     │
                    │ (uid 10001,  │   │  memberships, contests, contest │
                    │  no network, │   │  _participants, problems,       │
                    │  read-only   │   │  problem_versions, test_suites, │
                    │  rootfs)     │   │  test_cases, submissions,       │
                    └──────────────┘   │  attempts, schema_migrations    │
                                        └──────────────▲──────────────────┘
┌──────────────┐  HTTP (dev-auth)                     │
│  API (NestJS)│──────────────────────────────────────┘
│  :3000       │  runs migrations on boot
└──────────────┘
```

- **API** (`src/main.ts`, `src/api/`, `src/auth/`): contests, orgs, problems (+ immutable versions + test suites), submissions (+ idempotency), leaderboard, rejudge. Runs migrations on boot.
- **Worker** (`src/worker-main.ts`, `src/worker/`): claim loop (concurrency 2) + reaper. Claiming is one `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)`; verdicts are applied in one transaction conditional on `(status='running', worker_id)`; infra failures never write a student verdict — the attempt is left `running` and the reaper requeues it (up to 3 times, then `judge_error`).
- **Judge** (`src/worker/runner.ts`, `src/judge/runner.py`): `RealRunner` spawns one sandboxed Docker container per attempt (`--network none --user 10001 --cap-drop=ALL --read-only`, CPU/memory/pids/output caps); `DoubleRunner` is a deterministic in-process double (`JUDGE_MODE=double`) with scripted per-attempt behaviour and failpoints for tests.
- **Scoring** (`src/core/scoring.ts`, the canonical definition): per (user, problem), the authoritative attempt of a submission is its latest completed attempt with verdict ≠ `judge_error`. Solved ⇔ some submission has authoritative verdict `accepted`. `points = solved ? max(0, 100 − penaltyPerWrong × wrongBeforeAccept) : 0`; `penaltyMinutes = solved ? minutes(opensAt → firstAcceptAt) + 20 × wrongBeforeAccept : 0`. Ranking: totalScore DESC, totalPenaltyMinutes ASC, userId ASC. The leaderboard SQL (`src/api/leaderboard.service.ts`) and the rebuild script (`scripts/rebuild-standings.ts`, via `scripts/leaderboard-sql.ts`) implement exactly this; `test/double/worker.test.ts` (d) and the rebuild script assert they agree.

## Run it

```bash
docker compose up --build
```

This starts `postgres` (16-alpine), builds the `shodh-runner:latest` image, then `api` on http://localhost:3000 and `worker` (real judge mode). The API runs migrations on boot. Seed the demo data:

```bash
docker compose exec api npx ts-node -T scripts/seed.ts
```

Note: the compose `postgres` service publishes no host port, so host-side commands that need the database (`npm run migrate`, `npm run seed`, `npm test`, `scripts/workload.ts`, `scripts/rebuild-standings.ts`) cannot reach it as shipped. Run them against a local PostgreSQL instead (see "Local development" below), or add a `ports: ["5432:5432"]` mapping to the compose file.

### Local development (no Docker)

```bash
# PostgreSQL 16 locally, database `shodh`, user postgres / postgres
npm run migrate   # applies migrations/*.sql
npm run seed      # demo orgs/users/contests/problems (idempotent)
npm run dev:api   # API on :3000 (JUDGE_MODE=double for no-Docker judging)
# in a second terminal:
JUDGE_MODE=double npx ts-node -T src/worker-main.ts
```

### Functional evaluation (one command, local Postgres)

```bash
npm run migrate && npm run seed && npm test
# plus the standalone checks:
npm run openapi   # validates docs/openapi.json, prints the 14 paths
DATABASE_URL=postgres://postgres:postgres@localhost:5432/shodh \
  npx ts-node -T scripts/rebuild-standings.ts --contest c0000000-0001-4000-8000-000000000001
```

### Concurrent workload

```bash
# double mode (no Docker): API + worker running as above, then:
npx ts-node -T scripts/workload.ts --mode double --users 10 --subs 30 --concurrency 5
# real mode (Docker): docker compose up --build -d, then:
npx ts-node -T scripts/workload.ts --mode real --users 20 --subs 60 --concurrency 10
```

The workload submits the sample programs (`sample-programs/correct.py`, `wrong.py`, `runtime_error.py`, plus `timeout.py` and `big_output.py`) overlapping with leaderboard reads, and writes `results/results-<mode>-<ISO timestamp>.json` with latency percentiles per endpoint, throughput, errors by code, queue delay, and judge runtime separately. See `REPORT.md` for the numbers measured here.

## API docs

Full spec: [`docs/openapi.json`](docs/openapi.json) (OpenAPI 3.0, hand-written from the controllers; `npm run openapi` validates it). All errors are `{ "error": { "code": string, "message": string } }`.

Auth (dev fixture only): `Authorization: Bearer dev:<user-uuid>`. Unknown/missing token → `401 UNAUTHORIZED`. Seed identities: [`seed/IDENTITIES.md`](seed/IDENTITIES.md).

```bash
API=http://localhost:3000
PRIYA=aaaaaaaa-0003-4000-8000-000000000003   # participant, acme
ANA=aaaaaaaa-0001-4000-8000-000000000001     # organizer, acme
CONTEST=c0000000-0001-4000-8000-000000000001 # Acme Weekly #1 (open)
PROBLEM=10000000-0001-4000-8000-000000000001 # Add Two Numbers

curl $API/health
curl -H "Authorization: Bearer dev:$PRIYA" $API/contests/$CONTEST
curl -H "Authorization: Bearer dev:$PRIYA" -X POST $API/contests/$CONTEST/join
curl -H "Authorization: Bearer dev:$PRIYA" -X POST $API/contests/$CONTEST/submissions \
  -H 'Content-Type: application/json' \
  -d "{\"problemId\":\"$PROBLEM\",\"code\":\"import sys\nprint(sum(map(int, sys.stdin.read().split())))\",\"language\":\"python\",\"idempotencyKey\":\"demo-1\"}"
# 202 = created, 200 = idempotent replay (same key + same payload),
# 409 IDEMPOTENCY_CONFLICT = same key + different payload
curl -H "Authorization: Bearer dev:$PRIYA" $API/submissions/<submission-id>
curl -H "Authorization: Bearer dev:$PRIYA" "$API/contests/$CONTEST/leaderboard?page=1&limit=20"
curl -H "Authorization: Bearer dev:$PRIYA" $API/orgs/11111111-1111-4111-8111-111111111111/problems/$PROBLEM
curl -H "Authorization: Bearer dev:$ANA" -X POST $API/submissions/<submission-id>/rejudge \
  -H 'Content-Type: application/json' \
  -d '{"problemVersionId":"20000000-0001-4000-8000-000000000001","testSuiteId":"30000000-0001-4000-8000-000000000001"}'
```

## Scoring rules

See "Architecture" above and `src/core/scoring.ts`. Wrong verdicts (`wrong_answer`, `compile_error`, `runtime_error`, `time_limit`) before the first accept cost `penaltyPerWrong` points each (default 20) and 20 penalty minutes each; `judge_error` never counts — it is an infrastructure failure, not a student result. A later rejudge supersedes earlier attempts: only the latest completed non-`judge_error` attempt of a submission is authoritative.

## Authorization rules

- Non-members (and missing resources) always get `404 NOT_FOUND` — existence is never leaked. Members with the wrong role get `403 FORBIDDEN`.
- Organizers cannot submit to their own org's contests (`409 ORGANIZER_CANNOT_PARTICIPATE`); participants must join first (`409 NOT_A_PARTICIPANT`) and the contest must be open (`409 CONTEST_NOT_OPEN`).
- A submission is visible to its author and to org organizers only; anyone else gets `404`.
- Rejudge is organizer-only; the version/suite must belong to the submission's problem (`409 INVALID_VERSION`).
- Stable business error codes: `CONTEST_NOT_OPEN`, `CONTEST_NOT_FOUND`, `NOT_A_PARTICIPANT`, `ORGANIZER_CANNOT_PARTICIPATE`, `IDEMPOTENCY_CONFLICT`, `FORBIDDEN`, `NOT_FOUND`, `PROBLEM_NOT_FOUND`, `SUBMISSION_NOT_FOUND`, `INVALID_VERSION`, `UNAUTHORIZED` (see `src/core/errors.ts`).

## Submission / attempt state model

```
submission: queued -> running -> completed | failed
attempt:    queued -> running -> completed | failed | superseded
```

- Creating a submission inserts attempt 1 (`queued`) in the same transaction.
- The worker claims an attempt (`queued → running`), judges it, then applies the verdict (`running → completed`, score 100 if accepted else 0) and completes the submission — in one transaction, conditional on `(status='running', worker_id)`.
- Rejudge creates attempt N+1 (`queued`) and bumps `current_attempt_no`; the old attempt is left untouched and stays authoritative until the new one completes.
- A crashed/stalled worker's attempt stays `running` with a stale heartbeat; the reaper requeues it (up to 3 times), then fails it as `judge_error` and completes the submission. A `judge_error` never reduces a score.
- Attempts are unique per `(submission_id, attempt_no)`; submissions are unique per `(contest_id, author_id, idempotency_key)`.

## Dev-auth fixture + seed identities

Dev auth is `Bearer dev:<user-uuid>` (see `src/auth/auth.guard.ts`); it is a fixture for local evaluation, not production auth. Full seed table: [`seed/IDENTITIES.md`](seed/IDENTITIES.md). Key identities:

| Who | Role | UUID |
| --- | --- | --- |
| Ana Sharma | organizer (acme) | `aaaaaaaa-0001-4000-8000-000000000001` |
| Vikram Rao | organizer (vertex) | `aaaaaaaa-0002-4000-8000-000000000002` |
| Priya Nair | participant (acme) | `aaaaaaaa-0003-4000-8000-000000000003` |
| Arjun Mehta | participant (acme) | `aaaaaaaa-0004-4000-8000-000000000004` |
| Meera Iyer / Kabir Singh | participants (vertex) | `aaaaaaaa-0005-... / -0006-...` |

Contests (both `open`, 2026-11-01 → 2026-12-31, penalty 20): Acme Weekly #1 `c0000000-0001-...`, Vertex Sprint `c0000000-0002-...`. Problems (acme, v1, 3 cases each: 1 visible + 2 hidden): Add Two Numbers, FizzBuzz Lite, Sort Numbers.

## Isolation limits (summary)

Student code runs in a fresh container per attempt as uid 10001, `--network none`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, read-only rootfs with a 64 MB `/tmp` tmpfs, `--cpus 0.5`, `--memory 128m`, `--pids-limit 64`. Inside the runner, per-case limits are enforced with `resource` (`RLIMIT_CPU`, `RLIMIT_AS`, `RLIMIT_FSIZE` for output, `RLIMIT_NPROC`) plus a wall-clock timeout (time limit + 500 ms grace, process-group SIGKILL). The Docker socket is mounted read-only into the trusted worker only — never into runner containers (see `src/judge/SECURITY.md`). The runner never prints test inputs, expected outputs, or student output; per-case `detail` carries only generic labels (`exit_code:1`, `timeout_after:2000ms`). The API never selects `input`/`expected_output` for participant reads, and attempt `detail` never contains hidden test data or student code. Known limits: only Python is supported by the runner; there is no per-user rate limiting; the dev-auth fixture is not production authentication. Full details: `REPORT.md`.

## Verified here vs requires reviewer Docker

Verified on this machine on 18 Nov 2026 (PostgreSQL 16.15, Node 24; Docker daemon runs only with `--iptables=false --bridge=none` and registry pulls time out — see below):

- `npx tsc --noEmit` clean; `npm test`: **48 passed, 0 failed** (twice in a row) against real PostgreSQL — 33 unit tests (scoring/errors/pagination), 5 pg-mem contract-invariant tests (claim-once, reaper recovery, rejudge late-result, out-of-order leaderboard equality, `judge_error`-only), 4 real-worker integration tests (a)–(d) via `createWorker` + `DoubleRunner`, 6 API supertest tests (flow, idempotency, cross-org, hidden data, organizer rules, unauthenticated).
- `scripts/rebuild-standings.ts` exits 0 against both the SQL fallback and the live HTTP leaderboard (after the workload's 30 judged submissions).
- Double-mode workload measured (see `REPORT.md` and `results/results-double-*.json`); pg-mem benchmark + `EXPLAIN ANALYZE` before/after migration 002 recorded in `results/`.
- `npm run openapi` validates `docs/openapi.json` (14 paths).

Requires reviewer Docker (could NOT be verified here — the VM's Docker daemon cannot start via systemd (iptables permission denied, no NET_ADMIN); a manually started `dockerd --iptables=false --bridge=none` runs, but Docker Hub pulls time out and no base images are cached):

- `docker compose up --build` end-to-end boot, the real runner (`RealRunner` + `judge/Dockerfile.runner`), real-mode judging, and the real-mode workload command. The double-mode evidence above covers the API/worker/scoring paths; only the container execution path is unverified.
- Migration 002's index benefit: measured `EXPLAIN ANALYZE` shows **no improvement at the tested scale** (see `REPORT.md`) — the index is a scale bet, not a measured win here.
