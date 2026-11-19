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

## Render sandbox (`render/`)

The Python image above is the pre-pivot evaluation path. A visual brief (F12) is
rendered by a browser instead: the model writes
`function <entryPoint>(t, ctx, canvas)`, and headless Chromium calls it once per
frame. That image lives in [`render/`](render/).

```bash
npm run sandbox:render:build   # docker build -t ai-showdown-render:chromium sandbox/render/
```

Pin its digest the same way and put it in `apps/web/.env.local` as
`RENDER_SANDBOX_IMAGE`.

**Why a separate image.** Chromium needs a bigger memory ceiling and a writable
`/dev/shm`; raising those on the Python runner would loosen a boundary that does
not need it. The two images never share a container.

**What stays the same.** No network (`--network none`), immutable rootfs
(`--read-only`), `noexec` tmpfs, all capabilities dropped, `no-new-privileges`,
and the same stdin-job / stdout-record protocol. The host still decides every
verdict — the container reports frames and whether each was flat; `gate.ts`
turns that into the deterministic checks.

**What differs.** The renderer runs as an unprivileged uid (1000), not root.
Chromium's own sandbox needs namespaces the container does not provide, so it is
disabled in the harness and replaced by the non-root process plus the
container-level controls above.

**Determinism.** Frames are captured at explicit time steps —
`i / (frameCount - 1) * targetDurationMs` — never wall-clock, and the image is
digest-pinned, so the same code, brief and image yield byte-identical frames.
Verified: three runs of the seeded reference implementations produced identical
SHA-256 frame hashes.

| File                 | Role                                                             |
| -------------------- | ---------------------------------------------------------------- |
| `render/Dockerfile`  | Pins the Playwright/Chromium base by digest; copies the harness  |
| `render/harness.mjs` | Trusted harness: job intake, per-frame render, one NDJSON record |

`harness.mjs` is trusted code that runs next to untrusted code. It reports
observations; it does not decide whether a render passed.
