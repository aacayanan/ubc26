"use client";

import Link from "next/link";
import { useState } from "react";
import { Status } from "@/components/ui";

interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

interface Verification {
  signature: string;
  explorerUrl: string;
  memo: string;
  preimage: {
    roundId: string;
    wagerId: string;
    modelId: string;
    lamports: string;
    nonce: string;
    commitmentHash: string;
  };
  checks: Check[];
  verified: boolean;
  scope: string;
}

/**
 * F20: let a wallet account verify its own commitment on demand.
 *
 * Every check is re-derived from Devnet by the server on each click; nothing
 * here is cached or asserted client-side. Pass / fail is a word next to the
 * dot, never colour alone.
 */
export function VerifyCommitment({ wagerId }: { wagerId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Verification | null>(null);

  async function verify() {
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/wagers/${wagerId}/verify`, {
        cache: "no-store",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Verification failed");
      }
      setResult(body.verification as Verification);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => void verify()}
        className="link t-label text-[0.625rem]"
      >
        Verify on Devnet
      </button>
    );
  }

  return (
    <div className="mt-4 w-full rounded-xl border border-hairline bg-white/[0.015] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="t-label text-[0.5625rem] text-faint">
          Commitment check · Solana Devnet
        </p>
        <div className="flex items-center gap-4">
          {result && !loading ? (
            <Status tone={result.verified ? "ink" : "amber"}>
              {result.verified ? "Verified" : "Not verified"}
            </Status>
          ) : null}
          <button
            type="button"
            onClick={() => void verify()}
            disabled={loading}
            className="link t-label text-[0.625rem]"
          >
            {loading ? "Checking…" : "Re-check"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="link t-label text-[0.625rem]"
          >
            Hide
          </button>
        </div>
      </div>

      {loading && !result ? (
        <p className="t-mono mt-3 text-[0.625rem] text-faint" aria-busy="true">
          Reading the transaction from Devnet…
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-xs text-magenta">
          {error}
        </p>
      ) : null}

      {result ? (
        <>
          <ul className="mt-4 space-y-2.5">
            {result.checks.map((check) => (
              <li key={check.id}>
                <Status tone={check.ok ? "ink" : "amber"}>
                  <span className="text-[0.8125rem] text-ink">
                    {check.ok ? "Pass" : "Fail"} — {check.label}
                  </span>
                </Status>
                <p className="t-mono mt-1 pl-4 text-[0.625rem] break-all text-faint">
                  {check.detail}
                </p>
              </li>
            ))}
          </ul>

          <details className="mt-4">
            <summary className="t-label cursor-pointer text-[0.5625rem] text-faint">
              Disclosed preimage (only you can see this)
            </summary>
            <dl className="t-mono mt-2 grid gap-1 text-[0.625rem] break-all text-muted">
              {Object.entries(result.preimage).map(([key, value]) => (
                <div key={key} className="flex gap-2">
                  <dt className="shrink-0 text-faint">{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <p className="t-mono mt-2 text-[0.5625rem] text-faint">
              hash =
              sha256(&quot;aisd:v2|roundId|wagerId|modelId|lamports|nonce&quot;)
            </p>
          </details>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <a
              href={result.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="link t-label text-[0.625rem]"
            >
              View transaction on Explorer &rarr;
            </a>
          </div>
          <p className="t-body mt-3 text-[0.6875rem] text-faint">
            {result.scope}{" "}
            <Link href="/on-chain" className="link">
              What&rsquo;s on-chain
            </Link>
          </p>
        </>
      ) : null}
    </div>
  );
}
