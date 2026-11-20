import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader, Panel, SectionHeading, Status } from "@/components/ui";
import {
  CHAIN_DOES_NOT_PROVE,
  CHAIN_LIMITS,
  CHAIN_PROVES,
  WALLET_BOUNDARY,
  type Guarantee,
} from "@/lib/chain-guarantees";

export const metadata: Metadata = {
  title: "What's on-chain",
  description:
    "What Solana Devnet proves about Zelto predictions, and what it does not.",
};

const DOC_URL =
  "https://github.com/aacayanan/ubc26/blob/main/docs/solana-integration.md";

function GuaranteeList({
  items,
  tone,
  word,
}: {
  items: readonly Guarantee[];
  tone: "ink" | "amber";
  word: string;
}) {
  return (
    <ul className="mt-4 grid gap-3">
      {items.map((item) => (
        <li key={item.title}>
          <Panel className="p-5">
            <Status tone={tone}>
              <span className="text-[0.9375rem] text-ink">
                <span className="sr-only">{word}: </span>
                {item.title}
              </span>
            </Status>
            <p className="t-body mt-2 pl-4 text-sm text-muted">{item.body}</p>
          </Panel>
        </li>
      ))}
    </ul>
  );
}

/**
 * F23: the honest boundary, where users and judges look. Every sentence comes
 * from lib/chain-guarantees.ts, which mirrors docs/solana-integration.md.
 */
export default function OnChainPage() {
  return (
    <div className="shell py-14 sm:py-16">
      <PageHeader
        title="What's on-chain"
        description="Zelto records each prediction and each step of a round on Solana Devnet, so some things can be checked by anyone and don't need to be taken on trust. Here is exactly which things."
      />

      <section className="mt-12">
        <SectionHeading>What anyone can check</SectionHeading>
        <GuaranteeList items={CHAIN_PROVES} tone="ink" word="Proven" />
      </section>

      <section className="mt-12">
        <SectionHeading>What you still trust us for</SectionHeading>
        <GuaranteeList
          items={CHAIN_DOES_NOT_PROVE}
          tone="amber"
          word="Not proven"
        />
      </section>

      <section className="mt-12">
        <SectionHeading>Limits</SectionHeading>
        <Panel quiet className="mt-4 p-5">
          <ul className="t-body grid list-disc gap-2 pl-5 text-sm text-muted">
            {CHAIN_LIMITS.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
            <li>{WALLET_BOUNDARY}</li>
          </ul>
        </Panel>
      </section>

      <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2">
        <Link href="/predictions" className="link t-label text-[0.625rem]">
          Verify your own predictions &rarr;
        </Link>
        <a
          href={DOC_URL}
          target="_blank"
          rel="noreferrer"
          className="link t-label text-[0.625rem]"
        >
          Technical details &rarr;
        </a>
      </div>
    </div>
  );
}
