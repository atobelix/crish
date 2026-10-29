/**
 * chat-stream 流式执行与收口纯辅助函数（streamExecutionHelper）。
 *
 * 封装并发流冲突检测、思考占位清理与完成终态收口逻辑。
 */
import type { MutableRefObject } from 'react';
import type { StreamTextBatcher } from '../../api/streamTextBatcher';
import { sessionStreams } from '../../api/sessionStreamManager';
import type { SessionMessage } from '../../store/types';
import { getSessionById } from '../../store/sessionStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import { markStreamingActive } from '../../api/streamStop';
import { buildTerminalToolPatches } from './helpers';
import { streamBatchKey } from '../../api/streamTextBatcher';
import { getStreamThinking, setStreamText } from '../../store/streamingStore';
import { StreamRenderBuffer } from '../../api/StreamRenderBuffer';
import {
  commitRunCompletion,
  decideEmptyRunNotice,
  finalizeAssistantMessageText,
  finalizeRunCompletionStatuses,
} from './streamRunCompletion';
import { type StreamRunState } from './streamCallbacksInternals';
import { applyRunUsageSnapshot } from './streamCallbacksUsage';
import { maybeRequestAiSessionTitle } from '../../api/sessionAiTitle';
import { logger } from '../../services/LoggerService';
import {
  drainQueuedAfterComplete,
  maybeContinueGoalMode,
} from './goalContinuation';

/**
 * 检查当前会话是否已有正在运行的流。
 * 若存在活动流，则将当前 user 消息置为 queued 状态并提示警告，阻止重复启动。
 */
export function handleStreamConflict(sid: string, userMsgId: string): boolean {
  if (!sessionStreams.get(sid)) return false;

  const userMsg = getSessionById(sid)?.messages?.find(
    (m: SessionMessage) => m.id === userMsgId
  );
  if (userMsg?.sender === 'user' && userMsg.status === 'processing') {
    // processing → queued 属于守卫表中的 force 转换（串行守卫 S7 自动排队）；
    // 不带 force 会被 validateStatusTransition 拒绝，消息卡在 processing。
    getCompositionRoot()
      .session.getState()
      .setSessionMessageStatus(sid, userMsgId, 'queued', undefined, {
        force: true,
      });
  }
  logger.warn(
    '[runStreamingAssistant] refuse start while stream live (L1 follow_up, no abort)',
    { module: 'chat-stream', sessionId: sid }
  );
  return true;
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
  thinkingBatcher: StreamTextBatcher | null | undefined;
  flushStreamBatchers: () => void;
  generationMapRef: MutableRefObject<Map<string, number>>;
  state: StreamRunState;
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
    thinkingBatcher,
    flushStreamBatchers,
    generationMapRef,
    state,
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

/**
 * 为单轮 run 创建并启动独占的流式渲染缓冲器（StreamRenderBuffer），
 * 绑定帧刷新与生命周期守卫；缓冲器随 run 句柄登记进 sessionStreams。
 */
export function setupStreamRenderBuffer(opts: {
  sid: string;
  assistantMsgId: string;
  generationMapRef: MutableRefObject<Map<string, number>>;
  state: StreamRunState;
  assertLive: () => boolean;
  finishComplete: () => void;
}): StreamRenderBuffer {
  const buffer = new StreamRenderBuffer();

  const myGen = (opts.generationMapRef.current.get(opts.sid) ?? 0) + 1;
  opts.generationMapRef.current.set(opts.sid, myGen);

  buffer.onFrame = (frame) => {
    if (frame.isFinal) {
      if (opts.state.draining) {
        setStreamText(opts.sid, opts.assistantMsgId, frame.full);
        opts.finishComplete();
      }
      return;
    }
    if (opts.state.runClosed && !opts.state.draining) return;
    if (!opts.assertLive() && !opts.state.draining) return;
    if (myGen !== opts.generationMapRef.current.get(opts.sid)) return;
    setStreamText(opts.sid, opts.assistantMsgId, frame.full);
  };
  buffer.start();
  return buffer;
}
