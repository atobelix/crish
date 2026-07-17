import { constants } from "node:fs";
import { mkdir, open as openFile, readFile, rename, stat as statFile, writeFile } from "node:fs/promises";
import { createReadStream, type ReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { AsyncMutex, isRecord, JsonlAppendBatcher } from "@crish/shared-utils";
import {
  ORCHESTRATOR_EVENT_LOG_SCHEMA_VERSION,
  ORCHESTRATOR_PROTOCOL_VERSION,
  type OrchestratorEvent,
  type OrchestratorEventLogMetadata,
  type OrchestratorEventReadOptions,
  type OrchestratorSessionEventSummary,
  type OrchestratorEventStore,
  type OrchestratorEventType
} from "./types";
import {
  compareSessionSummaries,
  toOrchestratorSessionEventSummary,
  updateSessionSummary,
  type MutableSessionEventSummary,
  type OrchestratorRunSummaryState
} from "./session-summary";

export const ORCHESTRATOR_EVENT_STORE_FILE_VERSION = 1;
export const ORCHESTRATOR_SESSION_SUMMARY_INDEX_VERSION = 2;

export interface FileOrchestratorEventStoreHeader {
  type: "orchestrator-event-store";
  version: typeof ORCHESTRATOR_EVENT_STORE_FILE_VERSION;
  protocolVersion: typeof ORCHESTRATOR_PROTOCOL_VERSION;
  eventLogId: string;
  generation: number;
  schemaVersion: typeof ORCHESTRATOR_EVENT_LOG_SCHEMA_VERSION;
}

export interface FileOrchestratorEventStoreOptions {
  header?: FileOrchestratorEventStoreHeader;
  sessionSummaryIndexPath?: string;
  /**
   * 内存中缓存的最大事件数量
   *
   * 超过此限制后，最早的缓存事件将被释放。
   * 默认 10000。设置为 0 表示不缓存。
   */
  maxCachedEvents?: number;
  /**
   * 索引刷盘间隔（毫秒）。
   *
   * append() 只更新内存索引，当距离上次刷盘超过此间隔时才写磁盘。
   * 设为 0 表示每次 append 都刷盘，设为 Infinity 表示只手动刷盘。
   * 默认 5000ms。
   */
  indexFlushIntervalMs?: number;
}

export interface FileOrchestratorSessionSummaryIndex {
  type: "orchestrator-session-summary-index";
  version: typeof ORCHESTRATOR_SESSION_SUMMARY_INDEX_VERSION;
  protocolVersion: typeof ORCHESTRATOR_PROTOCOL_VERSION;
  eventLogId: string;
  generation: number;
  schemaVersion: typeof ORCHESTRATOR_EVENT_LOG_SCHEMA_VERSION;
  summaries: FileOrchestratorSessionSummaryIndexRecord[];
}

export interface FileOrchestratorSessionSummaryIndexRecord {
  sessionId: string;
  lastUpdated: string;
  eventCount: number;
  runIds: string[];
  runStates?: OrchestratorRunSummaryState[];
  lastEventId?: string;
  lastSequence?: number;
  lastMessagePreview?: string;
  pendingInputIds?: string[];
  pendingInputEventCount?: number;
}

// ─── 三层读取策略：字节偏移索引类型 ────────────────────────

export interface ByteOffsetRange {
  byteOffset: number;
  byteLength: number;
}

export interface ByteOffsetIndexEntry {
  sessionId: string;
  ranges: ByteOffsetRange[];
}

export interface ByteOffsetIndexFile {
  type: "orchestrator-byte-offset-index";
  version: number;
  eventLogId: string;
  generation: number;
  entries: ByteOffsetIndexEntry[];
}

export type OrchestratorEventStoreFailureKind =
  | "closed"
  | "write-failed"
  | "index-write-failed"
  | "invalid-event"
  | "duplicate-event-id"
  | "invalid-read";

/** Store-level failures that latch the writer closed for subsequent appends. */
const LATCHING_FAILURE_KINDS = new Set<OrchestratorEventStoreFailureKind>(["write-failed"]);

export class OrchestratorEventStoreError extends Error {
  readonly kind: OrchestratorEventStoreFailureKind;
  readonly filePath: string;
  readonly eventId?: string;

  constructor(
    message: string,
    options: {
      kind: OrchestratorEventStoreFailureKind;
      filePath: string;
      eventId?: string;
      cause?: unknown;
    }
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OrchestratorEventStoreError";
    this.kind = options.kind;
    this.filePath = options.filePath;
    this.eventId = options.eventId;
  }
}

export class OrchestratorEventStoreClosedError extends OrchestratorEventStoreError {
  constructor(filePath: string, eventId?: string) {
    super(`Orchestrator event store is closed: ${filePath}`, {
      kind: "closed",
      filePath,
      eventId
    });
    this.name = "OrchestratorEventStoreClosedError";
  }
}

export class OrchestratorEventStoreWriteError extends OrchestratorEventStoreError {
  constructor(filePath: string, eventId: string | undefined, cause: unknown) {
    super(`Failed to append orchestrator event${eventId ? ` ${eventId}` : ""} to ${filePath}`, {
      kind: "write-failed",
      filePath,
      eventId,
      cause
    });
    this.name = "OrchestratorEventStoreWriteError";
  }
}

export class OrchestratorEventStoreIndexWriteError extends OrchestratorEventStoreError {
  constructor(filePath: string, cause: unknown) {
    super(`Failed to write session summary index for ${filePath}`, {
      kind: "index-write-failed",
      filePath,
      cause
    });
    this.name = "OrchestratorEventStoreIndexWriteError";
  }
}

export class OrchestratorEventStoreInvalidEventError extends OrchestratorEventStoreError {
  constructor(filePath: string, eventId: string | undefined, reason: string) {
    super(`Invalid orchestrator event${eventId ? ` ${eventId}` : ""}: ${reason}`, {
      kind: "invalid-event",
      filePath,
      eventId
    });
    this.name = "OrchestratorEventStoreInvalidEventError";
  }
}

export class OrchestratorEventStoreDuplicateIdError extends OrchestratorEventStoreError {
  constructor(filePath: string, eventId: string) {
    super(`Duplicate orchestrator event id ${eventId} in ${filePath}`, {
      kind: "duplicate-event-id",
      filePath,
      eventId
    });
    this.name = "OrchestratorEventStoreDuplicateIdError";
  }
}

export class OrchestratorEventStoreInvalidReadError extends OrchestratorEventStoreError {
  constructor(filePath: string, reason: string) {
    super(`Invalid orchestrator event store read: ${reason}`, {
      kind: "invalid-read",
      filePath
    });
    this.name = "OrchestratorEventStoreInvalidReadError";
  }
}

const DEFAULT_HEADER: FileOrchestratorEventStoreHeader = {
  type: "orchestrator-event-store",
  version: ORCHESTRATOR_EVENT_STORE_FILE_VERSION,
  protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
  eventLogId: "",
  generation: 1,
  schemaVersion: ORCHESTRATOR_EVENT_LOG_SCHEMA_VERSION
};

const EVENT_TYPES = new Set<OrchestratorEventType>([
  "session-created",
  "conversation-rewind-audit",
  "session-leaf-moved",
  "pending-input-created",
  "pending-input-cancelled",
  "pending-input-dispatched",
  "run-queued",
  "run-started",
  "goal-round-started",
  "goal-round-completed",
  "goal-continuation-decided",
  "runtime-event",
  "run-cancel-requested",
  "run-cancelled",
  "run-completed",
  "run-failed"
]);

export class FileOrchestratorEventStore implements OrchestratorEventStore {
  private appendQueue: Promise<void> = Promise.resolve();
  private headerReady = false;
  private metadata?: OrchestratorEventLogMetadata;
  private acceptingAppends = true;
  private latchedFailure?: OrchestratorEventStoreError;
  private cachedEvents?: OrchestratorEvent[];
  private cachedEventsBySession = new Map<string, OrchestratorEvent[]>();
  /**
   * 批量 fsync 的 JSONL 追加写入器。
   *
   * 缓存文件句柄、累积写入并批量 fsync，相比逐条 writeFile+sync 显著提升吞吐。
   * 在 close() 时释放。
   */
  private appendBatcher?: JsonlAppendBatcher;
  private cachedEventsByRun = new Map<string, OrchestratorEvent[]>();
  private cachedSessionSummaries = new Map<string, MutableSessionEventSummary>();
  private sessionSummaryCacheReady = false;
  /**
   * 索引写入失败计数
   *
   * 索引写入失败不阻塞主事件追加流程，但持续失败意味着索引可能过期。
   * 调用方可以通过 healthCheck() 检测此状态。
   */
  private indexWriteFailureCount = 0;
  private lastIndexWriteError?: Error;

  /**
   * Known event ids for uniqueness enforcement on append.
   * Populated from the durable log (once) and every successful append.
   */
  private knownEventIds = new Set<string>();
  private eventIdsReady = false;

  // ─── 三层读取策略：字节偏移索引 ──────────────────────────
  /**
   * 当前文件大小（用于计算 append 事件的 byteOffset）。
   * 在 ensureHeader 后初始化。
   */
  private currentFileSize = 0;

  /**
   * byteOffsetIndex: sessionId → 该 session 所有事件的字节范围列表
   *
   * 每个条目包含 { byteOffset, byteLength }，用于 seek + read 精准读取。
   * 持久化为 {filePath}.byte-index.json。
   */
  private byteOffsetIndex = new Map<string, Array<{ byteOffset: number; byteLength: number }>>();
  private byteIndexLoaded = false;

  /**
   * 索引脏标志：当内存中的索引被修改但未持久化时为 true。
   *
   * append() 只更新内存索引，不立即写磁盘。
   * flushIndex() 或 close() 时批量写入。
   */
  private indexDirty = false;

  /**
   * 索引刷盘间隔（毫秒）。
   *
   * 当距离上次成功刷盘超过此间隔时，append() 会顺便刷盘。
   * 设为 0 表示每次 append 都刷盘（旧行为），设为 Infinity 表示只手动刷盘。
   * 默认 5000ms。
   */
  private indexFlushIntervalMs: number;

  /**
   * 上次成功刷盘的时间戳。
   */
  private lastIndexFlushTime = 0;

  /**
   * 串行化 flushIndex 的互斥锁。
   *
   * append() 内部、listSessionSummaries() 与 close() 都会调用 flushIndex()，其中
   * 后两者不在 appendQueue 内执行。若不加锁，并发的 append 与外部 flushIndex 会
   * 同时读写同一份内存索引与磁盘 companion file，导致索引内容交错或丢失。该锁
   * 确保任意时刻只有一个 flushIndex 临界区在执行（FIFO 公平排队）。
   */
  private readonly flushMutex = new AsyncMutex();

  /**
   * 尾部启动读取的事件数量（默认 1000）。
   * 如果事件日志较小则全量读取，较大时只读取尾部用于快速构建 session 摘要。
   */
  private static readonly TAIL_BOOTSTRAP_EVENT_COUNT = 1000;

  constructor(
    private readonly filePath: string,
    private readonly options: FileOrchestratorEventStoreOptions = {}
  ) {
    this.indexFlushIntervalMs = options.indexFlushIntervalMs ?? 5_000;
  }

  /**
   * 检查事件存储的健康状态
   *
   * 返回当前存储是否可写、索引是否同步等信息。
   */
  healthCheck(): { writable: boolean; indexSynced: boolean; indexDirty: boolean; indexWriteFailureCount: number; lastIndexWriteError?: string } {
    return {
      writable: this.acceptingAppends && !this.latchedFailure,
      indexSynced: this.indexWriteFailureCount === 0,
      indexDirty: this.indexDirty,
      indexWriteFailureCount: this.indexWriteFailureCount,
      lastIndexWriteError: this.lastIndexWriteError?.message,
    };
  }

  async append(event: OrchestratorEvent): Promise<void> {
    // Client validation stays outside the write latch path.
    assertAppendableEvent(event, this.filePath);

    if (!this.acceptingAppends) {
      throw new OrchestratorEventStoreClosedError(this.filePath, event.id);
    }
    if (this.latchedFailure) {
      throw this.latchedFailure;
    }

    await this.enqueueAppend(async () => {
      try {
        // Re-check inside the serialized queue so close() racing concurrent appends is deterministic.
        if (!this.acceptingAppends) {
          throw new OrchestratorEventStoreClosedError(this.filePath, event.id);
        }
        if (this.latchedFailure) {
          throw this.latchedFailure;
        }

        await this.ensureHeader();
        await this.ensureEventIdsLoaded();
        if (this.knownEventIds.has(event.id)) {
          throw new OrchestratorEventStoreDuplicateIdError(this.filePath, event.id);
        }

        await this.tryLoadSessionSummaryIndex();
        await this.tryLoadByteOffsetIndex();

        // 计算字节偏移（当前文件大小即为新事件的起始偏移）
        const serialized = JSON.stringify(event);
        const byteLength = Buffer.byteLength(serialized, "utf8") + 1; // +1 for trailing newline
        // ensureAppendBatcher 在首次构造 batcher 时同步 currentFileSize 并预测
        // batcher 是否会补首行 "\n" 前缀，将其计入 currentFileSize。此后 byteOffset
        // 直接取 currentFileSize，batcher.append 仅向 pending buffer 追加，不改变
        // 文件不变式（每次 append 都带 "\n"，文件始终以 "\n" 结尾）。
        const batcher = await this.ensureAppendBatcher();
        await batcher.append(serialized);
        // 立即 flush 确保 append 返回后数据已落盘。
        // event-store 的调用方（含测试）依赖 append 的同步持久化语义：
        // 直接 readFile 或新建 store 实例读取时必须看到已写入的事件。
        // batcher 仍提供句柄缓存与集中化的换行/目录 fsync 逻辑。
        await batcher.flush();
        const byteOffset = this.currentFileSize;
        this.currentFileSize += byteLength;

        // 追踪字节偏移
        this.trackByteOffset(event.sessionId, byteOffset, byteLength);

        this.knownEventIds.add(event.id);
        this.appendCachedEvent(event);

        // 标记索引为脏（延迟写入）
        this.indexDirty = true;

        // 按刷盘间隔决定是否持久化索引
        if (this.shouldFlushIndexNow()) {
          await this.flushIndex();
        }
      } catch (cause) {
        if (cause instanceof OrchestratorEventStoreError) {
          throw cause;
        }
        throw new OrchestratorEventStoreWriteError(this.filePath, event.id, cause);
      }
    });
  }

  async readSession(sessionId: string, afterSequence = 0, options: OrchestratorEventReadOptions = {}): Promise<OrchestratorEvent[]> {
    assertNonEmptyId(sessionId, "sessionId", this.filePath);
    const read = normalizeReadOptions(afterSequence, options, this.filePath);

    if (!this.byteIndexLoaded) {
      await this.tryLoadByteOffsetIndex();
    }

    // ── 三层策略：优先使用字节偏移索引（tier 2）─
    if (this.byteIndexLoaded && this.byteOffsetIndex.has(sessionId)) {
      const events = await this.readSessionViaByteIndex(sessionId, read.afterSequence);
      // When the byte index knows the session, trust it even for empty filtered results
      // (e.g. afterSequence past the tail) so we do not force a full cache rebuild.
      if (events.length > 0 || read.afterSequence > 0 || read.maxEvents === 0) {
        return this.applyMaxEvents(events, read.maxEvents);
      }
      // Empty unfiltered result may indicate a stale/partial byte index — fall through.
    }

    // ── 兜底：全量缓存读取（tier 3 的简化版）─
    await this.ensureEventCache();
    return collectAfterSequence(this.cachedEventsBySession.get(sessionId) ?? [], read.afterSequence, read.maxEvents);
  }

  async readRun(runId: string, afterSequence = 0, options: OrchestratorEventReadOptions = {}): Promise<OrchestratorEvent[]> {
    assertNonEmptyId(runId, "runId", this.filePath);
    const read = normalizeReadOptions(afterSequence, options, this.filePath);
    await this.ensureEventCache();
    return collectAfterSequence(this.cachedEventsByRun.get(runId) ?? [], read.afterSequence, read.maxEvents);
  }

  async getMetadata(): Promise<OrchestratorEventLogMetadata> {
    if (!this.headerReady || !this.metadata) {
      await this.ensureHeader();
    }
    return this.metadata!;
  }

  async listSessionSummaries(): Promise<OrchestratorSessionEventSummary[]> {
    await this.flush();
    if (!this.sessionSummaryCacheReady && !(await this.tryLoadSessionSummaryIndex())) {
      // Product session lists must be complete; tail bootstrap is diagnostic-only.
      await this.ensureEventCache();
    }
    // Persist deferred index updates so a subsequent cold open sees the same summaries.
    if (this.indexDirty) {
      await this.flushIndex();
    }
    return [...this.cachedSessionSummaries.values()]
      .map(toOrchestratorSessionEventSummary)
      .sort((left, right) => compareSessionSummaries(left, right));
  }

  async readAll(afterSequence = 0, options: OrchestratorEventReadOptions = {}): Promise<OrchestratorEvent[]> {
    const read = normalizeReadOptions(afterSequence, options, this.filePath);
    await this.ensureEventCache();
    return collectAfterSequence(this.cachedEvents ?? [], read.afterSequence, read.maxEvents);
  }

  /**
   * 流式全量回放（tier 3）。
   *
   * 逐行读取事件日志，避免一次性加载全部到内存。
   * 用于操作员主动触发的全量审计回放场景。
   *
   * @returns AsyncGenerator，逐个产出 OrchestratorEvent
   */
  async *readAllStreaming(afterSequence = 0): AsyncGenerator<OrchestratorEvent> {
    const read = normalizeReadOptions(afterSequence, {}, this.filePath);
    await this.flush();
    await this.ensureHeader();

    // Empty brand-new store: header only (or just-created file) yields nothing.
    const stream = createReadStream(this.filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let headerSkipped = false;
    for await (const line of rl) {
      if (!line.trim()) continue;

      if (!headerSkipped) {
        headerSkipped = true;
        // 跳过 header 行
        continue;
      }

      const parsed = parseJsonLine(line);
      if (isOrchestratorEvent(parsed) && parsed.sequence > read.afterSequence) {
        yield parsed;
      }
    }
  }

  // ─── 三层读取策略：字节偏移索引（tier 2）─

  /**
   * 使用字节偏移索引精准读取 session 事件。
   *
   * 从 {filePath}.byte-index.json 加载的索引中获取该 session 的字节范围，
   * 然后 seek + read 只读取相关部分，避免全量文件读取。
   */
  private async readSessionViaByteIndex(
    sessionId: string,
    afterSequence: number
  ): Promise<OrchestratorEvent[]> {
    const ranges = this.byteOffsetIndex.get(sessionId);
    if (!ranges || ranges.length === 0) return [];

    const events: OrchestratorEvent[] = [];
    const handle = await openFile(this.filePath, constants.O_RDONLY);

    try {
      for (const { byteOffset, byteLength } of ranges) {
        const buffer = Buffer.alloc(byteLength);
        const { bytesRead } = await handle.read(buffer, 0, byteLength, byteOffset);

        if (bytesRead === 0) continue;

        const chunk = buffer.toString("utf8", 0, bytesRead);
        const lines = chunk.split(/\r?\n/).filter((l) => l.trim());

        for (const line of lines) {
          const parsed = parseJsonLine(line);
          if (
            isOrchestratorEvent(parsed) &&
            parsed.sequence > afterSequence
          ) {
            events.push(parsed);
          }
        }
      }
    } finally {
      await handle.close();
    }

    return events.sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * 加载字节偏移索引。
   *
   * 索引文件路径：{filePath}.byte-index.json
   * 如果加载成功，byteOffsetIndex 和 byteIndexLoaded 会被设置。
   */
  private async tryLoadByteOffsetIndex(): Promise<boolean> {
    if (this.byteIndexLoaded) return true;

    const indexPath = this.byteIndexPath();
    const raw = await readFile(indexPath, "utf8").catch(() => null);
    if (!raw?.trim()) return false;

    try {
      const parsed = JSON.parse(raw) as ByteOffsetIndexFile;
      if (
        !isRecord(parsed) ||
        parsed.type !== "orchestrator-byte-offset-index" ||
        parsed.version !== 1 ||
        !Array.isArray(parsed.entries)
      ) {
        return false;
      }
      await this.ensureHeader();
      if (
        !this.metadata ||
        parsed.eventLogId !== this.metadata.eventLogId ||
        parsed.generation !== this.metadata.generation
      ) {
        return false;
      }

      this.byteOffsetIndex = new Map(
        parsed.entries.map((entry: ByteOffsetIndexEntry) => [
          entry.sessionId,
          entry.ranges,
        ])
      );
      this.byteIndexLoaded = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 持久化字节偏移索引到 companion file。
   *
   * 写入策略：atomic write (tmp + rename)，与 session summary index 一致。
   */
  private async writeByteOffsetIndex(): Promise<void> {
    if (!this.byteIndexLoaded || !this.metadata) return;

    const indexPath = this.byteIndexPath();
    const entries: ByteOffsetIndexEntry[] = [];

    for (const [sessionId, ranges] of this.byteOffsetIndex) {
      entries.push({ sessionId, ranges });
    }

    const file: ByteOffsetIndexFile = {
      type: "orchestrator-byte-offset-index",
      version: 1,
      eventLogId: this.metadata.eventLogId,
      generation: this.metadata.generation,
      entries,
    };

    await mkdir(dirname(indexPath), { recursive: true });
    const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(file)}\n`, "utf8");
    await rename(tempPath, indexPath);
  }

  /**
   * 记录一个事件的字节偏移到索引中。
   *
   * 首次记录时自动将 byteIndexLoaded 设为 true，
   * 确保后续 writeByteOffsetIndex 和 readSessionViaByteIndex 能正常工作。
   */
  private trackByteOffset(
    sessionId: string,
    byteOffset: number,
    byteLength: number
  ): void {
    let ranges = this.byteOffsetIndex.get(sessionId);
    if (!ranges) {
      ranges = [];
      this.byteOffsetIndex.set(sessionId, ranges);
    }
    ranges.push({ byteOffset, byteLength });
    // 首次 append 后索引已在内存中构建，标记为已加载
    if (!this.byteIndexLoaded) {
      this.byteIndexLoaded = true;
    }
  }

  private byteIndexPath(): string {
    return `${this.filePath}.byte-index.json`;
  }

  private applyMaxEvents(events: OrchestratorEvent[], maxEvents?: number): OrchestratorEvent[] {
    if (maxEvents === undefined || events.length <= maxEvents) return events;
    return events.slice(0, maxEvents);
  }

  private async ensureEventCache(): Promise<void> {
    await this.flush();
    if (this.cachedEvents) return;
    // 读路径校正 currentFileSize：外部写入（或崩溃的对端）可能在 ensureHeader
    // 之后扩展日志，使增量维护的 currentFileSize 失真。此处通过 appendQueue
    // 串行化 stat，避免与并发 append 的增量更新互相覆盖。
    await this.refreshFileSize();
    const raw = await readFile(this.filePath, "utf8").catch((cause) => {
      const error = cause as NodeJS.ErrnoException;
      if (error.code === "ENOENT") return null;
      throw cause;
    });
    if (!raw?.trim()) {
      this.replaceEventCache([]);
      return;
    }

    const lines = raw.split(/\r?\n/);
    const headerIndex = lines.findIndex((line) => line.trim().length > 0);
    if (headerIndex === -1) {
      this.replaceEventCache([]);
      return;
    }
    this.applyHeader(parseHeader(lines[headerIndex]!, this.filePath));
    this.headerReady = true;

    const events: OrchestratorEvent[] = [];
    for (let index = headerIndex + 1; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      const parsed = parseJsonLine(line);
      if (isOrchestratorEvent(parsed)) {
        events.push(parsed);
      }
    }
    this.replaceEventCache(events.sort((left, right) => left.sequence - right.sequence));
    await this.writeSessionSummaryIndex().catch((cause) => {
      this.indexWriteFailureCount++;
      this.lastIndexWriteError = cause instanceof Error ? cause : new Error(String(cause));
    });
  }

  /**
   * Ensure known event ids are loaded so append can enforce uniqueness.
   * Prefer the warm event cache; otherwise scan the JSONL for valid event ids only.
   */
  private async ensureEventIdsLoaded(): Promise<void> {
    if (this.eventIdsReady) return;

    if (this.cachedEvents) {
      for (const item of this.cachedEvents) {
        this.knownEventIds.add(item.id);
      }
      this.eventIdsReady = true;
      return;
    }

    const raw = await readFile(this.filePath, "utf8").catch((cause) => {
      const error = cause as NodeJS.ErrnoException;
      if (error.code === "ENOENT") return null;
      throw cause;
    });
    if (!raw?.trim()) {
      this.eventIdsReady = true;
      return;
    }

    const lines = raw.split(/\r?\n/);
    let headerSkipped = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!headerSkipped) {
        headerSkipped = true;
        continue;
      }
      const parsed = parseJsonLine(line);
      if (isOrchestratorEvent(parsed)) {
        this.knownEventIds.add(parsed.id);
      }
    }
    this.eventIdsReady = true;
  }

  /**
   * 从尾部快速启动：只读取日志尾部 N 条事件来构建 session 摘要缓存。
   *
   * 与 ensureEventCache() 的区别：
   * - ensureEventCache() 全量读取文件，适合小日志或需要完整事件的场景
   * - bootstrapFromTail() 只读取尾部，适合大日志快速启动场景
   *
   * 启动策略：
   * 1. 如果 session summary index 文件存在且有效，直接使用（最快）
   * 2. 否则，从日志尾部读取 TAIL_BOOTSTRAP_EVENT_COUNT 条事件构建摘要
   * 3. 如果日志行数 <= TAIL_BOOTSTRAP_EVENT_COUNT，等价于全量读取
   *
   * @returns 启动是否成功（true = 摘要缓存已就绪，false = 需要回退到 ensureEventCache）
   */
  async bootstrapFromTail(): Promise<boolean> {
    await this.flush();
    if (this.sessionSummaryCacheReady) return true;

    // 策略 1：优先尝试加载持久化的 session summary index
    if (await this.tryLoadSessionSummaryIndex()) {
      return true;
    }

    // 策略 2：从日志尾部读取
    await this.ensureHeader();
    await this.tryLoadByteOffsetIndex();

    const tailEvents = await this.readTailEvents(FileOrchestratorEventStore.TAIL_BOOTSTRAP_EVENT_COUNT);
    if (tailEvents.length === 0) {
      // 空日志，标记缓存就绪
      this.cachedSessionSummaries = new Map();
      this.sessionSummaryCacheReady = true;
      return true;
    }

    // 用尾部事件构建 session 摘要
    for (const event of tailEvents) {
      updateSessionSummary(this.cachedSessionSummaries, event);
    }
    this.sessionSummaryCacheReady = true;

    // 持久化索引以加速后续启动
    await this.writeSessionSummaryIndex().catch((cause) => {
      this.indexWriteFailureCount++;
      this.lastIndexWriteError = cause instanceof Error ? cause : new Error(String(cause));
    });

    return true;
  }

  /**
   * 读取日志尾部 N 条事件。
   *
   * 使用反向读取策略：从文件末尾向前扫描，收集最近的事件。
   * 避免全量读取大文件。
   */
  private async readTailEvents(count: number): Promise<OrchestratorEvent[]> {
    const handle = await openFile(this.filePath, constants.O_RDONLY);
    try {
      const stat = await handle.stat();
      if (stat.size === 0) return [];

      // 估算读取范围：假设每行平均 512 字节
      const estimatedBytes = count * 512;
      const readSize = Math.min(estimatedBytes + 4096, stat.size); // 额外 4KB 余量
      const readOffset = Math.max(0, stat.size - readSize);

      const buffer = Buffer.alloc(readSize);
      const { bytesRead } = await handle.read(buffer, 0, readSize, readOffset);

      if (bytesRead === 0) return [];

      const content = buffer.toString("utf8", 0, bytesRead);
      const lines = content.split(/\r?\n/).filter((l) => l.trim());

      // 如果不是从文件开头读取，丢弃第一行（可能不完整）
      const startIndex = readOffset > 0 ? 1 : 0;
      // 跳过 header 行
      const headerSkipped = readOffset === 0 ? 1 : 0;

      const events: OrchestratorEvent[] = [];
      for (let i = startIndex + headerSkipped; i < lines.length; i++) {
        const parsed = parseJsonLine(lines[i]!);
        if (isOrchestratorEvent(parsed)) {
          events.push(parsed);
        }
      }

      // 按序列号排序后取尾部 N 条
      events.sort((a, b) => a.sequence - b.sequence);
      return events.slice(-count);
    } finally {
      await handle.close();
    }
  }

  async flush(): Promise<void> {
    await this.appendQueue;
    await this.appendBatcher?.flush();
    if (this.latchedFailure) {
      throw this.latchedFailure;
    }
  }

  /**
   * 在 appendQueue 串行化下用 stat 刷新 currentFileSize。
   *
   * currentFileSize 由 append 增量维护（currentFileSize += byteLength），但外部
   * 写入（或崩溃的对端进程）会让它失真。读路径在读取前调用此方法校正。通过链入
   * appendQueue 串行化，避免与并发 append 的增量更新互相覆盖（lost update）：
   * 若直接在读路径里 stat 并赋值，stat 读取与赋值之间可能插入一个 append 的增量
   * 更新，导致刚写入的事件偏移被旧值覆盖，字节偏移索引随之错位。
   */
  private async refreshFileSize(): Promise<void> {
    const next = this.appendQueue.then(async () => {
      // 先 flush batcher，确保 pending 数据落盘后再 stat。
      // 否则 stat.size 不含 pending append，currentFileSize 会被低估，
      // 导致后续 append 的 byteOffset 计算错位、字节偏移索引损坏。
      await this.appendBatcher?.flush();
      try {
        const stat = await statFile(this.filePath);
        this.currentFileSize = stat.size;
      } catch {
        // 文件可能尚不存在或暂时不可访问：保持现有 currentFileSize，不阻断读路径。
      }
    });
    this.appendQueue = next.then(
      () => undefined,
      () => undefined
    );
    await next;
  }

  async close(): Promise<void> {
    this.acceptingAppends = false;
    await this.flush();
    // 关闭前确保索引已持久化
    if (this.indexDirty) {
      await this.flushIndex();
    }
    // 释放批量追加写入器
    if (this.appendBatcher) {
      try {
        await this.appendBatcher.close();
      } catch {
        // 句柄释放失败不应阻断 close
      }
      this.appendBatcher = undefined;
    }
  }

  /**
   * 懒初始化 JsonlAppendBatcher。
   *
   * batcher 内部缓存文件句柄、累积写入并批量 fsync，相比逐条 writeFile+sync
   * 显著提升吞吐。首行换行与目录 fsync 由 batcher 自身处理。
   *
   * 字节偏移索引兼容：batcher 的 ensureLeadingNewline 在 handle 打开时检查
   * 文件末尾是否为 "\n"，若否则补一个 "\n"。我们在构造 batcher 前先 stat + 读
   * 尾字节，预测该前缀字节数并计入 currentFileSize，保证后续 byteOffset 计算
   * 准确。预测与 batcher 实际写入之间存在极小 TOCTOU 窗口（仅首次构造时），
   * 与原 appendLineWithCachedHandle 的窗口语义一致。
   */
  private async ensureAppendBatcher(): Promise<JsonlAppendBatcher> {
    if (!this.appendBatcher) {
      // 预测 batcher 是否会补首行 "\n" 前缀
      const stat = await statFile(this.filePath).catch(() => null);
      let prefixBytes = 0;
      if (stat && stat.size > 0) {
        const handle = await openFile(this.filePath, constants.O_RDONLY);
        try {
          const tail = Buffer.alloc(1);
          await handle.read(tail, 0, 1, stat.size - 1);
          if (tail[0] !== 10) {
            prefixBytes = 1;
          }
        } finally {
          await handle.close();
        }
      }
      this.currentFileSize = (stat?.size ?? 0) + prefixBytes;
      this.appendBatcher = new JsonlAppendBatcher({ filePath: this.filePath });
    }
    return this.appendBatcher;
  }

  /**
   * 判断是否应该立即刷盘索引。
   *
   * 条件：索引脏 且 距离上次刷盘超过 indexFlushIntervalMs。
   */
  private shouldFlushIndexNow(): boolean {
    if (!this.indexDirty) return false;
    if (this.indexFlushIntervalMs === 0) return true;
    if (this.indexFlushIntervalMs === Infinity) return false;
    return Date.now() - this.lastIndexFlushTime >= this.indexFlushIntervalMs;
  }

  /**
   * 显式刷盘索引：将内存中的 summary index 和 byte index 持久化到磁盘。
   *
   * 正常情况下 append() 会按 indexFlushIntervalMs 间隔自动刷盘，
   * 但调用方也可以在关键时刻（如 session 创建后、关闭前）主动调用此方法。
   *
   * @returns 是否实际执行了写入（false 表示索引不脏或未加载）
   */
  async flushIndex(): Promise<boolean> {
    // 串行化所有 flushIndex 调用方（append 内部、listSessionSummaries、close）。
    // listSessionSummaries 与 close 不在 appendQueue 内，若不加锁会与并发 append
    // 内的 flushIndex 竞争同一份内存索引与磁盘 companion file，导致写入交错或丢失。
    return this.flushMutex.runExclusive(() => this.flushIndexInner());
  }

  private async flushIndexInner(): Promise<boolean> {
    if (!this.indexDirty) return false;

    const needsSummaryIndexWrite = this.sessionSummaryCacheReady && this.metadata !== undefined;
    const needsByteIndexWrite = this.byteIndexLoaded && this.metadata !== undefined;
    // Neither index is loadable yet — keep dirty so a later flush can persist once ready.
    if (!needsSummaryIndexWrite && !needsByteIndexWrite) {
      return false;
    }

    let summaryIndexSynced = !needsSummaryIndexWrite;
    let byteIndexSynced = !needsByteIndexWrite;
    let anyWritten = false;

    if (needsSummaryIndexWrite) {
      await this.writeSessionSummaryIndex()
        .then(() => {
          summaryIndexSynced = true;
          anyWritten = true;
        })
        .catch((cause) => {
          this.indexWriteFailureCount++;
          this.lastIndexWriteError = cause instanceof Error ? cause : new Error(String(cause));
        });
    }

    if (needsByteIndexWrite) {
      await this.writeByteOffsetIndex()
        .then(() => {
          byteIndexSynced = true;
          anyWritten = true;
        })
        .catch((cause) => {
          this.indexWriteFailureCount++;
          this.lastIndexWriteError = cause instanceof Error ? cause : new Error(String(cause));
        });
    }

    if (summaryIndexSynced && byteIndexSynced) {
      this.indexDirty = false;
      this.lastIndexFlushTime = Date.now();
    }

    return anyWritten;
  }

  private async ensureHeader(): Promise<void> {
    if (this.headerReady) return;

    await mkdir(dirname(this.filePath), { recursive: true });
    const handle = await openFile(this.filePath, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR, 0o600);
    try {
      const stat = await handle.stat();
      if (stat.size === 0) {
        const header = normalizeHeader(this.options.header ?? createOrchestratorEventStoreHeader(), this.filePath);
        const headerLine = `${JSON.stringify(header)}\n`;
        await handle.writeFile(headerLine, "utf8");
        await handle.sync();
        this.applyHeader(header);
        this.headerReady = true;
        this.currentFileSize = Buffer.byteLength(headerLine, "utf8");
        return;
      }
      this.currentFileSize = stat.size;
    } finally {
      await handle.close();
    }

    const raw = await readFile(this.filePath, "utf8");
    const headerLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!headerLine) {
      throw new Error(`Invalid empty orchestrator event store file: ${this.filePath}`);
    }
    this.applyHeader(parseHeader(headerLine, this.filePath));
    this.headerReady = true;
  }

  private async enqueueAppend(operation: () => Promise<void>): Promise<void> {
    const next = this.appendQueue.then(operation, operation).catch((cause) => {
      const failure = normalizeEventStoreFailure(cause, this.filePath);
      // Only durable write failures latch the store. Client validation errors
      // (invalid event / duplicate id / closed) must leave subsequent appends viable.
      if (LATCHING_FAILURE_KINDS.has(failure.kind)) {
        this.latchedFailure ??= failure;
        throw this.latchedFailure;
      }
      throw failure;
    });
    this.appendQueue = next.then(
      () => undefined,
      () => undefined
    );
    await next;
  }

  private applyHeader(header: FileOrchestratorEventStoreHeader): void {
    this.metadata = metadataFromHeader(header);
  }

  private replaceEventCache(events: OrchestratorEvent[]): void {
    this.cachedEvents = events;
    this.cachedEventsBySession = new Map();
    this.cachedEventsByRun = new Map();
    this.cachedSessionSummaries = new Map();
    this.knownEventIds = new Set();
    for (const event of events) {
      this.knownEventIds.add(event.id);
      this.indexCachedEvent(event);
    }
    this.eventIdsReady = true;
    this.sessionSummaryCacheReady = true;
  }

  private appendCachedEvent(event: OrchestratorEvent): void {
    if (this.cachedEvents) {
      this.cachedEvents.push(event);
      if (this.cachedEvents.length > 1 && this.cachedEvents.at(-2)!.sequence > event.sequence) {
        this.cachedEvents.sort((left, right) => left.sequence - right.sequence);
      }
      this.evictCachedEventsIfNeeded();
      this.indexCachedEvent(event);
    } else if (this.sessionSummaryCacheReady) {
      updateSessionSummary(this.cachedSessionSummaries, event);
    }
  }

  private evictCachedEventsIfNeeded(): void {
    const maxCached = this.options.maxCachedEvents ?? 10_000;
    if (maxCached <= 0 || !this.cachedEvents) return;
    if (this.cachedEvents.length <= maxCached) return;
    // 保留最新的事件，淘汰最早的
    const evicted = this.cachedEvents.splice(0, this.cachedEvents.length - maxCached);
    // 从索引中移除被淘汰的事件
    for (const event of evicted) {
      const sessionEvents = this.cachedEventsBySession.get(event.sessionId);
      if (sessionEvents) {
        const index = sessionEvents.indexOf(event);
        if (index !== -1) sessionEvents.splice(index, 1);
        if (sessionEvents.length === 0) this.cachedEventsBySession.delete(event.sessionId);
      }
      if (event.runId) {
        const runEvents = this.cachedEventsByRun.get(event.runId);
        if (runEvents) {
          const index = runEvents.indexOf(event);
          if (index !== -1) runEvents.splice(index, 1);
          if (runEvents.length === 0) this.cachedEventsByRun.delete(event.runId);
        }
      }
    }
  }

  private indexCachedEvent(event: OrchestratorEvent): void {
    appendIndexedEvent(this.cachedEventsBySession, event.sessionId, event);
    if (event.runId) appendIndexedEvent(this.cachedEventsByRun, event.runId, event);
    updateSessionSummary(this.cachedSessionSummaries, event);
  }

  private sessionSummaryIndexPath(): string {
    return this.options.sessionSummaryIndexPath ?? `${this.filePath}.session-index.json`;
  }

  private async tryLoadSessionSummaryIndex(): Promise<boolean> {
    if (this.sessionSummaryCacheReady) return true;
    await this.ensureHeader();
    const metadata = this.metadata;
    if (!metadata) return false;

    const raw = await readFile(this.sessionSummaryIndexPath(), "utf8").catch(() => null);
    if (!raw?.trim()) return false;

    const parsed = parseJsonLine(raw);
    if (!isSessionSummaryIndex(parsed, metadata)) return false;

    // Deferred index flush can leave the on-disk index behind the event log. Detect that
    // window via max sequence and force a full rebuild so cold list reads stay complete.
    const indexMaxSequence = parsed.summaries.reduce(
      (max, summary) => Math.max(max, summary.lastSequence ?? 0),
      0
    );
    const logMaxSequence = await this.peekMaxEventSequence();
    if (logMaxSequence > indexMaxSequence) {
      return false;
    }

    this.cachedSessionSummaries = new Map(
      parsed.summaries.map((summary) => [
        summary.sessionId,
        {
          sessionId: summary.sessionId,
          lastUpdated: summary.lastUpdated,
          eventCount: summary.eventCount,
          runIds: new Set(summary.runIds),
          runStates: new Map((summary.runStates ?? []).map((state) => [state.runId, state])),
          pendingInputIds: new Set(summary.pendingInputIds ?? []),
          pendingInputEventCount: summary.pendingInputEventCount ?? (summary.pendingInputIds?.length ? summary.pendingInputIds.length : 0),
          ...(summary.lastEventId !== undefined ? { lastEventId: summary.lastEventId } : {}),
          ...(summary.lastSequence !== undefined ? { lastSequence: summary.lastSequence } : {}),
          ...(summary.lastMessagePreview !== undefined ? { lastMessagePreview: summary.lastMessagePreview } : {})
        }
      ])
    );
    this.sessionSummaryCacheReady = true;
    return true;
  }

  /**
   * Peek the highest event sequence currently present in the JSONL log.
   * Used to detect deferred-flush session summary index staleness.
   */
  private async peekMaxEventSequence(): Promise<number> {
    const tail = await this.readTailEvents(1);
    return tail.at(-1)?.sequence ?? 0;
  }

  private async writeSessionSummaryIndex(): Promise<void> {
    if (!this.sessionSummaryCacheReady || !this.metadata) return;
    const filePath = this.sessionSummaryIndexPath();
    const index: FileOrchestratorSessionSummaryIndex = {
      type: "orchestrator-session-summary-index",
      version: ORCHESTRATOR_SESSION_SUMMARY_INDEX_VERSION,
      protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
      eventLogId: this.metadata.eventLogId,
      generation: this.metadata.generation,
      schemaVersion: this.metadata.schemaVersion,
      summaries: [...this.cachedSessionSummaries.values()].map((summary) => ({
        sessionId: summary.sessionId,
        lastUpdated: summary.lastUpdated,
        eventCount: summary.eventCount,
        runIds: [...summary.runIds].sort(),
        runStates: [...summary.runStates.values()].sort((left, right) => left.runId.localeCompare(right.runId)),
        pendingInputIds: [...summary.pendingInputIds].sort(),
        pendingInputEventCount: summary.pendingInputEventCount,
        ...(summary.lastEventId !== undefined ? { lastEventId: summary.lastEventId } : {}),
        ...(summary.lastSequence !== undefined ? { lastSequence: summary.lastSequence } : {}),
        ...(summary.lastMessagePreview !== undefined ? { lastMessagePreview: summary.lastMessagePreview } : {})
      }))
    };
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(index)}\n`, "utf8");
    await rename(tempPath, filePath);
  }
}

function appendIndexedEvent(
  index: Map<string, OrchestratorEvent[]>,
  key: string,
  event: OrchestratorEvent
): void {
  const events = index.get(key);
  if (!events) {
    index.set(key, [event]);
    return;
  }
  events.push(event);
  if (events.length > 1 && events.at(-2)!.sequence > event.sequence) {
    events.sort((left, right) => left.sequence - right.sequence);
  }
}

function collectAfterSequence(events: OrchestratorEvent[], afterSequence: number, maxEvents?: number): OrchestratorEvent[] {
  if (maxEvents === 0) return [];
  const collected: OrchestratorEvent[] = [];
  for (const event of events) {
    if (event.sequence <= afterSequence) continue;
    collected.push(event);
    if (maxEvents !== undefined && collected.length >= maxEvents) break;
  }
  return collected;
}

function normalizeEventStoreFailure(cause: unknown, filePath: string): OrchestratorEventStoreError {
  if (cause instanceof OrchestratorEventStoreError) {
    return cause;
  }
  return new OrchestratorEventStoreWriteError(filePath, undefined, cause);
}

function assertAppendableEvent(event: OrchestratorEvent, filePath: string): void {
  const eventId = isRecord(event) && typeof event.id === "string" ? event.id : undefined;

  if (!isRecord(event)) {
    throw new OrchestratorEventStoreInvalidEventError(filePath, eventId, "event must be an object");
  }
  if (!isOrchestratorEvent(event)) {
    throw new OrchestratorEventStoreInvalidEventError(
      filePath,
      eventId,
      "event failed structural validation (protocolVersion, id, sequence, type, sessionId, timestamp, payload)"
    );
  }
  if (event.id.trim().length === 0) {
    throw new OrchestratorEventStoreInvalidEventError(filePath, event.id, "id must be a non-empty string");
  }
  if (event.sessionId.trim().length === 0) {
    throw new OrchestratorEventStoreInvalidEventError(filePath, event.id, "sessionId must be a non-empty string");
  }
  if (event.runId !== undefined && event.runId.trim().length === 0) {
    throw new OrchestratorEventStoreInvalidEventError(filePath, event.id, "runId must be non-empty when provided");
  }
  if (event.timestamp.trim().length === 0) {
    throw new OrchestratorEventStoreInvalidEventError(filePath, event.id, "timestamp must be a non-empty string");
  }
}

function assertNonEmptyId(value: string, label: "sessionId" | "runId", filePath: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OrchestratorEventStoreInvalidReadError(filePath, `${label} must be a non-empty string`);
  }
}

function normalizeReadOptions(
  afterSequence: number,
  options: OrchestratorEventReadOptions,
  filePath: string
): { afterSequence: number; maxEvents?: number } {
  if (!Number.isInteger(afterSequence) || afterSequence < 0) {
    throw new OrchestratorEventStoreInvalidReadError(
      filePath,
      `afterSequence must be a non-negative integer (received ${String(afterSequence)})`
    );
  }

  const maxEvents = options.maxEvents;
  if (maxEvents === undefined) {
    return { afterSequence };
  }
  if (!Number.isInteger(maxEvents) || maxEvents < 0) {
    throw new OrchestratorEventStoreInvalidReadError(
      filePath,
      `maxEvents must be a non-negative integer when provided (received ${String(maxEvents)})`
    );
  }
  return { afterSequence, maxEvents };
}

function parseHeader(line: string, filePath: string): FileOrchestratorEventStoreHeader {
  const parsed = parseJsonLine(line);
  if (!isRecord(parsed) || parsed.type !== "orchestrator-event-store") {
    throw new Error(`Invalid orchestrator event store header in ${filePath}`);
  }
  if (parsed.version !== ORCHESTRATOR_EVENT_STORE_FILE_VERSION) {
    throw new Error(`Unsupported orchestrator event store version ${String(parsed.version)} in ${filePath}`);
  }
  if (parsed.protocolVersion !== ORCHESTRATOR_PROTOCOL_VERSION) {
    throw new Error(`Unsupported orchestrator protocol version ${String(parsed.protocolVersion)} in ${filePath}`);
  }
  return normalizeHeader(parsed, filePath);
}

function normalizeHeader(value: unknown, filePath: string): FileOrchestratorEventStoreHeader {
  if (!isRecord(value) || value.type !== "orchestrator-event-store") {
    throw new Error(`Invalid orchestrator event store header in ${filePath}`);
  }
  if (value.version !== ORCHESTRATOR_EVENT_STORE_FILE_VERSION) {
    throw new Error(`Unsupported orchestrator event store version ${String(value.version)} in ${filePath}`);
  }
  if (value.protocolVersion !== ORCHESTRATOR_PROTOCOL_VERSION) {
    throw new Error(`Unsupported orchestrator protocol version ${String(value.protocolVersion)} in ${filePath}`);
  }
  const schemaVersion =
    typeof value.schemaVersion === "number" && Number.isInteger(value.schemaVersion) && value.schemaVersion > 0
      ? value.schemaVersion
      : ORCHESTRATOR_EVENT_LOG_SCHEMA_VERSION;
  if (schemaVersion !== ORCHESTRATOR_EVENT_LOG_SCHEMA_VERSION) {
    throw new Error(`Unsupported orchestrator event log schema version ${String(schemaVersion)} in ${filePath}`);
  }
  const generation =
    typeof value.generation === "number" && Number.isInteger(value.generation) && value.generation > 0
      ? value.generation
      : 1;
  const eventLogId =
    typeof value.eventLogId === "string" && value.eventLogId.length > 0
      ? value.eventLogId
      : deterministicEventLogId(filePath);

  return {
    type: "orchestrator-event-store",
    version: ORCHESTRATOR_EVENT_STORE_FILE_VERSION,
    protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
    eventLogId,
    generation,
    schemaVersion: ORCHESTRATOR_EVENT_LOG_SCHEMA_VERSION
  };
}

function metadataFromHeader(header: FileOrchestratorEventStoreHeader): OrchestratorEventLogMetadata {
  return {
    eventLogId: header.eventLogId,
    generation: header.generation,
    schemaVersion: header.schemaVersion,
    protocolVersion: header.protocolVersion
  };
}

function isSessionSummaryIndex(
  value: unknown,
  metadata: OrchestratorEventLogMetadata
): value is FileOrchestratorSessionSummaryIndex {
  if (
    !isRecord(value) ||
    value.type !== "orchestrator-session-summary-index" ||
    value.version !== ORCHESTRATOR_SESSION_SUMMARY_INDEX_VERSION ||
    value.protocolVersion !== metadata.protocolVersion ||
    value.eventLogId !== metadata.eventLogId ||
    value.generation !== metadata.generation ||
    value.schemaVersion !== metadata.schemaVersion ||
    !Array.isArray(value.summaries)
  ) {
    return false;
  }

  return value.summaries.every((summary) => {
    if (!isRecord(summary)) return false;
    const { sessionId, lastUpdated, eventCount, runIds, runStates, pendingInputIds, pendingInputEventCount, lastEventId, lastSequence, lastMessagePreview } = summary;
    if (typeof sessionId !== "string" || sessionId.length === 0) return false;
    if (typeof lastUpdated !== "string" || lastUpdated.length === 0) return false;
    if (!Number.isInteger(eventCount) || typeof eventCount !== "number" || eventCount < 0) return false;
    if (!Array.isArray(runIds) || !runIds.every((runId) => typeof runId === "string" && runId.length > 0)) {
      return false;
    }
    if (runStates !== undefined && !isRunSummaryStateArray(runStates)) return false;
    if (pendingInputIds !== undefined && !isStringArray(pendingInputIds)) return false;
    if (pendingInputEventCount !== undefined && (!Number.isInteger(pendingInputEventCount) || typeof pendingInputEventCount !== "number" || pendingInputEventCount < 0)) {
      return false;
    }
    if (lastEventId !== undefined && typeof lastEventId !== "string") return false;
    if (lastSequence !== undefined && (!Number.isInteger(lastSequence) || typeof lastSequence !== "number" || lastSequence < 0)) return false;
    if (lastMessagePreview !== undefined && typeof lastMessagePreview !== "string") return false;
    return true;
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isRunSummaryStateArray(value: unknown): value is OrchestratorRunSummaryState[] {
  return (
    Array.isArray(value) &&
    value.every((state) => {
      if (!isRecord(state)) return false;
      if (typeof state.runId !== "string" || state.runId.length === 0) return false;
      if (
        state.status !== "queued" &&
        state.status !== "running" &&
        state.status !== "awaiting-approval" &&
        state.status !== "cancelling" &&
        state.status !== "cancelled" &&
        state.status !== "completed" &&
        state.status !== "failed"
      ) {
        return false;
      }
      if (typeof state.updatedAt !== "string" || state.updatedAt.length === 0) return false;
      if (state.lastEventId !== undefined && typeof state.lastEventId !== "string") return false;
      if (state.lastSequence !== undefined && (!Number.isInteger(state.lastSequence) || typeof state.lastSequence !== "number" || state.lastSequence < 0)) {
        return false;
      }
      return true;
    })
  );
}

function deterministicEventLogId(filePath: string): string {
  return `eventlog_${createHash("sha256").update(filePath).digest("hex").slice(0, 24)}`;
}

export function createOrchestratorEventStoreHeader(
  input: Partial<Pick<FileOrchestratorEventStoreHeader, "eventLogId" | "generation">> = {}
): FileOrchestratorEventStoreHeader {
  return {
    ...DEFAULT_HEADER,
    eventLogId: input.eventLogId && input.eventLogId.length > 0 ? input.eventLogId : `eventlog_${randomUUID()}`,
    generation: input.generation && input.generation > 0 ? input.generation : 1
  };
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isOrchestratorEvent(value: unknown): value is OrchestratorEvent {
  const sequence = isRecord(value) ? value.sequence : undefined;
  return (
    isRecord(value) &&
    value.protocolVersion === ORCHESTRATOR_PROTOCOL_VERSION &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof sequence === "number" &&
    Number.isInteger(sequence) &&
    sequence > 0 &&
    typeof value.type === "string" &&
    EVENT_TYPES.has(value.type as OrchestratorEventType) &&
    typeof value.sessionId === "string" &&
    value.sessionId.trim().length > 0 &&
    (value.runId === undefined || (typeof value.runId === "string" && value.runId.trim().length > 0)) &&
    typeof value.timestamp === "string" &&
    value.timestamp.trim().length > 0 &&
    isRecord(value.payload)
  );
}
