import "server-only";

import { spawn } from "node:child_process";

/**
 * Thin wrapper around the `docker` CLI.
 *
 * A Docker client library (dockerode) would add a dependency and a second
 * connection model for one binary; the repo's guidance is to prefer the simple
 * thing. Everything security-relevant is in the argv the caller builds, so this
 * layer only has to be correct about process lifecycle.
 *
 * No shell is ever involved: `args` is an array, so a container name or image
 * reference cannot inject a second command.
 */

export interface DockerProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  wallMs: number;
  /** Set when the binary could not be spawned at all (e.g. ENOENT). */
  spawnError: string | null;
}

export interface DockerProcessOptions {
  stdin?: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

/**
 * Run `docker` and resolve with whatever happened.
 *
 * Never rejects on a non-zero exit: a failed container is a normal result the
 * caller classifies. Only a cancellation settles with `spawnError`.
 */
export function runDocker(
  dockerBin: string,
  args: string[],
  options: DockerProcessOptions,
): Promise<DockerProcessResult> {
  const startedAt = Date.now();

  return new Promise<DockerProcessResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let spawnError: string | null = null;
    let stdout = "";
    let stderr = "";

    const child = spawn(dockerBin, args, { stdio: ["pipe", "pipe", "pipe"] });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        wallMs: Date.now() - startedAt,
        spawnError,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM: the container has its own teardown path, and the
      // CLI must not be given a chance to linger.
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    // Keep draining after the cap so the child never blocks on a full pipe;
    // only stop *growing* the buffer.
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < options.maxStdoutBytes) {
        stdout += chunk;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < options.maxStderrBytes) {
        stderr += chunk;
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = `${error.name}: ${error.message}`;
      finish(null);
    });

    child.on("close", (code) => finish(code));

    if (options.stdin !== undefined) {
      // The container can exit before it reads stdin — an unknown image exits
      // 125 immediately — which raises EPIPE here. Without these guards that
      // becomes an unhandled 'error' event and takes down the worker.
      child.stdin.on("error", () => {});
      try {
        child.stdin.end(options.stdin);
      } catch {
        // Reported through the process result; nothing to recover from here.
      }
    } else {
      child.stdin.end();
    }
  });
}

export async function dockerIsAvailable(dockerBin: string): Promise<boolean> {
  const result = await runDocker(dockerBin, ["info"], {
    timeoutMs: 5_000,
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
  });
  return (
    result.spawnError === null && !result.timedOut && result.exitCode === 0
  );
}
