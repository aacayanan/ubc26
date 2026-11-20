"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LiveModelProgress,
  LiveModelState,
  LiveRoundProgress,
} from "@ai-showdown/shared";
import { LiveRenderFrame } from "@/components/live-render-frame";
import { Meter, Panel, Status, roundLabel, roundTone } from "@/components/ui";

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
  initialStatus,
}: {
  roundId: string;
  /** The status the round page already loaded, so the first paint is right. */
  initialStatus: string;
}) {
  const [progress, setProgress] = useState<LiveRoundProgress | null>(null);
  const [status, setStatus] = useState(initialStatus);
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
      setStatus(next.status);
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
    <section aria-labelledby="live-heading" className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="live-heading" className="t-title text-[1.0625rem] text-ink">
          The round, live
        </h2>
        <div className="flex items-center gap-3">
          <Status
            tone={roundTone(status)}
            pulse={status === "RUNNING" || status === "EVALUATING"}
          >
            {roundLabel(status)}
          </Status>
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
        <Panel quiet className="mt-4 p-4">
          <p className="text-sm text-muted">{progress.retry.message}</p>
        </Panel>
      ) : null}

      {progress?.outcome ? (
        <Panel quiet className="mt-4 p-4">
          <p className="t-label text-[0.5625rem] text-faint">Outcome</p>
          <p className="mt-1.5 text-sm text-ink">{progress.outcome.reason}</p>
          <Link
            href={`/results/${progress.roundId}`}
            className="link t-label mt-2 inline-block text-[0.625rem]"
          >
            Full result and replay
          </Link>
        </Panel>
      ) : null}

      {progress === null ? (
        <Panel quiet className="mt-4 px-5 py-8 text-center" aria-busy="true">
          <p className="t-mono text-[0.625rem] text-faint">
            Reading the round…
          </p>
        </Panel>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
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

  return (
    <Panel className="flex flex-col p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-[0.9375rem] text-ink">{model.name}</p>
        <Status tone={status.tone} pulse={model.state === "generating"}>
          {status.label}
        </Status>
      </div>

      {replay ? (
        <div className="mt-4">
          <LiveRenderFrame model={model} replay={replay} />
        </div>
      ) : null}

      {generated > 0 ? (
        <div className="mt-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="t-label text-[0.5625rem] text-faint">Code</span>
            <span className="t-num text-[0.625rem] text-muted">
              {complete
                ? `${generated} chunk${generated === 1 ? "" : "s"} written`
                : `${generated} of ${expected} chunks`}
            </span>
          </div>
          <Meter
            value={chunkProgress}
            className="mt-2"
            label={
              complete
                ? `${model.name} has finished writing`
                : `${model.name} has written ${generated} of ${expected} chunks`
            }
          />
        </div>
      ) : null}

      {model.code ? (
        <pre
          ref={codeRef}
          className="mt-3 max-h-56 overflow-auto rounded-lg border border-hairline bg-void p-3 text-[0.625rem] leading-relaxed text-muted"
        >
          <code>{model.code}</code>
        </pre>
      ) : (
        <p className="t-mono mt-3 rounded-lg border border-hairline bg-void p-3 text-[0.625rem] text-faint">
          {model.state === "pending" ? "queued" : "no code yet"}
        </p>
      )}

      {model.failure ? (
        <p className="t-body mt-3 text-xs leading-relaxed text-muted">
          {model.failure.message}
        </p>
      ) : model.judge?.reason ? (
        <p className="t-body mt-3 text-xs leading-relaxed text-muted">
          {model.judge.reason}
        </p>
      ) : null}
    </Panel>
  );
}
