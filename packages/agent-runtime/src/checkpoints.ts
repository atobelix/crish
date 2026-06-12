import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { createId, nowIso } from "./session";
import type { JsonObject, ToolArtifact } from "@crish/shared-types";

export interface WorkspaceCheckpointOptions {
  workspaceRoot: string;
  sessionId: string;
  archiveRoot?: string;
  maxFileBytes?: number;
}

export interface CreateWorkspaceCheckpointRequest extends WorkspaceCheckpointOptions {
  label: string;
  files: string[];
}

export interface RestoreWorkspaceCheckpointRequest {
  workspaceRoot: string;
  archiveRoot?: string;
  checkpointPath: string;
}

export interface WorkspaceCheckpointFile {
  path: string;
  existed: boolean;
  bytes?: number;
  sha256?: string;
  snapshotPath?: string;
  skippedReason?: "file-too-large";
}

export interface WorkspaceCheckpoint {
  id: string;
  label: string;
  sessionId: string;
  workspaceRoot: string;
  archiveRoot: string;
  createdAt: string;
  files: WorkspaceCheckpointFile[];
  manifestPath: string;
}

export interface WorkspaceCheckpointRestoreResult {
  checkpointId: string;
  restored: string[];
  deleted: string[];
  skipped: Array<{ path: string; reason: string }>;
}

const DEFAULT_MAX_FILE_BYTES = 2_000_000;

export async function createWorkspaceCheckpoint(request: CreateWorkspaceCheckpointRequest): Promise<WorkspaceCheckpoint> {
  const workspaceRoot = resolve(request.workspaceRoot);
  const archiveRoot = resolveCheckpointArchiveRoot(workspaceRoot, request.archiveRoot);
  const checkpointId = createId("checkpoint");
  const checkpointDir = resolve(
    archiveRoot,
    safeSegment(request.sessionId),
    "checkpoints",
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeSegment(checkpointId)}`
  );
  assertInside(archiveRoot, checkpointDir, "checkpoint directory");

  const uniqueFiles = [...new Set(request.files.map((file) => normalizeRelativePath(workspaceRoot, file)))].sort();
  const files: WorkspaceCheckpointFile[] = [];
  for (const relativePath of uniqueFiles) {
    const targetPath = resolveWorkspacePath(workspaceRoot, relativePath);
    const fileStat = await stat(targetPath).catch(() => null);
    if (fileStat && !fileStat.isFile()) {
      throw new Error(`Checkpoint paths must be files or missing files: ${relativePath}`);
    }
    if (!fileStat) {
      files.push({ path: relativePath, existed: false });
      continue;
    }

    const bytes = fileStat.size;
    if (bytes > (request.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)) {
      files.push({
        path: relativePath,
        existed: true,
        bytes,
        skippedReason: "file-too-large"
      });
      continue;
    }

    const content = await readFile(targetPath);
    const snapshotPath = resolve(checkpointDir, "files", relativePath);
    assertInside(checkpointDir, snapshotPath, "checkpoint file");
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, content);
    files.push({
      path: relativePath,
      existed: true,
      bytes,
      sha256: createHash("sha256").update(content).digest("hex"),
      snapshotPath
    });
  }

  const manifestPath = resolve(checkpointDir, "checkpoint.json");
  const checkpoint: WorkspaceCheckpoint = {
    id: checkpointId,
    label: request.label,
    sessionId: request.sessionId,
    workspaceRoot,
    archiveRoot,
    createdAt: nowIso(),
    files,
    manifestPath
  };

  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  return checkpoint;
}

export async function restoreWorkspaceCheckpoint(request: RestoreWorkspaceCheckpointRequest): Promise<WorkspaceCheckpointRestoreResult> {
  const workspaceRoot = resolve(request.workspaceRoot);
  const archiveRoot = resolveCheckpointArchiveRoot(workspaceRoot, request.archiveRoot);
  const manifestPath = resolve(archiveRoot, request.checkpointPath);
  assertInside(archiveRoot, manifestPath, "checkpoint manifest");

  const checkpoint = JSON.parse(await readFile(manifestPath, "utf8")) as WorkspaceCheckpoint;
  const restored: string[] = [];
  const deleted: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const file of checkpoint.files) {
    const targetPath = resolveWorkspacePath(workspaceRoot, file.path);
    if (!file.existed) {
      await rm(targetPath, { force: true });
      deleted.push(file.path);
      continue;
    }

    if (!file.snapshotPath) {
      skipped.push({ path: file.path, reason: file.skippedReason ?? "missing snapshot" });
      continue;
    }

    const snapshotPath = resolve(file.snapshotPath);
    assertInside(archiveRoot, snapshotPath, "checkpoint file");
    const bytes = await readFile(snapshotPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, bytes);
    restored.push(file.path);
  }

  return {
    checkpointId: checkpoint.id,
    restored,
    deleted,
    skipped
  };
}

export function checkpointToArtifact(checkpoint: WorkspaceCheckpoint): ToolArtifact {
  return {
    kind: "file",
    title: `Checkpoint: ${checkpoint.label}`,
    uri: checkpoint.manifestPath,
    metadata: {
      checkpointId: checkpoint.id,
      label: checkpoint.label,
      files: checkpoint.files.length,
      filePaths: checkpoint.files.map((file) => file.path).slice(0, 100),
      manifestPath: checkpoint.manifestPath
    }
  };
}

export function checkpointRestoreResultToOutput(result: WorkspaceCheckpointRestoreResult): JsonObject {
  return {
    checkpointId: result.checkpointId,
    restored: result.restored,
    deleted: result.deleted,
    skipped: result.skipped.map((item) => `${item.path}: ${item.reason}`)
  };
}

export function resolveCheckpointArchiveRoot(workspaceRoot: string, archiveRoot?: string): string {
  return resolve(workspaceRoot, archiveRoot ?? ".agent-runtime/snapshots");
}

function normalizeRelativePath(workspaceRoot: string, inputPath: string): string {
  const targetPath = resolveWorkspacePath(workspaceRoot, inputPath);
  return relative(resolve(workspaceRoot), targetPath);
}

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, inputPath);
  assertInside(root, candidate, "workspace path");
  return candidate;
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
