"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Transaction } from "@solana/web3.js";
import { CountdownReadout } from "@/components/countdown";
import { Meter, Panel, Status } from "@/components/ui";
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
  const [amount, setAmount] = useState("0.01");
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [wallet, setWallet] = useState<string | null>(null);
  // Wall-clock read in the poll tick, never during render.
  const [now, setNow] = useState(0);

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
      };
      setPool(body.pool);
      setMine(body.mine);
    }
  }, [roundId]);

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

  async function placeWager(kind: "ante" | "live") {
    if (!selected) return;
    setStep({ kind: "working", label: "Connecting Phantom…" });
    try {
      const address = await connectPhantom();
      setWallet(address);

      setStep({
        kind: "working",
        label:
          kind === "ante" ? "Pricing the $5 ante…" : "Preparing the wager…",
      });
      const prepareResponse = await fetch(
        `/api/rounds/${roundId}/wagers/prepare`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modelId: selected,
            kind,
            sol: kind === "live" ? amount : undefined,
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
  const poolByModel = new Map((pool?.models ?? []).map((m) => [m.modelId, m]));

  return (
    <div className="space-y-3">
      {/* Betting state */}
      <Panel className="p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Status
            tone={phase === "closed" ? "ink" : "live"}
            pulse={phase !== "closed"}
          >
            {phase === "ante"
              ? "Ante open"
              : phase === "live"
                ? "Live betting open"
                : "Betting closed"}
          </Status>
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
          {phase === "ante"
            ? "Place the $5-equivalent ante in Devnet SOL to join this round. Live betting opens when generation starts."
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

      {/* Pool */}
      <Panel className="p-7">
        <div className="flex items-center justify-between">
          <h2 className="t-title text-[1rem] text-ink">The pool</h2>
          <span className="t-num text-[0.8125rem] text-muted">
            {sol(pool?.grossLamports)}
          </span>
        </div>
        <p className="t-mono mt-1 text-[0.625rem] text-faint">
          {pool?.settlement
            ? "settled returns"
            : pool?.final
              ? "pool locked · returns depend on the outcome"
              : "estimated payout multipliers · change until betting closes"}
          {pool && pool.pendingWagers > 0
            ? ` · ${pool.pendingWagers} confirming`
            : ""}
        </p>
        <div className="mt-4 space-y-2">
          {models.map((model) => {
            const entry = poolByModel.get(model.id);
            return (
              <div
                key={model.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-hairline px-4 py-3"
              >
                <span className="text-[0.8125rem] text-ink">{model.name}</span>
                <span className="t-num text-[0.75rem] text-muted">
                  {sol(entry?.stakedLamports)} ·{" "}
                  <span className="text-ink">
                    {entry?.multiplier
                      ? `${entry.multiplier.toFixed(2)}×${pool?.settlement ? "" : " est."}`
                      : "no backers"}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
        <p className="t-body mt-3 text-xs text-faint">
          Parimutuel: the pool, minus the disclosed fee, is split pro-rata among
          backers of the model that conforms. Tied winners split by dead heat.
          If nobody backed a winner, or the round is void, every wager is
          refunded in full.
        </p>
      </Panel>

      {/* Wager form */}
      {mine && (canAnte || canLive) ? (
        <Panel className="p-7">
          <h2 className="t-title text-[1rem] text-ink">
            {canAnte ? "Place your $5 ante" : "Place a live wager"}
          </h2>
          <fieldset className="mt-5" disabled={busy || confirming}>
            <legend className="t-label text-[0.5625rem] text-faint">
              Which model conforms?
            </legend>
            <div className="mt-2.5 space-y-2">
              {models.map((m) => {
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
                      name="sol-model"
                      value={m.id}
                      checked={active}
                      onChange={() => setSelected(m.id)}
                      className="sr-only"
                    />
                    <span
                      aria-hidden="true"
                      className={`grid size-[15px] shrink-0 place-items-center rounded-full border ${active ? "border-magenta" : "border-white/40"}`}
                    >
                      <span
                        className={`size-[7px] rounded-full ${active ? "bg-magenta" : "bg-transparent"}`}
                      />
                    </span>
                    <span className="text-[0.875rem] text-ink">{m.name}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {canLive ? (
            <div className="mt-5">
              <label
                htmlFor="sol-amount"
                className="t-label block text-[0.5625rem] text-faint"
              >
                Amount
              </label>
              <div className="mt-2.5 flex items-center gap-2">
                <input
                  id="sol-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="field t-num"
                />
                <span className="t-mono shrink-0 text-[0.6875rem] text-faint">
                  SOL
                </span>
              </div>
              <p className="t-mono mt-2 text-[0.625rem] text-faint">
                0.005–0.25 SOL · up to 10 live wagers · 1 SOL per round
              </p>
            </div>
          ) : (
            <p className="t-mono mt-4 text-[0.625rem] text-faint">
              ${((pool?.anteUsdCents ?? 500) / 100).toFixed(2)} in Devnet SOL at
              the current SOL/USD reference price
            </p>
          )}

          <button
            type="button"
            onClick={() => placeWager(canAnte ? "ante" : "live")}
            disabled={busy || confirming || !selected}
            className="btn btn-solid btn-block mt-6"
          >
            {busy
              ? step.label
              : confirming
                ? "Waiting for your last wager…"
                : canAnte
                  ? "Sign the ante in Phantom"
                  : "Sign this wager in Phantom"}
          </button>
          <p className="t-mono mt-3 text-center text-[0.625rem] leading-relaxed text-faint">
            one transaction: SOL transfer + memo commitment · Phantom must be in
            Devnet (testnet mode)
            {wallet ? ` · ${wallet.slice(0, 4)}…${wallet.slice(-4)}` : ""}
          </p>
        </Panel>
      ) : mine && !mine.canWager ? (
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
