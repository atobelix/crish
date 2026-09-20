/**
 * useStreamCallbacks：chat-stream 对外主钩子（G-03c 拆分后的主文件）。
 *
 * - run 编排主体 → useRunStreamingAssistant.ts；
 * - 收口/完成/工具队列纯函数段 → streamCallbacksInternals.ts；
 * - 事件分发（onRunError / 子 agent）→ streamCallbacksEvents.ts；
 * - usage 消费（快照回填 / approx 兜底）→ streamCallbacksUsage.ts；
 * - 表面纯函数 + DELAY_AFTER_STOP_MS + 共享参数类型 → streamCallbacksSurfaces.ts；
 * - 本文件保留：hook 参数面 / 停止生成（L2 cooperative / L3 force）/
 *   对外返回面 + 兼容 re-export（调用方与测试零改动）。
 */
import { useRef } from 'react';
import { getSessionById } from '../../store/sessionStore';
import { patchSession } from '../../api/storeAccess';
import { getCompositionRoot } from '../../app/compositionRoot';
import { clearStream, getStreamText } from '../../store/streamingStore';
import {
  markStreamingActive,
  dispatchStreamStopCancel,
} from '../../api/streamStop';
import { recordStreamDiag } from '../../api/streamDiag';
import { toast } from '../../services/toast/ToastContext';
import type { UseChatStreamOptions } from './types';
import type { StreamBatcherRefs } from './useStreamBatchers';
import {
  resolveStreamSessionId,
  commitStreamToolsToSession,
  commitStreamToSession,
  scheduleFinalMarkdownHtml,
  buildTerminalToolPatches,
} from './helpers';
import { useRunStreamingAssistant } from './useRunStreamingAssistant';
import { buildMessageIndex } from './streamCallbacksInternals';
import { applyStopUsageApprox } from './streamCallbacksUsage';
import type {
  StreamRunQueryHelpers,
  StreamRunStarter,
} from './streamCallbacksSurfaces';

export function useStreamCallbacks(
  options: UseChatStreamOptions,
  refs: StreamBatcherRefs,
  queryHelpers: StreamRunQueryHelpers
): {
  runStreamingAssistant: StreamRunStarter;
  /** 默认 Stop = L2 cooperative */
  handleStopGeneration: () => void;
  /** 强制取消 = L3 force（UI 二次确认后调用） */
  handleForceCancelGeneration: () => void;
} {
  const { streamManagerRef, renderBufferRef, flushStreamBatchers } = refs;

  const generationMapRef = useRef<Map<string, number>>(new Map());
  const { runStreamingAssistant } = useRunStreamingAssistant(
    options,
    refs,
    queryHelpers,
    generationMapRef
  );

  /**
   * 停止生成：默认 L2 cooperative；force=true 时 L3。
   * UI 默认 Stop → handleStopGeneration()；强制取消 → handleForceCancelGeneration()。
   * 共享 wire：api/streamStop.dispatchStreamStopCancel → createStreamCancel / compositionRoot
   *（Wave C：core_run_control 单一命令面，cancel-run 双线已删）。
   * 本函数保留 chat 专属 partials（buffer / goalMode / message status / telemetry）。
   */
  const finalizeStopGeneration = (force: boolean) => {
    const sid = resolveStreamSessionId(
      null,
      getCompositionRoot().session.getActiveSessionId()
    );
    if (!sid) return;
    const cur = streamManagerRef.current!.get(sid);
    if (!cur) return;
    streamManagerRef.current!.delete(sid);
    generationMapRef.current.delete(sid);
    markStreamingActive(false);
    const stopBuf = renderBufferRef.current;
    // T2.2：stop 路径走预算式收口（常态 ≤2 帧同步刷完，行为不变；
    // 大残余分帧，isFinal 帧落盘后收口仍由本函数自管）
    // F1a（R2-4）：不再调用 stopBuf?.stop()——它 cancelScheduledFlush 中断预算
    // 循环，大残余（>16KB）时 isFinal 帧永不到达（P2-1 截断根因）。buffer 已
    // finalMarked，后续 push 被拒绝，预算循环至多 N 帧自然收口于 isFinal 帧。
    stopBuf?.flushFinal();
    flushStreamBatchers();
    const st = getCompositionRoot().session.getState();
    if (getSessionById(sid)?.goalMode?.active) {
      streamManagerRef.current!.markGoalCancelled(sid);
      patchSession(sid, { goalMode: null });
    }
    // Persist partial stream text only（禁止把「已停止」等系统句写入气泡）
    // F1b（R2-4）：stopBuf.currentText() 优先——它 = fullText + pending.join('')
    // 恒为完整全文（大残余首帧同步刷入 ≤8KB 后剩余仍在 pending 中）；
    // getStreamText 是「停止前最后一帧」写入的陈旧截断值，降为兜底（P2-1 截断根因）。
    const stopBufFull = stopBuf?.currentText() ?? '';
    const partialText =
      stopBufFull ||
      getStreamText(sid, cur.assistantMsgId) ||
      buildMessageIndex(getSessionById(sid)).get(cur.assistantMsgId)?.text ||
      '';
    const stopText = (partialText || '').trim();
    commitStreamToolsToSession(sid, cur.assistantMsgId);
    if (stopText) {
      commitStreamToSession(sid, cur.assistantMsgId, { text: stopText });
      // F1d（R2-4）：截断防御断言——commit 文本不得短于 buffer 完整终稿，
      // 正常路径恒等，为将来任何 drain 回归的哨兵
      if (stopBufFull && stopText.length < stopBufFull.length) {
        console.warn(
          `[crish-desktop][stop-truncation] stop 终稿截断：committed=${stopText.length} buffered=${stopBufFull.length}`
        );
        recordStreamDiag({
          kind: 'stop-truncation',
          scope: 'chat-stream',
          message: `stop 终稿截断 committed=${stopText.length} buffered=${stopBufFull.length}`,
        });
      }
    } else {
      // 无正文：清空占位（不写 assistant 正文）；停止提示走全局 toast（单轨收敛 §2.4）
      st.updateMessageText(sid, cur.assistantMsgId, '');
      clearStream(sid, cur.assistantMsgId);
      toast.show(force ? '已强制停止本轮生成。' : '已停止本轮生成。', {
        type: 'info',
      });
    }
    const asst = buildMessageIndex(getSessionById(sid)).get(cur.assistantMsgId);
    st.setSessionMessageStatus(sid, cur.userMsgId, 'completed');
    st.setSessionMessageStatus(sid, cur.assistantMsgId, 'completed');
    if (stopText) {
      scheduleFinalMarkdownHtml(sid, cur.assistantMsgId, stopText);
    }
    const stopPatches = buildTerminalToolPatches(asst?.toolCalls, 'stop');
    if (stopPatches.length) {
      // T-E 步骤 3（U5）：raw setState → applyToolCallPatches action（批量终态）
      getCompositionRoot()
        .session.getState()
        .applyToolCallPatches(sid, cur.assistantMsgId, stopPatches);
    }
    void applyStopUsageApprox({
      sid,
      userMsgId: cur.userMsgId,
      assistantMsgId: cur.assistantMsgId,
      stopText,
    });
    // L2/L3 wire：shared helper（chat has live cancel; no runId double-dispatch）
    dispatchStreamStopCancel({ force, cancel: cur.cancel });
  };

  /** 默认 Stop = L2 cooperative_stop */
  const handleStopGeneration = () => {
    finalizeStopGeneration(false);
  };

  /** 强制取消 = L3 force_cancel（UI 应二次确认） */
  const handleForceCancelGeneration = () => {
    finalizeStopGeneration(true);
  };

  return {
    runStreamingAssistant,
    handleStopGeneration,
    handleForceCancelGeneration,
  };
}

// 单轨收敛：旧四态裁决器已删除（resolveRunErrorSurface / isActionableErrorKind）。
// 错误展示唯一出口 = SessionRuntimeStatusStore（ComposerErrorBar / InFlowStatusLine）。
