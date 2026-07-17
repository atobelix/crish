import { mkdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { isNodeError, JsonlAppendBatcher } from "@crish/shared-utils";
import type { ConversationBoundaryCheckpointSource, ConversationBoundaryManifestRecord } from "./conversation-boundary-manifest";
import type { GitCheckpoint, GitCheckpointToolCall } from "./git-versioning";
import { nowIso } from "./session";
import type { JsonObject, JsonValue } from "@crish/shared-types";

export type CheckpointManifestSource = ConversationBoundaryCheckpointSource;

export interface CheckpointManifestToolCall {
  id?: string;
  toolName?: string;
  actor?: string;
  sessionId?: string;
  targetSummary?: string;
}

export interface CheckpointManifestCheckpointRef {
  id?: string;
  ref?: string;
  refName?: string;
  manifestPath?: string;
  source?: CheckpointManifestSource;
  repositoryRoot?: string;
  workspaceRoot?: string;
  toolCall?: GitCheckpointToolCall;
}

export interface CheckpointManifestRecord {
  sessionId: string;
  runId: string;
  userMessageId: string;
  toolCall?: CheckpointManifestToolCall;
  checkpointId: string;
  checkpointRef: string;
  workspaceRoot: string;
  changedPaths: string[];
  source: CheckpointManifestSource;
  createdAt: string;
  metadata?: JsonObject;
}

export interface CheckpointManifestInput {
  sessionId: string;
  runId: string;
  userMessageId: string;
  toolCall?: CheckpointManifestToolCall;
  checkpoint?: CheckpointManifestCheckpointRef | GitCheckpoint;
  checkpointId?: string;
  checkpointRef?: string;
  workspaceRoot?: string;
  changedPaths?: string[];
  source?: CheckpointManifestSource;
  createdAt?: string;
  metadata?: JsonObject;
}

export interface CheckpointManifestServiceOptions {
  manifestPath: string;
  now?: () => string;
}

export interface CheckpointManifestListOptions {
  sessionId?: string;
  runId?: string;
  userMessageId?: string;
  checkpointId?: string;
}

export interface CheckpointRewindBoundaryLookupOptions {
  sessionId: string;
  userMessageId: string;
}

export interface CheckpointManifestReadResult {
  records: CheckpointManifestRecord[];
  invalidRecords: CheckpointManifestInvalidRecord[];
}

export interface CheckpointManifestInvalidRecord {
  line: number;
  reason: string;
  text: string;
}

export class CheckpointManifestService {
  private readonly manifestPath: string;
  private readonly now: () => string;
  private appendQueue: Promise<void> = Promise.resolve();
  private appendBatcher: JsonlAppendBatcher | undefined;

  constructor(options: CheckpointManifestServiceOptions) {
    this.manifestPath = resolve(options.manifestPath);
    this.now = options.now ?? nowIso;
  }

  async append(input: CheckpointManifestInput): Promise<CheckpointManifestRecord> {
    const record = createCheckpointManifestRecord(input, this.now);
    const appendTask = this.appendQueue.then(async () => {
      const batcher = await this.ensureAppendBatcher();
      await batcher.append(serializeCheckpointManifestRecord(record));
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

  async list(options: CheckpointManifestListOptions = {}): Promise<CheckpointManifestRecord[]> {
    await this.flushPendingAppends();
    const result = await readCheckpointManifest(this.manifestPath);
    return filterRecords(result.records, options);
  }

  async read(): Promise<CheckpointManifestReadResult> {
    await this.flushPendingAppends();
    return readCheckpointManifest(this.manifestPath);
  }

  async findLatest(options: CheckpointManifestListOptions = {}): Promise<CheckpointManifestRecord | undefined> {
    return findLatestCheckpointManifestRecord(await this.list(options));
  }

  async findLatestForRewindBoundary(
    options: CheckpointRewindBoundaryLookupOptions
  ): Promise<CheckpointManifestRecord | undefined> {
    return this.findLatest({ sessionId: options.sessionId, userMessageId: options.userMessageId });
  }
}

export function createCheckpointManifestRecord(
  input: CheckpointManifestInput,
  now: () => string = nowIso
): CheckpointManifestRecord {
  const checkpointId = requireNonEmpty(input.checkpointId ?? input.checkpoint?.id, "checkpoint id");
  const checkpointRef = requireNonEmpty(checkpointRefFromInput(input), "checkpoint ref");
  const workspaceRoot = workspaceRootFromInput(input);
  const source = input.source ?? checkpointSourceFromInput(input.checkpoint) ?? "unknown";
  const toolCall = input.toolCall ?? input.checkpoint?.toolCall;
  const record: CheckpointManifestRecord = {
    sessionId: requireNonEmpty(input.sessionId, "session id"),
    runId: requireNonEmpty(input.runId, "run id"),
    userMessageId: requireNonEmpty(input.userMessageId, "user message id"),
    checkpointId,
    checkpointRef,
    workspaceRoot,
    changedPaths: normalizeChangedPaths(workspaceRoot, input.changedPaths ?? []),
    source: requireCheckpointSource(source),
    createdAt: input.createdAt ?? now(),
    ...(toolCall !== undefined ? { toolCall: validateToolCall(toolCall) } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
  };
  return validateCheckpointManifestRecord(record);
}

export function createCheckpointManifestInputFromBoundary(
  boundary: ConversationBoundaryManifestRecord,
  overrides: Partial<CheckpointManifestInput> = {}
): CheckpointManifestInput {
  return {
    sessionId: boundary.sessionId,
    runId: boundary.runId,
    userMessageId: boundary.userMessageId,
    checkpointId: boundary.checkpointId,
    checkpointRef: boundary.checkpointRef,
    workspaceRoot: boundary.workspaceRoot,
    changedPaths: boundary.changedPaths,
    source: boundary.checkpointSource,
    createdAt: boundary.createdAt,
    metadata: boundary.metadata,
    ...overrides
  };
}

export function serializeCheckpointManifestRecord(record: CheckpointManifestRecord): string {
  return JSON.stringify(validateCheckpointManifestRecord(record));
}

export function parseCheckpointManifestRecord(value: string): CheckpointManifestRecord {
  const parsed = JSON.parse(value) as unknown;
  return validateCheckpointManifestRecord(parsed);
}

export function validateCheckpointManifestRecord(value: unknown): CheckpointManifestRecord {
  if (!isJsonObject(value)) {
    throw new Error("checkpoint manifest record must be a JSON object");
  }

  const workspaceRoot = resolve(requireNonEmpty(jsonString(value.workspaceRoot), "workspace root"));
  const record: CheckpointManifestRecord = {
    sessionId: requireNonEmpty(jsonString(value.sessionId), "session id"),
    runId: requireNonEmpty(jsonString(value.runId), "run id"),
    userMessageId: requireNonEmpty(jsonString(value.userMessageId), "user message id"),
    checkpointId: requireNonEmpty(jsonString(value.checkpointId), "checkpoint id"),
    checkpointRef: requireNonEmpty(jsonString(value.checkpointRef), "checkpoint ref"),
    workspaceRoot,
    changedPaths: normalizeChangedPaths(workspaceRoot, jsonStringArray(value.changedPaths, "changed paths")),
    source: requireCheckpointSource(jsonString(value.source)),
    createdAt: requireIsoLike(jsonString(value.createdAt), "created at"),
    ...(value.toolCall !== undefined ? { toolCall: validateToolCall(value.toolCall) } : {}),
    ...(value.metadata !== undefined ? { metadata: requireJsonObject(value.metadata, "metadata") } : {})
  };
  return record;
}

export async function readCheckpointManifest(manifestPath: string): Promise<CheckpointManifestReadResult> {
  const text = await readFile(resolve(manifestPath), "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const records: CheckpointManifestRecord[] = [];
  const invalidRecords: CheckpointManifestInvalidRecord[] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    try {
      records.push(parseCheckpointManifestRecord(trimmed));
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

export function findLatestCheckpointManifestRecord(
  records: CheckpointManifestRecord[],
  options: CheckpointManifestListOptions = {}
): CheckpointManifestRecord | undefined {
  const filtered = filterRecords(records, options);
  return filtered
    .slice()
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.userMessageId.localeCompare(left.userMessageId) ||
        right.checkpointId.localeCompare(left.checkpointId)
    )[0];
}

export function checkpointManifestRecordToRewindRestoreFacts(record: CheckpointManifestRecord): JsonObject {
  return {
    sessionId: record.sessionId,
    runId: record.runId,
    userMessageId: record.userMessageId,
    checkpointId: record.checkpointId,
    checkpointRef: record.checkpointRef,
    workspaceRoot: record.workspaceRoot,
    changedPaths: record.changedPaths,
    source: record.source,
    createdAt: record.createdAt
  };
}

function filterRecords(records: CheckpointManifestRecord[], options: CheckpointManifestListOptions): CheckpointManifestRecord[] {
  return records.filter(
    (record) =>
      (options.sessionId === undefined || record.sessionId === options.sessionId) &&
      (options.runId === undefined || record.runId === options.runId) &&
      (options.userMessageId === undefined || record.userMessageId === options.userMessageId) &&
      (options.checkpointId === undefined || record.checkpointId === options.checkpointId)
  );
}

function checkpointRefFromInput(input: CheckpointManifestInput): string | undefined {
  const checkpoint = input.checkpoint;
  return (
    input.checkpointRef ??
    checkpointStringProperty(checkpoint, "ref") ??
    checkpointStringProperty(checkpoint, "refName") ??
    checkpointStringProperty(checkpoint, "manifestPath")
  );
}

function workspaceRootFromInput(input: CheckpointManifestInput): string {
  const checkpoint = input.checkpoint;
  const workspaceRoot =
    input.workspaceRoot ??
    checkpointStringProperty(checkpoint, "workspaceRoot") ??
    checkpointStringProperty(checkpoint, "repositoryRoot");
  return resolve(
    requireNonEmpty(workspaceRoot, "workspace root")
  );
}

function checkpointSourceFromInput(checkpoint: CheckpointManifestInput["checkpoint"]): CheckpointManifestSource | undefined {
  const source = checkpointStringProperty(checkpoint, "source");
  return source === undefined ? undefined : requireCheckpointSource(source);
}

function checkpointStringProperty(checkpoint: CheckpointManifestInput["checkpoint"], key: string): string | undefined {
  if (!checkpoint || !(key in checkpoint)) {
    return undefined;
  }
  const value = (checkpoint as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeChangedPaths(workspaceRoot: string, changedPaths: string[]): string[] {
  const root = resolve(workspaceRoot);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of changedPaths) {
    const value = requireNonEmpty(path, "changed path");
    const candidate = resolve(root, value);
    assertInside(root, candidate, "changed path");
    const relativePath = relative(root, candidate).replace(/\\/g, "/");
    if (relativePath.length === 0) {
      continue;
    }
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

function validateToolCall(value: unknown): CheckpointManifestToolCall {
  if (!isJsonObject(value)) {
    throw new Error("tool call must be a JSON object");
  }
  return {
    ...(value.id !== undefined ? { id: optionalNonEmpty(jsonString(value.id), "tool call id") } : {}),
    ...(value.toolName !== undefined ? { toolName: optionalNonEmpty(jsonString(value.toolName), "tool call tool name") } : {}),
    ...(value.actor !== undefined ? { actor: optionalNonEmpty(jsonString(value.actor), "tool call actor") } : {}),
    ...(value.sessionId !== undefined ? { sessionId: optionalNonEmpty(jsonString(value.sessionId), "tool call session id") } : {}),
    ...(value.targetSummary !== undefined
      ? { targetSummary: optionalNonEmpty(jsonString(value.targetSummary), "tool call target summary") }
      : {})
  };
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

function requireIsoLike(value: string | undefined, label: string): string {
  const normalized = requireNonEmpty(value, label);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return normalized;
}

function requireCheckpointSource(value: string | undefined): CheckpointManifestSource {
  if (value === "runtime" || value === "tool" || value === "external" || value === "unknown") {
    return value;
  }
  throw new Error("checkpoint source must be runtime, tool, external, or unknown");
}

function jsonString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
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


