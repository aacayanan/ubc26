import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./chain-records", () => ({ recordOperatorMemoInBackground: vi.fn() }));
vi.mock("@/lib/server/integrations/supabase/admin", () => ({
  getServiceRoleSupabase: () => {
    throw new Error("tests pass their own client");
  },
}));

import { BettingMeter, estimateTokens } from "./betting";

const A = "model-a";
const B = "model-b";

function fakeSupabase(rules: Partial<Record<string, unknown>> = {}) {
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
    data: {
      applicable: true,
      alreadyClosed: rpc.mock.calls.length > 1,
      closedAt: "2026-11-20T00:00:00Z",
      reason: args.p_reason,
    },
    error: null,
  }));
  const row = {
    wagering_mode: "devnet_sol",
    betting_phase: "live",
    token_budget_per_model: 6144,
    cutoff_bps: 7500,
    stall_timeout_seconds: null,
    ...rules,
  };
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
      }),
    }),
    rpc,
  };
  return { client: client as never, rpc };
}

describe("estimateTokens", () => {
  it("uses reported usage when present", () => {
    expect(estimateTokens(1200, 99999)).toEqual({
      tokens: 1200,
      estimated: false,
    });
  });
  it("over-estimates conservatively from characters when usage is missing", () => {
    expect(estimateTokens(null, 3001)).toEqual({
      tokens: 1001,
      estimated: true,
    });
  });
});

describe("BettingMeter", () => {
  let fake: ReturnType<typeof fakeSupabase>;

  beforeEach(() => {
    fake = fakeSupabase();
  });

  it("stays open below 75% and closes when the FIRST model reaches it", async () => {
    const meter = await BettingMeter.forRound("r1", [A, B], fake.client);
    expect(meter.thresholdTokens).toBe(4608);

    await meter.beforeReveal({ modelId: A, kind: "chunk", outputTokens: 1536 });
    await meter.beforeReveal({ modelId: B, kind: "chunk", outputTokens: 1536 });
    await meter.beforeReveal({ modelId: A, kind: "chunk", outputTokens: 1536 });
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(meter.active).toBe(true);

    await meter.beforeReveal({ modelId: A, kind: "chunk", outputTokens: 1536 });
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    expect(fake.rpc.mock.calls[0][1]).toMatchObject({
      p_reason: "token_threshold",
      p_model_id: A,
    });
    expect(meter.active).toBe(false);

    // Later events never re-close.
    await meter.beforeReveal({ modelId: B, kind: "chunk", outputTokens: 4000 });
    await meter.close("all_models_stopped");
    expect(fake.rpc).toHaveBeenCalledTimes(1);
  });

  it("closes before the chunk is revealed (the call resolves only after the RPC)", async () => {
    const meter = await BettingMeter.forRound("r1", [A], fake.client);
    const order: string[] = [];
    fake.rpc.mockImplementationOnce(async () => {
      order.push("close");
      return {
        data: {
          applicable: true,
          alreadyClosed: false,
          closedAt: "2026-11-20T00:00:00Z",
          reason: "token_threshold" as unknown,
        },
        error: null,
      };
    });
    await meter.beforeReveal({ modelId: A, kind: "chunk", outputTokens: 5000 });
    order.push("reveal");
    expect(order).toEqual(["close", "reveal"]);
  });

  it("closes early when a model finishes below the threshold", async () => {
    const meter = await BettingMeter.forRound("r1", [A, B], fake.client);
    await meter.beforeReveal({
      modelId: A,
      kind: "chunk",
      outputTokens: 800,
      terminal: true,
    });
    expect(fake.rpc.mock.calls[0][1]).toMatchObject({
      p_reason: "model_finished",
    });
  });

  it("closes early when a model fails", async () => {
    const meter = await BettingMeter.forRound("r1", [A, B], fake.client);
    await meter.beforeReveal({ modelId: B, kind: "failed" });
    expect(fake.rpc.mock.calls[0][1]).toMatchObject({
      p_reason: "model_failed",
      p_model_id: B,
    });
  });

  it("counts a usage-less chunk conservatively", async () => {
    const meter = await BettingMeter.forRound("r1", [A], fake.client);
    await meter.beforeReveal({
      modelId: A,
      kind: "chunk",
      outputTokens: null,
      chars: 3 * 4608,
    });
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    expect(meter.snapshot().models[A]).toMatchObject({
      tokens: 4608,
      estimated: true,
    });
  });

  it("is inert for points rounds", async () => {
    fake = fakeSupabase({ wagering_mode: "points" });
    const meter = await BettingMeter.forRound("r1", [A], fake.client);
    await meter.beforeReveal({
      modelId: A,
      kind: "chunk",
      outputTokens: 99999,
    });
    await meter.close("all_models_stopped");
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("the stall safeguard is off unless configured", async () => {
    const meter = await BettingMeter.forRound("r1", [A], fake.client);
    expect(await meter.checkStall()).toBe(false);

    const configured = fakeSupabase({ stall_timeout_seconds: 1 });
    const stalled = await BettingMeter.forRound("r1", [A], configured.client);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2_000);
    expect(await stalled.checkStall()).toBe(true);
    vi.useRealTimers();
    expect(configured.rpc.mock.calls[0][1]).toMatchObject({
      p_reason: "stall",
    });
  });
});
