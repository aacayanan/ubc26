"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Panel, Status } from "@/components/ui";

interface ChainRecord {
  purpose: string;
  status: string;
  signature: string | null;
  explorerUrl: string | null;
  memo: string;
  confirmedAt: string | null;
  matchesRound: boolean | null;
  matchesOutcome: boolean | null;
  settlement: {
    kind: string;
    reason: string;
    winners: string[];
    grossLamports: string;
    feeLamports: string;
    netLamports: string;
    payoutCount: number;
    detail: string;
  } | null;
  onChain: {
    found: boolean;
    memoMatches: boolean;
    operatorSigned: boolean;
    blockTime: string | null;
  } | null;
}

interface RecordsResponse {
  roundId: string;
  anteDeadline: string;
  records: ChainRecord[];
}

const LABELS: Record<string, { title: string; what: string }> = {
  round_record: {
    title: "Round opened",
    what: "The round, its ante deadline and its betting rules.",
  },
  betting_close: {
    title: "Betting closed",
    what: "When betting closed and why.",
  },
  settlement: {
    title: "Round settled",
    what: "The result: winning models, the pool, the 5% fee and the payout count.",
  },
};

function sol(lamports: string): string {
  return (Number(lamports) / 1_000_000_000).toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
}

/** One plain line for a settlement record: who was paid, or why it refunded. */
function settlementLine(s: NonNullable<ChainRecord["settlement"]>): string {
  if (s.kind === "settled") {
    return `Paid ${sol(s.netLamports)} SOL to backers of ${s.winners.join(" and ")} · 5% fee ${sol(s.feeLamports)} SOL kept by the treasury · ${s.payoutCount} payout${s.payoutCount === 1 ? "" : "s"}`;
  }
  const why =
    s.reason === "voided"
      ? "the round was void"
      : s.reason === "no_winner"
        ? "no model conformed"
        : s.reason === "winner_unbacked"
          ? "nobody backed the conforming model"
          : s.reason;
  return `Refunded ${sol(s.grossLamports)} SOL in full because ${why} · no fee · ${s.payoutCount} refund${s.payoutCount === 1 ? "" : "s"}`;
}

function statusWord(record: ChainRecord): {
  tone: "ink" | "live" | "amber";
  word: string;
} {
  if (record.status === "confirmed") return { tone: "ink", word: "On Devnet" };
  if (record.status === "pending") return { tone: "live", word: "Recording" };
  // timeout / failed: shown honestly, never as confirmed.
  return { tone: "amber", word: "Not recorded yet, retrying" };
}

/**
 * F21/F22: the round's public, operator-signed records on Solana Devnet.
 *
 * These are the operator's attestations: they timestamp what the backend
 * decided. They do not prove the models or the judge were honest.
 */
export function RoundRecords({ roundId }: { roundId: string }) {
  const [data, setData] = useState<RecordsResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (checkChain: boolean) => {
      const response = await fetch(
        `/api/rounds/${roundId}/records${checkChain ? "?check=1" : ""}`,
        { cache: "no-store" },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Could not load the records");
      }
      return body as RecordsResponse;
    },
    [roundId],
  );

  useEffect(() => {
    let active = true;
    const tick = () =>
      load(false)
        .then((loaded) => {
          if (active) setData((current) => mergeChecks(current, loaded));
        })
        .catch(() => undefined);
    void tick();
    // Records land a few seconds after the events they describe.
    const timer = window.setInterval(tick, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [load]);

  async function check() {
    setChecking(true);
    setError(null);
    try {
      setData(await load(true));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Check failed");
    } finally {
      setChecking(false);
    }
  }

  if (!data || data.records.length === 0) return null;
  const anyConfirmed = data.records.some((r) => r.status === "confirmed");

  return (
    <Panel className="mt-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="t-title text-[1rem] text-ink">On-chain record</h2>
        {anyConfirmed ? (
          <button
            type="button"
            onClick={() => void check()}
            disabled={checking}
            className="link t-label text-[0.625rem]"
          >
            {checking ? "Checking…" : "Check on Devnet"}
          </button>
        ) : null}
      </div>
      <p className="t-body mt-2 max-w-[70ch] text-xs text-muted">
        Zelto publishes each step of this round on Solana Devnet, so its timing
        can be checked independently. These are the operator&rsquo;s records of
        what the backend decided. They don&rsquo;t prove the models or the judge
        were honest.{" "}
        <Link href="/on-chain" className="link">
          What&rsquo;s on-chain
        </Link>
      </p>

      {error ? (
        <p role="alert" className="mt-3 text-xs text-magenta">
          {error}
        </p>
      ) : null}

      <ul className="mt-4 grid gap-3">
        {data.records.map((record) => {
          const label = LABELS[record.purpose] ?? {
            title: record.purpose,
            what: "",
          };
          const status = statusWord(record);
          return (
            <li
              key={record.purpose}
              className="rounded-xl border border-hairline px-4 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[0.875rem] text-ink">{label.title}</p>
                  <p className="t-body text-[0.75rem] text-faint">
                    {label.what}
                  </p>
                </div>
                <span className="flex items-center gap-3">
                  <Status tone={status.tone}>{status.word}</Status>
                  {record.explorerUrl ? (
                    <a
                      href={record.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="link t-mono text-[0.625rem]"
                    >
                      tx
                    </a>
                  ) : null}
                </span>
              </div>

              {record.purpose === "round_record" ? (
                <p className="t-mono mt-2 text-[0.625rem] text-muted">
                  ante deadline {data.anteDeadline} (UTC)
                </p>
              ) : null}

              {record.settlement ? (
                <p className="t-body mt-2 text-[0.75rem] text-muted">
                  {settlementLine(record.settlement)}
                </p>
              ) : null}

              {record.matchesOutcome === false ? (
                <p className="mt-2 text-xs text-magenta">
                  This settlement does not match the round&rsquo;s result:{" "}
                  {record.settlement?.detail}
                </p>
              ) : null}

              {record.matchesRound === false ? (
                <p className="mt-2 text-xs text-magenta">
                  This record does not match the round&rsquo;s stored details.
                </p>
              ) : null}

              {record.onChain ? (
                <p className="t-mono mt-2 text-[0.625rem] text-muted">
                  {record.onChain.found &&
                  record.onChain.memoMatches &&
                  record.onChain.operatorSigned &&
                  record.matchesRound !== false &&
                  record.matchesOutcome !== false
                    ? `Checked: on Devnet, signed by the operator, matches this round${record.onChain.blockTime ? ` · ${record.onChain.blockTime}` : ""}`
                    : "Check failed: the transaction on Devnet does not match this record."}
                </p>
              ) : null}

              <p className="t-mono mt-2 text-[0.5625rem] break-all text-faint">
                {record.memo}
              </p>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** Keep the last on-chain check while the background poll refreshes status. */
function mergeChecks(
  current: RecordsResponse | null,
  loaded: RecordsResponse,
): RecordsResponse {
  if (!current) return loaded;
  const checks = new Map(current.records.map((r) => [r.purpose, r.onChain]));
  return {
    ...loaded,
    records: loaded.records.map((r) => ({
      ...r,
      onChain: r.onChain ?? checks.get(r.purpose) ?? null,
    })),
  };
}
