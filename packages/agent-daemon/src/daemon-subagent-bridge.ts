import type { AgentEvent } from "@crish/shared-types";
import { approvalRiskFields } from "./approval-projection.js";
import type { ApprovalQueue } from "./approval-queue.js";
import type { DaemonOutboundMessage } from "./types.js";
import {
  readDaemonSubagentBridgeUpdateFromAgentEvent,
  type DaemonSubagentBridgeUpdate,
} from "./subagent-runtime.js";

type Broadcast = (message: DaemonOutboundMessage) => void;

interface ActiveSubagent {
  runId: string;
  subagentRunId: string;
  parentToolCallId: string;
  description: string;
  mode: string;
}

export class DaemonSubagentBridge {
  private readonly activeSubagents = new Map<string, ActiveSubagent>();

  constructor(
    private readonly broadcast: Broadcast,
    private readonly approvalQueue: ApprovalQueue
  ) {}

  processAgentEvent(event: AgentEvent, runId: string): void {
    this.processBridgeUpdate(readDaemonSubagentBridgeUpdateFromAgentEvent(event), runId);

    if (event.type === "tool-update") {
      const childEvent = (event.update.json as { event?: AgentEvent } | undefined)?.event;
      if (childEvent) {
        this.processAgentEvent(childEvent, runId);
      }
    }
  }

  private processBridgeUpdate(
    update: DaemonSubagentBridgeUpdate | undefined,
    runId: string
  ): void {
    if (!update) return;

    if (update.phase === "started") {
      this.activeSubagents.set(update.subagentId, {
        runId,
        subagentRunId: update.subagentRunId,
        parentToolCallId: update.parentToolCallId,
        description: update.description,
        mode: update.mode,
      });

      this.broadcast({
        type: "subagent-started",
        runId,
        subagentId: update.subagentId,
        subagentRunId: update.subagentRunId,
        parentToolCallId: update.parentToolCallId,
        description: update.description,
        mode: update.mode,
      });

      console.log(`[Daemon] Subagent started: ${update.subagentId} (run: ${update.subagentRunId})`);
      return;
    }

    if (update.phase === "event") {
      this.broadcast({
        type: "subagent-event",
        runId,
        subagentId: update.subagentId,
        subagentRunId: update.subagentRunId,
        parentToolCallId: update.parentToolCallId,
        event: update.event,
      });

      if (update.event.type === "approval-requested") {
        this.broadcastApprovalRequested(update.event, update.subagentRunId);
      }
      return;
    }

    const subagentInfo = this.activeSubagents.get(update.subagentId);
    this.broadcast({
      type: "subagent-ended",
      runId: subagentInfo?.runId ?? runId,
      subagentId: update.subagentId,
      subagentRunId: update.subagentRunId,
      parentToolCallId: update.parentToolCallId,
      status: update.status,
      summary: update.summary,
    });

    this.activeSubagents.delete(update.subagentId);
    console.log(`[Daemon] Subagent ended: ${update.subagentId} (${update.status})`);
  }

  private broadcastApprovalRequested(
    event: Extract<AgentEvent, { type: "approval-requested" }>,
    runId: string
  ): void {
    const snapshot = this.approvalQueue.getApproval(event.request.id);
    // Parity with session-handlers.broadcastApprovalRequested: risk facts on the wire
    this.broadcast({
      type: "approval-requested",
      runId,
      toolCallId: event.request.toolCallId,
      toolName: event.request.toolName,
      input: event.request.parameters as Record<string, unknown>,
      summary: event.request.summary,
      timeoutMs: snapshot?.timeoutMs ?? this.approvalQueue.getDefaultTimeoutMs(),
      expiresAt: snapshot?.expiresAt ?? null,
      remainingMs: snapshot?.remainingMs ?? null,
      ...approvalRiskFields(event.request.metadata),
    });
  }
}
