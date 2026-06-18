import { constants } from "node:fs";
import { mkdir, open as openFile, readFile, rename, writeFile } from "node:fs/promises";
import { createReadStream, type ReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { isRecord } from "@crish/shared-utils";
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

export type OrchestratorEventStoreFailureKind = "closed" | "write-failed" | "index-write-failed";

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
    if (!this.acceptingAppends) {
      throw new OrchestratorEventStoreClosedError(this.filePath, event.id);
    }
    if (this.latchedFailure) {
      throw this.latchedFailure;
    }

    await this.enqueueAppend(async () => {
      try {
        await this.ensureHeader();
        await this.tryLoadSessionSummaryIndex();
        await this.tryLoadByteOffsetIndex();

        // 计算字节偏移（当前文件大小即为新事件的起始偏移）
        const serialized = JSON.stringify(event);
        const byteOffset = this.currentFileSize;
        const byteLength = Buffer.byteLength(serialized, "utf8") + 1; // +1 for newline

        await appendJsonlLine(this.filePath, serialized);
        this.currentFileSize += byteLength;

        // 追踪字节偏移
        this.trackByteOffset(event.sessionId, byteOffset, byteLength);

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
    if (!this.byteIndexLoaded) {
      await this.tryLoadByteOffsetIndex();
    }

    // ── 三层策略：优先使用字节偏移索引（tier 2）─
    if (this.byteIndexLoaded && this.byteOffsetIndex.has(sessionId)) {
      const events = await this.readSessionViaByteIndex(sessionId, afterSequence);
      if (events.length > 0) return this.applyMaxEvents(events, options.maxEvents);
    }

    // ── 兜底：全量缓存读取（tier 3 的简化版）─
    await this.ensureEventCache();
    return collectAfterSequence(this.cachedEventsBySession.get(sessionId) ?? [], afterSequence, options.maxEvents);
  }

  async readRun(runId: string, afterSequence = 0, options: OrchestratorEventReadOptions = {}): Promise<OrchestratorEvent[]> {
    await this.ensureEventCache();
    return collectAfterSequence(this.cachedEventsByRun.get(runId) ?? [], afterSequence, options.maxEvents);
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
    return [...this.cachedSessionSummaries.values()]
      .map(toOrchestratorSessionEventSummary)
      .sort((left, right) => compareSessionSummaries(left, right));
  }

  async readAll(afterSequence = 0, options: OrchestratorEventReadOptions = {}): Promise<OrchestratorEvent[]> {
    await this.ensureEventCache();
    return collectAfterSequence(this.cachedEvents ?? [], afterSequence, options.maxEvents);
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
    await this.flush();
    await this.ensureHeader();

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
      if (isOrchestratorEvent(parsed) && parsed.sequence > afterSequence) {
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
    if (this.latchedFailure) {
      throw this.latchedFailure;
    }
  }

  async close(): Promise<void> {
    this.acceptingAppends = false;
    await this.flush();
    // 关闭前确保索引已持久化
    if (this.indexDirty) {
      await this.flushIndex();
    }
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
    if (!this.indexDirty) return false;

    const needsSummaryIndexWrite = this.sessionSummaryCacheReady && this.metadata !== undefined;
    const needsByteIndexWrite = this.byteIndexLoaded && this.metadata !== undefined;
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
      this.latchedFailure ??= failure;
      throw this.latchedFailure;
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
    for (const event of events) {
      this.indexCachedEvent(event);
    }
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

async function appendJsonlLine(filePath: string, line: string): Promise<void> {
  const handle = await openFile(filePath, constants.O_APPEND | constants.O_RDWR);
  try {
    const stat = await handle.stat();
    let prefix = "";
    if (stat.size > 0) {
      const tail = Buffer.alloc(1);
      await handle.read(tail, 0, 1, stat.size - 1);
      if (tail[0] !== 10) prefix = "\n";
    }
    await handle.writeFile(`${prefix}${line}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
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
    typeof sequence === "number" &&
    Number.isInteger(sequence) &&
    sequence > 0 &&
    typeof value.type === "string" &&
    EVENT_TYPES.has(value.type as OrchestratorEventType) &&
    typeof value.sessionId === "string" &&
    (value.runId === undefined || typeof value.runId === "string") &&
    typeof value.timestamp === "string" &&
    isRecord(value.payload)
  );
}
