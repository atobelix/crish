import { MAX_FOLDERS } from '@crish/shared-utils/browser';
import { isDemoMode } from '../api/appMode';
import { GENERAL_FOLDER, getActiveProjectId } from '../api/projectStore';
import {
  EMPTY_SESSION_TITLE,
  shellPruneKeepIds,
} from '../api/sessionTitle';
import { nowIsoTimestamp } from '../api/sessionTime';
import type { SessionImportMeta, SessionState } from './types';
import type { MessageContextInjection } from './types';
import {
  deleteSessionFromIndexed,
  getSessionById,
  getSessionForWrite,
  rebindSessionById,
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
import { triggerSessionMessageHydrateIfNeeded } from './sessionActivateHydrate';
// 可见注入卡片挂载辅助纯函数（addContextInjection 复用，见 sessionInjectionMount.ts）
import {
  appendInjectionToMessage,
  findInjectionMountTarget,
  isContextStateCarrierMessage,
  makeInjectionCarrierMessage,
} from './sessionInjectionMount';

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
  | 'addContextInjection'
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
          triggerSessionMessageHydrateIfNeeded(nextId, get, set);
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
      let isDeletingActive = false;
      let nextActiveIdToSwitch: string | null = null;

      set((state) => {
        // 1. 检查被删除的是否为当前活跃会话
        isDeletingActive = state.activeSessionId === id;

        if (isDeletingActive) {
          // 原子计算相邻会话焦点转移（优先右邻居，退化左邻居，无则切安全空会话）
          const currentIdx = state.sessions.findIndex((s) => s.id === id);
          if (currentIdx !== -1) {
            const candidate =
              state.sessions[currentIdx + 1] || state.sessions[currentIdx - 1];
            nextActiveIdToSwitch = candidate ? candidate.id : null;
          }
        }

        // 2. 从索引与数组中物理删除目标会话
        removed = deleteSessionFromIndexed(state, id);
        if (!removed) return;
        dropTerminalForSession(state, id);

        // 3. 关键：若是活跃会话被删除，在同一次 set 原子事务中转移焦点，彻底消灭悬垂指针与白屏
        if (isDeletingActive) {
          if (nextActiveIdToSwitch && state.sessionsById[nextActiveIdToSwitch]) {
            state.activeSessionId = nextActiveIdToSwitch;
            state.draftFolder = '';
            state.activeAgentId = null;
            state.panelAgentId = null;
            syncActiveTerminalSession(nextActiveIdToSwitch);
          } else if (state.sessions.length > 0 && state.sessions[0]) {
            // 兜底：若邻居未命中但仍有剩余会话，切到首个有效会话
            const fallbackId = state.sessions[0].id;
            state.activeSessionId = fallbackId;
            state.draftFolder = '';
            state.activeAgentId = null;
            state.panelAgentId = null;
            syncActiveTerminalSession(fallbackId);
          } else {
            // 无剩余会话：原子切入安全草稿态，绝不残留悬垂 ID 或空串导致全白崩溃
            applyDraftModeToState(state);
          }
        }
      });

      if (removed) {
        sessionRuntimeRegistry.remove(id);
        clearMessageSnapshots(id);
        useStreamingStore.getState().clearSession(id);

        // 若当前活动会话发生了焦点转移且切入具体真实会话，触发必要的工作区激活与懒加载
        if (isDeletingActive && !isDemoMode()) {
          const newActiveId = get().activeSessionId;
          if (newActiveId && !isPendingDraft(newActiveId)) {
            const nextSess = getSessionById(get(), newActiveId);
            if (nextSess) {
              void import('../api/projectStore').then(
                ({ activateWorkspaceForSessionFolder }) => {
                  activateWorkspaceForSessionFolder(nextSess.folder);
                }
              );
              triggerSessionMessageHydrateIfNeeded(newActiveId, get, set);
            }
          }
        }
      }
      return removed;
    },

    /**
     * 向目标会话时间线写入一条可见上下文注入卡片。
     *
     * 挂载策略（findInjectionMountTarget）：优先写入「最新可挂载消息」——
     * 进行中的助手消息或空正文注入载体消息；无任何可挂载消息时创建
     * sender='assistant' 的载体消息（makeInjectionCarrierMessage）。
     *
     * 防御：空 targetSessionId 拒绝并 console.warn；injection 缺 id 拒绝；
     * 目标会话不存在时静默 no-op（与 addMessage 对缺失会话的语义一致）。
     * 写卡动作单一路径：外部一律经 contextInjectionDispatcher 调用本 action。
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

        const target = findInjectionMountTarget(sess.messages);
        if (target) {
          appendInjectionToMessage(target, injection);
          if (injection.metadata?.mode === 'context-state') {
            // 清理紧邻目标之前的冗余纯 context-state 载体消息（彻底治愈历史连续堆叠病灶）
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

    // setSessions / patchSession / clearSessionMessages 由 createSessionStateActions 提供（见 return 处合并）。
  };

  // 草稿态 actions 注入 createSession 引用（避免循环导入）后合并
  const draftActions = createSessionDraftActions(set, get, actions.createSession);
  // 批量状态 actions（setSessions / patchSession / clearSessionMessages）
  const stateActions = createSessionStateActions(set);
  return { ...actions, ...draftActions, ...stateActions };
}

export { triggerSessionMessageHydrateIfNeeded } from './sessionActivateHydrate';

