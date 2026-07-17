import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolArtifact } from "@crish/shared-types";

export interface WorkspaceSnapshotOptions {
  enabled?: boolean;
  archiveRoot?: string;
  maxFileBytes?: number;
}

export interface FileSnapshotRequest {
  workspaceRoot: string;
  filePath: string;
  sessionId: string;
  toolCallId: string;
  options?: WorkspaceSnapshotOptions | false;
}

export interface RestoreSnapshotRequest {
  workspaceRoot: string;
  archiveRoot?: string;
  snapshotPath: string;
  targetPath: string;
}

/**
 * Create a pre-mutation file snapshot under the workspace archive.
 *
 * Path rules (fixes double-prefix / absolute collapse):
 * - Always resolve the source file under workspaceRoot first
 * - Store archive layout with **relative** posix segments only
 * - Never pass a full absolute path as a trailing resolve() segment
 *   (Windows would drop archiveRoot and write onto the source file)
 */
export async function createFileSnapshot(request: FileSnapshotRequest): Promise<ToolArtifact | null> {
  if (request.options === false || request.options?.enabled === false) {
    return null;
  }

  const workspaceRoot = resolve(request.workspaceRoot);
  const absoluteFile = resolveUnderRoot(workspaceRoot, request.filePath, "workspace file");
  const relativePath = toRelativePosix(workspaceRoot, absoluteFile);

  const fileStat = await stat(absoluteFile).catch(() => null);
  if (!fileStat?.isFile()) {
    return null;
  }

  const maxFileBytes = request.options?.maxFileBytes ?? 2_000_000;
  if (fileStat.size > maxFileBytes) {
    return {
      kind: "log",
      title: "Snapshot skipped",
      text: `Skipped snapshot for ${relativePath} because it is ${fileStat.size} bytes.`,
      metadata: {
        reason: "file-too-large",
        bytes: fileStat.size,
        maxFileBytes,
      },
    };
  }

  const archiveRoot = resolveArchiveRoot(workspaceRoot, request.options?.archiveRoot);
  const snapshotPath = joinUnderRoot(
    archiveRoot,
    safeSegment(request.sessionId),
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeSegment(request.toolCallId)}`,
    ...relativePath.split("/"),
  );
  assertInside(archiveRoot, snapshotPath, "snapshot path");

  const bytes = await readFile(absoluteFile);
  await mkdir(dirname(snapshotPath), { recursive: true });
  await atomicWriteFile(snapshotPath, bytes);

  return {
    kind: "file",
    title: `Snapshot: ${relativePath}`,
    uri: snapshotPath,
    metadata: {
      sourcePath: relativePath,
      /** Absolute path for restore-by-uri */
      snapshotPath,
      /** Archive-relative path (posix) — safe to re-join under archiveRoot */
      snapshotRelativePath: toRelativePosix(archiveRoot, snapshotPath),
      bytes: bytes.byteLength,
    },
  };
}

export async function restoreFileSnapshot(request: RestoreSnapshotRequest): Promise<ToolArtifact> {
  const workspaceRoot = resolve(request.workspaceRoot);
  const archiveRoot = resolveArchiveRoot(workspaceRoot, request.archiveRoot);
  const snapshotPath = resolveSnapshotLocation(archiveRoot, request.snapshotPath);
  const targetPath = resolveUnderRoot(workspaceRoot, request.targetPath, "target path");

  const bytes = await readFile(snapshotPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await atomicWriteFile(targetPath, bytes);

  return {
    kind: "file",
    title: `Restored: ${toRelativePosix(workspaceRoot, targetPath)}`,
    uri: targetPath,
    metadata: {
      snapshotPath,
      targetPath: toRelativePosix(workspaceRoot, targetPath),
      bytes: bytes.byteLength,
    },
  };
}

export function resolveArchiveRoot(workspaceRoot: string, archiveRoot?: string): string {
  return resolve(resolve(workspaceRoot), archiveRoot ?? ".agent-runtime/snapshots");
}

/**
 * Resolve a snapshot location without double-prefixing.
 * Accepts absolute uri (inside archive) or archive-relative path.
 */
export function resolveSnapshotLocation(archiveRoot: string, snapshotPath: string): string {
  const archive = resolve(archiveRoot);
  let raw = snapshotPath.trim().replace(/\\/g, "/");
  if (!raw) {
    throw new Error("snapshot path is empty");
  }

  if (isAbsolute(raw) || isWindowsDrivePath(raw) || isWindowsUncPath(raw)) {
    const abs = resolve(raw);
    assertInside(archive, abs, "snapshot path");
    return abs;
  }

  // 剥掉误带的 archive 相对前缀，避免 .agent-runtime/snapshots 双拼
  for (const prefix of [".agent-runtime/snapshots/", "agent-runtime/snapshots/"]) {
    while (raw.startsWith(prefix)) {
      raw = raw.slice(prefix.length);
    }
  }

  // Relative: join segment-by-segment under archive (never resolve(archive, abs-looking))
  const joined = joinUnderRoot(archive, ...raw.split(/[/\\]+/).filter(Boolean));
  assertInside(archive, joined, "snapshot path");
  return joined;
}

/** Resolve path under root; reject escapes and avoid double-prefix. */
export function resolveUnderRoot(root: string, inputPath: string, label: string): string {
  const base = resolve(root);
  const raw = inputPath.trim();
  if (!raw) {
    throw new Error(`${label} is empty`);
  }

  const candidate =
    isAbsolute(raw) || isWindowsDrivePath(raw) || isWindowsUncPath(raw)
      ? resolve(raw)
      : joinUnderRoot(base, ...raw.split(/[/\\]+/).filter(Boolean));

  assertInside(base, candidate, label);
  return candidate;
}

/** Join relative segments under root; each segment must be a single path part (no abs, no ..). */
export function joinUnderRoot(root: string, ...segments: string[]): string {
  let out = resolve(root);
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      throw new Error("path segment escapes allowed root");
    }
    if (isAbsolute(segment) || isWindowsDrivePath(segment) || isWindowsUncPath(segment)) {
      throw new Error(`absolute path segment not allowed under root: ${segment}`);
    }
    // Reject nested separators smuggled in one segment after split
    if (segment.includes("/") || segment.includes("\\")) {
      throw new Error(`invalid path segment: ${segment}`);
    }
    out = resolve(out, segment);
  }
  assertInside(resolve(root), out, "joined path");
  return out;
}

export function toRelativePosix(root: string, absolutePath: string): string {
  const base = resolve(root);
  const abs = resolve(absolutePath);
  assertInside(base, abs, "path");
  const rel = relative(base, abs);
  if (!rel || rel === ".") {
    throw new Error("path resolves to root; relative form required");
  }
  if (rel.startsWith("..") || isAbsolute(rel) || isWindowsDrivePath(rel)) {
    throw new Error(`path escapes root: ${absolutePath}`);
  }
  return rel.split(sep).join("/");
}

function assertInside(root: string, candidate: string, label: string): void {
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    // Also allow forward-slash comparison on Windows edge cases
    const rootSlash = normalizedRoot.split(sep).join("/");
    const candSlash = normalizedCandidate.split(sep).join("/");
    if (candSlash !== rootSlash && !candSlash.startsWith(`${rootSlash}/`)) {
      throw new Error(`${label} escapes allowed root`);
    }
  }
}

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function safeSegment(input: string): string {
  return input.replace(/[^a-z0-9_.-]/gi, "_");
}

function isWindowsDrivePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

function isWindowsUncPath(path: string): boolean {
  return path.startsWith("\\\\") || path.startsWith("//");
}

/**
 * 原子覆写：先写 tmp 文件再 rename，避免 mid-write 崩溃留下截断内容。
 * tmp 文件名含 pid + 时间戳 + UUID，避免并发碰撞；与目标同目录保证 rename 原子。
 */
async function atomicWriteFile(targetPath: string, data: string | Buffer): Promise<void> {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, data);
  await rename(tmpPath, targetPath);
}
