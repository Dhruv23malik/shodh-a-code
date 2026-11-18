# Judge security — isolation limits and failure semantics

## What runs where

- **Worker** (`Dockerfile.worker`, Node): trusted. It owns the Docker
  socket (`/var/run/docker.sock`, mounted read-only into the worker
  container only) and spawns one short-lived runner container per
  attempt. It never executes student code itself.
- **Runner** (`judge/Dockerfile.runner`, `src/judge/runner.py`): untrusted
  student code executes here, exactly one attempt per container, which
  is discarded afterwards (`docker run --rm`).

## Isolation limits (per attempt)

| Limit | Mechanism |
|---|---|
| No network | `docker run --network none` |
| Non-root | `--user 10001` (uid 10001, created in the image); the process cannot write outside its mounts |
| CPU | `--cpus ${JUDGE_CPU}` (default 0.5) at container level; `RLIMIT_CPU` = ceil(time_limit_ms/1000)+1 s per case inside the runner |
| Memory | `--memory ${JUDGE_MEMORY_MB}m` (default 128) at container level; `RLIMIT_AS` = problem `memory_mb`, clamped to the container cap, per case |
| Processes | `--pids-limit ${JUDGE_PIDS_LIMIT}` (default 64); `RLIMIT_NPROC` = 64 in the runner |
| Output | `JUDGE_MAX_OUTPUT_BYTES` (default 1 MiB): `RLIMIT_FSIZE` caps every file the child writes, including the stdout/stderr capture files; a case that exceeds it gets outcome `output_limit` |
| Wall time | Per case: problem `time_limit_ms` + 500 ms grace (whole process group SIGKILLed on expiry → `time_limit`). Whole attempt: sum of per-case limits + 10 s grace at the worker (container killed by name) |
| Filesystem | `--read-only` rootfs; only `/tmp` is writable, as a `noexec,nosuid` tmpfs capped at 64 MiB; `/work` is a per-attempt temp dir (`os.tmpdir()/shodh-<attemptId>-<random>`) mounted for that attempt only and deleted in a `finally` (docker `--rm` + `fs.rm(..., force)`) |
| Privileges | `--cap-drop=ALL`, `--security-opt=no-new-privileges` |
| Host mounts | None. The Docker socket is mounted ONLY into the trusted worker, NEVER into runner containers. A runner container has no path to the host Docker daemon, the database, or other attempts' code |
| Secrets / test data | The runner never prints test inputs, expected outputs, or student stdout/stderr. Per-case `detail` carries only generic labels (`exit_code:1`, `timeout_after:2000ms`, `output_exceeded:1048576B`, `compile_error`). Logs carry ids only (`submissionId`/`attemptId`), never code or test data |

Notes:
- `/work` is chmod `0777` inside the worker so uid 10001 can write
  `verdict.json` there. It is a fresh per-attempt directory, not shared
  between attempts, and is deleted after the run.
- Operators should set `JUDGE_MEMORY_MB` >= the largest problem
  `memory_mb`: the runner clamps a problem's `RLIMIT_AS` to the
  container cap so the container OOM-killer does not fire first.
- The runner exits 0 whenever it produced a verdict — even for a wrong
  answer. A verdict is data, not a process failure. It exits non-zero
  only on runner infrastructure failure (missing/unreadable inputs).

## What this does NOT protect against (stated honestly)

- **No seccomp profile** is applied (default Docker seccomp only).
  A kernel-level sandbox escape is out of scope for this assessment.
- **No AppArmor/SELinux profile** beyond the Docker defaults.
- A malicious program can still burn its full CPU/memory/time budget
  (that is what the caps are for) and can fork up to the pids limit.
- Side channels (timing, CPU cache) between co-tenants are not
  mitigated; attempts run sequentially per worker slot (concurrency 2)
  and each in its own container, but share the host kernel.
- The worker holds the Docker socket: anyone who can execute code in
  the worker container (or read its environment) effectively has host
  Docker access. Treat the worker as trusted infrastructure, keep it
  off any untrusted network path, and never mount the socket anywhere
  else.

## Failure semantics

- **Student error** (wrong output, runtime error, compile error, time
  limit, output flood): a verdict is written to the attempt
  (`status='completed'`) and the submission completes. `score` is 100
  for `accepted`, 0 otherwise; per-problem points with wrong-attempt
  penalties are computed by the leaderboard, not here.
- **Runner infra failure** (Docker error, non-zero runner exit, missing
  or malformed `verdict.json`, unsupported language, no test cases,
  wall-clock expiry with no verdict): the runner throws
  `JudgeInfraError`. The worker writes NOTHING — no student verdict.
  The attempt stays `running` with its heartbeat going stale.
- **Crash between judging and verdict write** (process killed,
  `JUDGE_FAILPOINT=crash_before_verdict` / `crash_after_judge`, or the
  double's `crash_before_verdict`): identical to infra failure — the
  attempt stays `running`; nothing is half-written because the verdict
  write is a single conditional transaction.
- **Reaper recovery**: every 30 s the worker finds `running` attempts
  whose heartbeat is older than `WORKER_STALE_AFTER_SECONDS` (default
  120 s) and requeues them (`requeue_count` in `attempts.detail`),
  up to 3 times. After the 3rd stale recovery the attempt is marked
  `failed` with verdict `judge_error` and its submission completes
  (only if it is still the current attempt). A `judge_error` never
  reduces a score and never overwrites an earlier authoritative
  verdict — the leaderboard excludes it.
- **Superseded attempt**: if a newer attempt exists, the conditional
  verdict update affects 0 rows; the stale worker logs a warning and
  does NOT touch the submission.
