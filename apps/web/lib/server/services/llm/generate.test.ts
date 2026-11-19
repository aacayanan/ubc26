import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GenerationOutcome,
  OpenRouterClient,
} from "@/lib/server/integrations/openrouter/client";
import type { GenerationChallenge } from "@/lib/server/services/llm/prompt";
import type { LLMModelRecord } from "@/lib/server/services/llm/models";

const persist = vi.hoisted(() => ({
  upsertExecution: vi.fn(),
  markExecutionStatus: vi.fn(),
}));

vi.mock("@/lib/server/services/evaluation/persist", () => ({
  upsertExecution: persist.upsertExecution,
  markExecutionStatus: persist.markExecutionStatus,
  upsertTestResults: vi.fn(),
}));

const { generateModelSolution } =
  await import("@/lib/server/services/llm/generate");

const MODEL: LLMModelRecord = {
  id: "model-uuid",
  slug: "cheapest-3-a",
  name: "Model A",
  provider: "openrouter",
  openrouterModelId: "test/model-a",
  config: { temperature: 0 },
  sortOrder: 1,
  role: "competitor",
};

const CHALLENGE: GenerationChallenge = {
  title: "Isometric donut spinning in a loop",
  prompt: "Render a donut in an isometric projection.",
  styleConstraints: "Two flat fills on a void background.",
  entryPoint: "drawFrame",
  targetDurationMs: 1200,
  frameCount: 36,
  frameWidth: 320,
  frameHeight: 240,
  starterCode: "",
};

function clientReturning(outcome: GenerationOutcome): OpenRouterClient {
  return {
    maxAttempts: 3,
    forfeitThreshold: 3,
    generate: vi.fn(async () => outcome),
  };
}

function success(content: string, attempts = 1): GenerationOutcome {
  return {
    ok: true,
    content,
    finishReason: "stop",
    requestedModel: "test/model-a",
    servedModel: "test/model-a",
    providerRequestId: "gen-1",
    usage: { inputUnits: 1, outputUnits: 2, totalUnits: 3 },
    attempts,
    latencyMs: 42,
    attemptsDetail: [],
  };
}

function run(client: OpenRouterClient) {
  return generateModelSolution({
    roundId: "round-uuid",
    model: MODEL,
    challenge: CHALLENGE,
    correlationId: "corr-1",
    client,
  });
}

beforeEach(() => {
  persist.upsertExecution.mockReset();
  persist.markExecutionStatus.mockReset();
  persist.upsertExecution.mockResolvedValue({ id: "exec-uuid" });
  persist.markExecutionStatus.mockResolvedValue(undefined);
});

describe("generateModelSolution", () => {
  it("writes a running row first, snapshots the config, and records success", async () => {
    const result = await run(
      clientReturning(
        success("function drawFrame(t, ctx) {\n  ctx.fillRect(0, 0, 1, 1);\n}"),
      ),
    );

    const written = persist.upsertExecution.mock.calls[0][0];
    expect(written).toMatchObject({
      roundId: "round-uuid",
      modelId: "model-uuid",
      runType: "generation",
      attempt: 1,
      openrouterModelId: "test/model-a",
      status: "running",
    });
    // The snapshot records what was actually SENT, floor included (F16).
    expect(written.config.params).toEqual({ temperature: 0, max_tokens: 8192 });
    expect(written.config.promptTemplateVersion).toBe("render-v1");
    expect(written.config.promptSha256).toMatch(/^[0-9a-f]{64}$/);

    expect(result.status).toBe("succeeded");
    expect(result.code).toContain("function drawFrame");

    const [, status, patch] = persist.markExecutionStatus.mock.calls.at(-1)!;
    expect(status).toBe("succeeded");
    expect(patch.solutionCode).toContain("function drawFrame");
    expect(patch.latencyMs).toBe(42);
    expect(patch.attemptCount).toBe(1);
    expect(patch.providerRequestId).toBe("gen-1");
    expect(patch.responseMeta).toMatchObject({
      requestedModel: "test/model-a",
    });
  });

  it("marks unusable output as a forfeit without writing a solution", async () => {
    const result = await run(
      clientReturning(success("I refuse to write code.", 3)),
    );

    expect(result.status).toBe("error");
    expect(result.forfeited).toBe(true);
    expect(result.code).toBeNull();

    const [, status, patch] = persist.markExecutionStatus.mock.calls.at(-1)!;
    expect(status).toBe("error");
    expect(patch.failureKind).toBe("malformed_response");
    expect(patch.solutionCode).toBeUndefined();
  });

  it("maps a timeout to the timeout status and forfeits", async () => {
    const result = await run(
      clientReturning({
        ok: false,
        failureKind: "timeout",
        status: null,
        exhausted: true,
        providerMessage: "Request exceeded 60000 ms",
        providerRequestId: null,
        servedModel: null,
        attempts: 3,
        latencyMs: 180_000,
        attemptsDetail: [],
      }),
    );

    expect(result.status).toBe("timeout");
    expect(result.forfeited).toBe(true);

    const [, status] = persist.markExecutionStatus.mock.calls.at(-1)!;
    expect(status).toBe("timeout");
  });

  it("maps an unknown model to unavailable", async () => {
    await run(
      clientReturning({
        ok: false,
        failureKind: "model_unavailable",
        status: 404,
        exhausted: false,
        providerMessage: "No endpoints found",
        providerRequestId: null,
        servedModel: null,
        attempts: 1,
        latencyMs: 5,
        attemptsDetail: [],
      }),
    );

    const [, status, patch] = persist.markExecutionStatus.mock.calls.at(-1)!;
    expect(status).toBe("unavailable");
    expect(patch.failureKind).toBe("model_unavailable");
    expect(patch.attemptCount).toBe(1);
  });

  it("does not forfeit when a retriable failure stopped short of the threshold", async () => {
    const result = await run(
      clientReturning({
        ok: false,
        failureKind: "provider_error",
        status: 500,
        exhausted: true,
        providerMessage: "boom",
        providerRequestId: null,
        servedModel: null,
        attempts: 2,
        latencyMs: 10,
        attemptsDetail: [],
      }),
    );

    expect(result.forfeited).toBe(false);
    expect(result.status).toBe("error");
  });
});
