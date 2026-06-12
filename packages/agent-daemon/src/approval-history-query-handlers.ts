import type { JsonObject } from "@crish/shared-types";
import type { AgentEvent, PermissionDecision } from "@crish/shared-types";
import type { AgentOrchestrator, OrchestratorEvent } from "@crish/agent-orchestrator";
import { isRecord } from "@crish/shared-utils";
import type { ApprovalQueue } from "./approval-queue.js";
import { approvalRiskFields, approvalStatusSnapshot } from "./approval-projection.js";
import type {
  ApprovalHistoryEntry,
  ApprovalHistoryFilters,
  ApprovalHistoryListedMessage,
  ApprovalProtocolStatus,
  ListApprovalHistoryMessage,
} from "./types.js";

const DEFAULT_APPROVAL_HISTORY_LIMIT = 100;
const MAX_APPROVAL_HISTORY_LIMIT = 500;

export async function createApprovalHistoryResponse(
  orchestrator: AgentOrchestrator,
  approvalQueue: ApprovalQueue,
  msg: ListApprovalHistoryMessage
): Promise<ApprovalHistoryListedMessage> {
  const queryStartedAt = Date.now();
  const [eventLog, events] = await Promise.all([
    orchestrator.getEventLogMetadata(),
    orchestrator.readAllEvents(),
  ]);
  const filters = approvalHistoryFilters(msg);
  const approvalsById = projectApprovalEvents(events);
  const liveOverlayCount = mergeLiveApprovals(approvalsById, approvalQueue);
  const projected = [...approvalsById.values()];
  const filtered = projected.filter((approval) => matchesApprovalHistoryFilters(approval, filters));
  const sorted = filtered.sort(compareApprovalHistoryEntries);
  const limit = approvalHistoryLimit(msg.limit);
  const approvals = sorted.slice(0, limit);
  const truncated = sorted.length > approvals.length;

  return {
    type: "approval-history-listed",
    approvals,
    eventLog,
    filters,
    total: sorted.length,
    returned: approvals.length,
    truncated,
    diagnostics: {
      queryMs: Date.now() - queryStartedAt,
      eventCount: events.length,
      projectedCount: projected.length,
      liveOverlayCount,
      filteredOutCount: projected.length - filtered.length,
      limit,
      truncated,
    },
  };
}

function projectApprovalEvents(events: OrchestratorEvent[]): Map<string, ApprovalHistoryEntry> {
  const approvals = new Map<string, ApprovalHistoryEntry>();

  for (const event of events) {
    if (event.type !== "runtime-event") continue;
    const runtimeEvent = event.payload.event;
    if (!isRuntimeEventRecord(runtimeEvent)) continue;

    if (runtimeEvent.type === "approval-requested") {
      const request = runtimeEvent.request;
      if (!isRecord(request)) continue;
      const toolCallId = stringValue(request.id);
      if (!toolCallId) continue;
      const metadata = toJsonObject(request.metadata);
      const createdAt = timestampMs(stringValue(runtimeEvent.timestamp) ?? event.timestamp);
      const tool = isRecord(request.tool) ? request.tool : undefined;
      const entry: ApprovalHistoryEntry = {
        toolCallId,
        runId: event.runId ?? "",
        sessionId: event.sessionId,
        toolName: stringValue(tool?.name) ?? "unknown",
        summary: stringValue(request.summary) ?? "",
        input: toJsonObject(request.input),
        createdAt,
        status: "pending",
        timeoutMs: null,
        expiresAt: null,
        remainingMs: null,
        source: "event-log",
        updatedAt: createdAt,
        requestSequence: event.sequence,
        ...approvalRiskFields(metadata),
      };
      approvals.set(toolCallId, entry);
      continue;
    }

    if (runtimeEvent.type === "approval-resolved") {
      const toolCallId = stringValue(runtimeEvent.requestId);
      if (!toolCallId) continue;
      const decision = isRecord(runtimeEvent.decision)
        ? (runtimeEvent.decision as PermissionDecision)
        : undefined;
      const resolvedAt = timestampMs(stringValue(runtimeEvent.timestamp) ?? event.timestamp);
      const status = approvalStatusFromDecision(decision);
      const existing =
        approvals.get(toolCallId) ??
        ({
          toolCallId,
          runId: event.runId ?? "",
          sessionId: event.sessionId,
          toolName: "unknown",
          summary: "",
          input: {},
          createdAt: resolvedAt,
          status,
          timeoutMs: null,
          expiresAt: null,
          remainingMs: 0,
          source: "event-log",
          updatedAt: resolvedAt,
        } satisfies ApprovalHistoryEntry);

      existing.status = status;
      existing.resolvedAt = resolvedAt;
      existing.updatedAt = resolvedAt;
      existing.resolvedSequence = event.sequence;
      existing.remainingMs = 0;
      if (decision?.reason) existing.reason = decision.reason;
      const expiredAt = approvalExpiredAt(decision);
      if (expiredAt !== undefined) {
        existing.expiredAt = expiredAt;
        existing.expiredReason = existing.reason;
      }
      approvals.set(toolCallId, existing);
    }
  }

  return approvals;
}

function mergeLiveApprovals(
  approvalsById: Map<string, ApprovalHistoryEntry>,
  approvalQueue: ApprovalQueue
): number {
  let overlayCount = 0;
  for (const snapshot of [
    ...approvalQueue.getPendingApprovals(),
    ...approvalQueue.getRecentApprovals(),
  ]) {
    const status = approvalStatusSnapshot(snapshot);
    const existing = approvalsById.get(status.toolCallId);
    const input = toJsonObject(snapshot.metadata?.input);
    const updatedAt = status.resolvedAt ?? status.createdAt;

    if (existing) {
      existing.status = status.status;
      existing.timeoutMs = status.timeoutMs;
      existing.expiresAt = status.expiresAt;
      existing.remainingMs = status.remainingMs;
      existing.updatedAt = Math.max(existing.updatedAt, updatedAt);
      existing.live = true;
      if (status.resolvedAt !== undefined) existing.resolvedAt = status.resolvedAt;
      if (status.expiredAt !== undefined) existing.expiredAt = status.expiredAt;
      if (status.reason !== undefined) existing.reason = status.reason;
      if (status.expiredReason !== undefined) existing.expiredReason = status.expiredReason;
      if (status.risk !== undefined) existing.risk = status.risk;
      if (status.riskReason !== undefined) existing.riskReason = status.riskReason;
      if (status.requiresDoubleConfirm !== undefined) {
        existing.requiresDoubleConfirm = status.requiresDoubleConfirm;
      }
      if (status.recommendSnapshot !== undefined) {
        existing.recommendSnapshot = status.recommendSnapshot;
      }
      if (status.metadata !== undefined) existing.metadata = status.metadata;
      if (Object.keys(input).length > 0) existing.input = input;
    } else {
      approvalsById.set(status.toolCallId, {
        toolCallId: status.toolCallId,
        runId: status.runId,
        toolName: status.toolName,
        summary: status.summary,
        input,
        createdAt: status.createdAt,
        status: status.status,
        timeoutMs: status.timeoutMs,
        expiresAt: status.expiresAt,
        remainingMs: status.remainingMs,
        source: "live-queue",
        live: true,
        updatedAt,
        ...(status.resolvedAt !== undefined ? { resolvedAt: status.resolvedAt } : {}),
        ...(status.expiredAt !== undefined ? { expiredAt: status.expiredAt } : {}),
        ...(status.reason !== undefined ? { reason: status.reason } : {}),
        ...(status.expiredReason !== undefined ? { expiredReason: status.expiredReason } : {}),
        ...(status.risk !== undefined ? { risk: status.risk } : {}),
        ...(status.riskReason !== undefined ? { riskReason: status.riskReason } : {}),
        ...(status.requiresDoubleConfirm !== undefined
          ? { requiresDoubleConfirm: status.requiresDoubleConfirm }
          : {}),
        ...(status.recommendSnapshot !== undefined ? { recommendSnapshot: status.recommendSnapshot } : {}),
        ...(status.metadata !== undefined ? { metadata: status.metadata } : {}),
      });
    }
    overlayCount += 1;
  }
  return overlayCount;
}

function approvalHistoryFilters(msg: ListApprovalHistoryMessage): ApprovalHistoryFilters {
  const status = msg.status ?? msg.decision;
  return {
    ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
    ...(msg.runId ? { runId: msg.runId } : {}),
    ...(msg.toolName ? { toolName: msg.toolName } : {}),
    ...(status ? { status } : {}),
    ...(msg.risk ? { risk: msg.risk } : {}),
  };
}

function matchesApprovalHistoryFilters(
  approval: ApprovalHistoryEntry,
  filters: ApprovalHistoryFilters
): boolean {
  if (filters.sessionId && approval.sessionId !== filters.sessionId) return false;
  if (filters.runId && approval.runId !== filters.runId) return false;
  if (filters.toolName && approval.toolName !== filters.toolName) return false;
  if (filters.status && approval.status !== filters.status) return false;
  if (filters.risk && approval.risk !== filters.risk) return false;
  return true;
}

function approvalHistoryLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_APPROVAL_HISTORY_LIMIT;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_APPROVAL_HISTORY_LIMIT;
  return Math.min(MAX_APPROVAL_HISTORY_LIMIT, Math.floor(value));
}

function compareApprovalHistoryEntries(left: ApprovalHistoryEntry, right: ApprovalHistoryEntry): number {
  const byUpdatedAt = right.updatedAt - left.updatedAt;
  if (byUpdatedAt !== 0) return byUpdatedAt;
  return (right.resolvedSequence ?? right.requestSequence ?? 0) - (left.resolvedSequence ?? left.requestSequence ?? 0);
}

function approvalStatusFromDecision(decision: PermissionDecision | undefined): ApprovalProtocolStatus {
  const approval = decision?.metadata?.approval;
  if (isRecord(approval) && approval.status === "expired") return "expired";
  if (isRecord(approval) && approval.status === "denied") return "denied";
  if (decision?.behavior === "allow") return "approved";
  return "denied";
}

function approvalExpiredAt(decision: PermissionDecision | undefined): number | undefined {
  const approval = decision?.metadata?.approval;
  if (!isRecord(approval) || approval.status !== "expired") return undefined;
  return typeof approval.expiredAt === "number" ? approval.expiredAt : undefined;
}

function isRuntimeEventRecord(value: unknown): value is AgentEvent & Record<string, unknown> {
  return isRecord(value) && typeof value.type === "string";
}

function timestampMs(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toJsonObject(value: unknown): JsonObject {
  return isRecord(value) ? (value as JsonObject) : {};
}


