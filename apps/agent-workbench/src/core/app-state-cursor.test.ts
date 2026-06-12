import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppState } from "./app-state";
import type {
  DaemonEventLogMetadata,
  DaemonOrchestratorEvent,
  DaemonSessionRecord,
  DaemonSessionSummary,
  WorkbenchJsonObject
} from "../shared/workbench-contract";

describe("AppState daemon event cursors", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    localStorage.clear();
  });

  it("creates no-project sessions by default even when a project folder is selected", () => {
    const state = new AppState();
    state.setState("workingDirectory", "C:/Software/conex");
    // workMode is now a computed property derived from currentSession.projectId

    const session = state.createSession();

    expect(session.projectId).toBeNull();
    expect(session.workingDirectory).toBeUndefined();
    expect(state.getCurrentWorkspaceContext()).toMatchObject({
      workspaceMode: "none",
      projectId: null,
    });
    expect(state.workMode).toBe("chat");
  });

  it("keeps a direct first user message in a no-project conversation", () => {
    const state = new AppState();
    state.setState("workingDirectory", "C:/Software/conex");
    // workMode is now a computed property derived from currentSession.projectId

    const message = state.addMessage({ role: "user", content: "hello from an empty chat" });
    const session = state.getSession(message.sessionId);

    expect(session?.projectId).toBeNull();
    expect(session?.workingDirectory).toBeUndefined();
    expect(state.getRunWorkspace(session?.id)).toEqual({ workspaceMode: "none" });
    expect(state.workMode).toBe("chat");
  });

  it("persists replay cursors under the event log identity namespace", () => {
    const state = new AppState();
    const firstLog = eventLog("eventlog_one", 1);
    const secondLog = eventLog("eventlog_two", 1);

    state.setDaemonRunEvents("run-1", [event("event-1", 1)], firstLog, 1);
    expect(state.getPersistedRunCursor("run-1")).toMatchObject({
      eventLogId: "eventlog_one",
      generation: 1,
      afterSequence: 1,
      lastEventId: "event-1",
    });

    state.setDaemonRunEvents("run-1", [event("event-2", 1)], secondLog, 1);
    expect(state.getPersistedRunCursor("run-1")).toMatchObject({
      eventLogId: "eventlog_two",
      generation: 1,
      afterSequence: 1,
      lastEventId: "event-2",
    });

    const raw = JSON.parse(localStorage.getItem("conex-event-cursors") ?? "{}");
    expect(Object.keys(raw.runs)).toEqual([
      "eventlog_one:1:1:1:run-1",
      "eventlog_two:1:1:1:run-1",
    ]);
  });

  it("deduplicates appended daemon session event batches", () => {
    const state = new AppState();
    const log = eventLog("eventlog_one", 1);

    state.setDaemonSessionEvents("session-1", [event("event-1", 1)], log, 1, true, {
      backend: {
        mode: "full-replay",
        requestedAfterSequence: 0,
        storeReadAfterSequence: 0,
        projectedAfterSequence: 0,
        eventsFetched: 1,
        queryMs: 4,
      },
    });
    state.appendDaemonSessionEvents("session-1", [event("event-1", 1), event("event-2", 2)], log, 2, true, {
      requestMs: 7,
      backend: {
        mode: "incremental",
        requestedAfterSequence: 1,
        storeReadAfterSequence: 1,
        projectedAfterSequence: 1,
        eventsFetched: 2,
        queryMs: 3,
      },
    });

    expect(state.getState().daemonBrowser.sessionEventsBySessionId["session-1"]?.events.map((item) => item.id)).toEqual([
      "event-1",
      "event-2",
    ]);
    expect(state.getPersistedSessionCursor("session-1")).toMatchObject({
      afterSequence: 2,
      lastEventId: "event-2",
    });
    expect(state.getState().daemonBrowser.sessionEventsBySessionId["session-1"]?.diagnostics).toMatchObject({
      scope: "session",
      targetId: "session-1",
      mode: "incremental",
      requestMs: 7,
      backendQueryMs: 3,
      eventsFetched: 2,
      eventsApplied: 1,
      dedupedCount: 1,
      totalEvents: 2,
    });
  });

  it("projects lightweight daemon session summaries before detail hydration", () => {
    const state = new AppState();
    const records = [
      sessionRecord("session-old", "2026-06-08T00:00:00.000Z"),
      sessionRecord("session-new", "2026-06-08T00:01:00.000Z"),
    ];
    const summaries: DaemonSessionSummary[] = [
      {
        sessionId: "session-old",
        lastUpdated: "2026-06-08T00:05:00.000Z",
        eventCount: 10,
        runCount: 2,
        activeRunCount: 1,
        activeRunIds: ["run-active"],
        latestRunId: "run-active",
        latestRunStatus: "running",
        latestRunUpdatedAt: "2026-06-08T00:05:00.000Z",
        pendingInputCount: 1,
        pendingApprovalCount: 0,
        lastEventId: "event-10",
        lastSequence: 10,
        lastMessagePreview: "Latest summary preview",
      },
      {
        sessionId: "session-new",
        lastUpdated: "2026-06-08T00:01:00.000Z",
        eventCount: 1,
        runCount: 1,
      },
    ];

    state.setDaemonSessions(records, summaries);

    expect(state.getState().daemonBrowser.sessions.map((session) => session.id)).toEqual([
      "session-old",
      "session-new",
    ]);
    expect(state.getState().daemonBrowser.sessionSummaries["session-old"]).toMatchObject({
      eventCount: 10,
      runCount: 2,
      lastSequence: 10,
      lastMessagePreview: "Latest summary preview",
    });
    expect(state.getSession("session-old")).toMatchObject({
      id: "session-old",
      messages: [],
      updatedAt: Date.parse("2026-06-08T00:05:00.000Z"),
      activeRunId: "run-active",
      lastRunId: "run-active",
      daemonSummary: expect.objectContaining({ lastEventId: "event-10" }),
    });
  });

  it("replaces daemon sessions from refreshed action results instead of keeping stale metadata", () => {
    const state = new AppState();
    state.setDaemonSessions([sessionRecord("session-1", "2026-06-08T00:00:00.000Z", { title: "Before" })]);
    state.setDaemonSessions([sessionRecord("session-1", "2026-06-08T00:01:00.000Z", { title: "After", pinned: true })]);

    expect(state.getSession("session-1")).toMatchObject({
      title: "After",
      daemonRecord: expect.objectContaining({
        metadata: expect.objectContaining({ title: "After", pinned: true }),
      }),
    });
    expect(state.getState().currentSession?.title).toBe("After");
  });

  it("retains daemon event pagination fields and persists next cursors", () => {
    const state = new AppState();
    const log = eventLog("eventlog_one", 1);
    const nextCursor = {
      ...log,
      afterSequence: 2,
      lastEventId: "event-2",
    };

    state.setDaemonSessionEvents("session-1", [event("event-1", 1), event("event-2", 2)], log, 2, true, {
      nextCursor,
      hasMore: true,
      backend: {
        mode: "incremental",
        requestedAfterSequence: 0,
        storeReadAfterSequence: 0,
        projectedAfterSequence: 0,
        eventsFetched: 3,
        eventsReturned: 2,
        truncated: true,
        maxEvents: 2,
        queryMs: 5,
      },
    });

    expect(state.getState().daemonBrowser.sessionEventsBySessionId["session-1"]).toMatchObject({
      hasMore: true,
      nextAfterSequence: 2,
      nextCursor,
      diagnostics: {
        hasMore: true,
        maxEvents: 2,
        nextCursor,
      },
    });
    expect(state.getPersistedSessionCursor("session-1")).toMatchObject(nextCursor);
  });

  it("hydrates daemon history incrementally without duplicate messages or stale drafts", () => {
    const state = new AppState();
    const firstBatch = [
      runQueued("event-1", 1),
      runtimeEvent("event-2", 2, {
        type: "message-delta",
        messageId: "assistant-1",
        block: { type: "text", text: "Hel" },
      }),
    ];

    state.hydrateSessionFromDaemonEvents("session-1", firstBatch);
    state.hydrateSessionFromDaemonEvents("session-1", firstBatch);

    expect(messageContents(state)).toEqual(["Build history", "Hel"]);

    state.hydrateSessionFromDaemonEvents("session-1", [
      runtimeEvent("event-3", 3, {
        type: "message-delta",
        messageId: "assistant-1",
        block: { type: "text", text: "lo" },
      }),
    ]);
    expect(messageContents(state)).toEqual(["Build history", "Hello"]);

    state.hydrateSessionFromDaemonEvents("session-1", [
      runtimeEvent("event-4", 4, {
        type: "message-end",
        message: {
          id: "assistant-1",
          role: "assistant",
          createdAt: "2026-06-08T00:00:04.000Z",
          blocks: [{ type: "text", text: "Hello" }],
        },
      }),
    ]);

    expect(messageContents(state)).toEqual(["Build history", "Hello"]);
    expect(state.getSession("session-1")?.messages.map((message) => message.id)).toEqual([
      "daemon-user-event-1",
      "assistant-1",
    ]);
  });

  it("ignores a persisted cursor when switching to an empty daemon session without cached events", async () => {
    const seed = new AppState();
    const log = eventLog("eventlog_one", 1);
    seed.setDaemonSessionEvents("session-1", [event("event-1", 1)], log, 1);

    const state = new AppState();
    state.setDaemonSessions([sessionRecord("session-1", "2026-06-08T00:00:00.000Z")]);
    const { tauriBridge } = await import("./tauri-bridge");
    const readSessionEvents = vi.spyOn(tauriBridge, "readSessionEvents").mockResolvedValue({
      type: "session-events",
      sessionId: "session-1",
      events: [runQueued("event-1", 1)],
      eventLog: log,
      afterSequence: 0,
      nextAfterSequence: 1,
      hasMore: false,
    });
    const listRuns = vi.spyOn(tauriBridge, "listRuns").mockResolvedValue([]);

    await state.switchSession("session-1");

    expect(state.getCurrentSessionId()).toBe("session-1");
    expect(readSessionEvents).toHaveBeenCalledWith({
      sessionId: "session-1",
      afterSequence: 0,
      maxEvents: 200,
      cursor: undefined,
    });
    expect(state.getSession("session-1")?.messages.map((message) => message.content)).toEqual(["Build history"]);
    listRuns.mockRestore();
    readSessionEvents.mockRestore();
  });

  it("loads daemon history on session switch even when local placeholder messages exist", async () => {
    const state = new AppState();
    const log = eventLog("eventlog_one", 1);
    state.setDaemonSessions([sessionRecord("session-1", "2026-06-08T00:00:00.000Z")]);
    const session = state.getSession("session-1");
    session?.messages.push({
      id: "local-placeholder",
      role: "system",
      content: "Starting...",
      timestamp: Date.now(),
    });
    const { tauriBridge } = await import("./tauri-bridge");
    const readSessionEvents = vi.spyOn(tauriBridge, "readSessionEvents").mockResolvedValue({
      type: "session-events",
      sessionId: "session-1",
      events: [runQueued("event-1", 1)],
      eventLog: log,
      afterSequence: 0,
      nextAfterSequence: 1,
      hasMore: false,
    });
    const listRuns = vi.spyOn(tauriBridge, "listRuns").mockResolvedValue([]);

    await state.switchSession("session-1");

    expect(state.getCurrentSessionId()).toBe("session-1");
    expect(readSessionEvents).toHaveBeenCalled();
    expect(state.getSession("session-1")?.messages.map((message) => message.content)).toEqual(["Build history"]);
    listRuns.mockRestore();
    readSessionEvents.mockRestore();
  });

  it("does not switch the active chat when daemon events are hydrated for a browser selection", () => {
    const state = new AppState();
    const active = state.createSession("Active local chat", null);

    state.hydrateSessionFromDaemonEvents("session-1", [runQueued("event-1", 1)]);

    expect(state.getCurrentSessionId()).toBe(active.id);
    expect(state.getState().currentSession?.id).toBe(active.id);
    expect(state.getSession("session-1")?.messages.map((message) => message.content)).toEqual(["Build history"]);
  });

  it("activates a hydrated daemon session only when explicitly requested", () => {
    const state = new AppState();
    const active = state.createSession("Active local chat", null);

    state.hydrateSessionFromDaemonEvents("session-1", [runQueued("event-1", 1)], { activate: true });

    expect(state.getCurrentSessionId()).not.toBe(active.id);
    expect(state.getCurrentSessionId()).toBe("session-1");
    expect(state.getState().currentSession?.messages.map((message) => message.content)).toEqual(["Build history"]);
  });

  it("emits a fresh current session object when activated daemon history changes", () => {
    const state = new AppState();
    state.setDaemonSessions([sessionRecord("session-1", "2026-06-08T00:00:00.000Z")]);
    state.selectDaemonSession("session-1", { activate: true });
    const before = state.getState().currentSession;
    const seen: Array<unknown> = [];
    const unsubscribe = state.subscribe("currentSession", (session) => {
      seen.push(session);
    });

    state.hydrateSessionFromDaemonEvents("session-1", [runQueued("event-1", 1)], { activate: true });

    const after = state.getState().currentSession;
    expect(after).not.toBe(before);
    expect(after?.messages.map((message) => message.content)).toEqual(["Build history"]);
    expect(seen.at(-1)).toBe(after);
    unsubscribe();
  });

  it("fully replays a daemon session switch when only a placeholder is present", async () => {
    const state = new AppState();
    const log = eventLog("eventlog_one", 1);
    state.setDaemonSessions([sessionRecord("session-1", "2026-06-08T00:00:00.000Z")]);
    state.hydrateSessionFromDaemonEvents("session-1", [runQueued("old-event", 1)]);
    state.getSession("session-1")!.messages = [
      {
        id: "local-placeholder",
        role: "system",
        content: "Starting...",
        timestamp: Date.now(),
      },
    ];

    const { tauriBridge } = await import("./tauri-bridge");
    const readSessionEvents = vi.spyOn(tauriBridge, "readSessionEvents").mockResolvedValue({
      type: "session-events",
      sessionId: "session-1",
      events: [runQueued("event-1", 1)],
      eventLog: log,
      afterSequence: 0,
      nextAfterSequence: 1,
      hasMore: false,
    });
    const listRuns = vi.spyOn(tauriBridge, "listRuns").mockResolvedValue([]);

    await state.switchSession("session-1");

    expect(readSessionEvents).toHaveBeenCalledWith({
      sessionId: "session-1",
      afterSequence: 0,
      maxEvents: 200,
      cursor: undefined,
    });
    expect(state.getState().currentSession?.id).toBe("session-1");
    expect(state.getState().currentSession?.messages.map((message) => message.content)).toEqual(["Build history"]);
    listRuns.mockRestore();
    readSessionEvents.mockRestore();
  });

  it("keeps existing daemon sessions when a refresh fails", async () => {
    const state = new AppState();
    const first = sessionRecord("session-1", "2026-06-08T00:00:00.000Z");
    state.setDaemonSessions([first]);
    const { tauriBridge } = await import("./tauri-bridge");
    const diagnosticResult = Object.assign([], {
      ok: false as const,
      diagnostic: {
        command: "workbench_list_sessions",
        code: "daemon-disconnected" as const,
        feature: "session list",
        message: "sidecar.daemon connect failed while querying sessions-listed",
        severity: "error" as const,
        source: "tauri-bridge" as const,
      },
    });
    const listSessions = vi.spyOn(tauriBridge, "listSessions").mockResolvedValue(diagnosticResult);

    await expect(state.refreshDaemonSessionsAfterAction()).rejects.toThrow(/sidecar\.daemon connect failed/);

    expect(state.getState().daemonBrowser.sessions.map((session) => session.id)).toEqual(["session-1"]);
    expect(state.getState().sessions.map((session) => session.id)).toContain("session-1");
    expect(state.getState().daemonBrowser.error).toContain("sidecar.daemon connect failed");
    listSessions.mockRestore();
  });

  it("merges run snapshots without dropping earlier session messages", () => {
    const state = new AppState();
    state.hydrateSessionFromDaemonEvents("session-1", [
      runQueued("event-1", 1, { runId: "run-old", prompt: "Older question" }),
      runtimeEvent("event-2", 2, {
        type: "message-delta",
        messageId: "assistant-old",
        block: { type: "text", text: "Older answer" },
      }, "run-old"),
      runtimeEvent("event-3", 3, {
        type: "message-end",
        message: {
          id: "assistant-old",
          role: "assistant",
          createdAt: "2026-06-08T00:00:03.000Z",
          blocks: [{ type: "text", text: "Older answer" }],
        },
      }, "run-old"),
    ], { activate: true });

    state.hydrateSessionFromDaemonSnapshot({
      sessionId: "session-1",
      runId: "run-new",
      title: "New failed run",
      status: "failed",
      updatedAt: "2026-06-08T00:00:06.000Z",
      currentRun: {
        id: "run-new",
        sessionId: "session-1",
        cwd: "C:/repo",
        createdAt: "2026-06-08T00:00:04.000Z",
        updatedAt: "2026-06-08T00:00:06.000Z",
        metadata: { prompt: "New question", workspaceMode: "project" },
      },
      messages: [
        {
          id: "daemon-user-run-new",
          role: "user",
          content: "New question",
          createdAt: "2026-06-08T00:00:04.000Z",
        },
        {
          id: "assistant-new",
          role: "assistant",
          content: "[系统错误] failed",
          createdAt: "2026-06-08T00:00:05.000Z",
        },
      ],
      pendingToolCalls: [],
      backgroundTasks: [],
      progressLabel: "Failed",
    });

    expect(state.getState().currentSession?.messages.map((message) => message.content)).toEqual([
      "Older question",
      "Older answer",
      "New question",
      "[系统错误] failed",
    ]);
  });
});

function eventLog(eventLogId: string, generation: number): DaemonEventLogMetadata {
  return {
    eventLogId,
    generation,
    schemaVersion: 1,
    protocolVersion: 1,
  };
}

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return [...data.keys()][index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

function event(id: string, sequence: number) {
  return {
    protocolVersion: 1 as const,
    id,
    sequence,
    type: "run-started" as const,
    sessionId: "session-1",
    runId: "run-1",
    timestamp: "2026-06-08T00:00:00.000Z",
    payload: {},
  };
}

function sessionRecord(
  id: string,
  updatedAt: string,
  metadata?: WorkbenchJsonObject
): DaemonSessionRecord {
  return {
    id,
    cwd: `C:/repo/${id}`,
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt,
    status: "open",
    ...(metadata ? { metadata } : {}),
  };
}

function runQueued(
  id: string,
  sequence: number,
  overrides: { runId?: string; prompt?: string } = {}
): DaemonOrchestratorEvent {
  const runId = overrides.runId ?? "run-1";
  return {
    protocolVersion: 1,
    id,
    sequence,
    type: "run-queued",
    sessionId: "session-1",
    runId,
    timestamp: timestamp(sequence),
    payload: {
      run: {
        id: runId,
        sessionId: "session-1",
        cwd: "C:/repo",
        status: "queued",
        createdAt: timestamp(1),
        updatedAt: timestamp(1),
        metadata: { prompt: overrides.prompt ?? "Build history" },
      },
    },
  };
}

function runtimeEvent(
  id: string,
  sequence: number,
  runtimeEvent: WorkbenchJsonObject,
  runId = "run-1"
): DaemonOrchestratorEvent {
  return {
    protocolVersion: 1,
    id,
    sequence,
    type: "runtime-event",
    sessionId: "session-1",
    runId,
    timestamp: timestamp(sequence),
    payload: { event: runtimeEvent },
  };
}

function timestamp(sequence: number): string {
  return `2026-06-08T00:00:0${sequence}.000Z`;
}

function messageContents(state: AppState): string[] {
  return state.getSession("session-1")?.messages.map((message) => message.content) ?? [];
}
