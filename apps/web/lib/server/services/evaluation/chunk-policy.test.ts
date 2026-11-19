import { describe, expect, it } from "vitest";
import {
  CHUNK_POLICY_VERSION,
  chunkParams,
  DEFAULT_CHUNK_POLICY,
} from "@/lib/server/services/evaluation/chunk-policy";

/**
 * F17 chunk policy.
 *
 * The fairness rule (REQUIREMENTS.md non-negotiable #10) is that the per-chunk
 * token cap is identical for every model. That only holds if a model's own
 * catalog config cannot raise it, which is what these tests pin.
 */

describe("chunkParams", () => {
  it("applies the policy cap to the model's params", () => {
    const params = chunkParams({ temperature: 0 }, DEFAULT_CHUNK_POLICY);
    expect(params).toEqual({
      temperature: 0,
      max_tokens: DEFAULT_CHUNK_POLICY.maxTokensPerChunk,
    });
  });

  it("cannot let a model config raise the per-chunk cap", () => {
    // A lineup row configured with a large budget must not get four times its
    // rivals' generation budget; the cap is the policy, not the row.
    const params = chunkParams(
      { temperature: 0, max_tokens: 32_768 },
      DEFAULT_CHUNK_POLICY,
    );

    expect(params.max_tokens).toBe(DEFAULT_CHUNK_POLICY.maxTokensPerChunk);
  });

  it("keeps unrelated model params", () => {
    const params = chunkParams(
      { temperature: 0.7, top_p: 0.9 },
      { ...DEFAULT_CHUNK_POLICY, maxTokensPerChunk: 512 },
    );

    expect(params).toEqual({ temperature: 0.7, top_p: 0.9, max_tokens: 512 });
  });

  it("does not mutate the input config", () => {
    const config = { temperature: 0 };
    chunkParams(config, DEFAULT_CHUNK_POLICY);
    expect(config).toEqual({ temperature: 0 });
  });
});

describe("DEFAULT_CHUNK_POLICY", () => {
  it("records a versioned template so a run stays explainable", () => {
    expect(DEFAULT_CHUNK_POLICY.promptTemplateVersion).toContain(
      CHUNK_POLICY_VERSION,
    );
  });

  it("bounds chunks for the 2-3 minute demo budget", () => {
    expect(DEFAULT_CHUNK_POLICY.maxChunks).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_CHUNK_POLICY.maxChunks).toBeLessThanOrEqual(8);
  });
});
