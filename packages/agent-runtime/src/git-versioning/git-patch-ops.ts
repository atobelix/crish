import { relative, resolve, sep } from "node:path";
import { isRecord } from "@crish/shared-utils";
import { CrishError } from "@crish/shared-types";
import type {
  GitCheckpointDiffFile,
  GitCheckpointMetadata,
  GitCommandResult,
  GitStatusEntry,
  GitWorkspaceStatus
} from "./git-types";

export const DEFAULT_REF_NAMESPACE = "refs/agent-runtime/checkpoints";
export const CHECKPOINT_METADATA_VERSION = 1;
export const CHECKPOINT_MARKER = `Agent-Runtime-Checkpoint: v${CHECKPOINT_METADATA_VERSION}`;

export function parseStatus(output: string): GitWorkspaceStatus {
  const entries: GitStatusEntry[] = [];
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const entry: GitStatusEntry = {
      path: normalizeGitPath(path),
      index: status[0] ?? " ",
      worktree: status[1] ?? " "
    };
    if (entry.index === "R" || entry.index === "C") {
      const originalPath = records[++index];
      if (originalPath) entry.originalPath = normalizeGitPath(originalPath);
    }
    entries.push(entry);
  }

  const staged = entries
    .filter((entry) => entry.index !== " " && entry.index !== "?" && entry.index !== "!")
    .map((entry) => entry.path);
  const unstaged = entries
    .filter((entry) => entry.worktree !== " " && entry.worktree !== "?" && entry.worktree !== "!")
    .map((entry) => entry.path);
  const untracked = entries.filter((entry) => entry.index === "?" && entry.worktree === "?").map((entry) => entry.path);
  const conflicted = entries.filter(isConflictedStatus).map((entry) => entry.path);
  return {
    clean: entries.length === 0,
    staged,
    unstaged,
    untracked,
    conflicted,
    entries
  };
}

export function isConflictedStatus(entry: GitStatusEntry): boolean {
  const code = `${entry.index}${entry.worktree}`;
  return code.includes("U") || code === "AA" || code === "DD";
}

export function parseNameStatus(output: string): GitCheckpointDiffFile[] {
  const files: GitCheckpointDiffFile[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [status, firstPath, secondPath] = line.split("\t");
    if (!status || !firstPath) continue;
    if ((status.startsWith("R") || status.startsWith("C")) && secondPath) {
      files.push({
        status,
        path: normalizeGitPath(secondPath),
        originalPath: normalizeGitPath(firstPath)
      });
      continue;
    }
    files.push({
      status,
      path: normalizeGitPath(firstPath)
    });
  }
  return files;
}

export function parseCheckpointMetadata(message: string): GitCheckpointMetadata {
  const markerIndex = message.indexOf(CHECKPOINT_MARKER);
  if (markerIndex < 0) {
    throw new CrishError("Commit is not an agent-runtime Git checkpoint", "TOOL_ERROR", "permanent", false);
  }
  const metadataLine = message
    .slice(markerIndex + CHECKPOINT_MARKER.length)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("{"));
  if (!metadataLine) {
    throw new CrishError("Git checkpoint metadata is missing", "TOOL_ERROR", "permanent", false);
  }
  const parsed = JSON.parse(metadataLine) as unknown;
  if (!isCheckpointMetadata(parsed)) {
    throw new CrishError("Git checkpoint metadata is invalid", "TOOL_ERROR", "permanent", false);
  }
  return parsed;
}

export function isCheckpointMetadata(value: unknown): value is GitCheckpointMetadata {
  if (!isRecord(value)) return false;
  return (
    value.version === CHECKPOINT_METADATA_VERSION &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    (value.strategy === "commit" || value.strategy === "snapshot") &&
    typeof value.refName === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.repositoryRoot === "string" &&
    (typeof value.baseCommit === "string" || value.baseCommit === null) &&
    typeof value.includeUntracked === "boolean" &&
    isWorkspaceStatus(value.statusBefore)
  );
}

export function isWorkspaceStatus(value: unknown): value is GitWorkspaceStatus {
  return (
    isRecord(value) &&
    typeof value.clean === "boolean" &&
    isStringArray(value.staged) &&
    isStringArray(value.unstaged) &&
    isStringArray(value.untracked) &&
    isStringArray(value.conflicted) &&
    Array.isArray(value.entries)
  );
}

export function commitMessage(rawCommit: string): string {
  const splitAt = rawCommit.indexOf("\n\n");
  return splitAt >= 0 ? rawCommit.slice(splitAt + 2) : "";
}

export function trimRequired(result: GitCommandResult, label: string): string {
  const value = result.stdout.trim();
  if (!value) throw new CrishError(`Git did not return ${label}`, "TOOL_ERROR", "transient", true);
  return value;
}

export function normalizeRefNamespace(input: string | undefined): string {
  const value = (input ?? DEFAULT_REF_NAMESPACE).replace(/\/+$/g, "");
  if (!value.startsWith("refs/") || value.includes("..") || /[\s~^:?*[\\]/.test(value)) {
    throw new CrishError(`Invalid Git ref namespace: ${input ?? DEFAULT_REF_NAMESPACE}`, "TOOL_ERROR", "permanent", false);
  }
  return value;
}

export function safeRefSegment(input: string): string {
  return input
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .replace(/\.+/g, ".")
    .replace(/^\./, "_")
    .replace(/\.$/, "_");
}

export function normalizeRepositoryPath(root: string, inputPath: string): string {
  const candidate = resolve(root, inputPath);
  assertInside(root, candidate, "Git path");
  return normalizeGitPath(relative(root, candidate));
}

export function assertInside(root: string, candidate: string, label: string): void {
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new CrishError(`${label} escapes repository root`, "TOOL_ERROR", "permanent", false);
  }
}

export function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function assertExpectedChangedPaths(root: string, expectedPaths: string[], actualPaths: string[]): void {
  const expected = uniqueSorted(expectedPaths.map((path) => normalizeRepositoryPath(root, path)));
  const actual = uniqueSorted(actualPaths);
  if (expected.length === actual.length && expected.every((path, index) => path === actual[index])) {
    return;
  }
  throw new CrishError(
    `Git checkpoint restore changed paths do not match expected paths. expected: ${expected.join(", ") || "(none)"}; actual: ${
      actual.join(", ") || "(none)"
    }`,
    "TOOL_ERROR",
    "permanent",
    false
  );
}

export function uniqueSorted(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

export function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
