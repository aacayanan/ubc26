"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Transaction } from "@solana/web3.js";
import { CountdownReadout } from "@/components/countdown";
import {
  SolMarketBoard,
  appendPriceSample,
  type BoardPool,
} from "@/components/sol-market-board";
import type { PriceSample } from "@/components/price-ribbon";
import {
  Meter,
  Panel,
  RoundBento,
  Status,
  type BentoStat,
} from "@/components/ui";
import { VerifyCommitment } from "@/components/verify-commitment";
import { formatMultiplier } from "@/lib/odds";
import { formatSol } from "@/lib/sol-pool";

/**
 * SOL round view (Devnet prototype, 2026-11-20).
 *
 * Wager lifecycle shown to the user, honestly:
 *   preparing → awaiting signature → confirming on Devnet → accepted
 *                                                         → rejected / expired
 * Only "accepted" means the wager is in the pool. Explorer links appear only
 * for transactions that exist on-chain; a payout shows "Paid" only once the
 * transfer is confirmed.
 *
 * The live code and renders are the shared LiveRoundPanel (F27) below this
 * view; this component adds the token meters, betting state, pool and wagers.
 */

interface PoolModel {
  modelId: string;
  stakedLamports: string;
  share: number;
  multiplier: number | null;
}

interface Pool {
  wageringMode: string;
  bettingPhase: "ante" | "live" | "closed";
  bettingClosedAt: string | null;
  bettingCloseReason: string | null;
  bettingCloseModelId: string | null;
  feeBps: number;
  anteUsdCents: number;
  tier: string | null;
  tierLabel: string | null;
  cutoffBps: number;
  tokenBudgetPerModel: number | null;
  treasuryAddress: string | null;
  final: boolean;
  grossLamports: string;
  feeLamports: string;
  netLamports: string;
  pendingWagers: number;
  acceptedWagers: number;
  bettors: number;
  models: PoolModel[];
  settlement: Record<string, unknown> | null;
  meters: Record<string, { tokens: number; estimated: boolean }>;
}

interface MyWager {
  id: string;
  kind: "ante" | "live";
  modelId: string;
  lamports: string;
  status: string;
  explorerUrl: string | null;
  rejectionReason: string | null;
  settlementOutcome: string | null;
  payoutLamports: string | null;
}

interface MyPayout {
  id: string;
  kind: string;
  lamports: string;
  status: string;
  explorerUrl: string | null;
  lastError: string | null;
}

interface Mine {
  wagers: MyWager[];
  payouts: MyPayout[];
  canWager: boolean;
}

type Step =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | {
      kind: "done";
      status: string;
      message: string;
      explorerUrl: string | null;
    };

const CLOSE_REASON: Record<string, string> = {
  token_threshold: "reached 75% of its output-token budget",
  model_finished: "finished early",
  model_failed: "failed",
  all_models_stopped: "generation ended",
  stall: "generation stalled (safeguard)",
  round_failed: "the round failed",
  admin: "an operator closed it",
};

function lamports(value: string | null | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return BigInt(0);
  }
}

function sol(value: string | null | undefined): string {
  return `${formatSol(lamports(value))} SOL`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function connectPhantom(): Promise<string> {
  const provider = window.solana;
  if (!provider?.connect || !provider.signTransaction) {
    throw new Error("Phantom is not available in this browser");
  }
  const existing = provider.publicKey?.toBase58();
  if (existing) return existing;
  const result = await provider.connect();
  return result.publicKey.toBase58();
}

/** Lamports as SOL, rounded up to 4 decimals so it always clears the minimum. */
function minimumSol(lamports: string): string {
  return (Math.ceil(Number(lamports) / 100_000) / 10_000).toFixed(4);
}

export function SolRound({
  roundId,
  status,
  deadline,
  models,
}: {
  roundId: string;
  status: string;
  deadline: string;
  models: { id: string; name: string }[];
}) {
  const [pool, setPool] = useState<Pool | null>(null);
  const [mine, setMine] = useState<Mine | null>(null);
  const [selected, setSelected] = useState("");
  const [amount, setAmount] = useState("");
  // The $3 live minimum in lamports at the current reference price (advisory;
  // the server re-checks it when the wager is prepared).
  const [liveMinimum, setLiveMinimum] = useState<{
    usdCents: number;
    lamports: string;
  } | null>(null);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [wallet, setWallet] = useState<string | null>(null);
  // Wall-clock read in the poll tick, never during render.
  const [now, setNow] = useState(0);
  // Price readings, recorded where the pool was actually observed. A poll that
  // returns the same numbers adds nothing (appendPriceSample), so an idle
  // market's trace stays flat instead of looking busy.
  const [samples, setSamples] = useState<PriceSample[]>([]);

  const names = useMemo(
    () => new Map(models.map((m) => [m.id, m.name])),
    [models],
  );

  const refresh = useCallback(async () => {
    const poolResponse = await fetch(`/api/rounds/${roundId}/pool`, {
      cache: "no-store",
    });
    if (poolResponse.ok) {
      const body = (await poolResponse.json()) as {
        pool: Pool;
        mine: Mine | null;
        liveMinimum?: { usdCents: number; lamports: string } | null;
      };
      setPool(body.pool);
      setMine(body.mine);
      setLiveMinimum(body.liveMinimum ?? null);
      setSamples((previous) =>
        appendPriceSample(previous, body.pool as BoardPool, models),
      );
    }
  }, [roundId, models]);

  useEffect(() => {
    let active = true;
    const tick = () => {
      if (!active) return;
      setNow(Date.now());
      setWallet(window.solana?.publicKey?.toBase58() ?? null);
      void refresh().catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 2_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const acceptedAnte = mine?.wagers.find(
    (w) => w.kind === "ante" && w.status === "accepted",
  );
  const confirming =
    mine?.wagers.some((w) => w.status === "submitted") ?? false;
  const phase = pool?.bettingPhase ?? "ante";
  const anteOpen =
    status === "OPEN" &&
    phase === "ante" &&
    now > 0 &&
    now < Date.parse(deadline);
  const liveOpen =
    phase === "live" && status !== "SETTLED" && status !== "VOIDED";
  const canAnte = anteOpen && !acceptedAnte && mine?.canWager;
  const canLive = liveOpen && Boolean(acceptedAnte) && mine?.canWager;
  // The buy-in comes from the round's tier, never a constant: a $2 cheap round
  // and a $10 exclusive round differ only in this number.
  const anteLabel =
    pool?.anteUsdCents === undefined
      ? "tier-priced"
      : `$${(pool.anteUsdCents / 100).toFixed(2)}`;

  async function placeWager(kind: "ante" | "live") {
    if (!selected) return;
    setStep({ kind: "working", label: "Connecting Phantom…" });
    try {
      const address = await connectPhantom();
      setWallet(address);

      setStep({
        kind: "working",
        label:
          kind === "ante"
            ? `Pricing the ${anteLabel} ante…`
            : "Preparing the wager…",
      });
      const prepareResponse = await fetch(
        `/api/rounds/${roundId}/wagers/prepare`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modelId: selected,
            kind,
            // A blank amount bets the current $3 minimum.
            sol:
              kind === "live"
                ? amount.trim() ||
                  (liveMinimum ? minimumSol(liveMinimum.lamports) : "")
                : undefined,
            wallet: address,
          }),
        },
      );
      const prepared = await prepareResponse.json();
      if (!prepareResponse.ok)
        throw new Error(
          prepared?.error?.message ?? "Could not prepare the wager",
        );

      setStep({
        kind: "working",
        label: `Approve ${sol(prepared.wager.lamports)} in Phantom…`,
      });
      const transaction = Transaction.from(
        fromBase64(prepared.wager.transaction),
      );
      const signed = await window.solana!.signTransaction!(transaction);
      const signedB64 = toBase64(
        (signed as Transaction).serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }),
      );

      setStep({ kind: "working", label: "Confirming on Solana Devnet…" });
      const submitResponse = await fetch(
        `/api/rounds/${roundId}/wagers/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wagerId: prepared.wager.wagerId,
            signedTransaction: signedB64,
          }),
        },
      );
      const submitted = await submitResponse.json();
      if (!submitResponse.ok)
        throw new Error(
          submitted?.error?.message ?? "The wager was not accepted",
        );

      const result = submitted.wager as {
        status: string;
        reason: string | null;
        explorerUrl: string | null;
      };
      setStep({
        kind: "done",
        status: result.status,
        message:
          result.status === "accepted"
            ? "Accepted. Your wager is in the pool and verified on Devnet."
            : result.status === "submitted"
              ? "Still confirming on Devnet. It counts only once it is accepted."
              : (result.reason ?? "The wager was not accepted."),
        explorerUrl: result.explorerUrl,
      });
      await refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The wager failed";
      setStep({
        kind: "done",
        status: "error",
        message: /reject|denied|cancel/i.test(message)
          ? "You declined the signature. Nothing was sent."
          : message,
        explorerUrl: null,
      });
    }
  }

  const busy = step.kind === "working";
  const budget = pool?.tokenBudgetPerModel ?? null;
  const cutoff = (pool?.cutoffBps ?? 7500) / 10_000;

  // The statistics grid exists only while the round is still open. The moment
  // it locks, every tile disappears and the page is the live show — the market
  // board, the token meters and the renders — so nothing on screen can be read
  // as a pre-deadline reading after the deadline has passed. An unparseable
  // deadline counts as passed: a clock we cannot read must never look safe to
  // stake on (the same rule `describeDeadline` applies).
  const deadlineMs = Date.parse(deadline);
  const deadlinePassed =
    !Number.isFinite(deadlineMs) || (now > 0 && now >= deadlineMs);
  const statsOpen = status === "OPEN" && !deadlinePassed;

  // The bento: every pre-deadline statistic in one instrument grid. Each value
  // is a pool aggregate or the round's own configuration — nothing invented —
  // and before the pool answers, a tile simply reads "—".
  const bestPayout = (pool?.models ?? [])
    .map((m) => m.multiplier)
    .filter((m): m is number => m !== null)
    .reduce<number | null>(
      (best, m) => (best === null || m > best ? m : best),
      null,
    );
  const bentoStats: BentoStat[] = [
    {
      label: "The pool",
      value: pool ? formatSol(lamports(pool.grossLamports)) : "—",
      suffix: pool ? "SOL" : undefined,
      note:
        pool && pool.pendingWagers > 0
          ? `${pool.pendingWagers} wagers confirming`
          : "Devnet test SOL",
    },
    {
      label: "Backers",
      value: pool ? String(pool.bettors) : "—",
      note: "distinct wallets in the pool",
    },
    {
      label: "Wagers",
      value: pool ? String(pool.acceptedWagers) : "—",
      note: "ante and live, accepted",
    },
    {
      label: "The ante",
      value: `$${((pool?.anteUsdCents ?? 500) / 100).toFixed(2)}`,
      note: "paid in Devnet SOL",
    },
    {
      label: "Betting cutoff",
      value: String(Math.round(cutoff * 100)),
      suffix: "%",
      note: "of each model's token budget",
    },
    {
      label: "Token budget",
      value: budget ? budget.toLocaleString() : "—",
      suffix: budget ? "tokens" : undefined,
      note: "output tokens per model",
    },
    {
      label: "Best payout",
      value: bestPayout === null ? "—" : formatMultiplier(bestPayout),
      note:
        bestPayout === null ? "no backers yet" : "if that model conforms alone",
    },
    {
      label: "Winning-round fee",
      value: pool ? String(pool.feeBps / 100) : "—",
      suffix: pool ? "%" : undefined,
      note: "deducted before the split",
    },
  ];

  return (
    <div className="space-y-3">
      {/* Betting state. The phase badge that used to sit here ("Ante open",
          "Live betting open") is gone: the sentence below states the phase in
          full, and the board's own ticket says what to do about it. */}
      <Panel className="p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {pool?.tierLabel ? (
            <span className="t-mono text-[0.6875rem] text-faint">
              {pool.tierLabel} tier · {anteLabel} buy-in
            </span>
          ) : null}
          {anteOpen ? (
            <span className="t-mono flex items-center gap-1.5 text-[0.6875rem] text-muted">
              <span className="text-faint">ante closes in</span>
              <CountdownReadout
                deadline={deadline}
                className="t-num text-ink"
              />
            </span>
          ) : null}
        </div>
        <p className="t-body mt-4 text-sm text-muted">
          {phase === "ante" && anteOpen
            ? `Place the ${anteLabel}-equivalent ante in Devnet SOL to join this round. Live betting opens when generation starts.`
            : phase === "ante"
              ? "The ante window closed with the deadline. Live betting opens the moment generation starts."
              : phase === "live"
                ? `Betting closes the moment any model reaches ${Math.round(cutoff * 100)}% of its output-token budget, or earlier if a model finishes or fails.`
                : pool?.bettingCloseReason
                  ? `Closed because ${pool.bettingCloseModelId ? `${names.get(pool.bettingCloseModelId) ?? "a model"} ` : ""}${CLOSE_REASON[pool.bettingCloseReason] ?? pool.bettingCloseReason}.${pool.final ? " Final pool locked." : ""}`
                  : "Betting is closed."}
        </p>
        <p className="t-mono mt-3 text-[0.625rem] text-faint">
          Devnet test SOL only · no real value ·{" "}
          {pool ? `${pool.feeBps / 100}% fee on winning rounds` : ""}
        </p>
      </Panel>

      {/* The statistics a viewer scans before staking — pool, backers, clock,
          cutoff, payout. They exist only while the round is open: once it
          locks these numbers are no longer a decision input, so the grid
          unmounts and the live show takes the page. */}
      {statsOpen ? <RoundBento stats={bentoStats} /> : null}

      {/* The market: the price trace, the three sides, and the ticket. This is
          the way to place a wager — pick a side on the chart, drag the stake,
          see the projection move before the signature. */}
      {pool ? (
        <SolMarketBoard
          models={models}
          pool={pool}
          selected={selected}
          onSelect={setSelected}
          amount={amount}
          onAmount={setAmount}
          samples={samples}
          minimum={
            liveMinimum
              ? {
                  usdCents: liveMinimum.usdCents,
                  sol: minimumSol(liveMinimum.lamports),
                }
              : null
          }
          drafting={Boolean(canLive)}
          ante={Boolean(canAnte)}
          busy={busy || confirming}
          busyLabel={
            step.kind === "working"
              ? step.label
              : confirming
                ? "Waiting for your last wager…"
                : undefined
          }
          onSubmit={() => placeWager(canAnte ? "ante" : "live")}
          ctaLabel={
            canAnte ? "Sign the ante in Phantom" : "Sign this wager in Phantom"
          }
          anteNote={
            canAnte
              ? `${anteLabel} in Devnet SOL at the current SOL/USD reference price`
              : undefined
          }
        />
      ) : null}

      {/* Live generation with token meters */}
      <Panel className="p-7">
        <h2 className="t-title text-[1rem] text-ink">Token budget</h2>
        <p className="t-mono mt-1 text-[0.625rem] text-faint">
          output tokens per model · the line marks the betting cutoff
        </p>
        <div className="mt-5 space-y-5">
          {models.map((model) => {
            const meter = pool?.meters[model.id];
            const used =
              budget && meter ? Math.min(meter.tokens / budget, 1) : 0;
            return (
              <div key={model.id}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[0.875rem] text-ink">{model.name}</p>
                  <span className="t-num text-[0.6875rem] text-muted">
                    {meter
                      ? `${meter.tokens.toLocaleString()}${meter.estimated ? "≈" : ""}`
                      : "0"}
                    {budget ? ` / ${budget.toLocaleString()} tokens` : ""}
                  </span>
                </div>
                <div className="relative mt-2">
                  <Meter
                    value={used}
                    label={`${model.name} has used ${Math.round(used * 100)} percent of its token budget`}
                  />
                  <span
                    aria-hidden="true"
                    className="absolute top-[-3px] h-[calc(100%+6px)] w-px bg-ink/60"
                    style={{ left: `${cutoff * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* The rules, once. The board above carries the prices; this carries the
          settlement logic and the wallet the signature came from. */}
      <Panel quiet className="p-6">
        <p className="t-body text-xs leading-relaxed text-faint">
          Parimutuel: the pool, minus the disclosed fee, is split pro-rata among
          backers of the model that conforms. Tied winners split by dead heat.
          If nobody backed a winner, or the round is void, every wager is
          refunded in full.
        </p>
        <p className="t-mono mt-3 text-[0.625rem] leading-relaxed text-faint">
          one transaction: SOL transfer + memo commitment · Phantom must be in
          Devnet (testnet mode)
          {wallet ? ` · ${wallet.slice(0, 4)}…${wallet.slice(-4)}` : ""}
        </p>
      </Panel>

      {mine && !mine.canWager ? (
        <Panel quiet className="p-6">
          <p className="t-body text-sm text-muted">
            Staff accounts can watch but not wager.
          </p>
        </Panel>
      ) : mine && liveOpen && !acceptedAnte ? (
        <Panel quiet className="p-6">
          <p className="t-body text-sm text-muted">
            Live betting is for accounts that placed the ante before the
            deadline. You can still watch, and vote once betting closes.
          </p>
        </Panel>
      ) : !mine ? (
        <Panel quiet className="p-6">
          <p className="t-body text-sm text-muted">
            Sign in to wager. Watching needs no account.
          </p>
        </Panel>
      ) : null}

      {step.kind === "done" ? (
        <div
          role="status"
          className={`rounded-lg border px-4 py-3 text-xs ${
            step.status === "accepted"
              ? "border-hairline text-ink"
              : "border-magenta/30 bg-magenta/[0.07] text-magenta"
          }`}
        >
          {step.message}
          {step.explorerUrl ? (
            <>
              {" "}
              <a
                href={step.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="link"
              >
                View on Solana Explorer
              </a>
            </>
          ) : null}
        </div>
      ) : null}

      {/* My wagers and payouts */}
      {mine && (mine.wagers.length > 0 || mine.payouts.length > 0) ? (
        <Panel className="p-7">
          <h2 className="t-title text-[1rem] text-ink">Your wagers</h2>
          <ul className="mt-4 space-y-2">
            {mine.wagers.map((w) => (
              <li
                key={w.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-4 py-3 text-[0.75rem]"
              >
                <span className="text-ink">
                  {w.kind === "ante" ? "Ante" : "Live"} ·{" "}
                  {names.get(w.modelId) ?? "model"} · {sol(w.lamports)}
                </span>
                <span className="flex items-center gap-3">
                  <Status
                    tone={
                      w.status === "accepted"
                        ? "ink"
                        : w.status === "submitted"
                          ? "live"
                          : "amber"
                    }
                  >
                    {w.settlementOutcome ??
                      (w.status === "submitted" ? "confirming" : w.status)}
                  </Status>
                  {w.explorerUrl ? (
                    <a
                      href={w.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="link t-mono text-[0.625rem]"
                    >
                      tx
                    </a>
                  ) : null}
                </span>
                {w.status === "accepted" ? (
                  <div className="w-full">
                    <VerifyCommitment wagerId={w.id} />
                  </div>
                ) : null}
              </li>
            ))}
            {mine.payouts.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-4 py-3 text-[0.75rem]"
              >
                <span className="text-ink">
                  {p.kind === "refund" ? "Refund" : "Winnings"} ·{" "}
                  {sol(p.lamports)}
                </span>
                <span className="flex items-center gap-3">
                  <Status
                    tone={
                      p.status === "confirmed"
                        ? "ink"
                        : p.status === "blocked" || p.status === "failed"
                          ? "amber"
                          : "live"
                    }
                  >
                    {p.status === "confirmed"
                      ? "Paid"
                      : p.status === "submitted" || p.status === "uncertain"
                        ? "Sending"
                        : p.status === "blocked"
                          ? "On hold"
                          : "Queued"}
                  </Status>
                  {p.explorerUrl ? (
                    <a
                      href={p.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="link t-mono text-[0.625rem]"
                    >
                      tx
                    </a>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
