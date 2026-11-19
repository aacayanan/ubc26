import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChunkPolicy } from "@ai-showdown/shared";
import type { BriefRecord } from "@/lib/server/services/briefs/briefs";
import type { RoundRunInputs } from "@/lib/server/services/pipeline/round-inputs";
import type { LLMModelRecord } from "@/lib/server/services/llm/models";

/**
 * F17 round pipeline — stage order and the gate→judge rule.
 *
 * Every collaborator that touches the network, Docker or Postgres is mocked, so
 * what is under test is the orchestration itself: does a failed render reach the
 * judge, does a generation forfeit short-circuit, and does a missing judge leave
 * models unjudged rather than fabricated?
 *
 * These are the rules the acceptance criteria name, expressed as ordering
 * assertions.
 */

const deps = vi.hoisted(() => ({
  loadRoundRunInputs: vi.fn(),
  generateChunks: vi.fn(),
  evaluateArtifact: vi.fn(),
  renderPreview: vi.fn(),
  getActiveJudge: vi.fn(),
  judgeModelRender: vi.fn(),
  getRenderedArtifact: vi.fn(),
  getJudgeVerdict: vi.fn(),
  upsertExecution: vi.fn(),
  getChunkPolicy: vi.fn(),
  transitionRound: vi.fn(),
}));

vi.mock("@/lib/server/services/pipeline/round-inputs", () => ({
  loadRoundRunInputs: deps.loadRoundRunInputs,
}));
vi.mock("@/lib/server/services/llm/generate-chunks", () => ({
  generateChunks: deps.generateChunks,
}));
vi.mock("@/lib/server/services/evaluation/artifact-run", () => ({
  evaluateArtifact: deps.evaluateArtifact,
  isEligibleForJudging: (gatePassed: boolean) => gatePassed,
}));
vi.mock("@/lib/server/services/evaluation/preview-run", () => ({
  renderPreview: deps.renderPreview,
}));
vi.mock("@/lib/server/services/llm/models", () => ({
  getActiveJudge: deps.getActiveJudge,
}));
vi.mock("@/lib/server/services/llm/judge", () => ({
  judgeModelRender: deps.judgeModelRender,
}));
vi.mock("@/lib/server/services/evaluation/artifacts", () => ({
  getRenderedArtifact: deps.getRenderedArtifact,
}));
vi.mock("@/lib/server/services/pipeline/pipeline-persist", () => ({
  getJudgeVerdict: deps.getJudgeVerdict,
}));
vi.mock("@/lib/server/services/evaluation/persist", () => ({
  upsertExecution: deps.upsertExecution,
  markExecutionStatus: vi.fn(),
}));
vi.mock("@/lib/server/services/evaluation/chunk-policy", () => ({
  getChunkPolicy: deps.getChunkPolicy,
  chunkParams: (config: Record<string, unknown>, policy: ChunkPolicy) => ({
    ...config,
    max_tokens: policy.maxTokensPerChunk,
  }),
}));

const { runRoundPipeline } =
  await import("@/lib/server/services/pipeline/run-round");

const POLICY: ChunkPolicy = {
  maxTokensPerChunk: 2048,
  maxChunks: 3,
  promptTemplateVersion: "render-v1+chunk-v1",
};

const BRIEF: BriefRecord = {
  id: "brief-1",
  slug: "isometric-donut",
  version: 1,
  title: "Isometric donut",
  prompt: "Draw a donut.",
  styleConstraints: "Two fills.",
  entryPoint: "drawFrame",
  targetDurationMs: 1200,
  frameCount: 4,
  frameWidth: 320,
  frameHeight: 240,
  deterministicChecks: [],
  judgeRubric: [{ id: "subject", question: "Is there a donut?", weight: 1 }],
  starterCode: "",
  referenceImpl: "",
  referenceValidatedAt: null,
};

const JUDGE: LLMModelRecord = {
  id: "judge-uuid",
  slug: "judge",
  name: "Judge",
  provider: "openrouter",
  openrouterModelId: "nvidia/nemotron",
  config: {},
  sortOrder: 100,
  role: "judge",
};

function frame(index: number) {
  return {
    index,
    png: "iVBORw0KGgo=",
    blank: false,
    distinctColors: 12,
    width: 320,
    height: 240,
  };
}

function participant(id: string, ordinal: number) {
  return {
    id,
    slug: id,
    name: id,
    provider: "openrouter",
    openrouterModelId: `test/${id}`,
    config: {},
    sortOrder: ordinal,
    role: "competitor" as const,
    ordinal,
  };
}

function inputs(status: RoundRunInputs["status"]): RoundRunInputs {
  return {
    roundId: "round-1",
    slug: "round-one",
    status,
    brief: BRIEF,
    participants: [participant("a", 1), participant("b", 2)],
  };
}

const supabase = { from: vi.fn(), rpc: deps.transitionRound } as never;

beforeEach(() => {
  Object.values(deps).forEach((fn) => fn.mockReset());
  deps.getChunkPolicy.mockReturnValue(POLICY);
  deps.upsertExecution.mockResolvedValue({ id: "exec-1" });
  deps.getActiveJudge.mockResolvedValue(JUDGE);
  deps.transitionRound.mockResolvedValue({ data: null, error: null });
  deps.loadRoundRunInputs.mockResolvedValue(inputs("LOCKED"));
  deps.renderPreview.mockResolvedValue({
    rendered: true,
    parseOk: true,
    frames: 4,
  });
  // Default: no stored artifact, so the first run renders. The resume test
  // overrides this.
  deps.getRenderedArtifact.mockResolvedValue(null);
  deps.getJudgeVerdict.mockResolvedValue(null);
});

function run(overrides: Record<string, unknown> = {}) {
  return runRoundPipeline({
    roundId: "round-1",
    correlationId: "corr-1",
    supabase,
    ...overrides,
  });
}

describe("runRoundPipeline", () => {
  it("refuses an OPEN round before doing any work", async () => {
    deps.loadRoundRunInputs.mockResolvedValue(inputs("OPEN"));

    await expect(run()).rejects.toThrow(/only runs a locked round/);
    expect(deps.generateChunks).not.toHaveBeenCalled();
    expect(deps.evaluateArtifact).not.toHaveBeenCalled();
  });

  it("generates, renders and judges each gate-passing model", async () => {
    deps.generateChunks.mockResolvedValue({
      executionId: "exec-1",
      status: "succeeded",
      forfeited: false,
      code: "function drawFrame(){}",
      chunksGenerated: 2,
      chunksResumed: 0,
      failureReason: null,
    });
    deps.evaluateArtifact.mockResolvedValue({
      artifactId: "art-1",
      gatePassed: true,
      gateFailureReason: null,
      checks: [],
      eligibleForJudging: true,
      framesRendered: 4,
      framesStored: 4,
      framesTruncated: false,
      unavailable: false,
      frames: [frame(0)],
    });
    deps.judgeModelRender.mockResolvedValue({
      executionId: "judge-exec",
      verdict: { kind: "ruled", conformed: true, reason: "Looks right." },
    });

    const result = await run();

    expect(deps.evaluateArtifact).toHaveBeenCalledTimes(2);
    expect(deps.judgeModelRender).toHaveBeenCalledTimes(2);
    expect(result.judged).toBe(true);
    expect(result.models.every((m) => m.judge?.kind === "ruled")).toBe(true);
  });

  it("never sends a failed gate to the judge", async () => {
    deps.generateChunks.mockResolvedValue({
      executionId: "exec-1",
      status: "succeeded",
      forfeited: false,
      code: "function drawFrame(){}",
      chunksGenerated: 1,
      chunksResumed: 0,
      failureReason: null,
    });
    deps.evaluateArtifact.mockResolvedValue({
      artifactId: "art-1",
      gatePassed: false,
      gateFailureReason: "The canvas was blank.",
      checks: [],
      eligibleForJudging: false,
      framesRendered: 4,
      framesStored: 4,
      framesTruncated: false,
      unavailable: false,
      frames: [frame(0)],
    });

    const result = await run();

    expect(deps.judgeModelRender).not.toHaveBeenCalled();
    expect(result.models.every((m) => m.judge === null)).toBe(true);
    expect(result.models[0].gate.failureReason).toBe("The canvas was blank.");
  });

  it("short-circuits a generation forfeit without rendering or judging", async () => {
    deps.generateChunks.mockResolvedValue({
      executionId: "exec-1",
      status: "unavailable",
      forfeited: true,
      code: null,
      chunksGenerated: 0,
      chunksResumed: 0,
      failureReason: "Invalid key",
    });

    const result = await run();

    expect(deps.evaluateArtifact).not.toHaveBeenCalled();
    expect(deps.judgeModelRender).not.toHaveBeenCalled();
    expect(result.models.every((m) => m.generationForfeited)).toBe(true);
    expect(result.models[0].generationFailureReason).toBe("Invalid key");
    // A generation forfeit fails the gate — it is the model's failure, not an
    // infrastructure state that would make the round retryable.
    expect(result.models[0].gate.unavailable).toBe(false);
  });

  it("leaves gate-passing models unjudged when no judge is seated", async () => {
    deps.getActiveJudge.mockResolvedValue(null);
    deps.generateChunks.mockResolvedValue({
      executionId: "exec-1",
      status: "succeeded",
      forfeited: false,
      code: "function drawFrame(){}",
      chunksGenerated: 1,
      chunksResumed: 0,
      failureReason: null,
    });
    deps.evaluateArtifact.mockResolvedValue({
      artifactId: "art-1",
      gatePassed: true,
      gateFailureReason: null,
      checks: [],
      eligibleForJudging: true,
      framesRendered: 4,
      framesStored: 4,
      framesTruncated: false,
      unavailable: false,
      frames: [frame(0)],
    });

    const result = await run();

    expect(deps.judgeModelRender).not.toHaveBeenCalled();
    expect(result.judged).toBe(false);
    expect(result.models.every((m) => m.judge === null)).toBe(true);
  });

  it("publishes a preview for each chunk as generation streams", async () => {
    deps.generateChunks.mockImplementation(
      async (input: {
        onChunk: (
          chunk: { chunkIndex: number },
          source: string,
        ) => Promise<void>;
      }) => {
        await input.onChunk({ chunkIndex: 0 }, "function drawFrame(){}");
        return {
          executionId: "exec-1",
          status: "succeeded",
          forfeited: false,
          code: "function drawFrame(){}",
          chunksGenerated: 1,
          chunksResumed: 0,
          failureReason: null,
        };
      },
    );
    deps.evaluateArtifact.mockResolvedValue({
      artifactId: "art-1",
      gatePassed: true,
      gateFailureReason: null,
      checks: [],
      eligibleForJudging: true,
      framesRendered: 4,
      framesStored: 4,
      framesTruncated: false,
      unavailable: false,
      frames: [frame(0)],
    });
    deps.judgeModelRender.mockResolvedValue({
      executionId: "judge-exec",
      verdict: { kind: "ruled", conformed: true, reason: "ok" },
    });

    await run();

    // One preview per model per chunk.
    expect(deps.renderPreview).toHaveBeenCalledTimes(2);
    expect(deps.renderPreview.mock.calls[0][0].chunkIndex).toBe(0);
  });

  it("re-reads a stored artifact on a resume instead of re-rendering", async () => {
    deps.generateChunks.mockResolvedValue({
      executionId: "exec-1",
      status: "succeeded",
      forfeited: false,
      code: "function drawFrame(){}",
      chunksGenerated: 0,
      chunksResumed: 2,
      failureReason: null,
    });
    // A prior run already rendered and gated this source.
    deps.getRenderedArtifact.mockResolvedValue({
      executionId: "exec-1",
      gatePassed: true,
      gateFailureReason: null,
      checks: [],
      frameCount: 1,
      frames: [frame(0)],
      framesTruncated: false,
      unavailable: false,
    });
    // ...and already ruled on it.
    deps.getJudgeVerdict.mockResolvedValue({
      subjectModelId: "a",
      verdict: "conformed",
      reason: "Already ruled.",
      criteria: [],
    });

    const result = await run();

    // Neither the sandbox nor the judge runs again.
    expect(deps.evaluateArtifact).not.toHaveBeenCalled();
    expect(deps.judgeModelRender).not.toHaveBeenCalled();
    expect(result.judged).toBe(true);
    expect(result.models[0].judge?.kind).toBe("ruled");
  });

  it("re-renders an artifact that recorded an outage", async () => {
    deps.generateChunks.mockResolvedValue({
      executionId: "exec-1",
      status: "succeeded",
      forfeited: false,
      code: "function drawFrame(){}",
      chunksGenerated: 0,
      chunksResumed: 1,
      failureReason: null,
    });
    deps.getRenderedArtifact.mockResolvedValue({
      executionId: "exec-1",
      gatePassed: false,
      gateFailureReason: "sandbox down",
      checks: [],
      frameCount: 0,
      frames: [],
      framesTruncated: false,
      unavailable: true,
    });
    deps.evaluateArtifact.mockResolvedValue({
      artifactId: "art-1",
      gatePassed: true,
      gateFailureReason: null,
      checks: [],
      eligibleForJudging: true,
      framesRendered: 4,
      framesStored: 4,
      framesTruncated: false,
      unavailable: false,
      frames: [frame(0)],
    });
    deps.judgeModelRender.mockResolvedValue({
      executionId: "judge-exec",
      verdict: { kind: "ruled", conformed: true, reason: "ok" },
    });

    await run();

    expect(deps.evaluateArtifact).toHaveBeenCalled();
  });

  it("keeps generating when a preview render throws", async () => {
    deps.renderPreview.mockRejectedValue(new Error("docker down"));
    deps.generateChunks.mockImplementation(
      async (input: {
        onChunk: (
          chunk: { chunkIndex: number },
          source: string,
        ) => Promise<void>;
      }) => {
        // The callback swallows the failure; generation must continue.
        await input.onChunk({ chunkIndex: 0 }, "function drawFrame(){}");
        return {
          executionId: "exec-1",
          status: "succeeded",
          forfeited: false,
          code: "function drawFrame(){}",
          chunksGenerated: 1,
          chunksResumed: 0,
          failureReason: null,
        };
      },
    );
    deps.evaluateArtifact.mockResolvedValue({
      artifactId: "art-1",
      gatePassed: true,
      gateFailureReason: null,
      checks: [],
      eligibleForJudging: true,
      framesRendered: 4,
      framesStored: 4,
      framesTruncated: false,
      unavailable: false,
      frames: [frame(0)],
    });
    deps.judgeModelRender.mockResolvedValue({
      executionId: "judge-exec",
      verdict: { kind: "ruled", conformed: true, reason: "ok" },
    });

    const result = await run();
    expect(result.models[0].generationForfeited).toBe(false);
    expect(deps.evaluateArtifact).toHaveBeenCalled();
  });

  it("moves a locked round to RUNNING and then EVALUATING", async () => {
    deps.generateChunks.mockResolvedValue({
      executionId: "exec-1",
      status: "succeeded",
      forfeited: false,
      code: "function drawFrame(){}",
      chunksGenerated: 1,
      chunksResumed: 0,
      failureReason: null,
    });
    deps.evaluateArtifact.mockResolvedValue({
      artifactId: "art-1",
      gatePassed: true,
      gateFailureReason: null,
      checks: [],
      eligibleForJudging: true,
      framesRendered: 4,
      framesStored: 4,
      framesTruncated: false,
      unavailable: false,
      frames: [frame(0)],
    });
    deps.judgeModelRender.mockResolvedValue({
      executionId: "judge-exec",
      verdict: { kind: "ruled", conformed: true, reason: "ok" },
    });

    await run();

    const targets = deps.transitionRound.mock.calls.map(
      (call) => (call[1] as { p_to_status: string }).p_to_status,
    );
    expect(targets).toEqual(["RUNNING", "EVALUATING"]);
  });

  it("leaves the round RUNNING when no judge could rule", async () => {
    deps.getActiveJudge.mockResolvedValue(null);
    deps.generateChunks.mockResolvedValue({
      executionId: "exec-1",
      status: "succeeded",
      forfeited: false,
      code: "function drawFrame(){}",
      chunksGenerated: 1,
      chunksResumed: 0,
      failureReason: null,
    });
    deps.evaluateArtifact.mockResolvedValue({
      artifactId: "art-1",
      gatePassed: true,
      gateFailureReason: null,
      checks: [],
      eligibleForJudging: true,
      framesRendered: 4,
      framesStored: 4,
      framesTruncated: false,
      unavailable: false,
      frames: [frame(0)],
    });

    const result = await run();

    expect(result.judged).toBe(false);
    const targets = deps.transitionRound.mock.calls.map(
      (call) => (call[1] as { p_to_status: string }).p_to_status,
    );
    // A round still needing a pass stays RUNNING — that is what makes the next
    // job tick pick it up instead of leaving it settled on a guess.
    expect(targets).toEqual(["RUNNING"]);
  });

  it("generates for every model concurrently", async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });

    deps.generateChunks.mockImplementation(async () => {
      started += 1;
      if (started === 2) release?.();
      // Deadlocks if generation were serial: the first call would wait forever
      // for a second call that never starts.
      await bothStarted;
      return {
        executionId: "exec-1",
        status: "failed",
        forfeited: true,
        code: null,
        chunksGenerated: 0,
        chunksResumed: 0,
        failureReason: "stopped for the test",
      };
    });

    const result = await run();

    expect(started).toBe(2);
    expect(result.models.every((m) => m.generationForfeited)).toBe(true);
  });

  it("never runs two preview renders at once", async () => {
    let active = 0;
    let peak = 0;

    deps.renderPreview.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { rendered: true, parseOk: true, frames: 4 };
    });

    deps.generateChunks.mockImplementation(
      async (input: {
        onChunk: (
          chunk: { chunkIndex: number },
          source: string,
        ) => Promise<void>;
      }) => {
        // Both models fire two previews at the same time; the limiter must
        // serialize them or three Chromium containers contend for the host.
        await Promise.all([
          input.onChunk({ chunkIndex: 0 }, "a"),
          input.onChunk({ chunkIndex: 1 }, "b"),
        ]);
        return {
          executionId: "exec-1",
          status: "failed",
          forfeited: true,
          code: null,
          chunksGenerated: 0,
          chunksResumed: 0,
          failureReason: "stopped for the test",
        };
      },
    );

    await run();

    expect(peak).toBe(1);
  });
});
