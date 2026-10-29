/**
 * /goal 续写与排队追问 drain（run 收口后由 executeStreamCompletion 调用）。
 *
 * 下一轮启动统一经 `sessionStreams.scheduleStart`，由该会话当前登记的 starter 执行。
 */
import {
  BUSY_RETRY_MAX_ATTEMPTS,
  busyRetryDelayMs,
  clearBusy,
  getBusyAttempt,
  sessionStreams,
} from '../../api/sessionStreamManager';
import { DOMAIN_MESSAGES } from '../../api/userFacingErrors';
import { reportRuntimeStatus } from '../../store/sessionRuntimeStatusStore';
import { getSessionById } from '../../store/sessionStore';
import { addMessage, patchSession } from '../../api/storeAccess';
import {
  decideGoalContinuation,
  GOAL_DEFAULT_MAX_ITERATIONS,
  goalStopAllowsToast,
  mergeGoalTasksFromAssistantText,
  buildGoalModePrefix,
} from '../../api/goalModeController';
import { generateMessageId } from '../../utils/generateMessageId';
import type { SessionMessage, SessionGoalMode } from '../../store/types';
import { getCompositionRoot } from '../../app/compositionRoot';
import { toast } from '../../services/toast/ToastContext';

export type GoalRoundEvent =
  | {
      type: 'goal-round-started';
      round: number;
      maxRounds: number;
      goal: string;
    }
  | {
      type: 'goal-round-completed';
      round: number;
      decision: string;
      reasonDetail?: string;
      stalledDelta?: number;
    }
  | {
      type: 'goal-continuation-decided';
      action: string;
      reason?: string;
    };

export function goalDecisionToStatus(
  decision: string
): 'active' | 'completed' | 'blocked' | undefined {
  const d = String(decision ?? '')
    .toLowerCase()
    .replace(/[-_]/g, '');
  if (d === 'completed' || d === 'done') return 'completed';
  if (d === 'blocked' || d === 'noprogress' || d === 'nogoal') return 'blocked';
  if (d === 'continue' || d === 'inprogress') return undefined;
  return undefined;
}

export function isGoalDecisionTerminal(decision: string): boolean {
  const s = goalDecisionToStatus(decision);
  if (s === 'completed' || s === 'blocked') return true;
  const d = String(decision ?? '')
    .toLowerCase()
    .replace(/[-_]/g, '');
  return d === 'nogoal';
}

export function applyGoalRoundEventToGoalMode(
  current: SessionGoalMode | null | undefined,
  event: GoalRoundEvent
): SessionGoalMode | null {
  if (!current) return null;
  if (event.type === 'goal-round-started') {
    return {
      ...current,
      active: true,
      iteration: Math.max(0, event.round - 1),
      maxIterations: event.maxRounds,
      status: 'active',
      goal: event.goal || current.goal,
    };
  }
  if (event.type === 'goal-round-completed') {
    const status = goalDecisionToStatus(event.decision);
    const next: SessionGoalMode = {
      ...current,
      iteration: Math.max(0, event.round - 1),
    };
    if (status) {
      next.status = status;
    } else {
      delete next.status;
    }
    return next;
  }
  if (event.type === 'goal-continuation-decided') {
    const a = String(event.action ?? '').toLowerCase();
    if (a === 'complete') return { ...current, status: 'completed' };
    if (a === 'block') return { ...current, status: 'blocked' };
    if (a === 'continue') return { ...current, status: 'active' };
  }
  return current;
}

function syncGoalTasksFromAssistantText(
  sid: string,
  assistantText: string,
  gm: SessionGoalMode
): SessionGoalMode {
  const next = mergeGoalTasksFromAssistantText(gm, assistantText);
  if (next === gm) return gm;
  patchSession(sid, { goalMode: next });
  return next;
}

/** goal 模式续写判定；返回 true 表示已调度下一轮（调用方不再 drain） */
export function maybeContinueGoalMode(
  sid: string,
  assistantMsgId: string
): boolean {
  const cancelled = sessionStreams.consumeGoalCancelled(sid);
  const sess = getSessionById(sid);
  const asstText =
    sess?.messages.find((m: SessionMessage) => m.id === assistantMsgId)?.text ||
    '';
  if (sess?.goalMode?.active) {
    syncGoalTasksFromAssistantText(sid, asstText, sess.goalMode);
  }
  const liveSess = getSessionById(sid);
  const decision = decideGoalContinuation({
    cancelled,
    session: liveSess,
    assistantText: asstText,
  });

  if (decision.action === 'stop') {
    if (decision.reason === 'done' || decision.reason === 'max_iter') {
      patchSession(sid, { goalMode: decision.goalMode });
    }
    if (decision.toast && goalStopAllowsToast(decision.reason)) {
      toast.show(decision.toast);
    }
    return false;
  }

  patchSession(sid, { goalMode: decision.goalMode });
  // 发送前固定 clientMessageId，经 addMessage upsert 防双写（wsId 在 action 内忽略）
  const userMsgId = generateMessageId('user');
  addMessage('ws', sid, {
    id: userMsgId,
    sender: 'user',
    text: decision.displayText,
    timestamp: Date.now(),
    status: 'processing',
  });

  sessionStreams.scheduleStart(sid, decision.modelText, userMsgId);
  return true;
}

/** 排空队首 queued 用户消息（含串行守卫退避重发） */
export function drainQueuedAfterComplete(sid: string): void {
  if (!sessionStreams.beginDrain(sid)) return;
  try {
    const st = getCompositionRoot().session.getState();
    const sess = getSessionById(sid);
    const stillBusy = sess?.messages?.some(
      (m: SessionMessage) =>
        m.sender === 'assistant' && m.status === 'processing'
    );
    if (stillBusy) return;
    const next = sess?.messages.find(
      (m: SessionMessage) => m.sender === 'user' && m.status === 'queued'
    );
    if (!next?.text) return;
    // P1-d 方案 B：串行守卫自动排队 → 退避重发（300ms 起指数，最多 4 次）；
    // 用尽 → queued → error，失败经 ComposerErrorBar 可见（不写 errorDetail）
    const busyAttempt = getBusyAttempt(next.id);
    if (busyAttempt > BUSY_RETRY_MAX_ATTEMPTS) {
      clearBusy(next.id);
      st.setSessionMessageStatus(sid, next.id, 'error', undefined, {
        force: true,
      });
      reportRuntimeStatus({
        type: 'failed',
        sessionId: sid,
        kind: 'generic',
        message: DOMAIN_MESSAGES.S7_EXHAUSTED,
        turn: { userMsgId: next.id },
      });
      return;
    }
    st.setSessionMessageStatus(sid, next.id, 'processing');
    let prompt = next.text;
    const gm = sess?.goalMode;
    if (gm?.active && gm.goal) {
      const maxIter = gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS;
      prompt = `${buildGoalModePrefix(gm.goal, gm.iteration ?? 0, maxIter, gm.tasks)}${next.text}`;
    }
    if (busyAttempt > 0) {
      const delay = busyRetryDelayMs(busyAttempt);
      sessionStreams.scheduleStart(sid, prompt, next.id, (fn) => {
        setTimeout(fn, delay);
      });
    } else {
      sessionStreams.scheduleStart(sid, prompt, next.id);
    }
  } finally {
    // drain 标记跨过本轮同步收口栈，下一 microtask 释放（防同栈重入）
    queueMicrotask(() => sessionStreams.endDrain(sid));
  }
}
