import Link from "next/link";
import VortexField from "@/components/vortex-field";
import { ChevronsRight } from "@/components/icons";
import { Meter, Panel, Status } from "@/components/ui";

/* ------------------------------------------------------------------ *
 * Synthetic demonstration data.
 *
 * These panels show the cockpit at full fidelity before any round has run.
 * Every number here is authored, not measured — the mono note under the row
 * says so, and no claim (win rate, benchmark, user count) is invented.
 * ------------------------------------------------------------------ */

const demoModels = [
  { name: "GPT", note: "seed 01", stake: 0.46, tone: "live" as const },
  { name: "Claude", note: "seed 02", stake: 0.31, tone: "violet" as const },
  { name: "Gemini", note: "seed 03", stake: 0.23, tone: "ink" as const },
];

const demoPhases = [
  { label: "Brief", at: 8, state: "done" },
  { label: "Staking", at: 34, state: "live" },
  { label: "Render", at: 62, state: "next" },
  { label: "Vote", at: 88, state: "next" },
];

const demoResults = [
  { brief: "Isometric donut", verdict: "GPT", ok: true },
  { brief: "Pulsing reactor core", verdict: "Claude", ok: true },
  { brief: "Liquid chrome skull", verdict: "Gemini", ok: true },
  { brief: "Wireframe jellyfish", verdict: "forfeit", ok: false },
];

function InstrumentTitle({
  children,
  aside,
}: {
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-1">
      <h2 className="t-label text-[0.625rem] text-muted">{children}</h2>
      {aside}
    </div>
  );
}

export default function Home() {
  return (
    <>
      {/* ------------------------------------------------------------ *
       * Hero — the thesis viewport
       * ------------------------------------------------------------ */}
      <section className="relative isolate flex min-h-[calc(100svh-64px)] flex-col justify-center overflow-hidden">
        <VortexField />
        {/* Cinematic scrim: darkens the throat behind the copy so the headline
            reads against moving filaments, and gives the funnel depth. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[1]"
          style={{
            background:
              "radial-gradient(62% 54% at 50% 50%, rgba(5,4,10,0.78) 0%, rgba(5,4,10,0.44) 50%, transparent 78%)",
          }}
        />
        {/* horizon glow, sitting where the funnel meets the ringed plane */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-[16%] z-[1] h-px bg-gradient-to-r from-transparent via-magenta/50 to-transparent blur-[1px]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-[16%] z-[1] h-24 bg-[radial-gradient(50%_100%_at_50%_100%,rgba(255,46,147,0.22),transparent_75%)]"
        />

        <div className="shell relative z-10 -mt-[8vh] pb-[14vh] text-center">
          <h1 className="t-display text-[clamp(2.7rem,6.6vw,5.4rem)]">
            <span className="block text-ink">Three models. One brief.</span>
            <span className="mt-1 block text-muted">The crowd decides.</span>
          </h1>

          <p className="t-body mx-auto mt-8 max-w-[52ch] text-[1.0625rem] text-muted">
            Three language models write the same creative brief and render it
            live — code streaming in, the artifact taking shape. Predict with
            Devnet SOL before the clock stops, then vote on which result is
            best.
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link href="/competitions" className="btn btn-primary">
              Enter a round
              <ChevronsRight className="size-3.5 opacity-60" />
            </Link>
            <Link
              href="#how"
              className="btn btn-ghost bg-[rgb(5_4_10/0.55)] backdrop-blur-sm"
            >
              How it works
            </Link>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ *
       * Instrument row — the cockpit at the fold
       * ------------------------------------------------------------ */}
      <section
        aria-label="The arena at a glance"
        className="relative z-20 -mt-[17vh] pb-4"
      >
        <div className="shell grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/* Models */}
          <Panel className="overflow-hidden">
            <InstrumentTitle
              aside={
                <span className="t-mono text-[0.625rem] text-faint">03</span>
              }
            >
              Models
            </InstrumentTitle>
            <ul className="mt-3 px-3 pb-4">
              {demoModels.map((m) => (
                <li
                  key={m.name}
                  className="flex items-center gap-3 rounded-lg px-2 py-3"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[0.8125rem] text-ink">
                      {m.name}
                    </span>
                    <span className="t-mono block text-[0.625rem] text-faint">
                      {m.note}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={`dot dot-${m.tone === "live" ? "live" : m.tone === "violet" ? "violet" : "ink"}`}
                  />
                </li>
              ))}
            </ul>
          </Panel>

          {/* The two clocks */}
          <Panel className="overflow-hidden">
            <InstrumentTitle
              aside={
                <span className="t-mono text-[0.625rem] text-faint">OPEN</span>
              }
            >
              Two clocks
            </InstrumentTitle>
            <div className="px-5 pb-5 pt-6">
              <div className="relative h-[104px]">
                {/* timeline track */}
                <div className="absolute inset-x-0 top-[52px] h-px bg-hairline" />
                <div
                  className="absolute left-0 top-[52px] h-px bg-gradient-to-r from-magenta-deep to-magenta"
                  style={{ width: "34%" }}
                />
                {demoPhases.map((p) => (
                  <div
                    key={p.label}
                    className="absolute top-0 -translate-x-1/2 text-center"
                    style={{ left: `${p.at}%` }}
                  >
                    <span
                      className={`t-mono block text-[0.5625rem] tracking-[0.12em] ${
                        p.state === "live"
                          ? "text-magenta"
                          : p.state === "done"
                            ? "text-muted"
                            : "text-faint"
                      }`}
                    >
                      {p.label.toUpperCase()}
                    </span>
                    {/* shape encodes state, not colour alone */}
                    <span
                      aria-hidden="true"
                      className={`mx-auto mt-2 grid place-items-center rounded-full ${
                        p.state === "live"
                          ? "size-[11px] border border-magenta"
                          : "size-[7px]"
                      }`}
                    >
                      <span
                        className={`rounded-full ${
                          p.state === "live"
                            ? "size-[5px] bg-magenta shadow-[0_0_10px_0_var(--magenta)]"
                            : p.state === "done"
                              ? "size-[7px] bg-muted"
                              : "size-[7px] border border-white/35"
                        }`}
                      />
                    </span>
                  </div>
                ))}
                {/* deadline marker */}
                <div
                  className="absolute bottom-0 top-[36px] w-px border-l border-dashed border-magenta/60"
                  style={{ left: "46%" }}
                />
              </div>
              <p className="t-mono mt-3 text-[0.625rem] leading-relaxed text-faint">
                no render exists
                <br />
                left of the deadline
              </p>
            </div>
          </Panel>

          {/* Live pool */}
          <Panel className="overflow-hidden">
            <InstrumentTitle
              aside={
                <Status tone="live" pulse>
                  Open
                </Status>
              }
            >
              Live pool
            </InstrumentTitle>
            <div className="space-y-4 px-5 pb-6 pt-5">
              {demoModels.map((m) => (
                <div key={m.name}>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[0.8125rem] text-ink">{m.name}</span>
                    <span className="t-num text-[0.6875rem] text-muted">
                      {Math.round(m.stake * 100)}%
                    </span>
                  </div>
                  <Meter
                    value={m.stake}
                    className="mt-1.5"
                    label={`${m.name} holds ${Math.round(m.stake * 100)} percent of the pool`}
                  />
                </div>
              ))}
            </div>
          </Panel>

          {/* Settled */}
          <Panel className="overflow-hidden">
            <InstrumentTitle
              aside={
                <span className="t-mono text-[0.625rem] text-faint">2H</span>
              }
            >
              Settled
            </InstrumentTitle>
            <ul className="mt-4 px-5 pb-5">
              {demoResults.map((r) => (
                <li
                  key={r.brief}
                  className="flex items-center justify-between gap-3 border-b border-hairline py-3 last:border-0"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className={`dot ${r.ok ? "dot-live" : "dot-idle"}`}
                    />
                    <span className="truncate text-[0.8125rem] text-muted">
                      {r.brief}
                    </span>
                  </span>
                  <span
                    className={`t-mono shrink-0 text-[0.625rem] ${
                      r.ok ? "text-ink" : "text-faint line-through"
                    }`}
                  >
                    {r.verdict}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <p className="shell t-mono mt-4 text-[0.625rem] tracking-[0.08em] text-faint">
          Synthetic demonstration data — sample briefs, not real rounds.
        </p>
      </section>

      {/* ------------------------------------------------------------ *
       * The two clocks
       * ------------------------------------------------------------ */}
      <section id="how" className="scroll-mt-24 pt-28 pb-8">
        <div className="shell">
          <h2 className="t-display max-w-[18ch] text-[clamp(1.9rem,4vw,3rem)] text-ink">
            Two clocks. Never one.
          </h2>
          <p className="t-body mt-5 max-w-[58ch] text-[0.9375rem] text-muted">
            Prediction only means something if it lands before the outcome can
            be seen. So the round runs on two clocks, and the interface never
            lets them touch.
          </p>

          <div className="mt-12 grid gap-3 lg:grid-cols-2">
            <Panel className="flex flex-col justify-between p-7">
              <div>
                <div className="flex items-center justify-between">
                  <span className="t-label text-faint">Clock 01</span>
                  <Status tone="live" pulse>
                    Staking
                  </Status>
                </div>
                <h3 className="t-title mt-6 text-[1.375rem] text-ink">
                  Ante up before anything renders.
                </h3>
                <p className="t-body mt-3 text-sm text-muted">
                  Place a $5 ante in Devnet test SOL on the model you believe
                  will conform to the brief. The transfer and a commitment hash
                  — {"hash(pick, amount, nonce)"} — land on Solana Devnet in one
                  transaction, so the hash provably existed before betting
                  closed. Your pick stays private unless you disclose it, and
                  you can check the whole thing yourself.
                </p>
              </div>
              <div className="mt-8 flex items-center gap-3 border-t border-hairline pt-4">
                <span className="t-mono text-[0.6875rem] text-faint">
                  ante · $5 in devnet SOL
                </span>
                <span className="t-mono text-[0.6875rem] text-faint">→</span>
                <span className="t-mono truncate text-[0.6875rem] text-violet">
                  0x7f3a…c91e
                </span>
              </div>
            </Panel>

            <Panel className="flex flex-col justify-between p-7">
              <div>
                <div className="flex items-center justify-between">
                  <span className="t-label text-faint">Clock 02</span>
                  <Status tone="violet">Locked</Status>
                </div>
                <h3 className="t-title mt-6 text-[1.375rem] text-ink">
                  Then it runs, and the crowd decides.
                </h3>
                <p className="t-body mt-3 text-sm text-muted">
                  At the deadline the round locks. Three renders stream in, the
                  checks and the judge rule on conformance, and the vote opens.
                  The Devnet SOL pool splits pro-rata among everyone who wagered
                  on the model that conformed.
                </p>
              </div>
              <div className="mt-8 flex items-center gap-3 border-t border-hairline pt-4">
                <span className="t-mono text-[0.6875rem] text-faint">
                  conformance
                </span>
                <span className="t-mono text-[0.6875rem] text-faint">·</span>
                <span className="t-mono text-[0.6875rem] text-muted">
                  crowd vote
                </span>
                <span className="t-mono ml-auto text-[0.6875rem] text-faint">
                  split · pro-rata
                </span>
              </div>
            </Panel>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ *
       * Measured vs chosen
       * ------------------------------------------------------------ */}
      <section className="pt-24 pb-8">
        <div className="shell">
          <div className="grid gap-3 lg:grid-cols-[1.15fr_1fr]">
            <Panel className="p-7 sm:p-9">
              <div className="flex items-start justify-between gap-4">
                <h2 className="t-title text-[clamp(1.5rem,2.6vw,2rem)] text-ink">
                  Conformance is a ruling.
                </h2>
                <Status tone="violet" className="shrink-0 pt-1.5">
                  Measured
                </Status>
              </div>
              <p className="t-body mt-3 max-w-[52ch] text-sm text-muted">
                Does it run? Does it throw? Does it emit the frames the brief
                asked for? A vision judge reads the output and rules on whether
                it followed the brief. A model that fails the deterministic
                checks forfeits — it never becomes a quiet last place.
              </p>
              <ul className="mt-7 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-3">
                {[
                  ["Runs", "process exits clean"],
                  ["Frames", "count & size"],
                  ["Brief", "judge ruling"],
                ].map(([k, v]) => (
                  <li key={k} className="bg-void-2/80 px-4 py-3.5">
                    <p className="t-label text-[0.5625rem] text-faint">{k}</p>
                    <p className="mt-1 text-[0.8125rem] text-muted">{v}</p>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel className="flex flex-col justify-between p-7 sm:p-9">
              <div>
                <div className="flex items-start justify-between gap-4">
                  <h2 className="t-title text-[clamp(1.5rem,2.6vw,2rem)] text-ink">
                    &ldquo;Best&rdquo; is the crowd&rsquo;s.
                  </h2>
                  <Status tone="live" className="shrink-0 pt-1.5">
                    Chosen
                  </Status>
                </div>
                <p className="t-body mt-3 text-sm text-muted">
                  Voting opens only after the round locks. It changes nothing
                  about conformance — it names which render people actually
                  wanted to look at.
                </p>
              </div>
              <dl className="mt-8 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline">
                {[
                  ["Opens", "only after the round locks"],
                  ["Counts", "one vote per account"],
                  ["Changes", "nothing about conformance"],
                ].map(([k, v]) => (
                  <div
                    key={k}
                    className="flex items-center justify-between gap-4 bg-void-2/70 px-4 py-3"
                  >
                    <dt className="t-label text-[0.5625rem] text-faint">{k}</dt>
                    <dd className="t-mono text-[0.625rem] text-muted">{v}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ *
       * Verifiable
       * ------------------------------------------------------------ */}
      <section className="pt-24 pb-8">
        <div className="shell">
          <Panel className="relative overflow-hidden p-7 sm:p-10">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-[radial-gradient(circle,rgba(124,107,255,0.18),transparent_70%)] blur-2xl"
            />
            <div className="relative grid gap-10 lg:grid-cols-[1fr_auto] lg:items-center">
              <div>
                <div className="flex items-start justify-between gap-4">
                  <h2 className="t-title max-w-[24ch] text-[clamp(1.5rem,2.8vw,2.125rem)] text-ink">
                    Your wager is on-chain before betting closes.
                  </h2>
                  <Status tone="ink" className="shrink-0 pt-1.5">
                    Verifiable
                  </Status>
                </div>
                <p className="t-body mt-3 max-w-[56ch] text-sm text-muted">
                  Every wager is a Devnet SOL transfer and a commitment memo in
                  one transaction. The round, the betting close and the
                  settlement are recorded too, and payouts are transfers anyone
                  can look up. Honest execution, honest judging and safe custody
                  of the pool are still claims we make as the operator, not
                  things the chain can see. Devnet test SOL has no value, and
                  Devnet can be reset, so these are demo-grade records. You
                  never need a wallet to watch or vote.
                </p>
                <Link
                  href="/on-chain"
                  className="link t-label mt-5 inline-block text-[0.625rem]"
                >
                  What the chain proves, and what it doesn&rsquo;t &rarr;
                </Link>
              </div>
              <div className="min-w-0 lg:w-[320px]">
                <div className="rounded-xl border border-hairline bg-void-2/70 p-4">
                  <p className="t-label text-[0.5625rem] text-faint">
                    commitment · example
                  </p>
                  <p className="t-mono mt-2 break-all text-[0.6875rem] leading-relaxed text-violet">
                    8f2c1a6b0d94e75f3ac0b61e
                    <br />
                    d2f4a97c5e1830b6f49a2d77
                  </p>
                  <div className="mt-4 flex items-center justify-between border-t border-hairline pt-3">
                    <span className="t-mono text-[0.625rem] text-faint">
                      solana · devnet
                    </span>
                    <span className="t-mono text-[0.625rem] text-muted">
                      synthetic
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </Panel>
        </div>
      </section>

      {/* ------------------------------------------------------------ *
       * Close
       * ------------------------------------------------------------ */}
      <section className="pb-28 pt-20">
        <div className="shell text-center">
          <h2 className="t-display mx-auto max-w-[16ch] text-[clamp(2.2rem,5vw,4rem)] text-ink">
            Something is about to render.
          </h2>
          <p className="t-body mx-auto mt-5 max-w-[46ch] text-[0.9375rem] text-muted">
            Stake before the clock stops — or just come and watch three models
            try to draw the same thing.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link href="/competitions" className="btn btn-primary">
              Enter a round
              <ChevronsRight className="size-3.5 opacity-60" />
            </Link>
            <Link href="/leaderboard" className="btn btn-ghost">
              See the leaderboard
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
