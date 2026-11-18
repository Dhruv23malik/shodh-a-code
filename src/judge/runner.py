#!/usr/bin/env python3
"""Shodh judge runner — executes one submission against its test cases.

Runs INSIDE the sandboxed runner container (judge/Dockerfile.runner) as
non-root uid 10001, no network, read-only rootfs. It reads:

  /work/code.py    — the student's program (Python)
  /work/tests.json — {"time_limit_ms": int, "memory_mb": int,
                     "max_output_bytes": int,
                     "cases": [{"position": int, "name": str,
                                "input": str, "expected_output": str}]}
                     (a bare list of cases is also accepted; defaults apply)

and writes:

  /work/verdict.json — {"verdict": str, "reason": str,
                        "cases": [{"position": int, "name": str,
                                   "passed": bool,
                                   "outcome": "ok" | "wrong_output" |
                                              "runtime_error" | "time_limit" |
                                              "output_limit",
                                   "runtimeMs": int,
                                   "detail": str}]}

Rules:
  * stdout is compared stripped against expected_output stripped.
  * Exit code is ALWAYS 0 when a verdict was produced — even for a wrong
    answer. A verdict is data, not a process failure. Exit non-zero only
    for runner infrastructure failure (missing/unreadable inputs).
  * NEVER print test inputs, expected outputs, or student stdout/stderr
    to stdout/stderr/logs. The per-case `detail` field carries only a
    generic machine label (e.g. "exit_code:1", "timeout_after:2000ms") —
    never program output, because student code could echo a test input.
  * Per-case limits (enforced with the `resource` module in a preexec_fn,
    plus a wall-clock timeout in this process):
      RLIMIT_CPU   — ceil(time_limit_ms / 1000) + 1 seconds (backstop)
      RLIMIT_AS    — memory_mb (per-process address space)
      RLIMIT_FSIZE — max_output_bytes (caps every file the child writes,
                     including the stdout/stderr capture files)
      RLIMIT_NPROC — 64 processes for the sandbox uid
    Wall-clock timeout per case = time_limit_ms + 500 ms grace; on
    expiry the whole process group is SIGKILLed and the case is a
    time_limit.
"""

import json
import os
import resource
import signal
import subprocess
import sys
import time

WORK = "/work"
CODE_PATH = os.path.join(WORK, "code.py")
TESTS_PATH = os.path.join(WORK, "tests.json")
VERDICT_PATH = os.path.join(WORK, "verdict.json")

# Grace added to the per-case wall-clock timeout (ms).
TIME_GRACE_MS = 500
# Per-process cap inside the container (the container itself also has
# --pids-limit; this is the in-process backstop).
NPROC_LIMIT = 64

OUTCOMES = ("ok", "wrong_output", "runtime_error", "time_limit", "output_limit")
VERDICTS = (
    "accepted",
    "wrong_answer",
    "compile_error",
    "runtime_error",
    "time_limit",
    "judge_error",
)


def eprint(msg: str) -> None:
    # Log lines must never contain test data or student code/output.
    print(f"runner: {msg}", file=sys.stderr, flush=True)


def load_tests() -> dict:
    with open(TESTS_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return {
            "time_limit_ms": 2000,
            "memory_mb": 256,
            "max_output_bytes": 1024 * 1024,
            "cases": data,
        }
    if not isinstance(data, dict) or not isinstance(data.get("cases"), list):
        raise ValueError("tests.json must be a case list or an object with a cases list")
    return data


def make_limits(time_limit_ms: int, memory_mb: int, max_output_bytes: int):
    cpu_seconds = max(1, int(time_limit_ms / 1000) + 1)
    as_bytes = max(1, memory_mb) * 1024 * 1024

    def limits() -> None:
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
        resource.setrlimit(resource.RLIMIT_AS, (as_bytes, as_bytes))
        resource.setrlimit(
            resource.RLIMIT_FSIZE, (max_output_bytes, max_output_bytes)
        )
        resource.setrlimit(resource.RLIMIT_NPROC, (NPROC_LIMIT, NPROC_LIMIT))

    return limits


def case_result(case: dict, passed: bool, outcome: str, runtime_ms: int,
                detail: str = "") -> dict:
    return {
        "position": int(case["position"]),
        "name": str(case["name"]),
        "passed": passed,
        "outcome": outcome,
        "runtimeMs": runtime_ms,
        "detail": detail,
    }


def run_case(case: dict, time_limit_ms: int, memory_mb: int,
             max_output_bytes: int) -> dict:
    """Run one test case. Returns a verdict.json case entry."""
    timeout_s = time_limit_ms / 1000.0 + TIME_GRACE_MS / 1000.0
    limits = make_limits(time_limit_ms, memory_mb, max_output_bytes)
    start = time.monotonic()

    out_path = f"/tmp/out_{case['position']}.bin"
    err_path = f"/tmp/err_{case['position']}.bin"
    for p in (out_path, err_path):
        try:
            os.unlink(p)
        except FileNotFoundError:
            pass

    proc = None
    try:
        with open(out_path, "wb") as out_f, open(err_path, "wb") as err_f:
            # Cap the stderr capture file as well: the child writes stderr
            # to it, so RLIMIT_FSIZE bounds it (SIGXFSZ kills the child).
            # stdout is capped by the same RLIMIT_FSIZE on its file.
            proc = subprocess.Popen(
                [sys.executable, CODE_PATH],
                stdin=subprocess.PIPE,
                stdout=out_f,
                stderr=err_f,
                preexec_fn=limits,
                start_new_session=True,
            )
            try:
                proc.communicate(
                    input=str(case.get("input", "")).encode("utf-8"),
                    timeout=timeout_s,
                )
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                proc.wait()
                runtime_ms = int((time.monotonic() - start) * 1000)
                return case_result(
                    case, False, "time_limit", runtime_ms,
                    f"timeout_after:{time_limit_ms}ms",
                )
    except OSError as exc:
        # Could not spawn at all (e.g. resource exhaustion): infra-side,
        # but per-case we report it as a runtime error and let the
        # aggregate verdict carry it; a total spawn failure is handled
        # by the caller treating a missing verdict.json as judge_error.
        runtime_ms = int((time.monotonic() - start) * 1000)
        return case_result(
            case, False, "runtime_error", runtime_ms,
            f"spawn_failed:{exc.__class__.__name__}",
        )
    finally:
        if proc is not None and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            proc.wait()

    runtime_ms = int((time.monotonic() - start) * 1000)
    returncode = proc.returncode if proc is not None else -1

    # Read captured stdout (bounded: RLIMIT_FSIZE capped the file).
    try:
        out_size = os.path.getsize(out_path)
    except OSError:
        out_size = 0
    if out_size >= max_output_bytes:
        return case_result(
            case, False, "output_limit", runtime_ms,
            f"output_exceeded:{max_output_bytes}B",
        )

    try:
        with open(out_path, "rb") as f:
            stdout = f.read().decode("utf-8", errors="replace")
    except OSError:
        stdout = ""

    # CPU-limit kill (SIGXCPU=24, escalated to SIGKILL=9) means the
    # program burned its CPU budget: a time limit, not a crash.
    if returncode in (-signal.SIGXCPU, -signal.SIGKILL):
        return case_result(
            case, False, "time_limit", runtime_ms,
            f"timeout_after:{time_limit_ms}ms",
        )
    if returncode != 0:
        return case_result(
            case, False, "runtime_error", runtime_ms,
            f"exit_code:{returncode}",
        )

    expected = str(case.get("expected_output", ""))
    if stdout.strip() == expected.strip():
        return case_result(case, True, "ok", runtime_ms)
    return case_result(case, False, "wrong_output", runtime_ms)


def aggregate(results: list) -> tuple:
    """Map per-case outcomes to (verdict, reason)."""
    if not results:
        return "judge_error", "no_cases"
    outcomes = [r["outcome"] for r in results]
    if "time_limit" in outcomes:
        return "time_limit", "timeout"
    if "output_limit" in outcomes:
        # No dedicated verdict exists; an output flood is a resource
        # violation by the program, closest to a runtime error.
        return "runtime_error", "output_limit"
    if "runtime_error" in outcomes:
        return "runtime_error", "runtime_error"
    if "wrong_output" in outcomes:
        return "wrong_answer", "wrong_output"
    return "accepted", "all_passed"


def write_verdict(verdict: str, reason: str, results: list) -> None:
    payload = {"verdict": verdict, "reason": reason, "cases": results}
    tmp_path = VERDICT_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp_path, VERDICT_PATH)


def main() -> int:
    try:
        tests = load_tests()
    except Exception as exc:  # missing / malformed tests.json: infra failure
        eprint(f"cannot load tests.json ({exc.__class__.__name__})")
        return 2
    if not os.path.isfile(CODE_PATH):
        eprint("code.py missing")
        return 2

    try:
        time_limit_ms = int(tests.get("time_limit_ms", 2000))
        memory_mb = int(tests.get("memory_mb", 256))
        max_output_bytes = int(tests.get("max_output_bytes", 1024 * 1024))
        cases = sorted(tests["cases"], key=lambda c: c["position"])
    except (KeyError, TypeError, ValueError) as exc:
        eprint(f"malformed tests.json ({exc.__class__.__name__})")
        return 2

    # Compile check first: a SyntaxError is a compile_error for every case,
    # not a per-case runtime error.
    try:
        with open(CODE_PATH, "rb") as f:
            compile(f.read(), "code.py", "exec")
    except SyntaxError:
        results = [
            case_result(c, False, "runtime_error", 0, "compile_error")
            for c in cases
        ]
        write_verdict("compile_error", "compile_error", results)
        return 0

    results = [
        run_case(c, time_limit_ms, memory_mb, max_output_bytes) for c in cases
    ]
    verdict, reason = aggregate(results)
    write_verdict(verdict, reason, results)
    return 0


if __name__ == "__main__":
    sys.exit(main())
