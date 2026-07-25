import { describe, expect, it } from "vitest";
import {
  joinLinesForSeek,
  normalizeEol,
  normalizeUnicodeLine,
  replaceViaSeekSequence,
  seekSequence,
  splitLinesForSeek,
  type SeekPass,
} from "./seek-sequence";
import golden from "./fixtures/seek-cases.json";

describe("seekSequence — exact / rstrip / trim / normalized", () => {
  it("1. exact multi-line block", () => {
    const hay = splitLinesForSeek("a\nfoo\nbar\nbaz\n");
    const pat = splitLinesForSeek("foo\nbar");
    const r = seekSequence(hay, pat);
    expect(r.hit).toEqual({ index: 1, pass: "exact", length: 2 });
    expect(r.matchCount).toBe(1);
    expect(r.passTried).toEqual(["exact"]);
  });

  it("2. rstrip: trailing spaces in file, none in pattern", () => {
    const hay = ["  x  ", "y"];
    const pat = ["  x", "y"];
    const r = seekSequence(hay, pat);
    expect(r.hit?.pass).toBe("rstrip");
    expect(r.hit?.index).toBe(0);
    expect(r.passTried).toEqual(["exact", "rstrip"]);
  });

  it("3. rstrip: trailing tabs only (ASCII space/tab)", () => {
    const hay = ["foo\t\t", "bar\t"];
    const pat = ["foo", "bar"];
    const r = seekSequence(hay, pat);
    expect(r.hit).toEqual({ index: 0, pass: "rstrip", length: 2 });
  });

  it("4. trim: leading + trailing indent drift", () => {
    const hay = ["    const a = 1;", "    const b = 2;"];
    const pat = ["const a = 1;", "const b = 2;"];
    const r = seekSequence(hay, pat);
    expect(r.hit?.pass).toBe("trim");
    expect(r.hit?.index).toBe(0);
  });

  it("5. normalized: curly double quotes → ASCII", () => {
    const file = ["say \u201Chello\u201D"];
    const pat = ['say "hello"'];
    const r = seekSequence(file, pat);
    expect(r.hit?.pass).toBe("normalized");
    expect(r.hit?.index).toBe(0);
  });

  it("6. normalized: em dash / en dash → hyphen", () => {
    const file = ["range 1\u20143"]; // em dash
    const pat = ["range 1-3"];
    const r = seekSequence(file, pat);
    expect(r.hit?.pass).toBe("normalized");
  });

  it("7. normalized: NBSP → space", () => {
    const file = ["a\u00A0b"];
    const pat = ["a b"];
    const r = seekSequence(file, pat);
    expect(r.hit?.pass).toBe("normalized");
  });

  it("8. ambiguous multi-match at exact tier refuses", () => {
    const hay = ["x", "x"];
    const pat = ["x"];
    const r = seekSequence(hay, pat);
    expect(r.hit).toBeNull();
    expect(r.matchCount).toBe(2);
    expect(r.passTried).toEqual(["exact"]);
  });

  it("9. ambiguous at trim (no exact/rstrip) refuses — no fall-through", () => {
    // Differ only by leading spaces → exact/rstrip miss; trim hits twice.
    const hay = ["  foo", "  bar", "    foo", "    bar"];
    const pat = ["foo", "bar"];
    const r = seekSequence(hay, pat);
    expect(r.hit).toBeNull();
    expect(r.matchCount).toBe(2);
    expect(r.passTried).toEqual(["exact", "rstrip", "trim"]);
  });

  it("10. pattern longer than haystack → missing", () => {
    const r = seekSequence(["one"], ["too", "many", "lines"]);
    expect(r.hit).toBeNull();
    expect(r.matchCount).toBe(0);
    expect(r.passTried).toEqual([]);
  });

  it("11. empty pattern → missing (aligned with Rust A1)", () => {
    const hay = ["a", "b"];
    const r = seekSequence(hay, [], 1);
    expect(r.hit).toBeNull();
    expect(r.matchCount).toBe(0);
    expect(r.passTried).toEqual([]);
  });

  it("12. eof anchor matches only the suffix window", () => {
    const hay = ["tail", "mid", "tail"];
    const pat = ["tail"];
    // Without eof → ambiguous
    expect(seekSequence(hay, pat, 0, false).matchCount).toBe(2);
    // With eof → only last line
    const r = seekSequence(hay, pat, 0, true);
    expect(r.hit).toEqual({ index: 2, pass: "exact", length: 1 });
  });

  it("13. no match after all four passes", () => {
    const r = seekSequence(["alpha", "beta"], ["gamma"]);
    expect(r.hit).toBeNull();
    expect(r.matchCount).toBe(0);
    expect(r.passTried).toEqual(["exact", "rstrip", "trim", "normalized"]);
  });

  it("14. startIndex skips earlier exact hit so later unique remains", () => {
    const hay = ["x", "y", "x"];
    const pat = ["x"];
    expect(seekSequence(hay, pat, 0).matchCount).toBe(2);
    const r = seekSequence(hay, pat, 1);
    expect(r.hit).toEqual({ index: 2, pass: "exact", length: 1 });
  });

  it("15. exact preferred: unique exact wins even if trim would also match", () => {
    const hay = ["foo", "  foo"];
    const pat = ["foo"];
    const r = seekSequence(hay, pat);
    expect(r.hit).toEqual({ index: 0, pass: "exact", length: 1 });
    expect(r.passTried).toEqual(["exact"]);
  });

  it("16. CRLF body splits cleanly via splitLinesForSeek", () => {
    const hay = splitLinesForSeek("a\r\nb\r\nc");
    expect(hay).toEqual(["a", "b", "c"]);
    const r = seekSequence(hay, ["b"]);
    expect(r.hit?.index).toBe(1);
  });

  it("17. normalized: curly single quotes", () => {
    const file = ["it\u2019s fine"];
    const pat = ["it's fine"];
    const r = seekSequence(file, pat);
    expect(r.hit?.pass).toBe("normalized");
  });

  it("18. start beyond feasible window → missing", () => {
    const r = seekSequence(["a", "b", "c"], ["b", "c"], 2);
    expect(r.hit).toBeNull();
    expect(r.matchCount).toBe(0);
  });

  it("19. dash + nbsp combined (Rust unicode_normalize_dash_and_nbsp)", () => {
    const r = seekSequence(["foo\u2014bar\u00A0baz"], ["foo-bar baz"]);
    expect(r.hit?.pass).toBe("normalized");
    expect(r.hit?.index).toBe(0);
  });

  it("20. ambiguous windows from start=0; unique from start=2", () => {
    const hay = ["x", "y", "x", "y"];
    const pat = ["x", "y"];
    expect(seekSequence(hay, pat, 0).hit).toBeNull();
    expect(seekSequence(hay, pat, 0).matchCount).toBe(2);
    const r = seekSequence(hay, pat, 2);
    expect(r.hit).toEqual({ index: 2, pass: "exact", length: 2 });
  });
});

describe("replaceViaSeekSequence", () => {
  it("21. rewrites unique multi-line block (exact)", () => {
    const body = "pre\nold1\nold2\npost";
    const out = replaceViaSeekSequence(body, "old1\nold2", "new1\nnew2");
    expect(out).toMatchObject({ content: "pre\nnew1\nnew2\npost", pass: "exact", index: 1 });
  });

  it("22. applies via rstrip when trailing whitespace drifts", () => {
    const body = "keep\nfoo   \nbar\t\nend";
    const out = replaceViaSeekSequence(body, "foo\nbar", "FOO\nBAR");
    expect("content" in out && out.content).toBe("keep\nFOO\nBAR\nend");
    expect("pass" in out && out.pass).toBe("rstrip");
  });

  it("23. applies via normalized quotes", () => {
    const body = "x\nsay \u201Chello\u201D\ny";
    const out = replaceViaSeekSequence(body, 'say "hello"', "say 'hi'");
    expect("content" in out && out.content).toBe("x\nsay 'hi'\ny");
    expect("pass" in out && out.pass).toBe("normalized");
  });

  it("24. ambiguous → error, no rewrite", () => {
    const out = replaceViaSeekSequence("x\nx\n", "x", "y");
    expect(out).toEqual({
      error: "ambiguous",
      matchCount: 2,
      passTried: ["exact"],
    });
  });

  it("25. missing → error", () => {
    const out = replaceViaSeekSequence("a\nb\n", "zzz", "y");
    expect(out).toMatchObject({ error: "missing", matchCount: 0 });
  });

  it("26. empty oldText rejected as missing", () => {
    const out = replaceViaSeekSequence("body", "", "tail");
    expect(out).toMatchObject({ error: "missing", matchCount: 0 });
  });

  it("27. preserves CRLF style of original body", () => {
    const body = "a\r\nold\r\nb";
    const out = replaceViaSeekSequence(body, "old", "NEW");
    expect("content" in out && out.content).toBe("a\r\nNEW\r\nb");
  });

  it("28. eof option replaces only the trailing occurrence", () => {
    const body = "tail\nmiddle\ntail";
    const out = replaceViaSeekSequence(body, "tail", "END", { eof: true });
    expect("content" in out && out.content).toBe("tail\nmiddle\nEND");
  });
});

describe("helpers", () => {
  it("normalizeEol unifies CR and CRLF", () => {
    expect(normalizeEol("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("normalizeUnicodeLine maps punctuation table (no outer trim)", () => {
    // Rust: normalize_unicode_line("\u{2018}a\u{2019} \u{2014} \u{00A0}") == "'a' -  "
    expect(normalizeUnicodeLine("\u2018a\u2019 \u2014 \u00A0")).toBe("'a' -  ");
    expect(normalizeUnicodeLine("\uFEFFx")).toBe("x");
  });

  it("joinLinesForSeek joins with chosen eol", () => {
    expect(joinLinesForSeek(["a", "b"], "\r\n")).toBe("a\r\nb");
  });
});

describe("golden fixture vectors (shared with Rust A1/A3)", () => {
  it("runs all cases", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(12);
    for (const c of golden.cases) {
      const r = seekSequence(c.haystack, c.pattern, c.startIndex ?? 0, c.eof ?? false);
      if (c.expect.kind === "hit") {
        expect(r.hit, c.id).not.toBeNull();
        expect(r.hit!.index, c.id).toBe(c.expect.index);
        expect(r.hit!.pass as SeekPass, c.id).toBe(c.expect.pass);
        expect(r.matchCount, c.id).toBe(1);
      } else if (c.expect.kind === "ambiguous") {
        expect(r.hit, c.id).toBeNull();
        expect(r.matchCount, c.id).toBeGreaterThan(1);
        if (c.expect.matchCount != null) {
          expect(r.matchCount, c.id).toBe(c.expect.matchCount);
        }
      } else {
        expect(r.hit, c.id).toBeNull();
        expect(r.matchCount, c.id).toBe(0);
      }
    }
  });
});
