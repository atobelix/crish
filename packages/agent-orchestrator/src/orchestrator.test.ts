import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentMessage, JsonObject } from "@crish/shared-types";
import {
  ORCHESTRATOR_PROTOCOL_VERSION,
  type OrchestratorEvent,
  type OrchestratorEventType,
  type OrchestratorRunRecord
} from "./types";
import { AgentOrchestrator, InMemoryOrchestratorEventStore } from "./orchestrator";

describe("AgentOrchestrator", () => {
  it("wraps runtime events in sequenced run events", async () => {
    const orchestrator = new AgentOrchestrator({
      createRunEngine: () => new FakeRunEngine([
        { type: "agent-start", sessionId: "session_a", timestamp: "2026-01-01T00:00:00.000Z" },
        { type: "agent-end", sessionId: "session_a", timestamp: "2026-01-01T00:00:01.000Z", reason: "stop" }
      ])
    });

    const handle = await orchestrator.startRun({ id: "run_a", sessionId: "session_a", cwd: "C:/tmp", input: "hello" });
    const events = await collect(handle.events);

    expect(events.map((event) => event.type)).toEqual(["run-queued", "run-started", "runtime-event", "runtime-event", "run-completed"]);
    expect(events.map((event) => event.sequence)).toEqual([2, 3, 4, 5, 6]);
    expect((events[0]?.payload.run as { status?: string } | undefined)?.status).toBe("queued");
    expect((events[1]?.payload.run as { status?: string } | undefined)?.status).toBe("running");
    expect(orchestrator.getRun("run_a")).toMatchObject({
      status: "completed",
      outcome: "completed",
      reason: "completed"
    });
    expect(events.at(-1)?.payload).toMatchObject({
      outcome: "completed",
      reason: "completed"
    });
    await expect(orchestrator.readRunEvents("run_a", 3)).resolves.toHaveLength(3);
  });

  it("fails a durable run when the event store append fails instead of advertising replayable history", async () => {
    const store = new RejectingEventStore(new Error("disk is read-only"));
    const orchestrator = new AgentOrchestrator({
      eventStore: store,
      createRunEngine: () =>
        new FakeRunEngine([
          { type: "agent-start", sessionId: "session_durable_failure", timestamp: "2026-01-01T00:00:00.000Z" },
          { type: "agent-end", sessionId: "session_durable_failure", timestamp: "2026-01-01T00:00:01.000Z", reason: "stop" }
        ])
    });

    const handle = await orchestrator.startRun({
      id: "run_durable_failure",
      sessionId: "session_durable_failure",
      cwd: "C:/tmp",
      input: "hello"
    });
    const events = await collect(handle.events);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "run-failed",
      runId: "run_durable_failure",
      payload: {
        reason: "event-store-write-failed",
        outcomeDetail: {
          kind: "event-store-write-failed",
          failedEventType: "run-queued"
        }
      }
    });
    expect(orchestrator.getRun("run_durable_failure")).toMatchObject({
      status: "failed",
      outcome: "failed",
      reason: "event-store-write-failed",
      error: "disk is read-only"
    });
    await expect(orchestrator.readRunEvents("run_durable_failure")).rejects.toThrow("disk is read-only");
  });

  it("marks a run as awaiting approval while runtime waits", async () => {
    let releaseApproval!: () => void;
    const approvalHold = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const orchestrator = new AgentOrchestrator({
      createRunEngine: () =>
        new GatedApprovalRunEngine(approvalHold, {
          sessionId: "session_b",
          request: {
            id: "approval_a",
            sessionId: "session_b",
            cwd: "C:/tmp",
            toolCallId: "approval_a",
            toolName: "write",
            parameters: {},
            summary: "mutate",
            toolMetadata: { category: "filesystem", isReadOnly: false }
          }
        })
    });

    const handle = await orchestrator.startRun({ id: "run_b", sessionId: "session_b", cwd: "C:/tmp", input: "hello" });
    const iterator = handle.events[Symbol.asyncIterator]();
    const statuses: string[] = [];

    // Drain through the approval-requested runtime event while the engine is held.
    while (true) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      const event = next.value!;
      if (event.type === "runtime-event") {
        statuses.push(orchestrator.getRun("run_b")?.status ?? "missing");
        break;
      }
    }

    expect(statuses).toEqual(["awaiting-approval"]);
    expect(orchestrator.getRun("run_b")).toMatchObject({
      status: "awaiting-approval",
      reason: "awaiting-approval"
    });

    releaseApproval();

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value!;
      if (event.type === "runtime-event") {
        statuses.push(orchestrator.getRun("run_b")?.status ?? "missing");
      }
    }

    expect(statuses).toEqual(["awaiting-approval", "running"]);
    expect(orchestrator.getRun("run_b")).toMatchObject({
      status: "completed",
      outcome: "completed"
    });
  });

  it("persists and restores daemon-owned pending input records", async () => {
    const store = new InMemoryOrchestratorEventStore();
    const orchestrator = new AgentOrchestrator({
      eventStore: store,
      createRunEngine: () => new FakeRunEngine([]),
      now: () => "2026-01-01T00:00:00.000Z",
      createId: (prefix) => `${prefix}_1`
    });
    await orchestrator.createSession({ id: "session_pending", cwd: "C:/tmp" });

    const queued = await orchestrator.enqueuePendingInput({
      id: "pending_1",
      sessionId: "session_pending",
      runId: "run_pending",
      text: " continue after current run ",
      mode: "after-current-run"
    });

    expect(queued.input).toMatchObject({
      id: "pending_1",
      sessionId: "session_pending",
      runId: "run_pending",
      text: "continue after current run",
      status: "pending"
    });
    expect(orchestrator.listPendingInputs("session_pending")).toHaveLength(1);

    const restored = new AgentOrchestrator({
      eventStore: store,
      createRunEngine: () => new FakeRunEngine([])
    });
    await restored.restoreFromEventStore();
    expect(restored.listPendingInputs("session_pending")).toEqual([queued.input]);

    await restored.cancelPendingInput({ id: "pending_1", sessionId: "session_pending", reason: "user-cancelled" });
    expect(restored.listPendingInputs("session_pending")).toEqual([]);
  });

  it("restores in-flight runs as interrupted terminal records with audit events", async () => {
    const store = new InMemoryOrchestratorEventStore();
    const queuedRun = runRecord({ id: "run_restore_queued", sessionId: "session_restore" });
    const runningRun = runRecord({ id: "run_restore_running", sessionId: "session_restore" });
    const approvalRun = runRecord({ id: "run_restore_approval", sessionId: "session_restore" });
    const cancellingRun = runRecord({ id: "run_restore_cancelling", sessionId: "session_restore" });
    const events = [
      storedEvent({
        id: "event_1",
        sequence: 1,
        type: "run-queued",
        sessionId: "session_restore",
        runId: queuedRun.id,
        payload: { run: queuedRun }
      }),
      storedEvent({
        id: "event_2",
        sequence: 2,
        type: "run-queued",
        sessionId: "session_restore",
        runId: runningRun.id,
        payload: { run: runningRun }
      }),
      storedEvent({
        id: "event_3",
        sequence: 3,
        type: "run-started",
        sessionId: "session_restore",
        runId: runningRun.id,
        payload: { run: { ...runningRun, status: "running", startedAt: "2026-01-01T00:00:01.000Z" } }
      }),
      storedEvent({
        id: "event_4",
        sequence: 4,
        type: "run-queued",
        sessionId: "session_restore",
        runId: approvalRun.id,
        payload: { run: approvalRun }
      }),
      storedEvent({
        id: "event_5",
        sequence: 5,
        type: "run-started",
        sessionId: "session_restore",
        runId: approvalRun.id,
        payload: { run: { ...approvalRun, status: "running", startedAt: "2026-01-01T00:00:01.000Z" } }
      }),
      storedEvent({
        id: "event_6",
        sequence: 6,
        type: "runtime-event",
        sessionId: "session_restore",
        runId: approvalRun.id,
        payload: {
          event: {
            type: "approval-requested",
            sessionId: "session_restore",
            timestamp: "2026-01-01T00:00:02.000Z",
            request: {
              id: "approval_restore",
              sessionId: "session_restore",
              cwd: "C:/tmp",
              tool: { name: "write_file", label: "Write file" },
              input: { path: "file.txt" },
              summary: "mutate"
            }
          }
        }
      }),
      storedEvent({
        id: "event_7",
        sequence: 7,
        type: "run-queued",
        sessionId: "session_restore",
        runId: cancellingRun.id,
        payload: { run: cancellingRun }
      }),
      storedEvent({
        id: "event_8",
        sequence: 8,
        type: "run-started",
        sessionId: "session_restore",
        runId: cancellingRun.id,
        payload: { run: { ...cancellingRun, status: "running", startedAt: "2026-01-01T00:00:01.000Z" } }
      }),
      storedEvent({
        id: "event_9",
        sequence: 9,
        type: "run-cancel-requested",
        sessionId: "session_restore",
        runId: cancellingRun.id,
        payload: { reason: "daemon-shutdown" }
      })
    ];
    for (const event of events) store.append(event);

    let nextId = 0;
    const orchestrator = new AgentOrchestrator({
      eventStore: store,
      createRunEngine: () => new FakeRunEngine([]),
      now: () => "2026-01-01T00:10:00.000Z",
      createId: (prefix) => `${prefix}_restore_${++nextId}`
    });

    await orchestrator.restoreFromEventStore();

    expect(orchestrator.listRuns().filter((run) => isActiveStatus(run.status))).toEqual([]);
    expect(orchestrator.getRun(queuedRun.id)).toMatchObject({
      status: "failed",
      outcome: "failed",
      reason: "daemon-restarted",
      error: "Run was interrupted by daemon restart.",
      outcomeDetail: {
        kind: "interrupted",
        reason: "daemon-restarted",
        previousStatus: "queued"
      }
    });
    expect(orchestrator.getRun(runningRun.id)).toMatchObject({
      status: "failed",
      outcome: "failed",
      reason: "daemon-restarted",
      error: "Run was interrupted by daemon restart.",
      outcomeDetail: {
        kind: "interrupted",
        reason: "daemon-restarted",
        previousStatus: "running"
      }
    });
    expect(orchestrator.getRun(approvalRun.id)).toMatchObject({
      status: "failed",
      outcome: "failed",
      reason: "daemon-restarted",
      error: "Run was interrupted by daemon restart.",
      outcomeDetail: {
        kind: "interrupted",
        reason: "daemon-restarted",
        previousStatus: "awaiting-approval",
        previousReason: "awaiting-approval",
        previousOutcomeDetail: {
          id: "approval_restore",
          summary: "mutate"
        }
      }
    });
    expect(orchestrator.getRun(cancellingRun.id)).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      reason: "daemon-restarted",
      error: "Run cancellation was interrupted by daemon restart.",
      outcomeDetail: {
        kind: "interrupted",
        reason: "daemon-restarted",
        previousStatus: "cancelling"
      }
    });

    await expect(orchestrator.readRunEvents(queuedRun.id)).resolves.toMatchObject([
      { type: "run-queued" },
      {
        type: "run-failed",
        payload: {
          reason: "daemon-restarted",
          outcomeDetail: { previousStatus: "queued" }
        }
      }
    ]);
    await expect(orchestrator.readRunEvents(runningRun.id)).resolves.toMatchObject([
      { type: "run-queued" },
      { type: "run-started" },
      {
        type: "run-failed",
        payload: {
          reason: "daemon-restarted",
          outcomeDetail: { previousStatus: "running" }
        }
      }
    ]);
    await expect(orchestrator.readRunEvents(approvalRun.id)).resolves.toMatchObject([
      { type: "run-queued" },
      { type: "run-started" },
      { type: "runtime-event" },
      {
        type: "run-failed",
        payload: {
          reason: "daemon-restarted",
          outcomeDetail: { previousStatus: "awaiting-approval" }
        }
      }
    ]);
    await expect(orchestrator.readRunEvents(cancellingRun.id)).resolves.toMatchObject([
      { type: "run-queued" },
      { type: "run-started" },
      { type: "run-cancel-requested" },
      {
        type: "run-cancelled",
        payload: {
          reason: "daemon-restarted",
          outcomeDetail: { previousStatus: "cancelling" }
        }
      }
    ]);
  });

  it("preserves blocked outcome and reason while restoring terminal records", async () => {
    const store = new InMemoryOrchestratorEventStore();
    const run = runRecord({
      id: "run_restore_blocked",
      sessionId: "session_restore_blocked",
      status: "failed",
      outcome: "blocked",
      reason: "goal-blocked",
      outcomeDetail: { action: "block", reason: "Need user input" },
      error: "Need user input",
      kind: "goal",
      goal: {
        status: "blocked",
        visibleGoal: "ship",
        maxRounds: 3,
        maxStalledRounds: 1,
        currentRound: 0,
        completedRounds: 1,
        stalledRounds: 0,
        stoppedReason: "blocked"
      }
    });
    store.append(
      storedEvent({
        id: "event_blocked_1",
        sequence: 1,
        type: "run-failed",
        sessionId: run.sessionId,
        runId: run.id,
        payload: {
          run,
          outcome: "blocked",
          reason: "goal-blocked",
          outcomeDetail: { action: "block", reason: "Need user input" },
          error: "Need user input"
        }
      })
    );

    const orchestrator = new AgentOrchestrator({
      eventStore: store,
      createRunEngine: () => new FakeRunEngine([]),
      now: () => "2026-01-01T00:10:00.000Z",
      createId: (prefix) => `${prefix}_unused`
    });

    await orchestrator.restoreFromEventStore();

    expect(orchestrator.getRun(run.id)).toMatchObject({
      status: "failed",
      outcome: "blocked",
      reason: "goal-blocked",
      outcomeDetail: { action: "block", reason: "Need user input" },
      error: "Need user input",
      goal: {
        status: "blocked",
        stoppedReason: "blocked"
      }
    });
    await expect(orchestrator.readRunEvents(run.id)).resolves.toHaveLength(1);
  });

  it("preserves completed failed and cancelled records while restoring terminal history", async () => {
    const store = new InMemoryOrchestratorEventStore();
    const completedRun = runRecord({
      id: "run_restore_completed",
      sessionId: "session_restore_terminal",
      status: "completed",
      outcome: "completed",
      reason: "completed",
      finishedAt: "2026-01-01T00:00:02.000Z"
    });
    const failedRun = runRecord({
      id: "run_restore_failed",
      sessionId: "session_restore_terminal",
      status: "failed",
      outcome: "failed",
      reason: "runtime-error",
      error: "runtime failed",
      finishedAt: "2026-01-01T00:00:03.000Z"
    });
    const cancelledRun = runRecord({
      id: "run_restore_cancelled",
      sessionId: "session_restore_terminal",
      status: "cancelled",
      outcome: "cancelled",
      reason: "aborted",
      error: "aborted by user",
      finishedAt: "2026-01-01T00:00:04.000Z"
    });
    const terminalEvents = [
      storedEvent({
        id: "event_terminal_1",
        sequence: 1,
        type: "run-completed",
        sessionId: completedRun.sessionId,
        runId: completedRun.id,
        payload: { run: completedRun, outcome: "completed", reason: "completed" }
      }),
      storedEvent({
        id: "event_terminal_2",
        sequence: 2,
        type: "run-failed",
        sessionId: failedRun.sessionId,
        runId: failedRun.id,
        payload: { run: failedRun, outcome: "failed", reason: "runtime-error", error: "runtime failed" }
      }),
      storedEvent({
        id: "event_terminal_3",
        sequence: 3,
        type: "run-cancelled",
        sessionId: cancelledRun.sessionId,
        runId: cancelledRun.id,
        payload: { run: cancelledRun, outcome: "cancelled", reason: "aborted", error: "aborted by user" }
      })
    ];
    for (const event of terminalEvents) store.append(event);

    const orchestrator = new AgentOrchestrator({
      eventStore: store,
      createRunEngine: () => new FakeRunEngine([]),
      now: () => "2026-01-01T00:10:00.000Z",
      createId: (prefix) => `${prefix}_unused`
    });

    await orchestrator.restoreFromEventStore();

    expect(orchestrator.getRun(completedRun.id)).toMatchObject({
      status: "completed",
      outcome: "completed",
      reason: "completed",
      finishedAt: "2026-01-01T00:00:02.000Z"
    });
    expect(orchestrator.getRun(failedRun.id)).toMatchObject({
      status: "failed",
      outcome: "failed",
      reason: "runtime-error",
      error: "runtime failed",
      finishedAt: "2026-01-01T00:00:03.000Z"
    });
    expect(orchestrator.getRun(cancelledRun.id)).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      reason: "aborted",
      error: "aborted by user",
      finishedAt: "2026-01-01T00:00:04.000Z"
    });
    await expect(orchestrator.readSessionEvents("session_restore_terminal")).resolves.toHaveLength(3);
    await expect(orchestrator.readRunEvents(completedRun.id)).resolves.toEqual([terminalEvents[0]]);
    await expect(orchestrator.readRunEvents(failedRun.id)).resolves.toEqual([terminalEvents[1]]);
    await expect(orchestrator.readRunEvents(cancelledRun.id)).resolves.toEqual([terminalEvents[2]]);
  });

  it("moves the active session leaf through a durable session event", async () => {
    const store = new InMemoryOrchestratorEventStore();
    let nextId = 0;
    const orchestrator = new AgentOrchestrator({
      eventStore: store,
      createRunEngine: () => new FakeRunEngine([]),
      now: () => "2026-01-01T00:00:00.000Z",
      createId: (prefix) => `${prefix}_leaf_${++nextId}`
    });
    await orchestrator.createSession({ id: "session_leaf", cwd: "C:/tmp" });

    const moved = await orchestrator.moveSessionLeaf({
      sessionId: "session_leaf",
      targetLeafId: "leaf_target",
      reason: "conversation-rewind",
      metadata: { boundaryId: "boundary_1" }
    });

    expect(moved).toMatchObject({
      changed: true,
      fromLeafId: null,
      toLeafId: "leaf_target",
      event: {
        type: "session-leaf-moved",
        payload: {
          fromLeafId: null,
          toLeafId: "leaf_target",
          reason: "conversation-rewind",
          metadata: { boundaryId: "boundary_1" }
        }
      }
    });
    expect(orchestrator.getSession("session_leaf")).toMatchObject({
      currentLeafId: "leaf_target"
    });

    const restored = new AgentOrchestrator({
      eventStore: store,
      createRunEngine: () => new FakeRunEngine([]),
      now: () => "2026-01-01T00:10:00.000Z"
    });
    await restored.restoreFromEventStore();

    expect(restored.getSession("session_leaf")).toMatchObject({
      currentLeafId: "leaf_target"
    });
  });

  it("does not move a session leaf when the durable leaf event fails to persist", async () => {
    const store = new RejectingEventStore(new Error("disk is read-only"));
    const orchestrator = new AgentOrchestrator({
      eventStore: store,
      createRunEngine: () => new FakeRunEngine([])
    });
    await orchestrator.createSession({ id: "session_leaf_failure", cwd: "C:/tmp" });

    await expect(
      orchestrator.moveSessionLeaf({
        sessionId: "session_leaf_failure",
        targetLeafId: "leaf_target",
        reason: "conversation-rewind"
      })
    ).rejects.toThrow("disk is read-only");
    expect(orchestrator.getSession("session_leaf_failure")?.currentLeafId).toBeUndefined();
  });

  it("aborts active runs through the registered run engine", async () => {
    const engine = new BlockingRunEngine();
    const orchestrator = new AgentOrchestrator({
      createRunEngine: () => engine
    });

    expect(orchestrator.steerRun("missing", "hello")).toBe(false);
    expect(orchestrator.isRunActive("missing")).toBe(false);

    const handle = await orchestrator.startRun({ id: "run_c", sessionId: "session_c", cwd: "C:/tmp", input: "hello" });
    const iterator = handle.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();

    expect(orchestrator.isRunActive("run_c")).toBe(true);
    expect(orchestrator.steerRun("run_c", "nudge")).toBe(true);
    expect(engine.steered).toHaveLength(1);
    expect(engine.steered[0]?.blocks?.[0]).toMatchObject({ type: "text", text: "nudge" });

    expect(orchestrator.cancelRun("run_c")).toBe(true);
    engine.release();

    const rest = await drain(iterator);
    expect(engine.abortReason).toBe("cancelled-by-user");
    expect(rest.map((event) => event.type)).toContain("run-cancel-requested");
    expect(orchestrator.getRun("run_c")).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      reason: "aborted"
    });
  });

  it("marks max-turns agent endings as failed instead of completed", async () => {
    const orchestrator = new AgentOrchestrator({
      createRunEngine: () =>
        new FakeRunEngine([
          { type: "agent-start", sessionId: "session_d", timestamp: "2026-01-01T00:00:00.000Z" },
          { type: "agent-end", sessionId: "session_d", timestamp: "2026-01-01T00:00:01.000Z", reason: "max-turns" }
        ])
    });

    const handle = await orchestrator.startRun({ id: "run_d", sessionId: "session_d", cwd: "C:/tmp", input: "hello" });
    const events = await collect(handle.events);

    expect(events.map((event) => event.type)).toEqual(["run-queued", "run-started", "runtime-event", "runtime-event", "run-failed"]);
    expect(orchestrator.getRun("run_d")).toMatchObject({
      status: "failed",
      outcome: "failed",
      reason: "max-turns",
      error: "Run reached the maximum turn limit"
    });
    expect(events.at(-1)?.payload).toMatchObject({
      outcome: "failed",
      reason: "max-turns",
      error: "Run reached the maximum turn limit"
    });
  });

  it("marks runtime errors as failed and preserves provider detail", async () => {
    const orchestrator = new AgentOrchestrator({
      createRunEngine: () =>
        new FakeRunEngine([
          {
            type: "provider-diagnostic",
            sessionId: "session_e",
            timestamp: "2026-01-01T00:00:00.000Z",
            diagnostic: {
              phase: "response-start",
              providerId: "test-provider",
              status: 429,
              errorKind: "quota"
            }
          },
          {
            type: "runtime-error",
            sessionId: "session_e",
            timestamp: "2026-01-01T00:00:01.000Z",
            error: "quota exceeded"
          },
          {
            type: "agent-end",
            sessionId: "session_e",
            timestamp: "2026-01-01T00:00:02.000Z",
            reason: "error",
            error: "quota exceeded"
          }
        ])
    });

    const handle = await orchestrator.startRun({ id: "run_e", sessionId: "session_e", cwd: "C:/tmp", input: "hello" });
    const events = await collect(handle.events);

    expect(events.map((event) => event.type)).toEqual([
      "run-queued",
      "run-started",
      "runtime-event",
      "runtime-event",
      "runtime-event",
      "run-failed"
    ]);
    expect(orchestrator.getRun("run_e")).toMatchObject({
      status: "failed",
      outcome: "failed",
      reason: "provider-error",
      error: "quota exceeded",
      outcomeDetail: {
        providerDiagnostic: {
          status: 429,
          errorKind: "quota"
        }
      }
    });
    expect(events.at(-1)?.payload).toMatchObject({
      outcome: "failed",
      reason: "provider-error",
      error: "quota exceeded"
    });
  });

  it("continues goal runs across runtime engines and completes from a continuation decision", async () => {
    const inputs: Array<string | AgentMessage> = [];
    const roundEvents: AgentEvent[][] = [
      [
        { type: "agent-start", sessionId: "session_goal", timestamp: "2026-01-01T00:00:00.000Z" },
        goalDecisionToolEnd({
          action: "continue",
          reason: "Need a verification round",
          prompt: "verify the result",
          progressSignature: "round-a"
        }),
        { type: "agent-end", sessionId: "session_goal", timestamp: "2026-01-01T00:00:01.000Z", reason: "stop" }
      ],
      [
        { type: "agent-start", sessionId: "session_goal", timestamp: "2026-01-01T00:00:02.000Z" },
        goalDecisionToolEnd({
          action: "complete",
          reason: "Goal is verified",
          progressSignature: "round-b"
        }),
        { type: "agent-end", sessionId: "session_goal", timestamp: "2026-01-01T00:00:03.000Z", reason: "stop" }
      ]
    ];
    const orchestrator = new AgentOrchestrator({
      createRunEngine: () =>
        new RecordingRunEngine(roundEvents.shift() ?? [], (input) => {
          inputs.push(input);
        })
    });

    const handle = await orchestrator.startGoalRun({
      id: "run_goal",
      sessionId: "session_goal",
      cwd: "C:/tmp",
      input: "ship the feature",
      goal: { maxRounds: 3 }
    });
    const events = await collect(handle.events);

    expect(inputs).toEqual(["ship the feature", "verify the result"]);
    expect(events.map((event) => event.type)).toEqual([
      "run-queued",
      "run-started",
      "goal-round-started",
      "runtime-event",
      "runtime-event",
      "runtime-event",
      "goal-round-completed",
      "goal-continuation-decided",
      "goal-round-started",
      "runtime-event",
      "runtime-event",
      "runtime-event",
      "goal-round-completed",
      "goal-continuation-decided",
      "run-completed"
    ]);
    expect(orchestrator.getRun("run_goal")).toMatchObject({
      kind: "goal",
      status: "completed",
      outcome: "completed",
      reason: "goal-completed",
      goal: {
        status: "completed",
        completedRounds: 2,
        stoppedReason: "complete",
        lastDecision: {
          action: "complete",
          reason: "Goal is verified"
        }
      }
    });
    const decisions = events.filter((event) => event.type === "goal-continuation-decided");
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.payload).toMatchObject({
      decision: {
        action: "continue",
        reason: "Need a verification round"
      },
      assessment: {
        state: "needs-continuation",
        explicitDecisionSource: "tool-output"
      }
    });
    expect(decisions[1]?.payload).toMatchObject({
      decision: {
        action: "complete",
        reason: "Goal is verified"
      },
      assessment: {
        state: "completed",
        explicitDecisionSource: "tool-output"
      }
    });
  });

  it("blocks goal runs that stop without typed progress or continuation", async () => {
    const orchestrator = new AgentOrchestrator({
      createRunEngine: () =>
        new FakeRunEngine([
          { type: "agent-start", sessionId: "session_no_progress", timestamp: "2026-01-01T00:00:00.000Z" },
          {
            type: "message-end",
            sessionId: "session_no_progress",
            message: {
              id: "message_no_progress",
              role: "assistant",
              createdAt: "2026-01-01T00:00:00.500Z",
              blocks: [{ type: "text", text: "I am done." }]
            }
          },
          { type: "agent-end", sessionId: "session_no_progress", timestamp: "2026-01-01T00:00:01.000Z", reason: "stop" }
        ])
    });

    const handle = await orchestrator.startGoalRun({
      id: "run_no_progress",
      sessionId: "session_no_progress",
      cwd: "C:/tmp",
      input: "finish a task",
      goal: { maxRounds: 3 }
    });
    const events = await collect(handle.events);
    const decision = events.find((event) => event.type === "goal-continuation-decided");

    expect(decision?.payload).toMatchObject({
      decision: {
        action: "block",
        reason: "Goal round ended without observable progress or a typed continuation decision."
      },
      assessment: {
        state: "no-progress",
        progress: {
          observed: false,
          signature: "no-progress"
        }
      }
    });
    expect(events.at(-1)?.type).toBe("run-failed");
    expect(orchestrator.getRun("run_no_progress")).toMatchObject({
      status: "failed",
      outcome: "blocked",
      reason: "goal-blocked",
      goal: {
        status: "blocked",
        completedRounds: 1,
        stoppedReason: "blocked"
      }
    });
  });

  it("blocks goal runs when continuation would exceed the round budget", async () => {
    const orchestrator = new AgentOrchestrator({
      createRunEngine: () =>
        new FakeRunEngine([
          { type: "agent-start", sessionId: "session_budget", timestamp: "2026-01-01T00:00:00.000Z" },
          goalDecisionToolEnd({
            action: "continue",
            reason: "More work remains",
            prompt: "continue",
            progressSignature: "same"
          }),
          { type: "agent-end", sessionId: "session_budget", timestamp: "2026-01-01T00:00:01.000Z", reason: "stop" }
        ])
    });

    const handle = await orchestrator.startGoalRun({
      id: "run_budget",
      sessionId: "session_budget",
      cwd: "C:/tmp",
      input: "long task",
      goal: { maxRounds: 1 }
    });
    const events = await collect(handle.events);

    expect(events.at(-1)?.type).toBe("run-failed");
    expect(orchestrator.getRun("run_budget")).toMatchObject({
      status: "failed",
      outcome: "blocked",
      reason: "goal-max-rounds",
      goal: {
        status: "blocked",
        completedRounds: 1,
        stoppedReason: "max-rounds"
      }
    });
  });

  it("keeps max-turns inside goal runs as a failed outcome", async () => {
    const orchestrator = new AgentOrchestrator({
      createRunEngine: () =>
        new FakeRunEngine([
          { type: "agent-start", sessionId: "session_max", timestamp: "2026-01-01T00:00:00.000Z" },
          { type: "agent-end", sessionId: "session_max", timestamp: "2026-01-01T00:00:01.000Z", reason: "max-turns" }
        ])
    });

    const handle = await orchestrator.startGoalRun({
      id: "run_max",
      sessionId: "session_max",
      cwd: "C:/tmp",
      input: "long task",
      goal: { maxRounds: 3 }
    });
    const events = await collect(handle.events);

    expect(events.at(-1)?.type).toBe("run-failed");
    expect(orchestrator.getRun("run_max")).toMatchObject({
      status: "failed",
      outcome: "failed",
      reason: "max-turns",
      goal: {
        status: "failed",
        stoppedReason: "error"
      }
    });
  });

  it("keeps provider errors inside goal runs as failed outcomes without continuation", async () => {
    const orchestrator = new AgentOrchestrator({
      createRunEngine: () =>
        new FakeRunEngine([
          {
            type: "provider-diagnostic",
            sessionId: "session_goal_provider",
            timestamp: "2026-01-01T00:00:00.000Z",
            diagnostic: {
              phase: "response-start",
              providerId: "test-provider",
              status: 500,
              errorKind: "server"
            }
          },
          {
            type: "runtime-error",
            sessionId: "session_goal_provider",
            timestamp: "2026-01-01T00:00:01.000Z",
            error: "provider failed"
          }
        ])
    });

    const handle = await orchestrator.startGoalRun({
      id: "run_goal_provider",
      sessionId: "session_goal_provider",
      cwd: "C:/tmp",
      input: "long task",
      goal: { maxRounds: 3 }
    });
    const events = await collect(handle.events);

    expect(events.map((event) => event.type)).not.toContain("goal-continuation-decided");
    expect(events.at(-1)?.type).toBe("run-failed");
    expect(orchestrator.getRun("run_goal_provider")).toMatchObject({
      status: "failed",
      outcome: "failed",
      reason: "provider-error",
      error: "provider failed",
      goal: {
        status: "failed",
        stoppedReason: "error"
      }
    });
  });

  it("keeps runtime errors inside goal runs as failed outcomes without continuation", async () => {
    const orchestrator = new AgentOrchestrator({
      createRunEngine: () =>
        new FakeRunEngine([
          {
            type: "runtime-error",
            sessionId: "session_goal_runtime",
            timestamp: "2026-01-01T00:00:01.000Z",
            error: "runtime failed"
          }
        ])
    });

    const handle = await orchestrator.startGoalRun({
      id: "run_goal_runtime",
      sessionId: "session_goal_runtime",
      cwd: "C:/tmp",
      input: "long task",
      goal: { maxRounds: 3 }
    });
    const events = await collect(handle.events);

    expect(events.map((event) => event.type)).not.toContain("goal-continuation-decided");
    expect(events.at(-1)?.type).toBe("run-failed");
    expect(orchestrator.getRun("run_goal_runtime")).toMatchObject({
      status: "failed",
      outcome: "failed",
      reason: "runtime-error",
      error: "runtime failed",
      goal: {
        status: "failed",
        stoppedReason: "error"
      }
    });
  });

  it("blocks stalled goal runs after repeated progress signatures", async () => {
    const roundEvents: AgentEvent[][] = [
      [
        { type: "agent-start", sessionId: "session_stalled", timestamp: "2026-01-01T00:00:00.000Z" },
        goalDecisionToolEnd({
          action: "continue",
          reason: "Need another pass",
          prompt: "continue",
          progressSignature: "same-progress"
        }),
        { type: "agent-end", sessionId: "session_stalled", timestamp: "2026-01-01T00:00:01.000Z", reason: "stop" }
      ],
      [
        { type: "agent-start", sessionId: "session_stalled", timestamp: "2026-01-01T00:00:02.000Z" },
        goalDecisionToolEnd({
          action: "continue",
          reason: "Still trying",
          prompt: "continue",
          progressSignature: "same-progress"
        }),
        { type: "agent-end", sessionId: "session_stalled", timestamp: "2026-01-01T00:00:03.000Z", reason: "stop" }
      ]
    ];
    const orchestrator = new AgentOrchestrator({
      createRunEngine: () => new FakeRunEngine(roundEvents.shift() ?? [])
    });

    const handle = await orchestrator.startGoalRun({
      id: "run_stalled",
      sessionId: "session_stalled",
      cwd: "C:/tmp",
      input: "keep working",
      goal: { maxRounds: 5, maxStalledRounds: 1 }
    });
    const events = await collect(handle.events);

    expect(events.filter((event) => event.type === "goal-continuation-decided")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("run-failed");
    expect(orchestrator.getRun("run_stalled")).toMatchObject({
      status: "failed",
      outcome: "blocked",
      reason: "goal-stalled",
      goal: {
        status: "blocked",
        stoppedReason: "stalled",
        stalledRounds: 1,
        lastProgressSignature: "same-progress"
      }
    });
  });

  it("cancels active goal runs through the current round engine", async () => {
    const engine = new BlockingRunEngine();
    const orchestrator = new AgentOrchestrator({
      createRunEngine: () => engine
    });

    const handle = await orchestrator.startGoalRun({
      id: "run_cancel_goal",
      sessionId: "session_cancel_goal",
      cwd: "C:/tmp",
      input: "keep working",
      goal: { maxRounds: 3 }
    });
    const iterator = handle.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await iterator.next();

    expect(orchestrator.cancelRun("run_cancel_goal")).toBe(true);
    engine.release();

    const rest = await drain(iterator);
    expect(engine.abortReason).toBe("cancelled-by-user");
    expect(rest.map((event) => event.type)).toContain("run-cancel-requested");
    expect(orchestrator.getRun("run_cancel_goal")).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      reason: "aborted",
      goal: {
        status: "cancelled",
        stoppedReason: "cancelled"
      }
    });
  });
});

class FakeRunEngine {
  constructor(private readonly events: AgentEvent[]) {}

  async *run(_input?: string | AgentMessage): AsyncIterable<AgentEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  abort(): void {}

  enqueueSteerInput(_message: AgentMessage): void {}
}

/** Emits approval-requested, waits for a gate, then approval-resolved — for intermediate status assertions. */
class GatedApprovalRunEngine {
  constructor(
    private readonly hold: Promise<void>,
    private readonly approval: {
      sessionId: string;
      request: Extract<AgentEvent, { type: "approval-requested" }>["request"];
    }
  ) {}

  async *run(_input?: string | AgentMessage): AsyncIterable<AgentEvent> {
    yield {
      type: "approval-requested",
      sessionId: this.approval.sessionId,
      timestamp: "2026-01-01T00:00:00.000Z",
      request: this.approval.request
    };
    await this.hold;
    yield {
      type: "approval-resolved",
      sessionId: this.approval.sessionId,
      timestamp: "2026-01-01T00:00:01.000Z",
      requestId: this.approval.request.id,
      decision: { behavior: "allow" }
    };
  }

  abort(): void {}

  enqueueSteerInput(_message: AgentMessage): void {}
}

class RecordingRunEngine extends FakeRunEngine {
  constructor(events: AgentEvent[], private readonly onInput: (input: string | AgentMessage) => void) {
    super(events);
  }

  override async *run(input: string | AgentMessage): AsyncIterable<AgentEvent> {
    this.onInput(input);
    yield* super.run();
  }
}

class BlockingRunEngine {
  abortReason?: string;
  steered: AgentMessage[] = [];
  private releaseRun!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  async *run(): AsyncIterable<AgentEvent> {
    await this.released;
    yield { type: "agent-end", sessionId: "session_c", timestamp: "2026-01-01T00:00:01.000Z", reason: "aborted" };
  }

  abort(reason?: string): void {
    this.abortReason = reason;
  }

  enqueueSteerInput(message: AgentMessage): void {
    this.steered.push(message);
  }

  release(): void {
    this.releaseRun();
  }
}

class RejectingEventStore {
  private remainingAllowedAppends: number;

  /**
   * @param allowAppends Number of successful appends before rejecting.
   *   Default 1 so session-created can persist while later run/leaf events fail.
   */
  constructor(
    private readonly error: Error,
    allowAppends = 1
  ) {
    this.remainingAllowedAppends = allowAppends;
  }

  append(): Promise<void> {
    if (this.remainingAllowedAppends > 0) {
      this.remainingAllowedAppends -= 1;
      return Promise.resolve();
    }
    return Promise.reject(this.error);
  }

  readSession(): Promise<OrchestratorEvent[]> {
    return Promise.reject(this.error);
  }

  readRun(): Promise<OrchestratorEvent[]> {
    return Promise.reject(this.error);
  }
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function drain<T>(iterator: AsyncIterator<T>): Promise<T[]> {
  const collected: T[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return collected;
    collected.push(next.value);
  }
}

function runRecord(overrides: Partial<OrchestratorRunRecord>): OrchestratorRunRecord {
  return {
    id: "run_restore",
    sessionId: "session_restore",
    cwd: "C:/tmp",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function storedEvent(input: {
  id: string;
  sequence: number;
  type: OrchestratorEventType;
  sessionId: string;
  runId?: string;
  payload: Record<string, unknown>;
}): OrchestratorEvent {
  return {
    protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
    id: input.id,
    sequence: input.sequence,
    type: input.type,
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: input.payload as OrchestratorEvent["payload"]
  };
}

function isActiveStatus(status: OrchestratorRunRecord["status"]): boolean {
  return status === "queued" || status === "running" || status === "awaiting-approval" || status === "cancelling";
}

function fakeTool() {
  return {
    name: "write_file",
    label: "Write file",
    description: "Write a file",
    category: "filesystem" as const,
    concurrency: "exclusive" as const,
    isReadOnly: () => false,
    summarize: () => "mutate",
    execute: async () => ({ text: "ok" })
  };
}

function goalDecisionToolEnd(decision: {
  action: "continue" | "complete" | "block";
  reason: string;
  prompt?: string;
  progressSignature?: string;
}): AgentEvent {
  return {
    type: "tool-end",
    sessionId: "session_goal",
    batchId: "batch_goal",
    timestamp: "2026-01-01T00:00:00.500Z",
    result: {
      id: "tool_goal",
      toolName: "goal_status",
      durationMs: 1,
      isError: false,
      output: {
        text: decision.reason,
        json: {
          continuation: decision
        }
      }
    }
  };
}
