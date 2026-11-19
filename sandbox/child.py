"""Child runner: executes one test case of one solution.

This process runs as uid 1001 (dropped by the harness's preexec) and imports
untrusted model-generated code, so everything here assumes the code it imports
will try to escape, stall, flood, or exhaust memory.

It reports only the solution's return value. It never decides whether the test
passed — the host compares against the answer key, which is never present in
this container.
"""

import importlib.util
import json
import resource
import sys

# Applied before the solution is imported so a module-level allocation is
# already capped. Values are (resource, limit) with soft == hard.
LIMITS = (
    (resource.RLIMIT_AS, 128 * 1024 * 1024),  # address space: memory bombs
    # Above the harness's capture cap so a truncated capture is detectable
    # rather than silently exactly the cap.
    (resource.RLIMIT_FSIZE, 1024 * 1024),  # largest file written
    (resource.RLIMIT_NOFILE, 32),  # file descriptors
    (resource.RLIMIT_NPROC, 8),  # processes and threads
    (resource.RLIMIT_CORE, 0),  # no core dumps into the tmpfs
)


def apply_limits():
    for resource_id, value in LIMITS:
        try:
            resource.setrlimit(resource_id, (value, value))
        except (ValueError, OSError):
            # A limit the kernel refuses is not fatal: the container-level caps
            # still bound the run.
            pass


def main():
    # argv: source_path, entry_point, args_json, result_path
    source_path, entry_point, args_json, result_path = sys.argv[1:5]

    apply_limits()

    spec = importlib.util.spec_from_file_location("solution", source_path)
    if spec is None or spec.loader is None:
        raise ImportError("cannot load solution module")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    function = getattr(module, entry_point)
    result = function(*json.loads(args_json))

    # allow_nan=False: json.dumps(float("nan")) emits a bare NaN token, which is
    # not JSON and would break the host parser. Letting it raise turns an
    # unserialisable answer into a normal child failure instead of a corrupt
    # result stream.
    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump({"ok": True, "value": result}, handle, allow_nan=False)


if __name__ == "__main__":
    main()
