-- F12: the hand-seeded visual brief bank.
--
-- Every brief is a JSON document consumed by `public.seed_brief()` (see
-- 20261118101500_visual_briefs.sql). Re-running this file is safe: an unchanged
-- document is a no-op, a changed one inserts the next version as a draft.
--
-- Nothing here publishes. `publish_brief()` is called by the validation script
-- (`npm run briefs:validate`) only after each reference implementation has
-- actually rendered in the sandbox — that is what makes the F12 acceptance
-- criterion "a reference implementation renders before publishing" true rather
-- than aspirational.
--
-- Reference implementations are written with `E'...'` string literals so `\n`
-- is a real newline in the stored source on every Postgres, not a literal
-- backslash-n. They take `t` (milliseconds) and draw from it, so a frame
-- depends only on time — never on wall-clock or randomness. Frames are captured
-- at `i / (frameCount - 1) * targetDurationMs`.

-- ---------------------------------------------------------------------------
-- Brief 1 — the isometric donut.
--
-- The canonical demo brief: legible in one glance, and easy to judge ("is it a
-- donut?", "does it spin?", "is it isometric?"). The reference implementation
-- draws a torus with a fixed 2:1 isometric squash and rotates the hole's angle
-- linearly over the loop.
-- ---------------------------------------------------------------------------
select public.seed_brief(jsonb_build_object(
  'slug', 'isometric-donut',
  'title', 'Isometric donut spinning in a loop',
  'prompt',
    'Render a donut (a torus seen from above) in an isometric projection, ' ||
    'spinning smoothly once around its vertical axis over the course of one ' ||
    'loop. The loop must be seamless: the last frame should flow into the ' ||
    'first. The donut should read as a solid object with a clear hole in the ' ||
    'middle, not a flat ring.',
  'style_constraints',
    'Isometric projection: circles are drawn as ellipses squashed 2:1 ' ||
    'vertically. The donut body uses exactly two flat fills — magenta ' ||
    '#FF2E93 for the lit side, violet #7C6BFF for the shaded side — with no ' ||
    'gradients, no outlines and no shadows. The background is solid void ' ||
    '#05040A. No text, no logos, no UI. The hole in the centre must stay ' ||
    'visible in every frame.',
  'entry_point', 'drawFrame',
  'target_duration_ms', 1200,
  'frame_count', 36,
  'frame_width', 320,
  'frame_height', 240,
  'starter_code',
    E'// Called once per frame. t is milliseconds within the loop.\n' ||
    E'// ctx is a 2D context, canvas is the frame canvas.\n' ||
    E'function drawFrame(t, ctx, canvas) {\n' ||
    E'  // Draw the isometric donut here.\n' ||
    E'}\n',
  'reference_impl',
    E'function drawFrame(t, ctx, canvas) {\n' ||
    E'  const w = canvas.width, h = canvas.height;\n' ||
    E'  const cx = w / 2, cy = h / 2;\n' ||
    E'  const phase = (t / 1200) * Math.PI * 2;\n' ||
    E'  ctx.fillStyle = "#05040A";\n' ||
    E'  ctx.fillRect(0, 0, w, h);\n' ||
    E'  // Outer and inner radii of the torus, in isometric (2:1) space.\n' ||
    E'  const outer = Math.min(w, h) * 0.36;\n' ||
    E'  const inner = outer * 0.42;\n' ||
    E'  const squash = 0.5;\n' ||
    E'  const lit = ["#FF2E93", "#7C6BFF"];\n' ||
    E'  // Two half-rings: the sweep rotates with the phase, which reads as spin.\n' ||
    E'  for (let side = 0; side < 2; side++) {\n' ||
    E'    const start = phase + side * Math.PI;\n' ||
    E'    ctx.beginPath();\n' ||
    E'    ctx.ellipse(cx, cy, outer, outer * squash, 0, start, start + Math.PI);\n' ||
    E'    ctx.ellipse(cx, cy, inner, inner * squash, 0, start + Math.PI, start, true);\n' ||
    E'    ctx.closePath();\n' ||
    E'    ctx.fillStyle = lit[side];\n' ||
    E'    ctx.fill();\n' ||
    E'  }\n' ||
    E'}\n',
  'deterministic_checks', jsonb_build_array(
    jsonb_build_object('kind', 'process_exit', 'expect', 0),
    jsonb_build_object('kind', 'no_uncaught_error'),
    jsonb_build_object('kind', 'frames_emitted', 'expect', 36),
    jsonb_build_object('kind', 'frame_dimensions', 'expect', '320x240'),
    jsonb_build_object('kind', 'non_blank')
  ),
  'judge_rubric', jsonb_build_array(
    jsonb_build_object('id', 'subject',
      'question', 'Does the render show a donut — a ring with a visible hole in the centre?',
      'weight', 0.4),
    jsonb_build_object('id', 'motion',
      'question', 'Does the donut rotate around its vertical axis across the frames, and does the loop close cleanly?',
      'weight', 0.3),
    jsonb_build_object('id', 'projection',
      'question', 'Is the projection isometric — circles squashed roughly 2:1 vertically rather than drawn as flat circles?',
      'weight', 0.2),
    jsonb_build_object('id', 'style',
      'question', 'Are the colours limited to magenta, violet and the void background, with no gradients, outlines, text or UI?',
      'weight', 0.1)
  )
));

-- ---------------------------------------------------------------------------
-- Brief 2 — the pulsing reactor core.
--
-- Tests the opposite skill: layered concentric motion rather than a solid body.
-- A judge can rule on "is there a core?", "does it pulse?", "is the pulse
-- periodic?" without guessing.
-- ---------------------------------------------------------------------------
select public.seed_brief(jsonb_build_object(
  'slug', 'pulsing-reactor-core',
  'title', 'Pulsing reactor core',
  'prompt',
    'Render a reactor core: a bright central sphere surrounded by two or more ' ||
    'concentric rings. The core pulses — it grows and shrinks smoothly — at a ' ||
    'constant period, completing exactly two full pulses over the loop. The ' ||
    'rings should react to the pulse, expanding outward as the core grows. The ' ||
    'loop must be seamless.',
  'style_constraints',
    'The core is magenta #FF2E93. The rings are violet #7C6BFF at reduced ' ||
    'opacity (between 0.3 and 0.8) so they layer rather than occlude. The ' ||
    'background is solid void #05040A. Additive-looking glow is allowed but ' ||
    'must come from overlapping translucent shapes, not from a blur filter. No ' ||
    'text, no logos, no UI. The core must remain centred in every frame.',
  'entry_point', 'drawFrame',
  'target_duration_ms', 1600,
  'frame_count', 32,
  'frame_width', 320,
  'frame_height', 240,
  'starter_code',
    E'// Called once per frame. t is milliseconds within the loop.\n' ||
    E'function drawFrame(t, ctx, canvas) {\n' ||
    E'  // Draw the pulsing reactor core here.\n' ||
    E'}\n',
  'reference_impl',
    E'function drawFrame(t, ctx, canvas) {\n' ||
    E'  const w = canvas.width, h = canvas.height;\n' ||
    E'  const cx = w / 2, cy = h / 2;\n' ||
    E'  // Two full pulses over the 1600 ms loop.\n' ||
    E'  const pulse = 0.5 + 0.5 * Math.sin((t / 1600) * Math.PI * 4);\n' ||
    E'  ctx.fillStyle = "#05040A";\n' ||
    E'  ctx.fillRect(0, 0, w, h);\n' ||
    E'  const base = Math.min(w, h) * 0.14;\n' ||
    E'  // Rings first, so the core sits on top of them.\n' ||
    E'  for (let i = 2; i >= 1; i--) {\n' ||
    E'    const radius = base * (1 + i * 0.9) + pulse * base * 0.6 * i;\n' ||
    E'    ctx.beginPath();\n' ||
    E'    ctx.arc(cx, cy, radius, 0, Math.PI * 2);\n' ||
    E'    ctx.strokeStyle = "rgba(124, 107, 255, " + (0.55 - i * 0.1) + ")";\n' ||
    E'    ctx.lineWidth = 2 + pulse * 2;\n' ||
    E'    ctx.stroke();\n' ||
    E'  }\n' ||
    E'  ctx.beginPath();\n' ||
    E'  ctx.arc(cx, cy, base * (0.85 + pulse * 0.35), 0, Math.PI * 2);\n' ||
    E'  ctx.fillStyle = "#FF2E93";\n' ||
    E'  ctx.fill();\n' ||
    E'}\n',
  'deterministic_checks', jsonb_build_array(
    jsonb_build_object('kind', 'process_exit', 'expect', 0),
    jsonb_build_object('kind', 'no_uncaught_error'),
    jsonb_build_object('kind', 'frames_emitted', 'expect', 32),
    jsonb_build_object('kind', 'frame_dimensions', 'expect', '320x240'),
    jsonb_build_object('kind', 'non_blank')
  ),
  'judge_rubric', jsonb_build_array(
    jsonb_build_object('id', 'subject',
      'question', 'Does the render show a distinct bright core surrounded by at least two concentric rings?',
      'weight', 0.35),
    jsonb_build_object('id', 'pulse',
      'question', 'Does the core pulse — grow and shrink smoothly — completing about two full pulses over the loop?',
      'weight', 0.35),
    jsonb_build_object('id', 'reaction',
      'question', 'Do the surrounding rings visibly react to the pulse, expanding as the core grows?',
      'weight', 0.2),
    jsonb_build_object('id', 'style',
      'question', 'Are the colours limited to magenta, violet and the void background, with no text or UI?',
      'weight', 0.1)
  )
));

-- ---------------------------------------------------------------------------
-- Brief 3 — the tunnel of light.
--
-- A depth brief: the judge must see perspective, not just motion. It also
-- exercises the "non-blank" check hardest — a naive implementation can leave
-- large dark regions, which is allowed as long as the frame is not flat.
-- ---------------------------------------------------------------------------
select public.seed_brief(jsonb_build_object(
  'slug', 'light-tunnel',
  'title', 'Flying through a tunnel of light',
  'prompt',
    'Render the view from inside a tunnel: a series of concentric shapes ' ||
    'rushing toward the viewer to create a sense of forward motion. The tunnel ' ||
    'must read as having depth — the shapes should scale up as they approach. ' ||
    'The loop must be seamless: the moment one shape flies past, the next ' ||
    'should already be entering from the centre.',
  'style_constraints',
    'Monochrome within the palette: shapes alternate between magenta #FF2E93 ' ||
    'and violet #7C6BFF. The background is solid void #05040A. Depth must be ' ||
    'conveyed by scale and position, not by a blur filter. At least three ' ||
    'shapes must be visible in every frame. No text, no logos, no UI.',
  'entry_point', 'drawFrame',
  'target_duration_ms', 1400,
  'frame_count', 28,
  'frame_width', 320,
  'frame_height', 240,
  'starter_code',
    E'// Called once per frame. t is milliseconds within the loop.\n' ||
    E'function drawFrame(t, ctx, canvas) {\n' ||
    E'  // Draw the tunnel here.\n' ||
    E'}\n',
  'reference_impl',
    E'function drawFrame(t, ctx, canvas) {\n' ||
    E'  const w = canvas.width, h = canvas.height;\n' ||
    E'  const cx = w / 2, cy = h / 2;\n' ||
    E'  ctx.fillStyle = "#05040A";\n' ||
    E'  ctx.fillRect(0, 0, w, h);\n' ||
    E'  const count = 6;\n' ||
    E'  const progress = (t / 1400) % 1;\n' ||
    E'  // Draw far-to-near so nearer shapes overlap further ones.\n' ||
    E'  for (let i = count - 1; i >= 0; i--) {\n' ||
    E'    // Each shape sits on a depth ramp; progress pushes them outward.\n' ||
    E'    const depth = ((i / count) + progress) % 1;\n' ||
    E'    const scale = Math.pow(depth, 2.2);\n' ||
    E'    const radius = scale * Math.min(w, h) * 0.9;\n' ||
    E'    if (radius < 1) continue;\n' ||
    E'    ctx.beginPath();\n' ||
    E'    ctx.arc(cx, cy, radius, 0, Math.PI * 2);\n' ||
    E'    ctx.strokeStyle = (i % 2 === 0) ? "#FF2E93" : "#7C6BFF";\n' ||
    E'    ctx.lineWidth = 1 + scale * 4;\n' ||
    E'    ctx.stroke();\n' ||
    E'  }\n' ||
    E'}\n',
  'deterministic_checks', jsonb_build_array(
    jsonb_build_object('kind', 'process_exit', 'expect', 0),
    jsonb_build_object('kind', 'no_uncaught_error'),
    jsonb_build_object('kind', 'frames_emitted', 'expect', 28),
    jsonb_build_object('kind', 'frame_dimensions', 'expect', '320x240'),
    jsonb_build_object('kind', 'non_blank')
  ),
  'judge_rubric', jsonb_build_array(
    jsonb_build_object('id', 'subject',
      'question', 'Does the render read as a tunnel — concentric shapes centred on the frame?',
      'weight', 0.3),
    jsonb_build_object('id', 'depth',
      'question', 'Do the shapes scale up as they approach, conveying forward motion rather than a flat animation?',
      'weight', 0.35),
    jsonb_build_object('id', 'continuity',
      'question', 'Is at least three shapes visible in every frame, with a new one entering as another passes?',
      'weight', 0.25),
    jsonb_build_object('id', 'style',
      'question', 'Are the colours limited to magenta, violet and the void background, with no text or UI?',
      'weight', 0.1)
  )
));
