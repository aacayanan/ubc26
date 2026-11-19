import "server-only";

import { ConfigurationError } from "@/lib/server/errors/app-error";
import { getServerEnv } from "@/lib/config/server";
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_FORFEIT_THRESHOLD,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  OPENROUTER_BASE_URL,
  createOpenRouterClient,
  type OpenRouterClient,
} from "@/lib/server/integrations/openrouter/client";

/**
 * The configured OpenRouter client (F16).
 *
 * Only the API key is required. The rest is tuning and is optional in env so a
 * Docker image without it still runs; a malformed value is a configuration
 * error rather than a silent fallback, because a typo'd timeout or attempt cap
 * changes demo behaviour invisibly.
 *
 * The key is read here, lazily, and never at module scope — nothing needs to
 * exist in the bundle for this module to be analysable.
 */

function readInt(
  name: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new ConfigurationError(
      `${name} must be an integer between ${bounds.min} and ${bounds.max}`,
    );
  }
  return value;
}

function readBaseUrl(fallback: string): string {
  const raw = process.env.OPENROUTER_BASE_URL?.trim();
  if (!raw) return fallback;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError("OPENROUTER_BASE_URL is not a valid URL");
  }

  // A plaintext endpoint in production would send the API key in the clear.
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new ConfigurationError("OPENROUTER_BASE_URL must use https");
  }
  return url.toString().replace(/\/+$/, "");
}

export interface OpenRouterEnv {
  baseUrl: string;
  timeoutMs: number;
  maxAttempts: number;
  forfeitThreshold: number;
}

export function getOpenRouterEnv(): OpenRouterEnv {
  return {
    baseUrl: readBaseUrl(OPENROUTER_BASE_URL),
    timeoutMs: readInt("OPENROUTER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, {
      min: 1_000,
      max: 300_000,
    }),
    maxAttempts: readInt("OPENROUTER_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, {
      min: 1,
      max: 5,
    }),
    forfeitThreshold: readInt(
      "OPENROUTER_FORFEIT_THRESHOLD",
      DEFAULT_FORFEIT_THRESHOLD,
      { min: 1, max: 5 },
    ),
  };
}

export function getOpenRouterClient(): OpenRouterClient {
  const { openRouterApiKey } = getServerEnv();
  const env = getOpenRouterEnv();

  return createOpenRouterClient({
    apiKey: openRouterApiKey,
    baseUrl: env.baseUrl,
    timeoutMs: env.timeoutMs,
    maxAttempts: env.maxAttempts,
    forfeitThreshold: env.forfeitThreshold,
    backoffMs: DEFAULT_BACKOFF_MS,
  });
}
