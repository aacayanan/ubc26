import "server-only";

import type { LLMFailureKind } from "@ai-showdown/shared";
import { logger } from "@/lib/server/logging/logger";

/**
 * OpenRouter client (F16).
 *
 * One `generate()` call asks a single configured model for a completion and
 * returns an explicit outcome for every way it can fail. Provider failures are
 * values, not exceptions: a caller in the F17 pipeline needs to record them and
 * move on, so only programmer errors throw here.
 *
 * The retry loop lives inside one call. Its attempts never create new
 * `model_executions` rows — `(round_id, model_id, run_type, attempt)` belongs
 * to F17's orchestration. `attempts`/`attemptCount` describe this call only.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_FORFEIT_THRESHOLD = 3;

// Wait between attempts. The list may be shorter than maxAttempts (the last
// entry repeats) but never longer.
export const DEFAULT_BACKOFF_MS: readonly number[] = [1_000, 3_000];

const MAX_JITTER_MS = 250;
const MAX_RETRY_AFTER_MS = 5_000;
const MAX_PROVIDER_MESSAGE_CHARS = 200;

// Keys a per-model config may never set: they are the request envelope, and a
// catalog edit must not be able to retarget the request or change the prompt.
const RESERVED_PARAM_KEYS = new Set(["model", "messages", "stream"]);

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface OpenRouterRequest {
  /** `llm_models.openrouter_model_id`. */
  model: string;
  /** Identical for every model — the fairness rule (F16). */
  messages: ChatMessage[];
  /** Per-model generation params (temperature, max_tokens, …). */
  params?: Record<string, unknown>;
  correlationId: string;
}

/** What one HTTP attempt produced. Persisted for reproducibility. */
export interface AttemptRecord {
  attempt: number;
  status: number | null;
  failureKind: LLMFailureKind | null;
  durationMs: number;
}

export interface GenerationSuccess {
  ok: true;
  content: string;
  finishReason: string | null;
  requestedModel: string;
  /** May differ from requested after provider routing — recorded on purpose. */
  servedModel: string | null;
  providerRequestId: string | null;
  usage: {
    inputUnits: number | null;
    outputUnits: number | null;
    totalUnits: number | null;
  } | null;
  attempts: number;
  /** Sum of attempt durations; excludes backoff sleeps. */
  latencyMs: number;
  attemptsDetail: AttemptRecord[];
}

export interface GenerationFailure {
  ok: false;
  failureKind: LLMFailureKind;
  status: number | null;
  /** True when the class was retriable and attempts ran out. */
  exhausted: boolean;
  providerMessage: string;
  providerRequestId: string | null;
  servedModel: string | null;
  attempts: number;
  latencyMs: number;
  attemptsDetail: AttemptRecord[];
}

export type GenerationOutcome = GenerationSuccess | GenerationFailure;

export interface OpenRouterClient {
  /** HTTP attempts one `generate()` call may consume. */
  readonly maxAttempts: number;
  /** Failed attempts after which the model forfeits the round (F16). */
  readonly forfeitThreshold: number;
  generate(request: OpenRouterRequest): Promise<GenerationOutcome>;
}

export interface OpenRouterClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  forfeitThreshold?: number;
  backoffMs?: readonly number[];
  /** Injected so tests never wait on real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

interface AttemptFailure {
  ok: false;
  failureKind: LLMFailureKind;
  retriable: boolean;
  status: number | null;
  providerMessage: string;
  retryAfterMs: number | null;
}

type AttemptResult =
  | {
      ok: true;
      content: string;
      finishReason: string | null;
      servedModel: string | null;
      providerRequestId: string | null;
      usage: GenerationSuccess["usage"];
    }
  | AttemptFailure;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the request body. `config` is spread in but the envelope keys win, so
 * a hostile or careless catalog row cannot swap the model or rewrite the prompt.
 */
export function buildRequestBody(
  request: OpenRouterRequest,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request.params ?? {})) {
    if (!RESERVED_PARAM_KEYS.has(key)) params[key] = value;
  }

  return {
    ...params,
    model: request.model,
    messages: request.messages,
    stream: false,
  };
}

/** Collapse a provider message to one bounded line — it can echo request text. */
export function sanitizeProviderMessage(message: string): string {
  const single = message.replace(/\s+/g, " ").trim();
  return single.length > MAX_PROVIDER_MESSAGE_CHARS
    ? `${single.slice(0, MAX_PROVIDER_MESSAGE_CHARS - 1)}…`
    : single;
}

function classifyHttpStatus(
  status: number,
  providerMessage: string,
): AttemptFailure {
  const message = sanitizeProviderMessage(providerMessage);

  if (status === 402) {
    return {
      ok: false,
      failureKind: "insufficient_credits",
      retriable: false,
      status,
      providerMessage: message,
      retryAfterMs: null,
    };
  }

  if (status === 401 || status === 403) {
    return {
      ok: false,
      failureKind: "auth",
      retriable: false,
      status,
      providerMessage: message,
      retryAfterMs: null,
    };
  }

  if (status === 404) {
    return {
      ok: false,
      failureKind: "model_unavailable",
      retriable: false,
      status,
      providerMessage: message,
      retryAfterMs: null,
    };
  }

  // OpenRouter reports some unknown models as 400; the message is the only
  // signal that separates them from a genuinely malformed request.
  if (
    status === 400 &&
    /not a valid model|no endpoints?( found)?/i.test(message)
  ) {
    return {
      ok: false,
      failureKind: "model_unavailable",
      retriable: false,
      status,
      providerMessage: message,
      retryAfterMs: null,
    };
  }

  if (status === 400 || status === 422) {
    return {
      ok: false,
      failureKind: "invalid_request",
      retriable: false,
      status,
      providerMessage: message,
      retryAfterMs: null,
    };
  }

  // OpenRouter uses 503 with this code when no provider can serve the model
  // right now. That is the model being unavailable, not a generic outage —
  // retrying immediately only burns the attempt budget.
  if (status === 503 && /no available (model )?providers?/i.test(message)) {
    return {
      ok: false,
      failureKind: "model_unavailable",
      retriable: false,
      status,
      providerMessage: message,
      retryAfterMs: null,
    };
  }

  if (status === 429) {
    return {
      ok: false,
      failureKind: "rate_limited",
      retriable: true,
      status,
      providerMessage: message,
      retryAfterMs: null,
    };
  }

  if (status === 408 || status >= 500) {
    return {
      ok: false,
      failureKind: "provider_error",
      retriable: true,
      status,
      providerMessage: message,
      retryAfterMs: null,
    };
  }

  return {
    ok: false,
    failureKind: "provider_error",
    retriable: status >= 500,
    status,
    providerMessage: message,
    retryAfterMs: null,
  };
}

function readRetryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;

  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseSuccessBody(body: unknown): AttemptResult {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const choices = record?.choices;

  // A 200 without a usable choice is a malformed response, not a crash: some
  // providers return an error object with a 200, and content can be null when
  // a content filter fires.
  const first =
    Array.isArray(choices) && choices.length > 0
      ? (choices[0] as Record<string, unknown>)
      : null;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;

  if (typeof content !== "string" || content.trim() === "") {
    return {
      ok: false,
      failureKind: "malformed_response",
      retriable: true,
      status: 200,
      providerMessage: "Response did not contain a completion",
      retryAfterMs: null,
    };
  }

  const usage = record?.usage as Record<string, unknown> | undefined;

  return {
    ok: true,
    content,
    finishReason:
      typeof first?.finish_reason === "string" ? first.finish_reason : null,
    servedModel: typeof record?.model === "string" ? record.model : null,
    providerRequestId:
      typeof record?.id === "string" && record.id.length > 0 ? record.id : null,
    usage: usage
      ? {
          inputUnits: asNumber(usage.prompt_tokens),
          outputUnits: asNumber(usage.completion_tokens),
          totalUnits: asNumber(usage.total_tokens),
        }
      : null,
  };
}

function readProviderMessage(body: unknown, fallback: string): string {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const error = record?.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return fallback;
}

export function createOpenRouterClient(
  options: OpenRouterClientOptions,
): OpenRouterClient {
  const {
    apiKey,
    fetch: fetchImpl = fetch,
    baseUrl = OPENROUTER_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    forfeitThreshold = DEFAULT_FORFEIT_THRESHOLD,
    backoffMs = DEFAULT_BACKOFF_MS,
    sleep = defaultSleep,
  } = options;

  if (!apiKey) {
    // Programmer error: the only throw in this module.
    throw new Error("OpenRouter client requires an API key");
  }

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const attemptsCap = Math.max(1, Math.floor(maxAttempts));

  async function attemptOnce(
    request: OpenRouterRequest,
  ): Promise<{ result: AttemptResult; latencyMs: number }> {
    const controller = new AbortController();
    const startedAt = performance.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildRequestBody(request)),
        signal: controller.signal,
      });

      const latencyMs = Math.round(performance.now() - startedAt);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Non-JSON error body (an HTML proxy page, say) — status still rules.
        }
        const failure = classifyHttpStatus(
          response.status,
          readProviderMessage(parsed, `HTTP ${response.status}`),
        );
        failure.retryAfterMs = readRetryAfterMs(response);
        return { result: failure, latencyMs };
      }

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          result: {
            ok: false,
            failureKind: "provider_error",
            retriable: true,
            status: response.status,
            providerMessage: "Response body was not valid JSON",
            retryAfterMs: null,
          },
          latencyMs,
        };
      }

      return { result: parseSuccessBody(parsed), latencyMs };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startedAt);

      if (timedOut) {
        return {
          result: {
            ok: false,
            failureKind: "timeout",
            retriable: true,
            status: null,
            providerMessage: `Request exceeded ${timeoutMs} ms`,
            retryAfterMs: null,
          },
          latencyMs,
        };
      }

      // A transport-level rejection (DNS, TLS, socket reset). Fetch wraps these
      // in TypeError; anything else is unexpected and only retried once over.
      const isAbort = error instanceof Error && error.name === "AbortError";
      return {
        result: {
          ok: false,
          failureKind: isAbort ? "timeout" : "network",
          retriable: true,
          status: null,
          providerMessage: sanitizeProviderMessage(
            error instanceof Error ? error.message : "Network request failed",
          ),
          retryAfterMs: null,
        },
        latencyMs,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function generate(
    request: OpenRouterRequest,
  ): Promise<GenerationOutcome> {
    const { correlationId, model } = request;

    if (request.messages.length === 0) {
      throw new Error("OpenRouter request has no messages");
    }

    const attemptsDetail: AttemptRecord[] = [];
    let totalAttemptMs = 0;
    let last: AttemptFailure | null = null;
    let lastRequestId: string | null = null;
    let lastServedModel: string | null = null;

    for (let attempt = 1; attempt <= attemptsCap; attempt += 1) {
      logger.info("openrouter.request.started", {
        correlationId,
        model,
        attempt,
      });

      const { result, latencyMs } = await attemptOnce(request);
      totalAttemptMs += latencyMs;

      if (result.ok) {
        attemptsDetail.push({
          attempt,
          status: 200,
          failureKind: null,
          durationMs: latencyMs,
        });
        logger.info("openrouter.request.succeeded", {
          correlationId,
          model,
          attempt,
          attempts: attempt,
          latencyMs: totalAttemptMs,
          servedModel: result.servedModel,
        });

        return {
          ok: true,
          content: result.content,
          finishReason: result.finishReason,
          requestedModel: model,
          servedModel: result.servedModel,
          providerRequestId: result.providerRequestId,
          usage: result.usage,
          attempts: attempt,
          latencyMs: totalAttemptMs,
          attemptsDetail,
        };
      }

      attemptsDetail.push({
        attempt,
        status: result.status,
        failureKind: result.failureKind,
        durationMs: latencyMs,
      });
      last = result;
      lastServedModel = lastServedModel ?? null;
      lastRequestId = lastRequestId ?? null;

      const hasAttemptsLeft = attempt < attemptsCap;

      logger.warn("openrouter.request.attempt_failed", {
        correlationId,
        model,
        attempt,
        statusCode: result.status,
        failureKind: result.failureKind,
        retriable: result.retriable,
        latencyMs,
      });

      if (!result.retriable || !hasAttemptsLeft) break;

      const base = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0;
      const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
      const waitMs = Math.min(
        result.retryAfterMs ?? base + jitter,
        MAX_RETRY_AFTER_MS + MAX_JITTER_MS,
      );

      logger.info("openrouter.request.retrying", {
        correlationId,
        model,
        nextAttempt: attempt + 1,
        waitMs,
      });
      await sleep(waitMs);
    }

    // The loop always runs at least once and every iteration either returns or
    // assigns `last`, but TypeScript cannot prove it.
    const failure = last as AttemptFailure;
    const attempts = attemptsDetail.length;
    const outcome: GenerationFailure = {
      ok: false,
      failureKind: failure.failureKind,
      status: failure.status,
      exhausted: failure.retriable,
      providerMessage: failure.providerMessage,
      providerRequestId: lastRequestId,
      servedModel: lastServedModel,
      attempts,
      latencyMs: totalAttemptMs,
      attemptsDetail,
    };

    logger.error("openrouter.request.failed", {
      correlationId,
      model,
      attempts,
      statusCode: failure.status,
      failureKind: failure.failureKind,
      exhausted: outcome.exhausted,
      willForfeit: outcome.exhausted && attempts >= forfeitThreshold,
      latencyMs: totalAttemptMs,
    });

    return outcome;
  }

  return { maxAttempts: attemptsCap, forfeitThreshold, generate };
}
