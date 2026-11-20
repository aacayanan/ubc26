"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LiveModelProgress,
  LiveModelState,
  LiveRoundProgress,
} from "@ai-showdown/shared";
import { LiveRenderFrame } from "@/components/live-render-frame";
import { Meter, Panel, Status, cx } from "@/components/ui";

/**
 * The live watch surface for a round (F27).
 *
 * It renders *persisted* progress: everything on screen came from a row the
 * pipeline wrote, so a refresh or a reconnect recovers the current state rather
 * than restarting a guess (acceptance #1–#2). Nothing is optimistically advanced
 * — the chunk counter, the render, the verdict and the failure line all read the
 * same response.
 *
 * It polls rather than streams. That matches the existing precedent
 * (`app/dev/pipeline/[id]`), costs nothing to deploy, and keeps a single read
 * path; an SSE version is a post-submission improvement.
 *
 * A failed poll never blanks the view or reads as "closed": the last good state
 * stays on screen with a quiet retrying strip. That mistake already shipped once
 * (F9) and is the reason the load states are explicit here.
 */

const POLL_MS = 2500;

/** Round statuses that will not change again, so polling stops. */
const TERMINAL_STATUSES = new Set(["SETTLED", "VOIDED", "ARCHIVED"]);

export function LiveRoundPanel({
  roundId,
  className = "",
}: {
  roundId: string;
  /** Placement is the page's call — the round page runs this full width. */
  className?: string;
}) {
  const [progress, setProgress] = useState<LiveRoundProgress | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [everLoaded, setEverLoaded] = useState(false);

  /**
   * One poll. Returns the status it read, so the caller can decide whether the
   * round has finished — the loop never reads React state to make that call,
   * which is what keeps it out of a re-created interval on every status change.
   */
  const load = useCallback(async (): Promise<string | null> => {
    try {
      const response = await fetch(`/api/rounds/${roundId}/progress`, {
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          body?.error?.message ?? "Could not load the round's progress",
        );
      }
      const next = body as LiveRoundProgress;
      setProgress(next);
      setEverLoaded(true);
      setLoadError(null);
      return next.status;
    } catch (error) {
      // Keep whatever is already on screen; only the strip changes.
      setLoadError(
        error instanceof Error ? error.message : "Could not load progress",
      );
      return null;
    }
  }, [roundId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    function tick() {
      if (!active) return;
      void load().then((next) => {
        // A terminal round does not change again, so stop asking. `null` means
        // the poll failed — keep trying, the round may still be moving.
        if (!active || next === null) return;
        if (TERMINAL_STATUSES.has(next) && timer) {
          clearInterval(timer);
          timer = null;
        }
      });
    }

    // Poll on an interval, and refetch when the tab comes back: a backgrounded
    // tab throttles timers, and a viewer returning to it should see the truth
    // immediately rather than up to one interval later.
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };

    tick();
    timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      active = false;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  return (
    <section aria-labelledby="live-heading" className={className}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="live-heading" className="t-title text-[0.9375rem] text-ink">
          The round, live
        </h2>
        {/* The phase badge that used to sit here is gone: the page header and the
            betting sentence both state the phase already. */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void load()}
            className="btn btn-ghost btn-sm"
          >
            Refresh
          </button>
        </div>
      </div>

      {loadError ? (
        <p
          role="status"
          className="t-mono mt-3 rounded-lg border border-hairline bg-void-2/60 px-3 py-2 text-[0.625rem] text-muted"
        >
          {everLoaded
            ? "Lost the live feed — showing the last state we had. Retrying…"
            : `Could not load progress: ${loadError}`}
        </p>
      ) : null}

      {progress?.retry ? (
        <p
          role="status"
          className="t-body mt-3 border-l-0 text-[0.8125rem] leading-relaxed text-muted"
        >
          {progress.retry.message}
        </p>
      ) : null}

      {progress?.outcome ? (
        <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="t-label text-[0.5625rem] text-faint">Outcome</span>
          <p className="t-body min-w-0 flex-1 text-[0.8125rem] text-ink">
            {progress.outcome.reason}
          </p>
          <Link
            href={`/results/${progress.roundId}`}
            className="link t-label text-[0.625rem]"
          >
            Full result and replay
          </Link>
        </div>
      ) : null}

      {progress === null ? (
        <Panel quiet className="mt-4 px-5 py-8 text-center" aria-busy="true">
          <p className="t-mono text-[0.625rem] text-faint">
            Reading the round…
          </p>
        </Panel>
      ) : (
        // Side by side, one column per contender — the product's whole promise is
        // that the renders happen together, and a column of full-width panels
        // made a viewer scroll past a whole screen of one model before meeting
        // the next. The renders lead; the code is a reading under each, not the
        // exhibit. Two-model rounds get two wider columns rather than one hole.
        <div
          className={cx(
            "mt-4 grid gap-3",
            progress.models.length > 2 ? "md:grid-cols-3" : "md:grid-cols-2",
          )}
        >
          {progress.models.map((model) => (
            <ModelCard
              key={model.modelId}
              model={model}
              replay={progress.replay}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** The dot + word for a model's pipeline state. Never amber, never a chip. */
function modelStatus(state: LiveModelState): {
  tone: "live" | "violet" | "ink" | "idle";
  label: string;
} {
  switch (state) {
    case "generating":
      return { tone: "live", label: "Writing" };
    case "rendering":
      return { tone: "violet", label: "Rendering" };
    case "judging":
      return { tone: "violet", label: "Judging" };
    case "conformed":
      return { tone: "ink", label: "Conformed" };
    case "not_conformed":
      return { tone: "idle", label: "Off brief" };
    case "forfeited":
      return { tone: "idle", label: "Forfeited" };
    case "unavailable":
      return { tone: "violet", label: "Unavailable" };
    default:
      return { tone: "idle", label: "Waiting" };
  }
}

function ModelCard({
  model,
  replay,
}: {
  model: LiveModelProgress;
  replay: LiveRoundProgress["replay"];
}) {
  const status = modelStatus(model.state);
  const codeRef = useRef<HTMLPreElement>(null);

  // Follow the writing, the way a terminal would. Only while the model is still
  // generating — scrolling a finished pane out from under a reader is rude.
  useEffect(() => {
    if (model.state !== "generating") return;
    const node = codeRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [model.code, model.state]);

  const { generated, expected, complete } = model.chunks;
  // The ceiling is not a target — a model that finished its answer in one chunk
  // of three is done, and a bar stuck at 33% would say otherwise.
  const chunkProgress =
    complete || expected === 0
      ? generated > 0
        ? 1
        : 0
      : Math.min(1, generated / expected);

  // A tile, not a card: three of these share one row, so the glass slab and its
  // 70px ambient drop (`.panel`) would be three competing surfaces saying
  // nothing the hairline does not. The render is the content; everything else
  // is a reading beneath it.
  return (
    <div className="flex min-w-0 flex-col rounded-2xl border border-hairline bg-white/[0.015] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[0.875rem] text-ink">{model.name}</p>
        <Status tone={status.tone} pulse={model.state === "generating"}>
          {status.label}
        </Status>
      </div>

      {replay ? (
        <div className="mt-2.5">
          <LiveRenderFrame model={model} replay={replay} />
        </div>
      ) : null}

      {generated > 0 ? (
        <div className="mt-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="t-label text-[0.5rem] text-faint">Code</span>
            <span className="t-num text-[0.5625rem] text-muted">
              {complete
                ? `${generated} chunk${generated === 1 ? "" : "s"} written`
                : `${generated} of ${expected} chunks`}
            </span>
          </div>
          <Meter
            value={chunkProgress}
            className="mt-1.5"
            label={
              complete
                ? `${model.name} has finished writing`
                : `${model.name} has written ${generated} of ${expected} chunks`
            }
          />
        </div>
      ) : null}

      {/* The code pane is a fixed-height window, not a growing block: a model
          mid-write would otherwise push its neighbours out of the row. */}
      {model.code ? (
        <pre
          ref={codeRef}
          className="mt-2.5 max-h-40 min-h-24 overflow-auto rounded-lg border border-hairline bg-void/70 p-2.5 text-[0.625rem] leading-relaxed text-muted"
        >
          <code>{model.code}</code>
        </pre>
      ) : (
        <p className="t-mono mt-2.5 min-h-24 rounded-lg border border-hairline bg-void/70 p-2.5 text-[0.625rem] text-faint">
          {model.state === "pending" ? "queued" : "no code yet"}
        </p>
      )}

      {model.failure ? (
        <p className="t-body mt-2 text-[0.6875rem] leading-relaxed text-muted">
          {model.failure.message}
        </p>
      ) : model.judge?.reason ? (
        <p className="t-body mt-2 text-[0.6875rem] leading-relaxed text-muted">
          {model.judge.reason}
        </p>
      ) : null}
    </div>
  );
}
