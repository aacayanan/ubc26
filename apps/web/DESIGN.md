---
name: Zelto
description: Organic cybernetic minimalism — monochrome instrumentation lit by one magenta and one violet, with a living WebGL flow-field at its heart.
colors:
  void: "#05040a"
  void-lift: "#0b0912"
  void-raised: "#12101c"
  ink: "#f3eff7"
  muted: "#a79fb4"
  faint: "#8a8297"
  magenta: "#ff2e93"
  magenta-deep: "#b30e63"
  violet: "#7c6bff"
  amber: "#e0a45e"
  hairline: "rgba(255,255,255,0.08)"
  hairline-strong: "rgba(255,255,255,0.14)"
typography:
  display:
    fontFamily: "Host Grotesk, system-ui, sans-serif"
    fontSize: "clamp(2.7rem, 6.6vw, 5.4rem)"
    fontWeight: 300
    lineHeight: 0.98
    letterSpacing: "-0.038em"
  headline:
    fontFamily: "Host Grotesk, system-ui, sans-serif"
    fontSize: "clamp(1.9rem, 3.6vw, 2.5rem)"
    fontWeight: 400
    lineHeight: 1.06
    letterSpacing: "-0.028em"
  body:
    fontFamily: "Host Grotesk, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.68
    letterSpacing: "normal"
  label:
    fontFamily: "Azeret Mono, ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.2em"
  mono:
    fontFamily: "Azeret Mono, ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.02em"
rounded:
  panel: "18px"
  tile: "12px"
  control: "10px"
  pill: "999px"
spacing:
  gutter: "20px"
  gutter-wide: "32px"
  grid-gap: "12px"
  panel-pad: "20px"
  section: "96px"
  header: "64px"
components:
  button-primary:
    backgroundColor: "rgba(255,255,255,0.03)"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0.72rem 1.4rem"
    typography: "{typography.body}"
  button-primary-hover:
    backgroundColor: "rgba(255,255,255,0.07)"
  button-solid:
    backgroundColor: "{colors.ink}"
    textColor: "#0a070d"
    rounded: "{rounded.pill}"
    padding: "0.72rem 1.4rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "0.72rem 1.4rem"
  field:
    backgroundColor: "rgba(255,255,255,0.02)"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0.68rem 0.85rem"
  panel:
    backgroundColor: "rgba(255,255,255,0.03)"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel-pad}"
  nav-link:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
---

# Design System: Zelto

## Overview

**Creative North Star: "One Organism Under Clinical Light"**

The whole application is a single instrument: near-black ground, hairline geometry, and a monochrome structure that carries every task without decoration. Meaning is not distributed across a rainbow; it is concentrated — one magenta for what is live, one violet for what is locked or verified, and nothing else competing. The page should read as a precision cockpit that happens to be alive, not as a decorated dashboard.

The "alive" comes from material and field, never from UI chrome. A WebGL flow-field vortex is the only organic object; halftone dot screens, a fine film grain and a vignette sit at the edges of the frame like the room the interface occupies. Surfaces are translucent glass with a one-pixel hairline and an inner top highlight — material you could touch, not a glowing card. Display type is Host Grotesk set light and tight; Azeret Mono does every readout, label, hash and timer, so metadata looks measured rather than merchandised.

The world explicitly refuses the category default of neon-on-black cyberpunk: no glowing headlines, no gradient-filled text, no rainbow accent spray. Glow exists physically in the vortex, the status dot and the thin meters. Every control stays quiet, legible and monochrome until a dot or a meter tells you what state you are in.

**Key Characteristics:**

- Dark only; void ground with hairline-separated translucent glass.
- Two accents only: magenta (#ff2e93) alive, violet (#7c6bff) locked/verifiable; amber (#e0a45e) reserved for account warning states.
- Halftone, grain and vignette at the page edges; one WebGL vortex as the organic centerpiece.
- Host Grotesk display and UI; Azeret Mono for readouts, hashes, timers and tracked micro-labels.
- Status is a 6px dot plus a word; depth is glass and hairline, not drop-shadow stacking.
- Motion is slow, easing-out, and resolves to a composed still under reduced motion.

## Colors

A near-black instrument panel carrying exactly two meaningful accents, with a third reserved for account warnings.

### Primary

- **Arena Magenta** (#ff2e93): the color of what is alive — staking-open status, live pulse rings, meter fill, hero bloom, selection tint, focus underline on active nav. Also used deep as `magenta-deep` (#b30e63) at the base of meters and timeline progress, and as the low-alpha scrim colors in the vortex fallback.
- **Commitment Violet** (#7c6bff): the color of what is locked, measured, verifiable or in-flight — locked/running/judging status dots, conformance readouts, hashes, the focus ring, and the cool end of the meter gradient.
- **Warning Amber** (#e0a45e): account-state warnings only (no wallet, practice mode, profile unavailable). It never encodes round state. The direction contract named two accents; the build adds amber, and the build wins — it is a semantic exception, not a third brand color.

### Neutral

- **Void** (#05040a / oklch equivalent): page ground, header backdrop base, vignette color.
- **Void Lift** (#0b0912): the lifted ground used inside tiles and as the gradient bottom of the page.
- **Void Raised** (#12101c): inset tile and table-cell fills where a slightly lifted patch is needed.
- **Instrument Ink** (#f3eff7): primary text, solid button fill, dot-ink status, hero headline first line.
- **Muted Instrument** (#a79fb4): body copy, descriptions, secondary labels, nav at rest.
- **Faint Instrument** (#8a8297): micro-labels, timestamps, notes, placeholder text, idle readouts.
- **Hairline** (rgba(255,255,255,0.08)): every panel border, divider, table rule and header underline. A stronger hairline (rgba(255,255,255,0.14)) exists for hover and emphasized boundaries; form controls use a third step (rgba(255,255,255,0.30)) to hit 3:1 against their own fill.

### Named Rules

**The Two Accents Rule.** Magenta and violet are the only chromatic voices on the page. If a new element needs a third hue, it is wrong; reuse a dot, a weight change or a hairline instead.

**The Amber Exception Rule.** Amber appears only on account-state warnings (missing wallet, practice mode, missing profile). It never marks a round's state and never decorates.

**The Ground Rule.** There is no light theme. Backgrounds are void-to-void-lift gradients, and no surface may sit lighter than a 4.2%-white glass fill over them.

## Typography

**Display Font:** Host Grotesk (with system-ui, sans-serif)
**Body Font:** Host Grotesk (with system-ui, sans-serif)
**Label/Mono Font:** Azeret Mono (with ui-monospace, monospace)

**Character:** A light, tightly tracked grotesk gives the product its clinical confidence; Azeret Mono supplies the instrument readings. The pairing reads as a lab console, not a marketing site — display type is soft-spoken, mono type is precise.

### Hierarchy

- **Display** (300, clamp(2.7rem, 6.6vw, 5.4rem), 0.98, -0.038em): landing hero, closing statement, 404 and error headlines. Always balanced (`text-wrap: balance`), never gradient-filled. The second line of the hero is set in muted, not ink.
- **Headline / Page Title** (400, clamp(1.9rem, 3.6vw, 2.5rem), 1.06, -0.028em): page headers ("Rounds", "Leaderboard", "Models") and in-panel section titles.
- **Title** (400, 1.0625rem–1.375rem, 1.06): card titles, dashboard greeting, subsection headings.
- **Body** (400, 0.875–0.9375rem, 1.68, Host Grotesk): descriptions and prose; held to roughly 42–62ch (`max-w-[52ch]`…`[62ch]`), with `text-wrap: pretty`.
- **Label** (400, 0.6875rem, 1.4, 0.2em, uppercase, Azeret Mono): table headers, field labels, readout captions, instrument-panel titles. Micro contexts drop to 0.5625–0.625rem while keeping the tracking; some labels add tracking to 0.24em.
- **Mono / Numeral** (Azeret Mono, 0.625–0.6875rem, 0.02em): timestamps, hashes, seed notes, model names in metadata, and tabular numerals via `.t-num` (tabular-nums, -0.01em).

### Named Rules

**The Instrument Label Rule.** Metadata is set in uppercase Azeret Mono at 0.14em or more of tracking. It is a text block, not a badge, chip or colored pill.

**The Readout Rule.** Any number that a person compares — points, stakes, percentages, counts — uses tabular numerals. Prose never gets monospaced; numerals never get proportional.

## Layout

The page is one centered shell (`max-width: 1180px`, 20px side padding, 32px from 640px up) over a fixed atmospheric field. A 64px sticky header with a hairline underline carries the logo, centered mono nav and a pill account action; below `sm` the nav collapses to a centered dropdown panel and the header reduces to logo + action.

The landing hero is `min-h-[calc(100svh-64px)]`, fully full-bleed, with the copy block lifted `-8vh` over the vortex throat and the four-panel cockpit row overlapped upward (`-17vh`) so it reads as part of the fold rather than a new section. The cockpit is one column on mobile, two at `sm`, four at `lg`, with a 12px gap; every panel is equal-height.

Interior routes use `shell py-14 sm:py-16`, then a `PageHeader` (title left, actions right, wrapping) followed by a 40px gap into content. Sections separate at `pt-24`/`pt-28` (96–112px) with 12px card gaps; hero copy is centered and constrained to 52ch, page descriptions to 62ch. Two-column layouts (`lg:grid-cols-[1.15fr_1fr]`, split login at `lg:grid-cols-[1.05fr_1fr]`) never collapse into cramped side-by-sides — they stack below `lg`. Tables hide secondary columns below `sm`; card groups switch 1→2 columns at `sm` and 2→4 in the cockpit at `lg`.

The `divider-hatch` (a 1px dashed-line pattern of 6px hairline runs) is the only decorative rule; section separators elsewhere are plain 1px hairlines.

## Elevation & Depth

Depth is material, not shadow stacking. The canonical `.panel` is a translucent slab: a 180° white gradient from 4.2% to 1.2% alpha, a 1px hairline border, a 1px inner top highlight (white at 6%), an 18px backdrop blur with 125% saturation, and one deep ambient drop (0 28px 70px -34px near-black) that separates it from the void. The drop is what the glass casts, never a lifted-card effect. `.panel-quiet` removes the gradient, highlight and drop entirely, leaving a 1.8%-white fill and a hairline; `.panel-interactive` changes only border color, fill and nothing else on hover.

There is no stacking of shadows, no hover lift, no colored card glows. Colored light is a field (bloom, vortex) or a source (the meter gradient), not a surface effect. No zero-offset coloured halos: the status dot is a plain filled dot and `btn-solid:hover` carries no ring.

### Shadow Vocabulary

- **Panel ambient** (`box-shadow: inset 0 1px 0 0 rgb(255 255 255 / 0.06), 0 28px 70px -34px rgb(0 0 0 / 0.95)`): the only surface shadow; belongs to `.panel`.
- **Dot glow** (`box-shadow: 0 0 10px -1px var(--dot)`): status dots only; idle dots switch it off.
- **Solid-button hover ring** (`box-shadow: 0 0 0 1px rgb(255 46 147 / 0.35)`): the single magenta edge allowed on a control.
- **Focus ring** (`outline: 2px solid var(--violet); outline-offset: 3px`): global `:focus-visible`, never removed.

### Named Rules

**The Glass-Is-Material Rule.** Glass is a material, not decoration: use the full panel recipe for content surfaces, `panel-quiet` for informational strips and empty states, and never fake a glass look with blur alone.

**The One-Shadow Rule.** A surface gets the panel ambient or no shadow. No stacked shadows, no offset hard shadows, no glow around cards.

## Shapes

Panels are softly rounded at 18px — large enough to feel like a machined aperture, small enough to stay technical. Nested tiles and grouped data use 12px; inputs use 10px; buttons, dots, meters, avatars and pills use fully rounded 999px. Borders are always 1px hairline; there are no 2px frames and no filled color blocks as borders.

The signature geometry is concentric and radial: the vortex funnel and its 30 ringed horizon bands, the `CrosshairMark` (a thin circle, crosshair ticks and a dashed outer ring), the 6px status dot with its breathing ring, and the 3px meter. Dividers are hairline rules or the dashed `divider-hatch`. Icons are authored 1.3px-stroke SVGs (logo bars, Solana mark, crosshair, chevron / double-chevron / arrow in `components/icons.tsx`), never icon fonts or unicode glyphs.

## Components

### Buttons

- **Shape:** pill (999px), 0.8125rem, weight 500, 0.02em tracking, padding `0.72rem 1.4rem` (`btn-sm`: 0.75rem / 0.5rem 0.95rem).
- **Primary (outlined):** ink text on a 3%-white fill with a 22%-white border and an inner top highlight — the landing and header CTA. Hover raises border to 40% white and fill to 7%; active to 10%.
- **Solid:** ink fill with near-black (`#0a070d`) text, used for form submits and the one decisive action; hover goes white with the magenta 1px edge.
- **Ghost:** muted text, transparent fill, hairline border; hover turns ink text with a stronger hairline. `btn-block` spans the form width; disabled drops to 45% opacity.
- **Hover / Focus:** color/background/border transitions at 220ms with the world ease; focus uses the global violet ring, not a button-specific glow.

### Cards / Containers

- **Corner Style:** 18px panel radius.
- **Background:** glass gradient over the void, or a flat 1.8%-white quiet fill.
- **Shadow Strategy:** one ambient panel shadow; quiet and interactive cards do not add any.
- **Border:** 1px hairline; hover/interactive strengthens to the 14%-white hairline.
- **Internal Padding:** 20px instrument titles, 20–28px panel bodies, 28–40px for statement panels; 14px for empty states.

### Inputs / Fields

- **Style:** 10px radius, 2%-white fill, 1px `rgba(255,255,255,0.30)` control boundary (3:1 minimum), 0.875rem ink text, faint placeholder.
- **Focus:** violet border plus a 1px violet shadow ring, and the fill lifts to 3.5%; hover strengthens the boundary before focus.
- **Error / Disabled:** errors are a magenta-tinted inline strip (magenta text on magenta 7% fill, 30% border), notices use violet the same way; disabled controls inherit the 45% opacity rule.

### Status

- **Style:** a 6px filled dot (with a 10px -1px glow) followed by an uppercase Azeret Mono word at 0.14em tracking, `muted` text, never a filled chip.
- **Tones:** live = magenta, violet = locked/in-flight, ink = settled/verifiable, amber = account warning, idle = 22%-white with no glow. `dot-pulse` adds a 3.2s expanding hairline ring.
- **State mapping:** `OPEN → live ("Staking open")`, `LOCKED/RUNNING/EVALUATING → violet ("Locked"/"Rendering"/"Judging")`, `SETTLED → ink ("Settled")`, everything else idle.

### Meter

- **Style:** a 3px track at 8%-white with a full-round fill; the fill is a 90° gradient from magenta-deep through magenta at 62% to violet. Always paired with an accessible label; the number beside it uses tabular mono.

### Readout

- **Style:** a faint uppercase mono caption over a 1.375rem tabular numeral, optional muted mono suffix. The dashboard instrument strip is four readouts separated by 1px hairline gutters in one glass slab — the atom of the cockpit.

### Navigation

- **Style:** sticky 64px header, `rgba(5,4,10,0.72)` with `backdrop-blur-xl`, hairline underline. Nav links are uppercase Azeret Mono labels, muted at rest, ink when active, with a 4px magenta dot beneath the active item. The logo mark is two slanted gradient bars, the second deliberately out of register.
- **Mobile:** hamburger under `sm`; the menu is a full-width dark panel with block links, each prefixed by a live/idle dot when active.

### Empty State

- **Style:** a quiet panel centered at 46rem, with a 40px `CrosshairMark`, a medium ink sentence, a 46ch muted explanation and an optional ghost action. Empty states are composed, never a shrug; synthetic data rows carry an explicit mono provenance note.

### Signature: The Vortex Field

- **Technique:** three.js `WebGLRenderer` (alpha, antialias on, DPR clamped to 2) running **three passes over one shared analytic field**, all on the GPU — no CPU simulation, no per-frame allocation. (1) _Dust_: 74,000 points + 18,000 ledger points in one `BufferGeometry` (`aSeed` + `aKind`), a radial dot fragment shader keeping each round. (2) _Filaments_: a `LineSegments` pass of 96 drawn arcs × 96 segments tracing the funnel skeleton, plus 40 ring outlines × 128 segments on the ground plane. (3) _Confirmation pulses_: 9,000 points whose radius expands over time, radiating outward from the throat across the plane. One GLSL `funnelPoint()` derives every pass, so arcs and dust never drift apart: 96 strands with per-strand radius (`0.74 + 0.38·seed`) and twist (`4.6 + 4.8·seed`), a depth fade, and an additive blend with no depth test/write.
- **Narrative:** the field is the product's mechanism, not decoration. Dots stream _inward_ from the wide mouth and brighten as they reach the throat (commitments being sealed); three strand hues — magenta, violet and pale ink — carry the three models feeding one arena; expanding rings run _outward_ across the ground plane (confirmations propagating). The motion reads hero → core → plaza.

### Atmosphere (signature layer)

- **Layers:** a fixed, pointer-events-free stack — magenta bloom (120vw × 90vh, 10% magenta, 30px blur), two masked halftone dot fields (5px grid, 1.05px magenta dots fading from opposite corners at 34% and 26%), film grain at 5% in `overlay`, and a vignette plus top scrim. Quiet routes drop the bloom to 40% and halftone to 20%/14%.
- **Grain asset:** `public/texture/grain.png`, 160×160 px, 34.9 KB, per-pixel white noise generated once; composited at `mix-blend-mode: overlay` and 0.05 opacity so true blacks stay black and gradient steps dither instead of lifting the void.

### Motion

- **Grammar:** one ease, `cubic-bezier(0.16, 1, 0.3, 1)`; entrances `rise` 720ms from 14px below with fade; state transitions 200–240ms; halftone is static, only the vortex and the status pulse breathe. Nothing moves without intent.
- **Reduced motion:** a global media query collapses every animation and transition to 0.001ms and disables `.rise`; the vortex renders one still frame. Motion is never the only carrier of state.

## Do's and Don'ts

### Do:

- **Do** keep magenta and violet as the only chromatic accents, and let amber appear only on account warnings.
- **Do** express status as a 6px dot plus an uppercase mono word, with shape and word carrying the meaning.
- **Do** build surfaces from the glass recipe: 1px hairline, inner top highlight, 4.2→1.2%-white gradient, 18px radius, one ambient drop.
- **Do** set every number a person compares in tabular Azeret Mono, and every label in uppercase tracked mono at 0.14em or more.
- **Do** keep the atmosphere at the frame edges and behind the hero; body copy never sits on an unmasked halftone field.
- **Do** keep focus visible with the global 2px violet ring at 3px offset on every interactive element.
- **Do** resolve all motion to a composed still under `prefers-reduced-motion`, including the vortex.

### Don't:

- **Don't** introduce a light theme, a third accent, gradient-filled text or glowing headlines.
- **Don't** turn a status into a filled neon chip, badge or colored pill.
- **Don't** stack shadows, offset hard shadows, or add hover lift to cards.
- **Don't** replace glass with blur alone or add colored card glows; colored light belongs to fields and dots.
- **Don't** use monospace for prose or proportional figures for readouts.
- **Don't** let a decorative micro-label stand in for real state; metadata labels carry information, not ornament.
