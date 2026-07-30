import {
  mkdir,
  readFile,
  rename,
  stat as statFile,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { AsyncMutex, isNodeError } from '@crish/shared-utils';
import { JsonlAppendBatcher } from '@crish/shared-utils/node';
import type {
  ConversationBoundaryCheckpointSource,
  ConversationBoundaryManifestRecord,
} from './conversation-boundary-manifest';
import { nowIso } from './session';
import type {
  GitCheckpoint,
  GitCheckpointToolCall,
  JsonObject,
  JsonValue,
} from '@crish/shared-types';
import { CrishError } from '@crish/shared-types';

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
  stats: CheckpointManifestStats;
}

export interface CheckpointManifestStats {
  /** 已成功解析的记录总数（含已 tombstone 软删除的条目）。 */
  totalRecords: number;
  /** tombstone 软删除记录数。 */
  deletedRecords: number;
}

export interface CheckpointManifestInvalidRecord {
  line: number;
  reason: string;
  text: string;
}

/**
 * tombstone 软删除记录。
 *
 * 由于 manifest 记录没有单一 id 字段，tombstone 携带记录的唯一复合键
 * (sessionId, runId, userMessageId, checkpointId) 用于精确匹配待删除条目。
 * reader 解析时维护已删除键集合，跳过任何匹配的活跃记录。
 */
interface CheckpointManifestTombstone {
  type: 'delete';
  sessionId: string;
  runId: string;
  userMessageId: string;
  checkpointId: string;
  deletedAt: string;
}

export class CheckpointManifestService {
  /**
   * 软删除记录占文件总记录数的比例达到该阈值时触发 compaction。
   * 30% 是经验值：低于此比例 compaction 收益有限，高于则文件膨胀明显。
   */
  private static readonly COMPACTION_RATIO_THRESHOLD = 0.3;
  /**
   * 软删除记录绝对数量下限。小文件即使比例高也不 compaction，
   * 避免在低基数下频繁重写的开销超过收益。
   */
  private static readonly COMPACTION_MIN_DELETED_RECORDS = 100;

  private readonly manifestPath: string;
  private readonly now: () => string;
  private readonly mutex = new AsyncMutex();
  private appendBatcher: JsonlAppendBatcher | undefined;
  private cachedResult: CheckpointManifestReadResult | undefined;
  private cachedMtimeMs: number | undefined;

  constructor(options: CheckpointManifestServiceOptions) {
    this.manifestPath = resolve(options.manifestPath);
    this.now = options.now ?? nowIso;
  }

  async append(
    input: CheckpointManifestInput
  ): Promise<CheckpointManifestRecord> {
    return this.mutex.runExclusive(async () => {
      const record = createCheckpointManifestRecord(input, this.now);
      const batcher = await this.ensureAppendBatcher();
      await batcher.append(serializeCheckpointManifestRecord(record));
      // 同步持久化语义：调用方依赖 append 返回后数据已落盘（例如跨进程/跨实例读取）。
      // batcher 仍提供 FileHandle 缓存 + 集中化换行/目录 fsync 收益。
      await batcher.flush();
      // 同步失效缓存：在 append 返回前清空缓存，关闭
      // "append 返回 → invalidateCache" 之间的竞态窗口，
      // 避免并发读取命中旧缓存。
      this.invalidateCache();
      return record;
    });
  }

  /**
   * 软删除所有匹配 options 的记录。
   *
   * 为每个匹配记录追加一条 tombstone（携带复合键），不物理删除文件内容。
   * tombstone 落盘后评估 compaction 阈值，必要时原子重写文件回收空间。
   * 返回被软删除的记录数（未含已被先前 tombstone 标记的记录）。
   */
  async delete(options: CheckpointManifestListOptions = {}): Promise<number> {
    return this.mutex.runExclusive(async () => {
      const result = await this.readWithCache();
      const matching = filterRecords(result.records, options);
      if (matching.length === 0) return 0;
      const tombstones = matching.map((record) =>
        serializeCheckpointTombstone({
          type: 'delete',
          sessionId: record.sessionId,
          runId: record.runId,
          userMessageId: record.userMessageId,
          checkpointId: record.checkpointId,
          deletedAt: this.now(),
        })
      );
      const batcher = await this.ensureAppendBatcher();
      for (const line of tombstones) {
        await batcher.append(line);
      }
      await batcher.flush();
      this.invalidateCache();
      // tombstone 落盘后再评估 compaction：基于最新文件统计决定是否重写。
      await this.maybeCompact();
      return matching.length;
    });
  }

  /**
   * 释放持久化的追加句柄。
   *
   * 正常运行期间 append() 会复用同一个文件句柄以提升吞吐，
   * 在关闭/卸载场景下应调用此方法确保句柄被释放。
   */
  async close(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await this.releaseAppendHandle();
    });
  }

  private async releaseAppendHandle(): Promise<void> {
    if (this.appendBatcher) {
      try {
        await this.appendBatcher.close();
      } catch {
        // silent: close error ignored
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
      this.appendBatcher = new JsonlAppendBatcher({
        filePath: this.manifestPath,
      });
    }
    return this.appendBatcher;
  }

  private invalidateCache(): void {
    this.cachedResult = undefined;
    this.cachedMtimeMs = undefined;
  }

  async list(
    options: CheckpointManifestListOptions = {}
  ): Promise<CheckpointManifestRecord[]> {
    const result = await this.readWithCache();
    return filterRecords(result.records, options);
  }

  async read(): Promise<CheckpointManifestReadResult> {
    return this.readWithCache();
  }

  async findLatest(
    options: CheckpointManifestListOptions = {}
  ): Promise<CheckpointManifestRecord | undefined> {
    return findLatestCheckpointManifestRecord(await this.list(options));
  }

  async findLatestForRewindBoundary(
    options: CheckpointRewindBoundaryLookupOptions
  ): Promise<CheckpointManifestRecord | undefined> {
    return this.findLatest({
      sessionId: options.sessionId,
      userMessageId: options.userMessageId,
    });
  }

  /**
   * 读取并缓存 manifest 全量解析结果。
   *
   * 以 stat().mtimeMs 作为缓存失效判据：若文件未变更则直接返回缓存，
   * 避免 list/read 反复读全文件。append()/delete() 写入后会显式置失效，
   * 覆盖同一毫秒内多次写入导致 mtimeMs 相同的边界情况。缓存 miss 时
   * 先 flush batcher 确保 pending 数据落盘后再 stat，使 mtimeMs 与
   * 文件实际内容一致。
   */
  private async readWithCache(): Promise<CheckpointManifestReadResult> {
    // 先 flush pending appends，确保文件反映所有写入后再 stat。
    // 这样 mtimeMs 判据与文件实际内容一致，避免读到旧 mtime 命中缓存。
    if (this.appendBatcher) {
      await this.appendBatcher.flush();
    }
    const stat = await statFile(this.manifestPath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (!stat) {
      const emptyResult: CheckpointManifestReadResult = {
        records: [],
        invalidRecords: [],
        stats: { totalRecords: 0, deletedRecords: 0 },
      };
      this.cachedResult = emptyResult;
      this.cachedMtimeMs = undefined;
      return emptyResult;
    }
    if (
      this.cachedResult !== undefined &&
      this.cachedMtimeMs === stat.mtimeMs
    ) {
      return this.cachedResult;
    }
    const result = await readCheckpointManifest(this.manifestPath);
    this.cachedResult = result;
    this.cachedMtimeMs = stat.mtimeMs;
    return result;
  }

  /**
   * 软删除累积达到阈值时触发 compaction，重写文件只保留活跃 records。
   *
   * 动机：delete() 以 tombstone 形式追加到 JSONL 文件，长会话下 tombstone
   * 累积导致文件膨胀、readWithCache 解析大量无效行、内存缓存承载历史负担。
   * compaction 把所有未删除 records 原子重写到原文件，回收空间。
   *
   * 阈值：deletedRecords >= 100 且 deletedRecords/totalRecords >= 0.3。
   * 小文件不触发，避免频繁 compaction 的开销超过收益。
   */
  private async maybeCompact(): Promise<void> {
    // delete() 的 append 已 invalidate 缓存，此处重新读取以获取
    // 包含最新 tombstone 的统计。
    const result = await this.readWithCache();
    const stats = result.stats;
    if (stats.totalRecords === 0) return;
    const ratio = stats.deletedRecords / stats.totalRecords;
    if (
      stats.deletedRecords >=
        CheckpointManifestService.COMPACTION_MIN_DELETED_RECORDS &&
      ratio >= CheckpointManifestService.COMPACTION_RATIO_THRESHOLD
    ) {
      await this.compactRecords();
    }
  }

  /**
   * 重写文件只保留未删除 records。
   *
   * 通过 appendQueue 串行化，确保 compaction 期间无并发 append。
   * 使用 tmp + rename 原子覆写，崩溃时要么旧文件完整、要么新文件完整。
   * compaction 后必须释放 appendBatcher：rename 后旧 fd 指向被覆写的 inode，
   * 后续 append 必须重新打开新文件；同时重置缓存强制下次读取 compacted 文件。
   */
  private async compactRecords(): Promise<void> {
    // readWithCache 内部会 flush pending tombstone，确保读到完整文件
    const result = await this.readWithCache();
    // 原子写入 tmp + rename 覆盖原文件
    const tmpPath = `${this.manifestPath}.compact-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await mkdir(dirname(tmpPath), { recursive: true });
    const content =
      result.records.length > 0
        ? `${result.records.map((record) => serializeCheckpointManifestRecord(record)).join('\n')}\n`
        : '';
    try {
      await writeFile(tmpPath, content, 'utf8');
      await rename(tmpPath, this.manifestPath);
    } catch (error) {
      // rename 失败时清理 tmp 残留，避免污染工作区
      // silent: cleanup on rename failure
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
    // rename 成功后旧 appendBatcher 的 fd 指向被覆写的 inode，必须释放
    await this.releaseAppendHandle();
    // 重置缓存，强制下次 readWithCache 读取 compacted 文件
    this.invalidateCache();
  }
}

export function createCheckpointManifestRecord(
  input: CheckpointManifestInput,
  now: () => string = nowIso
): CheckpointManifestRecord {
  const checkpointId = requireNonEmpty(
    input.checkpointId ?? input.checkpoint?.id,
    'checkpoint id'
  );
  const checkpointRef = requireNonEmpty(
    checkpointRefFromInput(input),
    'checkpoint ref'
  );
  const workspaceRoot = workspaceRootFromInput(input);
  const source =
    input.source ?? checkpointSourceFromInput(input.checkpoint) ?? 'unknown';
  const toolCall = input.toolCall ?? input.checkpoint?.toolCall;
  const record: CheckpointManifestRecord = {
    sessionId: requireNonEmpty(input.sessionId, 'session id'),
    runId: requireNonEmpty(input.runId, 'run id'),
    userMessageId: requireNonEmpty(input.userMessageId, 'user message id'),
    checkpointId,
    checkpointRef,
    workspaceRoot,
    changedPaths: normalizeChangedPaths(
      workspaceRoot,
      input.changedPaths ?? []
    ),
    source: requireCheckpointSource(source),
    createdAt: input.createdAt ?? now(),
    ...(toolCall !== undefined ? { toolCall: validateToolCall(toolCall) } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
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
    workspaceRoot: boundary.workspaceRoot,
    changedPaths: boundary.changedPaths,
    createdAt: boundary.createdAt,
    ...(boundary.checkpointId !== undefined
      ? { checkpointId: boundary.checkpointId }
      : {}),
    ...(boundary.checkpointRef !== undefined
      ? { checkpointRef: boundary.checkpointRef }
      : {}),
    ...(boundary.checkpointSource !== undefined
      ? { source: boundary.checkpointSource }
      : {}),
    ...(boundary.metadata !== undefined ? { metadata: boundary.metadata } : {}),
    ...overrides,
  };
}

export function serializeCheckpointManifestRecord(
  record: CheckpointManifestRecord
): string {
  return JSON.stringify(validateCheckpointManifestRecord(record));
}

export function parseCheckpointManifestRecord(
  value: string
): CheckpointManifestRecord {
  const parsed = JSON.parse(value) as unknown;
  return validateCheckpointManifestRecord(parsed);
}

export function validateCheckpointManifestRecord(
  value: unknown
): CheckpointManifestRecord {
  if (!isJsonObject(value)) {
    throw new CrishError(
      'checkpoint manifest record must be a JSON object',
      'CHECKPOINT_ERROR',
      'permanent',
      false
    );
  }

  const workspaceRoot = resolve(
    requireNonEmpty(jsonString(value.workspaceRoot), 'workspace root')
  );
  const record: CheckpointManifestRecord = {
    sessionId: requireNonEmpty(jsonString(value.sessionId), 'session id'),
    runId: requireNonEmpty(jsonString(value.runId), 'run id'),
    userMessageId: requireNonEmpty(
      jsonString(value.userMessageId),
      'user message id'
    ),
    checkpointId: requireNonEmpty(
      jsonString(value.checkpointId),
      'checkpoint id'
    ),
    checkpointRef: requireNonEmpty(
      jsonString(value.checkpointRef),
      'checkpoint ref'
    ),
    workspaceRoot,
    changedPaths: normalizeChangedPaths(
      workspaceRoot,
      jsonStringArray(value.changedPaths, 'changed paths')
    ),
    source: requireCheckpointSource(jsonString(value.source)),
    createdAt: requireIsoLike(jsonString(value.createdAt), 'created at'),
    ...(value.toolCall !== undefined
      ? { toolCall: validateToolCall(value.toolCall) }
      : {}),
    ...(value.metadata !== undefined
      ? { metadata: requireJsonObject(value.metadata, 'metadata') }
      : {}),
  };
  return record;
}

export async function readCheckpointManifest(
  manifestPath: string
): Promise<CheckpointManifestReadResult> {
  const text = await readFile(resolve(manifestPath), 'utf8').catch(
    (error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  );
  const records: CheckpointManifestRecord[] = [];
  const invalidRecords: CheckpointManifestInvalidRecord[] = [];
  const deletedKeys = new Set<string>();
  let totalRecords = 0;
  let deletedRecords = 0;
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      invalidRecords.push({
        line: index + 1,
        reason:
          error instanceof Error ? error.message : 'invalid manifest record',
        text: line,
      });
      return;
    }
    // 识别 tombstone：不计入 invalidRecords，仅维护已删除键集合。
    // tombstone 可能出现在对应活跃记录之前或之后，reader 统一按复合键
    // 标记删除，并在追加活跃记录时跳过已删除键。
    if (isCheckpointManifestTombstone(parsed)) {
      totalRecords += 1;
      deletedRecords += 1;
      deletedKeys.add(
        checkpointRecordKey(
          parsed.sessionId,
          parsed.runId,
          parsed.userMessageId,
          parsed.checkpointId
        )
      );
      return;
    }
    try {
      const record = validateCheckpointManifestRecord(parsed);
      if (
        deletedKeys.has(
          checkpointRecordKey(
            record.sessionId,
            record.runId,
            record.userMessageId,
            record.checkpointId
          )
        )
      ) {
        // 已被 tombstone 标记的活跃记录跳过（避免无效条目污染 list/read 结果）
        return;
      }
      records.push(record);
      totalRecords += 1;
    } catch (error) {
      invalidRecords.push({
        line: index + 1,
        reason:
          error instanceof Error ? error.message : 'invalid manifest record',
        text: line,
      });
    }
  });

  return { records, invalidRecords, stats: { totalRecords, deletedRecords } };
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

export function checkpointManifestRecordToRewindRestoreFacts(
  record: CheckpointManifestRecord
): JsonObject {
  return {
    sessionId: record.sessionId,
    runId: record.runId,
    userMessageId: record.userMessageId,
    checkpointId: record.checkpointId,
    checkpointRef: record.checkpointRef,
    workspaceRoot: record.workspaceRoot,
    changedPaths: record.changedPaths,
    source: record.source,
    createdAt: record.createdAt,
  };
}

function filterRecords(
  records: CheckpointManifestRecord[],
  options: CheckpointManifestListOptions
): CheckpointManifestRecord[] {
  return records.filter(
    (record) =>
      (options.sessionId === undefined ||
        record.sessionId === options.sessionId) &&
      (options.runId === undefined || record.runId === options.runId) &&
      (options.userMessageId === undefined ||
        record.userMessageId === options.userMessageId) &&
      (options.checkpointId === undefined ||
        record.checkpointId === options.checkpointId)
  );
}

function serializeCheckpointTombstone(
  tombstone: CheckpointManifestTombstone
): string {
  return JSON.stringify(tombstone);
}

function isCheckpointManifestTombstone(
  value: unknown
): value is CheckpointManifestTombstone {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === 'delete' &&
    typeof record.sessionId === 'string' &&
    record.sessionId.length > 0 &&
    typeof record.runId === 'string' &&
    record.runId.length > 0 &&
    typeof record.userMessageId === 'string' &&
    record.userMessageId.length > 0 &&
    typeof record.checkpointId === 'string' &&
    record.checkpointId.length > 0 &&
    typeof record.deletedAt === 'string' &&
    record.deletedAt.length > 0
  );
}

/**
 * 复合键的稳定字符串表示，用于在 reader 中匹配 tombstone 与活跃记录。
 *
 * 使用 `\0` 作为分隔符以避免字段值中常见字符（如 `/`、`:`、`-`）造成碰撞。
 */
function checkpointRecordKey(
  sessionId: string,
  runId: string,
  userMessageId: string,
  checkpointId: string
): string {
  return `${sessionId}\0${runId}\0${userMessageId}\0${checkpointId}`;
}

function checkpointRefFromInput(
  input: CheckpointManifestInput
): string | undefined {
  const checkpoint = input.checkpoint;
  return (
    input.checkpointRef ??
    checkpointStringProperty(checkpoint, 'ref') ??
    checkpointStringProperty(checkpoint, 'refName') ??
    checkpointStringProperty(checkpoint, 'manifestPath')
  );
}

function workspaceRootFromInput(input: CheckpointManifestInput): string {
  const checkpoint = input.checkpoint;
  const workspaceRoot =
    input.workspaceRoot ??
    checkpointStringProperty(checkpoint, 'workspaceRoot') ??
    checkpointStringProperty(checkpoint, 'repositoryRoot');
  return resolve(requireNonEmpty(workspaceRoot, 'workspace root'));
}

function checkpointSourceFromInput(
  checkpoint: CheckpointManifestInput['checkpoint']
): CheckpointManifestSource | undefined {
  const source = checkpointStringProperty(checkpoint, 'source');
  return source === undefined ? undefined : requireCheckpointSource(source);
}

function checkpointStringProperty(
  checkpoint: CheckpointManifestInput['checkpoint'],
  key: string
): string | undefined {
  if (!checkpoint || !(key in checkpoint)) {
    return undefined;
  }
  const value = (checkpoint as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function normalizeChangedPaths(
  workspaceRoot: string,
  changedPaths: string[]
): string[] {
  const root = resolve(workspaceRoot);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of changedPaths) {
    const value = requireNonEmpty(path, 'changed path');
    const candidate = resolve(root, value);
    assertInside(root, candidate, 'changed path');
    const relativePath = relative(root, candidate).replace(/\\/g, '/');
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
  if (
    normalizedCandidate !== normalizedRoot &&
    !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new CrishError(
      `${label} escapes workspace root`,
      'CHECKPOINT_ERROR',
      'permanent',
      false
    );
  }
}

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function validateToolCall(value: unknown): CheckpointManifestToolCall {
  if (!isJsonObject(value)) {
    throw new CrishError(
      'tool call must be a JSON object',
      'CHECKPOINT_ERROR',
      'permanent',
      false
    );
  }
  const id =
    value.id !== undefined
      ? optionalNonEmpty(jsonString(value.id), 'tool call id')
      : undefined;
  const toolName =
    value.toolName !== undefined
      ? optionalNonEmpty(jsonString(value.toolName), 'tool call tool name')
      : undefined;
  const actor =
    value.actor !== undefined
      ? optionalNonEmpty(jsonString(value.actor), 'tool call actor')
      : undefined;
  const sessionId =
    value.sessionId !== undefined
      ? optionalNonEmpty(jsonString(value.sessionId), 'tool call session id')
      : undefined;
  const targetSummary =
    value.targetSummary !== undefined
      ? optionalNonEmpty(
          jsonString(value.targetSummary),
          'tool call target summary'
        )
      : undefined;
  return {
    ...(id !== undefined ? { id } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(actor !== undefined ? { actor } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(targetSummary !== undefined ? { targetSummary } : {}),
  };
}

function requireNonEmpty(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new CrishError(
      `${label} must be a non-empty string`,
      'CHECKPOINT_ERROR',
      'permanent',
      false
    );
  }
  return normalized;
}

function optionalNonEmpty(
  value: string | undefined,
  label: string
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmpty(value, label);
}

function requireIsoLike(value: string | undefined, label: string): string {
  const normalized = requireNonEmpty(value, label);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new CrishError(
      `${label} must be a valid timestamp`,
      'CHECKPOINT_ERROR',
      'permanent',
      false
    );
  }
  return normalized;
}

function requireCheckpointSource(
  value: string | undefined
): CheckpointManifestSource {
  if (
    value === 'runtime' ||
    value === 'tool' ||
    value === 'external' ||
    value === 'unknown'
  ) {
    return value;
  }
  throw new CrishError(
    'checkpoint source must be runtime, tool, external, or unknown',
    'CHECKPOINT_ERROR',
    'permanent',
    false
  );
}

function jsonString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function jsonStringArray(
  value: JsonValue | undefined,
  label: string
): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new CrishError(
      `${label} must be an array of strings`,
      'CHECKPOINT_ERROR',
      'permanent',
      false
    );
  }
  return value as string[];
}

function requireJsonObject(
  value: JsonValue | undefined,
  label: string
): JsonObject {
  if (!isJsonObject(value)) {
    throw new CrishError(
      `${label} must be a JSON object`,
      'CHECKPOINT_ERROR',
      'permanent',
      false
    );
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
