---
version: 1
slug: "apps-web-app"
primary_target: "apps/web/app"
related_targets: []
---

# Surface: Zelto web app

## Scope and visitor mode

Whole web application, two route groups, one visual world.

- Persuade — `apps/web/app/(public)/page.tsx` (landing). A first-time visitor
  must understand the contest and find the way in within one viewport.
- Operate — `(public)` competitions, leaderboard, models, results, login, and
  every `(app)` route (dashboard, predictions, profile, link-wallet, error,
  not-found). Expression may never obscure the task or the state.
- Experience — the landing hero itself: the vortex is the artifact.

## Audience and job

A person watching a timed contest between three models. They do not write code
and hold no blockchain knowledge. Before the deadline they take a side; after
it, they watch and vote. They need to know, at a glance: what is open, how long
is left, what the pool looks like, and what happened last round.

## Chosen direction

**Organic cybernetic minimalism.** A premium AI-infrastructure surface that
reads as one strange living organism. Monochrome SaaS structure carries every
task; a single magenta and a single violet carry all meaning; halftone, grain
and atmospheric distortion live at the page edges; a WebGL flow-field vortex is
the one organic centerpiece.

## Memorable moment

The landing hero: fine magenta-to-violet filaments spiral into a funnel above a
ringed horizon, breathing on a slow tide, while a two-line headline sits over
the throat of the vortex. Scrolling brings it to rest. Nothing else on the page
moves without intent.

## Constraints carried in

- Dark only. No light theme.
- No wagering, deposits or payouts; points only.
- No fabricated users, win rates, testimonials or benchmarks. Empty states are
  designed, not filled.
- Full copy rewrite to the post-pivot product truth (visual briefs,
  conformance, crowd vote, parimutuel points). Retired vocabulary — accuracy,
  speed, code length — does not appear.
- Semantic HTML, keyboard parity, visible focus, `prefers-reduced-motion`.

## Unresolved

- Final three OpenRouter model IDs (never hard-coded in UI copy; read from
  config or shown as role labels).
- Solana scope (gated) and deployment host. No surface may depend on either.

## Direction contract

**THESIS:** One organism under clinical light — the page is monochrome
instrumentation, and magenta is the only thing alive in it. It refuses the
category default of neon-on-black cyberpunk with glowing text and gradient
headlines; the glow is physical, in the field, and every control stays legible
and quiet.

**OWN-WORLD:** Void ground `#05040A` lifting to `#0B0912`; ink `#F3EFF7`;
muted `#A79FB4`; hairline `rgba(255,255,255,.08)`; magenta `#FF2E93`; violet
`#7C6BFF`. Host Grotesk for display and UI; Azeret Mono for readouts, hashes,
timers, code and tracked micro-labels. Surfaces are translucent panels with a
1px hairline and an inner top highlight — glass as material, never as
decoration. Metadata is a mono text block, not a badge. Status is a filled
6px dot plus a word.

**STORY:** The visitor understands three models are about to write something
and the crowd decides; they believe the stake is sealed because the clock and
the commitment are shown as fact; they enter a round, or open the leaderboard.

**FIRST VIEWPORT:** A 64px header with hairline underline, mono tracked nav
left of a pill CTA. Below it, a full-bleed vortex: a funnel of ~90k additive
filaments rising from a ringed horizon at the lower third, magenta deep and
violet high, against near-black. Over its throat, a two-line display headline
in Host Grotesk at clamp(2.6rem, 6.4vw, 5.5rem), second line in muted ink; one
pill primary action directly beneath. At the fold, a row of four instrument
panels — Models, The two clocks, Live rounds, Settled — reading as one cockpit.

**FORM:** Pinned by the user's brief and reference; no seed roll applies. The
world is brief-pinned, so the roll's job — escaping the category default — is
already discharged by the brief itself: it names monochrome SaaS structure, not
neon-on-black.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance.
