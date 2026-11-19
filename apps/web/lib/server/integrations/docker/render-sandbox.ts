import "server-only";

import {
  ConfigurationError,
  InternalError,
} from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { getRenderSandboxEnv } from "@/lib/config/sandbox";
import {
  dockerIsAvailable,
  runDocker,
} from "@/lib/server/integrations/docker/process";
import {
  RENDER_PROTOCOL_VERSION,
  type RenderJob,
  type RenderResultRecord,
} from "@ai-showdown/shared";

/**
 * Starts, watches and tears down one render container (F12/F14).
 *
 * The isolation model matches F13's Python runner — no network, immutable
 * rootfs, a single tmpfs, CPU/memory/pid ceilings, all capabilities dropped —
 * with two differences that a browser forces:
 *
 *   * the process runs as a non-root uid (Chromium refuses a sandboxed root
 *     without `--no-sandbox`, and `--no-sandbox` is exactly what we do not want
 *     to hand model-generated code);
 *   * the tmpfs is larger, because Chromium writes its profile and shared
 *     memory there.
 *
 * Everything the container says is an observation. `evaluate.ts` decides what
 * the deterministic checks mean; nothing here marks a render "good".
 */

export interface RenderContainerRequest {
  containerName: string;
  job: RenderJob;
  wallClockMs: number;
}

export interface RenderContainerResult {
  /** The parsed result record, or null when the container produced none. */
  record: RenderResultRecord | null;
  stderr: string;
  exitCode: number | null;
  oomKilled: boolean;
  timedOut: boolean;
  wallMs: number;
  /** True when docker itself never produced a result (daemon down, no image). */
  unavailable: boolean;
}

const ORPHAN_PREFIX = "f12-render-";

/**
 * Build the `docker run` argv.
 *
 * Kept in one place so the threat model can quote exactly what runs, and so the
 * flags are reviewable without reading the process code.
 */
export function buildRenderSandboxArgs(
  request: RenderContainerRequest,
): string[] {
  const env = getRenderSandboxEnv();

  return [
    "run",
    "--name",
    request.containerName,
    // The job is the only channel in, which is also why no host path is ever
    // mounted.
    "-i",
    "--network",
    "none",
    // Immutable rootfs: the harness and the browser cannot be rewritten by the
    // code they are rendering.
    "--read-only",
    // Chromium needs a writable /tmp and /dev/shm. noexec stops a solution
    // from dropping a binary and running it.
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${env.tmpfsMb}m`,
    "--tmpfs",
    "/dev/shm:rw,noexec,nosuid,nodev,size=256m",
    "--memory",
    `${env.memoryMb}m`,
    "--memory-swap",
    `${env.memoryMb}m`,
    "--cpus",
    env.cpus,
    "--pids-limit",
    String(env.pidsLimit),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    // Non-root. The image's `pwuser` (uid 1000) owns nothing privileged, and
    // the browser gets no more than that.
    "--user",
    "1000:1000",
    "-e",
    "HOME=/tmp",
    env.imageRef,
  ];
}

export async function runRenderContainer(
  request: RenderContainerRequest,
): Promise<RenderContainerResult> {
  const env = getRenderSandboxEnv();
  const startedAt = Date.now();

  const result = await runDocker(
    env.dockerBin,
    buildRenderSandboxArgs(request),
    {
      stdin: JSON.stringify(request.job),
      timeoutMs: request.wallClockMs,
      maxStdoutBytes: env.maxStdoutBytes,
      maxStderrBytes: env.maxStderrBytes,
    },
  );

  logger.info("render.container.started", {
    containerName: request.containerName,
    wallClockMs: request.wallClockMs,
  });

  const unavailable =
    result.spawnError !== null ||
    result.exitCode === 125 ||
    result.exitCode === 126;

  let oomKilled = false;
  if (!unavailable) {
    oomKilled = await readOomKilled(env.dockerBin, request.containerName);
  }

  if (result.timedOut) {
    await killRenderContainer(request.containerName);
  }

  await removeContainer(env.dockerBin, request.containerName);

  const wallMs = Date.now() - startedAt;
  const record = unavailable ? null : parseRenderRecord(result.stdout);

  logger.info("render.container.finished", {
    containerName: request.containerName,
    exitCode: result.exitCode,
    oomKilled,
    timedOut: result.timedOut,
    frames: record?.frames.length ?? 0,
    wallMs,
  });

  return {
    record,
    stderr: result.stderr,
    exitCode: result.exitCode,
    oomKilled,
    timedOut: result.timedOut,
    wallMs,
    unavailable,
  };
}

/**
 * Parse the container's single NDJSON record.
 *
 * The container emits exactly one `render` line. A trailing partial line from a
 * killed container is discarded rather than treated as a result; a malformed
 * line yields null so the caller records an explicit failure instead of a
 * half-read frame set.
 */
export function parseRenderRecord(raw: string): RenderResultRecord | null {
  const lines = raw.split("\n");

  for (const line of lines) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRenderRecord(parsed)) continue;
    return parsed;
  }

  return null;
}

function isRenderRecord(value: unknown): value is RenderResultRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;

  if (record.t !== "render" || record.protocol !== RENDER_PROTOCOL_VERSION) {
    return false;
  }
  if (typeof record.ok !== "boolean" || !Array.isArray(record.frames)) {
    return false;
  }

  return record.frames.every((frame) => {
    if (!frame || typeof frame !== "object") return false;
    const f = frame as Record<string, unknown>;
    return (
      typeof f.index === "number" &&
      typeof f.png === "string" &&
      typeof f.blank === "boolean" &&
      typeof f.distinctColors === "number" &&
      // Required, not optional: the dimension check reads these, and a frame
      // missing them would otherwise pass parsing and then fail confusingly.
      typeof f.width === "number" &&
      typeof f.height === "number"
    );
  });
}

async function readOomKilled(
  dockerBin: string,
  containerName: string,
): Promise<boolean> {
  const result = await runDocker(
    dockerBin,
    ["inspect", "--format", "{{.State.OOMKilled}}", containerName],
    { timeoutMs: 5_000, maxStdoutBytes: 64, maxStderrBytes: 1024 },
  );

  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function removeContainer(
  dockerBin: string,
  containerName: string,
): Promise<void> {
  await runDocker(dockerBin, ["rm", "-f", containerName], {
    timeoutMs: 10_000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  });
}

export async function killRenderContainer(
  containerName: string,
): Promise<void> {
  const env = getRenderSandboxEnv();
  await runDocker(env.dockerBin, ["kill", "-s", "SIGKILL", containerName], {
    timeoutMs: 10_000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  });
}

/**
 * Remove render containers left behind by a crashed worker.
 *
 * Names are prefixed at creation, so this can only ever touch containers this
 * feature owns.
 */
export async function reapOrphanedRenderContainers(): Promise<number> {
  const env = getRenderSandboxEnv();

  const listed = await runDocker(
    env.dockerBin,
    ["ps", "-aq", "--filter", `name=${ORPHAN_PREFIX}`],
    { timeoutMs: 15_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 4096 },
  );

  const ids = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (ids.length === 0) return 0;

  await runDocker(env.dockerBin, ["rm", "-f", ...ids], {
    timeoutMs: 30_000,
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
  });

  logger.warn("render.orphans.reaped", { count: ids.length });
  return ids.length;
}

/**
 * Startup pre-flight: the daemon must be reachable and the pinned image present.
 *
 * Fails closed — running without these would silently mark every render
 * `unavailable`.
 */
export async function assertRenderSandboxAvailable(): Promise<void> {
  const env = getRenderSandboxEnv();

  if (!(await dockerIsAvailable(env.dockerBin))) {
    throw new ConfigurationError(
      "Docker daemon is unavailable; the render sandbox cannot run",
    );
  }

  const inspected = await runDocker(
    env.dockerBin,
    ["image", "inspect", env.imageRef, "--format", "{{.Id}}"],
    { timeoutMs: 15_000, maxStdoutBytes: 1024, maxStderrBytes: 2048 },
  );

  if (inspected.exitCode !== 0) {
    throw new ConfigurationError(
      `Render image ${env.imageRef} is not present locally; run \`npm run sandbox:render:build\``,
    );
  }
}

export async function renderSandboxIsReady(): Promise<boolean> {
  try {
    await assertRenderSandboxAvailable();
    return true;
  } catch (error) {
    if (error instanceof ConfigurationError) return false;
    throw new InternalError("Failed to check the render sandbox", error);
  }
}
