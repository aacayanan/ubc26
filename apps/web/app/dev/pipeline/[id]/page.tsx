"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LiveRoundProgress, RenderedFrame } from "@ai-showdown/shared";
import {
  PageHeader,
  Panel,
  Status,
  roundLabel,
  roundTone,
} from "@/components/ui";

/**
 * Dev watch page for a round (F17/F27).
 *
 * `scripts/dev-pipeline-run.mjs` prints this URL after it fires the pipeline, so
 * it has to exist. It polls `GET /api/rounds/[id]/progress` and shows what each
 * model has produced: the code so far, the gate verdict, the judge's ruling and
 * the stored frames.
 *
 * Frames are *stored PNGs* rendered by the pinned Chromium sandbox — this page
 * only displays them as images. It never executes model code in the browser, so
 * it sidesteps the quarantine surface entirely (the live replay iframe is the
 * round page's job, under the `sandbox="allow-scripts"` rules in CLAUDE.md).
 *
 * The payload types come from `@ai-showdown/shared` rather than being
 * redeclared here, so this page cannot drift from the endpoint it reads.
 */

const TERMINAL_STATUSES = new Set(["SETTLED", "VOIDED", "ARCHIVED"]);

export default function PipelineWatchPage() {
  // `useParams` rather than awaiting a `params` promise: the awaited form
  // resolved after the fetch effect had already run with a null id, so the page
  // sat on "Loading round…" forever with a 200 response in the network tab.
  const params = useParams<{ id: string }>();
  const roundId = params?.id ?? null;

  const [progress, setProgress] = useState<LiveRoundProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<string | null> => {
    if (!roundId) return null;
    try {
      const response = await fetch(`/api/rounds/${roundId}/progress`, {
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Could not load progress");
      }
      setProgress(body as LiveRoundProgress);
      setError(null);
      return (body as LiveRoundProgress).status;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Load failed");
      return null;
    }
  }, [roundId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    function tick() {
      if (!active) return;
      void load().then((status) => {
        if (!active || status === null) return;
        if (TERMINAL_STATUSES.has(status) && timer) {
          clearInterval(timer);
          timer = null;
        }
      });
    }

    tick();
    timer = setInterval(tick, 3000);

    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [load]);

  const frameFor = useMemo(() => {
    return (
      model: LiveRoundProgress["models"][number],
    ): RenderedFrame | null => {
      return (
        model.frames.at(-1) ?? model.previews.at(-1)?.frames.at(-1) ?? null
      );
    };
  }, []);

  if (error) {
    return (
      <div className="shell py-14">
        <Panel className="p-7">
          <p role="alert" className="text-sm text-magenta">
            {error}
          </p>
        </Panel>
      </div>
    );
  }

  if (!progress) {
    return (
      <div className="shell py-14">
        <p className="t-label text-[0.625rem] text-faint">Loading round…</p>
      </div>
    );
  }

  return (
    <div className="shell py-12 sm:py-14">
      <PageHeader
        title={progress.brief?.title ?? progress.slug}
        description={
          progress.brief?.prompt ??
          "This round has not been revealed yet — renders stay hidden until staking closes."
        }
      />

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Status
          tone={roundTone(progress.status)}
          pulse={progress.status === "RUNNING"}
        >
          {roundLabel(progress.status)}
        </Status>
        <Link
          href={`/competitions/${progress.roundId}`}
          className="link t-label text-[0.625rem]"
        >
          Round page
        </Link>
        <button
          type="button"
          onClick={() => void load()}
          className="btn btn-ghost btn-sm"
        >
          Refresh
        </button>
      </div>

      {progress.outcome ? (
        <Panel className="mt-6 p-5">
          <p className="t-label text-[0.5625rem] text-faint">Outcome</p>
          <p className="mt-2 text-sm text-ink">{progress.outcome.reason}</p>
        </Panel>
      ) : progress.retry ? (
        <Panel className="mt-6 p-5">
          <p className="t-label text-[0.5625rem] text-faint">Retry</p>
          <p className="mt-2 text-sm text-ink">{progress.retry.message}</p>
        </Panel>
      ) : null}

      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        {progress.models.map((model) => {
          const frame = frameFor(model);
          return (
            <Panel key={model.modelId} className="flex flex-col p-5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[0.9375rem] text-ink">{model.name}</p>
                <span className="t-mono text-[0.625rem] text-faint">
                  {model.state}
                </span>
              </div>

              <div className="mt-4 aspect-square overflow-hidden rounded-lg border border-hairline bg-void-2/60">
                {frame ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`data:image/png;base64,${frame.png}`}
                    alt={`${model.name} — latest rendered frame`}
                    className="size-full object-contain"
                  />
                ) : (
                  <div className="grid size-full place-items-center">
                    <p className="t-mono text-[0.625rem] text-faint">
                      {model.compiling ? "compiling…" : "no frame yet"}
                    </p>
                  </div>
                )}
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-2 text-[0.6875rem]">
                <div>
                  <dt className="text-faint">Gate</dt>
                  <dd className="text-ink">
                    {model.gatePassed === null
                      ? "—"
                      : model.gatePassed
                        ? "passed"
                        : "failed"}
                  </dd>
                </div>
                <div>
                  <dt className="text-faint">Judge</dt>
                  <dd className="text-ink">{model.judge?.verdict ?? "—"}</dd>
                </div>
              </dl>

              {model.judge?.reason ? (
                <p className="mt-3 text-xs leading-relaxed text-muted">
                  {model.judge.reason}
                </p>
              ) : model.failure ? (
                <p className="mt-3 text-xs leading-relaxed text-muted">
                  {model.failure.message}
                </p>
              ) : null}

              {model.code ? (
                <details className="mt-4">
                  <summary className="t-label cursor-pointer text-[0.5625rem] text-muted">
                    Code
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-hairline bg-void p-3 text-[0.625rem] leading-relaxed text-muted">
                    <code>{model.code}</code>
                  </pre>
                </details>
              ) : null}
            </Panel>
          );
        })}
      </div>
    </div>
  );
}
