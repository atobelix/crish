import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { nowIso } from "./session";
import { isNodeError, JsonlAppendBatcher } from "@crish/shared-utils";
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
  private appendBatcher: JsonlAppendBatcher | undefined;

  constructor(options: ConversationBoundaryManifestServiceOptions) {
    this.manifestPath = resolve(options.manifestPath);
    this.now = options.now ?? nowIso;
  }

  async append(input: ConversationBoundaryManifestInput): Promise<ConversationBoundaryManifestRecord> {
    const record = createConversationBoundaryManifestRecord(input, this.now);
    const appendTask = this.appendQueue.then(async () => {
      const batcher = await this.ensureAppendBatcher();
      await batcher.append(serializeConversationBoundaryManifestRecord(record));
      // 同步持久化语义：调用方依赖 append 返回后数据已落盘（例如跨进程/跨实例读取）。
      // batcher 仍提供 FileHandle 缓存 + 集中化换行/目录 fsync 收益。
      await batcher.flush();
    });
    this.appendQueue = appendTask.catch(() => undefined);
    await appendTask;
    return record;
  }

  /**
   * 释放持久化的追加句柄。
   *
   * 正常运行期间 append() 会复用同一个文件句柄以提升吞吐，
   * 在关闭/卸载场景下应调用此方法确保句柄被释放。
   */
  async close(): Promise<void> {
    const closeTask = this.appendQueue.then(() => this.releaseAppendHandle());
    this.appendQueue = closeTask.catch(() => undefined);
    await closeTask;
  }

  private async releaseAppendHandle(): Promise<void> {
    if (this.appendBatcher) {
      try {
        await this.appendBatcher.close();
      } catch {
        // 忽略关闭错误
      }
      this.appendBatcher = undefined;
    }
  }

  /**
   * 懒初始化 JsonlAppendBatcher。
   *
   * batcher 内部缓存文件句柄、累积写入并批量 fsync，相比逐条 writeFile+sync
   * 显著提升吞吐。首行换行与目录 fsync 由 batcher 自身处理。
   */
  private async ensureAppendBatcher(): Promise<JsonlAppendBatcher> {
    if (!this.appendBatcher) {
      await mkdir(dirname(this.manifestPath), { recursive: true });
      this.appendBatcher = new JsonlAppendBatcher({ filePath: this.manifestPath });
    }
    return this.appendBatcher;
  }

  /**
   * 等待所有已入队的 append 落盘后再返回，确保后续读取看到完整数据。
   */
  private async flushPendingAppends(): Promise<void> {
    await this.appendQueue;
    await this.appendBatcher?.flush();
  }

  async list(options: ConversationBoundaryManifestListOptions = {}): Promise<ConversationBoundaryManifestRecord[]> {
    await this.flushPendingAppends();
    const result = await readConversationBoundaryManifest(this.manifestPath);
    return filterRecords(result.records, options);
  }

  async read(): Promise<ConversationBoundaryManifestReadResult> {
    await this.flushPendingAppends();
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


