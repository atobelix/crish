import { createHash, randomUUID } from "node:crypto";
import { isRecord } from "@crish/shared-utils";
export {
  ORCHESTRATOR_EVENT_LOG_SCHEMA_VERSION,
  ORCHESTRATOR_PROTOCOL_VERSION,
} from "../types";
import {
  ORCHESTRATOR_EVENT_LOG_SCHEMA_VERSION,
  ORCHESTRATOR_PROTOCOL_VERSION,
  type OrchestratorEvent,
  type OrchestratorEventLogMetadata,
  type OrchestratorEventReadOptions,
  type OrchestratorEventType
} from "../types";
import type { MutableSessionEventSummary, OrchestratorRunSummaryState } from "../session-summary";

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
  header: FileOrchestratorEventStoreHeader | undefined;
  sessionSummaryIndexPath: string | undefined;
  /**
   * 内存中缓存的最大事件数量
   *
   * 超过此限制后，最早的缓存事件将被释放。
   * 默认 10000。设置为 0 表示不缓存。
   */
  maxCachedEvents: number | undefined;
  /**
   * 索引刷盘间隔（毫秒）。
   *
   * append() 只更新内存索引，当距离上次刷盘超过此间隔时才写磁盘。
   * 设为 0 表示每次 append 都刷盘，设为 Infinity 表示只手动刷盘。
   * 默认 5000ms。
   */
  indexFlushIntervalMs: number | undefined;
  /** JSONL 文件轮转最大字节数（默认 100MB）。达到此大小后自动创建新文件。 */
  maxSizeBytes: number | undefined;
  /** 保留的归档文件最大数量（默认 10）。超过此数量的旧归档会被删除。 */
  maxArchives: number | undefined;
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

export interface SessionIndexEntry {
  firstOffset: number;
  lastOffset: number;
  eventCount: number;
  lastUpdated: number;
  summary: MutableSessionEventSummary;
}

export type OrchestratorEventStoreFailureKind =
  | "closed"
  | "write-failed"
  | "index-write-failed"
  | "invalid-event"
  | "duplicate-event-id"
  | "invalid-read";

/** Store-level failures that latch the writer closed for subsequent appends. */
export const LATCHING_FAILURE_KINDS = new Set<OrchestratorEventStoreFailureKind>(["write-failed"]);

export class OrchestratorEventStoreError extends Error {
  readonly kind: OrchestratorEventStoreFailureKind;
  readonly filePath: string;
  readonly eventId: string | undefined;

  constructor(
    message: string,
    options: {
      kind: OrchestratorEventStoreFailureKind;
      filePath: string;
      eventId: string | undefined;
      cause: unknown | undefined;
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
  constructor(filePath: string, eventId: string | undefined) {
    super(`Orchestrator event store is closed: ${filePath}`, {
      kind: "closed",
      filePath,
      eventId,
      cause: undefined
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
      eventId: undefined,
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
      eventId,
      cause: undefined
    });
    this.name = "OrchestratorEventStoreInvalidEventError";
  }
}

export class OrchestratorEventStoreDuplicateIdError extends OrchestratorEventStoreError {
  constructor(filePath: string, eventId: string) {
    super(`Duplicate orchestrator event id ${eventId} in ${filePath}`, {
      kind: "duplicate-event-id",
      filePath,
      eventId,
      cause: undefined
    });
    this.name = "OrchestratorEventStoreDuplicateIdError";
  }
}

export class OrchestratorEventStoreInvalidReadError extends OrchestratorEventStoreError {
  constructor(filePath: string, reason: string) {
    super(`Invalid orchestrator event store read: ${reason}`, {
      kind: "invalid-read",
      filePath,
      eventId: undefined,
      cause: undefined
    });
    this.name = "OrchestratorEventStoreInvalidReadError";
  }
}

export const DEFAULT_HEADER: FileOrchestratorEventStoreHeader = {
  type: "orchestrator-event-store",
  version: ORCHESTRATOR_EVENT_STORE_FILE_VERSION,
  protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
  eventLogId: "",
  generation: 1,
  schemaVersion: ORCHESTRATOR_EVENT_LOG_SCHEMA_VERSION
};

export const EVENT_TYPES = new Set<OrchestratorEventType>([
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

export function parseHeader(line: string, filePath: string): FileOrchestratorEventStoreHeader {
  const parsed = parseJsonLine(line);
  if (!isRecord(parsed) || parsed.type !== "orchestrator-event-store") {
    throw new OrchestratorEventStoreInvalidReadError(filePath, `Invalid orchestrator event store header in ${filePath}`);
  }
  if (parsed.version !== ORCHESTRATOR_EVENT_STORE_FILE_VERSION) {
    throw new OrchestratorEventStoreInvalidReadError(filePath, `Unsupported orchestrator event store version ${String(parsed.version)} in ${filePath}`);
  }
  if (parsed.protocolVersion !== ORCHESTRATOR_PROTOCOL_VERSION) {
    throw new OrchestratorEventStoreInvalidReadError(filePath, `Unsupported orchestrator protocol version ${String(parsed.protocolVersion)} in ${filePath}`);
  }
  return normalizeHeader(parsed, filePath);
}

export function normalizeHeader(value: unknown, filePath: string): FileOrchestratorEventStoreHeader {
  if (!isRecord(value) || value.type !== "orchestrator-event-store") {
    throw new OrchestratorEventStoreInvalidReadError(filePath, `Invalid orchestrator event store header in ${filePath}`);
  }
  if (value.version !== ORCHESTRATOR_EVENT_STORE_FILE_VERSION) {
    throw new OrchestratorEventStoreInvalidReadError(filePath, `Unsupported orchestrator event store version ${String(value.version)} in ${filePath}`);
  }
  if (value.protocolVersion !== ORCHESTRATOR_PROTOCOL_VERSION) {
    throw new OrchestratorEventStoreInvalidReadError(filePath, `Unsupported orchestrator protocol version ${String(value.protocolVersion)} in ${filePath}`);
  }
  const schemaVersion =
    typeof value.schemaVersion === "number" && Number.isInteger(value.schemaVersion) && value.schemaVersion > 0
      ? value.schemaVersion
      : ORCHESTRATOR_EVENT_LOG_SCHEMA_VERSION;
  if (schemaVersion !== ORCHESTRATOR_EVENT_LOG_SCHEMA_VERSION) {
    throw new OrchestratorEventStoreInvalidReadError(filePath, `Unsupported orchestrator event log schema version ${String(schemaVersion)} in ${filePath}`);
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

export function metadataFromHeader(header: FileOrchestratorEventStoreHeader): OrchestratorEventLogMetadata {
  return {
    eventLogId: header.eventLogId,
    generation: header.generation,
    schemaVersion: header.schemaVersion,
    protocolVersion: header.protocolVersion
  };
}

export function isSessionSummaryIndex(
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

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

export function isRunSummaryStateArray(value: unknown): value is OrchestratorRunSummaryState[] {
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

export function deterministicEventLogId(filePath: string): string {
  return `eventlog_${createHash("sha256").update(filePath).digest("hex").slice(0, 24)}`;
}

export function createOrchestratorEventStoreHeader(
  input: { eventLogId: string | undefined; generation: number | undefined } = { eventLogId: undefined, generation: undefined }
): FileOrchestratorEventStoreHeader {
  return {
    ...DEFAULT_HEADER,
    eventLogId: input.eventLogId && input.eventLogId.length > 0 ? input.eventLogId : `eventlog_${randomUUID()}`,
    generation: input.generation && input.generation > 0 ? input.generation : 1
  };
}

export function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    // silent: JSON.parse 降级，损坏行返回 null 由调用方处理
    return null;
  }
}

export function isOrchestratorEvent(value: unknown): value is OrchestratorEvent {
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

export function appendIndexedEvent(
  index: Map<string, Set<OrchestratorEvent>>,
  key: string,
  event: OrchestratorEvent
): void {
  let events = index.get(key);
  if (!events) {
    events = new Set();
    index.set(key, events);
  }
  events.add(event);
}

export function sortedBySequence(set: Set<OrchestratorEvent> | undefined): OrchestratorEvent[] {
  if (!set || set.size === 0) return [];
  const events = [...set];
  events.sort((left, right) => left.sequence - right.sequence);
  return events;
}

export function collectAfterSequence(events: OrchestratorEvent[], afterSequence: number, maxEvents?: number): OrchestratorEvent[] {
  if (maxEvents === 0) return [];
  const collected: OrchestratorEvent[] = [];
  for (const event of events) {
    if (event.sequence <= afterSequence) continue;
    collected.push(event);
    if (maxEvents !== undefined && collected.length >= maxEvents) break;
  }
  return collected;
}

export function normalizeEventStoreFailure(cause: unknown, filePath: string): OrchestratorEventStoreError {
  if (cause instanceof OrchestratorEventStoreError) {
    return cause;
  }
  return new OrchestratorEventStoreWriteError(filePath, undefined, cause);
}

export function assertAppendableEvent(event: OrchestratorEvent, filePath: string): void {
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

export function assertNonEmptyId(value: string, label: "sessionId" | "runId", filePath: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OrchestratorEventStoreInvalidReadError(filePath, `${label} must be a non-empty string`);
  }
}

export function normalizeReadOptions(
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
