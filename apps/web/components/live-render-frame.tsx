"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { LiveModelProgress, LiveRoundProgress } from "@ai-showdown/shared";
import { ReplayFrame } from "@/components/replay-frame";

/**
 * One model's render, while it is being written (F27).
 *
 * The audience ask is specific: *watch the code land, and the moment it compiles
 * the thing starts moving.* So this picks the newest chunk that actually parsed
 * and hands it to the quarantined replay; until then it shows whatever the
 * sandbox managed to capture, or "compiling…".
 *
 * Three rules it keeps:
 *
 *   * **Model code only ever runs in the sandboxed iframe.** `ReplayFrame`
 *     enforces that (`sandbox="allow-scripts"`, never `allow-same-origin`, CSP
 *     with `connect-src 'none'`); this component never evaluates anything.
 *   * **Playback is not restarted by polling.** The replay is keyed on the chunk
 *     index that produced it, so a poll that returns the same code re-renders
 *     the same tree and the animation keeps running. A new chunk remounts it,
 *     which is correct — the code genuinely changed.
 *   * **Reduced motion gets a still, not a blank.** A viewer who asked for less
 *     motion sees the stored frame instead of an animation.
 */

/** The newest preview whose source parsed, or null while it still does not. */
function latestParsed(
  model: LiveModelProgress,
): LiveModelProgress["previews"][number] | null {
  for (let i = model.previews.length - 1; i >= 0; i -= 1) {
    const preview = model.previews[i];
    if (preview.parseOk && preview.frames.length > 0) return preview;
  }
  // A parseable chunk whose render produced no frames is still a parsed source:
  // the iframe can try to draw it even though the sandbox captured nothing.
  for (let i = model.previews.length - 1; i >= 0; i -= 1) {
    if (model.previews[i].parseOk) return model.previews[i];
  }
  return null;
}

export function LiveRenderFrame({
  model,
  replay,
}: {
  model: LiveModelProgress;
  replay: NonNullable<LiveRoundProgress["replay"]>;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();

  const parsed = latestParsed(model);
  // Run the newest source that parsed, not the newest source. A half-written
  // function would throw on its first frame and fall back to a still, which
  // looks broken when a perfectly good earlier render exists.
  const source = model.renderableCode;
  const canReplay = parsed !== null && source !== null && source.trim() !== "";

  // Reduced motion resolves to a composed still, per DESIGN.md — not to a
  // paused iframe. A static frame is a still; a paused animation is not.
  if (canReplay && !prefersReducedMotion) {
    return (
      <div
        className="overflow-hidden rounded-xl border border-hairline bg-void"
        style={{ aspectRatio: `${replay.frameWidth} / ${replay.frameHeight}` }}
      >
        <ReplayFrame
          // Remount only when the code that is being drawn actually changed.
          key={`${parsed.chunkIndex}:${source.length}`}
          source={source}
          entryPoint={replay.entryPoint}
          frameWidth={replay.frameWidth}
          frameHeight={replay.frameHeight}
          targetDurationMs={replay.targetDurationMs}
          fallbackFrames={model.frames}
          label={model.name}
          autoPlay
          showControls={false}
        />
      </div>
    );
  }

  const frame = model.frames.at(-1) ?? parsed?.frames.at(-1) ?? null;

  return (
    <div
      className="grid place-items-center overflow-hidden rounded-xl border border-hairline bg-void"
      style={{ aspectRatio: `${replay.frameWidth} / ${replay.frameHeight}` }}
    >
      {frame ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`data:image/png;base64,${frame.png}`}
          alt={`${model.name} — latest captured frame`}
          className="size-full object-contain"
        />
      ) : (
        <p className="t-mono text-[0.625rem] text-faint">
          {model.compiling ? "compiling…" : "no render yet"}
        </p>
      )}
    </div>
  );
}

/**
 * Whether the viewer asked for reduced motion.
 *
 * Read in an effect so the server and first client paint agree; the default
 * (motion allowed) matches what a browser without the query reports. The
 * subscription is `useSyncExternalStore`, so there is no setState-in-effect and
 * a change of preference is picked up live.
 */
function usePrefersReducedMotion(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return () => {};
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return useSyncExternalStore(
    subscribe,
    () =>
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false,
    () => false,
  );
}
