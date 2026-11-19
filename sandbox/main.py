"""Trusted harness: runs one solution against its test cases inside the sandbox.

Reads a JSON job from stdin, spawns a child process per test case as a lower
uid, and emits one NDJSON record per test on stdout.

Two design points carry the security of the whole runner:

1. The job never contains expected answers. This process only reports what the
   solution returned; the host decides pass/fail. A solution that forges a
   record can therefore only substitute its own answer.
2. Child stdout/stderr go to files, never pipes. A pipe would let a flooding
   solution OOM the harness, and an unread pipe deadlocks it.

Container-level failure (exit 137, OOM) is a host-side concept; this process
exits 0 whenever it produced a record for every test.
"""

import ctypes
import json
import os
import resource
import signal
import subprocess
import sys
import time

HARNESS_DIR = "/opt/harness"
CHILD_SCRIPT = os.path.join(HARNESS_DIR, "child.py")
SOLUTION_PATH = "/tmp/solution.py"

# uid the solution runs as. Distinct from the harness (root) so a solution
# cannot reach /proc/<harness>/environ, /mem, /maps or ptrace the harness.
CHILD_UID = 1001

MAX_STDIN_BYTES = 1024 * 1024
MAX_CAPTURE_BYTES = 64 * 1024
MAX_TOTAL_RUNTIME_MS = 120_000

PROTOCOL = 1


def emit(record):
    """Write one NDJSON record and flush it.

    fsync is attempted but a pipe cannot be fsynced (EINVAL), so flush is the
    real durability guarantee — and it is enough: verified that records written
    before a harness OOM still reach the host.
    """
    sys.stdout.write(json.dumps(record, allow_nan=False) + "\n")
    sys.stdout.flush()
    try:
        os.fsync(1)
    except OSError:
        pass


def disable_dumping():
    """Stop the solution from attaching a debugger to the harness.

    PR_SET_DUMPABLE lives on the process; the child inherits its own copy after
    fork, so this only affects the harness. Wrapped because the constant is
    Linux-specific and this must never be the reason a run fails.
    """
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE, 0
    except Exception:
        pass


def child_preexec():
    """Drop to the unprivileged uid and cap the child's resources.

    Runs in the forked child before exec, so the limits apply from the first
    instruction of the solution's import. setgroups must precede setgid, and
    setgid must precede setuid, or the drop fails.
    """
    os.setgroups([])
    os.setgid(CHILD_UID)
    os.setuid(CHILD_UID)

    limits = (
        (resource.RLIMIT_AS, 128 * 1024 * 1024),
        # Above MAX_CAPTURE_BYTES on purpose: if the file cap equalled the
        # capture cap, a flooded stream would fill exactly the cap and the read
        # could not tell it had been cut. This way the harness sees a file
        # larger than it reads and can report stdoutTruncated honestly.
        (resource.RLIMIT_FSIZE, 1024 * 1024),
        (resource.RLIMIT_NOFILE, 32),
        (resource.RLIMIT_NPROC, 8),
        (resource.RLIMIT_CORE, 0),
    )
    for resource_id, value in limits:
        try:
            resource.setrlimit(resource_id, (value, value))
        except (ValueError, OSError):
            pass


def kill_child_tree(pid):
    """Kill the child's process group, then sweep by uid.

    killpg misses a grandchild that called setsid(), so the uid sweep is the
    backstop. Zombies are left to Popen.wait(): reaping them here would steal
    the child's exit status and make a killed run look like a clean exit 0.
    """
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass

    for _ in range(2):
        found = False
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open(f"/proc/{entry}/status", encoding="utf-8") as handle:
                    status = handle.read()
            except OSError:
                continue
            uid_line = next(
                (line for line in status.splitlines() if line.startswith("Uid:")),
                None,
            )
            state_line = next(
                (line for line in status.splitlines() if line.startswith("State:")),
                None,
            )
            if uid_line is None or state_line is None:
                continue
            if int(uid_line.split()[1]) != CHILD_UID:
                continue
            # Zombies already hold nothing; skipping them here (rather than at
            # kill time) is what tells us the tree is gone.
            if state_line.split()[1] == "Z":
                continue
            found = True
            try:
                os.kill(int(entry), signal.SIGKILL)
            except OSError:
                pass
        if not found:
            return True
        time.sleep(0.15)

    # Still something alive after two sweeps: report it rather than pretend the
    # tree is clean. The container teardown is the final backstop.
    return False


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def read_bounded(path):
    """Read at most MAX_CAPTURE_BYTES, reporting whether there was more."""
    try:
        with open(path, "rb") as handle:
            data = handle.read(MAX_CAPTURE_BYTES + 1)
    except OSError:
        return "", False
    truncated = len(data) > MAX_CAPTURE_BYTES
    return data[:MAX_CAPTURE_BYTES].decode("utf-8", "replace"), truncated


def classify_failure(exit_code, stderr_text):
    """Map a failed child to a coarse, machine-readable reason."""
    if exit_code is not None and exit_code < 0:
        if exit_code in (-9, -24):  # SIGKILL / SIGXCPU
            return "memory" if "MemoryError" in stderr_text else "timeout"
    if "MemoryError" in stderr_text:
        return "memory"
    if "Errno 11" in stderr_text or "Resource temporarily unavailable" in stderr_text:
        return "process_limit"
    if (
        "Out of range float values" in stderr_text
        or "not JSON serializable" in stderr_text
    ):
        return "unserialisable"
    return "exception"


def run_test(ordinal, args, timeout_ms, entry_point):
    """Run one test case and return its record."""
    result_path = f"/tmp/result-{ordinal}.json"
    stdout_path = f"/tmp/stdout-{ordinal}.txt"
    stderr_path = f"/tmp/stderr-{ordinal}.txt"
    for path in (result_path, stdout_path, stderr_path):
        try:
            os.unlink(path)
        except OSError:
            pass

    started = time.monotonic()
    status = "returned"
    value = None
    exit_code = None
    stdout_truncated = False
    stderr_truncated = False

    try:
        # Separate files, not pipes: a pipe lets a flooding solution OOM the
        # harness and an unread pipe deadlocks it. Separate files keep the two
        # streams distinguishable, which matters for debugging a failure.
        with open(stdout_path, "wb") as out_sink, open(
            stderr_path, "wb"
        ) as err_sink:
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-I",
                    "-B",
                    CHILD_SCRIPT,
                    SOLUTION_PATH,
                    entry_point,
                    json.dumps(args, allow_nan=False),
                    result_path,
                ],
                stdin=subprocess.DEVNULL,
                stdout=out_sink,
                stderr=err_sink,
                cwd="/tmp",
                start_new_session=True,
                preexec_fn=child_preexec,
            )
            try:
                process.wait(timeout=timeout_ms / 1000.0)
                exit_code = process.returncode
            except subprocess.TimeoutExpired:
                status = "timeout"
                kill_child_tree(process.pid)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
                # The direct child may already be gone while an escaped
                # grandchild held the group open; a SIGKILLed child reports
                # -9, but when it was reaped out of band the status is None.
                # Record the kill explicitly so a timeout never reads as 0.
                exit_code = (
                    process.returncode if process.returncode not in (None, 0) else -9
                )
    except Exception:
        status = "error"
        exit_code = None

    duration_ms = int((time.monotonic() - started) * 1000)
    stdout_text, stdout_truncated = read_bounded(stdout_path)
    stderr_text, stderr_truncated = read_bounded(stderr_path)

    if status == "returned":
        if exit_code != 0:
            status = "error"
        else:
            try:
                with open(result_path, encoding="utf-8") as handle:
                    payload = json.load(handle)
                if not isinstance(payload, dict) or not payload.get("ok"):
                    status = "error"
                else:
                    value = payload.get("value")
            except (OSError, ValueError):
                # No result file, or it was not valid JSON: the child died or
                # returned something unserialisable.
                status = "error"

    failure_kind = None
    if status == "timeout":
        failure_kind = "timeout"
    elif status == "error":
        # The child's traceback lives on stderr; stdout may hold its prints.
        failure_kind = classify_failure(exit_code, stderr_text)

    for path in (result_path, stdout_path, stderr_path):
        try:
            os.unlink(path)
        except OSError:
            pass

    record = {
        "t": "test",
        "protocol": PROTOCOL,
        "ordinal": ordinal,
        "outcome": status,
        "stdout": stdout_text,
        "stderr": stderr_text,
        "stdoutTruncated": stdout_truncated,
        "stderrTruncated": stderr_truncated,
        "exitCode": exit_code,
        "durationMs": duration_ms,
        "failureKind": failure_kind,
    }
    if status == "returned":
        record["value"] = value
    return record


def main():
    disable_dumping()

    raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    if len(raw) > MAX_STDIN_BYTES:
        emit({"t": "end", "protocol": PROTOCOL, "reason": "internal"})
        return 1

    try:
        job = json.loads(raw)
        tests = job["tests"]
        entry_point = job["entryPoint"]
        source = job["source"]
        if job.get("protocol") != PROTOCOL:
            raise ValueError("protocol mismatch")
        if not isinstance(tests, list) or not tests:
            raise ValueError("no tests")
        if not isinstance(entry_point, str) or not entry_point.isidentifier():
            raise ValueError("bad entry point")
        if not isinstance(source, str):
            raise ValueError("bad source")
    except (ValueError, KeyError, TypeError):
        emit({"t": "end", "protocol": PROTOCOL, "reason": "internal"})
        return 1

    # World-readable: the child (uid 1001) must read it, and nothing else lives
    # in this tmpfs that the answer key could leak into.
    try:
        with open(SOLUTION_PATH, "w", encoding="utf-8") as handle:
            handle.write(source)
        os.chmod(SOLUTION_PATH, 0o644)
    except OSError:
        emit({"t": "end", "protocol": PROTOCOL, "reason": "internal"})
        return 1

    emit({"t": "start", "protocol": PROTOCOL, "tests": len(tests)})

    budget_ms = min(
        sum(int(test.get("timeoutMs", 5000)) for test in tests),
        MAX_TOTAL_RUNTIME_MS,
    )
    deadline = time.monotonic() + budget_ms / 1000.0

    for test in tests:
        remaining_ms = int((deadline - time.monotonic()) * 1000)
        if remaining_ms <= 0:
            emit({"t": "end", "protocol": PROTOCOL, "reason": "budget"})
            return 0

        timeout_ms = min(int(test.get("timeoutMs", 5000)), remaining_ms)
        record = run_test(
            int(test["ordinal"]),
            test.get("args", []),
            timeout_ms,
            entry_point,
        )
        emit(record)

    emit({"t": "end", "protocol": PROTOCOL, "reason": "completed"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
