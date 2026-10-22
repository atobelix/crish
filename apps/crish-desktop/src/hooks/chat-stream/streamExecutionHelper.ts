/**
 * chat-stream 流式执行与收口纯辅助函数（streamExecutionHelper）。
 *
 * 封装并发流冲突检测、Markdown HTML 单次调度、思考占位清理与完成终态收口逻辑。
 */
import type { MutableRefObject } from 'react';
import type { StreamTextBatcher } from '../../api/streamTextBatcher';
import type { SessionStreamManager } from '../../api/sessionStreamManager';
import type { SessionMessage } from '../../store/types';
import { getSessionById } from '../../store/sessionStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import { markStreamingActive } from '../../api/streamStop';
import { scheduleFinalMarkdownHtml, buildTerminalToolPatches } from './helpers';
import { streamBatchKey } from '../../api/streamTextBatcher';
import { getStreamThinking } from '../../store/streamingStore';
import {
  commitRunCompletion,
  decideEmptyRunNotice,
  finalizeAssistantMessageText,
  finalizeRunCompletionStatuses,
} from './streamRunCompletion';
import { type StreamRunState } from './streamCallbacksInternals';
import { applyRunUsageSnapshot } from './streamCallbacksUsage';
import { maybeRequestAiSessionTitle } from '../../api/sessionAiTitle';

/**
 * 检查当前会话是否已有正在运行的流。
 * 若存在活动流，则将当前 user 消息置为 queued 状态并提示警告，阻止重复启动。
 */
export function handleStreamConflict(
  sid: string,
  userMsgId: string,
  streamManager: SessionStreamManager | null | undefined
): boolean {
  const prevStream = streamManager?.get(sid);
  if (!prevStream) return false;

  try {
    const st = getCompositionRoot().session.getState();
    const userMsg = getSessionById(sid)?.messages?.find(
      (m: SessionMessage) => m.id === userMsgId
    );
    if (userMsg?.sender === 'user' && userMsg.status === 'processing') {
      // processing → queued 属于守卫表中的 force 转换（串行守卫 S7 自动排队）；
      // 不带 force 会被 validateStatusTransition 拒绝，消息卡在 processing。
      st.setSessionMessageStatus(sid, userMsgId, 'queued', undefined, {
        force: true,
      });
    }
  } catch {
    /* ignore */
  }
  console.warn(
    '[runStreamingAssistant] refuse start while stream live (L1 follow_up, no abort)',
    sid,
    userMsgId
  );
  return true;
}

/**
 * 构造针对单次 assistant 运行的 Markdown HTML 调度器（单次触发，防止重复调度）。
 */
export function createFinalHtmlScheduler(
  sid: string,
  assistantMsgId: string
): (fullText: string) => void {
  let finalHtmlScheduled = false;
  return (fullText: string) => {
    if (finalHtmlScheduled || !(fullText || '').trim()) return;
    finalHtmlScheduled = true;
    scheduleFinalMarkdownHtml(sid, assistantMsgId, fullText, {
      preCleaned: true,
    });
  };
}

/**
 * 当接收到有效文本 chunk 时，如果占位思考仍为初始提示词且无真实思考流，则清理思考占位符。
 */
export function handleThinkingResetOnChunk(
  sid: string,
  assistantMsgId: string,
  thinkingBatcher: StreamTextBatcher | null | undefined
): void {
  // 1. 关键防御：优先检查轻量 streamingStore 中是否已有实时思考内容
  const liveThinking = getStreamThinking(sid, assistantMsgId);
  if (
    liveThinking &&
    liveThinking.trim() &&
    liveThinking !== '正在处理…' &&
    liveThinking !== '正在思考中...'
  ) {
    // 已有真实思考内容流出，严禁 drop 批合并器与抹除思考！
    return;
  }

  // 2. 检查持久化 sessionStore 中的占位状态
  const cur = getSessionById(sid)?.messages?.find(
    (m: SessionMessage) => m.id === assistantMsgId
  );
  if (cur?.thinking === '正在处理…' || cur?.thinking === '正在思考中...') {
    const key = streamBatchKey(sid, assistantMsgId);
    if (!thinkingBatcher?.hasPending(key)) {
      thinkingBatcher?.drop(key);
      getCompositionRoot()
        .session.getState()
        .updateMessageThinking(sid, assistantMsgId, '');
    }
  }
}

export interface StreamCompletionContext {
  sid: string;
  userMsgId: string;
  assistantMsgId: string;
  buffer: { currentText: () => string } | null;
  streamedFullText: string;
  startTime: number;
  localRunId: string | null;
  gotRealText: boolean;
  runEndedWithNetworkError: boolean;
  scheduleRunFinalHtml: (fullText: string) => void;
  thinkingBatcher: StreamTextBatcher | null | undefined;
  flushStreamBatchers: () => void;
  generationMapRef: MutableRefObject<Map<string, number>>;
  state: StreamRunState;
  maybeContinueGoalMode: (sid: string, assistantMsgId: string) => boolean;
  drainQueuedAfterComplete: (sid: string) => void;
}

/**
 * 执行流式任务完成收口逻辑（生命周期状态、消息落地、通知与后续队首排空）。
 */
export function executeStreamCompletion(ctx: StreamCompletionContext): void {
  const {
    sid,
    userMsgId,
    assistantMsgId,
    buffer,
    streamedFullText,
    startTime,
    localRunId,
    gotRealText,
    runEndedWithNetworkError,
    scheduleRunFinalHtml,
    thinkingBatcher,
    flushStreamBatchers,
    generationMapRef,
    state,
    maybeContinueGoalMode,
    drainQueuedAfterComplete,
  } = ctx;

  markStreamingActive(false);
  flushStreamBatchers();
  const { committedText, elapsed, asst } = commitRunCompletion({
    sid,
    assistantMsgId,
    buffer,
    streamedFullText,
    startTime,
    runId: localRunId,
    gotRealText,
    preserveRuntimeStatus: state.runEndedWithError,
  });
  decideEmptyRunNotice({
    asst,
    committedText,
    gotRealText,
    runEndedWithNetworkError,
  });
  const toolPatches = buildTerminalToolPatches(asst?.toolCalls, 'complete');
  if (toolPatches.length) {
    getCompositionRoot()
      .session.getState()
      .applyToolCallPatches(sid, assistantMsgId, toolPatches);
  }
  finalizeAssistantMessageText({
    sid,
    assistantMsgId,
    committedText,
    streamedFullText,
    scheduleRunFinalHtml,
    thinkingBatcher,
  });
  // 首条成功的助手回复后异步要标题。失败保留现有标题，策略在 sessionAiTitle。
  if (
    committedText.trim() &&
    !state.runEndedWithError &&
    !runEndedWithNetworkError
  ) {
    void maybeRequestAiSessionTitle(sid, assistantMsgId);
  }
  finalizeRunCompletionStatuses({
    sid,
    userMsgId,
    assistantMsgId,
    elapsed,
    runId: localRunId,
  });
  generationMapRef.current.delete(sid);
  state.runClosed = true;
  state.draining = false;
  void applyRunUsageSnapshot({
    runId: localRunId,
    sid,
    userMsgId,
    assistantMsgId,
  });
  if (!maybeContinueGoalMode(sid, assistantMsgId)) {
    drainQueuedAfterComplete(sid);
  }
}
