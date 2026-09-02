import { MAX_FOLDERS } from '@crish/shared-utils/browser';
import { isDemoMode } from '../api/appMode';
import { GENERAL_FOLDER, getActiveProjectId } from '../api/projectStore';
import {
  EMPTY_SESSION_TITLE,
  shellPruneKeepIds,
} from '../api/sessionTitle';
import { nowIsoTimestamp } from '../api/sessionTime';
import type { SessionImportMeta, SessionState } from './types';
import {
  deleteSessionFromIndexed,
  getSessionById,
  getSessionForWrite,
  reindexSessionsById,
} from './sessionIndex';
import { clearMessageSnapshots } from './messageSnapshotsBridge';
import { sessionRuntimeRegistry } from '../api/SessionRuntimeRegistry';
import { isPendingDraft } from './draftSession';
import { useStreamingStore } from './streamingStore';
import type {
  SessionActions,
  SessionStoreSlice,
  SessionImmerSet,
  SessionStoreGet,
} from './sessionActions';
import {
  applyTitleIfDefault,
  dropTerminalForSession,
  maybeAutoTitleSession,
  needsEngineMessageHydrate,
  normalizeWritableSessionTitle,
  pruneEmptyShellsInPlace,
  syncActiveTerminalSession,
} from './sessionSharedHelpers';

import { normalizeImportMeta } from './sessionImportMeta';
// 草稿态 actions + 共享辅助从子模块导入（保持本文件聚焦 CRUD/状态切换）
import {
  applyDraftModeToState,
  createSessionDraftActions,
} from './sessionDraftActions';
// 批量状态 actions（setSessions / patchSession / clearSessionMessages）从子模块导入
import { createSessionStateActions } from './sessionStateActions';

export function createSessionCrudActions<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>,
  get: SessionStoreGet<T>
): Pick<
  SessionActions,
  | 'setComposerDraft'
  | 'setActiveSessionId'
  | 'setActiveAgentId'
  | 'setPanelAgentId'
  | 'enterDraftMode'
  | 'setDraftFolder'
  | 'clearDraft'
  | 'commitDraftIfNeeded'
  | 'renameSession'
  | 'createSession'
  | 'deleteSession'
  | 'setSessions'
  | 'patchSession'
  | 'clearSessionMessages'
> {
  // 草稿态 actions 由子模块提供；createSession 传入以避免循环导入。
  // 先声明 createSession（下方 actions 对象内定义），再经引用注入 draft actions。
  // 由于 actions.createSession 在 actions 对象字面量内定义，而 draft actions
  // 需要调用它，这里用一个间接：draft actions 接受 createSessionFn 参数，
  // 传入 actions.createSession（在 return 时引用已构造的 actions）。

  const actions = {
    setComposerDraft: (sessionId: string, draft: string) =>
      set((state) => {
        if (!sessionId) return;
        if (!state.composerDrafts) state.composerDrafts = {};
        if (state.composerDrafts[sessionId] === draft) return;
        if (!draft) {
          delete state.composerDrafts[sessionId];
        } else {
          state.composerDrafts[sessionId] = draft;
        }
      }),

    setActiveSessionId: (id: string) => {
      // 维度 3 步骤 1（3-C）：补 normalizeSessionId 等价防御（trim + 空值检查）。
      // 此前 store 原生 action 仅做空值检查，未 trim；调用方（workspaceShellStore）
      // 现改为直调本 store action（斩断 store → api/storeAccess 反向边），
      // 故防御须在 action 内自洽（与 api/store-access/sessionAccess 的
      // normalizeSessionId 口径一致：trim 后空 → 保持当前/进入草稿态）。
      const nextId = typeof id === 'string' ? id.trim() : '';
      // 不变量：activeSessionId 绝不允许为空字符串，否则 UI 会触发"暂无会话"空屏。
      //
      // 分支策略：
      // 1. 空 / null → 若当前 active 有效则保持（no-op）；否则进入草稿态（保留现有 draftFolder）
      // 2. 草稿哨兵 → 切换到草稿态，保留现有 draftFolder（非 fresh draft）
      // 3. 有效会话 → 正常切换
      // 4. 未知非空 ID → 保持当前 active（若有效），否则进入草稿态
      if (!nextId) {
        set((state) => {
          if (
            state.activeSessionId &&
            (isPendingDraft(state.activeSessionId) ||
              getSessionById(state, state.activeSessionId))
          ) {
            // 当前 active 有效，保持不变
            return;
          }
          // 当前 active 无效 → 进入草稿态（保留现有 draftFolder 若非空）
          const keepFolder = state.draftFolder || undefined;
          applyDraftModeToState(state, keepFolder);
        });
        return;
      }
      if (isPendingDraft(nextId)) {
        // 切换到草稿态：保留现有 draftFolder（非 fresh draft）
        set((state) => {
          const keepFolder = state.draftFolder || undefined;
          applyDraftModeToState(state, keepFolder);
        });
        return;
      }
      let skipped = false;
      set((state) => {
        if (!getSessionById(state, nextId)) {
          // 未知非空 ID：标记跳过，在 set 外判断是否需要草稿态收口
          skipped = true;
          return;
        }
        const same = state.activeSessionId === nextId;
        state.activeSessionId = nextId;
        state.draftFolder = '';
        if (!same) {
          state.activeAgentId = null;
          state.panelAgentId = null;
          syncActiveTerminalSession(nextId);
        }
      });
      // 未知 ID 且当前 active 也无效 → 进入草稿态收口
      if (skipped) {
        set((state) => {
          if (
            state.activeSessionId &&
            !isPendingDraft(state.activeSessionId) &&
            getSessionById(state, state.activeSessionId)
          ) {
            // 当前 active 有效，保持不变（忽略未知 ID）
            return;
          }
          if (isPendingDraft(state.activeSessionId)) {
            // 已在草稿态，保持
            return;
          }
          // 当前 active 无效 → 进入草稿态
          const keepFolder = state.draftFolder || undefined;
          applyDraftModeToState(state, keepFolder);
        });
        return;
      }
      if (!isDemoMode()) {
        const sess = getSessionById(get(), nextId);
        if (sess) {
          void import('../api/projectStore').then(
            ({ activateWorkspaceForSessionFolder }) => {
              activateWorkspaceForSessionFolder(sess.folder);
            }
          );
          // Lazy message hydrate：list/sync 可只带 title；正文在 activate 时从引擎补。
          // 非丢消息 — 见 needsEngineMessageHydrate / store README「会话消息水合」。
          if (needsEngineMessageHydrate(sess)) {
            void import('../api/sessionEventHydrate').then(
              ({ hydrateSessionMessagesFromEngine, mergeMessagesById }) => {
                void hydrateSessionMessagesFromEngine(nextId).then((res) => {
                  if (!res.ok) return;
                  set((state) => {
                    // getSessionForWrite：经 sessions[] 写，避免 immer 只 fork sessionsById
                    // 导致 MCP/侧栏读 sessions[].messages 仍为 [] 的假「丢消息」
                    const s = getSessionForWrite(state, nextId);
                    if (!s) return;
                    // 按 id 合并：本地乐观消息 + 引擎回放不双 append；重放 length 不增
                    if (res.messages.length > 0) {
                      s.messages = mergeMessagesById(
                        s.messages || [],
                        res.messages
                      );
                      s.timestamp = nowIsoTimestamp();
                      s.timestampSource = 'remote';
                      maybeAutoTitleSession(state, s);
                    } else if (s.messages && s.messages.length > 0) {
                      maybeAutoTitleSession(state, s);
                    }
                    // P1-D2：游标取 max 保护——分页拉全后 nextAfterSequence 必然
                    // 前进；任何异常路径（如截断态）也不允许回拨既有游标
                    // （对齐 R2 §6 修复建议 1）
                    s.engineCursor = Math.max(
                      s.engineCursor ?? 0,
                      res.nextAfterSequence
                    );
                    if (res.lastRunId) s.engineLastRunId = res.lastRunId;
                    s.hydratedFromEngine = true;
                    // P1-D2：截断态标记。分页拉全成功（无 truncated）时清除——
                    // 拉全后标记自然清除，persist 熔断随之解除（见
                    // sessionRustDb.isHydrateTruncated）
                    if (res.truncated === true) {
                      s.hydrateTruncated = true;
                    } else {
                      delete s.hydrateTruncated;
                    }
                    // 再绑一次：保证 finalize 后 map 与数组同引用
                    state.sessionsById[nextId] = s;
                  });
                });
              }
            );
          }
        }
      }
    },

    setActiveAgentId: (id: string | null) =>
      set((state) => {
        if (id) {
          state.activeAgentId = null;
          state.panelAgentId = id;
        } else {
          state.activeAgentId = null;
        }
      }),

    setPanelAgentId: (id: string | null) =>
      set((state) => {
        state.panelAgentId = id;
      }),

    // enterDraftMode / setDraftFolder / clearDraft / commitDraftIfNeeded
    // 由 createSessionDraftActions 提供（见 return 处合并）。

    renameSession: (sessionId: string, title: string) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        const next = normalizeWritableSessionTitle(title);
        if (!next) return;
        if (sess.title === next) return;
        sess.title = next;
        state.sessionsById[sessionId] = sess;
      }),

    /**
     * 创建 / 附加真会话（写入 sessions[]）。
     *
     * **允许路径**：commitDraftIfNeeded、系统/定时占位（activate:false + 真实标题）、
     * 测试、显式 id attach。
     *
     * **禁止用户路径**：侧栏/快捷键/空态 CTA「新建」不得直接 create 默认标题空壳
     * → 应 enterDraftMode / shell.openNewDraftTab（ADR pending-draft / inventory #9）。
     *
     * 语义：mint 新 id | attach explicitId | activate:false 后台占位；**禁止 reuse 空壳**。
     * commit 后可短暂出现默认标题「新会话」真会话（shouldList=false）；
     * 历史脏壳仅由 hydrate/setSessions → prepareSessionsForUi GC（非 create 故事）。
     */
    createSession: (opts?: {
      title?: string;
      folder?: string;
      id?: string;
      activate?: boolean;
      importMeta?: SessionImportMeta;
    }) => {
      const explicitId =
        opts?.id && typeof opts.id === 'string' ? opts.id.trim() : '';
      const activate = opts?.activate !== false;
      const requestedTitle = normalizeWritableSessionTitle(opts?.title);
      const initialTitle = requestedTitle || EMPTY_SESSION_TITLE;
      const importMeta = normalizeImportMeta(opts?.importMeta);

      // 始终 mint 新 id（或 attach 显式 id）；不查找/复用既有空壳
      const id = explicitId || `sess-${Date.now()}`;
      set((state) => {
        const existing = getSessionById(state, id);
        if (existing) {
          const prevActive = state.activeSessionId;
          if (activate) {
            state.activeSessionId = id;
            state.activeAgentId = null;
            state.panelAgentId = null;
            syncActiveTerminalSession(id);
            state.draftFolder = '';
          }
          applyTitleIfDefault(existing, requestedTitle);
          if (importMeta && !existing.importMeta) {
            existing.importMeta = importMeta;
          }
          pruneEmptyShellsInPlace(
            state,
            shellPruneKeepIds(id, prevActive, { activating: activate })
          );
          return;
        }
        const projectId = getActiveProjectId();
        const activeSess = state.activeSessionId
          ? getSessionById(state, state.activeSessionId)
          : null;
        const currentFolder = activeSess?.folder;
        const defaultFolder = isDemoMode()
          ? opts?.folder || '常规会话'
          : opts?.folder ||
            currentFolder ||
            state.draftFolder ||
            projectId ||
            GENERAL_FOLDER;
        const sess: SessionState = {
          id,
          title: initialTitle,
          folder: defaultFolder,
          isPinned: false,
          isArchived: false,
          timestamp: nowIsoTimestamp(),
          messages: [],
          ...(importMeta ? { importMeta } : {}),
        };
        state.sessions.unshift(sess);
        reindexSessionsById(state);
        if (
          !state.folderOrder.includes(sess.folder) &&
          state.folderOrder.length < MAX_FOLDERS
        ) {
          state.folderOrder.unshift(sess.folder);
        }
        if (activate) {
          state.activeSessionId = id;
          state.activeAgentId = null;
          state.panelAgentId = null;
          syncActiveTerminalSession(id);
          state.draftFolder = '';
        }
      });
      return id;
    },

    deleteSession: (sessionId: string) => {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!id) return false;
      let removed = false;
      set((state) => {
        removed = deleteSessionFromIndexed(state, id);
        if (!removed) return;
        dropTerminalForSession(state, id);
        // 纯数据面：只删目标。不拿 sessions[] 邻居覆盖画面，也不在删除路径
        // prune 邻居空壳（那会把未打开的历史会话一并 GC）。画面由
        // shell.deleteSessionAndCloseTab → syncSessionFromActiveLeaf 校正。
      });
      if (removed) {
        sessionRuntimeRegistry.remove(id);
        clearMessageSnapshots(id);
        useStreamingStore.getState().clearSession(id);
      }
      return removed;
    },

    // setSessions / patchSession / clearSessionMessages 由 createSessionStateActions 提供（见 return 处合并）。
  };

  // 草稿态 actions 注入 createSession 引用（避免循环导入）后合并
  const draftActions = createSessionDraftActions(set, get, actions.createSession);
  // 批量状态 actions（setSessions / patchSession / clearSessionMessages）
  const stateActions = createSessionStateActions(set);
  return { ...actions, ...draftActions, ...stateActions };
}
