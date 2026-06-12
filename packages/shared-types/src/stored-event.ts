import type { JsonObject } from "./primitive-types";

export const STORED_EVENT_PROTOCOL_VERSION = 1;

export type StoredEventType =
  | "session-created"
  | "conversation-rewind-audit"
  | "session-leaf-moved"
  | "pending-input-created"
  | "pending-input-cancelled"
  | "pending-input-dispatched"
  | "run-queued"
  | "run-started"
  | "goal-round-started"
  | "goal-round-completed"
  | "goal-continuation-decided"
  | "runtime-event"
  | "run-cancel-requested"
  | "run-cancelled"
  | "run-completed"
  | "run-failed";

export interface StoredEvent<TPayload extends JsonObject = JsonObject> {
  protocolVersion: typeof STORED_EVENT_PROTOCOL_VERSION;
  id: string;
  sequence: number;
  type: StoredEventType;
  sessionId: string;
  runId?: string;
  timestamp: string;
  payload: TPayload;
}

export const STORED_EVENT_LOG_SCHEMA_VERSION = 1;

export interface StoredEventLogMetadata {
  eventLogId: string;
  generation: number;
  schemaVersion: typeof STORED_EVENT_LOG_SCHEMA_VERSION;
  protocolVersion: typeof STORED_EVENT_PROTOCOL_VERSION;
}

export interface StoredEventReadOptions {
  maxEvents?: number;
}

export interface EventStore {
  append(event: StoredEvent): Promise<void> | void;
  getMetadata?(): Promise<StoredEventLogMetadata> | StoredEventLogMetadata;
  listSessionSummaries?(): Promise<OrchestratorSessionEventSummary[]> | OrchestratorSessionEventSummary[];
  readAll?(afterSequence?: number, options?: StoredEventReadOptions): Promise<StoredEvent[]> | StoredEvent[];
  readSession(sessionId: string, afterSequence?: number, options?: StoredEventReadOptions): Promise<StoredEvent[]> | StoredEvent[];
  readRun?(runId: string, afterSequence?: number, options?: StoredEventReadOptions): Promise<StoredEvent[]> | StoredEvent[];
}

export interface OrchestratorSessionEventSummary {
  sessionId: string;
  lastUpdated: string;
  eventCount: number;
  runCount: number;
  activeRunCount?: number;
  activeRunIds?: string[];
  latestRunId?: string;
  latestRunStatus?: string;
  latestRunUpdatedAt?: string;
  pendingInputCount?: number;
  pendingApprovalCount?: number;
  lastEventId?: string;
  lastSequence?: number;
  lastMessagePreview?: string;
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  metadataUpdatedAt?: string;
  title?: string;
}
