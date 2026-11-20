import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GenerationOutcome,
  OpenRouterClient,
} from "@/lib/server/integrations/openrouter/client";
import type { ChunkPolicy } from "@ai-showdown/shared";
import type { GenerationChallenge } from "@/lib/server/services/llm/prompt";
import type { LLMModelRecord } from "@/lib/server/services/llm/models";
import type { ExistingChunk } from "@/lib/server/services/pipeline/pipeline-persist";

/**
 * F17 chunked generation.
 *
 * The acceptance criterion these tests exist for: "restarting after interruption
 * does not duplicate completed execution records, and does not re-spend tokens on
 * already-rendered chunks." That is entirely a property of the chunk loop, so it
 * is tested with persistence mocked and the provider call counted.
 */

const store = vi.hoisted(() => ({
  chunks: [] as Array<{
    chunkIndex: number;
    source: string;
    finishReason: string | null;
  }>,
}));

const persist = vi.hoisted(() => ({
  markExecutionStatus: vi.fn(),
  listChunks: vi.fn(),
  upsertChunk: vi.fn(),
}));

vi.mock("@/lib/server/services/evaluation/persist", () => ({
  markExecutionStatus: persist.markExecutionStatus,
  upsertExecution: vi.fn(),
}));

vi.mock("@/lib/server/services/pipeline/pipeline-persist", () => ({
  listChunks: persist.listChunks,
  upsertChunk: persist.upsertChunk,
}));

const { generateChunks } =
  await import("@/lib/server/services/llm/generate-chunks");

const MODEL: LLMModelRecord = {
  id: "model-uuid",
  slug: "nemo",
  name: "Mistral Nemo",
  provider: "openrouter",
  openrouterModelId: "mistralai/mistral-nemo",
  config: { temperature: 0 },
  sortOrder: 1,
  role: "competitor",
};

const CHALLENGE: GenerationChallenge = {
  title: "Isometric donut",
  prompt: "Draw a donut.",
  styleConstraints: "Two fills.",
  entryPoint: "drawFrame",
  targetDurationMs: 1200,
  frameCount: 36,
  frameWidth: 320,
  frameHeight: 240,
  starterCode: "",
};

const POLICY: ChunkPolicy = {
  maxTokensPerChunk: 2048,
  maxChunks: 3,
  promptTemplateVersion: "render-v1+chunk-v1",
};

function success(content: string, finishReason = "length"): GenerationOutcome {
  return {
    ok: true,
    content,
    finishReason,
    requestedModel: MODEL.openrouterModelId,
    servedModel: MODEL.openrouterModelId,
    providerRequestId: "gen-1",
    usage: { inputUnits: 10, outputUnits: 20, totalUnits: 30 },
    attempts: 1,
    latencyMs: 500,
    attemptsDetail: [],
  };
}

function client(responses: GenerationOutcome[]): OpenRouterClient & {
  generate: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  return {
    maxAttempts: 3,
    forfeitThreshold: 3,
    generate: vi.fn(async () => {
      const response = responses[call];
      call += 1;
      if (!response) throw new Error("client called more times than scripted");
      return response;
    }),
  };
}

function run(
  testClient: OpenRouterClient,
  onChunk?: (chunk: ExistingChunk, source: string) => void,
) {
  return generateChunks({
    roundId: "round-1",
    executionId: "exec-1",
    model: MODEL,
    challenge: CHALLENGE,
    policy: POLICY,
    correlationId: "corr-1",
    client: testClient,
    onChunk,
  });
}

beforeEach(() => {
  store.chunks = [];
  persist.markExecutionStatus.mockReset();
  persist.upsertChunk.mockReset();
  persist.listChunks.mockReset();
  persist.listChunks.mockImplementation(async () => [...store.chunks]);
  persist.upsertChunk.mockImplementation(
    async (row: {
      chunkIndex: number;
      source: string;
      finishReason: string | null;
    }) => {
      store.chunks.push({
        chunkIndex: row.chunkIndex,
        source: row.source,
        finishReason: row.finishReason,
      });
    },
  );
});

describe("generateChunks", () => {
  it("fills every chunk slot even when a model finishes early", async () => {
    // The bug this pins: a model that answers the whole brief in its first
    // reply used to end at chunk 1 of 3, while its rivals wrote 3. The early
    // finisher closed live betting mid-race and its chunk counter read "1 of 3".
    const testClient = client([
      success(
        "function drawFrame(t, ctx) {\n  ctx.fillRect(0, 0, 1, 1);\n}",
        "stop",
      ),
      success("drawFrame = () => {};", "stop"),
      success("", "stop"),
    ]);

    const result = await run(testClient);

    expect(testClient.generate).toHaveBeenCalledTimes(POLICY.maxChunks);
    expect(result.chunksGenerated).toBe(POLICY.maxChunks);
    expect(result.status).toBe("succeeded");
  });

  it("asks a finished model to extend, not to continue", async () => {
    const testClient = client([
      success(
        "function drawFrame(t, ctx) {\n  ctx.fillRect(0, 0, 1, 1);\n}",
        "stop",
      ),
      success("drawFrame = () => {};", "stop"),
      success("drawFrame = () => {};", "stop"),
    ]);

    await run(testClient);

    // Chunk 0 is the plain brief.
    const first = testClient.generate.mock.calls[0][0].messages;
    expect(first.map((m: { role: string }) => m.role)).toEqual([
      "system",
      "user",
    ]);

    // The later chunks carry the extension instruction, which tells the model to
    // layer over the existing entry point — never to write a second `function
    // drawFrame` declaration, which hoisting would turn into infinite recursion.
    const second = testClient.generate.mock.calls[1][0].messages;
    const instruction = second[second.length - 1].content as string;
    expect(instruction).toContain(
      "already defines a complete, working renderer",
    );
    expect(instruction).toContain("const __earlier1 = drawFrame;");
    expect(instruction).toContain("drawFrame = function (t, ctx, canvas) {");
    expect(instruction).toContain("Do not write a second");
  });

  it("continues a model that has not finished, keeping one schedule", async () => {
    const testClient = client([
      success("function drawFrame(t, ctx) {\n", "length"),
      success("  ctx.fillRect(0, 0, 1, 1);\n", "length"),
      success("}", "stop"),
    ]);

    await run(testClient);

    const second = testClient.generate.mock.calls[1][0].messages;
    const instruction = second[second.length - 1].content as string;
    expect(instruction).toContain("continuing the same function");
    expect(instruction).not.toContain("already defines a complete");
  });

  it("marks only the round's last chunk as terminal", async () => {
    // `terminal` is what closes live betting. An early `stop` must not carry it.
    const beforeReveal = vi.fn();
    const testClient = client([
      success("function drawFrame(t) {}", "stop"),
      success("drawFrame = () => {};", "stop"),
      success("drawFrame = () => {};", "stop"),
    ]);

    await generateChunks({
      roundId: "round-1",
      executionId: "exec-1",
      model: MODEL,
      challenge: CHALLENGE,
      policy: POLICY,
      correlationId: "corr-1",
      client: testClient,
      beforeReveal,
    });

    const terminals = beforeReveal.mock.calls
      .map(([event]) => event)
      .filter((event) => event.kind === "chunk")
      .map((event) => event.terminal);

    expect(terminals).toEqual([false, false, true]);
  });

  it("does not exceed maxChunks", async () => {
    // Every chunk hits the cap and never says stop.
    const testClient = client([
      success("a", "length"),
      success("b", "length"),
      success("c", "length"),
    ]);

    const result = await run(testClient);

    expect(testClient.generate).toHaveBeenCalledTimes(POLICY.maxChunks);
    expect(result.code).toBe("a\nb\nc");
  });

  it("resumes without re-spending tokens on stored chunks", async () => {
    // Two chunks already exist from a previous run; the third was never made.
    store.chunks = [
      {
        chunkIndex: 0,
        source: "function drawFrame(t, ctx) {\n",
        finishReason: "length",
      },
      {
        chunkIndex: 1,
        source: "  ctx.fillRect(0, 0, 1, 1);\n",
        finishReason: "length",
      },
    ];

    const testClient = client([success("}", "stop")]);
    const onChunk = vi.fn();

    const result = await run(testClient, onChunk);

    // Exactly one provider call — for the one missing chunk.
    expect(testClient.generate).toHaveBeenCalledTimes(1);
    expect(result.chunksResumed).toBe(2);
    expect(result.chunksGenerated).toBe(1);
    // The resumed chunks are not re-published as previews.
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(
      "function drawFrame(t, ctx) {\n  ctx.fillRect(0, 0, 1, 1);\n}",
    );
  });

  it("makes no provider call once every chunk slot is stored", async () => {
    store.chunks = [
      {
        chunkIndex: 0,
        source: "function drawFrame(t) {",
        finishReason: "stop",
      },
      { chunkIndex: 1, source: "}", finishReason: "length" },
      { chunkIndex: 2, source: "// detail", finishReason: "stop" },
    ];

    const testClient = client([]);
    const result = await run(testClient);

    expect(testClient.generate).not.toHaveBeenCalled();
    expect(result.chunksGenerated).toBe(0);
    expect(result.chunksResumed).toBe(3);
  });

  it("resumes a run that stopped early by filling the missing slots", async () => {
    // A round stored under the old rule ended at a `stop` chunk. The chunks are
    // still real output, so they are resumed — but the two slots the model never
    // wrote are generated, so the round's chunk count is still the schedule's.
    store.chunks = [
      {
        chunkIndex: 0,
        source: "function drawFrame(t) { ctx.fillRect(0, 0, 1, 1); }",
        finishReason: "stop",
      },
    ];

    const testClient = client([
      success("drawFrame = () => {};", "stop"),
      success("drawFrame = () => {};", "stop"),
    ]);

    const result = await run(testClient);

    expect(testClient.generate).toHaveBeenCalledTimes(2);
    expect(result.chunksResumed).toBe(1);
    expect(result.chunksGenerated).toBe(2);
  });

  it("maps a provider failure to a forfeit and never returns partial credit", async () => {
    const testClient = client([
      success("function drawFrame(t, ctx) {\n", "length"),
      {
        ok: false,
        failureKind: "auth",
        status: 401,
        exhausted: false,
        providerMessage: "Invalid key",
        providerRequestId: null,
        servedModel: null,
        attempts: 1,
        latencyMs: 100,
        attemptsDetail: [],
      },
    ]);

    const result = await run(testClient);

    expect(result.forfeited).toBe(true);
    expect(result.code).toBeNull();
    expect(result.chunksGenerated).toBe(1);
    // The failure status lands on the execution.
    expect(persist.markExecutionStatus).toHaveBeenCalledWith(
      "exec-1",
      "unavailable",
      expect.anything(),
    );
  });

  it("asks chunk 0 exactly as an unchunked turn would", async () => {
    const testClient = client([
      success("function drawFrame(t) {}", "stop"),
      success("drawFrame = () => {};", "stop"),
      success("drawFrame = () => {};", "stop"),
    ]);
    await run(testClient);

    const request = testClient.generate.mock.calls[0][0];
    expect(request.messages.map((m: { role: string }) => m.role)).toEqual([
      "system",
      "user",
    ]);
    // The per-chunk cap is what the policy says, not the model config.
    expect(request.params.max_tokens).toBe(POLICY.maxTokensPerChunk);
  });
});
