import { describe, expect, it, vi } from "vitest";
import {
  buildRequestBody,
  createOpenRouterClient,
  sanitizeProviderMessage,
  type ChatMessage,
  type OpenRouterRequest,
} from "@/lib/server/integrations/openrouter/client";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "system prompt" },
  { role: "user", content: "solve it" },
];

function request(
  overrides: Partial<OpenRouterRequest> = {},
): OpenRouterRequest {
  return {
    model: "test/model-a",
    messages: MESSAGES,
    params: { temperature: 0 },
    correlationId: "corr-1",
    ...overrides,
  };
}

function successBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "gen-123",
    model: "test/model-a",
    choices: [
      {
        message: { role: "assistant", content: "def f(x):\n    return x" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    ...overrides,
  });
}

function jsonResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(fetchImpl: typeof fetch, overrides = {}) {
  return createOpenRouterClient({
    apiKey: "test-key",
    fetch: fetchImpl,
    sleep: async () => {},
    maxAttempts: 3,
    forfeitThreshold: 3,
    ...overrides,
  });
}

describe("buildRequestBody", () => {
  it("cannot let params override the request envelope", () => {
    const body = buildRequestBody(
      request({
        params: {
          temperature: 0.2,
          model: "evil/model",
          messages: [],
          stream: true,
        },
      }),
    );

    expect(body.model).toBe("test/model-a");
    expect(body.messages).toBe(MESSAGES);
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.2);
  });
});

describe("createOpenRouterClient", () => {
  it("returns the completion with model, usage and id recorded", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, successBody()));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const outcome = await client.generate(request());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.content).toContain("def f");
    expect(outcome.requestedModel).toBe("test/model-a");
    expect(outcome.servedModel).toBe("test/model-a");
    expect(outcome.providerRequestId).toBe("gen-123");
    expect(outcome.usage).toEqual({
      inputUnits: 10,
      outputUnits: 20,
      totalUnits: 30,
    });
    expect(outcome.attempts).toBe(1);
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key",
    );
    expect(JSON.parse(init.body as string).messages).toEqual(MESSAGES);
  });

  it("records a served model that differs from the request", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, successBody({ model: "test/model-a:free" })),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const outcome = await client.generate(request());

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.servedModel).toBe("test/model-a:free");
  });

  it("retries a 429 and succeeds on the next attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          429,
          JSON.stringify({ error: { message: "rate limited" } }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(200, successBody()));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const outcome = await client.generate(request());

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Each attempt must send an identical body.
    const first = (fetchImpl.mock.calls[0][1] as RequestInit).body;
    const second = (fetchImpl.mock.calls[1][1] as RequestInit).body;
    expect(first).toBe(second);
  });

  it("honours Retry-After on a 429", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, JSON.stringify({ error: { message: "slow down" } }), {
          "retry-after": "2",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, successBody()));
    const client = makeClient(fetchImpl as unknown as typeof fetch, { sleep });

    await client.generate(request());

    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("forfeits after three failed attempts on a 500", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(500, JSON.stringify({ error: { message: "boom" } })),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const outcome = await client.generate(request());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failureKind).toBe("provider_error");
    expect(outcome.attempts).toBe(3);
    expect(outcome.exhausted).toBe(true);
    expect(outcome.attemptsDetail.map((a) => a.status)).toEqual([
      500, 500, 500,
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("classifies a timeout and retries it", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch, {
      timeoutMs: 10,
    });

    const outcome = await client.generate(request());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failureKind).toBe("timeout");
    expect(outcome.attempts).toBe(3);
  });

  it("does not retry a 404 for an unknown model", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        404,
        JSON.stringify({ error: { message: "No endpoints found" } }),
      ),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const outcome = await client.generate(request());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failureKind).toBe("model_unavailable");
    expect(outcome.attempts).toBe(1);
    expect(outcome.exhausted).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps 401 to auth and 402 to insufficient credits without retrying", async () => {
    const authFetch = vi.fn(async () =>
      jsonResponse(401, JSON.stringify({ error: { message: "bad key" } })),
    );
    const authOutcome = await makeClient(
      authFetch as unknown as typeof fetch,
    ).generate(request());
    expect(authOutcome.ok).toBe(false);
    if (!authOutcome.ok) {
      expect(authOutcome.failureKind).toBe("auth");
      expect(authOutcome.attempts).toBe(1);
    }

    const creditsFetch = vi.fn(async () =>
      jsonResponse(402, JSON.stringify({ error: { message: "no credits" } })),
    );
    const creditsOutcome = await makeClient(
      creditsFetch as unknown as typeof fetch,
    ).generate(request());
    expect(creditsOutcome.ok).toBe(false);
    if (!creditsOutcome.ok) {
      expect(creditsOutcome.failureKind).toBe("insufficient_credits");
    }
  });

  it("treats a 200 with a broken body as a retriable malformed response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, "<html>nope</html>"));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const outcome = await client.generate(request());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failureKind).toBe("provider_error");
    expect(outcome.attempts).toBe(3);
  });

  it("treats a 200 with an empty completion as malformed and retries", async () => {
    const emptyBody = JSON.stringify({
      id: "gen-1",
      choices: [{ message: { content: "" }, finish_reason: "content_filter" }],
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, emptyBody))
      .mockResolvedValueOnce(jsonResponse(200, successBody()));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const outcome = await client.generate(request());

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempts).toBe(2);
  });

  it("survives two 500s before a success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, "{}"))
      .mockResolvedValueOnce(jsonResponse(502, "{}"))
      .mockResolvedValueOnce(jsonResponse(200, successBody()));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const outcome = await client.generate(request());

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempts).toBe(3);
  });

  it("retries a network rejection", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, successBody()));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const outcome = await client.generate(request());

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempts).toBe(2);
  });

  it("reports a final network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const outcome = await client.generate(request());

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe("network");
      expect(outcome.attempts).toBe(3);
    }
  });
});

describe("sanitizeProviderMessage", () => {
  it("collapses whitespace and truncates", () => {
    const message = sanitizeProviderMessage(
      "line one\n\nline two   " + "x".repeat(400),
    );
    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThanOrEqual(200);
  });
});
