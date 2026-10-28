import React, { useRef, useState } from 'react';
import { clearAgentPanelFocus } from '../../api/openAgentPanel';
import { sessionListDisplayTitle } from '../../api/sessionTitle';
import { getCompositionRoot } from '../../app/compositionRoot';
import { toast } from '../../services/toast/ToastContext';
import {
  archiveUndoToastMessage,
  branchUndoToastMessage,
  BRANCH_TITLE_SUFFIX,
  type SessionContextMenuState,
  type SessionMenuAction,
} from './SidebarContextMenus';
import { toggleExclusiveMenu } from '@/components/ui';
import { openSessionInNewWindow } from './sidebarHelpers';
import {
  deleteSessionCascade,
  triggerSessionMessageHydrateIfNeeded,
} from '../../store/storeAccess';

type OpenSessionOpts = {
  title?: string;
  workspaceKey?: string;
  split?: 'right' | 'left' | 'top' | 'bottom';
};

function shellOpenSession(sessionId: string, opts?: OpenSessionOpts): void {
  getCompositionRoot().shell.openSession(sessionId, opts);
}

/**
 * 侧栏「拆分视图」：已打开 → openSession 聚焦；未打开且 split → 新叶只含该 session。
 */
function openSessionInChatSplit(
  sessionId: string,
  opts?: { title?: string; workspaceKey?: string }
): void {
  const sid = (sessionId || '').trim();
  if (!sid) return;
  shellOpenSession(sid, { ...opts, split: 'right' });
}

export interface UseSidebarContextMenuOptions {
  setSortDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useSidebarContextMenu({
  setSortDropdownOpen,
}: UseSidebarContextMenuOptions) {
  // pin/archive/branch 等命令式写走 compositionRoot.session；列表渲染仍用 selectors
  const [contextMenu, setContextMenu] =
    useState<SessionContextMenuState | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(
    null
  );
  // 删除会话确认（04-detail §2.1.3 宿主迁移）：hook 只登记待删目标与回调，
  // 不渲染 Dialog——由宿主（Sidebar.tsx）装配 ConfirmDialog 渲染
  const [pendingDelete, setPendingDelete] = useState<{
    sessionId: string;
    title: string;
  } | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuTriggerRef = useRef<HTMLElement | null>(null);

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    const customTrigger = (e as unknown as { triggerEl?: HTMLElement })
      .triggerEl;
    const rawTarget =
      customTrigger ??
      (e.currentTarget instanceof HTMLElement ? e.currentTarget : null) ??
      (e.target instanceof HTMLElement ? e.target : null);

    const isMoreTrigger = Boolean(
      (e as unknown as { isMoreButton?: boolean }).isMoreButton ||
      rawTarget?.dataset?.testid === 'session-more-button' ||
      rawTarget?.closest?.('[data-testid="session-more-button"]')
    );

    const moreBtn = rawTarget?.closest?.(
      '[data-testid="session-more-button"]'
    ) as HTMLElement | null;
    const triggerEl = isMoreTrigger ? (moreBtn ?? rawTarget) : rawTarget;

    const openThis = () => {
      setRenamingSessionId(null);
      setSortDropdownOpen(false);
      contextMenuTriggerRef.current = triggerEl;

      const triggerRect = triggerEl?.getBoundingClientRect();
      const customRect = (
        e as unknown as {
          triggerRect?: {
            left: number;
            top: number;
            right: number;
            bottom: number;
            width: number;
            height: number;
          };
        }
      ).triggerRect;
      const finalRect =
        triggerRect && (triggerRect.width > 0 || triggerRect.height > 0)
          ? {
              left: triggerRect.left,
              top: triggerRect.top,
              right: triggerRect.right,
              bottom: triggerRect.bottom,
              width: triggerRect.width,
              height: triggerRect.height,
            }
          : customRect;

      const nextMenuState: SessionContextMenuState = {
        x: e.clientX,
        y: e.clientY,
        sessionId,
      };
      if (isMoreTrigger) {
        nextMenuState.isMoreButton = true;
      }
      if (finalRect && (finalRect.width > 0 || finalRect.height > 0)) {
        nextMenuState.triggerRect = finalRect;
      }

      // 严格保存原始物理点击坐标，不可变锚点传递给浮层组件（彻底根除 Double Flip 二次翻转）
      setContextMenu(nextMenuState);
    };

    // 只有左键「更多」走 exclusive（开着写死 false，外点关后抑制重开）。
    // 右键 / 键盘 / 其它左键不得进 toggle——否则会把行选择或右键开菜单吞掉。
    if (isMoreTrigger && e.button !== 2) {
      e.preventDefault();
      toggleExclusiveMenu(
        contextMenu?.sessionId === sessionId,
        (next) => {
          if (next) openThis();
          else setContextMenu(null);
        },
        triggerEl
      );
      return;
    }

    e.preventDefault();
    openThis();
  };

  const handleAction = (
    action: SessionMenuAction,
    customSessionId?: string
  ) => {
    const sessionId = customSessionId || contextMenu?.sessionId;
    if (!sessionId) return;
    const root = getCompositionRoot();
    const store = root.session.getState();
    const targetSession =
      store.sessionsById[sessionId] ??
      store.sessions.find((s) => s.id === sessionId);
    setContextMenu(null);
    if (!targetSession) return;

    switch (action) {
      case 'open-current':
        shellOpenSession(sessionId, {
          title: targetSession.title,
          workspaceKey: targetSession.folder,
        });
        break;
      case 'open-split':
        clearAgentPanelFocus();
        openSessionInChatSplit(sessionId, {
          title: targetSession.title,
          workspaceKey: targetSession.folder,
        });
        break;
      case 'open-new': {
        void (async () => {
          await triggerSessionMessageHydrateIfNeeded(sessionId);
          const current =
            root.session.getState().sessionsById[sessionId] ?? targetSession;
          openSessionInNewWindow(current);
        })();
        break;
      }
      case 'rename':
        setRenamingSessionId(sessionId);
        break;
      case 'pin':
        // 仅 pin，不 open/focus；经 session 门面 → getSessionStoreState().pinSession
        root.session.pinSession(sessionId);
        break;
      case 'unpin':
        root.session.unpinSession(sessionId);
        break;
      case 'archive': {
        const title = sessionListDisplayTitle(targetSession);
        root.shell.getState().closeTabBySessionId(sessionId);
        root.session.archiveSession(sessionId);
        toast.show(archiveUndoToastMessage(title), () => {
          root.session.unarchiveSession(sessionId);
        });
        break;
      }
      case 'branch': {
        const title = sessionListDisplayTitle(targetSession);
        const newTitle = `${title}${BRANCH_TITLE_SUFFIX}`;
        const oldId = sessionId;
        void (async () => {
          await triggerSessionMessageHydrateIfNeeded(sessionId);
          root.session.branchSession(sessionId, newTitle);
          const newBranchId = root.session.getActiveSessionId();
          if (newBranchId && newBranchId !== oldId) {
            const newSess = root.session.getState().sessionsById[newBranchId];
            shellOpenSession(newBranchId, {
              title: newSess?.title ?? newTitle,
              workspaceKey: newSess?.folder ?? targetSession.folder,
            });
          }
          toast.show(branchUndoToastMessage(title), () => {
            if (newBranchId && newBranchId !== oldId) {
              root.shell.getState().closeTabBySessionId(newBranchId);
              root.session.archiveSession(newBranchId);
            }
            // 回焦点用 getState 命令式写（setActive 非门面入口，避免 god DI）
            root.session.getState().setActiveSessionId(oldId);
          });
        })();
        break;
      }
      case 'export': {
        void (async () => {
          try {
            await triggerSessionMessageHydrateIfNeeded(sessionId);
            const { tryDownloadSessionMarkdown } =
              await import('../../api/sessionExport');
            const session =
              root.session.getState().sessionsById[sessionId] ?? targetSession;
            const result = tryDownloadSessionMarkdown(session, new Date(), {
              sessionsById: root.session.getState().sessionsById,
            });
            if (result.ok === false) {
              toast.show(result.error || '导出失败');
            }
          } catch {
            toast.show('导出失败');
          }
        })();
        break;
      }
      case 'copy-id':
        navigator.clipboard
          .writeText(sessionId)
          .then(() => {
            toast.show('会话 ID 已复制到剪贴板');
          })
          .catch(() => {
            toast.show('复制失败');
          });
        break;
      case 'delete': {
        const title = sessionListDisplayTitle(targetSession);
        // 弹窗确认由宿主装配：确认后走 confirmDelete → deleteSessionCascade + toast
        setPendingDelete({ sessionId, title });
        break;
      }
      default:
        break;
    }
  };

  const confirmDelete = React.useCallback(() => {
    if (!pendingDelete) return;
    deleteSessionCascade(pendingDelete.sessionId);
    toast.show(`已删除对话: ${pendingDelete.title}`);
    setPendingDelete(null);
  }, [pendingDelete]);

  const cancelDelete = React.useCallback(() => {
    setPendingDelete(null);
  }, []);

  return {
    contextMenu,
    setContextMenu,
    renamingSessionId,
    setRenamingSessionId,
    pendingDelete,
    confirmDelete,
    cancelDelete,
    menuRef,
    sortMenuRef,
    contextMenuTriggerRef,
    handleContextMenu,
    handleAction,
  };
}
