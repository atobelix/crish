/**
 * 会话批量状态 actions：从 sessionCrudActions 拆出。
 * 聚焦 sessions[] 批量替换、单会话 patch、消息清空三类状态写。
 */

import { MAX_FOLDERS } from '@crish/shared-utils/browser';
import { prepareSessionsForUi } from '../api/sessionTitle';
import { PENDING_DRAFT_SESSION_ID, isPendingDraft } from './draftSession';
import { reindexSessionsById, getSessionForWrite } from './sessionIndex';
import { runEmptyShellAssert } from '../dev/emptyShellAssert';
import { useTerminalStore } from './terminalStore';
import type {
  SessionActions,
  SessionStoreSlice,
  SessionImmerSet,
} from './sessionActions';
import type { SessionGoalMode, SessionState } from './types';
import { syncActiveTerminalSession } from './sessionSharedHelpers';

/**
 * 创建会话批量状态 actions（setSessions / patchSession / clearSessionMessages）。
 * 从 sessionCrudActions 拆出以降低 hub 行数；仅依赖 set + 共享助手。
 */
export function createSessionStateActions<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>
): Pick<
  SessionActions,
  'setSessions' | 'patchSession' | 'clearSessionMessages' | 'evictSessionMessages'
> {
  return {
    /**
     * 批量替换 sessions（hydrate / daemon sync）。
     * 经 prepareSessionsForUi：补默认标题 + pruneEmptyShellSessions 剪幽灵空壳。
     * active 为 pending draft 哨兵时不 keep 任何空壳。
     * D2：prepare 后 dev empty-shell-assert（残壳 / I-DRAFT 脏入）。
     */
    setSessions: (sessions: SessionState[]) =>
      set((state) => {
        state.sessions = prepareSessionsForUi(
          sessions,
          state.activeSessionId || null
        );
        reindexSessionsById(state);
        // D2-4：list/hydrate 后残壳探测（dev 记 metric + warn once；生产 no-op）
        runEmptyShellAssert(state.sessions, {
          activeSessionId: state.activeSessionId || null,
        });
        for (const s of state.sessions) {
          if (
            s.folder &&
            !state.folderOrder.includes(s.folder) &&
            state.folderOrder.length < MAX_FOLDERS
) {
            state.folderOrder.push(s.folder);
          }
        }
        if (
          state.activeSessionId &&
          !isPendingDraft(state.activeSessionId) &&
          !state.sessionsById[state.activeSessionId]
        ) {
          // active 指向不存在的会话（非草稿态）：优先取首个 session 作后备，否则草稿哨兵
          // 不变量：绝不留下空字符串 activeSessionId
          // 草稿态保持不变，不被同步进来的会话抢占
          state.activeSessionId =
            state.sessions[0]?.id || PENDING_DRAFT_SESSION_ID;
          state.activeAgentId = null;
          state.panelAgentId = null;
          syncActiveTerminalSession(state.activeSessionId || null);
        }
        useTerminalStore
          .getState()
          .pruneTerminalSessions(Object.keys(state.sessionsById));
      }),

    patchSession: (
      sessionId: string,
      patch: { goalMode?: SessionGoalMode | null }
    ) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        if ('goalMode' in patch) {
          if (patch.goalMode === null || patch.goalMode === undefined) {
            delete sess.goalMode;
          } else {
            sess.goalMode = patch.goalMode;
          }
          state.sessionsById[sessionId] = sess;
        }
      }),

    clearSessionMessages: (sessionId: string) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        if (!sess.messages?.length) return;
        sess.messages = [];
        sess.messagesHydrated = true;
        state.sessionsById[sessionId] = sess;
      }),

    /**
     * 软驱逐已水合消息（D5 / FE-INV-8）。
     * 恢复为 ACT-502 懒壳：messages=[]、messagesHydrated=false、
     * **删除 hydratedFromEngine**——否则 needsEngineMessageHydrate 恒 false。
     * 仅改内存；不调用 saveSessionBody（空数组不得写库）。
    */
    evictSessionMessages: (sessionIds: readonly string[]) =>
      set((state) => evictSessionMessagesInState(state, sessionIds)),
  };
}

/** 在 Immer 更新中按 evictSessionMessages 的同一契约清除正文。 */
export function evictSessionMessagesInState<T extends SessionStoreSlice>(
  state: T,
  sessionIds: readonly string[]
): void {
  for (const id of sessionIds) {
    if (!id) continue;
    const sess = getSessionForWrite(state, id);
    if (!sess) continue;
    sess.messages = [];
    sess.messagesHydrated = false;
    delete sess.hydratedFromEngine;
    state.sessionsById[id] = sess;
  }
}
