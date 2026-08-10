// =======================================================================
// mock daemon v0（R0-06）——夹具事件工厂
//
// 职责：按引擎事件信封（AgentEventEnvelope 扁平 JSON，`crates/conex-types/
// src/events.rs:905-1013` 序列化形态）构造夹具事件。每个工厂返回扁平对象
// `{ type, runId, schemaVersion, sessionId, ...事件字段 }`；`sequence` 由
// 发射器（server.emitEvent）注入，不在工厂内固定。
//
// 校验保证：所有夹具在发射前经 generated/device 出站自检 + 测试中对
// parseEngineEvent 断言，保证移动端解析不炸（与真实引擎逐字段同构）。
// 字段要求对齐 generated/engine 解析器（parseEngineEvent）的必填面。
// =======================================================================

import type { JsonValue } from '../../../../packages/shared-types/src/primitive-types';
import type { PermissionRequest } from '../../../../packages/shared-types/src/generated/engine/types';
import { nowIso } from '../util.js';

/** 引擎事件信封 schema 版本（events.rs EVENT_ENVELOPE_SCHEMA_VERSION） */
export const ENVELOPE_SCHEMA_VERSION = 1;

/** 扁平信封注入字段的公共骨架 */
interface FlatEnvelope {
  type: string;
  runId?: string;
  schemaVersion: number;
  sessionId: string;
  [k: string]: unknown;
}

function flat(type: string, sessionId: string, runId: string | undefined, fields: Record<string, unknown>): JsonValue {
  const env: FlatEnvelope = { type, schemaVersion: ENVELOPE_SCHEMA_VERSION, sessionId, ...fields };
  if (runId) env['runId'] = runId;
  return env as unknown as JsonValue;
}

/** 会话开始（run 生命周期头部） */
export function agentStart(sessionId: string, runId: string): JsonValue {
  return flat('agent-start', sessionId, runId, { timestamp: nowIso() });
}

/** 会话结束（reason ∈ stop/max-turns/aborted/error/stopped） */
export function agentEnd(sessionId: string, runId: string, reason = 'stop'): JsonValue {
  return flat('agent-end', sessionId, runId, { timestamp: nowIso(), reason });
}

/** 轮次开始 */
export function turnStart(sessionId: string, runId: string, turnIndex: number): JsonValue {
  return flat('turn-start', sessionId, runId, { timestamp: nowIso(), turnIndex });
}

/** 轮次结束 */
export function turnEnd(sessionId: string, runId: string, turnIndex: number, toolCallCount: number): JsonValue {
  return flat('turn-end', sessionId, runId, { timestamp: nowIso(), turnIndex, toolCallCount });
}

/** 消息增量（文本块；message-delta 按 M6 裁剪规则只放行 text 增量） */
export function messageDeltaText(sessionId: string, runId: string, messageId: string, text: string): JsonValue {
  return flat('message-delta', sessionId, runId, {
    timestamp: nowIso(),
    messageId,
    block: { type: 'text', text },
  });
}

/** 消息增量（思考块；M6 裁剪规则：thought 增量只更新 hasThinking，正文不出网） */
export function messageDeltaThought(sessionId: string, runId: string, messageId: string, redacted = true): JsonValue {
  return flat('message-delta', sessionId, runId, {
    timestamp: nowIso(),
    messageId,
    block: { type: 'thought', text: '', redacted },
  });
}

/**
 * 消息终态（message-end）：M6 摘要化规则——正文首 200 字符 + truncated=true；
 * thought 只传 hasThinking。夹具按该规则构造，与真实桌面出网形态一致。
 */
export function messageEnd(sessionId: string, runId: string, messageId: string, text: string, turnIndex?: number): JsonValue {
  const truncated = text.length > 200;
  const bodyText = truncated ? text.slice(0, 200) : text;
  const message = {
    id: messageId,
    role: 'assistant',
    createdAt: nowIso(),
    blocks: [
      { type: 'text', text: bodyText },
      { type: 'thought', text: '', redacted: true },
    ],
    ...(truncated ? { truncated: true } : {}),
  };
  const fields: Record<string, unknown> = { message };
  if (turnIndex !== undefined) fields['turnIndex'] = turnIndex;
  return flat('message-end', sessionId, runId, fields);
}

/** 工具调用开始（ToolBatchCall 必填面：id/toolName/summary/input/category/concurrency） */
export function toolStart(
  sessionId: string,
  runId: string,
  batchId: string,
  call: { id: string; toolName: string; summary: string; input: JsonValue; category: string; concurrency: string },
): JsonValue {
  return flat('tool-start', sessionId, runId, { timestamp: nowIso(), batchId, call });
}

/** 工具执行进度（终端流式输出片段） */
export function toolUpdate(sessionId: string, runId: string, batchId: string, toolCallId: string, text: string): JsonValue {
  return flat('tool-update', sessionId, runId, {
    timestamp: nowIso(),
    batchId,
    toolCallId,
    update: { text },
  });
}

/** 工具调用结束（ToolBatchResult 必填面） */
export function toolEnd(sessionId: string, runId: string, batchId: string, result: { id: string; toolName: string; output: JsonValue; isError: boolean; durationMs: number }): JsonValue {
  return flat('tool-end', sessionId, runId, { timestamp: nowIso(), batchId, result });
}

/** run 终态（terminal ∈ completed/cancelled/failed；error 仅终态失败时带） */
export function runTerminal(sessionId: string, runId: string, terminal: 'completed' | 'cancelled' | 'failed', error?: string): JsonValue {
  const fields: Record<string, unknown> = { timestamp: nowIso(), terminal };
  if (error !== undefined) fields['error'] = error;
  return flat('run-terminal', sessionId, runId, fields);
}

/**
 * 审批请求（approval-requested）：PermissionRequest 必填面全量；
 * M6 跨端裁剪在真实桌面做，夹具保持全字段（测试移动端裁剪侧可自行断言）。
 */
export function approvalRequested(sessionId: string, runId: string, request: PermissionRequest): JsonValue {
  return flat('approval-requested', sessionId, runId, { timestamp: nowIso(), request });
}

/** 审批结果（approval-resolved；decision ∈ approved/denied/expired） */
export function approvalResolved(sessionId: string, runId: string, toolCallId: string, decision: string, requestId?: string): JsonValue {
  const fields: Record<string, unknown> = { timestamp: nowIso(), toolCallId, decision };
  if (requestId !== undefined) fields['requestId'] = requestId;
  return flat('approval-resolved', sessionId, runId, fields);
}

/** 缓存统计（run 收口时发射；RunCacheStats 必填面） */
export function cacheStatsUpdated(sessionId: string, runId: string, stats: Record<string, number | undefined>): JsonValue {
  return flat('cache-stats-updated', sessionId, runId, { timestamp: nowIso(), stats });
}

/** 缓存浪费告警（cache-waste-alert；attribution ∈ 见 MISS_ATTRIBUTION_VALUES） */
export function cacheWasteAlert(sessionId: string, runId: string, attribution: string, missedTokens: number, idleMs: number, modelChanged: boolean, missedCostUsd?: number): JsonValue {
  const fields: Record<string, unknown> = { timestamp: nowIso(), attribution, missedTokens, idleMs, modelChanged };
  if (missedCostUsd !== undefined) fields['missedCostUsd'] = missedCostUsd;
  return flat('cache-waste-alert', sessionId, runId, fields);
}

/** 冷缓存预警（cold-cache-warning；必填面 ttlSeconds/idleMs/resendEstimateTokens） */
export function coldCacheWarning(sessionId: string, runId: string, ttlSeconds: number, idleMs: number, resendEstimateTokens: number): JsonValue {
  return flat('cold-cache-warning', sessionId, runId, { timestamp: nowIso(), ttlSeconds, idleMs, resendEstimateTokens });
}

/** 定时器触发（subscribeAll 白名单事件；sessionId 用伪 timer id） */
export function timerFired(timerId: string, prompt: string): JsonValue {
  return flat('timer-fired', `timer-${timerId}`, undefined, { timerId, prompt, firedAtMs: Date.now() });
}
