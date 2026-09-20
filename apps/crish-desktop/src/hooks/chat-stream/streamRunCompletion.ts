/**
 * chat-stream run 收口三步 + 空回复横幅裁决（从 streamCallbacksInternals 拆出）。
 *
 * 职责域：
 * - decideEmptyRunNotice：空回复横幅裁决 + 展示动作；
 * - commitRunCompletion：complete 收口第一步（durable commit + diag 微任务）；
 * - finalizeAssistantMessageText：收口第二步（占位清理 + 时间线 + HTML 调度）；
 * - finalizeRunCompletionStatuses：收口第三步（状态置 completed + silent complete 检测）。
 *
 * 行为与原 streamCallbacksInternals 内联实现逐条等价，仅按职责域拆分，
 * 不改流式语义与回调时序。
 */
import { getSessionById } from '../../store/sessionStore';
import type { SessionMessage } from '../../store/types';
import type { MessageToolCall } from '../../store/types';
import { getStreamText } from '../../store/streamingStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import { clearRuntimeStatus } from '../../store/sessionRuntimeStatusStore';
import { toast } from '../../services/toast/ToastContext';
import { recordStreamDiag } from '../../api/streamDiag';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import { checkAndAlertSilentComplete } from '../../api/silentComplete';
import { streamBatchKey } from '../../api/streamTextBatcher';
import { commitStreamToSession } from './helpers';
import { buildMessageIndex, type MessageIndex } from './streamCallbacksInternals';

/**
 * 空回复提示（单轨收敛 §2.4）：全局 toast 一次性承载（5s TTL），不占 composer 区。
 * network 错误收口时守卫：ComposerErrorBar 已承载错误，不重复提示。
 */
export function decideEmptyRunNotice(opts: {
  asst: SessionMessage | undefined;
  committedText: string;
  gotRealText: boolean;
  runEndedWithNetworkError: boolean;
}): void {
  const { asst, committedText, gotRealText, runEndedWithNetworkError } = opts;
  if (runEndedWithNetworkError) return;
  if (asst && !gotRealText && !(asst.text || committedText || '').trim()) {
    const hasTools = (asst.toolCalls || []).some(
      (t: MessageToolCall) =>
        t.status === 'success' || t.status === 'error' || t.status === 'running'
    );
    if (!hasTools) {
      toast.show(
        '这一轮没有文字回复。若刚改过配置，请检查模型与网络。',
        { type: 'info', ttlMs: 5000 }
      );
    }
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
  // 单轨收敛 §2.0：run 收口 = 本轮结束，瞬态重试/错误行原子清空（成功不留痕）
  clearRuntimeStatus(sid);
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
    if (cleaned !== raw && latest?.text !== cleaned) {
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
  const index: MessageIndex = buildMessageIndex(getSessionById(sid));
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
