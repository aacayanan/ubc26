import "server-only";

import {
  ConfigurationError,
  InternalError,
} from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { getSandboxEnv } from "@/lib/config/sandbox";
import {
  dockerIsAvailable,
  runDocker,
} from "@/lib/server/integrations/docker/process";

/**
 * Starts, watches, and tears down one sandbox container (F13).
 *
 * Every flag here was chosen against a measured behaviour, not a guess; see
 * `docs/sandbox-threat-model.md` for the probe that justifies each one.
 */

export interface SandboxContainerRequest {
  containerName: string;
  jobJson: string;
  wallClockMs: number;
}

export interface SandboxContainerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  oomKilled: boolean;
  timedOut: boolean;
  wallMs: number;
  /** True when docker itself never produced a result (daemon down, no image). */
  unavailable: boolean;
}

const ORPHAN_PREFIX = "f13-";

/**
 * Build the `docker run` argv.
 *
 * Separated so the flags are testable and reviewable in one place, and so the
 * threat-model doc can quote exactly what runs.
 */
export function buildSandboxArgs(request: SandboxContainerRequest): string[] {
  const env = getSandboxEnv();

  return [
    "run",
    "--name",
    request.containerName,
    // Keep stdin open: the job document is the only channel into the container,
    // which is also why no host path is ever mounted.
    "-i",
    "--network",
    "none",
    // Immutable rootfs. The tmpfs below is the only writable location, so a
    // solution cannot rewrite the harness that judges it.
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--memory",
    `${env.memoryMb}m`,
    // Equal to --memory, which is how swap is disabled.
    "--memory-swap",
    `${env.memoryMb}m`,
    "--cpus",
    env.cpus,
    "--pids-limit",
    String(env.pidsLimit),
    // Root needs SETUID/SETGID to drop each test to uid 1001, and KILL to end
    // it. Nothing else survives.
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "KILL",
    "--security-opt",
    "no-new-privileges",
    // Root inside the container, constrained by the caps above: uid 1000
    // without CAP_SETUID cannot create the uid boundary (verified).
    "--user",
    "0:0",
    env.imageRef,
  ];
}

export async function runSandboxContainer(
  request: SandboxContainerRequest,
): Promise<SandboxContainerResult> {
  const env = getSandboxEnv();
  const startedAt = Date.now();

  const result = await runDocker(env.dockerBin, buildSandboxArgs(request), {
    stdin: request.jobJson,
    timeoutMs: request.wallClockMs,
    maxStdoutBytes: env.maxStdoutBytes * 4,
    maxStderrBytes: env.maxStderrBytes,
  });

  logger.info("sandbox.container.started", {
    containerName: request.containerName,
    wallClockMs: request.wallClockMs,
  });

  // A spawn failure or a docker-level non-zero exit with no container output
  // means infrastructure, not the model.
  const unavailable =
    result.spawnError !== null ||
    result.exitCode === 125 ||
    result.exitCode === 126;

  let oomKilled = false;

  if (!unavailable) {
    // No --rm on the run: OOM is only observable while the container still
    // exists. Read the state, then always remove it.
    oomKilled = await readOomKilled(env.dockerBin, request.containerName);
  }

  if (result.timedOut) {
    // Killing the docker client does not stop the container (verified), so
    // stop it by name before removing.
    await killSandboxContainer(request.containerName);
  }

  await removeContainer(env.dockerBin, request.containerName);

  const wallMs = Date.now() - startedAt;

  logger.info("sandbox.container.finished", {
    containerName: request.containerName,
    exitCode: result.exitCode,
    oomKilled,
    timedOut: result.timedOut,
    wallMs,
    stdoutBytes: result.stdout.length,
    stderrBytes: result.stderr.length,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    oomKilled,
    timedOut: result.timedOut,
    wallMs,
    unavailable,
  };
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
  // Best effort: a missing container is the normal case when the image never
  // resolved, and cleanup must never mask the run's real result.
  await runDocker(dockerBin, ["rm", "-f", containerName], {
    timeoutMs: 10_000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  });
}

export async function killSandboxContainer(
  containerName: string,
): Promise<void> {
  const env = getSandboxEnv();
  await runDocker(env.dockerBin, ["kill", "-s", "SIGKILL", containerName], {
    timeoutMs: 10_000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  });
}

/**
 * Remove containers left behind by a crashed worker.
 *
 * Names are prefixed at creation, so this can only ever touch containers this
 * feature owns. Intended to run once at startup.
 */
export async function reapOrphanedContainers(): Promise<number> {
  const env = getSandboxEnv();

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

  logger.warn("sandbox.orphans.reaped", { count: ids.length });
  return ids.length;
}

/**
 * Startup pre-flight: the daemon must be reachable and the pinned image present.
 *
 * Fails closed — running without these would silently mark every execution
 * `unavailable`. Call once per worker, not per run.
 */
export async function assertSandboxAvailable(): Promise<void> {
  const env = getSandboxEnv();

  if (!(await dockerIsAvailable(env.dockerBin))) {
    throw new ConfigurationError(
      "Docker daemon is unavailable; the evaluation sandbox cannot run",
    );
  }

  const inspected = await runDocker(
    env.dockerBin,
    ["image", "inspect", env.imageRef, "--format", "{{.Id}}"],
    { timeoutMs: 15_000, maxStdoutBytes: 1024, maxStderrBytes: 2048 },
  );

  if (inspected.exitCode !== 0) {
    throw new ConfigurationError(
      `Sandbox image ${env.imageRef} is not present locally; run \`npm run sandbox:build\``,
    );
  }
}

/** Exposed for callers that want to surface a clear error before queueing work. */
export async function sandboxIsReady(): Promise<boolean> {
  try {
    await assertSandboxAvailable();
    return true;
  } catch (error) {
    if (error instanceof ConfigurationError) return false;
    throw new InternalError("Failed to check the sandbox", error);
  }
}
