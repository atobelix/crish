import { collectRuntimeMetricsSnapshot } from "@crish/agent-runtime";
import type { OrchestratorRunRecord } from "@crish/agent-orchestrator";
import type { DaemonTaskSnapshot } from "../types.js";
import {
  EVENT_HANDLERS,
  createCtx,
  readLatestRunRecord,
  cleanMessage,
  titleFromPrompt,
  type SnapshotBuildContext,
  type BuildDaemonTaskSnapshotInput,
} from "./event-handlers.js";

export type { BuildDaemonTaskSnapshotInput, SnapshotBuildContext };

export function buildDaemonTaskSnapshot(input: BuildDaemonTaskSnapshotInput): DaemonTaskSnapshot {
  const events = [...input.events].sort((l, r) => l.sequence - r.sequence);
  const run = input.run ?? readLatestRunRecord(events);
  const ctx = createCtx(events, run);
  for (const event of events) {
    ctx.state.updatedAt = event.timestamp;
    EVENT_HANDLERS[event.type]?.(event, ctx);
  }
  return assembleSnapshot(ctx, run, input.run);
}

function assembleSnapshot(ctx: SnapshotBuildContext, run: OrchestratorRunRecord | undefined, inputRun: OrchestratorRunRecord | undefined): DaemonTaskSnapshot {
  for (const draft of ctx.drafts.values()) {
    if (draft.content || draft.toolCalls?.length) ctx.messages.push(draft);
  }
  const metrics = collectRuntimeMetricsSnapshot(ctx.runtimeEvents);
  return {
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    status: inputRun?.status ?? ctx.state.status,
    title: titleFromPrompt(ctx.prompt, ctx.runId),
    messages: ctx.messages.map(cleanMessage),
    latestError: run?.error ?? ctx.state.latestError,
    approval: [...ctx.approvals.values()].at(-1),
    pendingToolCalls: [...ctx.pendingToolCalls.values()],
    backgroundTasks: [...ctx.backgroundTasks.values()],
    progress: {
      label: ctx.state.progressLabel,
      eventCount: metrics.eventCount,
      turnCount: metrics.turnCount,
      textDeltaCount: metrics.streaming.textDeltaCount,
      toolCallCount: metrics.tools.callCount + ctx.pendingToolCalls.size,
      completedToolCallCount: metrics.tools.callCount,
      pendingToolCallCount: ctx.pendingToolCalls.size,
      approvalPending: ctx.approvals.size > 0,
      updatedAt: run?.updatedAt ?? ctx.state.updatedAt,
    },
    usage: {
      sampleCount: metrics.providerUsage.sampleCount,
      promptTokens: metrics.providerUsage.promptTokens,
      completionTokens: metrics.providerUsage.completionTokens,
      totalTokens: metrics.providerUsage.totalTokens,
      reasoningTokens: metrics.providerUsage.reasoningTokens,
    },
    cache: {
      sampleCount: metrics.cache.sampleCount,
      promptTokens: metrics.cache.promptTokens,
      readTokens: metrics.cache.readTokens,
      writeTokens: metrics.cache.writeTokens,
      missTokens: metrics.cache.missTokens,
      hitRatio: metrics.cache.hitRatio,
      writeRatio: metrics.cache.writeRatio,
      stablePrefixHash: metrics.latestDimensions?.stablePrefixHash,
      cacheKey: metrics.latestDimensions?.cacheKey,
      cacheStrategy: metrics.latestDimensions?.cacheStrategy,
    },
    updatedAt: run?.updatedAt ?? ctx.state.updatedAt,
    progressLabel: ctx.state.progressLabel,
    currentRun: {
      id: ctx.runId,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      createdAt: run?.createdAt ?? ctx.firstEventTimestamp ?? ctx.state.updatedAt,
      updatedAt: run?.updatedAt ?? ctx.state.updatedAt,
      startedAt: run?.startedAt,
      finishedAt: run?.finishedAt,
      metadata: ctx.metadata,
    },
  };
}
