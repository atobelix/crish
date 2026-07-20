import type { Stats } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { JsonObject, JsonValue, ToolExecutionContext } from "@crish/shared-types";
import type { LeaseScope, MutationLeaseOwner } from "../workspace-mutation-coordinator";
import type { LocalToolOptions } from "./types";

export interface LocalMutationLeaseRequest {
  scope: LeaseScope;
  toolName: string;
  cwd: string;
  targetSummary: string;
}

export async function withLocalMutationLease<TResult>(
  options: LocalToolOptions,
  context: ToolExecutionContext,
  request: LocalMutationLeaseRequest,
  operation: () => Promise<TResult> | TResult
): Promise<TResult> {
  const coordinator = options.mutationCoordinator;
  if (!coordinator) {
    return operation();
  }
  return coordinator.withLease(
    {
      scope: request.scope,
      owner: localMutationLeaseOwner(context, request),
      wait: true,
      signal: context.signal
    },
    () => operation()
  );
}

function localMutationLeaseOwner(context: ToolExecutionContext, request: LocalMutationLeaseRequest): MutationLeaseOwner {
  return {
    sessionId: context.sessionId,
    toolCallId: context.toolCallId,
    toolName: request.toolName,
    cwd: request.cwd,
    targetSummary: request.targetSummary
  };
}

export function recordReadSnapshot(
  options: LocalToolOptions,
  context: ToolExecutionContext,
  path: string,
  snapshotTag: string
): void {
  options.mutationCoordinator?.recordReadSnapshot(context.sessionId, path, snapshotTag);
}

export function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw new Error("Path must be a non-empty string");
  }
  // Reject control chars early (null bytes, CR/LF, etc. — path traversal / odd FS behavior)
  if (/[\u0000-\u001f\u007f]/.test(inputPath)) {
    throw new Error(`Invalid path (control character): ${JSON.stringify(inputPath)}`);
  }
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, inputPath);
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return candidate;
}

export function displayPath(workspaceRoot: string, filePath: string): string {
  const rel = relative(resolve(workspaceRoot), filePath);
  return rel || basename(filePath);
}

export function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function computeSnapshotTag(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

export function errorToString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error;
}

export function truncateForMetadata(value: string, maxLength: number): string {
  const limit = Number.isFinite(maxLength) ? Math.floor(maxLength) : 0;
  if (limit <= 0) return "";
  if (value.length <= limit) return value;
  if (limit === 1) return "…";
  return `${value.slice(0, limit - 1)}...`;
}

export async function statOrThrow(targetPath: string, display: string): Promise<Stats> {
  try {
    return await stat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Path does not exist: ${display}`);
    }
    throw error;
  }
}

export async function readdirOrThrow(targetPath: string, display: string) {
  try {
    return await readdir(targetPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Directory does not exist: ${display}`);
    }
    throw error;
  }
}

export async function readFileOrThrow(targetPath: string, display: string): Promise<Buffer> {
  try {
    return await readFile(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`File does not exist: ${display}`);
    }
    throw error;
  }
}

export async function ensureParentDirectoryForWrite(
  filePath: string,
  options: { existed: boolean; relativePath: string; workspaceRoot?: string }
): Promise<{ created: boolean; parentDisplay: string }> {
  const parent = dirname(filePath);
  const parentDisplay = options.workspaceRoot ? displayPath(options.workspaceRoot, parent) : parent;
  try {
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) {
      throw new Error(`Parent path is not a directory for ${options.relativePath}: ${parentDisplay}`);
    }
    return { created: false, parentDisplay };
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    if (options.existed) {
      throw new Error(
        `Parent directory is missing for existing file ${options.relativePath}. Refusing to recreate directories unexpectedly.`
      );
    }
    await mkdir(parent, { recursive: true });
    return { created: true, parentDisplay };
  }
}

export type ListingEntryKind = "directory" | "file" | "other";

function formatListingEntry(entry: { name: string; kind: ListingEntryKind }): string {
  // Keep a stable one-char prefix so dirs and files align in text output.
  const prefix = entry.kind === "directory" ? "/" : entry.kind === "file" ? " " : "?";
  return `${prefix}${entry.name}`;
}

export function formatListingText(items: Array<{ name: string; kind: ListingEntryKind }>): string {
  if (items.length === 0) return "(empty directory)";
  return items.map(formatListingEntry).join("\n");
}

export function splitTextLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

export function detectLineEnding(text: string): string {
  const match = text.match(/\r\n|\n|\r/);
  return match?.[0] ?? "\n";
}

export function formatNumberedLines(lines: string[], startLine: number): string {
  const safeStart =
    Number.isFinite(startLine) && startLine >= 1 ? Math.floor(startLine) : 1;
  if (lines.length === 0) return "";
  const width = String(safeStart + Math.max(0, lines.length - 1)).length;
  return lines
    .map((line, index) => `${String(safeStart + index).padStart(width, " ")} | ${line}`)
    .join("\n");
}

export function requireString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  // Paths/commands with embedded control chars are never legitimate model args.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${key} contains invalid control characters`);
  }
  // Preserve original (non-trimmed) value for commands that may encode intentional padding,
  // but reject pure whitespace so blank shell/path inputs never reach the OS.
  return value;
}

export function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

export function numberField(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Positive finite number field (timeouts, maxBytes, etc.).
 * Non-positive / non-finite / missing → undefined (caller applies default).
 */
export function positiveNumberField(input: JsonObject, key: string): number | undefined {
  const value = numberField(input, key);
  if (value === undefined || value <= 0) return undefined;
  return value;
}

export function booleanField(input: JsonObject, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

export function requireStringArray(input: JsonObject, key: string): string[] {
  const values = stringArrayField(input, key);
  if (values.length === 0) {
    throw new Error(`${key} must contain at least one path`);
  }
  return values;
}

export function stringArrayField(input: JsonObject, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !/[\u0000-\u001f\u007f]/.test(item));
}
