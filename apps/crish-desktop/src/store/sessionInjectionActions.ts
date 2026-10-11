import { nowIsoTimestamp } from '../api/sessionTime';
import type { MessageContextInjection } from './types';
import {
  getSessionForWrite,
  rebindSessionById,
} from './sessionIndex';
import type {
  SessionActions,
  SessionImmerSet,
  SessionStoreSlice,
} from './sessionActions';
import {
  appendInjectionToMessage,
  findInjectionMountTarget,
  isContextStateCarrierMessage,
  isContextStateInjection,
  makeInjectionCarrierMessage,
} from './sessionInjectionMount';

/** 可见上下文注入卡片的会话写入 action。 */
export function createSessionInjectionActions<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>
): Pick<SessionActions, 'addContextInjection'> {
  return {
    /**
     * 挂载到最新可写助手消息；找不到挂载点时，创建独立载体消息。
     * context-state 注入原地更新，并清理紧邻目标前方的冗余载体。
     */
    addContextInjection: (
      targetSessionId: string,
      injection: MessageContextInjection
    ) => {
      const sessionId =
        typeof targetSessionId === 'string' ? targetSessionId.trim() : '';
      if (!sessionId) {
        console.warn(
          '[addContextInjection] 拒绝写入：targetSessionId 为空'
        );
        return;
      }
      if (!injection || !injection.id) {
        console.warn(
          '[addContextInjection] 拒绝写入：injection 缺少 id'
        );
        return;
      }
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        if (!sess.messages) sess.messages = [];

        const isState = isContextStateInjection(injection);
        const lastMsg = sess.messages[sess.messages.length - 1];
        const target = isState
          ? isContextStateCarrierMessage(lastMsg)
            ? lastMsg
            : undefined
          : findInjectionMountTarget(sess.messages);
        if (target) {
          appendInjectionToMessage(target, injection);
          if (injection.metadata?.mode === 'context-state') {
            const targetIdx = sess.messages.indexOf(target);
            if (targetIdx > 0) {
              let pruneStart = targetIdx;
              while (
                pruneStart > 0 &&
                isContextStateCarrierMessage(sess.messages[pruneStart - 1])
              ) {
                pruneStart--;
              }
              if (pruneStart < targetIdx) {
                sess.messages.splice(pruneStart, targetIdx - pruneStart);
              }
            }
          }
        } else {
          sess.messages.push(makeInjectionCarrierMessage(injection));
        }
        if (injection.metadata?.mode !== 'context-state') {
          if (
            typeof injection.timestamp === 'number' &&
            Number.isFinite(injection.timestamp)
          ) {
            sess.timestamp = new Date(injection.timestamp).toISOString();
          } else {
            sess.timestamp = nowIsoTimestamp();
          }
          if (sess.timestampSource !== 'local') {
            sess.timestampSource = 'local';
          }
        }
        rebindSessionById(state, sessionId, sess);
      });
    },
  };
}
