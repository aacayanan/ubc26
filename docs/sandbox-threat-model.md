# Sandbox threat model (F13)

The evaluation sandbox is what stands between the application and arbitrary code
that an LLM produced. This document records the control stack, the attack list,
and — importantly — what was **measured** on this machine rather than assumed.

Environment the numbers below come from: Docker 29.5.2, `linux/arm64`, cgroup v2,
`python:3.12-alpine` pinned by digest, all probes run inside the actual
`sandbox/` image with the production flag set.

## What this protects against

- A solution exfiltrating data over the network.
- A solution reading or modifying the host filesystem, the app's env file, or
  the Supabase service-role key.
- A solution rewriting the harness to fake a pass.
- A solution exhausting CPU, memory, processes, disk, or file descriptors and
  taking the worker down.
- A solution hanging, or trapping signals, to run forever.
- A solution forging _its own_ verdict.

## What it does **not** protect against

- **A kernel or container-runtime escape.** Nothing here is a microVM.
- **The Docker socket being equivalent to host root.** The runner needs daemon
  access; F28 must decide between a mounted socket and a dedicated sidecar, and
  a compromised app process holding the socket is a host compromise.
- **A malicious challenge seed.** Test cases are trusted input.
- **Scoring honesty.** The backend remains trusted for _which_ answers it
  compares against; F23's on-chain commitments prove a prediction existed before
  a deadline, not that execution was fair.

## The load-bearing control

**Expected answers never enter the container.** The host sends only the source,
the entry point, and each test's positional arguments and timeout. The container
returns the solution's _value_; the host compares it against
`test_cases.expected_output` read from Postgres.

This is what makes forging pointless: a solution that somehow emits a result
record can only substitute _its own answer_, which still has to be correct.
`passed` is computed outside the container. A child **can** read anything the
harness writes to `/tmp` (measured — see below), so shipping the answer key into
the container would have handed every solution the answers.

The uid split below is therefore defence-in-depth for _harness integrity_, not
the primary control.

## Control stack

| Control                      | Flag / mechanism                               | Threat                       | Role             |
| ---------------------------- | ---------------------------------------------- | ---------------------------- | ---------------- |
| No network                   | `--network none`                               | exfiltration, C2             | load-bearing     |
| Immutable rootfs             | `--read-only`                                  | tampering with harness/image | load-bearing     |
| Writability only in `/tmp`   | `--tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m` | disk fill, exec from tmp     | load-bearing     |
| Memory ceiling               | `--memory 256m --memory-swap 256m`             | memory exhaustion            | load-bearing     |
| CPU ceiling                  | `--cpus 0.5`                                   | CPU starvation               | load-bearing     |
| Process ceiling              | `--pids-limit 64`                              | fork bombs                   | load-bearing     |
| Capability drop              | `--cap-drop ALL --cap-add SETUID,SETGID,KILL`  | privilege escalation         | load-bearing     |
| No setuid escalation         | `--security-opt no-new-privileges`             | setuid binaries              | defence in depth |
| Per-child rlimits            | `RLIMIT_AS/FSIZE/NOFILE/NPROC/CORE`            | per-test exhaustion          | defence in depth |
| uid split                    | harness root, child uid 1001                   | harness tampering            | defence in depth |
| Answer key withheld          | host-side comparison                           | verdict forgery              | **primary**      |
| File capture                 | child stdout/stderr → file                     | harness OOM / deadlock       | availability     |
| No `--rm` + `docker inspect` | host                                           | OOM attribution              | correctness      |
| `--name` + `rm -f`           | host                                           | orphan containers            | cleanup          |

## Attack checklist — measured

Each row is the attempt, the expected observable, and what actually happened.
Re-run any of them with the job harness described at the bottom.

| Attack                                     | Expected              | **Observed**                                             |
| ------------------------------------------ | --------------------- | -------------------------------------------------------- |
| `os.setuid(0)` from a solution             | denied                | `PermissionError` (`CapEff=0`)                           |
| Write `/usr`, `/etc`, `/`                  | denied                | `OSError` on all                                         |
| Write `/tmp`, then `execv` it              | write ok, exec denied | write ok; exec blocked by `noexec`                       |
| Read `/proc/1/environ` (harness)           | denied                | `PermissionError`                                        |
| Read `/proc/1/mem`, list `/proc/1/fd`      | denied                | `PermissionError`                                        |
| `ptrace(PTRACE_ATTACH, harness)`           | denied                | returned `-1`, `errno 1`                                 |
| Open `/var/run/docker.sock`                | absent                | `FileNotFoundError`                                      |
| Network interfaces                         | only `lo`             | `['lo']` — empty route table, 0 ARP entries              |
| `os.fork()` loop                           | bounded               | `OSError errno 11`, container survives                   |
| `bytearray(900 << 20)` in a test           | `MemoryError`         | `MemoryError`; harness alive; `failureKind:"memory"`     |
| Container-level 900 MB alloc               | OOM kill              | `OOMKilled=true`, exit 137                               |
| Infinite loop / `SIGTERM` trap             | killed                | `outcome:"timeout"`, `exitCode:-9`, `durationMs`≈timeout |
| 50 MB of stdout                            | bounded               | `exitCode:120` (`RLIMIT_FSIZE`), harness alive           |
| `setsid()` grandchild + sleep              | no hang               | returns in 0.31 s; grandchild swept by uid               |
| Return `float("nan")`                      | not JSON              | `outcome:"error"`, `failureKind:"unserialisable"`        |
| Read a harness-written `/tmp` file         | _readable_            | **readable** — this is why answers never enter           |
| Same-uid child writes harness fd 1         | —                     | _would succeed_ — this is why the uid split exists       |
| Child scans `/proc/self/fd`, writes a pipe | —                     | succeeds — why no fd-based result channel is trusted     |

Notes on three of the less obvious ones:

- **`--rm` is deliberately absent.** `docker inspect` after `--rm` reports the
  container does not exist, so the OOM flag is unreadable. The host always
  follows with `docker rm -f <name>`.
- **Killing the `docker` CLI does not stop the container** (measured). The host
  kills by name and removes by name, and `reapOrphanedContainers()` cleans up
  after a crashed worker.
- **`docker run` without `-i`** hands the container an empty stdin, which the
  harness correctly rejects with `end`/`internal`. The host always passes `-i`.

## Residual risks

1. **Cross-test state within one execution.** One container per execution means
   a solution can leave state in `/tmp` for its later test cases. Accepted: the
   alternative is a container per test case at roughly 10× the start cost, and a
   solution only cheats itself by carrying state forward.
2. **`duration_ms` is harness-reported.** Kept honest by the uid split (a child
   cannot write the harness's stats), but it is not a hardware measurement.
   F14 owns the authoritative speed metric.
3. **No custom seccomp profile.** Docker's default profile applies; a stricter
   allowlist would narrow the surface further but is not required for MVP.
4. **No gVisor / Kata.** A runtime-level escape is out of scope for a hackathon
   MVP.
5. **The sandbox image is mutable locally** unless the digest is pinned. The
   host refuses a tag-only `SANDBOX_IMAGE` for this reason.
6. **`--pids-limit` counts threads**, so a `multiprocessing` solution can hit
   `RLIMIT_NPROC` first; that surfaces as `failureKind:"process_limit"` rather
   than looking like a crash.

## Re-running the checks

```bash
npm run sandbox:build
docker image inspect ai-showdown-sandbox:py3.12 --format '{{index .RepoDigests 0}}'
```

There is **no automated JS test runner** in this repo by design (the existing
tests are SQL scripts pasted into the Supabase editor). The container-level
matrix is run by piping a job into the image:

```bash
printf '{"protocol":1,"source":"def solve(a,b):\n    return a+b\n","entryPoint":"solve","runType":"generation","tests":[{"ordinal":1,"args":[2,3],"timeoutMs":2000}]}' \
  | docker run -i --rm --network none --read-only \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
      --memory 256m --memory-swap 256m --cpus 0.5 --pids-limit 64 \
      --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL \
      --security-opt no-new-privileges --user 0:0 \
      ai-showdown-sandbox:py3.12
```

Expected: one `start` record, one `test` record with `"outcome":"returned"` and
`"value":5`, then `end`/`completed`.

For schema-level checks, `supabase/tests/constraints.sql` asserts the
`entry_point` constraints, and `npm run sandbox:check` exercises the persistence
upsert contract against a live project (skipped without a service-role key).
