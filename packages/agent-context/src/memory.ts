import {
  mkdir,
  readFile,
  rename,
  stat as statFile,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { decodeTextBuffer } from './encoding';
import { createId, nowIso } from './session';
import {
  AsyncMutex,
  BoundedMap,
  isNodeError,
  RingBuffer,
  IN_MEMORY_MEMORY_ENTRIES,
  toJsonValue,
} from '@crish/shared-utils';
import { JsonlAppendBatcher } from '@crish/shared-utils/node';
import type { JsonObject, JsonValue } from '@crish/shared-types';
import type { AgentTool } from '@crish/shared-types';

/**
 * Identity helper for tool definition.
 *
 * agent-context 是 Layer 2 leaf，不持有全局工具注册表（那是 runtime 层的职责）。
 * 此函数仅做类型检查并返回工具对象本身；运行时消费者可在装配时自行注册。
 */
function defineTool<T extends AgentTool>(tool: T): T {
  return tool;
}

export type MemoryScope = 'session' | 'project' | 'user';

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: JsonObject;
}

export interface MemorySearchOptions {
  query?: string;
  scope?: MemoryScope;
  tags?: string[];
  limit?: number;
}

export interface MemoryStore {
  remember(
    entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryEntry>;
  search(options?: MemorySearchOptions): Promise<MemoryEntry[]>;
  delete?(memoryId: string): Promise<boolean>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly entries = new RingBuffer<MemoryEntry>(
    IN_MEMORY_MEMORY_ENTRIES
  );
  private readonly deletedIds = new BoundedMap<string, true>(
    IN_MEMORY_MEMORY_ENTRIES,
    undefined
  );

  async remember(
    entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryEntry> {
    const now = nowIso();
    const saved: MemoryEntry = {
      ...entry,
      id: createId('memory'),
      createdAt: now,
      updatedAt: now,
    };
    this.entries.pushOverwritingOldest(saved);
    return saved;
  }

  async search(options: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    return filterMemories(
      this.entries.toArray().filter((entry) => !this.deletedIds.has(entry.id)),
      options
    );
  }

  async delete(memoryId: string): Promise<boolean> {
    const exists = this.entries
      .toArray()
      .some((entry) => entry.id === memoryId && !this.deletedIds.has(memoryId));
    if (!exists) return false;
    this.deletedIds.set(memoryId, true);
    return true;
  }
}

export class JsonlMemoryStore implements MemoryStore {
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

  private readonly mutex = new AsyncMutex();
  private appendBatcher: JsonlAppendBatcher | undefined;
  private cachedEntries: MemoryEntry[] | undefined;
  private cachedMtimeMs: number | undefined;
  private cachedStats:
    { totalRecords: number; deletedRecords: number } | undefined;
  private hasPendingLocalWrites = false;

  constructor(private readonly filePath: string) {}

  async remember(
    entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryEntry> {
    return this.mutex.runExclusive(async () => {
      const now = nowIso();
      const saved: MemoryEntry = {
        ...entry,
        id: createId('memory'),
        createdAt: now,
        updatedAt: now,
      };
      if (this.cachedEntries !== undefined) {
        this.cachedEntries.push(saved);
        if (this.cachedStats) this.cachedStats.totalRecords++;
      }
      this.hasPendingLocalWrites = true;
      const batcher = await this.ensureAppendBatcher();
      await batcher.append(JSON.stringify(saved));
      return saved;
    });
  }

  async search(options: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    const entries = await this.readEntries();
    return filterMemories(entries, options);
  }

  async delete(memoryId: string): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      const id = requireString({ memoryId }, 'memoryId');
      const entries = await this.readEntries();
      if (!entries.some((entry) => entry.id === id)) {
        return false;
      }
      if (this.cachedEntries !== undefined) {
        this.cachedEntries = this.cachedEntries.filter((e) => e.id !== id);
        if (this.cachedStats) {
          this.cachedStats.deletedRecords++;
        }
      }
      this.hasPendingLocalWrites = true;
      const batcher = await this.ensureAppendBatcher();
      await batcher.append(
        JSON.stringify({ type: 'delete', memoryId: id, deletedAt: nowIso() })
      );
      // tombstone 落盘后再评估 compaction：基于最新文件统计决定是否重写。
      await this.maybeCompact();
      return true;
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

  private invalidateEntriesCache(): void {
    this.cachedEntries = undefined;
    this.cachedMtimeMs = undefined;
    this.cachedStats = undefined;
  }

  /**
   * 读取并缓存条目。
   *
   * 以 stat().mtimeMs 作为缓存失效判据：若文件未变更则直接返回缓存，
   * 避免 search 反复读全文件。remember()/delete() 写入后会显式置失效，
   * 覆盖同一毫秒内多次写入导致 mtimeMs 相同的边界情况。缓存 miss 时
   * 先 flush batcher 确保 pending 数据落盘后再读取文件。
   */
  private async readEntries(): Promise<MemoryEntry[]> {
    // 先 flush pending appends，确保文件反映所有写入后再 stat。
    // 这样 mtimeMs 判据与文件实际内容一致，避免读到旧 mtime 命中缓存。
    if (this.appendBatcher) {
      await this.appendBatcher.flush();
    }
    const stat = await statFile(this.filePath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (!stat) {
      this.cachedEntries = [];
      this.cachedMtimeMs = undefined;
      this.cachedStats = { totalRecords: 0, deletedRecords: 0 };
      return this.cachedEntries;
    }
    if (this.hasPendingLocalWrites && this.cachedEntries !== undefined) {
      this.cachedMtimeMs = stat.mtimeMs;
      this.hasPendingLocalWrites = false;
      return this.cachedEntries;
    }
    if (
      this.cachedEntries !== undefined &&
      this.cachedMtimeMs === stat.mtimeMs
    ) {
      return this.cachedEntries;
    }
    const bytes = await readFile(this.filePath);
    const decoded = decodeTextBuffer(bytes);
    const entries = new Map<string, MemoryEntry>();
    const deletedIds = new Set<string>();
    let totalRecords = 0;
    let deletedRecords = 0;
    if (decoded.encoding !== 'binary') {
      for (const line of decoded.text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = JSON.parse(trimmed) as unknown;
          totalRecords += 1;
          if (isMemoryDeleteRecord(record)) {
            deletedIds.add(record.memoryId);
            entries.delete(record.memoryId);
            deletedRecords += 1;
            continue;
          }
          const entry = normalizeMemoryEntry(record);
          if (!deletedIds.has(entry.id)) {
            entries.set(entry.id, entry);
          }
        } catch {
          // silent: JSON.parse 降级，损坏行跳过
          continue;
        }
      }
    }
    this.cachedEntries = [...entries.values()];
    this.cachedMtimeMs = stat.mtimeMs;
    this.cachedStats = { totalRecords, deletedRecords };
    this.hasPendingLocalWrites = false;
    return this.cachedEntries;
  }

  /**
   * 懒初始化 JsonlAppendBatcher。
   *
   * batcher 内部缓存文件句柄、累积写入并批量 fsync，相比逐条 writeFile+sync
   * 显著提升吞吐。首行换行与目录 fsync 由 batcher 自身处理。
   */
  private async ensureAppendBatcher(): Promise<JsonlAppendBatcher> {
    if (!this.appendBatcher) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.appendBatcher = new JsonlAppendBatcher({ filePath: this.filePath });
    }
    return this.appendBatcher;
  }

  /**
   * 软删除累积达到阈值时触发 compaction，重写文件只保留活跃 entries。
   *
   * 动机：delete() 以 tombstone 形式追加到 JSONL 文件，长会话下 tombstone
   * 累积导致文件膨胀、readEntries 解析大量无效行、内存缓存承载历史负担。
   * compaction 把所有未删除 entries 原子重写到原文件，回收空间。
   *
   * 阈值：deletedRecords >= 100 且 deletedRecords/totalRecords >= 0.3。
   * 小文件不触发，避免频繁 compaction 的开销超过收益。
   */
  private async maybeCompact(): Promise<void> {
    // delete() 的 enqueueAppend 已 invalidate 缓存，此处重新读取以获取
    // 包含最新 tombstone 的统计。
    await this.readEntries();
    const stats = this.cachedStats;
    if (!stats || stats.totalRecords === 0) return;
    const ratio = stats.deletedRecords / stats.totalRecords;
    if (
      stats.deletedRecords >= JsonlMemoryStore.COMPACTION_MIN_DELETED_RECORDS &&
      ratio >= JsonlMemoryStore.COMPACTION_RATIO_THRESHOLD
    ) {
      await this.compactEntries();
    }
  }

  /**
   * 重写文件只保留未删除 entries。
   *
   * 通过 appendQueue 串行化，确保 compaction 期间无并发 append。
   * 使用 tmp + rename 原子覆写，崩溃时要么旧文件完整、要么新文件完整。
   * compaction 后必须释放 appendBatcher：rename 后旧 fd 指向被覆写的 inode，
   * 后续 append 必须重新打开新文件；同时重置缓存强制下次读取 compacted 文件。
   */
  private async compactEntries(): Promise<void> {
    // readEntries 内部会 flush pending tombstone，确保读到完整文件
    const entries = await this.readEntries();
    // 原子写入 tmp + rename 覆盖原文件
    const tmpPath = `${this.filePath}.compact-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await mkdir(dirname(tmpPath), { recursive: true });
    const content =
      entries.length > 0
        ? `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
        : '';
    try {
      await writeFile(tmpPath, content, 'utf8');
      await rename(tmpPath, this.filePath);
    } catch (error) {
      // silent: cleanup tmp on rename failure
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
    // rename 成功后旧 appendBatcher 的 fd 指向被覆写的 inode，必须释放
    await this.releaseAppendHandle();
    // 重置缓存，强制下次 readEntries 读取 compacted 文件
    this.invalidateEntriesCache();
  }
}

interface MemoryDeleteRecord {
  type: 'delete';
  memoryId: string;
  deletedAt: string;
}

function isMemoryDeleteRecord(value: unknown): value is MemoryDeleteRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === 'delete' &&
    typeof record.memoryId === 'string' &&
    record.memoryId.length > 0
  );
}

function normalizeMemoryEntry(value: unknown): MemoryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('memory entry must be an object');
  }
  const record = value as Record<string, unknown>;
  return {
    id: requireString(record as JsonObject, 'id'),
    scope: memoryScope(record.scope as JsonValue | undefined),
    content: requireString(record as JsonObject, 'content'),
    tags: stringArray(record.tags as JsonValue | undefined),
    createdAt: requireString(record as JsonObject, 'createdAt'),
    updatedAt: requireString(record as JsonObject, 'updatedAt'),
    ...(record.metadata &&
    typeof record.metadata === 'object' &&
    !Array.isArray(record.metadata)
      ? { metadata: record.metadata as JsonObject }
      : {}),
  };
}

export function createMemoryTools(store: MemoryStore): AgentTool[] {
  return [
    defineTool({
      name: 'remember_memory',
      label: 'Remember memory',
      description: 'Persist a concise memory for future agent turns.',
      category: 'internal',
      concurrency: 'exclusive',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          scope: { type: 'string', enum: ['session', 'project', 'user'] },
          tags: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      summarize(input: JsonObject) {
        return `remember ${stringField(input, 'content')?.slice(0, 80) ?? 'memory'}`;
      },
      async execute(input: JsonObject) {
        const metadata = objectField(input, 'metadata');
        const entry = await store.remember({
          content: requireString(input, 'content'),
          scope: memoryScope(input.scope),
          tags: stringArray(input.tags),
          ...(metadata !== undefined ? { metadata } : {}),
        });
        return {
          text: `Remembered ${entry.id}`,
          json: toJsonValue(entry),
        };
      },
    }),
    defineTool({
      name: 'search_memory',
      label: 'Search memory',
      description: 'Search persisted memories by text, scope, and tags.',
      category: 'internal',
      concurrency: 'parallel',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          scope: { type: 'string', enum: ['session', 'project', 'user'] },
          tags: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number' },
        },
        additionalProperties: false,
      },
      isReadOnly: () => true,
      summarize(input: JsonObject) {
        return `search memory ${stringField(input, 'query') ?? ''}`.trim();
      },
      async execute(input: JsonObject) {
        const query = stringField(input, 'query');
        const scope = optionalMemoryScope(input.scope);
        const tags = stringArray(input.tags);
        const limit = numberField(input, 'limit');
        const matches = await store.search({
          ...(query !== undefined ? { query } : {}),
          ...(scope !== undefined ? { scope } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return {
          text: matches
            .map((entry) => `${entry.id} [${entry.scope}] ${entry.content}`)
            .join('\n'),
          json: { matches: toJsonValue(matches) },
        };
      },
    }),
  ];
}

function filterMemories(
  entries: MemoryEntry[],
  options: MemorySearchOptions
): MemoryEntry[] {
  const query = options.query?.trim().toLowerCase();
  const tags = new Set((options.tags ?? []).map((tag) => tag.toLowerCase()));
  const limit = Math.max(1, options.limit ?? 20);
  return entries
    .filter((entry) => !options.scope || entry.scope === options.scope)
    .filter(
      (entry) =>
        !query ||
        entry.content.toLowerCase().includes(query) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(query))
    )
    .filter(
      (entry) =>
        tags.size === 0 || entry.tags.some((tag) => tags.has(tag.toLowerCase()))
    )
    .slice(-limit)
    .reverse();
}

function requireString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function objectField(input: JsonObject, key: string): JsonObject | undefined {
  const value = input[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function optionalMemoryScope(
  value: JsonValue | undefined
): MemoryScope | undefined {
  return value === 'session' || value === 'project' || value === 'user'
    ? value
    : undefined;
}

function memoryScope(value: JsonValue | undefined): MemoryScope {
  return optionalMemoryScope(value) ?? 'project';
}
