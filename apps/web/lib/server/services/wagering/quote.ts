import "server-only";

import { InternalError } from "@/lib/server/errors/app-error";

/**
 * Dollar-denominated prices (SOL prototype): the $5-equivalent ante and the
 * $3 minimum live wager.
 *
 * Devnet SOL has no market. The ante is priced against the *mainnet* SOL/USD
 * spot price as a reference, so the demo behaves like the product would — but
 * nothing of value moves. The wager itself is recorded in lamports, which are
 * authoritative; this quote is evidence of how that amount was chosen.
 *
 * Source: Coinbase public spot price. If it is unreachable and
 * SOL_USD_REFERENCE_PRICE is set, that configured reference is used and the
 * quote says so (`source: "configured"`) — it is never presented as live.
 */

export interface SolUsdQuote {
  source: "coinbase-spot" | "configured";
  /** USD per SOL, as a decimal string. */
  price: string;
  fetchedAt: string;
  anteUsdCents: number;
  lamports: string;
}

const LAMPORTS_PER_SOL = BigInt(1_000_000_000);

/** ceil(cents / 100 / price * 1e9) in exact integer arithmetic. */
export function lamportsForUsdCents(cents: number, price: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,12}))?$/.exec(price.trim());
  if (!match) throw new InternalError("Unparseable SOL/USD price", { price });
  const decimals = match[2] ?? "";
  const scale = BigInt(10) ** BigInt(decimals.length);
  const priceScaled = BigInt(match[1] + decimals);
  if (priceScaled <= BigInt(0))
    throw new InternalError("Non-positive SOL/USD price");

  // lamports = cents * 1e9 * scale / (price_scaled * 100), rounded up.
  const numerator = BigInt(cents) * LAMPORTS_PER_SOL * scale;
  const denominator = priceScaled * BigInt(100);
  return (numerator + denominator - BigInt(1)) / denominator;
}

async function fetchCoinbase(): Promise<string> {
  const response = await fetch(
    "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    {
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error(`coinbase ${response.status}`);
  const body = (await response.json()) as { data?: { amount?: string } };
  const amount = body.data?.amount;
  if (!amount || !/^\d+(\.\d+)?$/.test(amount))
    throw new Error("coinbase: bad body");
  return amount;
}

export interface SolUsdPrice {
  source: SolUsdQuote["source"];
  /** USD per SOL, as a decimal string. */
  price: string;
  fetchedAt: string;
}

/**
 * Cache window for the reference price. The pool endpoint is polled every few
 * seconds to show the live minimum; one upstream read per window is plenty
 * for a reference price and keeps the demo off Coinbase's rate limit.
 */
const PRICE_TTL_MS = 30_000;
let cachedPrice: { value: SolUsdPrice; at: number } | null = null;

/** The SOL/USD reference price, cached for PRICE_TTL_MS. */
export async function getSolUsdPrice(): Promise<SolUsdPrice> {
  if (cachedPrice && Date.now() - cachedPrice.at < PRICE_TTL_MS) {
    return cachedPrice.value;
  }
  const value = await readSolUsdPrice();
  cachedPrice = { value, at: Date.now() };
  return value;
}

export async function quoteAnte(anteUsdCents: number): Promise<SolUsdQuote> {
  const { source, price, fetchedAt } = await getSolUsdPrice();
  return {
    source,
    price,
    fetchedAt,
    anteUsdCents,
    lamports: lamportsForUsdCents(anteUsdCents, price).toString(),
  };
}

/** Evidence stored with a live wager: the price its $ minimum was checked at. */
export interface LiveMinimumQuote {
  source: SolUsdQuote["source"];
  price: string;
  fetchedAt: string;
  minUsdCents: number;
  minLamports: string;
}

/** The current lamport minimum for a live wager of `minUsdCents`. */
export async function quoteLiveMinimum(
  minUsdCents: number,
): Promise<LiveMinimumQuote> {
  const { source, price, fetchedAt } = await getSolUsdPrice();
  return {
    source,
    price,
    fetchedAt,
    minUsdCents,
    minLamports: lamportsForUsdCents(minUsdCents, price).toString(),
  };
}

async function readSolUsdPrice(): Promise<SolUsdPrice> {
  let price: string;
  let source: SolUsdQuote["source"];
  try {
    price = await fetchCoinbase();
    source = "coinbase-spot";
  } catch (error) {
    const configured = process.env.SOL_USD_REFERENCE_PRICE?.trim();
    if (!configured || !/^\d+(\.\d+)?$/.test(configured)) {
      throw new InternalError(
        "The SOL/USD price is unavailable; try again shortly",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    price = configured;
    source = "configured";
  }

  return { source, price, fetchedAt: new Date().toISOString() };
}
