/**
 * Render harness (F12/F14): run one visual brief's code in a headless browser
 * and emit every frame as PNG.
 *
 * Runs inside the render sandbox image, never in the app process. The job
 * arrives on stdin; one NDJSON record leaves on stdout. Frames are captured at
 * explicit time steps — `i / (n - 1) * durationMs` — so the same code yields
 * the same frames regardless of how fast the host machine is.
 *
 * This process is trusted. The code it renders is not: it runs in a page with
 * no network, no storage and no access to this process. The page is built from
 * a string with the source injected, so a solution cannot fetch, navigate or
 * reach a same-origin document.
 *
 * It reports observations only. Whether a frame is *good* is the host's call
 * (F14); `blank` and the measured dimensions here are cheap measured facts, not
 * verdicts. The host compares the measured size against the brief, so a
 * solution that resizes the canvas cannot slip past the dimension check.
 */

import { createRequire } from "node:module";

// Resolved from the image's own node_modules, not the repo's.
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_SOURCE_CHARS = 256 * 1024;
const MAX_FRAMES = 600;
const MAX_DIMENSION = 1920;
const DEFAULT_FRAME_TIMEOUT_MS = 10_000;

function fail(error) {
  process.stdout.write(
    JSON.stringify({
      t: "render",
      protocol: 1,
      ok: false,
      error: String(error),
      pageError: null,
      frames: [],
    }) + "\n",
  );
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        reject(new Error("job exceeds the size limit"));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8")),
    );
    process.stdin.on("error", reject);
  });
}

/** Validate the job. Anything malformed fails the run, never a frame. */
function parseJob(raw) {
  const job = JSON.parse(raw);

  if (job.protocol !== 1) throw new Error("protocol mismatch");
  if (typeof job.source !== "string" || job.source.length === 0) {
    throw new Error("missing source");
  }
  if (job.source.length > MAX_SOURCE_CHARS) throw new Error("source too large");
  if (
    typeof job.entryPoint !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(job.entryPoint)
  ) {
    throw new Error("bad entry point");
  }

  const frameCount = Number(job.frameCount);
  const frameWidth = Number(job.frameWidth);
  const frameHeight = Number(job.frameHeight);
  const targetDurationMs = Number(job.targetDurationMs);

  if (
    !Number.isInteger(frameCount) ||
    frameCount < 1 ||
    frameCount > MAX_FRAMES
  ) {
    throw new Error("bad frame count");
  }
  for (const [name, value] of [
    ["frame width", frameWidth],
    ["frame height", frameHeight],
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
      throw new Error(`bad ${name}`);
    }
  }
  if (!Number.isFinite(targetDurationMs) || targetDurationMs <= 0) {
    throw new Error("bad target duration");
  }

  const frameTimeoutMs =
    Number.isFinite(Number(job.frameTimeoutMs)) &&
    Number(job.frameTimeoutMs) > 0
      ? Math.min(Number(job.frameTimeoutMs), DEFAULT_FRAME_TIMEOUT_MS)
      : DEFAULT_FRAME_TIMEOUT_MS;

  return {
    source: job.source,
    entryPoint: job.entryPoint,
    frameCount,
    frameWidth,
    frameHeight,
    targetDurationMs,
    frameTimeoutMs,
  };
}

/**
 * The page. One canvas, a deterministic clock, and the model's source.
 *
 * `drawFrame` is expected to be a global function. Calling it with (t, ctx,
 * canvas) and letting it own all drawing means the harness never has to know
 * what the brief looks like.
 */
function buildHtml(job) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#000;}
  canvas{display:block;}
</style></head>
<body>
<canvas id="c" width="${job.frameWidth}" height="${job.frameHeight}"></canvas>
<script>
  window.__errors = [];
  window.addEventListener("error", (e) => window.__errors.push(String(e.message || e.error)));
  window.addEventListener("unhandledrejection", (e) => window.__errors.push(String(e.reason)));
</script>
<script>
${job.source}
</script>
<script>
  // Installed after the source so a solution cannot overwrite it.
  window.__renderFrame = (t) => {
    const canvas = document.getElementById("c");
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const fn = window["${job.entryPoint}"];
    if (typeof fn !== "function") {
      throw new Error("entry point ${job.entryPoint} is not a function");
    }
    fn(t, ctx, canvas);
    // Report the size the solution actually left the canvas at, not the size
    // it was given: resizing is the one way a solution could dodge the
    // frame_dimensions check.
    return {
      png: canvas.toDataURL("image/png"),
      width: canvas.width,
      height: canvas.height,
    };
  };

  // Sampled from a downscaled copy: a full-frame pixel scan per frame is slow
  // and a flat-colour render is what the non_blank check is really about.
  window.__frameStats = () => {
    const canvas = document.getElementById("c");
    const sample = document.createElement("canvas");
    sample.width = 32; sample.height = 32;
    const sctx = sample.getContext("2d", { alpha: false });
    sctx.drawImage(canvas, 0, 0, 32, 32);
    const { data } = sctx.getImageData(0, 0, 32, 32);
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4) {
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
    return { distinctColors: seen.size, blank: seen.size <= 1 };
  };
</script>
</body>
</html>`;
}

async function main() {
  let job;
  try {
    job = parseJob(await readStdin());
  } catch (error) {
    fail(error instanceof Error ? error.message : error);
    return 1;
  }

  const browser = await chromium.launch({
    headless: true,
    // The container already has no network and no writable rootfs; these are
    // the flags that stop Chromium from needing a writable /dev/shm or a
    // sandbox namespace the container cannot provide.
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--force-color-profile=srgb",
      "--force-device-scale-factor=1",
    ],
  });

  try {
    const page = await browser.newPage({
      viewport: { width: job.frameWidth, height: job.frameHeight },
      deviceScaleFactor: 1,
      // Never let a page settle on wall-clock time; the harness drives time.
      reducedMotion: "reduce",
    });

    // No network at the container level, and this makes the page agree: any
    // request aborts instead of hanging on a connection that cannot exist.
    await page.route("**/*", (route) => route.abort());

    await page.setContent(buildHtml(job), { waitUntil: "load" });

    const frames = [];
    for (let index = 0; index < job.frameCount; index += 1) {
      const t =
        job.frameCount === 1
          ? 0
          : (index / (job.frameCount - 1)) * job.targetDurationMs;

      const drawn = await page.evaluate(
        ({ time }) => window.__renderFrame(time),
        { time: t },
      );
      const stats = await page.evaluate(() => window.__frameStats());

      frames.push({
        index,
        png: drawn.png.slice(drawn.png.indexOf(",") + 1),
        blank: stats.blank,
        distinctColors: stats.distinctColors,
        width: drawn.width,
        height: drawn.height,
      });
    }

    const pageError = await page.evaluate(() =>
      window.__errors.length > 0 ? window.__errors[0] : null,
    );

    process.stdout.write(
      JSON.stringify({
        t: "render",
        protocol: 1,
        ok: true,
        error: null,
        pageError,
        frames,
      }) + "\n",
    );
    return 0;
  } catch (error) {
    fail(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    fail(error instanceof Error ? error.message : error);
    process.exit(1);
  });
