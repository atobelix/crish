import type {
  AgentOrchestrator,
  OrchestratorEvent,
  OrchestratorEventLogMetadata,
  OrchestratorSessionEventSummary,
  OrchestratorSessionRecord,
} from "@crish/agent-orchestrator";
import { toJsonObject } from "@crish/shared-utils";
import type { JsonObject, RunStatus } from "@crish/shared-types";
import type {
  DaemonEventCursorDiagnostic,
  DaemonEventReadDiagnostics,
  DaemonEventReadMode,
  DaemonEventReplayCursor,
  DaemonOutboundMessage,
  DaemonSessionSummary,
  GetRunSnapshotMessage,
  ListSessionsMessage,
  ListRunsMessage,
  ReadRunEventsMessage,
  ReadSessionEventsMessage,
} from "./types.js";
import { buildDaemonTaskSnapshot, type BuildDaemonTaskSnapshotInput } from "./task-snapshot-projection.js";
import type { FileSessionMetadataStore, SessionMetadataRecord } from "./session-metadata-store.js";

const DEFAULT_EVENT_PAGE_SIZE = 500;

export type QueryHandlerResult =
  | { ok: true; message: DaemonOutboundMessage }
  | { ok: false; code: string; message: string; runId?: string };

export async function createListSessionsResponse(
  orchestrator: AgentOrchestrator,
  input: { metadataStore?: FileSessionMetadataStore; query?: Pick<ListSessionsMessage, "includeArchived" | "includeDeleted"> } = {}
): Promise<DaemonOutboundMessage> {
  const queryStartedAt = Date.now();
  const metadata = input.metadataStore ? await input.metadataStore.list() : [];
  const rawSessions = orchestrator.listSessions();
  const sessions = mergeSessionMetadata(rawSessions, metadata, input.query);
  const { summaries: eventSummaries, available: summariesAvailable } = await maybeListSessionSummaries(orchestrator);
  const summaries = mergeSessionSummaries(sessions, eventSummaries, metadata);
  const eventLog = await orchestrator.getEventLogMetadata();
  return {
    type: "sessions-listed",
    sessions,
    summaries,
    eventLog,
    diagnostics: {
      queryMs: Date.now() - queryStartedAt,
      sessionCount: sessions.length,
      summaryCount: summaries.length,
      metadataCount: metadata.length,
      filteredOutCount: rawSessions.length - sessions.length,
      summarySource: summariesAvailable ? "event-store" : "unavailable",
    },
  };
}

export function createListRunsResponse(
  orchestrator: AgentOrchestrator,
  msg: ListRunsMessage
): DaemonOutboundMessage {
  return {
    type: "runs-listed",
    runs: orchestrator.listRuns(msg.sessionId),
    ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
  };
}

export async function createReadSessionEventsResponse(
  orchestrator: AgentOrchestrator,
  msg: ReadSessionEventsMessage
): Promise<QueryHandlerResult> {
  const eventLog = await orchestrator.getEventLogMetadata();
  const cursorDiagnostic = resolveCursorDiagnostic(msg.cursor, eventLog);
  const initialCursor = initialReplayCursor(msg, cursorDiagnostic);
  const pageSize = eventPageSize(msg.maxEvents);
  const needsFullCursorResolution = needsFullReplayCursorResolution(msg, cursorDiagnostic);
  const queryStartedAt = Date.now();
  const allEvents = await orchestrator.readSessionEvents(
    msg.sessionId,
    initialCursor.afterSequence,
    needsFullCursorResolution ? undefined : { maxEvents: pageSize + 1 }
  );
  const queryMs = Date.now() - queryStartedAt;
  const cursor = resolveReplayCursor(allEvents, msg, cursorDiagnostic);
  if (!cursor.ok) {
    return { ok: false, code: "INVALID_CURSOR", message: cursor.message };
  }

  const matchingEvents = allEvents.filter((event) => event.sequence > cursor.afterSequence);
  const { events, truncated } = limitEvents(matchingEvents, pageSize);
  const diagnostics = buildEventReadDiagnostics(
    msg,
    initialCursor.afterSequence,
    cursor.afterSequence,
    matchingEvents.length,
    events.length,
    queryMs,
    truncated,
    pageSize,
    cursorDiagnostic
  );
  return {
    ok: true,
    message: {
      type: "session-events",
      sessionId: msg.sessionId,
      events,
      eventLog,
      ...(cursorDiagnostic !== undefined ? { cursorDiagnostic } : {}),
      diagnostics,
      afterSequence: cursor.afterSequence,
      ...(msg.lastEventId !== undefined ? { lastEventId: msg.lastEventId } : {}),
      nextAfterSequence: nextAfterSequence(events, cursor.afterSequence),
      hasMore: truncated,
      ...(truncated ? { nextCursor: nextReplayCursor(eventLog, events, cursor.afterSequence) } : {}),
    } as DaemonOutboundMessage,
  };
}

export async function createReadRunEventsResponse(
  orchestrator: AgentOrchestrator,
  msg: ReadRunEventsMessage
): Promise<QueryHandlerResult> {
  const eventLog = await orchestrator.getEventLogMetadata();
  const cursorDiagnostic = resolveCursorDiagnostic(msg.cursor, eventLog);
  const initialCursor = initialReplayCursor(msg, cursorDiagnostic);
  const pageSize = eventPageSize(msg.maxEvents);
  const needsFullCursorResolution = needsFullReplayCursorResolution(msg, cursorDiagnostic);
  const queryStartedAt = Date.now();
  const allEvents = await orchestrator.readRunEvents(
    msg.runId,
    initialCursor.afterSequence,
    needsFullCursorResolution ? undefined : { maxEvents: pageSize + 1 }
  );
  const queryMs = Date.now() - queryStartedAt;
  const cursor = resolveReplayCursor(allEvents, msg, cursorDiagnostic);
  if (!cursor.ok) {
    return { ok: false, code: "INVALID_CURSOR", message: cursor.message, runId: msg.runId };
  }

  const matchingEvents = allEvents.filter((event) => event.sequence > cursor.afterSequence);
  const { events, truncated } = limitEvents(matchingEvents, pageSize);
  const diagnostics = buildEventReadDiagnostics(
    msg,
    initialCursor.afterSequence,
    cursor.afterSequence,
    matchingEvents.length,
    events.length,
    queryMs,
    truncated,
    pageSize,
    cursorDiagnostic
  );
  return {
    ok: true,
    message: {
      type: "run-events",
      runId: msg.runId,
      events,
      eventLog,
      ...(cursorDiagnostic !== undefined ? { cursorDiagnostic } : {}),
      diagnostics,
      afterSequence: cursor.afterSequence,
      ...(msg.lastEventId !== undefined ? { lastEventId: msg.lastEventId } : {}),
      nextAfterSequence: nextAfterSequence(events, cursor.afterSequence),
      hasMore: truncated,
      ...(truncated ? { nextCursor: nextReplayCursor(eventLog, events, cursor.afterSequence) } : {}),
      ...(msg.includeSnapshot
        ? {
            snapshot: buildDaemonTaskSnapshot({
              run: orchestrator.getRun(msg.runId),
              events: initialCursor.snapshotComplete && needsFullCursorResolution ? allEvents : await orchestrator.readRunEvents(msg.runId),
            } as BuildDaemonTaskSnapshotInput),
          }
        : {}),
    } as DaemonOutboundMessage,
  };
}

export async function createGetRunSnapshotResponse(
  orchestrator: AgentOrchestrator,
  msg: GetRunSnapshotMessage
): Promise<QueryHandlerResult> {
  const allEvents = await orchestrator.readRunEvents(msg.runId);
  const run = orchestrator.getRun(msg.runId);
  if (!run && allEvents.length === 0) {
    return {
      ok: false,
      code: "RUN_NOT_FOUND",
      message: `Run not found: ${msg.runId}`,
      runId: msg.runId,
    };
  }

  return {
    ok: true,
    message: {
      type: "run-snapshot",
      runId: msg.runId,
      snapshot: buildDaemonTaskSnapshot({ run, events: allEvents } as BuildDaemonTaskSnapshotInput),
    } as DaemonOutboundMessage,
  };
}

function initialReplayCursor(
  cursor: { afterSequence?: number; lastEventId?: string; cursor?: DaemonEventReplayCursor },
  cursorDiagnostic?: DaemonEventCursorDiagnostic
): { afterSequence: number; snapshotComplete: boolean } {
  if (cursorDiagnostic || cursor.lastEventId) {
    return { afterSequence: 0, snapshotComplete: true };
  }
  const afterSequence = cursor.cursor?.afterSequence ?? cursor.afterSequence ?? 0;
  return { afterSequence, snapshotComplete: afterSequence === 0 };
}

function needsFullReplayCursorResolution(
  cursor: { lastEventId?: string },
  cursorDiagnostic?: DaemonEventCursorDiagnostic
): boolean {
  return Boolean(cursorDiagnostic || cursor.lastEventId);
}

function resolveReplayCursor(
  events: OrchestratorEvent[],
  cursor: { afterSequence?: number; lastEventId?: string; cursor?: DaemonEventReplayCursor },
  cursorDiagnostic?: DaemonEventCursorDiagnostic
): ReplayCursorResolution {
  if (cursorDiagnostic) {
    return { ok: true, afterSequence: 0 };
  }

  let afterSequence = cursor.cursor?.afterSequence ?? cursor.afterSequence ?? 0;
  const lastEventId = cursor.lastEventId;

  if (lastEventId) {
    const event = events.find((candidate) => candidate.id === lastEventId);
    if (!event) {
      return {
        ok: false,
        message: `Replay cursor event not found: ${lastEventId}`,
      };
    }
    afterSequence = Math.max(afterSequence, event.sequence);
  }

  return { ok: true, afterSequence };
}

function resolveCursorDiagnostic(
  cursor: DaemonEventReplayCursor | undefined,
  current: OrchestratorEventLogMetadata
): DaemonEventCursorDiagnostic | undefined {
  if (!cursor) return undefined;
  if (
    cursor.eventLogId === current.eventLogId &&
    cursor.generation === current.generation &&
    cursor.schemaVersion === current.schemaVersion &&
    cursor.protocolVersion === current.protocolVersion
  ) {
    return undefined;
  }

  return {
    code: "EVENT_LOG_CURSOR_MISMATCH",
    message: "Replay cursor belongs to a different event log identity, generation, or schema version; replaying from the beginning.",
    severity: "warning",
    previous: cursor,
    current,
    replayedFromSequence: 0,
  };
}

function buildEventReadDiagnostics(
  cursor: { afterSequence?: number; lastEventId?: string; maxEvents?: number; cursor?: DaemonEventReplayCursor },
  storeReadAfterSequence: number,
  projectedAfterSequence: number,
  eventsFetched: number,
  eventsReturned: number,
  queryMs: number,
  truncated: boolean,
  pageSize: number,
  cursorDiagnostic?: DaemonEventCursorDiagnostic
): DaemonEventReadDiagnostics {
  return {
    mode: eventReadMode(cursor, cursorDiagnostic),
    requestedAfterSequence: cursor.cursor?.afterSequence ?? cursor.afterSequence ?? 0,
    storeReadAfterSequence,
    projectedAfterSequence,
    eventsFetched,
    eventsReturned,
    truncated: truncated || undefined,
    maxEvents: cursor.maxEvents ?? pageSize,
    queryMs,
  } as DaemonEventReadDiagnostics;
}

function eventReadMode(
  cursor: { lastEventId?: string; cursor?: DaemonEventReplayCursor },
  cursorDiagnostic?: DaemonEventCursorDiagnostic
): DaemonEventReadMode {
  if (cursorDiagnostic) return "full-replay";
  if (cursor.lastEventId) return "cursor-replay";
  return "incremental";
}

function nextAfterSequence(events: OrchestratorEvent[], fallback: number): number {
  return events.reduce((sequence, event) => Math.max(sequence, event.sequence), fallback);
}

function nextReplayCursor(
  eventLog: OrchestratorEventLogMetadata,
  events: OrchestratorEvent[],
  fallback: number
): DaemonEventReplayCursor | undefined {
  const afterSequence = nextAfterSequence(events, fallback);
  return {
    eventLogId: eventLog.eventLogId,
    generation: eventLog.generation,
    schemaVersion: eventLog.schemaVersion,
    protocolVersion: eventLog.protocolVersion,
    afterSequence,
    lastEventId: events.at(-1)?.id,
  };
}

function eventPageSize(maxEvents: number | undefined): number {
  return maxEvents ?? DEFAULT_EVENT_PAGE_SIZE;
}

function limitEvents(events: OrchestratorEvent[], limit: number): { events: OrchestratorEvent[]; truncated: boolean } {
  if (events.length <= limit) {
    return { events, truncated: false };
  }
  return { events: events.slice(0, limit), truncated: true };
}

async function maybeListSessionSummaries(
  orchestrator: AgentOrchestrator
): Promise<{ summaries: OrchestratorSessionEventSummary[]; available: boolean }> {
  const maybeSummaries = (
    orchestrator as { listSessionSummaries?: () => OrchestratorSessionEventSummary[] | Promise<OrchestratorSessionEventSummary[]> }
  ).listSessionSummaries;
  if (!maybeSummaries) return { summaries: [], available: false };
  const summaries = await maybeSummaries.call(orchestrator);
  return { summaries: Array.isArray(summaries) ? summaries : [], available: true };
}

function mergeSessionSummaries(
  sessions: ReturnType<AgentOrchestrator["listSessions"]>,
  eventSummaries: OrchestratorSessionEventSummary[],
  metadataRecords: SessionMetadataRecord[] = []
): DaemonSessionSummary[] {
  const bySessionId = new Map(eventSummaries.map((summary) => [summary.sessionId, summary]));
  const metadataBySessionId = new Map(metadataRecords.map((record) => [record.sessionId, record]));
  return sessions.map((session) => {
    const eventSummary = bySessionId.get(session.id);
    const metadata = metadataBySessionId.get(session.id);
    return {
      sessionId: session.id,
      lastUpdated: latestIso(eventSummary?.lastUpdated, session.updatedAt, metadata?.updatedAt),
      eventCount: eventSummary?.eventCount ?? 0,
      runCount: eventSummary?.runCount ?? 0,
      ...(eventSummary?.activeRunCount !== undefined ? { activeRunCount: eventSummary.activeRunCount } : {}),
      ...(eventSummary?.activeRunIds !== undefined ? { activeRunIds: eventSummary.activeRunIds } : {}),
      ...(eventSummary?.latestRunId !== undefined ? { latestRunId: eventSummary.latestRunId } : {}),
      ...(eventSummary?.latestRunStatus !== undefined ? { latestRunStatus: eventSummary.latestRunStatus as RunStatus } : {}),
      ...(eventSummary?.latestRunUpdatedAt !== undefined ? { latestRunUpdatedAt: eventSummary.latestRunUpdatedAt } : {}),
      ...(eventSummary?.pendingInputCount !== undefined ? { pendingInputCount: eventSummary.pendingInputCount } : {}),
      ...(eventSummary?.pendingApprovalCount !== undefined ? { pendingApprovalCount: eventSummary.pendingApprovalCount } : {}),
      ...(eventSummary?.lastEventId ? { lastEventId: eventSummary.lastEventId } : {}),
      ...(eventSummary?.lastSequence !== undefined ? { lastSequence: eventSummary.lastSequence } : {}),
      ...(eventSummary?.lastMessagePreview ? { lastMessagePreview: eventSummary.lastMessagePreview } : {}),
      ...(metadata?.title !== undefined ? { title: metadata.title } : {}),
      ...(metadata ? { pinned: metadata.pinned, archived: metadata.archived, deleted: metadata.deleted, metadataUpdatedAt: metadata.updatedAt } : {}),
    } as DaemonSessionSummary;
  });
}

function mergeSessionMetadata(
  sessions: OrchestratorSessionRecord[],
  metadataRecords: SessionMetadataRecord[],
  query: Pick<ListSessionsMessage, "includeArchived" | "includeDeleted"> = {}
): OrchestratorSessionRecord[] {
  const metadataBySessionId = new Map(metadataRecords.map((record) => [record.sessionId, record]));
  return sessions
    .map((session) => applySessionMetadata(session, metadataBySessionId.get(session.id)))
    .filter((session) => {
      const metadata = metadataBySessionId.get(session.id);
      if (!query.includeDeleted && metadata?.deleted) return false;
      if (!query.includeArchived && metadata?.archived) return false;
      return true;
    })
    .sort((left, right) => compareSessions(left, right, metadataBySessionId));
}

function applySessionMetadata(
  session: OrchestratorSessionRecord,
  metadata: SessionMetadataRecord | undefined
): OrchestratorSessionRecord {
  if (!metadata) return session;
  const sessionMetadata: JsonObject = {
    ...(session.metadata ?? {}),
    sessionMetadata: toJsonObject({
      title: metadata.title,
      pinned: metadata.pinned,
      archived: metadata.archived,
      deleted: metadata.deleted,
      updatedAt: metadata.updatedAt,
      source: metadata.source,
    }),
  };
  return {
    ...session,
    updatedAt: latestIso(session.updatedAt, metadata.updatedAt),
    status: metadata.archived ? "archived" : session.status,
    metadata: sessionMetadata,
  };
}

function compareSessions(
  left: OrchestratorSessionRecord,
  right: OrchestratorSessionRecord,
  metadataBySessionId: Map<string, SessionMetadataRecord>
): number {
  const leftPinned = metadataBySessionId.get(left.id)?.pinned === true;
  const rightPinned = metadataBySessionId.get(right.id)?.pinned === true;
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function latestIso(...values: Array<string | undefined>): string {
  return values.filter((value): value is string => value !== undefined).sort().at(-1) ?? new Date(0).toISOString();
}

type ReplayCursorResolution =
  | { ok: true; afterSequence: number }
  | { ok: false; message: string };
