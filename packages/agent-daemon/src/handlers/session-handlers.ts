/**
 * Session Handlers
 *
 * Extracted from DaemonRequestHandlers to reduce the monolithic
 * server-handlers.ts. Covers conversation rewind, session action,
 * and session/run event reading.
 */

import type { WebSocket } from "ws";
import { errorMessage, toJsonObject } from "@crish/shared-utils";
import type { JsonObject, AgentEvent } from "@crish/shared-types";
import {
  JsonlSessionStore,
  moveSessionLeaf as moveRuntimeSessionLeaf,
  restoreWorkspaceCheckpoint,
} from "@crish/agent-runtime";
import {
  AgentOrchestrator,
  planConversationRewind,
  type RunStatus,
} from "@crish/agent-orchestrator";
import type {
  ApplyConversationRewindMessage,
  ApplySessionActionMessage,
  ConversationRewindAppliedMessage,
  ConversationRewindApplyStepResult,
  ConversationRewindPlanSnapshot,
  DaemonCorrelationFields,
  DaemonOutboundMessage,
  PreviewConversationRewindByBoundaryMessage,
  PreviewConversationRewindMessage,
  ResolveConversationRewindBoundaryMessage,
} from "../types.js";
import type { DaemonConfig } from "../types.js";
import type { ApprovalQueue } from "../approval-queue.js";
import { approvalRiskFields } from "../approval-projection.js";
import type { FileSessionMetadataStore } from "../session-metadata-store.js";
import {
  previewConversationRewindByBoundary,
  resolveConversationRewindBoundary,
  runtimeSessionStorePath,
  type DaemonConversationRewindBoundaryMissingFact,
} from "../conversation-rewind-boundary.js";
import type {
  ConversationBoundaryManifestRecord,
  ConversationRewindTargetFacts,
} from "@crish/agent-runtime";
import {
  createReadSessionEventsResponse,
  createReadRunEventsResponse,
  createGetRunSnapshotResponse,
} from "../session-query-handlers.js";

// ─── Error class ───────────────────────────────────────────

export class DaemonConversationRewindError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DaemonConversationRewindError";
    this.code = code;
  }
}

// ─── Helper functions ──────────────────────────────────────

function isActiveRunStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running" || status === "awaiting-approval" || status === "cancelling";
}

function codeForBoundaryApplyBlock(result: {
  status: string;
  code?: string;
  diagnostics?: Array<{ code: string; blocked: boolean }>;
}): string {
  if (result.code) return result.code;
  const blocked = result.diagnostics?.find((item) => item.blocked);
  if (blocked) return blocked.code;
  return `REWIND_BOUNDARY_${result.status.toUpperCase()}`;
}

function messageForBoundaryApplyBlock(result: {
  status: string;
  message?: string;
  diagnostics?: Array<{ message: string; blocked: boolean }>;
}): string {
  if (result.message) return result.message;
  const blocked = result.diagnostics?.find((item) => item.blocked);
  if (blocked) return blocked.message;
  return `Conversation rewind boundary resolution returned status: ${result.status}`;
}

function approvalDecisionFromRuntimeEvent(
  event: Extract<AgentEvent, { type: "approval-resolved" }>
): { decision: "expired"; reason?: string; expiredAt?: number } | undefined {
  const approval = event.decision.metadata?.approval;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    return undefined;
  }

  const record = approval as Record<string, unknown>;
  if (record.status !== "expired") return undefined;

  return {
    decision: "expired",
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    ...(typeof record.expiredAt === "number" ? { expiredAt: record.expiredAt } : {}),
  };
}

// ─── Transport & dependency interfaces ─────────────────────

interface SessionTransport {
  send(ws: WebSocket, message: unknown): boolean;
  sendError(ws: WebSocket, code: string, message: string, runId?: string, correlation?: DaemonCorrelationFields): boolean;
  broadcast(message: unknown): number;
}

interface ConversationRewindApplyPlanResolution {
  plan: ConversationRewindPlanSnapshot;
  source: "explicit" | "boundary";
  boundary?: ConversationBoundaryManifestRecord | undefined;
  target?: ConversationRewindTargetFacts | undefined;
  runtimeTargetLeafId?: string | undefined;
  missingFacts?: DaemonConversationRewindBoundaryMissingFact[] | undefined;
}

// ─── Handler functions ─────────────────────────────────────

export async function handleReadSessionEvents(
  ws: WebSocket,
  msg: DaemonCorrelationFields & { type: "read-session-events" },
  orchestrator: AgentOrchestrator,
  transport: SessionTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T,
  correlationFrom: (correlation: DaemonCorrelationFields) => DaemonCorrelationFields
): Promise<void> {
  const result = await createReadSessionEventsResponse(orchestrator, msg as never);
  if (result.ok) {
    transport.send(ws, correlateResponse(result.message, msg));
  } else {
    transport.sendError(ws, result.code, result.message, undefined, correlationFrom(msg));
  }
}

export async function handleReadRunEvents(
  ws: WebSocket,
  msg: DaemonCorrelationFields & { type: "read-run-events" },
  orchestrator: AgentOrchestrator,
  transport: SessionTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T,
  correlationFrom: (correlation: DaemonCorrelationFields) => DaemonCorrelationFields
): Promise<void> {
  const result = await createReadRunEventsResponse(orchestrator, msg as never);
  if (result.ok) {
    transport.send(ws, correlateResponse(result.message, msg));
  } else {
    transport.sendError(ws, result.code, result.message, result.runId, correlationFrom(msg));
  }
}

export async function handleGetRunSnapshot(
  ws: WebSocket,
  msg: DaemonCorrelationFields & { type: "get-run-snapshot" },
  orchestrator: AgentOrchestrator,
  transport: SessionTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T,
  correlationFrom: (correlation: DaemonCorrelationFields) => DaemonCorrelationFields
): Promise<void> {
  const result = await createGetRunSnapshotResponse(orchestrator, msg as never);
  if (result.ok) {
    transport.send(ws, correlateResponse(result.message, msg));
  } else {
    transport.sendError(ws, result.code, result.message, result.runId, correlationFrom(msg));
  }
}

export function handlePreviewConversationRewind(
  ws: WebSocket,
  msg: PreviewConversationRewindMessage & DaemonCorrelationFields,
  orchestrator: AgentOrchestrator,
  approvalQueue: ApprovalQueue,
  transport: SessionTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): void {
  try {
    const plan = createConversationRewindPlan(msg, orchestrator, approvalQueue);
    transport.send(
      ws,
      correlateResponse(
        {
          type: "conversation-rewind-preview",
          sessionId: msg.sessionId,
          plan,
        },
        msg
      )
    );
  } catch (error) {
    sendConversationRewindError(ws, error, transport, msg);
  }
}

export async function handleResolveConversationRewindBoundary(
  ws: WebSocket,
  msg: ResolveConversationRewindBoundaryMessage & DaemonCorrelationFields,
  config: DaemonConfig,
  transport: SessionTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const result = await resolveConversationRewindBoundary({
      config,
      sessionId: msg.sessionId,
      userMessageId: msg.userMessageId,
      latestUserMessage: msg.latestUserMessage,
      mode: msg.mode,
    });
    const boundaryMsg: DaemonOutboundMessage = {
      type: "conversation-rewind-boundary",
      status: result.status,
      sessionId: result.sessionId,
      ...(result.userMessageId !== undefined ? { userMessageId: result.userMessageId } : {}),
      latestUserMessage: result.latestUserMessage,
      mode: result.mode,
      ...(result.boundary !== undefined ? { boundary: result.boundary } : {}),
      ...(result.checkpoint !== undefined ? { checkpoint: result.checkpoint } : {}),
      ...(result.target !== undefined ? { target: result.target } : {}),
      missingFacts: result.missingFacts,
      diagnostics: result.diagnostics,
    } as unknown as DaemonOutboundMessage;
    transport.send(ws, correlateResponse(boundaryMsg, msg));
  } catch (error) {
    sendConversationRewindError(ws, error, transport, msg);
  }
}

export async function handlePreviewConversationRewindByBoundary(
  ws: WebSocket,
  msg: PreviewConversationRewindByBoundaryMessage & DaemonCorrelationFields,
  config: DaemonConfig,
  orchestrator: AgentOrchestrator,
  approvalQueue: ApprovalQueue,
  transport: SessionTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const result = await previewConversationRewindByBoundary({
      config,
      orchestrator,
      approvalQueue,
      sessionId: msg.sessionId,
      userMessageId: msg.userMessageId,
      latestUserMessage: msg.latestUserMessage,
      mode: msg.mode,
      restorePolicy: msg.restorePolicy,
    activeSubagents: (msg.activeSubagents ?? []).map((a) => ({ ...a, subagentId: a.subagentId ?? '' })),
    });
    const boundaryMsg: DaemonOutboundMessage = {
      type: "conversation-rewind-boundary",
      status: result.status,
      sessionId: result.sessionId,
      ...(result.userMessageId !== undefined ? { userMessageId: result.userMessageId } : {}),
      latestUserMessage: result.latestUserMessage,
      mode: result.mode,
      ...(result.boundary !== undefined ? { boundary: result.boundary } : {}),
      ...(result.checkpoint !== undefined ? { checkpoint: result.checkpoint } : {}),
      ...(result.target !== undefined ? { target: result.target } : {}),
      missingFacts: result.missingFacts,
      diagnostics: result.diagnostics,
      ...(result.plan !== undefined ? { plan: result.plan } : {}),
      ...(result.runtimeTargetLeafId !== undefined ? { runtimeTargetLeafId: result.runtimeTargetLeafId } : {}),
    } as unknown as DaemonOutboundMessage;
    transport.send(ws, correlateResponse(boundaryMsg, msg));
  } catch (error) {
    sendConversationRewindError(ws, error, transport, msg);
  }
}

export async function handleApplyConversationRewind(
  ws: WebSocket,
  msg: ApplyConversationRewindMessage & DaemonCorrelationFields,
  deps: SessionRewindDeps,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const resolved = await createConversationRewindApplyPlan(msg, deps);
    assertConversationRewindPlanExecutable(resolved);
    const stepResults = await applyConversationRewindPlan(resolved, deps);
    const response: ConversationRewindAppliedMessage = {
      type: "conversation-rewind-applied",
      sessionId: msg.sessionId,
      plan: resolved.plan,
      stepResults,
    };
    deps.transport.send(ws, correlateResponse(response, msg));
  } catch (error) {
    sendConversationRewindError(ws, error, deps.transport, msg);
  }
}

export async function handleApplySessionAction(
  ws: WebSocket,
  msg: ApplySessionActionMessage & DaemonCorrelationFields,
  orchestrator: AgentOrchestrator,
  metadataStore: FileSessionMetadataStore,
  transport: SessionTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  const receipt = await createSessionActionReceipt({
    action: msg.action,
    orchestrator,
    metadataStore,
  });
  transport.send(ws, correlateResponse(receipt, msg));
}

// ─── Dependency interface for rewind apply ─────────────────

export interface SessionRewindDeps {
  orchestrator: AgentOrchestrator;
  approvalQueue: ApprovalQueue;
  config: DaemonConfig;
  transport: SessionTransport;
  sessionMetadataStore: FileSessionMetadataStore;
}

// ─── Internal helper functions ─────────────────────────────

function createConversationRewindPlan(
  msg: (PreviewConversationRewindMessage | ApplyConversationRewindMessage) & DaemonCorrelationFields,
  orchestrator: AgentOrchestrator,
  approvalQueue: ApprovalQueue
): ConversationRewindPlanSnapshot {
  const session = orchestrator.getSession(msg.sessionId);
  if (!session) {
    throw new DaemonConversationRewindError(
      "REWIND_SESSION_NOT_FOUND",
      `Session not found: ${msg.sessionId}`
    );
  }

  if (msg.targetLeafId === undefined || msg.entries === undefined) {
    throw new DaemonConversationRewindError(
      "REWIND_TARGET_MISSING",
      "Explicit conversation rewind requires targetLeafId and entries."
    );
  }

  return planConversationRewind({
    session,
    entries: msg.entries,
    targetLeafId: msg.targetLeafId,
    runs: orchestrator.listRuns(),
    pendingApprovals: approvalQueue.getPendingApprovals().map((approval) => ({
      toolCallId: approval.toolCallId,
      runId: approval.runId,
    })),
    activeSubagents: (msg.activeSubagents ?? []).map((a) => ({ ...a, subagentId: a.subagentId ?? '' })),
    checkpoint: msg.checkpoint,
    restorePolicy: msg.restorePolicy,
  });
}

async function createConversationRewindApplyPlan(
  msg: ApplyConversationRewindMessage & DaemonCorrelationFields,
  deps: SessionRewindDeps
): Promise<ConversationRewindApplyPlanResolution> {
  if (msg.targetLeafId !== undefined || msg.entries !== undefined) {
    return {
      plan: createConversationRewindPlan(msg, deps.orchestrator, deps.approvalQueue),
      source: "explicit",
    };
  }

  const result = await previewConversationRewindByBoundary({
    config: deps.config,
    orchestrator: deps.orchestrator,
    approvalQueue: deps.approvalQueue,
    sessionId: msg.sessionId,
    userMessageId: msg.userMessageId,
    latestUserMessage: msg.latestUserMessage,
    mode: msg.mode,
    restorePolicy: msg.restorePolicy,
    activeSubagents: msg.activeSubagents ?? [],
  });

  if (result.status !== "ok" || !result.plan) {
    throw new DaemonConversationRewindError(
      codeForBoundaryApplyBlock(result),
      messageForBoundaryApplyBlock(result)
    );
  }

  return {
    plan: result.plan,
    source: "boundary",
    boundary: result.boundary,
    target: result.target,
    runtimeTargetLeafId: result.runtimeTargetLeafId,
    missingFacts: result.missingFacts,
  };
}

function assertConversationRewindPlanExecutable(resolution: ConversationRewindApplyPlanResolution): void {
  if (resolution.source === "boundary" && resolution.missingFacts && resolution.missingFacts.length > 0) {
    throw new DaemonConversationRewindError(
      "REWIND_MISSING_FACTS",
      `Conversation rewind is missing required facts: ${resolution.missingFacts.join(", ")}`
    );
  }

  for (const step of resolution.plan.steps) {
    if (step.type !== "restore-workspace") continue;
    if (step.restore.source === "none") continue;
    if (step.restore.source === "runtime-manifest" && !step.restore.manifestPath) {
      throw new DaemonConversationRewindError(
        "REWIND_MISSING_CHECKPOINT",
        "Conversation rewind workspace restore requires a runtime checkpoint manifest path."
      );
    }
    if (step.restore.source !== "runtime-manifest" && step.restore.source !== "git-checkpoint") {
      throw new DaemonConversationRewindError(
        "REWIND_WORKSPACE_RESTORE_UNSUPPORTED",
        `Conversation rewind workspace restore source is unsupported: ${step.restore.source}`
      );
    }
  }
}

async function applyConversationRewindPlan(
  resolution: ConversationRewindApplyPlanResolution,
  deps: SessionRewindDeps
): Promise<ConversationRewindApplyStepResult[]> {
  const plan = resolution.plan;
  const results: ConversationRewindApplyStepResult[] = [];
  for (const step of plan.steps) {
    if (step.type === "cancel-runs") {
      const affectedIds = step.runs
        .filter((run) => deps.orchestrator.cancelRun(run.runId, run.reason))
        .map((run) => run.runId);
      for (const runId of affectedIds) {
        deps.approvalQueue.clearRun(runId, "conversation-rewind");
      }
      await waitForCancelledRunsToSettle(affectedIds, deps.orchestrator, 2_000);
      results.push({
        type: step.type,
        status: affectedIds.length > 0 ? "applied" : "skipped",
        code: affectedIds.length > 0 ? "active-runs-cancelled" : "no-active-runs",
        affectedIds,
        message: affectedIds.length === 0 ? "No active runs were cancelled." : undefined,
        metadata: undefined,
      });
      continue;
    }

    if (step.type === "clear-approvals") {
      for (const approval of step.approvals) {
        deps.approvalQueue.clearRun(approval.runId, approval.reason);
      }
      results.push({
        type: step.type,
        status: step.approvals.length > 0 ? "applied" : "skipped",
        code: step.approvals.length > 0 ? "pending-approvals-cleared" : "no-pending-approvals",
        affectedIds: step.approvals.map((approval) => approval.toolCallId),
        message: undefined,
        metadata: undefined,
      });
      continue;
    }

    if (step.type === "restore-workspace") {
      const restored = await restoreConversationRewindWorkspace(step.restore, resolution, deps);
      results.push({
        type: step.type,
        status: "applied",
        code: "workspace-restored",
        affectedIds: restored.affectedIds,
        message: undefined,
        metadata: restored.metadata,
      });
      continue;
    }

    const result = await moveConversationRewindSessionLeaf(step, resolution, deps);
    results.push({
      type: step.type,
      status: result.changed ? "applied" : "skipped",
      code: result.changed ? "session-leaf-moved" : "session-leaf-unchanged",
      affectedIds: step.toLeafId === null ? [] : [step.toLeafId],
      message: result.changed ? undefined : "Session leaf already points at the rewind target.",
      ...(result.runtimePointerId !== undefined ? { metadata: { runtimePointerId: result.runtimePointerId } } : { metadata: undefined }),
    });
  }
  await recordConversationRewindAudit(resolution, results, deps);
  return results;
}

async function waitForCancelledRunsToSettle(
  runIds: string[],
  orchestrator: AgentOrchestrator,
  timeoutMs: number
): Promise<void> {
  if (runIds.length === 0) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = runIds
      .map((runId) => orchestrator.getRun(runId))
      .filter((run) => run && isActiveRunStatus(run.status));
    if (active.length === 0) return;
    await delay(25);
  }

  const active = runIds
    .map((runId) => orchestrator.getRun(runId))
    .filter((run) => run && isActiveRunStatus(run.status));
  if (active.length > 0) {
    throw new DaemonConversationRewindError(
      "REWIND_ACTIVE_RUN_CANCEL_TIMEOUT",
      `Timed out waiting for active rewind runs to cancel: ${active.map((run) => run!.id).join(", ")}`
    );
  }
}

async function restoreConversationRewindWorkspace(
  restore: ConversationRewindPlanSnapshot["workspaceRestore"],
  resolution: ConversationRewindApplyPlanResolution,
  deps: SessionRewindDeps
): Promise<{ affectedIds: string[]; metadata: JsonObject }> {
  try {
    if (restore.source === "runtime-manifest") {
      if (!restore.manifestPath) {
        throw new DaemonConversationRewindError(
          "REWIND_MISSING_CHECKPOINT",
          "Runtime checkpoint restore is missing manifestPath."
        );
      }
      const result = await restoreWorkspaceCheckpoint({
        workspaceRoot: workspaceRootForRestore(resolution, deps),
        checkpointPath: restore.manifestPath,
      });
      return {
        affectedIds: [...result.restored, ...result.deleted],
        metadata: {
          checkpointId: result.checkpointId,
          restored: result.restored,
          deleted: result.deleted,
          skipped: result.skipped,
        },
      };
    }

    if (restore.source === "git-checkpoint") {
      if (!restore.checkpoint) {
        throw new DaemonConversationRewindError(
          "REWIND_MISSING_CHECKPOINT",
          "Git checkpoint restore is missing checkpoint ref."
        );
      }
      const { GitCliVersioningService } = await import("@crish/agent-runtime");
      const result = await new GitCliVersioningService().restoreCheckpoint({
        cwd: workspaceRootForRestore(resolution, deps),
        checkpoint: restore.checkpoint,
        cleanUntracked: restore.cleanUntracked,
        ...(resolution.target?.checkpoint?.changedPaths !== undefined
          ? { expectedChangedPaths: resolution.target.checkpoint.changedPaths }
          : {}),
      });
      return {
        affectedIds: result.changedPaths,
        metadata: {
          checkpointId: result.checkpointId,
          refName: result.refName,
          strategy: result.strategy,
          repositoryRoot: result.repositoryRoot,
          cleanUntracked: result.cleanUntracked,
          changedPaths: result.changedPaths,
        },
      };
    }

    throw new DaemonConversationRewindError(
      "REWIND_WORKSPACE_RESTORE_UNSUPPORTED",
      `Conversation rewind workspace restore source is unsupported: ${restore.source}`
    );
  } catch (error) {
    if (error instanceof DaemonConversationRewindError) throw error;
    throw new DaemonConversationRewindError(
      "REWIND_WORKSPACE_RESTORE_FAILED",
      `Conversation rewind workspace restore failed: ${errorMessage(error)}`
    );
  }
}

function workspaceRootForRestore(
  resolution: ConversationRewindApplyPlanResolution,
  deps: SessionRewindDeps
): string {
  if (resolution.target?.workspaceRoot) return resolution.target.workspaceRoot;
  return deps.orchestrator.getSession(resolution.plan.sessionId)?.cwd ?? deps.config.defaultCwd;
}

async function moveConversationRewindSessionLeaf(
  step: Extract<ConversationRewindPlanSnapshot["steps"][number], { type: "move-session-leaf" }>,
  resolution: ConversationRewindApplyPlanResolution,
  deps: SessionRewindDeps
): Promise<{ changed: boolean; runtimePointerId?: string }> {
  try {
    const result = await deps.orchestrator.moveSessionLeaf({
      sessionId: step.sessionId,
      targetLeafId: step.toLeafId,
      ...(deps.orchestrator.getSession(step.sessionId)?.currentLeafId !== undefined
        ? { expectedCurrentLeafId: step.fromLeafId }
        : {}),
      reason: "conversation-rewind",
      metadata: {
        fromLeafId: step.fromLeafId,
        toLeafId: step.toLeafId,
        ...(resolution.boundary !== undefined ? { userMessageId: resolution.boundary.userMessageId } : {}),
      },
    });

    const session = deps.orchestrator.getSession(step.sessionId);
    if (!session) {
      throw new Error(`Session not found after leaf move: ${step.sessionId}`);
    }
    let runtimePointerId: string | undefined;
    if (resolution.runtimeTargetLeafId !== undefined) {
      const store = new JsonlSessionStore(runtimeSessionStorePath(deps.config, step.sessionId, session.cwd), {
        mode: "append",
      });
      await store.open({
        type: "session",
        id: step.sessionId,
        cwd: session.cwd,
        createdAt: session.createdAt,
        version: 1,
      });
      const runtimeMove = await moveRuntimeSessionLeaf(store, resolution.runtimeTargetLeafId, {
        reason: "conversation-rewind",
        metadata: {
          fromLeafId: step.fromLeafId,
          toLeafId: step.toLeafId,
          runtimeTargetLeafId: resolution.runtimeTargetLeafId,
          ...(resolution.boundary !== undefined ? { userMessageId: resolution.boundary.userMessageId } : {}),
        },
      });
      runtimePointerId = runtimeMove.pointerEntry.id;
    }

    return {
      changed: result.changed,
      ...(runtimePointerId !== undefined ? { runtimePointerId } : {}),
    };
  } catch (error) {
    throw new DaemonConversationRewindError(
      "REWIND_LEAF_MOVE_FAILED",
      `Conversation rewind session leaf move failed: ${errorMessage(error)}`
    );
  }
}

async function recordConversationRewindAudit(
  resolution: ConversationRewindApplyPlanResolution,
  stepResults: ConversationRewindApplyStepResult[],
  deps: SessionRewindDeps
): Promise<void> {
  await deps.orchestrator.recordConversationRewindAudit({
    sessionId: resolution.plan.sessionId,
    payload: {
      kind: "conversation-rewind-applied",
      source: resolution.source,
      plan: toJsonObject(resolution.plan),
      stepResults: stepResults.map(toJsonObject),
      ...(resolution.boundary !== undefined ? { boundary: toJsonObject(resolution.boundary) } : {}),
      ...(resolution.target !== undefined ? { target: toJsonObject(resolution.target) } : {}),
    },
  });
}

function sendConversationRewindError(
  ws: WebSocket,
  error: unknown,
  transport: SessionTransport,
  correlation?: DaemonCorrelationFields
): void {
  if (error instanceof DaemonConversationRewindError) {
    transport.sendError(ws, error.code, error.message, undefined, correlation);
    return;
  }
  transport.sendError(ws, "CONVERSATION_REWIND_ERROR", errorMessage(error), undefined, correlation);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Broadcast helpers (re-exported for server-handlers) ───

export function broadcastApprovalRequested(
  event: Extract<AgentEvent, { type: "approval-requested" }>,
  runId: string,
  approvalQueue: ApprovalQueue,
  transport: SessionTransport
): void {
  const snapshot = approvalQueue.getApproval(event.request.id);
  transport.broadcast({
    type: "approval-requested",
    runId,
    toolCallId: event.request.toolCallId,
    toolName: event.request.toolName,
    input: event.request.parameters as Record<string, unknown>,
    summary: event.request.summary,
    timeoutMs: snapshot?.timeoutMs ?? approvalQueue.getDefaultTimeoutMs(),
    expiresAt: snapshot?.expiresAt ?? null,
    remainingMs: snapshot?.remainingMs ?? null,
    ...approvalRiskFields(event.request.metadata),
  });
}

export function broadcastExpiredApprovalResolved(
  event: Extract<AgentEvent, { type: "approval-resolved" }>,
  transport: SessionTransport
): void {
  const decision = approvalDecisionFromRuntimeEvent(event);
  if (decision?.decision !== "expired") return;

  transport.broadcast({
    type: "approval-resolved",
    toolCallId: event.requestId,
    decision: "expired",
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    ...(decision.expiredAt !== undefined ? { expiredAt: decision.expiredAt } : {}),
  });
}

// ─── Session action receipt helper ─────────────────────────

import { SESSION_ACTION_PROTOCOL_VERSION, type SessionAction } from "@crish/shared-types";
import type { SessionActionReceiptMessage } from "../types.js";
import { SessionMetadataStoreError } from "../session-metadata-store.js";

async function createSessionActionReceipt(input: {
  action: SessionAction;
  orchestrator: AgentOrchestrator;
  metadataStore: FileSessionMetadataStore;
}): Promise<SessionActionReceiptMessage> {
  const { action, orchestrator, metadataStore } = input;

  if (!orchestrator.getSession(action.sessionId)) {
    return rejectedSessionActionReceipt(
      action,
      "session-not-found",
      `Session not found: ${action.sessionId}`
    );
  }

  if (action.kind === "open") {
    return {
      type: "session-action-receipt",
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      actionId: action.actionId,
      kind: action.kind,
      sessionId: action.sessionId,
      status: "committed",
      committedAt: new Date().toISOString(),
      resultingSessionId: action.sessionId,
    };
  }

  if (action.kind === "rewind") {
    return rejectedSessionActionReceipt(
      action,
      "unsupported",
      "SessionAction rewind is not executed through apply-session-action. Use apply-conversation-rewind with an explicit target or boundary selector."
    );
  }

  if (action.kind === "fork") {
    return rejectedSessionActionReceipt(
      action,
      "unsupported",
      "SessionAction fork requires a durable orchestrator/session-tree cloning contract; daemon metadata store does not fake forked history."
    );
  }

  try {
    await metadataStore.applyAction(action, patchForSessionAction(action));
    return {
      type: "session-action-receipt",
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      actionId: action.actionId,
      kind: action.kind,
      sessionId: action.sessionId,
      status: "committed",
      committedAt: new Date().toISOString(),
      resultingSessionId: action.sessionId,
    };
  } catch (error) {
    return rejectedSessionActionReceipt(
      action,
      error instanceof SessionMetadataStoreError ? error.code : "session-metadata-store-failed",
      `Session metadata mutation failed: ${errorMessage(error)}`
    );
  }
}

function patchForSessionAction(
  action: Exclude<SessionAction, Extract<SessionAction, { kind: "open" | "rewind" | "fork" }>>
): Parameters<FileSessionMetadataStore["applyAction"]>[1] {
  switch (action.kind) {
    case "pin":
      return { kind: "pin", pinned: true };
    case "unpin":
      return { kind: "pin", pinned: false };
    case "rename":
      return { kind: "rename", title: action.title };
    case "archive":
      return { kind: "archive", archived: true };
    case "unarchive":
      return { kind: "archive", archived: false };
    case "delete":
      return { kind: "delete", deleted: true };
  }
}

function rejectedSessionActionReceipt(
  action: SessionAction,
  errorCode: string,
  errorMsg: string
): SessionActionReceiptMessage {
  return {
    type: "session-action-receipt",
    protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
    actionId: action.actionId,
    kind: action.kind,
    sessionId: action.sessionId,
    status: "rejected",
    errorCode,
    errorMessage: errorMsg,
  };
}
