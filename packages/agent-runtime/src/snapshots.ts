import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
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

export async function createFileSnapshot(request: FileSnapshotRequest): Promise<ToolArtifact | null> {
  if (request.options === false || request.options?.enabled === false) {
    return null;
  }

  const fileStat = await stat(request.filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    return null;
  }

  const maxFileBytes = request.options?.maxFileBytes ?? 2_000_000;
  if (fileStat.size > maxFileBytes) {
    return {
      kind: "log",
      title: "Snapshot skipped",
      text: `Skipped snapshot for ${displayPath(request.workspaceRoot, request.filePath)} because it is ${fileStat.size} bytes.`,
      metadata: {
        reason: "file-too-large",
        bytes: fileStat.size,
        maxFileBytes
      }
    };
  }

  const archiveRoot = resolveArchiveRoot(request.workspaceRoot, request.options?.archiveRoot);
  const relativePath = displayPath(request.workspaceRoot, request.filePath);
  const snapshotPath = resolve(
    archiveRoot,
    safeSegment(request.sessionId),
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeSegment(request.toolCallId)}`,
    relativePath
  );
  assertInside(archiveRoot, snapshotPath, "snapshot path");

  const bytes = await readFile(request.filePath);
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, bytes);

  return {
    kind: "file",
    title: `Snapshot: ${relativePath}`,
    uri: snapshotPath,
    metadata: {
      sourcePath: relativePath,
      snapshotPath,
      bytes: bytes.byteLength
    }
  };
}

export async function restoreFileSnapshot(request: RestoreSnapshotRequest): Promise<ToolArtifact> {
  const workspaceRoot = resolve(request.workspaceRoot);
  const archiveRoot = resolveArchiveRoot(workspaceRoot, request.archiveRoot);
  const snapshotPath = resolve(archiveRoot, request.snapshotPath);
  const targetPath = resolve(workspaceRoot, request.targetPath);
  assertInside(archiveRoot, snapshotPath, "snapshot path");
  assertInside(workspaceRoot, targetPath, "target path");

  const bytes = await readFile(snapshotPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, bytes);

  return {
    kind: "file",
    title: `Restored: ${displayPath(workspaceRoot, targetPath)}`,
    uri: targetPath,
    metadata: {
      snapshotPath,
      targetPath: displayPath(workspaceRoot, targetPath),
      bytes: bytes.byteLength
    }
  };
}

export function resolveArchiveRoot(workspaceRoot: string, archiveRoot?: string): string {
  return resolve(workspaceRoot, archiveRoot ?? ".agent-runtime/snapshots");
}

function displayPath(workspaceRoot: string, filePath: string): string {
  const rel = relative(resolve(workspaceRoot), filePath);
  return rel || filePath;
}

function assertInside(root: string, candidate: string, label: string): void {
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`${label} escapes allowed root`);
  }
}

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function safeSegment(input: string): string {
  return input.replace(/[^a-z0-9_.-]/gi, "_");
}
