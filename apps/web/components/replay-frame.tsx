"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RenderedFrame } from "@ai-showdown/shared";
import { buildReplayDoc } from "@/lib/sandbox/replay-doc";

/**
 * A quarantined replay of one model's render (F19).
 *
 * The generated code runs **only** inside an iframe with `sandbox="allow-scripts"`
 * and never `allow-same-origin`; the document carries its own CSP with
 * `connect-src 'none'` (see `lib/sandbox/replay-doc.ts`), so the code has an
 * opaque origin with no access to the app, its cookies or storage, and no way to
 * reach the network. The page never gets app state.
 *
 * Because the origin is opaque the parent cannot touch the iframe's DOM, so a
 * deterministic clock is driven by `postMessage`: the parent posts `{type:'render', t}`
 * and the iframe draws time `t`. `t` is an explicit step, not wall-clock, so the
 * same scrub position always yields the same frame.
 *
 * If the code throws — a model that renders server-side can still fail in a
 * different engine, or a chunk was never completed — the iframe reports
 * `{type:'error'}` and this component degrades to a stored artifact frame rather
 * than showing a blank box. The floor is always something to look at.
 */

const TICK_MS = 33; // ~30 fps while playing

export function ReplayFrame({
  source,
  entryPoint,
  frameWidth,
  frameHeight,
  targetDurationMs,
  fallbackFrames,
  label,
}: {
  source: string | null;
  entryPoint: string;
  frameWidth: number;
  frameHeight: number;
  targetDurationMs: number;
  fallbackFrames: RenderedFrame[];
  /** Accessible name; typically the model name. */
  label: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);

  const duration = Math.max(1, targetDurationMs);

  const doc = useMemo(() => {
    if (!source) return null;
    return buildReplayDoc({ source, entryPoint, frameWidth, frameHeight });
  }, [source, entryPoint, frameWidth, frameHeight]);

  // Receive frame/error/ready from the sandboxed document. Only trust messages
  // whose source is our own iframe's window.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: string } | null;
      if (!data) return;
      if (data.type === "ready") setReady(true);
      if (data.type === "error") setFailed(true);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Watchdog: if the document never reports ready (scripts blocked, srcdoc
  // unsupported, a browser that refuses the sandbox), fall back to the stored
  // frame rather than leaving a black box. The callback fires asynchronously, so
  // it does not cascade renders.
  useEffect(() => {
    if (!doc || ready || failed) return;
    const id = setTimeout(() => setFailed(true), 4000);
    return () => clearTimeout(id);
  }, [doc, ready, failed]);

  // Draw whatever time the scrubber is parked at (and once the doc is ready).
  useEffect(() => {
    if (!ready || failed || !doc) return;
    iframeRef.current?.contentWindow?.postMessage({ type: "render", t }, "*");
  }, [ready, failed, doc, t]);

  // Advance the deterministic clock while playing.
  useEffect(() => {
    if (!playing || failed || !doc) return;
    const id = setInterval(() => {
      setT((current) => {
        const next = current + TICK_MS;
        return next >= duration ? 0 : next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, failed, doc, duration]);

  const fallback = fallbackFrames[0] ?? null;

  return (
    <figure className="flex flex-col">
      <div
        className="relative overflow-hidden rounded-xl border border-hairline bg-void"
        style={{ aspectRatio: `${frameWidth} / ${frameHeight}` }}
      >
        {doc && !failed ? (
          <iframe
            ref={iframeRef}
            title={`Replay of ${label}`}
            srcDoc={doc}
            // The security posture, verbatim: scripts only, never same-origin.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="size-full"
          />
        ) : fallback ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`data:image/png;base64,${fallback.png}`}
            alt={`${label} — rendered frame`}
            className="size-full object-contain"
          />
        ) : (
          <div className="grid size-full place-items-center">
            <p className="t-mono text-[0.625rem] text-faint">
              {source ? "replay unavailable" : "no render"}
            </p>
          </div>
        )}
      </div>

      {doc && !failed ? (
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            className="btn btn-ghost btn-sm shrink-0"
            aria-label={playing ? `Pause ${label}` : `Play ${label}`}
            disabled={!ready}
          >
            {playing ? "Pause" : "Play"}
          </button>
          <input
            type="range"
            min={0}
            max={duration}
            step={TICK_MS}
            value={t}
            onChange={(e) => {
              setPlaying(false);
              setT(Number(e.target.value));
            }}
            aria-label={`Scrub ${label} replay`}
            className="w-full accent-violet"
            disabled={!ready}
          />
          <span className="t-num shrink-0 text-[0.625rem] text-faint">
            {Math.round(t)}&thinsp;ms
          </span>
        </div>
      ) : failed ? (
        <p className="t-mono mt-2 text-[0.625rem] text-faint">
          Live replay unavailable — showing the rendered frame.
        </p>
      ) : null}
    </figure>
  );
}
