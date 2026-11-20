/**
 * Validate a tier's models end to end: prompt → OpenRouter → render sandbox.
 *
 *   cd apps/web
 *   npx tsx --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json \
 *     ../../scripts/validate-tier-models.ts <tier>
 *
 * Why this exists: a model ID can exist in the OpenRouter catalog and still be
 * unusable here. The original lineup seed learned this the hard way — several
 * cheap models pass the deterministic gate and draw the wrong thing, and the
 * free-tier reasoning models spend the whole budget thinking and return no code
 * at all. So the seed's claim "these render" is checked by running them, not by
 * reading a pricing table.
 *
 * It is a *smoke* test, not a judge: it reports whether each model produced
 * code that rendered frames, and it does NOT rule on conformance. That is F31's
 * job and a vision model's. Read the result as "this model can take part", not
 * "this model follows the brief".
 *
 * Cost: one generation plus one render per model. A few cents at most.
 */
import { spawnSync } from "node:child_process";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";
import { getOpenRouterClient } from "@/lib/server/integrations/openrouter/config";
import {
  buildChunkMessages,
  extractRenderCode,
  toGenerationChallenge,
} from "@/lib/server/services/llm/prompt";
import { chunkParams, getChunkPolicy } from "@/lib/server/services/evaluation/chunk-policy";
import { getPublishedBrief } from "@/lib/server/services/briefs/briefs";
import type { LLMModelRecord } from "@/lib/server/services/llm/models";

const tier = process.argv[2];
const briefSlug = process.argv[3];
if (!tier) {
  console.error(
    "Usage: validate-tier-models.ts <tier> [brief-slug]   e.g. mid isometric-donut",
  );
  process.exit(2);
}

const RENDER_IMAGE = process.env.RENDER_SANDBOX_IMAGE;
if (!RENDER_IMAGE) {
  console.error("RENDER_SANDBOX_IMAGE is not set; cannot render.");
  process.exit(2);
}

const supabase = getServiceRoleSupabase();
const client = getOpenRouterClient();
const policy = getChunkPolicy();

interface RenderOutcome {
  ok: boolean;
  frames: number;
  error: string | null;
}

/** Run one renderer in the sandbox image exactly as the pipeline does. */
function render(brief: Awaited<ReturnType<typeof getPublishedBrief>>, source: string): RenderOutcome {
  if (!brief) throw new Error("brief missing");
  const job = {
    protocol: 1,
    source,
    entryPoint: brief.entryPoint,
    frameCount: brief.frameCount,
    frameWidth: brief.frameWidth,
    frameHeight: brief.frameHeight,
    targetDurationMs: brief.targetDurationMs,
  };
  const result = spawnSync(
    "docker",
    [
      "run", "--rm", "-i",
      "--network=none",
      "--memory=512m", "--cpus=1", "--pids-limit=256",
      "--read-only", "--tmpfs", "/tmp:size=64m",
      RENDER_IMAGE!,
    ],
    { input: JSON.stringify(job), encoding: "utf8", timeout: 120_000 },
  );
  if (result.error) return { ok: false, frames: 0, error: result.error.message };
  const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  if (!line) {
    return { ok: false, frames: 0, error: (result.stderr ?? "").slice(0, 200) || "no output" };
  }
  try {
    const parsed = JSON.parse(line) as { ok?: boolean; frames?: unknown[]; error?: string };
    return {
      ok: Boolean(parsed.ok),
      frames: Array.isArray(parsed.frames) ? parsed.frames.length : 0,
      error: parsed.error ?? null,
    };
  } catch {
    return { ok: false, frames: 0, error: "unparseable harness output" };
  }
}

async function main() {
  // A named brief, or the first published JavaScript brief.
  let brief = briefSlug
    ? await getPublishedBrief(briefSlug, supabase)
    : null;
  if (!briefSlug) {
    const { data } = await supabase
      .from("challenges")
      .select("slug")
      .eq("language", "javascript")
      .eq("status", "published")
      .order("slug")
      .limit(1)
      .maybeSingle();
    if (data?.slug) brief = await getPublishedBrief(data.slug as string, supabase);
  }
  if (!brief) {
    throw new Error(
      "No published JavaScript brief found. Run `npm run briefs:validate`.",
    );
  }

  const { data, error } = await supabase
    .from("llm_models")
    .select("id, slug, name, provider, openrouter_model_id, config, sort_order, role, tier")
    .eq("tier", tier)
    .eq("is_active", true)
    .eq("role", "competitor")
    .order("sort_order");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error(`No active competitors on tier "${tier}".`);

  const challenge = toGenerationChallenge(brief);
  console.log(`▶ brief ${brief.slug} v${brief.version} · tier ${tier} · ${data.length} model(s)\n`);

  let failures = 0;
  for (const row of data as Array<Record<string, unknown>>) {
    const model = {
      ...row,
      openrouterModelId: row.openrouter_model_id,
    } as unknown as LLMModelRecord;

    const messages = buildChunkMessages({
      challenge,
      codeSoFar: "",
      chunkIndex: 0,
      // A single-shot ask: we want to know it can produce a renderer at all,
      // not whether it survives the chunk schedule (the pipeline checks that).
      isFinalChunk: true,
    });

    const started = Date.now();
    const outcome = await client.generate({
      model: model.openrouterModelId,
      messages,
      params: chunkParams(model.config, policy),
      correlationId: `validate-${tier}-${model.slug}-${Date.now()}`,
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (!outcome.ok) {
      failures += 1;
      console.log(`  ✗ ${model.name} (${model.slug}) — generation failed in ${seconds}s: ${outcome.failureKind}`);
      continue;
    }

    const extracted = extractRenderCode(outcome.content, brief.entryPoint);
    if (!extracted.ok) {
      failures += 1;
      console.log(`  ✗ ${model.name} (${model.slug}) — no usable code (${extracted.reason}) in ${seconds}s`);
      continue;
    }

    const rendered = render(brief, extracted.code);
    if (rendered.ok && rendered.frames > 0) {
      console.log(`  ✓ ${model.name} (${model.slug}) — ${rendered.frames} frames in ${seconds}s`);
    } else {
      failures += 1;
      console.log(`  ✗ ${model.name} (${model.slug}) — render failed: ${rendered.error ?? "no frames"}`);
    }
  }

  console.log(
    `\n${failures === 0 ? "✓ every model on this tier generated and rendered" : `✗ ${failures} model(s) failed`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
