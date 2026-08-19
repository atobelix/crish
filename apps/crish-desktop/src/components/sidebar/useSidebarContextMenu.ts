import React, { useEffect, useRef, useState } from 'react';
import { clearAgentPanelFocus } from '../../api/openAgentPanel';
import { sessionListDisplayTitle } from '../../api/sessionTitle';
import { getCompositionRoot } from '../../app/compositionRoot';
import { toast } from '../../services/toast/ToastContext';
import {
  findChatLeafBySessionId,
  listChatLeaves,
  collectLeaves,
} from '../../store/storeAccess';
import { viewRegistry } from '../../services/view-registry';
import {
  archiveUndoToastMessage,
  branchUndoToastMessage,
  BRANCH_TITLE_SUFFIX,
  type SessionContextMenuState,
  type SessionMenuAction,
} from './SidebarContextMenus';
import { openSessionInNewWindow } from './sidebarHelpers';

/**
 * 侧栏「拆分视图」：在 layout-tree 上 split 出第二个 chat leaf 并绑定 session。
 * 已有该 session 的 chat leaf 时仅 focus（1 session ↔ 0..1 leaf）。
 * 不再走 legacy splitScreenWorkspace（只增 workspaces[]，不会产生 multi-unit）。
 */
function openSessionInChatSplit(
  sessionId: string,
  opts?: { title?: string; workspaceKey?: string }
): void {
  const sid = (sessionId || '').trim();
  if (!sid) return;

  const root = getCompositionRoot();
  const tree = root.tree.getState();
  const existing = findChatLeafBySessionId(tree.tree.root, sid);
  if (existing) {
    root.session.openOrFocusSession(sid, opts);
    return;
  }

  const chats = listChatLeaves(tree.tree.root);
  if (chats.length === 0) {
    root.session.openOrFocusSession(sid, opts);
    return;
  }

  const target = chats.find((c) => c.id === tree.activeLeafId) ?? chats[0]!;

  // 目标 leaf 未绑定时，先绑 shell active，避免两 pane 都跟 shell 漂
  const shell = root.shell.getState();
  const shellSid =
    shell.openTabs.find((t) => t.tabId === shell.activeTabId)?.sessionId ??
    null;
  if (!target.sessionId && shellSid && shellSid !== sid) {
    root.tree.setLeafSessionId(target.id, shellSid);
  }

  const beforeIds = new Set(
    collectLeaves(root.tree.getState().tree.root).map((l) => l.id)
  );
  // splitLeaf 未上 tree 门面（E5）；经 tree.getState 单一命令入口
  root.tree.getState().splitLeaf(target.id, 'horizontal', 'chat', 'after', 0.5);

  const after = root.tree.getState();
  const newLeaf = collectLeaves(after.tree.root).find(
    (l) => viewRegistry.isPrimary(l.panelId) && !beforeIds.has(l.id)
  );
  if (newLeaf) {
    root.tree.setLeafSessionId(newLeaf.id, sid);
    after.setActiveLeaf(newLeaf.id);
  }

  // 开/聚焦 shell tab；多 chat 时 bind 会 focus 已绑定 leaf，不会 rebind 邻居
  root.session.openOrFocusSession(sid, opts);
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

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
      if (
        sortMenuRef.current &&
        !sortMenuRef.current.contains(e.target as Node)
      ) {
        const sortBtn = (e.target as HTMLElement).closest('.sort-btn');
        if (!sortBtn) setSortDropdownOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setSortDropdownOpen(false);
      }
    };
    document.addEventListener('click', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [setSortDropdownOpen]);

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    setRenamingSessionId(null);
    // 严格保存原始物理点击坐标，不可变锚点传递给浮层组件（彻底根除 Double Flip 二次翻转）
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  };

  const handleAction = (action: SessionMenuAction) => {
    if (!contextMenu) return;
    const { sessionId } = contextMenu;
    const root = getCompositionRoot();
    const targetSession = root.session.getState().sessionsById[sessionId];
    setContextMenu(null);
    if (!targetSession) return;

    switch (action) {
      case 'open-current':
        root.session.openOrFocusSession(sessionId, {
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
        openSessionInNewWindow(targetSession);
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
        root.session.branchSession(sessionId, newTitle);
        const newBranchId = root.session.getActiveSessionId();
        toast.show(branchUndoToastMessage(title), () => {
          if (newBranchId && newBranchId !== oldId) {
            root.session.archiveSession(newBranchId);
          }
          // 回焦点用 getState 命令式写（setActive 非门面入口，避免 god DI）
          root.session.getState().setActiveSessionId(oldId);
        });
        break;
      }
      case 'export': {
        const session = targetSession;
        void (async () => {
          try {
            const { tryDownloadSessionMarkdown } =
              await import('../../api/sessionExport');
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
        navigator.clipboard.writeText(sessionId);
        toast.show('会话 ID 已复制到剪贴板');
        break;
      case 'delete': {
        const title = sessionListDisplayTitle(targetSession);
        // 弹窗确认由宿主装配：确认后走 confirmDelete → deleteSession + toast
        setPendingDelete({ sessionId, title });
        break;
      }
      default:
        break;
    }
  };

  const confirmDelete = React.useCallback(() => {
    if (!pendingDelete) return;
    const root = getCompositionRoot();
    // 删除走 sessionStore 命令式入口（SessionFacade 无 deleteSession）
    root.session.getState().deleteSession(pendingDelete.sessionId);
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
    handleContextMenu,
    handleAction,
  };
}
