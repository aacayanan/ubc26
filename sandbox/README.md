# Sandbox image

The container that runs one evaluation's worth of LLM-generated Python. Every
solution executes here, never in the app process.

This directory is the **isolation boundary**, so treat changes here with more
care than the rest of the repo. The threat model and the measured behaviour of
each control live in [`../docs/sandbox-threat-model.md`](../docs/sandbox-threat-model.md).

## Build

```bash
npm run sandbox:build          # from the repo root
```

That runs `docker build -t ai-showdown-sandbox:py3.12 sandbox/`.

## Pin the digest

The host refuses a tag-only image reference, because a tag silently re-pulls and
would change what past verdicts meant:

```bash
docker image inspect ai-showdown-sandbox:py3.12 \
  --format '{{index .RepoDigests 0}}'
```

Put the full `name@sha256:…` value in `apps/web/.env.local` as `SANDBOX_IMAGE`.

## How a run works

The host pipes a JSON job to the container's stdin. The job carries the source,
the entry point, and each test's positional arguments and timeout — **never the
expected answers**. That is the load-bearing control: the container returns the
solution's value, the host decides `passed`, so a forged result can only
substitute the solution's own answer.

The container runs `main.py` as root with only `CAP_SETUID`, `CAP_SETGID` and
`CAP_KILL`. For each test it spawns `child.py` as uid 1001, which imports the
solution and writes the return value to a file. Child output goes to a file, not
a pipe, so a solution cannot flood or deadlock the harness.

## Files

| File         | Role                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| `Dockerfile` | Pins `python:3.12-alpine` by digest; copies the harness in read-only      |
| `main.py`    | Trusted harness: job intake, per-test child, NDJSON records               |
| `child.py`   | Runs as uid 1001: applies rlimits, imports the solution, writes the value |

`main.py` and `child.py` are trusted code that runs next to untrusted code.
Neither decides correctness.
