/**
 * @file streamRunCompletion.ts
 * @description 流式回合终态提交与 Dual-Latch Handoff 协议接线器（Stage 02 Store 层权威实现）
 *
 * 核心职责：
 * 1. 彻底废除 `queueMicrotask(() => clearStream(...))` 裸清流造成的 1~2 帧空白闪烁；
 * 2. 接入 `dualLatchProtocol.ts` 的四态状态机（`STREAMING -> LATCHED -> COMMITTED -> DRAINED`）：
 *    - 第一重锁存（同步语义自锁存）：先将流式缓冲区的完整文本/思考单调合入持久消息 `msg.text`（唯一权威源 SSOT），
 *      清空 `msg.streamText = undefined`，并将槽位推进至 `LATCHED`；
 *    - 第二重锁存（双帧物理 rAF 握手）：通过 `executeDualRafHandoff` / `scheduleDualRafClearStream`
 *      跨越两个真实渲染帧确认 React Fiber 已提交持久态 DOM 后，才执行 `clearStream(sessionId, messageId)`
 *      并将状态机推进至 `DRAINED`。
 * 3. 支持与 `finalizeStreamingTurnAction` 联动，在单个 Store 事务内完成主消息终态、子代理归档与 Epoch 递增。
 */

import {
  dualLatchStateMachine,
  executeDualRafHandoff,
  resolveMonotonicRenderedText,
  resolveStreamMessageLatch,
  scheduleDualRafClearStream,
  scheduleDualRafClearStreams,
  type DualLatchPhase,
  type LatchableMessageShape,
  type RafScheduler,
} from './dualLatchProtocol';
import {
  clearStream,
  clearStreams,
  getStreamText,
  getStreamThinking,
} from './streamingStore';
import {
  finalizeStreamingTurnAction,
  type FinalSubagentSnapshot,
  type OrthogonalStreamingTurnSlice,
  type StreamingTurnStateSetter,
} from './sessionMessageActionsCore';
import type { MessageToolCallStatus } from './types';

export interface DualLatchTurnCommitOptions<
  S extends OrthogonalStreamingTurnSlice = OrthogonalStreamingTurnSlice,
> {
  readonly sessionId: string;
  readonly messageId: string;
  readonly finalText?: string;
  readonly finalThinking?: string;
  readonly finalStatus?: 'completed' | 'error' | 'cancelled';
  readonly completedAt?: number;
  readonly finalSubagents?: readonly FinalSubagentSnapshot[];
  /** 额外需要随同本轮一并按 ID 精确回收的子代理流式消息 ID 列表（严禁调用 clearSession） */
  readonly finalizedSubagentMessageIds?: readonly string[];
  readonly setStoreState?: StreamingTurnStateSetter<S>;
  readonly clearStreamFn?: (sessionId: string, messageId: string) => void;
  readonly clearStreamsFn?: (sessionId: string, messageIds: string[]) => void;
  readonly scheduleFrame?: RafScheduler;
  readonly onCommittedFrame?: () => void;
  readonly onDrainedFrame?: () => void;
}

export interface DualLatchTurnCommitResult {
  readonly latchedMessage: LatchableMessageShape;
  readonly finalText: string;
  readonly finalThinking: string | undefined;
  readonly phaseAfterLatch: DualLatchPhase;
  readonly cancelHandoff: () => void;
}

/**
 * 执行流式回合终态 Dual-Latch 提交：
 * 1. 同步读取 `streamingStore` 缓冲并与传入的 `finalText` 取单调不退化文本；
 * 2. 执行语义自锁存（`resolveStreamMessageLatch`）并登记 `LATCHED` 阶段；
 * 3. 若提供 `setStoreState`，通过 `finalizeStreamingTurnAction` 在单次 Store 事务内原子落盘；
 * 4. 启动双帧物理 rAF 交接（`STREAMING -> LATCHED -> COMMITTED -> DRAINED`），
 *    仅在第二帧 rAF 回调中精确调用 `clearStream` / `clearStreams`。
 */
export function commitStreamWithDualLatch<
  S extends OrthogonalStreamingTurnSlice = OrthogonalStreamingTurnSlice,
>(options: DualLatchTurnCommitOptions<S>): DualLatchTurnCommitResult {
  const {
    sessionId,
    messageId,
    finalStatus = 'completed',
    completedAt = Date.now(),
    finalSubagents,
    finalizedSubagentMessageIds,
    setStoreState,
    clearStreamFn = clearStream,
    clearStreamsFn = clearStreams,
    scheduleFrame,
    onCommittedFrame,
    onDrainedFrame,
  } = options;

  const liveStreamText = getStreamText(sessionId, messageId);
  const liveStreamThinking = getStreamThinking(sessionId, messageId);
  const resolvedText = resolveMonotonicRenderedText(
    options.finalText,
    liveStreamText
  );
  const resolvedThinking =
    options.finalThinking !== undefined
      ? options.finalThinking
      : liveStreamThinking || undefined;

  const latchedMessage = resolveStreamMessageLatch(
    {
      id: messageId,
      text: options.finalText,
      streamText: liveStreamText || undefined,
      thinking: resolvedThinking,
      status: 'processing',
    },
    resolvedText,
    finalStatus
  );

  const latchRecord = dualLatchStateMachine.markLatched(
    sessionId,
    messageId,
    latchedMessage.text.length
  );

  if (setStoreState) {
    finalizeStreamingTurnAction(setStoreState, {
      sessionId,
      messageId,
      finalText: latchedMessage.text,
      ...(resolvedThinking !== undefined
        ? { finalThinking: resolvedThinking }
        : {}),
      finalStatus,
      completedAt,
      ...(finalSubagents !== undefined ? { finalSubagents } : {}),
    });
  }

  const allMessageIdsToClear = new Set<string>([messageId]);
  if (finalizedSubagentMessageIds) {
    for (const subMsgId of finalizedSubagentMessageIds) {
      if (subMsgId) {
        allMessageIdsToClear.add(subMsgId);
        dualLatchStateMachine.markLatched(
          sessionId,
          subMsgId,
          (getStreamText(sessionId, subMsgId) ?? '').length
        );
      }
    }
  }

  let cancelHandoff: () => void;
  if (allMessageIdsToClear.size === 1 && !onCommittedFrame && !onDrainedFrame) {
    cancelHandoff = scheduleDualRafClearStream(
      sessionId,
      messageId,
      clearStreamFn,
      scheduleFrame
    );
  } else if (!onCommittedFrame && !onDrainedFrame) {
    cancelHandoff = scheduleDualRafClearStreams(
      sessionId,
      allMessageIdsToClear,
      clearStreamsFn,
      scheduleFrame
    );
  } else {
    cancelHandoff = executeDualRafHandoff({
      sessionId,
      messageId,
      latchedTextLength: latchedMessage.text.length,
      scheduleFrame,
      onCommitted: () => {
        for (const id of allMessageIdsToClear) {
          if (id !== messageId)
            dualLatchStateMachine.markCommitted(sessionId, id);
        }
        onCommittedFrame?.();
      },
      onDrain: () => {
        if (allMessageIdsToClear.size === 1) {
          clearStreamFn(sessionId, messageId);
        } else {
          clearStreamsFn(sessionId, Array.from(allMessageIdsToClear));
          for (const id of allMessageIdsToClear) {
            if (id !== messageId)
              dualLatchStateMachine.markDrained(sessionId, id);
          }
        }
        onDrainedFrame?.();
      },
    });
  }

  return {
    latchedMessage,
    finalText: latchedMessage.text,
    finalThinking: resolvedThinking,
    phaseAfterLatch: latchRecord.phase,
    cancelHandoff,
  };
}

export interface StreamRunCompletionStorePort {
  readonly sessions?: ReadonlyArray<{
    readonly id: string;
    readonly messages?: ReadonlyArray<{
      readonly id: string;
      readonly text?: string;
      readonly thinking?: string;
      readonly toolCalls?: ReadonlyArray<{
        readonly id: string;
        readonly status: MessageToolCallStatus;
        readonly output?: string;
      }>;
    }>;
  }>;
  readonly updateMessageText: (
    sessionId: string,
    messageId: string,
    text: string
  ) => void;
  readonly updateMessageThinking: (
    sessionId: string,
    messageId: string,
    thinking: string
  ) => void;
  readonly setSessionMessageStatus: (
    sessionId: string,
    messageId: string,
    status: 'completed' | 'error',
    thinkingTimeSec: number
  ) => void;
  readonly updateMessageTimeline: (
    sessionId: string,
    messageId: string
  ) => void;
  readonly applyToolCallPatches: (
    sessionId: string,
    messageId: string,
    patches: Array<{
      id: string;
      status?: MessageToolCallStatus;
      output?: string;
    }>
  ) => void;
}

/**
 * 同步将流式正文/思考锁存写入持久消息（Dual-Latch 第一重语义自锁存）
 */
export function finalizeAssistantMessageText(
  store: StreamRunCompletionStorePort,
  sessionId: string,
  assistantMsgId: string,
  accumulatedText: string,
  accumulatedThinking: string,
  streamError: string | null
): string {
  const sess = store.sessions?.find((s) => s.id === sessionId);
  const existingMsg = sess?.messages?.find((m) => m.id === assistantMsgId);
  const existingText = existingMsg?.text || '';
  const liveStreamText = getStreamText(sessionId, assistantMsgId);

  const bestCandidate = resolveMonotonicRenderedText(
    accumulatedText,
    liveStreamText
  );
  let resolvedFinalText = resolveMonotonicRenderedText(
    existingText,
    bestCandidate
  );
  if (streamError && !resolvedFinalText.trim()) resolvedFinalText = '';

  if (resolvedFinalText) {
    store.updateMessageText(sessionId, assistantMsgId, resolvedFinalText);
  }

  const liveThinking = getStreamThinking(sessionId, assistantMsgId) ?? '';
  const bestThinking =
    accumulatedThinking.length >= liveThinking.length
      ? accumulatedThinking
      : liveThinking;

  if (bestThinking) {
    store.updateMessageThinking(sessionId, assistantMsgId, bestThinking);
  } else if (existingMsg?.thinking === '正在处理…') {
    store.updateMessageThinking(sessionId, assistantMsgId, '');
  }

  dualLatchStateMachine.markLatched(
    sessionId,
    assistantMsgId,
    resolvedFinalText.length
  );
  return resolvedFinalText;
}

/**
 * 结算消息终态、收拢残留 running 工具调用并刷新时间线
 */
export function finalizeRunCompletionStatuses(
  store: StreamRunCompletionStorePort,
  sessionId: string,
  assistantMsgId: string,
  userMsgId: string,
  finalStatus: 'completed' | 'error',
  thinkingTimeSec: number,
  userInterrupted: boolean
): void {
  store.setSessionMessageStatus(
    sessionId,
    assistantMsgId,
    finalStatus,
    thinkingTimeSec
  );
  store.setSessionMessageStatus(sessionId, userMsgId, finalStatus, 0);

  const sess = store.sessions?.find((s) => s.id === sessionId);
  const msg = sess?.messages?.find((m) => m.id === assistantMsgId);
  const patches: Array<{
    id: string;
    status: MessageToolCallStatus;
    output: string;
  }> = [];

  for (const tc of msg?.toolCalls ?? []) {
    if (tc.status === 'running' || tc.status === 'pending_approval') {
      const nextStatus: MessageToolCallStatus =
        finalStatus === 'error' || userInterrupted ? 'error' : 'success';
      const fallbackOutput = userInterrupted
        ? '已停止'
        : finalStatus === 'error'
          ? '未完成（回合异常结束）'
          : '已完成';
      const nextOutput =
        tc.output && tc.output !== '执行中…' ? tc.output : fallbackOutput;
      patches.push({ id: tc.id, status: nextStatus, output: nextOutput });
    }
  }

  if (patches.length > 0)
    store.applyToolCallPatches(sessionId, assistantMsgId, patches);
  store.updateMessageTimeline(sessionId, assistantMsgId);
}

export interface RunCompletionCommitParams {
  readonly store: StreamRunCompletionStorePort;
  readonly sessionId: string;
  readonly assistantMsgId: string;
  readonly userMsgId: string;
  readonly accumulatedText: string;
  readonly accumulatedThinking: string;
  readonly streamError: string | null;
  readonly finalStatus: 'completed' | 'error';
  readonly thinkingTimeSec: number;
  readonly userInterrupted: boolean;
  readonly scheduleFrame?: RafScheduler;
  readonly clearStreamFn?: (sessionId: string, messageId: string) => void;
}

/**
 * 完整执行流式回合收尾：
 * 1. 同步锁存最终正文与思考（`LATCHED`）；
 * 2. 同步落盘状态与工具终态；
 * 3. 通过 Dual-Latch 双帧物理 rAF 握手（取代 `queueMicrotask` 裸清流）安全回收 `streamingStore`。
 */
export function commitRunCompletion(params: RunCompletionCommitParams): {
  readonly finalText: string;
  readonly cancelHandoff: () => void;
} {
  const {
    store,
    sessionId,
    assistantMsgId,
    userMsgId,
    accumulatedText,
    accumulatedThinking,
    streamError,
    finalStatus,
    thinkingTimeSec,
    userInterrupted,
    scheduleFrame,
    clearStreamFn = clearStream,
  } = params;

  const finalText = finalizeAssistantMessageText(
    store,
    sessionId,
    assistantMsgId,
    accumulatedText,
    accumulatedThinking,
    streamError
  );
  finalizeRunCompletionStatuses(
    store,
    sessionId,
    assistantMsgId,
    userMsgId,
    finalStatus,
    thinkingTimeSec,
    userInterrupted
  );
  const cancelHandoff = scheduleDualRafClearStream(
    sessionId,
    assistantMsgId,
    clearStreamFn,
    scheduleFrame
  );
  return { finalText, cancelHandoff };
}
