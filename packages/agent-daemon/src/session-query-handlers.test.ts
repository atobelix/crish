import { describe, expect, it } from "vitest";
import type { AgentOrchestrator, OrchestratorEvent, OrchestratorRunRecord } from "@crish/agent-orchestrator";
import type { JsonObject } from "@crish/shared-types";
import {
  createGetRunSnapshotResponse,
  createListRunsResponse,
  createListSessionsResponse,
  createReadSessionEventsResponse,
  createReadRunEventsResponse,
} from "./session-query-handlers";
import type { FileSessionMetadataStore, SessionMetadataRecord } from "./session-metadata-store";

describe("session query snapshot responses", () => {
  it("returns a daemon-owned run snapshot", async () => {
    const orchestrator = fakeOrchestrator([runQueued("event-1")], runRecord());

    const result = await createGetRunSnapshotResponse(orchestrator, {
      type: "get-run-snapshot",
      runId: "run-1",
    });

    expect(result).toMatchObject({
      ok: true,
      message: {
        type: "run-snapshot",
        runId: "run-1",
        snapshot: {
          runId: "run-1",
          sessionId: "session-1",
          title: "Snapshot query",
        },
      },
    });
  });

  it("can attach a snapshot to read-run-events", async () => {
    const events = [runQueued("event-1")];
    const orchestrator = fakeOrchestrator(events, runRecord());

    const result = await createReadRunEventsResponse(orchestrator, {
      type: "read-run-events",
      runId: "run-1",
      afterSequence: 0,
      includeSnapshot: true,
    });

    expect(result).toMatchObject({
      ok: true,
      message: {
        type: "run-events",
        events,
        eventLog: eventLogMetadata(),
        snapshot: {
          runId: "run-1",
          currentRun: {
            metadata: { prompt: "Snapshot query" },
          },
        },
      },
    });
  });

  it("returns event log metadata and rewinds stale replay cursors", async () => {
    const events = [runQueued("event-1")];
    const orchestrator = fakeOrchestrator(events, runRecord());

    const result = await createReadRunEventsResponse(orchestrator, {
      type: "read-run-events",
      runId: "run-1",
      afterSequence: 10,
      cursor: {
        eventLogId: "eventlog_old",
        generation: 1,
        schemaVersion: 1,
        protocolVersion: 1,
        afterSequence: 10,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      message: {
        type: "run-events",
        runId: "run-1",
        events,
        eventLog: eventLogMetadata(),
        afterSequence: 0,
        nextAfterSequence: 1,
        cursorDiagnostic: {
          code: "EVENT_LOG_CURSOR_MISMATCH",
          current: eventLogMetadata(),
          replayedFromSequence: 0,
        },
      },
    });
  });

  it("uses the replay cursor as the event store read boundary when no full replay is needed", async () => {
    const probes: FakeOrchestratorProbes = { runAfterSequences: [], sessionAfterSequences: [] };
    const events = [runQueued("event-1"), runQueued("event-2", 2)];
    const orchestrator = fakeOrchestrator(events, runRecord(), probes);

    const runResult = await createReadRunEventsResponse(orchestrator, {
      type: "read-run-events",
      runId: "run-1",
      afterSequence: 1,
    });
    const sessionResult = await createReadSessionEventsResponse(orchestrator, {
      type: "read-session-events",
      sessionId: "session-1",
      cursor: {
        ...eventLogMetadata(),
        afterSequence: 1,
        lastEventId: "event-1",
      },
    });

    expect(probes.runAfterSequences).toEqual([1]);
    expect(probes.sessionAfterSequences).toEqual([1]);
    expect(runResult).toMatchObject({
      ok: true,
      message: {
        type: "run-events",
        afterSequence: 1,
        events: [{ id: "event-2" }],
      },
    });
    expect(sessionResult).toMatchObject({
      ok: true,
      message: {
        type: "session-events",
        afterSequence: 1,
        events: [{ id: "event-2" }],
      },
    });
  });

  it("reports read diagnostics for incremental and cursor replay reads", async () => {
    const probes: FakeOrchestratorProbes = { runAfterSequences: [], sessionAfterSequences: [] };
    const events = [runQueued("event-1"), runQueued("event-2", 2), runQueued("event-3", 3)];
    const orchestrator = fakeOrchestrator(events, runRecord(), probes);

    const incremental = await createReadRunEventsResponse(orchestrator, {
      type: "read-run-events",
      runId: "run-1",
      cursor: {
        ...eventLogMetadata(),
        afterSequence: 2,
      },
    });
    const cursorReplay = await createReadSessionEventsResponse(orchestrator, {
      type: "read-session-events",
      sessionId: "session-1",
      afterSequence: 2,
      lastEventId: "event-2",
    });

    expect(probes.runAfterSequences).toEqual([2]);
    expect(probes.sessionAfterSequences).toEqual([0]);
    expect(incremental).toMatchObject({
      ok: true,
      message: {
        diagnostics: {
          mode: "incremental",
          requestedAfterSequence: 2,
          storeReadAfterSequence: 2,
          projectedAfterSequence: 2,
          eventsFetched: 1,
        },
      },
    });
    expect(cursorReplay).toMatchObject({
      ok: true,
      message: {
        diagnostics: {
          mode: "cursor-replay",
          requestedAfterSequence: 2,
          storeReadAfterSequence: 0,
          projectedAfterSequence: 2,
          eventsFetched: 1,
        },
      },
    });
  });

  it("resolves deep lastEventId replay cursors before applying the detail page cap", async () => {
    const probes: FakeOrchestratorProbes = { runAfterSequences: [], sessionAfterSequences: [] };
    const events = Array.from({ length: 1000 }, (_value, index) => runQueued(`event-${index + 1}`, index + 1));
    const orchestrator = fakeOrchestrator(events, runRecord(), probes);

    const result = await createReadSessionEventsResponse(orchestrator, {
      type: "read-session-events",
      sessionId: "session-1",
      lastEventId: "event-750",
      maxEvents: 25,
    });

    expect(probes.sessionAfterSequences).toEqual([0]);
    expect(result).toMatchObject({
      ok: true,
      message: {
        type: "session-events",
        afterSequence: 750,
        nextAfterSequence: 775,
        hasMore: true,
        nextCursor: {
          afterSequence: 775,
          lastEventId: "event-775",
        },
        diagnostics: {
          mode: "cursor-replay",
          storeReadAfterSequence: 0,
          projectedAfterSequence: 750,
          eventsFetched: 250,
          eventsReturned: 25,
          truncated: true,
          maxEvents: 25,
        },
      },
    });
    if (result.ok && result.message.type === "session-events") {
      expect(result.message.events).toHaveLength(25);
      expect(result.message.events[0]?.id).toBe("event-751");
      expect(result.message.events.at(-1)?.id).toBe("event-775");
    }
  });

  it("lists sessions and runs without hydrating event details", async () => {
    const probes: FakeOrchestratorProbes = {
      listSessions: 0,
      listRuns: [],
      runAfterSequences: [],
      sessionAfterSequences: [],
    };
    const orchestrator = fakeOrchestrator([runQueued("event-1")], runRecord(), probes);

    await expect(createListSessionsResponse(orchestrator)).resolves.toMatchObject({
      type: "sessions-listed",
      eventLog: eventLogMetadata(),
      sessions: [{ id: "session-1" }],
      summaries: [
        {
          sessionId: "session-1",
          eventCount: 1,
          runCount: 1,
          activeRunCount: 1,
          activeRunIds: ["run-1"],
          latestRunId: "run-1",
          latestRunStatus: "queued",
          latestRunUpdatedAt: "2026-01-01T00:00:01.000Z",
          lastEventId: "event-1",
          lastSequence: 1,
        },
      ],
      diagnostics: {
        sessionCount: 1,
        summaryCount: 1,
        metadataCount: 0,
        filteredOutCount: 0,
        summarySource: "event-store",
      },
    });
    expect(createListRunsResponse(orchestrator, { type: "list-runs", sessionId: "session-1" })).toMatchObject({
      type: "runs-listed",
      sessionId: "session-1",
      runs: [{ id: "run-1" }],
    });
    expect(probes.listSessions).toBe(1);
    expect(probes.listRuns).toEqual(["session-1"]);
    expect(probes.runAfterSequences).toEqual([]);
    expect(probes.sessionAfterSequences).toEqual([]);
  });

  it("merges session metadata into list results and hides archived or deleted sessions by default", async () => {
    const events = [runQueued("event-1")];
    const orchestrator = fakeOrchestrator(events, runRecord(), {}, [
      sessionRecord("session-1", "2026-01-01T00:00:01.000Z"),
      sessionRecord("session-2", "2026-01-01T00:00:02.000Z"),
      sessionRecord("session-3", "2026-01-01T00:00:03.000Z"),
    ]);
    const metadataStore = fakeMetadataStore([
      metadataRecord("session-1", { pinned: true, title: "Pinned title", updatedAt: "2026-01-01T00:00:04.000Z" }),
      metadataRecord("session-2", { archived: true }),
      metadataRecord("session-3", { deleted: true }),
    ]);

    const visible = await createListSessionsResponse(orchestrator, { metadataStore });
    const all = await createListSessionsResponse(orchestrator, {
      metadataStore,
      query: { includeArchived: true, includeDeleted: true },
    });

    expect(visible).toMatchObject({
      type: "sessions-listed",
      sessions: [
        {
          id: "session-1",
          updatedAt: "2026-01-01T00:00:04.000Z",
          metadata: {
            sessionMetadata: {
              title: "Pinned title",
              pinned: true,
              archived: false,
              deleted: false,
            },
          },
        },
      ],
      summaries: [
        {
          sessionId: "session-1",
          title: "Pinned title",
          pinned: true,
          archived: false,
          deleted: false,
          metadataUpdatedAt: "2026-01-01T00:00:04.000Z",
        },
      ],
    });
    expect(all).toMatchObject({
      sessions: [
        { id: "session-1" },
        { id: "session-3" },
        { id: "session-2", status: "archived" },
      ],
      diagnostics: {
        sessionCount: 3,
        summaryCount: 3,
        metadataCount: 3,
        filteredOutCount: 0,
      },
    });
  });

  it("caps detail reads while reporting lightweight pagination diagnostics", async () => {
    const probes: FakeOrchestratorProbes = { runAfterSequences: [], sessionAfterSequences: [] };
    const events = Array.from({ length: 1000 }, (_value, index) => runQueued(`event-${index + 1}`, index + 1));
    const orchestrator = fakeOrchestrator(events, runRecord(), probes);

    const result = await createReadSessionEventsResponse(orchestrator, {
      type: "read-session-events",
      sessionId: "session-1",
      afterSequence: 0,
      maxEvents: 50,
    });

    expect(probes.sessionAfterSequences).toEqual([0]);
    expect(result).toMatchObject({
      ok: true,
      message: {
        type: "session-events",
        nextAfterSequence: 50,
        hasMore: true,
        nextCursor: {
          afterSequence: 50,
          lastEventId: "event-50",
        },
        diagnostics: {
          eventsFetched: 51,
          eventsReturned: 50,
          truncated: true,
          maxEvents: 50,
        },
      },
    });
    if (result.ok) {
      expect(result.message.type).toBe("session-events");
      if (result.message.type === "session-events") {
        expect(result.message.events).toHaveLength(50);
        expect(result.message.events[0]?.id).toBe("event-1");
        expect(result.message.events.at(-1)?.id).toBe("event-50");
        expect(JSON.stringify(result.message.events)).not.toContain("event-1000");
      }
    }
  });

  it("uses a bounded default detail page when callers omit maxEvents", async () => {
    const events = Array.from({ length: 700 }, (_value, index) => runQueued(`event-${index + 1}`, index + 1));
    const orchestrator = fakeOrchestrator(events, runRecord());

    const result = await createReadRunEventsResponse(orchestrator, {
      type: "read-run-events",
      runId: "run-1",
      afterSequence: 0,
    });

    expect(result).toMatchObject({
      ok: true,
      message: {
        type: "run-events",
        nextAfterSequence: 500,
        hasMore: true,
        diagnostics: {
          eventsFetched: 501,
          eventsReturned: 500,
          truncated: true,
          maxEvents: 500,
        },
      },
    });
    if (result.ok && result.message.type === "run-events") {
      expect(result.message.events).toHaveLength(500);
    }
  });
});

function fakeOrchestrator(
  events: OrchestratorEvent[],
  run: OrchestratorRunRecord | undefined,
  probes: FakeOrchestratorProbes = {},
  sessions = [sessionRecord()]
): AgentOrchestrator {
  return {
    listSessions: () => {
      probes.listSessions = (probes.listSessions ?? 0) + 1;
      return sessions;
    },
    listRuns: (sessionId?: string) => {
      probes.listRuns?.push(sessionId);
      return run && (!sessionId || run.sessionId === sessionId) ? [run] : [];
    },
    readRunEvents: async (_runId: string, afterSequence = 0, options?: { maxEvents?: number }) => {
      probes.runAfterSequences?.push(afterSequence);
      return limitFakeEvents(events.filter((event) => event.sequence > afterSequence), options?.maxEvents);
    },
    readSessionEvents: async (_sessionId: string, afterSequence = 0, options?: { maxEvents?: number }) => {
      probes.sessionAfterSequences?.push(afterSequence);
      return limitFakeEvents(events.filter((event) => event.sequence > afterSequence), options?.maxEvents);
    },
    getRun: () => run,
    getEventLogMetadata: async () => eventLogMetadata(),
    listSessionSummaries: () => summarizeFakeEvents(events),
  } as unknown as AgentOrchestrator;
}

function limitFakeEvents(events: OrchestratorEvent[], maxEvents: number | undefined): OrchestratorEvent[] {
  return maxEvents === undefined ? events : events.slice(0, maxEvents);
}

interface FakeOrchestratorProbes {
  listSessions?: number;
  listRuns?: Array<string | undefined>;
  runAfterSequences?: number[];
  sessionAfterSequences?: number[];
}

function eventLogMetadata() {
  return {
    eventLogId: "eventlog_current",
    generation: 2,
    schemaVersion: 1 as const,
    protocolVersion: 1 as const,
  };
}

function summarizeFakeEvents(events: OrchestratorEvent[]) {
  const summaries = new Map<
    string,
    {
      sessionId: string;
      lastUpdated: string;
      eventCount: number;
      runCount: number;
      activeRunCount?: number;
      activeRunIds?: string[];
      latestRunId?: string;
      latestRunStatus?: OrchestratorRunRecord["status"];
      latestRunUpdatedAt?: string;
      pendingInputCount?: number;
      pendingApprovalCount?: number;
      runIds: Set<string>;
      runStates: Map<string, { runId: string; status: OrchestratorRunRecord["status"]; updatedAt: string; lastSequence: number }>;
      pendingInputIds: Set<string>;
      lastEventId?: string;
      lastSequence?: number;
    }
  >();
  for (const event of events) {
    const summary =
      summaries.get(event.sessionId) ??
      {
        sessionId: event.sessionId,
        lastUpdated: event.timestamp,
        eventCount: 0,
        runCount: 0,
        runIds: new Set<string>(),
        runStates: new Map<string, { runId: string; status: OrchestratorRunRecord["status"]; updatedAt: string; lastSequence: number }>(),
        pendingInputIds: new Set<string>(),
      };
    summary.eventCount += 1;
    const pendingInputId = fakePendingInputIdFromEvent(event);
    if (pendingInputId && event.type === "pending-input-created") summary.pendingInputIds.add(pendingInputId);
    if (
      pendingInputId &&
      (event.type === "pending-input-cancelled" || event.type === "pending-input-dispatched")
    ) {
      summary.pendingInputIds.delete(pendingInputId);
    }
    if (event.runId) {
      summary.runIds.add(event.runId);
      summary.runCount = summary.runIds.size;
      const status = fakeRunStatusFromEvent(event);
      if (status) {
        summary.runStates.set(event.runId, {
          runId: event.runId,
          status,
          updatedAt: event.timestamp,
          lastSequence: event.sequence,
        });
      }
    }
    if (summary.lastSequence === undefined || event.sequence >= summary.lastSequence) {
      summary.lastUpdated = event.timestamp;
      summary.lastEventId = event.id;
      summary.lastSequence = event.sequence;
    }
    summaries.set(event.sessionId, summary);
  }
  return [...summaries.values()].map(({ runIds: _runIds, runStates, pendingInputIds, ...summary }) => {
    const states = [...runStates.values()].sort((left, right) => right.lastSequence - left.lastSequence);
    const active = states.filter((state) =>
      state.status === "queued" || state.status === "running" || state.status === "awaiting-approval" || state.status === "cancelling"
    );
    const latest = states[0];
    return {
      ...summary,
      activeRunCount: active.length,
      ...(active.length > 0 ? { activeRunIds: active.map((state) => state.runId) } : {}),
      ...(latest
        ? {
            latestRunId: latest.runId,
            latestRunStatus: latest.status,
            latestRunUpdatedAt: latest.updatedAt,
          }
        : {}),
      pendingInputCount: pendingInputIds.size,
      pendingApprovalCount: states.filter((state) => state.status === "awaiting-approval").length,
    };
  });
}

function fakePendingInputIdFromEvent(event: OrchestratorEvent): string | undefined {
  if (isFakeRecord(event.payload.input) && typeof event.payload.input.id === "string") return event.payload.input.id;
  return typeof event.payload.inputId === "string" ? event.payload.inputId : undefined;
}

function fakeRunStatusFromEvent(event: OrchestratorEvent): OrchestratorRunRecord["status"] | undefined {
  const run = event.payload.run;
  if (isFakeRecord(run) && typeof run.status === "string") {
    return run.status as OrchestratorRunRecord["status"];
  }
  if (event.type === "run-queued") return "queued";
  if (event.type === "run-started") return "running";
  if (event.type === "run-cancel-requested") return "cancelling";
  if (event.type === "run-cancelled") return "cancelled";
  if (event.type === "run-completed") return "completed";
  if (event.type === "run-failed") return "failed";
  if (event.type === "runtime-event" && isFakeRecord(event.payload.event)) {
    if (event.payload.event.type === "approval-requested") return "awaiting-approval";
    if (event.payload.event.type === "approval-resolved") return "running";
  }
  return undefined;
}

function isFakeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runQueued(id: string, sequence = 1): OrchestratorEvent {
  return {
    protocolVersion: 1,
    id,
    sequence,
    type: "run-queued",
    sessionId: "session-1",
    runId: "run-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    payload: { run: runRecord() as unknown as JsonObject },
  };
}

function runRecord(): OrchestratorRunRecord {
  return {
    id: "run-1",
    sessionId: "session-1",
    cwd: "C:/repo",
    status: "queued",
    createdAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    metadata: { prompt: "Snapshot query" },
  };
}

function sessionRecord(id = "session-1", updatedAt = "2026-01-01T00:00:01.000Z") {
  return {
    id,
    cwd: "C:/repo",
    status: "open" as const,
    createdAt: "2026-01-01T00:00:01.000Z",
    updatedAt,
  };
}

function fakeMetadataStore(records: SessionMetadataRecord[]): FileSessionMetadataStore {
  return {
    list: async () => records,
  } as unknown as FileSessionMetadataStore;
}

function metadataRecord(
  sessionId: string,
  patch: Partial<SessionMetadataRecord> = {}
): SessionMetadataRecord {
  return {
    sessionId,
    pinned: false,
    archived: false,
    deleted: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: {
      actionId: "action-1",
      actionKind: "pin",
      requestedAt: "2026-01-01T00:00:00.000Z",
      requestedBy: "workbench",
    },
    ...patch,
  };
}
