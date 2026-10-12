/**
 * 草稿态 actions 工厂：从 sessionCrudActions 拆出。
 * 聚焦草稿哨兵态的进入 / 清除 / 提交，及共享的 applyDraftModeToState 辅助。
 *
 * 不变量：activeSessionId 绝不允许为空字符串，必须始终是有效会话 ID 或草稿哨兵。
 * applyDraftModeToState 是所有"进入草稿态"路径的统一收口点。
 */

import { GENERAL_FOLDER, getActiveProjectId } from '../api/projectStore';
import { EMPTY_SESSION_TITLE, shellPruneKeepIds } from '../api/sessionTitle';
import { recordDraftCommit, recordDraftEnter } from '../api/controlMetrics';
import { PENDING_DRAFT_SESSION_ID, isPendingDraft } from './draftSession';
import { getSessionById } from './sessionIndex';
import { syncActiveTerminalSession } from './sessionSharedHelpers';
import type {
  SessionActions,
  SessionStoreSlice,
  SessionImmerSet,
  SessionStoreGet,
} from './sessionActions';
import { draftFolderRegistry } from './draft-routing/draftFolderRegistry';
import { sessionRuntimeRegistry } from '../api/SessionRuntimeRegistry';

export interface CommitDraftOptions {
  title?: string;
  folder?: string;
  draftSessionId?: string;
}

export { draftFolderRegistry };
export const draftFolderBySessionId = draftFolderRegistry;

export function setDraftProjectFolder(
  folder: string,
  draftSessionId?: string
): void {
  const sid = (draftSessionId || '').trim();
  if (sid) {
    draftFolderRegistry.set(sid, folder);
  }
}

export function getDraftProjectFolder(
  draftSessionId?: string
): string | undefined {
  return draftSessionId ? draftFolderRegistry.get(draftSessionId) : undefined;
}

/**
 * 草稿态状态写入（共享辅助）：
 * 将 activeSessionId 设为草稿哨兵，并补齐 draftFolder / agent / terminalLines。
 *
 * 不变量：activeSessionId 绝不允许为空字符串，必须始终是有效会话 ID 或草稿哨兵。
 * 此辅助函数是所有"进入草稿态"路径的统一收口点，确保 draftFolder 不会缺失。
 */
export function applyDraftModeToState(
  state: SessionStoreSlice,
  folder?: string,
  opts?: { draftSessionId?: string }
): void {
  const id =
    opts?.draftSessionId && isPendingDraft(opts.draftSessionId)
      ? opts.draftSessionId
      : PENDING_DRAFT_SESSION_ID;
  state.activeSessionId = id;
  const effectiveFolder =
    (typeof folder === 'string' && folder.trim()) ||
    (opts?.draftSessionId
      ? draftFolderRegistry.get(opts.draftSessionId)
      : undefined) ||
    getActiveProjectId() ||
    GENERAL_FOLDER ||
    '';
  state.draftFolder = effectiveFolder;
  if (id && effectiveFolder) {
    draftFolderRegistry.set(id, effectiveFolder);
  }
  state.activeAgentId = null;
  state.panelAgentId = null;
  syncActiveTerminalSession(id);
}

/**
 * 创建草稿态相关 actions（enterDraftMode / setDraftFolder / clearDraft /
 * commitDraftIfNeeded）。
 *
 * commitDraftIfNeeded 内部调用 createSession（由 hub 传入 createSessionFn），
 * 以避免与 sessionCrudActions 形成循环导入。
 */
export function createSessionDraftActions<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>,
  get: SessionStoreGet<T>,
  createSessionFn: (opts: {
    title?: string;
    folder?: string;
    activate?: boolean;
  }) => string
): Pick<
  SessionActions,
  'enterDraftMode' | 'setDraftFolder' | 'clearDraft' | 'commitDraftIfNeeded'
> {
  const actions = {
    enterDraftMode: (folder?: string, opts?: { draftSessionId?: string }) => {
      set((state) => applyDraftModeToState(state, folder, opts));
      // D2：draft_enter 计数（内存）
      recordDraftEnter();
    },

    setDraftFolder: (folder: string, draftSessionId?: string) => {
      set((state) => {
        const val = typeof folder === 'string' ? folder : '';
        const targetId = draftSessionId || state.activeSessionId;
        if (targetId && isPendingDraft(targetId)) {
          draftFolderRegistry.set(targetId, val);
        }
        if (!draftSessionId || draftSessionId === state.activeSessionId) {
          state.draftFolder = val;
        }
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
     * 遵循 Guard-3：若显式传入 draftSessionId 且为合法草稿，强制物化，严禁早退全局 activeSessionId。
     */
    commitDraftIfNeeded: (opts?: CommitDraftOptions | string) => {
      const normalizedOpts =
        typeof opts === 'string' ? { draftSessionId: opts } : opts;
      const st = get();
      const targetDraftId = normalizedOpts?.draftSessionId;
      const isExplicitDraft = Boolean(
        targetDraftId && isPendingDraft(targetDraftId)
      );

      // Guard-3：仅在非显式草稿且当前 active 为真实有效会话时早退；
      // 若是显式草稿分屏触发转正，无论全局焦点在哪个真会话，都必须强制创建新会话！
      if (!isExplicitDraft) {
        if (!isPendingDraft(st.activeSessionId)) {
          if (st.activeSessionId && getSessionById(st, st.activeSessionId)) {
            return st.activeSessionId;
          }
          // 遗留脏态（active 为空或指向不存在的会话）：先进入草稿态再 commit
          set((state) => applyDraftModeToState(state));
        }
      }

      const cur = get();
      const effectiveDraftId = isExplicitDraft
        ? targetDraftId!
        : cur.activeSessionId;
      const folder =
        normalizedOpts?.folder ||
        (effectiveDraftId
          ? draftFolderRegistry.get(effectiveDraftId)
          : undefined) ||
        cur.draftFolder ||
        getActiveProjectId() ||
        GENERAL_FOLDER;

      // 仅当当前转正的会话与全局 active 一致时激活，后台转正保持非激活
      const shouldActivate =
        !isExplicitDraft || cur.activeSessionId === effectiveDraftId;
      const id = createSessionFn({
        ...(normalizedOpts?.title !== undefined
          ? { title: normalizedOpts.title }
          : {}),
        folder,
        activate: shouldActivate,
      });

      // 迁移草稿内容与运行时附件/思考状态，并清理注册表
      if (effectiveDraftId && effectiveDraftId !== id) {
        set((state) => {
          if (state.composerDrafts[effectiveDraftId]) {
            state.composerDrafts[id] = state.composerDrafts[effectiveDraftId];
            delete state.composerDrafts[effectiveDraftId];
          }
        });
        try {
          if (sessionRuntimeRegistry.exists(effectiveDraftId)) {
            const runtimeState = sessionRuntimeRegistry.get(effectiveDraftId);
            sessionRuntimeRegistry.save(id, {
              attachments: runtimeState.attachments,
              thinkingTitle: runtimeState.thinkingTitle,
            });
            sessionRuntimeRegistry.remove(effectiveDraftId);
          }
        } catch {
          /* ignore */
        }
        draftFolderRegistry.delete(effectiveDraftId);
      }

      // D2：draft_commit 计数（仅实际 mint 路径）
      recordDraftCommit();
      return id;
    },
  };

  return actions;
}

// 以下常量再导出供 hub 复用（避免 hub 重复 import 多处）
export { EMPTY_SESSION_TITLE, shellPruneKeepIds, isPendingDraft };
