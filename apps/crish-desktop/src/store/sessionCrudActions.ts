import { MAX_FOLDERS } from '@crish/shared-utils/browser';
import { isDemoMode } from '../api/appMode';
import { GENERAL_FOLDER, getActiveProjectId } from '../api/projectStore';
import {
  EMPTY_SESSION_TITLE,
  prepareSessionsForUi,
  shellPruneKeepIds,
} from '../api/sessionTitle';
import { nowIsoTimestamp } from '../api/sessionTime';
import type { SessionGoalMode, SessionImportMeta, SessionState } from './types';
import {
  deleteSessionFromIndexed,
  getSessionById,
  getSessionForWrite,
  getSessionIndex,
  reindexSessionsById,
} from './sessionIndex';
import { clearMessageSnapshots } from './messageSnapshotsBridge';
import { sessionRuntimeRegistry } from '../api/SessionRuntimeRegistry';
import { PENDING_DRAFT_SESSION_ID, isPendingDraft } from './draftSession';
import {
  recordDraftCommit,
  recordDraftEnter,
} from '../api/controlMetrics';
import { runEmptyShellAssert } from '../dev/emptyShellAssert';
import { useTerminalStore } from './terminalStore';
import type { SessionActions, SessionStoreSlice, SessionImmerSet, SessionStoreGet } from './sessionActions';
import {
  applyTitleIfDefault,
  dropTerminalForSession,
  maybeAutoTitleSession,
  needsEngineMessageHydrate,
  normalizeWritableSessionTitle,
  pickFallbackActiveSessionId,
  pruneEmptyShellsInPlace,
} from './sessionSharedHelpers';

/** 规范化外部导入 meta；非法则丢弃（不写坏字段） */
function normalizeImportMeta(
  raw: SessionImportMeta | undefined,
): SessionImportMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source =
    raw.source === 'claude-code' || raw.source === 'codex' ? raw.source : null;
  const sourceSessionId =
    typeof raw.sourceSessionId === 'string' ? raw.sourceSessionId.trim() : '';
  if (!source || !sourceSessionId) return undefined;
  const meta: SessionImportMeta = { source, sourceSessionId };
  if (typeof raw.sourcePath === 'string' && raw.sourcePath.trim()) {
    meta.sourcePath = raw.sourcePath.trim();
  }
  if (typeof raw.importedAt === 'string' && raw.importedAt.trim()) {
    meta.importedAt = raw.importedAt.trim();
  }
  return meta;
}

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
  /**
   * 草稿态状态写入（共享辅助）：
   * 将 activeSessionId 设为草稿哨兵，并补齐 draftFolder / agent / terminalLines。
   *
   * 不变量：activeSessionId 绝不允许为空字符串，必须始终是有效会话 ID 或草稿哨兵。
   * 此辅助函数是所有"进入草稿态"路径的统一收口点，确保 draftFolder 不会缺失。
   */
  const applyDraftModeToState = (
    state: SessionStoreSlice,
    folder?: string
  ) => {
    state.activeSessionId = PENDING_DRAFT_SESSION_ID;
    state.draftFolder =
      (typeof folder === 'string' && folder.trim()) ||
      getActiveProjectId() ||
      GENERAL_FOLDER ||
      '';
    state.activeAgentId = null;
    state.panelAgentId = null;
    useTerminalStore.getState().setActiveTerminalSession(
      PENDING_DRAFT_SESSION_ID
    );
  };

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
      const nextId = typeof id === 'string' ? id : '';
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
          useTerminalStore.getState().setActiveTerminalSession(nextId);
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
                      s.messages = mergeMessagesById(s.messages || [], res.messages);
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

    enterDraftMode: (folder?: string) => {
      set((state) => applyDraftModeToState(state, folder));
      // D2：draft_enter 计数（内存）
      recordDraftEnter();
    },

    setDraftFolder: (folder: string) => {
      set((state) => {
        state.draftFolder = typeof folder === 'string' ? folder : '';
      });
    },

    clearDraft: () => {
      // 不变量：clearDraft 后 activeSessionId 仍不允许为空字符串。
      // 语义上"清除草稿"= 退出当前草稿、进入一个全新的空白草稿态。
      // 这样保证 UI 永远显示"我们该在 X 中处理什么？"欢迎面，绝不触发"暂无会话"空屏。
      set((state) => applyDraftModeToState(state));
    },

    /**
     * 草稿 → 真会话：仅在发送首条/需持久化写时调用。
     * 内部唯一「用户路径 → createSession」收口；folder 取 commit 瞬间的 draftFolder。
     * 始终返回可用真 session id（脏 active 也会 enter→mint），调用方无需 createSession 兜底。
     */
    commitDraftIfNeeded: (opts?: { title?: string; folder?: string }) => {
      const st = get();
      // 草稿态 或 空 active（遗留脏态）→ mint 真会话
      if (!isPendingDraft(st.activeSessionId)) {
        if (st.activeSessionId && getSessionById(st, st.activeSessionId)) {
          return st.activeSessionId;
        }
        // 遗留脏态（active 为空或指向不存在的会话）：先进入草稿态再 commit
        set((state) => applyDraftModeToState(state));
      }
      const cur = get();
      const folder =
        opts?.folder ||
        cur.draftFolder ||
        getActiveProjectId() ||
        GENERAL_FOLDER;
      // createSession 允许：commit / 系统 / 测试；用户「新建」禁止直调
      const id = actions.createSession({
        ...(opts?.title !== undefined ? { title: opts.title } : {}),
        folder,
        activate: true,
      });
      // D2：draft_commit 计数（仅实际 mint 路径）
      recordDraftCommit();
      return id;
    },

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
            useTerminalStore.getState().setActiveTerminalSession(id);
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
          useTerminalStore.getState().setActiveTerminalSession(id);
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
        const idx = getSessionIndex(state, id);
        const wasActive = state.activeSessionId === id;
        const fallback = wasActive
          ? pickFallbackActiveSessionId(state, id, idx >= 0 ? idx : 0)
          : '';
        removed = deleteSessionFromIndexed(state, id);
        if (!removed) return;
        dropTerminalForSession(state, id);
        if (wasActive) {
          if (isPendingDraft(fallback)) {
            // 草稿态后备：复用 applyDraftModeToState 补齐 draftFolder / agent / terminal
            applyDraftModeToState(state);
          } else {
            state.activeSessionId = fallback;
            state.activeAgentId = null;
            state.panelAgentId = null;
            useTerminalStore.getState().setActiveTerminalSession(fallback);
          }
        }
        pruneEmptyShellsInPlace(
          state,
          shellPruneKeepIds(state.activeSessionId || null, null, {
            activating: true,
          })
        );
      });
      if (removed) {
        sessionRuntimeRegistry.remove(id);
        clearMessageSnapshots(id);
      }
      return removed;
    },

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
          state.activeSessionId = state.sessions[0]?.id || PENDING_DRAFT_SESSION_ID;
          state.activeAgentId = null;
          state.panelAgentId = null;
          useTerminalStore.getState().setActiveTerminalSession(
            state.activeSessionId || null
          );
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
        state.sessionsById[sessionId] = sess;
      }),
  };

  return actions;
}
