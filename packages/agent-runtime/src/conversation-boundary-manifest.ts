import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { nowIso } from "./session";
import { isNodeError } from "@crish/shared-utils";
import type { JsonObject, JsonValue } from "@crish/shared-types";

export type ConversationBoundaryCheckpointSource = "runtime" | "tool" | "external" | "unknown";

export interface ConversationBoundaryCheckpointRef {
  id?: string;
  ref?: string;
  source?: ConversationBoundaryCheckpointSource;
}

export interface ConversationBoundaryManifestRecord {
  sessionId: string;
  runId: string;
  userMessageId: string;
  sessionTreeLeafIdBefore?: string;
  sessionTreeLeafIdAfter?: string;
  runtimeLeafIdBefore?: string;
  runtimeLeafIdAfter?: string;
  eventSequence: number;
  workspaceRoot: string;
  checkpointId?: string;
  checkpointRef?: string;
  checkpointSource?: ConversationBoundaryCheckpointSource;
  changedPaths: string[];
  createdAt: string;
  metadata?: JsonObject;
}

export type ConversationRewindBoundaryTargetMode = "keep-user-message" | "remove-user-message";

export interface ConversationRewindBoundaryTargetFacts {
  sessionId: string;
  runId: string;
  userMessageId: string;
  mode: ConversationRewindBoundaryTargetMode;
  eventSequence: number;
  workspaceRoot: string;
  changedPaths: string[];
  createdAt: string;
  sessionTreeTargetLeafId?: string;
  runtimeTargetLeafId?: string;
  checkpointId?: string;
  checkpointRef?: string;
  checkpointSource?: ConversationBoundaryCheckpointSource;
  metadata?: JsonObject;
}

export interface ConversationBoundaryManifestInput {
  sessionId: string;
  runId: string;
  userMessageId: string;
  sessionTreeLeafIdBefore?: string;
  sessionTreeLeafIdAfter?: string;
  runtimeLeafIdBefore?: string;
  runtimeLeafIdAfter?: string;
  eventSequence: number;
  workspaceRoot: string;
  checkpoint?: ConversationBoundaryCheckpointRef;
  checkpointId?: string;
  checkpointRef?: string;
  checkpointSource?: ConversationBoundaryCheckpointSource;
  changedPaths?: string[];
  createdAt?: string;
  metadata?: JsonObject;
}

export interface ConversationBoundaryManifestServiceOptions {
  manifestPath: string;
  now?: () => string;
}

export interface ConversationBoundaryManifestListOptions {
  sessionId?: string;
  runId?: string;
  userMessageId?: string;
}

export interface ConversationBoundaryManifestReadResult {
  records: ConversationBoundaryManifestRecord[];
  invalidRecords: ConversationBoundaryManifestInvalidRecord[];
}

export interface ConversationBoundaryManifestInvalidRecord {
  line: number;
  reason: string;
  text: string;
}

export class ConversationBoundaryManifestService {
  private readonly manifestPath: string;
  private readonly now: () => string;
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(options: ConversationBoundaryManifestServiceOptions) {
    this.manifestPath = resolve(options.manifestPath);
    this.now = options.now ?? nowIso;
  }

  async append(input: ConversationBoundaryManifestInput): Promise<ConversationBoundaryManifestRecord> {
    const record = createConversationBoundaryManifestRecord(input, this.now);
    await mkdir(dirname(this.manifestPath), { recursive: true });
    const appendTask = this.appendQueue.then(() => appendJsonLine(this.manifestPath, serializeConversationBoundaryManifestRecord(record)));
    this.appendQueue = appendTask.catch(() => undefined);
    await appendTask;
    return record;
  }

  async list(options: ConversationBoundaryManifestListOptions = {}): Promise<ConversationBoundaryManifestRecord[]> {
    const result = await readConversationBoundaryManifest(this.manifestPath);
    return filterRecords(result.records, options);
  }

  async read(): Promise<ConversationBoundaryManifestReadResult> {
    return readConversationBoundaryManifest(this.manifestPath);
  }

  async findLatest(options: ConversationBoundaryManifestListOptions = {}): Promise<ConversationBoundaryManifestRecord | undefined> {
    return findLatestConversationBoundaryManifestRecord(await this.list(options));
  }
}

export function createConversationBoundaryManifestRecord(
  input: ConversationBoundaryManifestInput,
  now: () => string = nowIso
): ConversationBoundaryManifestRecord {
  const checkpointId = optionalNonEmpty(input.checkpointId ?? input.checkpoint?.id, "checkpoint id");
  const checkpointRef = optionalNonEmpty(input.checkpointRef ?? input.checkpoint?.ref, "checkpoint ref");
  const checkpointSource = input.checkpointSource ?? input.checkpoint?.source;
  const record: ConversationBoundaryManifestRecord = {
    sessionId: requireNonEmpty(input.sessionId, "session id"),
    runId: requireNonEmpty(input.runId, "run id"),
    userMessageId: requireNonEmpty(input.userMessageId, "user message id"),
    eventSequence: requireEventSequence(input.eventSequence),
    workspaceRoot: resolve(requireNonEmpty(input.workspaceRoot, "workspace root")),
    changedPaths: normalizeChangedPaths(input.workspaceRoot, input.changedPaths ?? []),
    createdAt: input.createdAt ?? now(),
    ...(input.sessionTreeLeafIdBefore !== undefined
      ? { sessionTreeLeafIdBefore: optionalNonEmpty(input.sessionTreeLeafIdBefore, "session tree leaf id before") }
      : {}),
    ...(input.sessionTreeLeafIdAfter !== undefined
      ? { sessionTreeLeafIdAfter: optionalNonEmpty(input.sessionTreeLeafIdAfter, "session tree leaf id after") }
      : {}),
    ...(input.runtimeLeafIdBefore !== undefined
      ? { runtimeLeafIdBefore: optionalNonEmpty(input.runtimeLeafIdBefore, "runtime leaf id before") }
      : {}),
    ...(input.runtimeLeafIdAfter !== undefined
      ? { runtimeLeafIdAfter: optionalNonEmpty(input.runtimeLeafIdAfter, "runtime leaf id after") }
      : {}),
    ...(checkpointId !== undefined ? { checkpointId } : {}),
    ...(checkpointRef !== undefined ? { checkpointRef } : {}),
    ...(checkpointSource !== undefined ? { checkpointSource } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
  };
  return validateConversationBoundaryManifestRecord(record);
}

export function serializeConversationBoundaryManifestRecord(record: ConversationBoundaryManifestRecord): string {
  return JSON.stringify(validateConversationBoundaryManifestRecord(record));
}

export function parseConversationBoundaryManifestRecord(value: string): ConversationBoundaryManifestRecord {
  const parsed = JSON.parse(value) as unknown;
  return validateConversationBoundaryManifestRecord(parsed);
}

export function validateConversationBoundaryManifestRecord(value: unknown): ConversationBoundaryManifestRecord {
  if (!isJsonObject(value)) {
    throw new Error("conversation boundary manifest record must be a JSON object");
  }

  const workspaceRoot = requireNonEmpty(jsonString(value.workspaceRoot), "workspace root");
  const record: ConversationBoundaryManifestRecord = {
    sessionId: requireNonEmpty(jsonString(value.sessionId), "session id"),
    runId: requireNonEmpty(jsonString(value.runId), "run id"),
    userMessageId: requireNonEmpty(jsonString(value.userMessageId), "user message id"),
    eventSequence: requireEventSequence(jsonNumber(value.eventSequence)),
    workspaceRoot: resolve(workspaceRoot),
    changedPaths: normalizeChangedPaths(workspaceRoot, jsonStringArray(value.changedPaths, "changed paths")),
    createdAt: requireIsoLike(jsonString(value.createdAt), "created at"),
    ...(value.sessionTreeLeafIdBefore !== undefined
      ? { sessionTreeLeafIdBefore: optionalNonEmpty(jsonString(value.sessionTreeLeafIdBefore), "session tree leaf id before") }
      : {}),
    ...(value.sessionTreeLeafIdAfter !== undefined
      ? { sessionTreeLeafIdAfter: optionalNonEmpty(jsonString(value.sessionTreeLeafIdAfter), "session tree leaf id after") }
      : {}),
    ...(value.runtimeLeafIdBefore !== undefined
      ? { runtimeLeafIdBefore: optionalNonEmpty(jsonString(value.runtimeLeafIdBefore), "runtime leaf id before") }
      : {}),
    ...(value.runtimeLeafIdAfter !== undefined
      ? { runtimeLeafIdAfter: optionalNonEmpty(jsonString(value.runtimeLeafIdAfter), "runtime leaf id after") }
      : {}),
    ...(value.checkpointId !== undefined ? { checkpointId: optionalNonEmpty(jsonString(value.checkpointId), "checkpoint id") } : {}),
    ...(value.checkpointRef !== undefined ? { checkpointRef: optionalNonEmpty(jsonString(value.checkpointRef), "checkpoint ref") } : {}),
    ...(value.checkpointSource !== undefined
      ? { checkpointSource: requireCheckpointSource(jsonString(value.checkpointSource)) }
      : {}),
    ...(value.metadata !== undefined ? { metadata: requireJsonObject(value.metadata, "metadata") } : {})
  };
  return record;
}

export async function readConversationBoundaryManifest(manifestPath: string): Promise<ConversationBoundaryManifestReadResult> {
  const text = await readFile(resolve(manifestPath), "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const records: ConversationBoundaryManifestRecord[] = [];
  const invalidRecords: ConversationBoundaryManifestInvalidRecord[] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    try {
      records.push(parseConversationBoundaryManifestRecord(trimmed));
    } catch (error) {
      invalidRecords.push({
        line: index + 1,
        reason: error instanceof Error ? error.message : "invalid manifest record",
        text: line
      });
    }
  });

  return { records, invalidRecords };
}

export function findLatestConversationBoundaryManifestRecord(
  records: ConversationBoundaryManifestRecord[],
  options: ConversationBoundaryManifestListOptions = {}
): ConversationBoundaryManifestRecord | undefined {
  const filtered = filterRecords(records, options);
  return filtered
    .slice()
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.eventSequence - left.eventSequence ||
        right.userMessageId.localeCompare(left.userMessageId)
    )[0];
}

export function conversationBoundaryManifestRecordToRewindTargetFacts(
  record: ConversationBoundaryManifestRecord,
  mode: ConversationRewindBoundaryTargetMode = "keep-user-message"
): ConversationRewindBoundaryTargetFacts {
  const targetSuffix = mode === "remove-user-message" ? "Before" : "After";
  const sessionTreeTargetLeafId = record[`sessionTreeLeafId${targetSuffix}` as const];
  const runtimeTargetLeafId = record[`runtimeLeafId${targetSuffix}` as const];
  return {
    sessionId: record.sessionId,
    runId: record.runId,
    userMessageId: record.userMessageId,
    mode,
    eventSequence: record.eventSequence,
    workspaceRoot: record.workspaceRoot,
    changedPaths: [...record.changedPaths],
    createdAt: record.createdAt,
    ...(sessionTreeTargetLeafId !== undefined ? { sessionTreeTargetLeafId } : {}),
    ...(runtimeTargetLeafId !== undefined ? { runtimeTargetLeafId } : {}),
    ...(record.checkpointId !== undefined ? { checkpointId: record.checkpointId } : {}),
    ...(record.checkpointRef !== undefined ? { checkpointRef: record.checkpointRef } : {}),
    ...(record.checkpointSource !== undefined ? { checkpointSource: record.checkpointSource } : {}),
    ...(record.metadata !== undefined ? { metadata: record.metadata } : {})
  };
}

async function appendJsonLine(path: string, line: string): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.writeFile(`${line}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(dirname(path));
}

async function fsyncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best-effort on Windows and some filesystems.
  }
}

function filterRecords(
  records: ConversationBoundaryManifestRecord[],
  options: ConversationBoundaryManifestListOptions
): ConversationBoundaryManifestRecord[] {
  return records.filter(
    (record) =>
      (options.sessionId === undefined || record.sessionId === options.sessionId) &&
      (options.runId === undefined || record.runId === options.runId) &&
      (options.userMessageId === undefined || record.userMessageId === options.userMessageId)
  );
}

function normalizeChangedPaths(workspaceRoot: string, changedPaths: string[]): string[] {
  const root = resolve(workspaceRoot);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of changedPaths) {
    const value = requireNonEmpty(path, "changed path");
    const candidate = resolve(root, value);
    assertInside(root, candidate, "changed path");
    const relativePath = candidate.slice(root.length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (!seen.has(relativePath)) {
      seen.add(relativePath);
      normalized.push(relativePath);
    }
  }
  return normalized.sort();
}

function assertInside(root: string, candidate: string, label: string): void {
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`${label} escapes workspace root`);
  }
}

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function requireNonEmpty(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function optionalNonEmpty(value: string | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmpty(value, label);
}

function requireEventSequence(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("event sequence must be a non-negative integer");
  }
  return value;
}

function requireIsoLike(value: string | undefined, label: string): string {
  const normalized = requireNonEmpty(value, label);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return normalized;
}

function requireCheckpointSource(value: string | undefined): ConversationBoundaryCheckpointSource {
  if (value === "runtime" || value === "tool" || value === "external" || value === "unknown") {
    return value;
  }
  throw new Error("checkpoint source must be runtime, tool, external, or unknown");
}

function jsonString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function jsonNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function jsonStringArray(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

function requireJsonObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}


