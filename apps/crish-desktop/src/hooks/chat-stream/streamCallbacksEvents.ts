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
import { useEphemeralChatStore } from '../../store/ephemeralChatStore';
import { recordStreamDiag } from '../../api/streamDiag';
import { toast } from '../../services/toast/ToastContext';
import type { StreamCallbacks } from '../../api/chatApi';
import type { SessionStreamManager } from '../../api/sessionStreamManager';
import type { StreamRenderBuffer } from '../../api/StreamRenderBuffer';
import type { StreamToolCallPatch } from '../../api/streamTextBatcher';
import {
  resolveToolDiffs,
  sanitizeToolDisplayOutput,
} from '../../api/toolFeedback';
import { publishToolDiffsLazy } from './helpers';
import {
  buildMessageIndex,
  resolveToolIdentity,
} from './streamCallbacksInternals';
import { resolveRunErrorSurface } from './streamCallbacksSurfaces';
import type { RunNotice } from './types';

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

  queueToolCallPatch(
    toolId,
    {
      id: toolId,
      ...(name ? { name } : {}),
      status: 'success',
      output: displayOut || output || '完成',
      diffs: resolvedDiffs.length ? resolvedDiffs : undefined,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
    },
    true
  );
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
  queueToolCallPatch(
    toolId,
    {
      id: toolId,
      status: 'error',
      output: clean || error || '失败',
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
    },
    true
  );
}

/**
 * onRunError 分级分发（通道 E-B）：按分类选展示面，一次错误只占一个瞬时面；
 * 持久条与横幅/toast 互斥（persistent 无 TTL，恢复驱动消失）。
 * 返回 hadNetworkError 供调用方置 runEndedWithNetworkError 守卫。
 */
export function handleRunError(opts: {
  wsId: string;
  sid: string;
  assistantMsgId: string;
  runId: string | null;
  message: string;
  kind: string | undefined;
  detail: string | undefined;
  pushRunNotice: (notice: RunNotice, ttlMs?: number) => void;
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
    assistantMsgId,
    runId,
    message,
    kind,
    detail,
    pushRunNotice,
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
  const surface = resolveRunErrorSurface(kind, hadText);
  const notice: RunNotice = {
    text: message,
    kind: kind || 'error',
    detail: detail || undefined,
  };
  let hadNetworkError = false;
  const st = getCompositionRoot().session.getState();
  if (surface === 'persistent') {
    // network/恢复类：仅输入框上方持久条；不进 toast、不写气泡
    hadNetworkError = true;
    pushRunNotice({ ...notice, persistent: true });
  } else if (surface === 'banner-toast') {
    // 可行动错误（blocked/auth/no_key/no_project）：横幅 + 一次性 toast
    pushRunNotice(notice, 14000);
    toast.show(message);
  } else if (surface === 'banner') {
    // 无正文的失败：仅横幅（14s TTL），无 toast
    pushRunNotice(notice, 14000);
  }

  if (asstErr) {
    if (surface === 'persistent') {
      // network/恢复类：不写气泡错误卡；无正文时 withdraw 占位（保持现状）
      if (!hadText) {
        st.withdrawMessage(wsId, sid, assistantMsgId);
        clearStream(sid, assistantMsgId);
      }
    } else if (!hadText) {
      // 零 Token 失败：彻底撤回预置的空白 assistant 消息，不留幽灵占位
      st.withdrawMessage(wsId, sid, assistantMsgId);
      clearStream(sid, assistantMsgId);
    } else {
      st.setSessionMessageStatus(sid, assistantMsgId, 'error', undefined, {
        errorDetail: {
          message: message || '服务暂时不可用，请检查网络或后端配置',
          kind: kind || 'stream-error',
          technical:
            typeof detail === 'string'
              ? detail
              : detail
                ? JSON.stringify(detail)
                : undefined,
        },
      });
    }
  }

  // 提取当轮真实提问文本与用户消息 ID，保障失败重试闭环
  const lastUserMsg = st?.sessionsById?.[sid]?.messages?.findLast(
    (m) => m.sender === 'user'
  );

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

  useEphemeralChatStore.getState().setEphemeralStatus(sid, {
    id: `err-${sid}-${assistantMsgId}`,
    messageId: assistantMsgId,
    kind: resolvedKind,
    message: message || '服务暂时不可用，请检查网络或后端配置',
    technicalDetail: typeof detail === 'string' ? detail : undefined,
    retryable: true,
    timestamp: Date.now(),
    retryContext: {
      userMsgId: lastUserMsg?.id,
      promptText: lastUserMsg?.text,
    },
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
  return { hadNetworkError };
}
