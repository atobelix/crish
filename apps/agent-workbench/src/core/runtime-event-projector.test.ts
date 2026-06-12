import { describe, expect, it } from "vitest";
import {
  classifyRuntimeDiagnosticContent,
  createRuntimeEventProjectionState,
  flushRuntimeProjectionDrafts,
  mapAgentEndReasonToRunStatus,
  materializeRuntimeProjectionMessages,
  materializeRuntimeTimelineItems,
  projectDaemonOrchestratorEvent,
  projectDaemonOrchestratorEvents,
  projectRuntimeEvent,
  timelineItemsFromRuntimeProjectionMessages,
} from "./runtime-event-projector";
import type { DaemonOrchestratorEvent } from "../shared/workbench-contract";

describe("runtime event projector", () => {
  it("accumulates incremental message text into a draft", () => {
    const state = createRuntimeEventProjectionState();

    projectRuntimeEvent(
      state,
      { type: "message-delta", messageId: "msg-1", block: { type: "text", text: "hello " } },
      { eventId: "event-1", runId: "run-1", sessionId: "session-1", timestamp: "2026-06-08T00:00:00.000Z" }
    );
    projectRuntimeEvent(
      state,
      { type: "message-delta", messageId: "msg-1", block: { type: "text", text: "world" } },
      { eventId: "event-2", runId: "run-1", sessionId: "session-1", timestamp: "2026-06-08T00:00:01.000Z" }
    );

    expect(state.drafts["msg-1"]).toMatchObject({
      id: "daemon-draft-msg-1",
      content: "hello world",
      streaming: true,
      runId: "run-1",
      sessionId: "session-1",
    });

    flushRuntimeProjectionDrafts(state);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toBe("hello world");
  });

  it("tracks tool call lifecycle and progress updates", () => {
    const state = createRuntimeEventProjectionState();

    projectRuntimeEvent(
      state,
      { type: "message-delta", messageId: "msg-1", block: { type: "tool-call", id: "tool-1", toolName: "edit", input: { path: "a.ts" } } },
      { runId: "run-1", sessionId: "session-1", timestamp: "2026-06-08T00:00:00.000Z" }
    );
    projectRuntimeEvent(
      state,
      { type: "tool-start", call: { id: "tool-1", toolName: "edit", input: { path: "a.ts" } } },
      { runId: "run-1", sessionId: "session-1", timestamp: "2026-06-08T00:00:01.000Z" }
    );
    projectRuntimeEvent(
      state,
      { type: "tool-update", toolCallId: "tool-1", update: { text: "halfway" } },
      { runId: "run-1", sessionId: "session-1", timestamp: "2026-06-08T00:00:02.000Z" }
    );
    projectRuntimeEvent(
      state,
      { type: "tool-end", result: { id: "tool-1", toolName: "edit", output: { text: "done" }, isError: false } },
      { runId: "run-1", sessionId: "session-1", timestamp: "2026-06-08T00:00:03.000Z" }
    );

    expect(state.drafts["msg-1"]?.toolCalls?.[0]).toMatchObject({
      id: "tool-1",
      name: "edit",
      status: "completed",
      output: "done",
    });
  });

  it("normalizes approval ids from request and resolved event shapes", () => {
    const state = createRuntimeEventProjectionState();

    const requested = projectRuntimeEvent(
      state,
      {
        type: "approval-requested",
        request: {
          id: "request-1",
          toolCallId: "approval-1",
          tool: { name: "write_file" },
          input: { path: "a.ts" },
        },
      },
      { runId: "run-1", sessionId: "session-1", timestamp: "2026-06-08T00:00:00.000Z" }
    );
    const resolved = projectRuntimeEvent(
      state,
      { type: "approval-resolved", requestId: "approval-1", decision: "deny" },
      { runId: "run-1", sessionId: "session-1", timestamp: "2026-06-08T00:00:01.000Z" }
    );

    expect(requested.approvals[0]).toMatchObject({ id: "approval-1", status: "requested" });
    expect(resolved.approvals[0]).toMatchObject({ id: "approval-1", status: "resolved" });
    expect(state.messages[0]?.toolCalls?.[0]).toMatchObject({
      id: "approval-1",
      name: "write_file",
      status: "denied",
    });
  });

  it("preserves backend destructive approval metadata on projected tool calls", () => {
    const state = createRuntimeEventProjectionState();

    const requested = projectRuntimeEvent(
      state,
      {
        type: "approval-requested",
        request: {
          id: "approval-critical",
          toolName: "shell_command",
          input: { command: "Remove-Item -Recurse C:/tmp/build-output" },
          summary: "Delete build output",
          metadata: {
            risk: "destructive",
            severity: "critical",
            matched: "Remove-Item -Recurse",
            confirmation: "double",
            requiresDoubleConfirm: true,
            recommendSnapshot: true,
            checkpointId: "checkpoint-1",
            snapshotId: "snapshot-1",
            reason: "Destructive command pattern",
          },
        },
      },
      { runId: "run-1", sessionId: "session-1", timestamp: "2026-06-08T00:00:00.000Z" }
    );

    const tool = requested.approvals[0]?.toolCall;
    expect(tool).toMatchObject({
      id: "approval-critical",
      riskLevel: "high",
      riskRule: "destructive",
      riskDetail: "Destructive command pattern",
      riskSource: "backend",
      matched: "Remove-Item -Recurse",
      requiresDoubleConfirm: true,
      recommendSnapshot: true,
      checkpointId: "checkpoint-1",
      snapshotId: "snapshot-1",
      approvalMetadata: {
        source: "backend",
        risk: "destructive",
        riskLevel: "high",
        matched: "Remove-Item -Recurse",
        requiresDoubleConfirm: true,
        recommendSnapshot: true,
        checkpointId: "checkpoint-1",
        snapshotId: "snapshot-1",
      },
    });
    expect(state.messages[0]?.toolCalls?.[0]).toMatchObject(tool ?? {});
  });

  it("does not invent high risk from tool names when approval metadata is missing", () => {
    const state = createRuntimeEventProjectionState();

    const requested = projectRuntimeEvent(
      state,
      {
        type: "approval-requested",
        request: {
          id: "approval-delete",
          toolCallId: "approval-delete",
          toolName: "delete_file",
          input: { path: "important.txt" },
          summary: "Delete a file",
        },
      },
      { runId: "run-1", sessionId: "session-1", timestamp: "2026-06-08T00:00:00.000Z" }
    );

    const tool = requested.approvals[0]?.toolCall;
    expect(tool).toMatchObject({
      id: "approval-delete",
      name: "delete_file",
      riskLevel: "unknown",
      riskSource: "unknown",
      approvalMetadata: {
        source: "unknown",
        riskLevel: "unknown",
      },
    });
    expect(tool?.riskRule).toBeUndefined();
    expect(tool?.matched).toBeUndefined();
    expect(tool?.requiresDoubleConfirm).toBeUndefined();
  });

  it("treats legacy local approval metadata as unknown risk diagnostics", () => {
    const state = createRuntimeEventProjectionState();

    const requested = projectRuntimeEvent(
      state,
      {
        type: "approval-requested",
        request: {
          id: "approval-local",
          toolName: "bash",
          input: { command: "rm -rf dist" },
          summary: "Delete build output",
          metadata: {
            source: "local",
            risk: "destructive",
            riskRule: "destructive",
            reason: "Local frontend name match",
            requiresDoubleConfirm: true,
          },
        },
      },
      { runId: "run-1", sessionId: "session-1", timestamp: "2026-06-08T00:00:00.000Z" }
    );

    const tool = requested.approvals[0]?.toolCall;
    expect(tool).toMatchObject({
      id: "approval-local",
      name: "bash",
      riskLevel: "unknown",
      riskSource: "unknown",
      approvalMetadata: {
        source: "unknown",
        riskLevel: "unknown",
        raw: expect.objectContaining({ source: "local", risk: "destructive" }),
      },
    });
    expect(tool?.riskRule).toBeUndefined();
    expect(tool?.requiresDoubleConfirm).toBeUndefined();
  });

  it("uses the same projection for daemon replay and realtime daemon events", () => {
    const events: DaemonOrchestratorEvent[] = [
      {
        protocolVersion: 1,
        id: "event-1",
        sequence: 1,
        type: "runtime-event",
        sessionId: "session-1",
        runId: "run-1",
        timestamp: "2026-06-08T00:00:00.000Z",
        payload: { event: { type: "message-delta", messageId: "msg-1", block: { type: "text", text: "hello" } } },
      },
      {
        protocolVersion: 1,
        id: "event-2",
        sequence: 2,
        type: "runtime-event",
        sessionId: "session-1",
        runId: "run-1",
        timestamp: "2026-06-08T00:00:01.000Z",
        payload: { event: { type: "message-end", messageId: "msg-1" } },
      },
      {
        protocolVersion: 1,
        id: "event-3",
        sequence: 3,
        type: "run-completed",
        sessionId: "session-1",
        runId: "run-1",
        timestamp: "2026-06-08T00:00:02.000Z",
        payload: { run: { status: "completed", reason: "goal-completed" } },
      },
    ];

    const replayed = projectDaemonOrchestratorEvents(events);
    const realtime = createRuntimeEventProjectionState();
    const runDeltas = events.map((event) => projectDaemonOrchestratorEvent(realtime, event).run).filter(Boolean);

    expect(materializeRuntimeProjectionMessages(realtime)).toEqual(materializeRuntimeProjectionMessages(replayed));
    expect(runDeltas.at(-1)).toEqual({ status: "completed", reason: "goal-completed" });
  });

  it("materializes ordered timeline items from projected messages", () => {
    const items = timelineItemsFromRuntimeProjectionMessages([
      {
        id: "msg-1",
        role: "user",
        content: "hello",
        timestamp: 1,
      },
      {
        id: "msg-2",
        role: "assistant",
        content: "Backend protocol failed while running workbench_list_sessions: $.workspaceMode: Unexpected field",
        timestamp: 2,
      },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "message", id: "message-msg-1", order: 0 });
    expect(items[1]).toMatchObject({
      kind: "diagnostic",
      id: "diagnostic-msg-2",
      order: 1,
      diagnostic: { title: "协议错误", source: "protocol", severity: "error" },
    });
  });

  it("classifies common transport and provider failures at the projection boundary", () => {
    expect(classifyRuntimeDiagnosticContent("Fetch transport failed: Provider request timed out after 120000ms")).toMatchObject({
      title: "模型传输错误",
      source: "transport",
    });
    expect(classifyRuntimeDiagnosticContent("System messages are not allowed")).toMatchObject({
      title: "模型接口错误",
      source: "provider",
    });
    expect(classifyRuntimeDiagnosticContent("<!DOCTYPE html><html><body>Bad gateway</body></html>")).toMatchObject({
      title: "上游网关错误",
      source: "transport",
    });
  });

  it("materializes runtime projection state into timeline items", () => {
    const state = createRuntimeEventProjectionState();
    projectRuntimeEvent(
      state,
      { type: "message-delta", messageId: "msg-1", block: { type: "text", text: "hello" } },
      { runId: "run-1", sessionId: "session-1", timestamp: "2026-06-08T00:00:00.000Z" }
    );
    projectRuntimeEvent(
      state,
      { type: "runtime-error", error: "Runtime error: provider closed the stream" },
      { runId: "run-1", sessionId: "session-1", timestamp: "2026-06-08T00:00:01.000Z" }
    );

    const items = materializeRuntimeTimelineItems(state);
    expect(items.some((item) => item.kind === "diagnostic" && item.diagnostic.source === "runtime")).toBe(true);
  });

  it("keeps approval metadata consistent between daemon replay and realtime projection", () => {
    const events: DaemonOrchestratorEvent[] = [
      {
        protocolVersion: 1,
        id: "event-1",
        sequence: 1,
        type: "runtime-event",
        sessionId: "session-1",
        runId: "run-1",
        timestamp: "2026-06-08T00:00:00.000Z",
        payload: {
          event: {
            type: "approval-requested",
            request: {
              id: "approval-1",
              toolName: "shell_command",
              input: { command: "rm -rf dist" },
              summary: "Remove dist",
              metadata: {
                risk: "destructive",
                matched: "rm -rf",
                requiresDoubleConfirm: true,
                recommendSnapshot: true,
                checkpoint: { id: "checkpoint-1" },
                snapshot: { id: "snapshot-1" },
              },
            },
          },
        },
      },
    ];

    const replayed = projectDaemonOrchestratorEvents(events);
    const realtime = createRuntimeEventProjectionState();
    const realtimeDelta = projectDaemonOrchestratorEvent(realtime, events[0]!);

    expect(materializeRuntimeProjectionMessages(realtime)).toEqual(materializeRuntimeProjectionMessages(replayed));
    expect(realtimeDelta.approvals[0]?.toolCall?.approvalMetadata).toMatchObject({
      source: "backend",
      risk: "destructive",
      riskLevel: "high",
      matched: "rm -rf",
      requiresDoubleConfirm: true,
      recommendSnapshot: true,
      checkpointId: "checkpoint-1",
      snapshotId: "snapshot-1",
    });
  });

  it("normalizes approval requestId and toolCallId at the projector boundary", () => {
    const state = createRuntimeEventProjectionState();

    const requested = projectRuntimeEvent(
      state,
      {
        type: "approval-requested",
        request: {
          id: "request-1",
          toolCallId: "tool-1",
          toolName: "write_file",
          input: { path: "a.ts" },
        },
      },
      { runId: "run-1", sessionId: "session-1" }
    );
    const resolved = projectRuntimeEvent(
      state,
      { type: "approval-resolved", requestId: "tool-1", approvalDecision: "approved" },
      { runId: "run-1", sessionId: "session-1" }
    );

    expect(requested.approvals[0]?.id).toBe("tool-1");
    expect(requested.approvals[0]?.toolCall?.id).toBe("tool-1");
    expect(resolved.approvals[0]).toMatchObject({ id: "tool-1", status: "resolved", decision: "approved" });
    expect(state.messages[0]?.toolCalls?.[0]).toMatchObject({ id: "tool-1", status: "approved" });
  });

  it("maps agent-end reasons to run status deltas", () => {
    expect(mapAgentEndReasonToRunStatus("stop")).toBe("completed");
    expect(mapAgentEndReasonToRunStatus("aborted")).toBe("cancelled");
    expect(mapAgentEndReasonToRunStatus("error")).toBe("failed");
    expect(mapAgentEndReasonToRunStatus("max-turns")).toBe("failed");
    expect(mapAgentEndReasonToRunStatus("intervention-required")).toBe("failed");
    expect(mapAgentEndReasonToRunStatus("runtime-error")).toBe("failed");
    expect(mapAgentEndReasonToRunStatus("goal-max-rounds")).toBe("failed");

    const state = createRuntimeEventProjectionState();
    const delta = projectRuntimeEvent(state, { type: "agent-end", reason: "aborted" });
    expect(delta.run).toMatchObject({ status: "cancelled", reason: "aborted" });
  });

  it("projects finished message blocks correctly without inserting incorrect newlines between sequential text blocks", () => {
    const state = createRuntimeEventProjectionState();
    
    projectRuntimeEvent(
      state,
      {
        type: "message-end",
        messageId: "msg-1",
        message: {
          id: "msg-1",
          role: "assistant",
          createdAt: "2026-06-08T00:00:00.000Z",
          blocks: [
            { type: "text", text: "你" },
            { type: "text", text: "好" },
            { type: "text", text: "！" },
            { type: "text", text: "\n" },
            { type: "text", text: "我" },
            { type: "text", text: "在" }
          ]
        }
      }
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toBe("你好！\n我在");
  });
});
