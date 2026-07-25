import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AsyncMutex, isRecord, LruMap, MAX_ORCHESTRATOR_EVENTS, MAX_ORCHESTRATOR_SESSIONS, retryWithBackoff } from "@crish/shared-utils";
import type { OrchestratorEvent, OrchestratorEventLogMetadata } from "../types";
import {
  updateSessionSummary,
  type MutableSessionEventSummary
} from "../session-summary";
import {
  ORCHESTRATOR_PROTOCOL_VERSION,
  ORCHESTRATOR_SESSION_SUMMARY_INDEX_VERSION,
  appendIndexedEvent,
  isSessionSummaryIndex,
  parseJsonLine,
  type ByteOffsetIndexEntry,
  type ByteOffsetIndexFile,
  type ByteOffsetRange,
  type FileOrchestratorSessionSummaryIndex,
  type SessionIndexEntry
} from "./event-types";

export class EventIndexer {
  byteOffsetIndex = new Map<string, ByteOffsetRange[]>();
  byteIndexLoaded = false;
  sessionIndex = new LruMap<string, SessionIndexEntry>(MAX_ORCHESTRATOR_SESSIONS);
  sessionIndexComplete = false;
  cachedSessionSummaries = new Map<string, MutableSessionEventSummary>();
  sessionSummaryCacheReady = false;
  indexDirty = false;
  lastIndexFlushTime = 0;
  indexWriteFailureCount = 0;
  lastIndexWriteError: Error | undefined;
  readonly flushMutex = new AsyncMutex();

  healthCheck(acceptingAppends: boolean, latchedFailure: unknown): {
    writable: boolean;
    indexSynced: boolean;
    indexDirty: boolean;
    indexWriteFailureCount: number;
    lastIndexWriteError: string | undefined;
  } {
    return {
      writable: acceptingAppends && !latchedFailure,
      indexSynced: this.indexWriteFailureCount === 0,
      indexDirty: this.indexDirty,
      indexWriteFailureCount: this.indexWriteFailureCount,
      lastIndexWriteError: this.lastIndexWriteError?.message
    };
  }

  async tryLoadSessionSummaryIndex(
    sessionSummaryIndexPath: string,
    metadata: OrchestratorEventLogMetadata,
    peekMaxSequence: () => Promise<number>
  ): Promise<boolean> {
    if (this.sessionSummaryCacheReady) return true;

    const raw = await readFile(sessionSummaryIndexPath, "utf8").catch(() => null);
    if (!raw?.trim()) return false;

    const parsed = parseJsonLine(raw);
    if (!isSessionSummaryIndex(parsed, metadata)) return false;

    const indexMaxSequence = parsed.summaries.reduce(
      (max, summary) => Math.max(max, summary.lastSequence ?? 0),
      0
    );
    const logMaxSequence = await peekMaxSequence();
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

  async writeSessionSummaryIndex(
    sessionSummaryIndexPath: string,
    metadata: OrchestratorEventLogMetadata
  ): Promise<void> {
    if (!this.sessionSummaryCacheReady) return;
    const index: FileOrchestratorSessionSummaryIndex = {
      type: "orchestrator-session-summary-index",
      version: ORCHESTRATOR_SESSION_SUMMARY_INDEX_VERSION,
      protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
      eventLogId: metadata.eventLogId,
      generation: metadata.generation,
      schemaVersion: metadata.schemaVersion,
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
    await retryWithBackoff(
      async () => {
        await mkdir(dirname(sessionSummaryIndexPath), { recursive: true });
        const tempPath = `${sessionSummaryIndexPath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tempPath, `${JSON.stringify(index)}\n`, "utf8");
        await rename(tempPath, sessionSummaryIndexPath);
      },
      { maxAttempts: 3, baseMs: 200, maxMs: 1500 }
    );
  }

  async tryLoadByteOffsetIndex(
    byteIndexPath: string,
    metadata: OrchestratorEventLogMetadata
  ): Promise<boolean> {
    if (this.byteIndexLoaded) return true;

    const raw = await readFile(byteIndexPath, "utf8").catch(() => null);
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
      if (
        parsed.eventLogId !== metadata.eventLogId ||
        parsed.generation !== metadata.generation
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

  async writeByteOffsetIndex(
    byteIndexPath: string,
    metadata: OrchestratorEventLogMetadata
  ): Promise<void> {
    if (!this.byteIndexLoaded) return;

    const entries: ByteOffsetIndexEntry[] = [];
    for (const [sessionId, ranges] of this.byteOffsetIndex) {
      entries.push({ sessionId, ranges });
    }

    const file: ByteOffsetIndexFile = {
      type: "orchestrator-byte-offset-index",
      version: 1,
      eventLogId: metadata.eventLogId,
      generation: metadata.generation,
      entries,
    };

    await retryWithBackoff(
      async () => {
        await mkdir(dirname(byteIndexPath), { recursive: true });
        const tempPath = `${byteIndexPath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tempPath, `${JSON.stringify(file)}\n`, "utf8");
        await rename(tempPath, byteIndexPath);
      },
      { maxAttempts: 3, baseMs: 200, maxMs: 1500 }
    );
  }

  trackByteOffset(sessionId: string, byteOffset: number, byteLength: number): void {
    let ranges = this.byteOffsetIndex.get(sessionId);
    if (!ranges) {
      ranges = [];
      this.byteOffsetIndex.set(sessionId, ranges);
    }
    ranges.push({ byteOffset, byteLength });
    if (!this.byteIndexLoaded) {
      this.byteIndexLoaded = true;
    }
  }

  updateSessionIndex(event: OrchestratorEvent, byteOffset?: number, byteLength?: number): void {
    let entry = this.sessionIndex.get(event.sessionId);
    if (entry) {
      entry.eventCount++;
      if (byteOffset !== undefined) {
        if (entry.firstOffset === 0 && entry.lastOffset === 0) {
          entry.firstOffset = byteOffset;
        }
        entry.lastOffset = byteOffset;
      }
      entry.lastUpdated = Date.now();
      updateSessionSummary(new Map([[event.sessionId, entry.summary]]), event);
      this.sessionIndex.set(event.sessionId, entry);
    } else {
      const summary: MutableSessionEventSummary = {
        sessionId: event.sessionId,
        lastUpdated: event.timestamp,
        eventCount: 0,
        runIds: new Set(),
        runStates: new Map(),
        pendingInputIds: new Set(),
        pendingInputEventCount: 0,
      };
      updateSessionSummary(new Map([[event.sessionId, summary]]), event);
      this.sessionIndex.set(event.sessionId, {
        firstOffset: byteOffset ?? 0,
        lastOffset: byteOffset ?? 0,
        eventCount: 1,
        lastUpdated: Date.now(),
        summary,
      });
    }
  }

  evictCachedEventsIfNeeded(
    cachedEvents: OrchestratorEvent[] | undefined,
    maxCachedEvents: number | undefined,
    cachedEventsBySession: Map<string, Set<OrchestratorEvent>>,
    cachedEventsByRun: Map<string, Set<OrchestratorEvent>>
  ): void {
    const maxCached = maxCachedEvents ?? MAX_ORCHESTRATOR_EVENTS;
    if (maxCached <= 0 || !cachedEvents) return;
    if (cachedEvents.length <= maxCached) return;

    const evicted = cachedEvents.splice(0, cachedEvents.length - maxCached);
    for (const event of evicted) {
      const sessionSet = cachedEventsBySession.get(event.sessionId);
      if (sessionSet) {
        sessionSet.delete(event);
        if (sessionSet.size === 0) cachedEventsBySession.delete(event.sessionId);
      }
      if (event.runId) {
        const runSet = cachedEventsByRun.get(event.runId);
        if (runSet) {
          runSet.delete(event);
          if (runSet.size === 0) cachedEventsByRun.delete(event.runId);
        }
      }
    }
  }

  indexCachedEvent(
    event: OrchestratorEvent,
    cachedEventsBySession: Map<string, Set<OrchestratorEvent>>,
    cachedEventsByRun: Map<string, Set<OrchestratorEvent>>
  ): void {
    appendIndexedEvent(cachedEventsBySession, event.sessionId, event);
    if (event.runId) appendIndexedEvent(cachedEventsByRun, event.runId, event);
    updateSessionSummary(this.cachedSessionSummaries, event);
  }

  replaceEventCache(
    events: OrchestratorEvent[],
    setCachedEvents: (events: OrchestratorEvent[]) => void,
    cachedEventsBySession: Map<string, Set<OrchestratorEvent>>,
    cachedEventsByRun: Map<string, Set<OrchestratorEvent>>,
    setKnownEventIds: (ids: Set<string>) => void
  ): void {
    setCachedEvents(events);
    cachedEventsBySession.clear();
    cachedEventsByRun.clear();
    this.cachedSessionSummaries.clear();
    const knownIds = new Set<string>();
    this.sessionIndex = new LruMap<string, SessionIndexEntry>(MAX_ORCHESTRATOR_SESSIONS);

    for (const event of events) {
      knownIds.add(event.id);
      this.indexCachedEvent(event, cachedEventsBySession, cachedEventsByRun);
    }
    setKnownEventIds(knownIds);

    for (const [sessionId, summary] of this.cachedSessionSummaries) {
      this.sessionIndex.set(sessionId, {
        firstOffset: 0,
        lastOffset: 0,
        eventCount: summary.eventCount,
        lastUpdated: Date.now(),
        summary,
      });
    }
    this.sessionIndexComplete = true;
    this.sessionSummaryCacheReady = true;
  }

  shouldFlushIndexNow(indexFlushIntervalMs: number): boolean {
    if (!this.indexDirty) return false;
    if (indexFlushIntervalMs === 0) return true;
    if (indexFlushIntervalMs === Infinity) return false;
    return Date.now() - this.lastIndexFlushTime >= indexFlushIntervalMs;
  }

  async flushIndex(
    sessionSummaryIndexPath: string,
    byteIndexPath: string,
    metadata: OrchestratorEventLogMetadata | undefined
  ): Promise<boolean> {
    return this.flushMutex.runExclusive(() =>
      this.flushIndexInner(sessionSummaryIndexPath, byteIndexPath, metadata)
    );
  }

  private async flushIndexInner(
    sessionSummaryIndexPath: string,
    byteIndexPath: string,
    metadata: OrchestratorEventLogMetadata | undefined
  ): Promise<boolean> {
    if (!this.indexDirty) return false;

    const needsSummaryIndexWrite = this.sessionSummaryCacheReady && metadata !== undefined;
    const needsByteIndexWrite = this.byteIndexLoaded && metadata !== undefined;
    if (!needsSummaryIndexWrite && !needsByteIndexWrite) {
      return false;
    }

    let summaryIndexSynced = !needsSummaryIndexWrite;
    let byteIndexSynced = !needsByteIndexWrite;
    let anyWritten = false;

    if (needsSummaryIndexWrite && metadata) {
      await this.writeSessionSummaryIndex(sessionSummaryIndexPath, metadata)
        .then(() => {
          summaryIndexSynced = true;
          anyWritten = true;
        })
        .catch((cause) => {
          this.indexWriteFailureCount++;
          this.lastIndexWriteError = cause instanceof Error ? cause : new Error(String(cause));
        });
    }

    if (needsByteIndexWrite && metadata) {
      await this.writeByteOffsetIndex(byteIndexPath, metadata)
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
}
