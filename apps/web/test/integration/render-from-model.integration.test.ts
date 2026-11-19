import { describe, expect, it } from "vitest";

import { createOpenRouterClient } from "@/lib/server/integrations/openrouter/client";
import { runRenderContainer } from "@/lib/server/integrations/docker/render-sandbox";
import { assessRender } from "@/lib/server/services/evaluation/observe";
import { buildArtifactRenderJob } from "@/lib/server/services/evaluation/artifact-run";
import {
  buildGenerationMessages,
  extractRenderCode,
  toGenerationChallenge,
} from "@/lib/server/services/llm/prompt";
import type { BriefRecord } from "@/lib/server/services/briefs/briefs";

/**
 * The F33 acceptance check: a real model reply becomes a real render.
 *
 * This is the seam the pivot opened. F16's client worked, F14's gate worked, but
 * the prompt between them still asked for Python — so nothing could join the two
 * halves. This test walks the whole path once, for real:
 *
 *   brief → prompt → model → extractor → render sandbox → F14 gate
 *
 * Skipped unless OPENROUTER_API_KEY, OPENROUTER_TEST_MODEL_ID and a
 * digest-pinned RENDER_SANDBOX_IMAGE are all set, so `npm test` never spends
 * credits or needs Docker. Run it explicitly:
 *
 *   OPENROUTER_API_KEY=... OPENROUTER_TEST_MODEL_ID=... \
 *   RENDER_SANDBOX_IMAGE="$(docker image inspect ai-showdown-render:chromium \
 *     --format '{{index .RepoDigests 0}}')" \
 *     npx vitest run --root apps/web test/integration/render-from-model.integration.test.ts
 */

const apiKey = process.env.OPENROUTER_API_KEY;
const modelId = process.env.OPENROUTER_TEST_MODEL_ID;
const sandboxImage = process.env.RENDER_SANDBOX_IMAGE;

/**
 * A brief shaped like the seeded donut, kept small so the live call is cheap.
 *
 * Not read from Postgres on purpose: the database is not required to prove the
 * seam works, and requiring one would mean this only runs on a seeded machine.
 */
const BRIEF: BriefRecord = {
  id: "integration-brief",
  slug: "f33-integration-donut",
  version: 1,
  title: "Isometric donut spinning in a loop",
  prompt:
    "Render a donut (a torus seen from above) in an isometric projection, " +
    "spinning smoothly once around its vertical axis over the loop. The loop " +
    "must be seamless and the hole in the middle must stay visible.",
  styleConstraints:
    "Isometric projection (circles squashed 2:1 vertically). Two flat fills " +
    "only — magenta #FF2E93 and violet #7C6BFF — on a void #05040A background. " +
    "No gradients, no outlines, no text, no UI.",
  entryPoint: "drawFrame",
  targetDurationMs: 1200,
  frameCount: 6,
  frameWidth: 320,
  frameHeight: 240,
  deterministicChecks: [
    { kind: "process_exit", expect: 0 },
    { kind: "no_uncaught_error" },
    { kind: "frames_emitted", expect: 6 },
    { kind: "frame_dimensions", expect: "320x240" },
    { kind: "non_blank" },
  ],
  judgeRubric: [],
  starterCode: "",
  // Never shown to the model: `toGenerationChallenge` strips it.
  referenceImpl: "function drawFrame() { /* the answer key */ }",
  referenceValidatedAt: null,
};

describe.skipIf(!apiKey || !modelId || !sandboxImage)(
  "F33 model reply renders",
  () => {
    it("takes a live completion through the extractor and the F14 gate", async () => {
      const client = createOpenRouterClient({
        apiKey: apiKey!,
        maxAttempts: 2,
        timeoutMs: 90_000,
      });

      const challenge = toGenerationChallenge(BRIEF);
      const messages = buildGenerationMessages(challenge);

      const outcome = await client.generate({
        model: modelId!,
        messages,
        // Deterministic sampling: a temperature above zero makes a flaky
        // integration test, not a better proof.
        params: { temperature: 0 },
        correlationId: "f33-integration",
      });

      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (!outcome.ok) return;

      // The extractor must find the entry point in a real reply — this is the
      // step that used to look for `def`, and every model would have failed.
      const extraction = extractRenderCode(outcome.content, BRIEF.entryPoint);
      expect(
        extraction.ok,
        extraction.ok ? "" : `extraction failed: ${extraction.reason}`,
      ).toBe(true);
      if (!extraction.ok) return;

      const container = await runRenderContainer({
        containerName: `f33-integration-${Date.now()}`,
        job: buildArtifactRenderJob(extraction.code, BRIEF),
        wallClockMs: 90_000,
      });

      expect(container.unavailable, "sandbox unavailable").toBe(false);
      expect(container.record, "no result record").not.toBeNull();

      const assessment = assessRender(container, BRIEF);

      // The gate can legitimately fail if the model drew something poor — that
      // is F14 working, not a broken seam. What must NOT happen is the render
      // never running, so assert on having frames rather than on passing.
      expect(assessment.record?.frames.length ?? 0).toBeGreaterThan(0);

      if (!assessment.gate.passed) {
        // Surfaced in the test output so a weak model is visible rather than
        // silently tolerated.
        console.warn(
          `Model ${modelId} rendered but failed the gate: ${assessment.gate.failureReason}`,
        );
      }
    }, 240_000);
  },
);
