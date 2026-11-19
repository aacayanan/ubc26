import "server-only";

import { ConfigurationError } from "@/lib/server/errors/app-error";

/**
 * Sandbox runner configuration (F13).
 *
 * Values are read on demand rather than validated once at module load, matching
 * `lib/config/server.ts`: a missing sandbox image should only break the code
 * paths that actually run evaluations, not page rendering.
 */
export interface SandboxEnv {
  dockerBin: string;
  /** Fully digest-pinned image reference, e.g. `name@sha256:…`. */
  imageRef: string;
  /** The trailing `sha256:…` of `imageRef`. */
  imageDigest: string;
  memoryMb: number;
  cpus: string;
  pidsLimit: number;
  wallClockMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

// A tag re-pulls, so two runs of the same solution could execute in different
// images and produce different verdicts. Requiring the digest is what makes the
// reproducibility guarantee real.
const DIGEST_PINNED = /^[\w./:@-]+@sha256:[0-9a-f]{64}$/;

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer`);
  }
  return parsed;
}

function readPositiveDecimal(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${name} must be a positive number`);
  }
  return raw.trim();
}

export function getSandboxEnv(): SandboxEnv {
  const imageRef = process.env.SANDBOX_IMAGE;

  if (!imageRef) {
    throw new ConfigurationError(
      "Missing SANDBOX_IMAGE (build with `npm run sandbox:build` and pin its digest)",
    );
  }

  if (!DIGEST_PINNED.test(imageRef)) {
    throw new ConfigurationError(
      "SANDBOX_IMAGE must be digest-pinned as name@sha256:<64 hex chars>; a " +
        "tag would silently re-pull and invalidate past verdicts",
    );
  }

  return {
    dockerBin: process.env.DOCKER_BIN?.trim() || "docker",
    imageRef,
    imageDigest: `sha256:${imageRef.slice(imageRef.lastIndexOf("@sha256:") + 8)}`,
    memoryMb: readPositiveInt("SANDBOX_MEMORY_MB", 256),
    cpus: readPositiveDecimal("SANDBOX_CPUS", "0.5"),
    pidsLimit: readPositiveInt("SANDBOX_PIDS_LIMIT", 64),
    wallClockMs: readPositiveInt("SANDBOX_WALL_CLOCK_MS", 120_000),
    maxStdoutBytes: readPositiveInt("SANDBOX_MAX_STDOUT_BYTES", 64 * 1024),
    maxStderrBytes: readPositiveInt("SANDBOX_MAX_STDERR_BYTES", 8 * 1024),
  };
}
