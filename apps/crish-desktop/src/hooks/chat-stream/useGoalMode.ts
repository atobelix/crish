import { type MutableRefObject } from 'react';
import type { SessionStreamManager } from '../../api/sessionStreamManager';
import { useLayoutStore } from '../../store/layoutStore';
import { getSessionById } from '../../store/sessionStore';
import { patchSession } from '../../api/storeAccess';
import {
  decideGoalContinuation,
  GOAL_DEFAULT_MAX_ITERATIONS,
  goalStopAllowsToast,
  mergeGoalTasksFromAssistantText,
  buildGoalModePrefix,
} from '../../api/goalModeController';
import type { SessionMessage, SessionGoalMode } from '../../store/types';

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

export function useGoalMode(
  streamManagerRef: MutableRefObject<SessionStreamManager | null>,
  onShowToast: (message: string) => void,
): {
  maybeContinueGoalMode: (sid: string, assistantMsgId: string) => boolean;
  drainQueuedAfterComplete: (sid: string) => void;
} {
  const maybeContinueGoalMode = (
    sid: string,
    assistantMsgId: string
  ): boolean => {
    const mgr = streamManagerRef.current!;
    const cancelled = mgr.consumeGoalCancelled(sid);
    const sess = getSessionById(sid);
    const asstText =
      sess?.messages.find((m: SessionMessage) => m.id === assistantMsgId)
        ?.text || '';
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
        onShowToast(decision.toast);
      }
      return false;
    }

    patchSession(sid, { goalMode: decision.goalMode });
    const userMsgId = `user-msg-goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    useLayoutStore.setState((state) => {
      const s = state.sessionsById[sid];
      if (!s) return;
      if (!s.messages) s.messages = [];
      s.messages.push({
        id: userMsgId,
        sender: 'user',
        text: decision.displayText,
        timestamp: Date.now(),
        status: 'processing',
      });
    });

    mgr.scheduleStart(sid, decision.modelText, userMsgId);
    return true;
  };

  const drainQueuedAfterComplete = (sid: string) => {
    const mgr = streamManagerRef.current!;
    if (!mgr.beginDrain(sid)) return;
    try {
      const st = useLayoutStore.getState();
      const sess = getSessionById(sid);
      const stillBusy = sess?.messages?.some(
        (m: SessionMessage) =>
          m.sender === 'assistant' && m.status === 'processing'
      );
      if (stillBusy) return;
      const next = sess?.messages.find(
        (m: SessionMessage) => m.sender === 'user' && m.status === 'queued'
      );
      if (next?.text) {
        st.setSessionMessageStatus(sid, next.id, 'processing');
        let prompt = next.text;
        const gm = sess?.goalMode;
        if (gm?.active && gm.goal) {
          const maxIter = gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS;
          prompt = `${buildGoalModePrefix(gm.goal, gm.iteration ?? 0, maxIter, gm.tasks)}${next.text}`;
        }
        mgr.scheduleStart(sid, prompt, next.id);
      }
    } finally {
      mgr.endDrainNextTick(sid);
    }
  };

  return { maybeContinueGoalMode, drainQueuedAfterComplete };
}
