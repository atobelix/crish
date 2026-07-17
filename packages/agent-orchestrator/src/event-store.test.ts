import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ORCHESTRATOR_PROTOCOL_VERSION, type OrchestratorEvent } from "./types";
import {
  createOrchestratorEventStoreHeader,
  FileOrchestratorEventStore,
  ORCHESTRATOR_EVENT_STORE_FILE_VERSION,
  ORCHESTRATOR_SESSION_SUMMARY_INDEX_VERSION,
  OrchestratorEventStoreDuplicateIdError,
  OrchestratorEventStoreInvalidEventError,
  OrchestratorEventStoreInvalidReadError,
} from "./event-store";

describe("FileOrchestratorEventStore", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("appends JSONL events behind a version header and reads by session, run, and sequence", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);
    const events = [
      event({ id: "event_1", sequence: 1, sessionId: "session_a", runId: "run_a" }),
      event({ id: "event_2", sequence: 2, sessionId: "session_a", runId: "run_b" }),
      event({ id: "event_3", sequence: 3, sessionId: "session_b", runId: "run_c" }),
      event({ id: "event_4", sequence: 4, sessionId: "session_a", runId: "run_a" })
    ];

    await Promise.all(events.map((item) => store.append(item)));

    const lines = (await readFile(filePath, "utf8")).trim().split(/\r?\n/);
    expect(JSON.parse(lines[0]!)).toEqual({
      type: "orchestrator-event-store",
      version: ORCHESTRATOR_EVENT_STORE_FILE_VERSION,
      protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
      eventLogId: expect.stringMatching(/^eventlog_/),
      generation: 1,
      schemaVersion: 1
    });
    expect(lines).toHaveLength(5);
    await expect(store.readSession("session_a", 1)).resolves.toEqual([events[1], events[3]]);
    await expect(store.readRun("run_a", 1)).resolves.toEqual([events[3]]);
  });

  it("exposes stable event log metadata from the JSONL header", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const header = createOrchestratorEventStoreHeader({ eventLogId: "eventlog_test", generation: 7 });
    const store = new FileOrchestratorEventStore(filePath, { header });

    await store.append(event({ id: "event_1", sequence: 1, sessionId: "session_a", runId: "run_a" }));

    await expect(store.getMetadata()).resolves.toEqual({
      eventLogId: "eventlog_test",
      generation: 7,
      schemaVersion: 1,
      protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION
    });
    await expect(new FileOrchestratorEventStore(filePath).getMetadata()).resolves.toEqual({
      eventLogId: "eventlog_test",
      generation: 7,
      schemaVersion: 1,
      protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION
    });
  });

  it("skips corrupt and invalid event lines while preserving valid sequence order", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const newest = event({ id: "event_4", sequence: 4, sessionId: "session_a", runId: "run_a" });
    const oldest = event({ id: "event_2", sequence: 2, sessionId: "session_a", runId: "run_a" });
    const header = JSON.stringify({
      type: "orchestrator-event-store",
      version: ORCHESTRATOR_EVENT_STORE_FILE_VERSION,
      protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION
    });

    await writeFile(
      filePath,
      [header, "{bad json", JSON.stringify({ type: "not-an-event" }), JSON.stringify(newest), "", JSON.stringify(oldest)].join("\n"),
      "utf8"
    );

    await expect(new FileOrchestratorEventStore(filePath).readAll()).resolves.toEqual([oldest, newest]);
  });

  it("roundtrips goal lifecycle events through file read APIs", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);
    const events = [
      event({
        id: "event_goal_1",
        sequence: 1,
        sessionId: "session_goal",
        runId: "run_goal",
        type: "goal-round-started",
        payload: { round: { index: 0 } }
      }),
      event({
        id: "event_goal_2",
        sequence: 2,
        sessionId: "session_goal",
        runId: "run_goal",
        type: "goal-round-completed",
        payload: { round: { index: 0, eventCount: 3 } }
      }),
      event({
        id: "event_goal_3",
        sequence: 3,
        sessionId: "session_goal",
        runId: "run_goal",
        type: "goal-continuation-decided",
        payload: {
          round: { index: 0 },
          decision: { action: "continue", reason: "Need another pass", prompt: "continue" }
        }
      })
    ];

    for (const item of events) {
      await store.append(item);
    }

    await expect(store.readAll()).resolves.toEqual(events);
    await expect(store.readSession("session_goal")).resolves.toEqual(events);
    await expect(store.readRun("run_goal")).resolves.toEqual(events);
  });

  it("serves indexed session and run reads after the cache has been warmed", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);
    const first = event({ id: "event_1", sequence: 1, sessionId: "session_a", runId: "run_a" });
    const second = event({ id: "event_2", sequence: 2, sessionId: "session_a", runId: "run_b" });
    const third = event({ id: "event_3", sequence: 3, sessionId: "session_b", runId: "run_a" });

    await store.append(first);
    await expect(store.readAll()).resolves.toEqual([first]);

    await store.append(second);
    await store.append(third);

    await expect(store.readSession("session_a")).resolves.toEqual([first, second]);
    await expect(store.readRun("run_a")).resolves.toEqual([first, third]);
    await expect(store.readRun("run_a", 1)).resolves.toEqual([third]);
  });

  it("serves lightweight session summaries from the event cache", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);
    const first = event({ id: "event_1", sequence: 1, sessionId: "session_a", runId: "run_a" });
    const message = event({
      id: "event_2",
      sequence: 2,
      sessionId: "session_a",
      runId: "run_b",
      payload: {
        event: {
          type: "message-end",
          message: {
            content: "Latest answer preview"
          }
        }
      }
    });
    const other = event({ id: "event_3", sequence: 3, sessionId: "session_b", runId: "run_c" });

    await store.append(first);
    await store.append(message);
    await store.append(other);

    await expect(store.listSessionSummaries()).resolves.toEqual([
      {
        sessionId: "session_b",
        lastUpdated: "2026-01-01T00:00:00.000Z",
        eventCount: 1,
        runCount: 1,
        lastEventId: "event_3",
        lastSequence: 3
      },
      {
        sessionId: "session_a",
        lastUpdated: "2026-01-01T00:00:00.000Z",
        eventCount: 2,
        runCount: 2,
        lastEventId: "event_2",
        lastSequence: 2,
        lastMessagePreview: "Latest answer preview"
      }
    ]);
  });

  it("tracks latest active and pending run state in lightweight session summaries", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);

    await store.append(
      event({
        id: "event_1",
        sequence: 1,
        sessionId: "session_a",
        runId: "run_active",
        type: "run-queued",
        payload: {
          run: {
            id: "run_active",
            status: "queued"
          }
        }
      })
    );
    await store.append(
      event({
        id: "event_2",
        sequence: 2,
        sessionId: "session_a",
        runId: "run_active",
        type: "run-started",
        payload: {
          run: {
            id: "run_active",
            status: "running"
          }
        }
      })
    );
    await store.append(
      event({
        id: "event_3",
        sequence: 3,
        sessionId: "session_a",
        runId: "run_waiting",
        type: "runtime-event",
        payload: {
          event: {
            type: "approval-requested",
            request: { id: "approval_1" }
          }
        }
      })
    );
    await store.append(
      event({
        id: "event_4",
        sequence: 4,
        sessionId: "session_a",
        runId: "run_done",
        type: "run-completed",
        payload: {
          run: {
            id: "run_done",
            status: "completed"
          }
        }
      })
    );

    await expect(store.listSessionSummaries()).resolves.toEqual([
      expect.objectContaining({
        sessionId: "session_a",
        runCount: 3,
        activeRunCount: 2,
        activeRunIds: ["run_waiting", "run_active"],
        latestRunId: "run_done",
        latestRunStatus: "completed",
        latestRunUpdatedAt: "2026-01-01T00:00:00.000Z",
        pendingApprovalCount: 1,
        lastEventId: "event_4",
        lastSequence: 4
      })
    ]);

    await expect(new FileOrchestratorEventStore(filePath).listSessionSummaries()).resolves.toEqual([
      expect.objectContaining({
        sessionId: "session_a",
        activeRunCount: 2,
        activeRunIds: ["run_waiting", "run_active"],
        latestRunId: "run_done",
        latestRunStatus: "completed",
        pendingApprovalCount: 1
      })
    ]);
  });

  it("tracks pending input counts in lightweight session summaries and cold indexes", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);
    const created = event({
      id: "event_pending_1",
      sequence: 1,
      sessionId: "session_a",
      type: "pending-input-created",
      payload: {
        input: {
          id: "pending_1",
          sessionId: "session_a",
          text: "continue after this",
          mode: "after-current-run",
          status: "pending",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      }
    });
    const cancelled = event({
      id: "event_pending_2",
      sequence: 2,
      sessionId: "session_a",
      type: "pending-input-cancelled",
      payload: {
        input: {
          id: "pending_1",
          sessionId: "session_a",
          text: "continue after this",
          mode: "after-current-run",
          status: "cancelled",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z"
        },
        inputId: "pending_1"
      }
    });

    await store.append(created);
    await expect(store.listSessionSummaries()).resolves.toEqual([
      expect.objectContaining({
        sessionId: "session_a",
        pendingInputCount: 1
      })
    ]);

    await store.append(cancelled);
    await expect(new FileOrchestratorEventStore(filePath).listSessionSummaries()).resolves.toEqual([
      expect.objectContaining({
        sessionId: "session_a",
        pendingInputCount: 0
      })
    ]);
  });

  it("persists and reuses a lightweight session summary index for cold list reads", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);
    const first = event({ id: "event_1", sequence: 1, sessionId: "session_a", runId: "run_a" });
    const message = event({
      id: "event_2",
      sequence: 2,
      sessionId: "session_a",
      runId: "run_b",
      payload: {
        event: {
          type: "message-end",
          message: {
            content: "Indexed answer preview"
          }
        }
      }
    });
    const other = event({ id: "event_3", sequence: 3, sessionId: "session_b", runId: "run_c" });

    await store.append(first);
    await store.append(message);
    await store.append(other);

    await expect(store.listSessionSummaries()).resolves.toHaveLength(2);

    const index = JSON.parse(await readFile(`${filePath}.session-index.json`, "utf8"));
    expect(index).toMatchObject({
      type: "orchestrator-session-summary-index",
      version: ORCHESTRATOR_SESSION_SUMMARY_INDEX_VERSION,
      protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
      eventLogId: expect.stringMatching(/^eventlog_/),
      generation: 1,
      schemaVersion: 1,
      summaries: expect.arrayContaining([
        expect.objectContaining({
          sessionId: "session_a",
          eventCount: 2,
          runIds: ["run_a", "run_b"],
          runStates: [],
          lastEventId: "event_2",
          lastSequence: 2,
          lastMessagePreview: "Indexed answer preview"
        })
      ])
    });

    const coldStore = new FileOrchestratorEventStore(filePath);
    await expect(coldStore.listSessionSummaries()).resolves.toEqual([
      {
        sessionId: "session_b",
        lastUpdated: "2026-01-01T00:00:00.000Z",
        eventCount: 1,
        runCount: 1,
        lastEventId: "event_3",
        lastSequence: 3
      },
      {
        sessionId: "session_a",
        lastUpdated: "2026-01-01T00:00:00.000Z",
        eventCount: 2,
        runCount: 2,
        lastEventId: "event_2",
        lastSequence: 2,
        lastMessagePreview: "Indexed answer preview"
      }
    ]);

    await coldStore.append(event({ id: "event_4", sequence: 4, sessionId: "session_a", runId: "run_d" }));
    const refreshedIndex = JSON.parse(await readFile(`${filePath}.session-index.json`, "utf8"));
    expect(refreshedIndex.summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "session_a",
          eventCount: 3,
          runIds: ["run_a", "run_b", "run_d"],
          lastEventId: "event_4",
          lastSequence: 4
        })
      ])
    );
  });

  it("treats the lightweight session summary index as best-effort", async () => {
    const dir = await tempDir(tempDirs);
    const filePath = join(dir, "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath, {
      sessionSummaryIndexPath: dir
    });

    await store.append(event({ id: "event_1", sequence: 1, sessionId: "session_a", runId: "run_a" }));
    await expect(store.listSessionSummaries()).resolves.toEqual([
      {
        sessionId: "session_a",
        lastUpdated: "2026-01-01T00:00:00.000Z",
        eventCount: 1,
        runCount: 1,
        lastEventId: "event_1",
        lastSequence: 1
      }
    ]);
    await expect(store.readAll()).resolves.toEqual([
      event({ id: "event_1", sequence: 1, sessionId: "session_a", runId: "run_a" })
    ]);
  });

  it("roundtrips durable session leaf movement events", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);
    const moved = event({
      id: "event_leaf_1",
      sequence: 1,
      sessionId: "session_leaf",
      type: "session-leaf-moved",
      payload: {
        session: {
          id: "session_leaf",
          cwd: "C:/tmp",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          status: "open",
          currentLeafId: "leaf_target"
        },
        fromLeafId: "leaf_current",
        toLeafId: "leaf_target",
        reason: "conversation-rewind"
      }
    });

    await store.append(moved);

    await expect(store.readAll()).resolves.toEqual([moved]);
    await expect(store.readSession("session_leaf")).resolves.toEqual([moved]);
  });

  it("rejects appends after close with a typed closed error", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);

    await store.append(event({ id: "event_1", sequence: 1, sessionId: "session_a", runId: "run_a" }));
    await store.close();

    await expect(
      store.append(event({ id: "event_2", sequence: 2, sessionId: "session_a", runId: "run_a" }))
    ).rejects.toMatchObject({
      name: "OrchestratorEventStoreClosedError",
      kind: "closed",
      filePath,
      eventId: "event_2"
    });
  });

  it("latches write failures with typed diagnostics", async () => {
    const dir = await tempDir(tempDirs);
    const blockerPath = join(dir, "not-a-directory");
    const filePath = join(blockerPath, "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);
    await writeFile(blockerPath, "blocks mkdir", "utf8");

    await expect(
      store.append(event({ id: "event_1", sequence: 1, sessionId: "session_a", runId: "run_a" }))
    ).rejects.toMatchObject({
      name: "OrchestratorEventStoreWriteError",
      kind: "write-failed",
      filePath,
      eventId: "event_1"
    });
    await expect(store.flush()).rejects.toMatchObject({
      name: "OrchestratorEventStoreWriteError",
      kind: "write-failed",
      filePath,
      eventId: "event_1"
    });
  });

  it("serves empty-store reads without requiring prior appends", async () => {
    const filePath = join(await tempDir(tempDirs), "empty-events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);

    await expect(store.readAll()).resolves.toEqual([]);
    await expect(store.readSession("session_missing")).resolves.toEqual([]);
    await expect(store.readRun("run_missing")).resolves.toEqual([]);
    await expect(store.listSessionSummaries()).resolves.toEqual([]);
    await expect(store.getMetadata()).resolves.toMatchObject({
      eventLogId: expect.stringMatching(/^eventlog_/),
      generation: 1,
      schemaVersion: 1,
      protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION
    });

    const streamed: OrchestratorEvent[] = [];
    for await (const item of store.readAllStreaming()) {
      streamed.push(item);
    }
    expect(streamed).toEqual([]);

    await expect(store.bootstrapFromTail()).resolves.toBe(true);
    await expect(store.listSessionSummaries()).resolves.toEqual([]);
    expect(store.healthCheck()).toMatchObject({
      writable: true,
      indexSynced: true
    });
  });

  it("rejects invalid append payloads with typed invalid-event errors and stays writable", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);

    await expect(
      store.append({
        ...event({ id: "event_bad", sequence: 1, sessionId: "session_a" }),
        type: "not-a-real-type"
      } as unknown as OrchestratorEvent)
    ).rejects.toMatchObject({
      name: "OrchestratorEventStoreInvalidEventError",
      kind: "invalid-event",
      filePath,
      eventId: "event_bad"
    });

    await expect(
      store.append({
        ...event({ id: "", sequence: 1, sessionId: "session_a" })
      })
    ).rejects.toBeInstanceOf(OrchestratorEventStoreInvalidEventError);

    await expect(
      store.append({
        ...event({ id: "event_bad_seq", sequence: 0, sessionId: "session_a" })
      })
    ).rejects.toMatchObject({ kind: "invalid-event", eventId: "event_bad_seq" });

    await expect(
      store.append({
        ...event({ id: "event_bad_session", sequence: 1, sessionId: "   " })
      })
    ).rejects.toMatchObject({ kind: "invalid-event", eventId: "event_bad_session" });

    // Validation failures must not latch the store.
    const valid = event({ id: "event_ok", sequence: 1, sessionId: "session_a", runId: "run_a" });
    await store.append(valid);
    await expect(store.readAll()).resolves.toEqual([valid]);
    expect(store.healthCheck().writable).toBe(true);
  });

  it("enforces event id uniqueness across warm and cold appends", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);
    const first = event({ id: "event_unique", sequence: 1, sessionId: "session_a", runId: "run_a" });

    await store.append(first);
    await expect(
      store.append(event({ id: "event_unique", sequence: 2, sessionId: "session_a", runId: "run_a" }))
    ).rejects.toMatchObject({
      name: "OrchestratorEventStoreDuplicateIdError",
      kind: "duplicate-event-id",
      filePath,
      eventId: "event_unique"
    });
    await expect(store.readAll()).resolves.toEqual([first]);

    // Cold open still sees the durable id and rejects the duplicate without latching.
    const cold = new FileOrchestratorEventStore(filePath);
    await expect(
      cold.append(event({ id: "event_unique", sequence: 3, sessionId: "session_a", runId: "run_b" }))
    ).rejects.toBeInstanceOf(OrchestratorEventStoreDuplicateIdError);

    const second = event({ id: "event_other", sequence: 2, sessionId: "session_a", runId: "run_b" });
    await cold.append(second);
    await expect(cold.readAll()).resolves.toEqual([first, second]);
  });

  it("guards read APIs against invalid afterSequence, maxEvents, and empty ids", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);
    const first = event({ id: "event_1", sequence: 1, sessionId: "session_a", runId: "run_a" });
    const second = event({ id: "event_2", sequence: 2, sessionId: "session_a", runId: "run_a" });
    const third = event({ id: "event_3", sequence: 3, sessionId: "session_b", runId: "run_b" });
    await store.append(first);
    await store.append(second);
    await store.append(third);

    await expect(store.readAll(0, { maxEvents: 2 })).resolves.toEqual([first, second]);
    await expect(store.readAll(1, { maxEvents: 1 })).resolves.toEqual([second]);
    await expect(store.readAll(0, { maxEvents: 0 })).resolves.toEqual([]);
    await expect(store.readSession("session_a", 1)).resolves.toEqual([second]);
    await expect(store.readRun("run_a", 0, { maxEvents: 1 })).resolves.toEqual([first]);

    await expect(store.readAll(-1)).rejects.toBeInstanceOf(OrchestratorEventStoreInvalidReadError);
    await expect(store.readAll(1.5)).rejects.toMatchObject({ kind: "invalid-read" });
    await expect(store.readAll(0, { maxEvents: -1 })).rejects.toMatchObject({ kind: "invalid-read" });
    await expect(store.readAll(0, { maxEvents: 1.2 })).rejects.toMatchObject({ kind: "invalid-read" });
    await expect(store.readSession("")).rejects.toMatchObject({
      name: "OrchestratorEventStoreInvalidReadError",
      kind: "invalid-read"
    });
    await expect(store.readSession("   ")).rejects.toMatchObject({ kind: "invalid-read" });
    await expect(store.readRun("")).rejects.toMatchObject({ kind: "invalid-read" });
    await expect(store.readAllStreaming(-1).next()).rejects.toMatchObject({ kind: "invalid-read" });
  });

  it("does not latch the store after a rejected duplicate id", async () => {
    const filePath = join(await tempDir(tempDirs), "events.jsonl");
    const store = new FileOrchestratorEventStore(filePath);
    await store.append(event({ id: "event_1", sequence: 1, sessionId: "session_a", runId: "run_a" }));

    await expect(
      store.append(event({ id: "event_1", sequence: 2, sessionId: "session_a", runId: "run_a" }))
    ).rejects.toMatchObject({ kind: "duplicate-event-id" });

    const next = event({ id: "event_2", sequence: 2, sessionId: "session_a", runId: "run_a" });
    await store.append(next);
    await expect(store.readAll()).resolves.toEqual([
      event({ id: "event_1", sequence: 1, sessionId: "session_a", runId: "run_a" }),
      next
    ]);
    expect(store.healthCheck().writable).toBe(true);
  });
});

async function tempDir(tempDirs: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orchestrator-events-"));
  tempDirs.push(dir);
  return dir;
}

function event(
  input: Pick<OrchestratorEvent, "id" | "sequence" | "sessionId" | "runId"> &
    Partial<Pick<OrchestratorEvent, "type" | "payload">>
): OrchestratorEvent {
  return {
    protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
    id: input.id,
    sequence: input.sequence,
    type: input.type ?? "runtime-event",
    sessionId: input.sessionId,
    runId: input.runId,
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: input.payload ?? { ok: true }
  };
}
