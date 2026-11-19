/**
 * The quarantined replay document (F19) — a pure string builder, no DOM.
 *
 * The server harness (`sandbox/render/harness.mjs`) renders model code in a
 * pinned, network-less container. The viewer must see the *same* code draw the
 * *same* frames, and CLAUDE.md's rule is absolute: browser-rendered generated
 * code runs only inside an iframe with `sandbox="allow-scripts"`, never
 * `allow-same-origin`, with a CSP of `connect-src 'none'` in the document
 * itself. That gives the page an opaque origin — no access to the app origin,
 * cookies or storage — and no way to reach the network.
 *
 * Because the origin is opaque the parent cannot script this document's DOM, so
 * the only interface is `postMessage`: the parent sends `{type:'render', t}` and
 * this page draws time `t` and replies `{type:'frame'|'error'}`. The page never
 * gets app state and never sends any; it only draws.
 *
 * Kept pure and tested so the security-relevant strings (the CSP, the sandbox
 * posture, the script-escape) are asserted rather than trusted.
 */

export interface ReplayDocInput {
  /** The model's finished source. */
  source: string;
  /** Global the source is expected to define: `function drawFrame(t, ctx, canvas)`. */
  entryPoint: string;
  frameWidth: number;
  frameHeight: number;
}

/**
 * The CSP the srcdoc document declares for itself.
 *
 * `default-src 'none'` denies everything, then the two allowances the renderer
 * genuinely needs are granted back: inline `<script>` (the model code) and
 * inline styles, plus `img-src data:` so `toDataURL` previews are legal. The
 * line that matters for the security model is `connect-src 'none'`: no fetch,
 * no XHR, no WebSocket, no beacon — model code cannot phone home.
 */
export const REPLAY_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'";

/**
 * Defuse a `</script>` sequence inside model source.
 *
 * The source is inlined into a `<script>` element. A literal `</script>` in the
 * code would close the element early and let the remainder escape into HTML —
 * the classic inline-script breakout. Escaping the closing slash (`<\/script>`)
 * keeps the JavaScript meaning identical (a string or regex containing `</script>`
 * is unaffected; a stray one is not valid JS anyway) while the HTML parser no
 * longer sees a close tag.
 */
export function escapeScriptContent(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

/** The entry-point identifier, validated so it can be interpolated safely. */
function safeEntryPoint(entryPoint: string): string {
  // Entry points are programmer-chosen global function names; anything outside
  // this set cannot be a valid identifier and is rejected rather than injected.
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entryPoint) ? entryPoint : "drawFrame";
}

function safeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), 4096)
    : fallback;
}

/**
 * Build the full `srcdoc` HTML for one model's replay.
 *
 * Structure mirrors the server harness's page: a single sized canvas, error
 * listeners installed before the source, the model source inline, and a render
 * shim installed *after* the source so a solution cannot overwrite it. The shim
 * clears to black and calls `entryPoint(t, ctx, canvas)`, exactly as the harness
 * does — same contract, so what the viewer replays is what the judge scored.
 */
export function buildReplayDoc(input: ReplayDocInput): string {
  const width = safeDimension(input.frameWidth, 640);
  const height = safeDimension(input.frameHeight, 480);
  const entryPoint = safeEntryPoint(input.entryPoint);
  const source = escapeScriptContent(input.source ?? "");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${REPLAY_CSP}">
<style>
  html,body{margin:0;padding:0;background:#000;overflow:hidden;}
  canvas{display:block;max-width:100%;height:auto;}
</style>
</head>
<body>
<canvas id="c" width="${width}" height="${height}"></canvas>
<script>
  // Errors are reported to the parent, which falls back to the stored frame.
  window.__replayError = (message) => {
    try { parent.postMessage({ type: "error", message: String(message) }, "*"); } catch (e) {}
  };
  window.addEventListener("error", (e) => window.__replayError(e.message || e.error));
  window.addEventListener("unhandledrejection", (e) => window.__replayError(e.reason));
</script>
<script>
${source}
</script>
<script>
  // Installed after the source so a solution cannot clobber the draw contract.
  window.__render = (t) => {
    const canvas = document.getElementById("c");
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const fn = window["${entryPoint}"];
    if (typeof fn !== "function") {
      throw new Error("entry point ${entryPoint} is not a function");
    }
    fn(t, ctx, canvas);
  };

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "render") return;
    try {
      window.__render(Number(data.t) || 0);
      parent.postMessage({ type: "frame", t: Number(data.t) || 0 }, "*");
    } catch (error) {
      window.__replayError(error && error.message ? error.message : error);
    }
  });

  parent.postMessage({ type: "ready" }, "*");
</script>
</body>
</html>`;
}
