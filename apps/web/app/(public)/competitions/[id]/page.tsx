"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  CrosshairMark,
  Meter,
  Panel,
  Status,
  roundLabel,
  roundTone,
} from "@/components/ui";

interface RoundDetail {
  id: string;
  brief_title: string;
  brief_text: string;
  models: { id: string; name: string }[];
  deadline: string;
  state: string;
  pool_points: number;
  pool_capacity: number;
  user_stake: { model_id: string; points: number } | null;
}

export default function CompetitionDetailPage() {
  const router = useRouter();

  // TODO: load from API — GET /api/rounds/[id]
  const round = null as RoundDetail | null;

  const [selected, setSelected] = useState<string>("");
  const [stake, setStake] = useState<string>("250");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // TODO: POST /api/rounds/[id]/stakes
      // await fetch(`/api/rounds/${round?.id}/stakes`, {
      //   method: "POST",
      //   headers: { "Content-Type": "application/json" },
      //   body: JSON.stringify({ model_id: selected, points: Number(stake) }),
      // });
      router.push("/predictions");
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Could not place the stake",
      );
    } finally {
      setSaving(false);
    }
  }

  if (!round) {
    return (
      <div className="shell py-14 sm:py-20">
        <div className="panel-quiet mx-auto flex max-w-xl flex-col items-center px-6 py-16 text-center">
          <CrosshairMark className="text-faint" />
          <h1 className="t-title mt-6 text-xl text-ink">
            This round is closed.
          </h1>
          <p className="t-body mt-3 max-w-[44ch] text-sm text-muted">
            Nothing is open under this id — it may have settled and moved to
            results, or the link is stale.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link href="/competitions" className="btn btn-ghost btn-sm">
              All rounds
            </Link>
            <Link href="/results" className="btn btn-ghost btn-sm">
              Results
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const isOpen = round.state === "OPEN";
  const staked = round.user_stake !== null;
  const poolUsed = round.pool_points / Math.max(round.pool_capacity, 1);

  return (
    <div className="shell py-12 sm:py-14">
      <nav aria-label="Breadcrumb" className="mb-8 flex items-center gap-2.5">
        <Link href="/competitions" className="link t-label text-[0.625rem]">
          Rounds
        </Link>
        <span aria-hidden="true" className="t-mono text-[0.625rem] text-faint">
          /
        </span>
        <span className="t-label text-[0.625rem] text-muted">
          {round.brief_title}
        </span>
      </nav>

      <div className="grid gap-3 lg:grid-cols-[1.35fr_1fr] lg:items-start">
        <div className="space-y-3">
          <Panel className="p-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Status
                tone={roundTone(round.state)}
                pulse={round.state === "OPEN"}
              >
                {roundLabel(round.state)}
              </Status>
              <span className="t-mono text-[0.6875rem] text-faint">
                {new Date(round.deadline).toLocaleString()}
              </span>
            </div>

            <h1 className="t-title mt-5 text-[clamp(1.6rem,3.2vw,2.25rem)] text-ink">
              {round.brief_title}
            </h1>
            <p className="t-body mt-4 max-w-[60ch] text-sm text-muted">
              {round.brief_text}
            </p>

            <div className="mt-7 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-3">
              {round.models.map((m) => (
                <div key={m.id} className="bg-void-2/80 px-4 py-3.5">
                  <p className="t-label text-[0.5625rem] text-faint">
                    Contender
                  </p>
                  <p className="mt-1 text-[0.875rem] text-ink">{m.name}</p>
                </div>
              ))}
            </div>
          </Panel>

          <Panel className="p-7">
            <div className="flex items-center justify-between">
              <h2 className="t-title text-[1rem] text-ink">The pool</h2>
              <span className="t-num text-[0.8125rem] text-muted">
                {round.pool_points.toLocaleString()} pts
              </span>
            </div>
            <Meter
              value={poolUsed}
              className="mt-4"
              label={`Pool is ${Math.round(poolUsed * 100)} percent of capacity`}
            />
            <p className="t-body mt-3 text-xs text-faint">
              Points, not money. The pot is split pro-rata among the backers of
              the model that conforms to the brief.
            </p>
          </Panel>
        </div>

        {/* Stake panel */}
        <Panel className="p-7 lg:sticky lg:top-24">
          {isOpen && !staked ? (
            <form onSubmit={handleSubmit}>
              <div className="flex items-center justify-between">
                <h2 className="t-title text-[1rem] text-ink">
                  Stake on a model
                </h2>
                <span className="t-mono text-[0.625rem] text-faint">
                  before deadline
                </span>
              </div>

              <fieldset className="mt-5">
                <legend className="t-label text-[0.5625rem] text-faint">
                  Which model conforms?
                </legend>
                <div className="mt-2.5 space-y-2">
                  {round.models.map((m) => {
                    const active = selected === m.id;
                    return (
                      <label
                        key={m.id}
                        className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet ${
                          active
                            ? "border-magenta bg-magenta/[0.07]"
                            : "border-[var(--control-line)] bg-white/[0.015] hover:border-white/45"
                        }`}
                      >
                        <input
                          type="radio"
                          name="model"
                          value={m.id}
                          checked={active}
                          onChange={() => setSelected(m.id)}
                          className="sr-only"
                        />
                        {/* filled vs hollow ring: selection never relies on colour */}
                        <span
                          aria-hidden="true"
                          className={`grid size-[15px] shrink-0 place-items-center rounded-full border ${
                            active ? "border-magenta" : "border-white/40"
                          }`}
                        >
                          <span
                            className={`size-[7px] rounded-full ${
                              active ? "bg-magenta" : "bg-transparent"
                            }`}
                          />
                        </span>
                        <span className="text-[0.875rem] text-ink">
                          {m.name}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <div className="mt-5">
                <label
                  htmlFor="stake"
                  className="t-label block text-[0.5625rem] text-faint"
                >
                  Stake
                </label>
                <div className="mt-2.5 flex items-center gap-2">
                  <input
                    id="stake"
                    type="number"
                    min={10}
                    step={10}
                    value={stake}
                    onChange={(e) => setStake(e.target.value)}
                    aria-describedby="stake-hint"
                    className="field t-num"
                  />
                  <span className="t-mono shrink-0 text-[0.6875rem] text-faint">
                    pts
                  </span>
                </div>
                <p
                  id="stake-hint"
                  className="t-mono mt-2 text-[0.625rem] text-faint"
                >
                  minimum 10 points · one stake per round
                </p>
              </div>

              {error ? (
                <p
                  role="alert"
                  className="mt-4 rounded-lg border border-magenta/30 bg-magenta/[0.07] px-3 py-2 text-xs text-magenta"
                >
                  {error}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={saving || !selected || Number(stake) < 10}
                className="btn btn-solid btn-block mt-6"
              >
                {saving ? "Sealing…" : "Seal this stake"}
              </button>

              <p className="t-mono mt-3 text-center text-[0.625rem] leading-relaxed text-faint">
                committed on devnet as hash(pick, stake, nonce)
              </p>
            </form>
          ) : staked ? (
            <div className="text-center">
              <Status tone="ink">Sealed</Status>
              <p className="t-title mt-5 text-lg text-ink">
                Your stake is in the pool.
              </p>
              <p className="t-body mt-2 text-sm text-muted">
                It is locked for this round, and settles with the pool once the
                round settles.
              </p>
              <Link
                href="/predictions"
                className="btn btn-ghost btn-block mt-6"
              >
                My predictions
              </Link>
            </div>
          ) : (
            <div className="text-center">
              <Status tone="violet">{roundLabel(round.state)}</Status>
              <p className="t-title mt-5 text-lg text-ink">
                {round.state === "SETTLED" || round.state === "ARCHIVED"
                  ? "This round has settled."
                  : round.state === "CANCELLED" || round.state === "FAILED"
                    ? "This round did not run."
                    : "Staking is closed."}
              </p>
              <p className="t-body mt-2 text-sm text-muted">
                {round.state === "EVALUATING"
                  ? "Renders are in and the judge is ruling on conformance."
                  : round.state === "SETTLED" || round.state === "ARCHIVED"
                    ? "Its conformance result and the crowd's choice are recorded in Results."
                    : round.state === "CANCELLED" || round.state === "FAILED"
                      ? "No render ran, so every stake is void and its points return to the pool."
                      : "The round has locked. Renders are being produced, and the crowd vote opens once they land."}
              </p>
              <Link href="/results" className="btn btn-ghost btn-block mt-6">
                Results
              </Link>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
