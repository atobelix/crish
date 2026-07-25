import type { AgentEvent } from "@crish/shared-types";
import { approvalRiskFields } from "./approval-projection.js";
import type { ApprovalQueue } from "./approval-queue.js";
import type { DaemonOutboundMessage } from "./types.js";
import {
  readDaemonSubagentBridgeUpdateFromAgentEvent,
  type DaemonSubagentBridgeUpdate,
} from "./subagent-runtime.js";
import { getDaemonLogger } from "./daemon-logger.js";

type Broadcast = (message: DaemonOutboundMessage) => void;

interface ActiveSubagent {
  runId: string;
  subagentId: string;
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
        subagentId: update.subagentId,
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

      getDaemonLogger().info('Subagent started', { module: 'DaemonSubagentBridge', subagentId: update.subagentId, subagentRunId: update.subagentRunId, runId });
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
    getDaemonLogger().info('Subagent ended', { module: 'DaemonSubagentBridge', subagentId: update.subagentId, status: update.status, runId: subagentInfo?.runId ?? runId });
  }

  private broadcastApprovalRequested(
    event: Extract<AgentEvent, { type: "approval-requested" }>,
    runId: string
  ): void {
    const snapshot = this.approvalQueue.getApproval(event.request.id);
    // Parity with session-handlers.broadcastApprovalRequested: risk facts on the wire
    const riskFields = approvalRiskFields(event.request.metadata);
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
      ...(riskFields.risk !== undefined ? { risk: riskFields.risk } : {}),
      ...(riskFields.riskReason !== undefined ? { riskReason: riskFields.riskReason } : {}),
      ...(riskFields.requiresDoubleConfirm !== undefined ? { requiresDoubleConfirm: riskFields.requiresDoubleConfirm } : {}),
      ...(riskFields.recommendSnapshot !== undefined ? { recommendSnapshot: riskFields.recommendSnapshot } : {}),
      ...(riskFields.metadata !== undefined ? { metadata: riskFields.metadata } : {}),
    });
  }

  /**
   * 清理指定 run 的所有追踪中子代理记录。
   *
   * 异常路径兜底：当父 run 被 cancel / error / 超时，子代理的 "ended" 事件
   * 可能不会被投递（事件流中断、orchestrator 提前结束迭代），导致 activeSubagents
   * Map 累积孤儿条目。在 run-handlers 的 finally 块中调用此方法保证清理。
   *
   * 幂等：对不存在的 run 调用不报错，多次调用安全。
   * 返回被清理的子代理 id 列表，供诊断/广播使用。
   */
  clearRun(runId: string): string[] {
    const removed: string[] = [];
    for (const [subagentId, info] of this.activeSubagents) {
      if (info.runId !== runId) continue;
      this.activeSubagents.delete(subagentId);
      removed.push(subagentId);
      getDaemonLogger().info('Subagent cleared on run-finalize', { module: 'DaemonSubagentBridge', subagentId, runId });
    }
    return removed;
  }

  /**
   * 清理全部追踪中子代理记录（daemon 关停时使用）。
   * 幂等：空 Map 调用安全。
   */
  clearAll(): void {
    const count = this.activeSubagents.size;
    this.activeSubagents.clear();
    if (count > 0) {
      getDaemonLogger().info('Cleared active subagents on shutdown', { module: 'DaemonSubagentBridge', count });
    }
  }

  /** 诊断用：当前追踪中的子代理数量。 */
  get size(): number {
    return this.activeSubagents.size;
  }

  /** 返回当前活跃子代理的快照，供重新连接的客户端回放状态。 */
  getActiveSubagentsSnapshot(): ActiveSubagent[] {
    return [...this.activeSubagents.values()];
  }

  /**
   * 从事件存储重建时调用：将子代理启动事件恢复到活跃追踪中。
   * 不广播消息，仅恢复内部状态。
   */
  rebuildStarted(update: DaemonSubagentBridgeUpdate, runId: string): void {
    if (update.phase !== "started") return;
    this.activeSubagents.set(update.subagentId, {
      runId,
      subagentId: update.subagentId,
      subagentRunId: update.subagentRunId,
      parentToolCallId: update.parentToolCallId,
      description: update.description,
      mode: update.mode,
    });
  }
}
