import { describe, expect, it } from "vitest";

import { buildReplayDoc, escapeScriptContent, REPLAY_CSP } from "./replay-doc";

/**
 * F19 quarantine builder.
 *
 * These are the security-load-bearing assertions for the replay iframe. The
 * reviewer-facing rule (CLAUDE.md) is that generated code runs only under
 * `sandbox="allow-scripts"`, never `allow-same-origin`, with a CSP of
 * `connect-src 'none'`. The builder cannot set the iframe attribute (that is the
 * component's job), but it must emit a document that is safe on its own and that
 * a script escape cannot break out of.
 */

describe("REPLAY_CSP", () => {
  it("denies everything by default and blocks the network", () => {
    expect(REPLAY_CSP).toContain("default-src 'none'");
    expect(REPLAY_CSP).toContain("connect-src 'none'");
  });

  it("only re-allows inline script/style and data images", () => {
    expect(REPLAY_CSP).toContain("script-src 'unsafe-inline'");
    expect(REPLAY_CSP).toContain("img-src data:");
    // No remote origins anywhere.
    expect(REPLAY_CSP).not.toMatch(/https?:\/\//);
  });
});

describe("escapeScriptContent", () => {
  it("neutralizes a closing script tag so the payload cannot break out", () => {
    const payload = "var x = 1;</script><script>alert(1)</script>";
    const escaped = escapeScriptContent(payload);

    // Exactly one real closing tag remains (the builder's own), and the injected
    // ones are defanged.
    expect(escaped.match(/<\/script/gi)).toBeNull();
    expect(escaped).toContain("<\\/script");
  });

  it("leaves ordinary code untouched", () => {
    const code = "function drawFrame(t, ctx, canvas) { ctx.fillRect(0,0,1,1); }";
    expect(escapeScriptContent(code)).toBe(code);
  });

  it("is case-insensitive on the closing tag", () => {
    const escaped = escapeScriptContent("</SCRIPT>");
    // No real closing tag survives, regardless of case.
    expect(escaped.match(/<\/script/gi)).toBeNull();
    expect(escaped).toContain("<\\/script");
  });
});

describe("buildReplayDoc", () => {
  const base = {
    source: "function drawFrame(t, ctx, canvas) { ctx.fillStyle = '#fff'; }",
    entryPoint: "drawFrame",
    frameWidth: 640,
    frameHeight: 480,
  };

  it("carries the CSP meta in the document head", () => {
    const html = buildReplayDoc(base);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("connect-src 'none'");
  });

  it("never references allow-same-origin", () => {
    // The iframe attribute is set by the component; the document must not smuggle
    // the phrase in a way a reviewer could mistake as a grant.
    expect(buildReplayDoc(base).toLowerCase()).not.toContain("allow-same-origin");
  });

  it("inlines the entry-point call and sizes the canvas", () => {
    const html = buildReplayDoc(base);
    expect(html).toContain('width="640"');
    expect(html).toContain('height="480"');
    expect(html).toContain('window["drawFrame"]');
  });

  it("defangs a breakout attempt in the source", () => {
    const payload = "drawFrame = 1;</script><script>parent.postMessage('pwned','*')";
    const html = buildReplayDoc({ ...base, source: payload });

    // The payload's own `</script>` must not survive in the document: if it did,
    // the inline script would close early and the rest would execute as HTML.
    expect(html).not.toContain("</script><script>");
    // It is present, but escaped.
    expect(html).toContain("<\\/script><script>");
  });

  it("rejects an invalid entry point by falling back to drawFrame", () => {
    const html = buildReplayDoc({
      ...base,
      entryPoint: "x; alert(1)",
    });
    expect(html).toContain('window["drawFrame"]');
    expect(html).not.toContain("x; alert(1)");
  });

  it("clamps a non-positive or absurd dimension", () => {
    const small = buildReplayDoc({ ...base, frameWidth: 0, frameHeight: -5 });
    expect(small).toContain('width="640"');
    expect(small).toContain('height="480"');

    const huge = buildReplayDoc({ ...base, frameWidth: 99999 });
    expect(huge).toContain('width="4096"');
  });

  it("posts ready to the parent on load", () => {
    expect(buildReplayDoc(base)).toContain('type: "ready"');
  });
});
