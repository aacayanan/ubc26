import { describe, expect, it } from "vitest";
import { createOpenRouterClient } from "@/lib/server/integrations/openrouter/client";

/**
 * A real call against OpenRouter (F16 acceptance check).
 *
 * Skipped unless OPENROUTER_API_KEY and OPENROUTER_TEST_MODEL_ID are set, so
 * `npm test` never spends credits or requires network. Run it explicitly:
 *
 *   OPENROUTER_API_KEY=... OPENROUTER_TEST_MODEL_ID=... npx vitest run \
 *     test/integration/openrouter.integration.test.ts
 */
const apiKey = process.env.OPENROUTER_API_KEY;
const modelId = process.env.OPENROUTER_TEST_MODEL_ID;

describe.skipIf(!apiKey || !modelId)("OpenRouter live call", () => {
  it("returns a Python completion with latency and a provider id", async () => {
    const client = createOpenRouterClient({
      apiKey: apiKey!,
      maxAttempts: 2,
      timeoutMs: 60_000,
    });

    const outcome = await client.generate({
      model: modelId!,
      messages: [
        {
          role: "system",
          content: "Reply with one complete Python file and nothing else.",
        },
        {
          role: "user",
          content: "Define def add(a, b) that returns their sum.",
        },
      ],
      params: { temperature: 0, max_tokens: 256 },
      correlationId: "integration-test",
    });

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.content).toContain("def add");
    expect(outcome.latencyMs).toBeGreaterThan(0);
    expect(outcome.requestedModel).toBe(modelId);
  }, 90_000);
});
