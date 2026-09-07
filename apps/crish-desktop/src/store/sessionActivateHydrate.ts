/**
 * 会话正文懒水合触发器：从 sessionCrudActions 拆出以遵循 RL-03 行数预算。
 * 只要会话处于 needsEngineMessageHydrate（正文为空且未完成引擎水合），
 * 即刻自发从引擎拉取，避免画面沦为空白草稿。
 */

import { isPendingDraft } from './draftSession';
import type { SessionImmerSet, SessionStoreGet } from './sessionActions';
import { getSessionById, getSessionForWrite } from './sessionIndex';
import {
  maybeAutoTitleSession,
  needsEngineMessageHydrate,
} from './sessionSharedHelpers';
import { nowIsoTimestamp } from '../api/sessionTime';

/**
 * 跨模块可复用的会话正文懒水合触发器。
 */
export function triggerSessionMessageHydrateIfNeeded(
  sessionId: string,
  get?: SessionStoreGet,
  set?: SessionImmerSet
): void {
  if (!sessionId || isPendingDraft(sessionId)) return;

  const resolveGet = async () => {
    if (get) return get();
    const { useSessionStore } = await import('./sessionStore');
    return useSessionStore.getState();
  };

  const resolveSet = async () => {
    if (set) return set;
    const { useSessionStore } = await import('./sessionStore');
    return useSessionStore.setState;
  };

  void resolveGet().then((state) => {
    const sess = getSessionById(state, sessionId);
    if (!sess || !needsEngineMessageHydrate(sess)) return;

    void Promise.all([
      import('../api/sessionEventHydrate'),
      resolveSet(),
    ]).then(
      ([
        { hydrateSessionMessagesFromEngine, mergeMessagesById },
        setter,
      ]) => {
        void hydrateSessionMessagesFromEngine(sessionId).then((res) => {
          if (!res.ok) return;
          setter((draft) => {
            const s = getSessionForWrite(draft, sessionId);
            if (!s) return;
            if (res.messages.length > 0) {
              s.messages = mergeMessagesById(
                s.messages || [],
                res.messages
              );
              s.timestamp = nowIsoTimestamp();
              s.timestampSource = 'remote';
              maybeAutoTitleSession(draft, s);
            } else if (s.messages && s.messages.length > 0) {
              maybeAutoTitleSession(draft, s);
            }
            s.engineCursor = Math.max(
              s.engineCursor ?? 0,
              res.nextAfterSequence
            );
            if (res.lastRunId) s.engineLastRunId = res.lastRunId;
            s.hydratedFromEngine = true;
            if (res.truncated === true) {
              s.hydrateTruncated = true;
            } else {
              delete s.hydrateTruncated;
            }
            draft.sessionsById[sessionId] = s;
          });
        });
      }
    );
  });
}
