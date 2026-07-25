/**
 * Deterministic 4-pass hunk locator for LLM edit / Accept (mutation locator).
 *
 * Passes (escalating permissiveness): exact → rstrip → trim → normalized (unicode).
 * Unique match only: multi-match at a tier is ambiguous (do not apply; do not fall through).
 * No Levenshtein / edit-distance silent hits.
 *
 * Orthogonal to Myers DiffEngine (display only). Pure functions; no I/O.
 *
 * Mirrors `crates/conex-diff/src/seek_sequence.rs` (A1) for fixture parity.
 */

/** Pass names (TS). Rust `SeekPass::UnicodeNormalize` ↔ `'normalized'`. */
export type SeekPass = "exact" | "rstrip" | "trim" | "normalized";

/** Successful unique hit at a single pass. */
export interface SeekHit {
  /** 0-based line index where the pattern starts in the haystack. */
  index: number;
  pass: SeekPass;
  /** Number of haystack lines consumed by the match (pattern length). */
  length: number;
}

/** Alias kept for callers that already use SeekSequenceHit. */
export type SeekSequenceHit = SeekHit;

export interface SeekSequenceResult {
  hit: SeekHit | null;
  /**
   * Matches found at the decisive pass:
   * - 0 → missing after all passes (or empty/too-long pattern)
   * - 1 → unique hit
   * - >1 → ambiguous at that pass (hit is null)
   */
  matchCount: number;
  /** Passes attempted in order until a unique or ambiguous result. */
  passTried: SeekPass[];
}

export type ReplaceViaSeekError = "missing" | "ambiguous";

export type ReplaceViaSeekResult =
  | { content: string; pass: SeekPass; index: number }
  | { error: ReplaceViaSeekError; matchCount: number; passTried: SeekPass[] };

const PASSES: readonly SeekPass[] = ["exact", "rstrip", "trim", "normalized"] as const;

/**
 * Normalize CR/LF variants to `\n` for stable line splits / string compares.
 * Does not alter non-EOL content.
 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Unicode punctuation / odd-space → ASCII for pass 4.
 * Mirrors Rust `normalize_unicode_line` (no outer trim — caller trims first).
 */
export function normalizeUnicodeLine(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    // Various dash / hyphen code-points → ASCII '-'
    if (
      c === 0x2010 || // hyphen
      c === 0x2011 || // non-breaking hyphen
      c === 0x2012 || // figure dash
      c === 0x2013 || // en dash
      c === 0x2014 || // em dash
      c === 0x2015 || // horizontal bar
      c === 0x2212 || // minus sign
      c === 0xfe58 || // small em dash
      c === 0xfe63 || // small hyphen-minus
      c === 0xff0d // fullwidth hyphen-minus
    ) {
      out += "-";
      continue;
    }
    // Fancy single quotes / primes → '
    if (
      c === 0x2018 || // left single
      c === 0x2019 || // right single
      c === 0x201a || // single low-9
      c === 0x201b || // single high-reversed-9
      c === 0x2032 || // prime
      c === 0x2035 // reversed prime
    ) {
      out += "'";
      continue;
    }
    // Fancy double quotes / double primes → "
    if (
      c === 0x201c || // left double
      c === 0x201d || // right double
      c === 0x201e || // double low-9
      c === 0x201f || // double high-reversed-9
      c === 0x2033 || // double prime
      c === 0x2036 // reversed double prime
    ) {
      out += '"';
      continue;
    }
    // Non-breaking / odd spaces → normal space
    if (
      c === 0x00a0 || // NBSP
      c === 0x2000 || // en quad
      c === 0x2001 || // em quad
      c === 0x2002 || // en space
      c === 0x2003 || // em space
      c === 0x2004 || // three-per-em
      c === 0x2005 || // four-per-em
      c === 0x2006 || // six-per-em
      c === 0x2007 || // figure space
      c === 0x2008 || // punctuation space
      c === 0x2009 || // thin space
      c === 0x200a || // hair space
      c === 0x200b || // zero-width space
      c === 0x202f || // narrow NBSP
      c === 0x205f || // medium mathematical space
      c === 0x3000 // ideographic space
    ) {
      out += " ";
      continue;
    }
    // BOM — drop
    if (c === 0xfeff) {
      continue;
    }
    out += line[i]!;
  }
  return out;
}

/** Trailing ASCII space/tab only — mirrors Rust `rstrip_line` / TS `/[ \t]+$/`. */
function rstripLine(line: string): string {
  return line.replace(/[ \t]+$/g, "");
}

function transformLine(line: string, pass: SeekPass): string {
  switch (pass) {
    case "exact":
      return line;
    case "rstrip":
      return rstripLine(line);
    case "trim":
      return line.trim();
    case "normalized":
      return normalizeUnicodeLine(line.trim());
    default: {
      const _exhaustive: never = pass;
      return _exhaustive;
    }
  }
}

function linesEqual(a: string, b: string, pass: SeekPass): boolean {
  return transformLine(a, pass) === transformLine(b, pass);
}

function windowMatches(
  haystack: readonly string[],
  pattern: readonly string[],
  index: number,
  pass: SeekPass,
): boolean {
  for (let j = 0; j < pattern.length; j++) {
    if (!linesEqual(haystack[index + j]!, pattern[j]!, pass)) {
      return false;
    }
  }
  return true;
}

/**
 * Locate `pattern` as a contiguous line window inside `haystack`.
 *
 * @param haystack file / buffer lines (EOL already stripped from each element)
 * @param pattern needle lines
 * @param startIndex first line index to consider (clamped to [0, haystack.length])
 * @param eof when true, only attempt the suffix window (pattern as file ending).
 *            Optional TS extension; Rust A1 currently has `start` only.
 *
 * Contract (aligned with Rust A1):
 * - Empty pattern → missing (`hit: null`)
 * - Pattern longer than haystack → missing
 * - Multi-match at the winning tier → ambiguous (`hit: null`, `matchCount > 1`)
 * - Zero matches at a tier → escalate to the next looser pass
 */
export function seekSequence(
  haystack: readonly string[],
  pattern: readonly string[],
  startIndex = 0,
  eof = false,
): SeekSequenceResult {
  // Empty pattern is invalid (callers handle append / EOF insert separately).
  if (pattern.length === 0) {
    return { hit: null, matchCount: 0, passTried: [] };
  }

  if (pattern.length > haystack.length) {
    return { hit: null, matchCount: 0, passTried: [] };
  }

  const start = Math.max(0, Math.min(startIndex, haystack.length));
  const maxStart = haystack.length - pattern.length;
  // EOF anchor: only the suffix window (optional; default false matches Rust).
  const searchStart = eof ? maxStart : start;
  if (searchStart > maxStart) {
    return { hit: null, matchCount: 0, passTried: [] };
  }

  const passTried: SeekPass[] = [];

  for (const pass of PASSES) {
    passTried.push(pass);
    const matches: number[] = [];
    for (let i = searchStart; i <= maxStart; i++) {
      if (windowMatches(haystack, pattern, i, pass)) {
        matches.push(i);
      }
    }
    if (matches.length === 1) {
      return {
        hit: { index: matches[0]!, pass, length: pattern.length },
        matchCount: 1,
        passTried,
      };
    }
    if (matches.length > 1) {
      // Ambiguous at this tier — safer than falling through to a looser unique false hit.
      return { hit: null, matchCount: matches.length, passTried };
    }
  }

  return { hit: null, matchCount: 0, passTried };
}

/**
 * Split text into lines for seek. EOL is normalized to `\n` then split.
 * A trailing newline yields a trailing empty string (split semantics), which is fine
 * for line-window seek when both sides use the same helper.
 */
export function splitLinesForSeek(text: string): string[] {
  const n = normalizeEol(text);
  if (n.length === 0) return [];
  return n.split("\n");
}

export function joinLinesForSeek(lines: readonly string[], eol = "\n"): string {
  return lines.join(eol);
}

function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export interface ReplaceViaSeekOptions {
  /** Forwarded to seekSequence (default 0). */
  startIndex?: number;
  /** Forwarded to seekSequence — anchor pattern as file suffix. */
  eof?: boolean;
}

/**
 * Replace the unique multi-line occurrence of `oldText` with `newText` using 4-pass seek.
 * Operates on original line cells (not transform-normalized text) so whitespace/unicode
 * in the file is only used for *location*, not rewritten unless replaced by `newText`.
 *
 * Empty `oldText` is rejected (`missing`) — callers handle append separately.
 * Preserves CRLF style of `body` when present.
 */
export function replaceViaSeekSequence(
  body: string,
  oldText: string,
  newText: string,
  options: ReplaceViaSeekOptions = {},
): ReplaceViaSeekResult {
  const hay = splitLinesForSeek(body);
  const pat = splitLinesForSeek(oldText);

  if (pat.length === 0) {
    return { error: "missing", matchCount: 0, passTried: [] };
  }

  const result = seekSequence(hay, pat, options.startIndex ?? 0, options.eof ?? false);
  if (!result.hit) {
    return {
      error: result.matchCount > 1 ? "ambiguous" : "missing",
      matchCount: result.matchCount,
      passTried: result.passTried,
    };
  }

  const newLines = splitLinesForSeek(newText);
  const next = [
    ...hay.slice(0, result.hit.index),
    ...newLines,
    ...hay.slice(result.hit.index + result.hit.length),
  ];
  const eol = detectEol(body);
  return {
    content: joinLinesForSeek(next, eol),
    pass: result.hit.pass,
    index: result.hit.index,
  };
}
