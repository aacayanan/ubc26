import { describe, expect, it } from "vitest";
import { parseRenderRecord } from "@/lib/server/integrations/docker/render-sandbox";

function record(frames: unknown[] = []): string {
  return JSON.stringify({
    t: "render",
    protocol: 1,
    ok: true,
    error: null,
    pageError: null,
    frames,
  });
}

const FRAME = {
  index: 0,
  png: "iVBORw0KGgo=",
  blank: false,
  distinctColors: 9,
  width: 320,
  height: 240,
};

describe("parseRenderRecord", () => {
  it("parses a well-formed record", () => {
    const parsed = parseRenderRecord(record([FRAME]));
    expect(parsed).not.toBeNull();
    expect(parsed?.ok).toBe(true);
    expect(parsed?.frames).toHaveLength(1);
  });

  it("returns null for empty output", () => {
    expect(parseRenderRecord("")).toBeNull();
  });

  it("returns null when only a partial line arrived", () => {
    // A container killed mid-write leaves a truncated line; that is not a
    // result and must not be read as an empty frame set.
    expect(parseRenderRecord('{"t":"render","protocol":1,"ok":tr')).toBeNull();
  });

  it("skips non-record noise and finds the record", () => {
    const raw = `some browser warning\n${record([FRAME])}\n`;
    expect(parseRenderRecord(raw)?.frames).toHaveLength(1);
  });

  it("rejects a record with the wrong protocol version", () => {
    const raw = JSON.stringify({
      t: "render",
      protocol: 2,
      ok: true,
      error: null,
      pageError: null,
      frames: [],
    });
    expect(parseRenderRecord(raw)).toBeNull();
  });

  it("rejects a record whose frame is malformed", () => {
    const raw = record([{ index: 0, png: "x" }]);
    expect(parseRenderRecord(raw)).toBeNull();
  });

  it("keeps a failed run's record — ok:false is a result, not noise", () => {
    const raw = JSON.stringify({
      t: "render",
      protocol: 1,
      ok: false,
      error: "bad entry point",
      pageError: null,
      frames: [],
    });
    const parsed = parseRenderRecord(raw);
    expect(parsed?.ok).toBe(false);
    expect(parsed?.error).toBe("bad entry point");
  });
});
