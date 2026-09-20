/**
 * chat-stream 事件分发段（G-03c 拆分）：onRunError 分级分发 + 子 agent 事件。
 *
 * - handleRunError：通道 E-B 展示唯一性（持久条 / 横幅+toast / 气泡卡），
 *   network 类返回 hadNetworkError 供调用方置 runEndedWithNetworkError 守卫；
 * - applySubagentStarted / applySubagentEvent / applySubagentEnded：
 *   协作子 agent 生命周期 → layout actions + 父工具卡状态。
 * 行为与原 useStreamCallbacks 内联实现逐条等价，不改流式语义与回调时序。
 */
import { getSessionById } from '../../store/sessionStore';
import type { SessionAgent } from '../../store/types';
import type { FileDiff } from '../../store/types';
import { clearStream, getStreamText } from '../../store/streamingStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import { reportRuntimeStatus } from '../../store/sessionRuntimeStatusStore';
import { recordStreamDiag } from '../../api/streamDiag';
import type { StreamCallbacks } from '../../api/chatApi';
import type { SessionStreamManager } from '../../api/sessionStreamManager';
import type { StreamRenderBuffer } from '../../api/StreamRenderBuffer';
import type { StreamToolCallPatch } from '../../api/streamTextBatcher';
import {
  resolveToolDiffs,
  sanitizeToolDisplayOutput,
} from '../../api/toolFeedback';
import { publishToolDiffsLazy, commitToolPatchToSession } from './helpers';
import {
  buildMessageIndex,
  resolveToolIdentity,
} from './streamCallbacksInternals';

type SubagentStartedInfo =
  NonNullable<StreamCallbacks['onSubagentStarted']> extends (
    info: infer T
  ) => void
    ? T
    : never;

type SubagentEventInfo =
  NonNullable<StreamCallbacks['onSubagentEvent']> extends (
    info: infer T
  ) => void
    ? T
    : never;

type SubagentEndedInfo =
  NonNullable<StreamCallbacks['onSubagentEnded']> extends (
    info: infer T
  ) => void
    ? T
    : never;

/** 子 agent 启动：侧栏 agent 行 upsert + 父工具卡「协作进行中」即时态。 */
export function applySubagentStarted(opts: {
  sid: string;
  info: SubagentStartedInfo;
  upsertSessionAgent: (sessionId: string, agent: SessionAgent) => void;
  queueToolCallPatch: (
    toolId: string,
    patch: StreamToolCallPatch,
    immediate?: boolean
  ) => void;
}): void {
  const { sid, info, upsertSessionAgent, queueToolCallPatch } = opts;
  if (!info.subagentId) return;
  const taskLabel = (info.description || '协作任务').trim() || '协作任务';
  upsertSessionAgent(sid, {
    id: info.subagentId,
    subagentRunId: info.subagentRunId,
    parentSessionId: sid,
    parentRunId: info.parentRunId,
    parentToolCallId: info.parentToolCallId,
    description: taskLabel,
    mode: info.mode || 'research',
    status: 'running',
    messages: [],
    startedAt: Date.now(),
  });
  if (info.parentToolCallId) {
    queueToolCallPatch(
      info.parentToolCallId,
      {
        id: info.parentToolCallId,
        status: 'running',
        output: '协作进行中…',
      },
      true
    );
  }
}

/** 子 agent 事件：T-E 步骤 3（U2）raw setState → applySubagentEventToAgent action。 */
export function applySubagentEvent(opts: {
  sid: string;
  info: SubagentEventInfo;
}): void {
  const { sid, info } = opts;
  if (!info.subagentId) return;
  getCompositionRoot()
    .session.getState()
    .applySubagentEventToAgent(sid, info.subagentId, info.event);
}

/** 子 agent 结束：T-E 步骤 3（U3）→ patchSessionAgentToolStatus action。 */
export function applySubagentEnded(opts: {
  sid: string;
  info: SubagentEndedInfo;
}): void {
  const { sid, info } = opts;
  if (!info.subagentId) return;
  //（agent 终态 + 时间线收口 + 父工具卡终态，与全局面 S3 共用同一 action）
  getCompositionRoot()
    .session.getState()
    .patchSessionAgentToolStatus(sid, info.subagentId, {
      status: info.status,
      ...(info.summary ? { summary: info.summary } : {}),
    });
}

/**
 * 审批结果（含完全访问自动放行）：allow → running 执行中；deny → error 未获批准。
 */
export function handleApprovalResolved(opts: {
  toolId: string;
  decision: 'allow' | 'deny';
  toolNames: Record<string, string>;
  queueToolCallPatch: (
    toolId: string,
    patch: StreamToolCallPatch,
    immediate?: boolean
  ) => void;
}): void {
  const { toolId, decision, toolNames, queueToolCallPatch } = opts;
  toolNames[toolId] = toolNames[toolId] || 'tool';
  if (decision === 'allow') {
    queueToolCallPatch(
      toolId,
      { id: toolId, status: 'running', output: '执行中…' },
      true
    );
  } else {
    queueToolCallPatch(
      toolId,
      { id: toolId, status: 'error', output: '未获批准' },
      true
    );
  }
}

/**
 * 工具成功：持久行 name/args 补全（工具身份三级索引链）+ diffs 发布 + 终端回显。
 */
export function handleToolSuccess(opts: {
  sid: string;
  assistantMsgId: string;
  toolId: string;
  output: string;
  diffs: FileDiff[] | undefined;
  toolNames: Record<string, string>;
  durationMs?: number;
  queueToolCallPatch: (
    toolId: string,
    patch: StreamToolCallPatch,
    immediate?: boolean
  ) => void;
}): void {
  const {
    sid,
    assistantMsgId,
    toolId,
    output,
    diffs,
    toolNames,
    durationMs: explicitDurationMs,
    queueToolCallPatch,
  } = opts;
  const { name, args } = resolveToolIdentity({
    toolNames,
    sid,
    assistantMsgId,
    toolId,
  });
  const displayOut = sanitizeToolDisplayOutput(output || '');
  const resolvedDiffs = resolveToolDiffs({
    name,
    args,
    output: displayOut,
    structuredDiffs: diffs,
  });
  const existingTc = buildMessageIndex(getSessionById(sid))
    .get(assistantMsgId)
    ?.toolCalls?.find((t) => t.id === toolId);
  const startedAt = existingTc?.startedAt;
  const durationMs =
    typeof explicitDurationMs === 'number' && explicitDurationMs >= 0
      ? explicitDurationMs
      : startedAt && startedAt > 0
        ? Math.max(0, Date.now() - startedAt)
        : undefined;

  const toolPatch: StreamToolCallPatch = {
    id: toolId,
    ...(name ? { name } : {}),
    status: 'success',
    output: displayOut || output || '完成',
    diffs: resolvedDiffs.length ? resolvedDiffs : undefined,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
  commitToolPatchToSession(sid, assistantMsgId, toolId, toolPatch);
  queueToolCallPatch(toolId, toolPatch, true);
  if (resolvedDiffs.length > 0) {
    publishToolDiffsLazy(resolvedDiffs);
  }
}

/** 工具失败：终态 error patch */
export function handleToolError(opts: {
  sid: string;
  toolId: string;
  error: string;
  toolNames: Record<string, string>;
  assistantMsgId?: string;
  durationMs?: number;
  queueToolCallPatch: (
    toolId: string,
    patch: StreamToolCallPatch,
    immediate?: boolean
  ) => void;
}): void {
  const {
    sid,
    toolId,
    error,
    queueToolCallPatch,
    assistantMsgId,
    durationMs: explicitDurationMs,
  } = opts;
  let durationMs: number | undefined =
    typeof explicitDurationMs === 'number' && explicitDurationMs >= 0
      ? explicitDurationMs
      : undefined;
  let startedAt: number | undefined;
  if (assistantMsgId) {
    const existingTc = buildMessageIndex(getSessionById(sid))
      .get(assistantMsgId)
      ?.toolCalls?.find((t) => t.id === toolId);
    startedAt = existingTc?.startedAt;
    if (durationMs === undefined && startedAt && startedAt > 0) {
      durationMs = Math.max(0, Date.now() - startedAt);
    }
  }
  const clean = sanitizeToolDisplayOutput(error || '');
  const toolPatch: StreamToolCallPatch = {
    id: toolId,
    status: 'error',
    output: clean || error || '失败',
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
  if (assistantMsgId) {
    commitToolPatchToSession(sid, assistantMsgId, toolId, toolPatch);
  }
  queueToolCallPatch(toolId, toolPatch, true);
}

/**
 * onRunError 单轨分发（docs/chat-notice-convergence §2.0/§2.3）：
 * 所有终态错误（含 network）唯一承载体 = SessionRuntimeStatusStore failed 相位
 * （ComposerErrorBar）。不写 toast / 横幅 / 气泡 errorDetail。
 *
 * 消息状态收口（错误即本轮终态，不依赖随后是否还有 onComplete）：
 * - user 消息 processing → completed（否则 isProcessing 恒真，发送按钮被 Stop 常驻）；
 * - assistant 零正文 → withdraw 占位；有正文 → 状态置 error（正文保留，历史可见「回复中断」）。
 * 返回 hadNetworkError 供调用方置 runEndedWithNetworkError 守卫。
 */
export function handleRunError(opts: {
  wsId: string;
  sid: string;
  userMsgId: string;
  assistantMsgId: string;
  runId: string | null;
  message: string;
  kind: string | undefined;
  detail: string | undefined;
  flushStreamBatchers: () => void;
  refs: {
    renderBuffer: StreamRenderBuffer | null;
    streamManager?: SessionStreamManager | null;
    generationMap: Map<string, number>;
  };
}): { hadNetworkError: boolean } {
  const {
    wsId,
    sid,
    userMsgId,
    assistantMsgId,
    runId,
    message,
    kind,
    detail,
    flushStreamBatchers,
    refs,
  } = opts;
  const asstErr = buildMessageIndex(getSessionById(sid)).get(assistantMsgId);
  const lastToolErr = (asstErr?.toolCalls || []).findLast(Boolean);
  recordStreamDiag({
    sessionId: sid,
    runId: runId || undefined,
    scope: kind || 'run-error',
    kind: kind || 'error',
    message,
    raw: detail || message,
    context: {
      lastTool: lastToolErr?.name ?? null,
      lastToolStatus: lastToolErr?.status ?? null,
      toolCount: asstErr?.toolCalls?.length ?? 0,
    },
  });
  const hadText = !!(
    (asstErr?.text || '').trim() || getStreamText(sid, assistantMsgId)?.trim()
  );
  const st = getCompositionRoot().session.getState();
  const isNetwork = kind === 'network';

  if (asstErr) {
    if (!hadText) {
      // 零 Token 失败：彻底撤回预置的空白 assistant 消息，不留幽灵占位
      st.withdrawMessage(wsId, sid, assistantMsgId);
      clearStream(sid, assistantMsgId);
    } else {
      // 有正文：正文保留，状态置 error（事实记录；行动入口在 ComposerErrorBar）
      st.setSessionMessageStatus(sid, assistantMsgId, 'error');
    }
  }
  // 本轮 user 消息收口：错误是终态，不再等待 onComplete
  const userMsg = buildMessageIndex(getSessionById(sid)).get(userMsgId);
  if (userMsg?.status === 'processing') {
    st.setSessionMessageStatus(sid, userMsgId, 'completed');
  }

  const validKinds = [
    'network',
    'rate_limit',
    'auth',
    'quota',
    'context_length',
    'server_error',
    'stream_abort',
  ] as const;
  const resolvedKind =
    kind && (validKinds as readonly string[]).includes(kind)
      ? (kind as (typeof validKinds)[number])
      : 'generic';

  // 全局唯一上报入口（docs/chat-notice-convergence §2.0）：
  // network 与其余终态错误统一进 failed 相位（ComposerErrorBar 唯一承载体）。
  // 只记录消息定位，不缓存提问文本——重试按 userMsgId 现查。
  reportRuntimeStatus({
    type: 'failed',
    sessionId: sid,
    kind: resolvedKind,
    message: message || '服务暂时不可用，请检查网络或后端配置',
    technicalDetail: typeof detail === 'string' ? detail : undefined,
    turn: { userMsgId, assistantMsgId },
  });

  flushStreamBatchers();
  // R-11（08-detail T5.4）：error 收口补清理——先预算刷残余帧
  //（避免残余文本被 gen 守卫丢弃），再按 complete 同语义删 gen
  //（entry 匹配守卫：被新 run 接管时不误删新 run 的 generationMap）
  refs.renderBuffer?.flush(false);
  const errCur = refs.streamManager?.get(sid);
  if (errCur?.assistantMsgId === assistantMsgId) {
    refs.generationMap.delete(sid);
  }
  return { hadNetworkError: isNetwork };
}
