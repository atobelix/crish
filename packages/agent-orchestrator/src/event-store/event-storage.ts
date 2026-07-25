import { constants } from "node:fs";
import { mkdir, open as openFile, readFile, rename, stat as statFile, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { retryWithBackoff } from "@crish/shared-utils";
import { JsonlAppendBatcher, type JsonlAppendBatcherOptions } from "@crish/shared-utils/node";
import type {
  OrchestratorEvent,
  OrchestratorEventLogMetadata,
  OrchestratorEventReadOptions,
  OrchestratorSessionEventSummary,
  OrchestratorEventStore
} from "../types";
import {
  compareSessionSummaries,
  toOrchestratorSessionEventSummary,
  updateSessionSummary
} from "../session-summary";
import { defaultStateSnapshotPath, loadStateSnapshotFile, writeStateSnapshotFile, type OrchestratorStateSnapshot } from "../state-snapshot";
import {
  assertAppendableEvent,
  assertNonEmptyId,
  collectAfterSequence,
  createOrchestratorEventStoreHeader,
  isOrchestratorEvent,
  LATCHING_FAILURE_KINDS,
  metadataFromHeader,
  normalizeEventStoreFailure,
  normalizeHeader,
  normalizeReadOptions,
  OrchestratorEventStoreClosedError,
  OrchestratorEventStoreDuplicateIdError,
  OrchestratorEventStoreError,
  OrchestratorEventStoreInvalidReadError,
  OrchestratorEventStoreWriteError,
  parseHeader,
  parseJsonLine,
  sortedBySequence,
  type FileOrchestratorEventStoreHeader,
  type FileOrchestratorEventStoreOptions
} from "./event-types";
import { EventIndexer } from "./event-indexer";

export class FileOrchestratorEventStore implements OrchestratorEventStore {
  private appendQueue: Promise<void> = Promise.resolve();
  private headerReady = false;
  private metadata: OrchestratorEventLogMetadata | undefined;
  private acceptingAppends = true;
  private latchedFailure?: OrchestratorEventStoreError;
  private cachedEvents?: OrchestratorEvent[];
  private cachedEventsBySession = new Map<string, Set<OrchestratorEvent>>();
  private cachedEventsByRun = new Map<string, Set<OrchestratorEvent>>();
  private appendBatcher: JsonlAppendBatcher | undefined;

  private knownEventIds = new Set<string>();
  private eventIdsReady = false;

  private currentFileSize = 0;
  private indexer = new EventIndexer();

  private indexFlushIntervalMs: number;
  private static readonly TAIL_BOOTSTRAP_EVENT_COUNT = 1000;
  private signalCleanup: (() => void) | undefined;

  private readonly maxSizeBytes: number;
  private readonly maxArchives: number;
  private nextGeneration: number;

  constructor(
    private readonly filePath: string,
    private readonly options: FileOrchestratorEventStoreOptions = {
      header: undefined,
      sessionSummaryIndexPath: undefined,
      maxCachedEvents: undefined,
      indexFlushIntervalMs: undefined,
      maxSizeBytes: undefined,
      maxArchives: undefined
    }
  ) {
    this.indexFlushIntervalMs = options.indexFlushIntervalMs ?? 5_000;
    this.maxSizeBytes = options.maxSizeBytes ?? 100 * 1024 * 1024;
    this.maxArchives = options.maxArchives ?? 10;
    this.nextGeneration = (options.header?.generation ?? 1) + 1;
  }

  installSignalHandlers(): () => void {
    if (this.signalCleanup) return this.signalCleanup;

    const doFlush = async () => {
      try {
        await this.close();
      } catch {
        // silent: close 失败不阻塞进程退出
      }
    };

    const onSigTerm = () => { doFlush().finally(() => process.exit(0)); };
    const onSigInt = () => { doFlush().finally(() => process.exit(0)); };
    const onExit = () => {
      if (this.appendBatcher?.pendingRecords && this.appendBatcher.pendingRecords > 0) {
        try { this.appendBatcher.flush(); } catch { /* silent */ }
      }
    };

    process.on("SIGTERM", onSigTerm);
    process.on("SIGINT", onSigInt);
    process.on("exit", onExit);

    this.signalCleanup = () => {
      process.off("SIGTERM", onSigTerm);
      process.off("SIGINT", onSigInt);
      process.off("exit", onExit);
      this.signalCleanup = undefined;
    };

    return this.signalCleanup;
  }

  healthCheck(): { writable: boolean; indexSynced: boolean; indexDirty: boolean; indexWriteFailureCount: number; lastIndexWriteError: string | undefined } {
    return this.indexer.healthCheck(this.acceptingAppends, this.latchedFailure);
  }

  async append(event: OrchestratorEvent): Promise<void> {
    assertAppendableEvent(event, this.filePath);

    if (!this.acceptingAppends) {
      throw new OrchestratorEventStoreClosedError(this.filePath, event.id);
    }
    if (this.latchedFailure) {
      throw this.latchedFailure;
    }

    await this.enqueueAppend(async () => {
      try {
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

        const serialized = JSON.stringify(event);
        const byteLength = Buffer.byteLength(serialized, "utf8") + 1;
        if (this.maxSizeBytes > 0 && this.currentFileSize + byteLength > this.maxSizeBytes) {
          await this.rotateFile();
          await this.ensureHeader();
        }

        const batcher = await this.ensureAppendBatcher();
        await retryWithBackoff(
          () => batcher.append(serialized),
          { maxAttempts: 3, baseMs: 200, maxMs: 1500 }
        );
        const byteOffset = this.currentFileSize;
        this.currentFileSize += byteLength;

        this.indexer.trackByteOffset(event.sessionId, byteOffset, byteLength);
        this.knownEventIds.add(event.id);
        this.appendCachedEvent(event);
        this.indexer.updateSessionIndex(event, byteOffset, byteLength);
        this.indexer.indexDirty = true;

        if (this.indexer.shouldFlushIndexNow(this.indexFlushIntervalMs)) {
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

  async readSession(sessionId: string, afterSequence = 0, options: OrchestratorEventReadOptions = { maxEvents: undefined }): Promise<OrchestratorEvent[]> {
    assertNonEmptyId(sessionId, "sessionId", this.filePath);
    const read = normalizeReadOptions(afterSequence, options, this.filePath);

    await this.flush();

    if (!this.indexer.byteIndexLoaded) {
      await this.tryLoadByteOffsetIndex();
    }

    if (this.indexer.byteIndexLoaded && this.indexer.byteOffsetIndex.has(sessionId)) {
      const events = await this.readSessionViaByteIndex(sessionId, read.afterSequence);
      if (events.length > 0 || read.afterSequence > 0 || read.maxEvents === 0) {
        return this.applyMaxEvents(events, read.maxEvents);
      }
    }

    await this.ensureEventCache();
    return collectAfterSequence(
      sortedBySequence(this.cachedEventsBySession.get(sessionId)),
      read.afterSequence,
      read.maxEvents
    );
  }

  async readRun(runId: string, afterSequence = 0, options: OrchestratorEventReadOptions = { maxEvents: undefined }): Promise<OrchestratorEvent[]> {
    assertNonEmptyId(runId, "runId", this.filePath);
    const read = normalizeReadOptions(afterSequence, options, this.filePath);

    if (this.cachedEvents) {
      return collectAfterSequence(
        sortedBySequence(this.cachedEventsByRun.get(runId)),
        read.afterSequence,
        read.maxEvents
      );
    }

    const collected: OrchestratorEvent[] = [];
    for await (const event of this.readAllStreaming(read.afterSequence)) {
      if (event.runId !== runId) continue;
      collected.push(event);
    }
    collected.sort((left, right) => left.sequence - right.sequence);
    return this.applyMaxEvents(collected, read.maxEvents);
  }

  async getMetadata(): Promise<OrchestratorEventLogMetadata> {
    if (!this.headerReady || !this.metadata) {
      await this.ensureHeader();
    }
    return this.metadata!;
  }

  async listSessionSummaries(): Promise<OrchestratorSessionEventSummary[]> {
    await this.flush();
    if (this.indexer.sessionIndexComplete && this.indexer.sessionIndex.size > 0) {
      const summaries: OrchestratorSessionEventSummary[] = [];
      this.indexer.sessionIndex.forEachRecent((entry) => {
        summaries.push(toOrchestratorSessionEventSummary(entry.summary));
        return true;
      });
      summaries.sort((left, right) => compareSessionSummaries(left, right));
      return summaries;
    }
    if (!this.indexer.sessionSummaryCacheReady && !(await this.tryLoadSessionSummaryIndex())) {
      await this.ensureEventCache();
    }
    if (this.indexer.indexDirty) {
      await this.flushIndex();
    }
    return [...this.indexer.cachedSessionSummaries.values()]
      .map(toOrchestratorSessionEventSummary)
      .sort((left, right) => compareSessionSummaries(left, right));
  }

  async readAll(afterSequence = 0, options: OrchestratorEventReadOptions = { maxEvents: undefined }): Promise<OrchestratorEvent[]> {
    const read = normalizeReadOptions(afterSequence, options, this.filePath);
    await this.ensureEventCache();
    return collectAfterSequence(this.cachedEvents ?? [], read.afterSequence, read.maxEvents);
  }

  async *readAllStreaming(afterSequence = 0): AsyncGenerator<OrchestratorEvent> {
    const read = normalizeReadOptions(afterSequence, { maxEvents: undefined }, this.filePath);
    await this.flush();
    await this.ensureHeader();

    const stream = createReadStream(this.filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let streamError: Error | null = null;
    stream.on("error", (error: Error) => {
      streamError = error;
    });

    let headerSkipped = false;
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;

        if (!headerSkipped) {
          headerSkipped = true;
          continue;
        }

        const parsed = parseJsonLine(line);
        if (isOrchestratorEvent(parsed) && parsed.sequence > read.afterSequence) {
          yield parsed;
        }
      }
    } finally {
      stream.destroy();
    }

    if (streamError) throw streamError;
  }

  private async readSessionViaByteIndex(
    sessionId: string,
    afterSequence: number
  ): Promise<OrchestratorEvent[]> {
    const ranges = this.indexer.byteOffsetIndex.get(sessionId);
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

  private async tryLoadByteOffsetIndex(): Promise<boolean> {
    if (!this.metadata) await this.ensureHeader();
    if (!this.metadata) return false;
    return this.indexer.tryLoadByteOffsetIndex(this.byteIndexPath(), this.metadata);
  }

  private async tryLoadSessionSummaryIndex(): Promise<boolean> {
    if (!this.metadata) await this.ensureHeader();
    if (!this.metadata) return false;
    return this.indexer.tryLoadSessionSummaryIndex(
      this.sessionSummaryIndexPath(),
      this.metadata,
      () => this.peekMaxEventSequence()
    );
  }

  private byteIndexPath(): string {
    return `${this.filePath}.byte-index.json`;
  }

  private sessionSummaryIndexPath(): string {
    return this.options.sessionSummaryIndexPath ?? `${this.filePath}.session-index.json`;
  }

  private async rotateFile(): Promise<void> {
    if (this.appendBatcher) {
      await this.appendBatcher.flush();
      await this.appendBatcher.close();
      this.appendBatcher = undefined;
    }

    const archivePath = (n: number) => `${this.filePath}.${n}.jsonl`;

    const oldestPath = archivePath(this.maxArchives);
    try { await unlink(oldestPath); } catch { /* silent */ }

    for (let i = this.maxArchives - 1; i >= 1; i--) {
      try { await rename(archivePath(i), archivePath(i + 1)); } catch { /* silent */ }
    }

    try { await rename(this.filePath, archivePath(1)); } catch { /* silent */ }

    const existingId = this.metadata?.eventLogId ?? (this.options.header?.eventLogId || undefined);

    this.headerReady = false;
    this.metadata = undefined;
    this.currentFileSize = 0;
    this.indexer.byteOffsetIndex.clear();
    this.indexer.byteIndexLoaded = false;
    this.indexer.indexDirty = true;

    (this.options as unknown as Record<string, unknown>).header = createOrchestratorEventStoreHeader({
      eventLogId: existingId ?? undefined,
      generation: this.nextGeneration++,
    });
  }

  private applyMaxEvents(events: OrchestratorEvent[], maxEvents?: number): OrchestratorEvent[] {
    if (maxEvents === undefined || events.length <= maxEvents) return events;
    return events.slice(0, maxEvents);
  }

  private async ensureEventCache(): Promise<void> {
    await this.flush();
    if (this.cachedEvents) return;

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
    await this.indexer.writeSessionSummaryIndex(this.sessionSummaryIndexPath(), this.metadata!).catch((cause) => {
      this.indexer.indexWriteFailureCount++;
      this.indexer.lastIndexWriteError = cause instanceof Error ? cause : new Error(String(cause));
    });
  }

  private async ensureEventIdsLoaded(): Promise<void> {
    if (this.eventIdsReady) return;

    if (this.cachedEvents) {
      for (const item of this.cachedEvents) {
        this.knownEventIds.add(item.id);
      }
      this.eventIdsReady = true;
      return;
    }

    const stream = createReadStream(this.filePath, { encoding: "utf8" });
    let streamError: Error | null = null;
    stream.on("error", (error: Error) => {
      streamError = error;
    });
    try {
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let headerSkipped = false;
      for await (const line of rl) {
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
      if (streamError) throw streamError;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw error;
    } finally {
      stream.destroy();
    }
    this.eventIdsReady = true;
  }

  async bootstrapFromTail(): Promise<boolean> {
    await this.flush();
    if (this.indexer.sessionSummaryCacheReady) return true;

    if (await this.tryLoadSessionSummaryIndex()) {
      return true;
    }

    await this.ensureHeader();
    await this.tryLoadByteOffsetIndex();

    const tailEvents = await this.readTailEvents(FileOrchestratorEventStore.TAIL_BOOTSTRAP_EVENT_COUNT);
    if (tailEvents.length === 0) {
      this.indexer.cachedSessionSummaries = new Map();
      this.indexer.sessionSummaryCacheReady = true;
      return true;
    }

    for (const event of tailEvents) {
      updateSessionSummary(this.indexer.cachedSessionSummaries, event);
    }
    this.indexer.sessionSummaryCacheReady = true;

    for (const [sessionId, summary] of this.indexer.cachedSessionSummaries) {
      this.indexer.sessionIndex.set(sessionId, {
        firstOffset: 0,
        lastOffset: 0,
        eventCount: summary.eventCount,
        lastUpdated: Date.now(),
        summary,
      });
    }
    this.indexer.sessionIndexComplete = true;

    if (this.metadata) {
      await this.indexer.writeSessionSummaryIndex(this.sessionSummaryIndexPath(), this.metadata).catch((cause) => {
        this.indexer.indexWriteFailureCount++;
        this.indexer.lastIndexWriteError = cause instanceof Error ? cause : new Error(String(cause));
      });
    }

    return true;
  }

  private async readTailEvents(count: number): Promise<OrchestratorEvent[]> {
    const handle = await openFile(this.filePath, constants.O_RDONLY);
    try {
      const { size } = await handle.stat();
      if (size === 0) return [];

      const CHUNK = 65536;
      let pos = size;
      const collected: string[] = [];
      let carry = "";

      while (pos > 0 && collected.length < count) {
        const readSize = Math.min(CHUNK, pos);
        pos -= readSize;
        const buf = Buffer.alloc(readSize);
        const { bytesRead } = await handle.read(buf, 0, readSize, pos);
        if (bytesRead === 0) break;

        const text = buf.toString("utf8", 0, bytesRead);
        const parts = text.split("\n");
        parts[parts.length - 1] += carry;
        carry = parts[0]!;

        for (let i = parts.length - 1; i >= 1; i--) {
          if (parts[i]!.trim()) {
            collected.push(parts[i]!);
            if (collected.length >= count) break;
          }
        }
      }

      const events: OrchestratorEvent[] = [];
      let headerSeen = false;
      for (let i = collected.length - 1; i >= 0; i--) {
        const line = collected[i]!;
        if (!headerSeen) {
          const parsed = parseJsonLine(line);
          if (parsed && isOrchestratorEvent(parsed)) {
            headerSeen = true;
            events.push(parsed);
          }
          continue;
        }
        const parsed = parseJsonLine(line);
        if (isOrchestratorEvent(parsed)) {
          events.push(parsed);
        }
      }

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

  private async refreshFileSize(): Promise<void> {
    const next = this.appendQueue.then(async () => {
      await this.appendBatcher?.flush();
      try {
        const stat = await statFile(this.filePath);
        this.currentFileSize = stat.size;
      } catch {
        // silent
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
    try {
      await this.flush();
    } catch { /* isolate flush failure */ }
    if (this.indexer.indexDirty) {
      try {
        await this.flushIndex();
      } catch { /* isolate flushIndex failure */ }
    }
    if (this.appendBatcher) {
      try {
        await this.appendBatcher.close();
      } catch {
        // silent
      }
      this.appendBatcher = undefined;
    }
  }

  private async ensureAppendBatcher(): Promise<JsonlAppendBatcher> {
    if (!this.appendBatcher) {
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
      this.appendBatcher = new JsonlAppendBatcher({ filePath: this.filePath } as JsonlAppendBatcherOptions);
    }
    return this.appendBatcher;
  }

  async flushIndex(): Promise<boolean> {
    return this.indexer.flushIndex(
      this.sessionSummaryIndexPath(),
      this.byteIndexPath(),
      this.metadata
    );
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

      const headerBuffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(headerBuffer, 0, headerBuffer.length, 0);
      const content = headerBuffer.toString("utf8", 0, bytesRead);
      const headerLine = content.split(/\r?\n/).find((line) => line.trim().length > 0);
      if (!headerLine) {
        throw new OrchestratorEventStoreInvalidReadError(this.filePath, `Invalid empty orchestrator event store file: ${this.filePath}`);
      }
      this.applyHeader(parseHeader(headerLine, this.filePath));
      this.headerReady = true;
    } finally {
      await handle.close();
    }
  }

  private async enqueueAppend(operation: () => Promise<void>): Promise<void> {
    const next = this.appendQueue.then(operation, operation).catch((cause) => {
      const failure = normalizeEventStoreFailure(cause, this.filePath);
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
    this.indexer.replaceEventCache(
      events,
      (evts) => { this.cachedEvents = evts; },
      this.cachedEventsBySession,
      this.cachedEventsByRun,
      (ids) => {
        this.knownEventIds = ids;
        this.eventIdsReady = true;
      }
    );
  }

  private appendCachedEvent(event: OrchestratorEvent): void {
    if (this.cachedEvents) {
      this.cachedEvents.push(event);
      if (this.cachedEvents.length > 1 && this.cachedEvents.at(-2)!.sequence > event.sequence) {
        this.cachedEvents.sort((left, right) => left.sequence - right.sequence);
      }
      this.indexer.evictCachedEventsIfNeeded(
        this.cachedEvents,
        this.options.maxCachedEvents,
        this.cachedEventsBySession,
        this.cachedEventsByRun
      );
      this.indexer.indexCachedEvent(event, this.cachedEventsBySession, this.cachedEventsByRun);
    } else if (this.indexer.sessionSummaryCacheReady) {
      updateSessionSummary(this.indexer.cachedSessionSummaries, event);
    }
    this.indexer.updateSessionIndex(event);
  }

  private async peekMaxEventSequence(): Promise<number> {
    const tail = await this.readTailEvents(1);
    return tail.at(-1)?.sequence ?? 0;
  }

  stateSnapshotPath(): string {
    return defaultStateSnapshotPath(this.filePath);
  }

  async loadStateSnapshot(): Promise<OrchestratorStateSnapshot | null> {
    await this.ensureHeader();
    if (!this.metadata) return null;
    return loadStateSnapshotFile(this.stateSnapshotPath(), this.metadata);
  }

  async writeStateSnapshot(snapshot: OrchestratorStateSnapshot): Promise<void> {
    return writeStateSnapshotFile(this.stateSnapshotPath(), snapshot);
  }
}
