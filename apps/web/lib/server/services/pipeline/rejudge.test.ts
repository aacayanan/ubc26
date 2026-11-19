import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BriefRecord } from "@/lib/server/services/briefs/briefs";
import type { RoundRunInputs } from "@/lib/server/services/pipeline/round-inputs";
import type { LLMModelRecord } from "@/lib/server/services/llm/models";
import { ConflictError, NotFoundError } from "@/lib/server/errors/app-error";

/**
 * F31 operator re-judge.
 *
 * The acceptance criterion is "judging can be re-run on stored frames without
 * re-generating code". These tests pin the fences around that: a re-judge reads
 * the stored artifact and never the sandbox, it obeys the two-clocks and
 * non-negotiable #9 (a failed gate is never judged), and a judge outage on the
 * second pass stays a typed `unavailable` rather than becoming a ruling.
 */

const deps = vi.hoisted(() => ({
  loadRoundRunInputs: vi.fn(),
  getActiveJudge: vi.fn(),
  getRenderedArtifact: vi.fn(),
  judgeModelRender: vi.fn(),
}));

vi.mock("@/lib/server/services/pipeline/round-inputs", () => ({
  loadRoundRunInputs: deps.loadRoundRunInputs,
}));
vi.mock("@/lib/server/services/llm/models", () => ({
  getActiveJudge: deps.getActiveJudge,
}));
vi.mock("@/lib/server/services/evaluation/artifacts", () => ({
  getRenderedArtifact: deps.getRenderedArtifact,
}));
vi.mock("@/lib/server/services/llm/judge", () => ({
  judgeModelRender: deps.judgeModelRender,
}));
// The eligibility rule is a one-line predicate in production; mirror it so the
// mock does not hide a semantic change.
vi.mock("@/lib/server/services/evaluation/artifact-run", () => ({
  isEligibleForJudging: (gatePassed: boolean) => gatePassed,
}));

const { rejudgeRound } = await import("@/lib/server/services/pipeline/rejudge");

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

const frame = {
  index: 0,
  png: "iVBORw0KGgo=",
  blank: false,
  distinctColors: 12,
  width: 320,
  height: 240,
};

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

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    executionId: "exec-1",
    gatePassed: true,
    gateFailureReason: null,
    checks: [],
    frameCount: 1,
    frames: [frame],
    framesTruncated: false,
    unavailable: false,
    ...overrides,
  };
}

const RUNNING = inputs("RUNNING");

/**
 * A fake supabase client good enough for the generation-execution read: one
 * generation execution per competitor, keyed `model_id`.
 */
function fakeSupabase(rows: Array<{ id: string; model_id: string }>) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => Promise.resolve({ data: rows, error: null }),
  };
  return { from: () => chain } as never;
}

beforeEach(() => {
  Object.values(deps).forEach((fn) => fn.mockReset());
  deps.loadRoundRunInputs.mockResolvedValue(RUNNING);
  deps.getActiveJudge.mockResolvedValue(JUDGE);
  deps.getRenderedArtifact.mockResolvedValue(artifact());
  deps.judgeModelRender.mockResolvedValue({
    executionId: "judge-exec",
    verdict: { kind: "ruled", conformed: true, reason: "Looks right." },
  });
});

function run(overrides: Record<string, unknown> = {}) {
  return rejudgeRound({
    roundId: "round-1",
    correlationId: "corr-1",
    supabase: fakeSupabase([
      { id: "gen-a", model_id: "a" },
      { id: "gen-b", model_id: "b" },
    ]),
    ...overrides,
  });
}

describe("rejudgeRound", () => {
  it("re-judges stored frames without rendering", async () => {
    const result = await run();

    // Both competitors judged, no render path touched.
    expect(deps.judgeModelRender).toHaveBeenCalledTimes(2);
    expect(result.models.every((m) => m.status === "judged")).toBe(true);
    expect(result.allJudged).toBe(true);

    // The frames handed to the judge are the stored artifact's, verbatim.
    const firstCall = deps.judgeModelRender.mock.calls[0][0];
    expect(firstCall.frames).toEqual([frame]);
    expect(firstCall.attempt).toBe(1); // participant a's ordinal
  });

  it("refuses a round that has not locked", async () => {
    deps.loadRoundRunInputs.mockResolvedValue(inputs("OPEN"));

    await expect(run()).rejects.toThrow(ConflictError);
    expect(deps.judgeModelRender).not.toHaveBeenCalled();
  });

  it("refuses to re-judge a finalized round", async () => {
    deps.loadRoundRunInputs.mockResolvedValue(inputs("SETTLED"));

    await expect(run()).rejects.toThrow(/only runs a locked round/);
    expect(deps.judgeModelRender).not.toHaveBeenCalled();
  });

  it("refuses when no judge is seated", async () => {
    deps.getActiveJudge.mockResolvedValue(null);

    await expect(run()).rejects.toThrow(/No judge is seated/);
    expect(deps.judgeModelRender).not.toHaveBeenCalled();
  });

  it("never sends a failed-gate render to the judge", async () => {
    deps.getRenderedArtifact.mockResolvedValue(
      artifact({
        gatePassed: false,
        gateFailureReason: "The canvas was blank.",
      }),
    );

    const result = await run();

    expect(deps.judgeModelRender).not.toHaveBeenCalled();
    expect(result.models.every((m) => m.status === "skipped")).toBe(true);
    expect(result.models[0].reason).toBe("The canvas was blank.");
    expect(result.allJudged).toBe(false);
  });

  it("skips an unavailable capture and a missing artifact explicitly", async () => {
    deps.getRenderedArtifact
      .mockResolvedValueOnce(artifact({ unavailable: true }))
      .mockResolvedValueOnce(null);

    const result = await run();

    expect(deps.judgeModelRender).not.toHaveBeenCalled();
    expect(result.models.map((m) => m.status)).toEqual(["skipped", "skipped"]);
    // A skip always carries a viewer-safe reason.
    expect(result.models.every((m) => typeof m.reason === "string")).toBe(true);
  });

  it("skips a model with no generation execution", async () => {
    const result = await rejudgeRound({
      roundId: "round-1",
      correlationId: "corr-1",
      // Only competitor "a" ever produced code.
      supabase: fakeSupabase([{ id: "gen-a", model_id: "a" }]),
    });

    expect(deps.judgeModelRender).toHaveBeenCalledTimes(1);
    expect(result.models.find((m) => m.modelId === "b")?.status).toBe(
      "skipped",
    );
  });

  it("records a judge outage as a typed unavailable, not a ruling", async () => {
    deps.judgeModelRender.mockResolvedValue({
      executionId: "judge-exec",
      verdict: {
        kind: "unavailable",
        reason: "The judge could not rule: timeout.",
      },
    });

    const result = await run();

    expect(result.models.every((m) => m.verdict?.kind === "unavailable")).toBe(
      true,
    );
    // It was asked, so it is "judged" — but with no conformance answer.
    expect(result.models.every((m) => m.status === "judged")).toBe(true);
  });

  it("re-judges a single subject when one is named", async () => {
    const result = await run({ subjectModelId: "b" });

    expect(deps.judgeModelRender).toHaveBeenCalledTimes(1);
    expect(deps.judgeModelRender.mock.calls[0][0].subjectModelId).toBe("b");
    // A single-subject run is never "all judged".
    expect(result.allJudged).toBe(false);
  });

  it("rejects a subject that does not compete in the round", async () => {
    await expect(run({ subjectModelId: "ghost" })).rejects.toThrow(
      NotFoundError,
    );
    expect(deps.judgeModelRender).not.toHaveBeenCalled();
  });
});
