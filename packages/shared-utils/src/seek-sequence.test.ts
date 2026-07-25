/**
 * Smoke tests for the package-root re-export path.
 * Full suite lives in `./file/seek-sequence.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  replaceViaSeekSequence,
  seekSequence,
  splitLinesForSeek,
} from "./seek-sequence";

describe("seekSequence (root re-export)", () => {
  it("exact match via re-export", () => {
    const r = seekSequence(splitLinesForSeek("a\nb\nc"), ["b"]);
    expect(r.hit).toEqual({ index: 1, pass: "exact", length: 1 });
  });

  it("rstrip + replaceViaSeekSequence via re-export", () => {
    const out = replaceViaSeekSequence("pre\nfoo  \npost", "foo", "bar");
    expect(out).toMatchObject({ content: "pre\nbar\npost", pass: "rstrip" });
  });

  it("ambiguous refuses via re-export", () => {
    const r = seekSequence(["x", "x"], ["x"]);
    expect(r.hit).toBeNull();
    expect(r.matchCount).toBe(2);
  });
});
