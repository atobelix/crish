import { invoke } from "@tauri-apps/api/core";

// ==================== Types ====================

export interface HashResult {
  algorithm: string;
  hex: string;
  base64: string;
  base64Url: string;
}

export interface EncodingDetectResult {
  encoding: string;
  confidence: number;
  isAscii: boolean;
  bomEncoding: string | null;
}

export interface DiffLine {
  kind: "Context" | "Addition" | "Deletion" | "NoNewline";
  content: string;
  oldLineno: number | null;
  newLineno: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: DiffLine[];
}

export interface DiffStats {
  additions: number;
  deletions: number;
  hunks: number;
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: "Added" | "Deleted" | "Modified" | "Renamed" | "Copied";
  hunks: DiffHunk[];
  stats: DiffStats;
}

export interface DiffResult {
  files: DiffFile[];
  truncated: boolean;
}

export interface DiffParseResult {
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  totalFiles: number;
}

export interface JsonlParseError {
  line: number;
  message: string;
}

export interface JsonlReadResult {
  records: unknown[];
  lineCount: number;
  truncated: boolean;
  parseErrors: JsonlParseError[];
}

export interface JsonlWriteResult {
  path: string;
  recordsWritten: number;
  bytesWritten: number;
}

export interface FileChunk {
  data: number[];
  offset: number;
  size: number;
  fileSize: number;
  isEof: boolean;
}

export interface FileInfo {
  size: number;
  modified: number;
  created: number | null;
  isFile: boolean;
  isDir: boolean;
  isSymlink: boolean;
}

// ==================== JS Fallback Implementations ====================

async function jsSha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex;
}

async function jsSha256Full(data: Uint8Array): Promise<HashResult> {
  const hash = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  const hashBytes = new Uint8Array(hash);
  const hex = Array.from(hashBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const base64 = btoa(String.fromCharCode(...hashBytes));
  const base64Url = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return {
    algorithm: "SHA-256",
    hex,
    base64,
    base64Url,
  };
}

function jsBase64Encode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data));
}

function jsBase64Decode(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
}

function jsDetectEncoding(data: Uint8Array): EncodingDetectResult {
  // BOM detection
  const bomEncoding = detectBom(data);

  // Check if ASCII
  const isAscii = data.every((b) => b < 128);

  if (isAscii) {
    return { encoding: "ASCII", confidence: 1.0, isAscii: true, bomEncoding };
  }

  // Try UTF-8 decode
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    decoder.decode(data);
    return { encoding: "UTF-8", confidence: 0.9, isAscii: false, bomEncoding };
  } catch {
    // Not valid UTF-8
  }

  // Try Latin-1 (always succeeds)
  const latin1Decoder = new TextDecoder("latin1");
  const latin1Text = latin1Decoder.decode(data);
  const latin1Score = scoreTextQuality(latin1Text);

  // Try Windows-1252
  const win1252Decoder = new TextDecoder("windows-1252");
  const win1252Text = win1252Decoder.decode(data);
  const win1252Score = scoreTextQuality(win1252Text);

  if (win1252Score > latin1Score) {
    return { encoding: "windows-1252", confidence: win1252Score, isAscii: false, bomEncoding };
  }
  return { encoding: "ISO-8859-1", confidence: latin1Score, isAscii: false, bomEncoding };
}

function detectBom(data: Uint8Array): string | null {
  if (data.length >= 4) {
    if (data[0] === 0xFF && data[1] === 0xFE && data[2] === 0x00 && data[3] === 0x00)
      return "UTF-32LE";
    if (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0xFE && data[3] === 0xFF)
      return "UTF-32BE";
  }
  if (data.length >= 3 && data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF)
    return "UTF-8";
  if (data.length >= 2) {
    if (data[0] === 0xFF && data[1] === 0xFE) return "UTF-16LE";
    if (data[0] === 0xFE && data[1] === 0xFF) return "UTF-16BE";
  }
  return null;
}

function scoreTextQuality(text: string): number {
  const total = text.length || 1;
  const controlCount = [...text].filter(
    (c) => {
      const code = c.charCodeAt(0);
      return (code >= 0x00 && code <= 0x08) || (code >= 0x0E && code <= 0x1F);
    }
  ).length;
  return 1.0 - controlCount / total;
}

function jsDecodeToUtf8(data: Uint8Array, encoding?: string): string {
  try {
    const decoder = new TextDecoder(encoding ?? "utf-8", { fatal: false });
    return decoder.decode(data);
  } catch {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    return decoder.decode(data);
  }
}

function jsParseDiff(content: string): DiffParseResult {
  const files: DiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  let currentFile: Partial<DiffFile> | null = null;
  let currentHunk: Partial<DiffHunk> | null = null;
  let fileAdditions = 0;
  let fileDeletions = 0;

  for (const line of content.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (currentFile?.oldPath != null && currentFile?.newPath != null) {
        if (currentHunk?.lines) {
          (currentFile.hunks ??= []).push(currentHunk as DiffHunk);
          currentHunk = null;
        }
        files.push(finalizeFile(currentFile, fileAdditions, fileDeletions));
        fileAdditions = 0;
        fileDeletions = 0;
      }
      currentFile = {};
      currentHunk = null;
      continue;
    }

    if (line.startsWith("--- ")) {
      currentFile!.oldPath = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      currentFile!.newPath = stripPrefix(line.slice(4));
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
    if (hunkMatch) {
      if (currentHunk?.lines) {
        (currentFile!.hunks ??= []).push(currentHunk as DiffHunk);
      }
      currentHunk = {
        oldStart: parseInt(hunkMatch[1] ?? "0"),
        oldCount: parseInt(hunkMatch[2] ?? "1"),
        newStart: parseInt(hunkMatch[3] ?? "0"),
        newCount: parseInt(hunkMatch[4] ?? "1"),
        header: hunkMatch[5]?.trim() ?? "",
        lines: [],
      };
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const lineno = currentHunk.newStart! + countByKind(currentHunk.lines!, "Addition");
      currentHunk.lines!.push({
        kind: "Addition",
        content: line.slice(1),
        oldLineno: null,
        newLineno: lineno,
      });
      fileAdditions++;
      totalAdditions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      const lineno = currentHunk.oldStart! + countByKind(currentHunk.lines!, "Deletion");
      currentHunk.lines!.push({
        kind: "Deletion",
        content: line.slice(1),
        oldLineno: lineno,
        newLineno: null,
      });
      fileDeletions++;
      totalDeletions++;
    } else if (line.startsWith("\\ ")) {
      currentHunk.lines!.push({
        kind: "NoNewline",
        content: line,
        oldLineno: null,
        newLineno: null,
      });
    } else {
      const ctxOffset = countByKind(currentHunk.lines!, "Context");
      const content = line.startsWith(" ") ? line.slice(1) : line;
      currentHunk.lines!.push({
        kind: "Context",
        content,
        oldLineno: currentHunk.oldStart! + ctxOffset,
        newLineno: currentHunk.newStart! + ctxOffset,
      });
    }
  }

  if (currentFile?.oldPath != null && currentFile?.newPath != null) {
    if (currentHunk?.lines) {
      (currentFile.hunks ??= []).push(currentHunk as DiffHunk);
    }
    files.push(finalizeFile(currentFile, fileAdditions, fileDeletions));
  }

  return { files, totalAdditions, totalDeletions, totalFiles: files.length };
}

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, "");
}

function countByKind(lines: DiffLine[], kind: DiffLine["kind"]): number {
  return lines.filter((l) => l.kind === kind).length;
}

function finalizeFile(
  f: Partial<DiffFile>,
  additions: number,
  deletions: number
): DiffFile {
  const status: DiffFile["status"] =
    f.oldPath === "/dev/null"
      ? "Added"
      : f.newPath === "/dev/null"
        ? "Deleted"
        : f.oldPath !== f.newPath
          ? "Renamed"
          : "Modified";
  return {
    oldPath: f.oldPath!,
    newPath: f.newPath!,
    status,
    hunks: (f.hunks ?? []) as DiffHunk[],
    stats: { additions, deletions, hunks: f.hunks?.length ?? 0 },
  };
}

// ==================== Bridge ====================

async function tryRust<I, O>(command: string, args: I): Promise<O | null> {
  try {
    return await invoke<O>(command, args as Record<string, unknown>);
  } catch {
    return null;
  }
}

export class PerfBackend {
  // ---- Hash ----

  static async sha256Hex(data: Uint8Array): Promise<string> {
    const rust = await tryRust<{ data: number[] }, HashResult>(
      "perf_hash_compute",
      { data: Array.from(data) }
    );
    if (rust) return rust.hex;
    return jsSha256Hex(data);
  }

  static async sha256Full(data: Uint8Array): Promise<HashResult> {
    const rust = await tryRust<{ data: number[] }, HashResult>(
      "perf_hash_compute",
      { data: Array.from(data) }
    );
    if (rust) return rust;
    return jsSha256Full(data);
  }

  static async base64Encode(data: Uint8Array): Promise<string> {
    const rust = await tryRust<{ data: number[] }, string>(
      "perf_base64_encode",
      { data: Array.from(data) }
    );
    if (rust) return rust;
    return jsBase64Encode(data);
  }

  static async base64Decode(encoded: string): Promise<Uint8Array> {
    const rust = await tryRust<{ encoded: string }, number[]>(
      "perf_base64_decode",
      { encoded }
    );
    if (rust) return new Uint8Array(rust);
    return jsBase64Decode(encoded);
  }

  // ---- Encoding ----

  static async detectEncoding(data: Uint8Array): Promise<EncodingDetectResult> {
    const rust = await tryRust<{ data: number[] }, EncodingDetectResult>(
      "perf_encoding_detect",
      { data: Array.from(data) }
    );
    if (rust) return rust;
    return jsDetectEncoding(data);
  }

  static async decodeToUtf8(data: Uint8Array, encoding?: string): Promise<string> {
    const rust = await tryRust<{ data: number[]; encoding?: string }, string>(
      "perf_encoding_decode",
      { data: Array.from(data), ...(encoding !== undefined ? { encoding } : {}) }
    );
    if (rust) return rust;
    return jsDecodeToUtf8(data, encoding);
  }

  // ---- Diff ----

  static async parseDiff(
    unifiedDiff: string,
    maxLines?: number
  ): Promise<DiffResult> {
    try {
      return await invoke<DiffResult>("perf_diff_parse", {
        unifiedDiff,
        maxLines: maxLines ?? 10000,
      });
    } catch {
      const { files } = jsParseDiff(unifiedDiff);
      return { files, truncated: false };
    }
  }

  // ---- JSONL ----

  static async readJsonl(
    path: string,
    maxLines?: number,
    workspaceRoot?: string
  ): Promise<string[]> {
    return invoke<string[]>("perf_jsonl_read", {
      path,
      maxLines,
      workspaceRoot,
    });
  }

  static async appendJsonl(
    path: string,
    lines: string[],
    flush?: boolean,
    workspaceRoot?: string
  ): Promise<void> {
    return invoke<void>("perf_jsonl_append", {
      path,
      lines,
      flush,
      workspaceRoot,
    });
  }

  static async writeJsonl(
    path: string,
    records: unknown[],
    append?: boolean,
    workspaceRoot?: string
  ): Promise<JsonlWriteResult> {
    return invoke<JsonlWriteResult>("perf_jsonl_write", {
      path,
      records,
      append,
      workspaceRoot,
    });
  }

  // ---- Filesystem ----

  static async readFileChunk(
    path: string,
    offset: number,
    size: number,
    workspaceRoot?: string
  ): Promise<FileChunk> {
    return invoke<FileChunk>("perf_fs_read_chunk", {
      path,
      offset,
      size,
      workspaceRoot,
    });
  }

  static async getFileInfo(
    path: string,
    workspaceRoot?: string
  ): Promise<FileInfo> {
    return invoke<FileInfo>("perf_fs_file_info", {
      path,
      workspaceRoot,
    });
  }

  static async startWatcher(
    path: string,
    recursive?: boolean,
    workspaceRoot?: string
  ): Promise<string> {
    return invoke<string>("perf_fs_watch_start", {
      path,
      recursive,
      workspaceRoot,
    });
  }

  static async stopWatcher(watcherId: string): Promise<void> {
    return invoke<void>("perf_fs_watch_stop", { watcherId });
  }
}
