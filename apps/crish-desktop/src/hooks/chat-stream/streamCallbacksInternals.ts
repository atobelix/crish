/**
 * chat-stream 流回调内部实现：run 收口 / 完成状态 / 工具队列的纯函数段。
 *
 * - msgId→message Map 索引（B6 O(1) 化：替代对 messages 的逐次 `.find(`）；
 * - finishComplete 的收口子逻辑（行为与原 useStreamCallbacks 内联实现逐条
 *   等价，仅按逻辑块拆分，不改流式语义与回调时序）。
 * 事件分发（onRunError / 子 agent）→ streamCallbacksEvents.ts；
 * usage 消费（快照回填 / approx 兜底）→ streamCallbacksUsage.ts。
 */
import { getSessionById } from '../../store/sessionStore';
import type { SessionMessage } from '../../store/types';
import type {
  MessageToolApprovalMeta,
  MessageToolCall,
} from '../../store/types';
import { getStreamText, getStreamTool } from '../../store/streamingStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import { recordStreamDiag } from '../../api/streamDiag';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import { checkAndAlertSilentComplete } from '../../api/silentComplete';
import { buildGoalRunTaskFields } from '../../api/goalModeController';
import {
  streamBatchKey,
  streamToolBatchKey,
  isImmediateToolStatus,
} from '../../api/streamTextBatcher';
import type {
  StreamToolCallPatch,
  StreamValueBatcher,
} from '../../api/streamTextBatcher';
import type { StreamRequestOptions } from '../../api/chatApi';
import type { SessionStreamManager } from '../../api/sessionStreamManager';
import type { MutableRefObject } from 'react';
import {
  commitStreamToSession,
  snapshotStreamTextToSession,
  isLiveStreamRun,
} from './helpers';
import { markStreamingActive } from '../../api/streamStop';
import type { RunNotice } from './types';

/** msgId → message 索引（O(1) 查表替代逐次 find）。 */
export type MessageIndex = ReadonlyMap<string, SessionMessage>;

export function buildMessageIndex(
  sess: { messages?: SessionMessage[] | null } | null | undefined
): MessageIndex {
  const msgs = sess?.messages;
  const index = new Map<string, SessionMessage>();
  if (msgs) {
    for (const m of msgs) index.set(m.id, m);
  }
  return index;
}

/** 工具身份解析（onToolSuccess 补全持久行）：三级合并链，全部 O(1) 查表。 */
export function resolveToolIdentity(opts: {
  toolNames: Record<string, string>;
  sid: string;
  assistantMsgId: string;
  toolId: string;
}): { name: string; args: string } {
  const { toolNames, sid, assistantMsgId, toolId } = opts;
  const live = getStreamTool(sid, assistantMsgId, toolId);
  const asst = buildMessageIndex(getSessionById(sid)).get(assistantMsgId);
  const toolIndex = new Map<string, MessageToolCall>();
  for (const t of asst?.toolCalls || []) toolIndex.set(t.id, t);
  const persisted = toolIndex.get(toolId);
  const name = toolNames[toolId] || live?.name || persisted?.name || '';
  const args = live?.arguments || persisted?.arguments || '';
  return { name, args };
}

/**
 * 空回复横幅裁决 + 展示动作（push 弹提示 / dismiss 清 TTL 横幅）。
 * network 错误收口时守卫：持久条已承载错误，不重复弹横幅。
 */
export function decideEmptyRunNotice(opts: {
  asst: SessionMessage | undefined;
  committedText: string;
  gotRealText: boolean;
  runEndedWithNetworkError: boolean;
  pushRunNotice: (notice: RunNotice, ttlMs?: number) => void;
  dismissTransientRunNotice: () => void;
}): void {
  const {
    asst,
    committedText,
    gotRealText,
    runEndedWithNetworkError,
    pushRunNotice,
    dismissTransientRunNotice,
  } = opts;
  if (runEndedWithNetworkError) return;
  if (asst && !gotRealText && !(asst.text || committedText || '').trim()) {
    const hasTools = (asst.toolCalls || []).some(
      (t: MessageToolCall) =>
        t.status === 'success' || t.status === 'error' || t.status === 'running'
    );
    if (!hasTools) {
      pushRunNotice(
        {
          text: '这一轮没有文字回复。若刚改过配置，请检查模型与网络。',
          kind: 'empty',
        },
        6000
      );
    } else {
      dismissTransientRunNotice();
    }
    return;
  }
  if (gotRealText || (asst?.text || committedText || '').trim()) {
    dismissTransientRunNotice();
  }
}

/**
 * complete 收口第一步：一次性 durable commit 全文 + 耗时/diag 微任务。
 * 返回 committedText / elapsed / asst 供后续收口步骤消费。
 */
export function commitRunCompletion(opts: {
  sid: string;
  assistantMsgId: string;
  buffer: { currentText: () => string } | null;
  streamedFullText: string;
  startTime: number;
  runId: string | null;
  gotRealText: boolean;
}): {
  committedText: string;
  elapsed: number;
  asst: SessionMessage | undefined;
} {
  const {
    sid,
    assistantMsgId,
    buffer,
    streamedFullText,
    startTime,
    runId,
    gotRealText,
  } = opts;
  const committedText = commitStreamToSession(sid, assistantMsgId, {
    text:
      buffer?.currentText() ||
      getStreamText(sid, assistantMsgId) ||
      streamedFullText ||
      '',
  });
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const asst = buildMessageIndex(getSessionById(sid)).get(assistantMsgId);
  const lastTool = (asst?.toolCalls || []).findLast(Boolean);
  const runningLeft = (asst?.toolCalls || []).filter(
    (t: MessageToolCall) => t.status === 'running'
  ).length;
  queueMicrotask(() => {
    recordStreamDiag({
      sessionId: sid,
      runId: runId || undefined,
      scope: 'run-complete',
      kind: 'complete',
      message: runningLeft
        ? `流已收口，但仍有 ${runningLeft} 个工具显示运行中`
        : '流正常收口',
      context: {
        lastTool: lastTool?.name ?? null,
        lastToolStatus: lastTool?.status ?? null,
        toolCount: asst?.toolCalls?.length ?? 0,
        gotRealText,
        elapsedSec: elapsed,
      },
    });
  });
  return { committedText, elapsed, asst };
}

/**
 * complete 收口第二步：正文/思考占位清理 + 时间线收口 + 最终 HTML 调度。
 * 返回预清理后的最终正文（N6 单次化，helpers 不再二次 strip）。
 */
export function finalizeAssistantMessageText(opts: {
  sid: string;
  assistantMsgId: string;
  committedText: string;
  streamedFullText: string;
  scheduleRunFinalHtml: (fullText: string) => void;
  thinkingBatcher: { drop: (key: string) => void } | null | undefined;
}): string {
  const {
    sid,
    assistantMsgId,
    committedText,
    streamedFullText,
    scheduleRunFinalHtml,
    thinkingBatcher,
  } = opts;
  const st = getCompositionRoot().session.getState();
  let finalTextForHtml = '';
  try {
    const latest = buildMessageIndex(getSessionById(sid)).get(assistantMsgId);
    const raw = latest?.text || committedText || streamedFullText || '';
    const cleaned = stripThoughtPlaceholders(raw);
    if (cleaned !== raw) {
      st.updateMessageText(sid, assistantMsgId, cleaned);
    }
    finalTextForHtml = cleaned || raw;
    const th = latest?.thinking || '';
    if (th === '正在处理…' || th === '正在思考中...') {
      thinkingBatcher?.drop(streamBatchKey(sid, assistantMsgId));
      st.updateMessageThinking(sid, assistantMsgId, '');
    }
    // T-E 步骤 3（U4）：raw setState → updateMessageTimeline action
    getCompositionRoot()
      .session.getState()
      .updateMessageTimeline(sid, assistantMsgId);
  } catch {
    /* ignore */
  }
  // N6 单次化：finalTextForHtml 已预清理，helpers 不再二次 strip
  scheduleRunFinalHtml(finalTextForHtml);
  return finalTextForHtml;
}

/**
 * complete 收口第三步：user/assistant 状态置 completed（仅 processing 态转换）
 * + D2-5 silent complete 终态检测（微任务，重读最新状态）。
 */
export function finalizeRunCompletionStatuses(opts: {
  sid: string;
  userMsgId: string;
  assistantMsgId: string;
  elapsed: number;
  runId: string | null;
}): void {
  const { sid, userMsgId, assistantMsgId, elapsed, runId } = opts;
  const st = getCompositionRoot().session.getState();
  const index = buildMessageIndex(getSessionById(sid));
  const latestUserMsg = index.get(userMsgId);
  const latestAssistantMsg = index.get(assistantMsgId);
  // 只在消息仍处于 processing 时标记完成；error/cancelled 等终态保持原状，
  // 避免触发 error → completed 这类非法状态转换。
  if (latestUserMsg?.status === 'processing') {
    st.setSessionMessageStatus(sid, userMsgId, 'completed');
  }
  if (latestAssistantMsg?.status === 'processing') {
    st.setSessionMessageStatus(sid, assistantMsgId, 'completed', elapsed);
  }
  // D2-5：终态后检测 silent complete（无用户可见正文/工具）；
  // T2.3 主块瘦身：移出同步主块（微任务）
  queueMicrotask(() => {
    try {
      const finalizedAsst = buildMessageIndex(getSessionById(sid)).get(
        assistantMsgId
      );
      checkAndAlertSilentComplete(finalizedAsst, {
        sessionId: sid,
        runId: runId || undefined,
        messageId: assistantMsgId,
      });
    } catch {
      /* ignore alert failures */
    }
  });
}

/** run 生命周期共享状态（run 钩子 + onComplete 分发共用，替代裸 let）。 */
export type StreamRunState = {
  runClosed: boolean;
  draining: boolean;
};

/**
 * onComplete 分发（T2.2 drain 语义 + 预算式收口触发）：
 * - 已被新 run 接管 → 置 runClosed，不碰 streamingActive；
 * - 否则置 draining，同步释放 streamManager entry，flushFinal 后无残余同步收口。
 */
export function createCompleteHandler(opts: {
  sid: string;
  assistantMsgId: string;
  state: StreamRunState;
  refs: {
    streamManagerRef: MutableRefObject<SessionStreamManager | null>;
  };
  flushStreamBatchers: () => void;
  finishComplete: () => void;
  buffer: { bufferedLength: () => number; flushFinal: () => void };
}): () => void {
  const {
    sid,
    assistantMsgId,
    state,
    refs,
    flushStreamBatchers,
    finishComplete,
    buffer,
  } = opts;
  const onComplete = () => {
    if (state.runClosed) return;
    if (
      !isLiveStreamRun(refs.streamManagerRef.current?.get(sid), assistantMsgId)
    ) {
      state.runClosed = true;
      // Replaced by a newer run — that run owns streamingActive; do not clear.
      return;
    }
    // T2.2（08-detail 3.2）：drain 标志放宽——不置 runClosed，分帧 drain
    // 期间中间帧照常 setStreamText（UI 以预算节奏自然流完，无「停一下再出
    // 最终版」跳跃感）；isFinal 帧到达后由 finishComplete 收口。
    state.draining = true;
    markStreamingActive(false);
    // streamManager entry 同步释放：L1 follow_up 拒绝窗口以 streamManager
    // 为门，drain 期间新发送可入队不误拒；generationMap 保留到
    // finishComplete（drain 中间帧需通过 myGen 守卫）。
    const curStream = refs.streamManagerRef.current?.get(sid);
    if (curStream?.assistantMsgId === assistantMsgId) {
      refs.streamManagerRef.current?.delete(sid);
    }
    const hadPending = buffer.bufferedLength() > 0;
    // 预算式收口（T2.1 flushFinal）：≤2 帧同步刷完（isFinal 帧同步到达 →
    // finishComplete 同步执行）；大残余走 rAF 预算循环。
    buffer.flushFinal();
    flushStreamBatchers();
    // 无残余：isFinal 帧不会到达 → 同步收口（finishComplete 幂等）
    if (!hadPending) finishComplete();
  };
  return onComplete;
}

/** 目标模式选项合并：goal run-task 字段 + assistant clientMessageId 覆盖。 */
export function buildGoalStreamOptions(opts: {
  sid: string;
  assistantMsgId: string;
  streamOptions?: StreamRequestOptions;
}): StreamRequestOptions {
  const { sid, assistantMsgId, streamOptions } = opts;
  const liveGm = getSessionById(sid)?.goalMode;
  const goalOpts =
    !liveGm?.active || !(liveGm.goal || '').trim()
      ? undefined
      : buildGoalRunTaskFields({
          goal: liveGm.goal,
          maxIterations: liveGm.maxIterations ?? 5,
        });
  // 助手 placeholder 幂等键始终下发；用户 clientMessageId 由 send 路径注入 options
  return {
    ...(streamOptions ?? {}),
    ...(goalOpts ?? {}),
    assistantClientMessageId:
      streamOptions?.assistantClientMessageId || assistantMsgId,
  };
}

/**
 * 工具 patch 队列工厂：running/pending 走 lite store（budget 节奏 flush），
 * 即时状态（success/error/pending_approval）直通 flushNow；快照写入不丢块。
 */
export function createToolPatchQueue(opts: {
  sid: string;
  assistantMsgId: string;
  toolNames: Record<string, string>;
  assertLive: () => boolean;
  readStreamedFullText: () => string;
  toolBatcher: StreamValueBatcher<StreamToolCallPatch> | null;
}): {
  queueToolCallPatch: (
    toolId: string,
    patch: StreamToolCallPatch,
    immediate?: boolean
  ) => void;
  upsertToolCall: (
    toolId: string,
    name: string,
    args: string | undefined,
    explanation: string | undefined,
    status: 'running' | 'pending_approval',
    approvalMeta?: MessageToolApprovalMeta
  ) => void;
} {
  const {
    sid,
    assistantMsgId,
    toolNames,
    assertLive,
    readStreamedFullText,
    toolBatcher,
  } = opts;
  const queueToolCallPatch = (
    toolId: string,
    patch: StreamToolCallPatch,
    immediate = false
  ) => {
    if (!assertLive()) return;
    const key = streamToolBatchKey(sid, assistantMsgId, toolId);
    toolBatcher?.push(key, patch);
    if (immediate || isImmediateToolStatus(patch.status)) {
      try {
        toolBatcher?.flushNow();
      } catch {
        /* ignore */
      }
    }
  };
  const upsertToolCall = (
    toolId: string,
    name: string,
    args: string | undefined,
    explanation: string | undefined,
    status: 'running' | 'pending_approval',
    approvalMeta?: MessageToolApprovalMeta
  ) => {
    // Durable text snapshot before tool so blocks/streamTextOffset interleave correctly.
    snapshotStreamTextToSession(sid, assistantMsgId, readStreamedFullText());
    toolNames[toolId] = name;
    queueToolCallPatch(
      toolId,
      {
        id: toolId,
        name,
        arguments: args,
        explanation,
        status,
        ...(approvalMeta ? { approvalMeta } : {}),
      },
      status === 'pending_approval'
    );
  };
  return { queueToolCallPatch, upsertToolCall };
}
