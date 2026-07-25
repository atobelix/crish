import React, { useEffect, useRef, useState } from 'react';
import { useLayoutStore } from '../../store/layoutStore';
import { getSessionStoreState } from '../../api/storeAccess';
import { clearAgentPanelFocus } from '../../api/openAgentPanel';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import {
  archiveUndoToastMessage,
  branchUndoToastMessage,
  BRANCH_TITLE_SUFFIX,
  clampContextMenuPosition,
  type SessionContextMenuState,
  type SessionMenuAction,
} from './SidebarContextMenus';
import { openSessionInNewWindow } from './sidebarHelpers';

export interface UseSidebarContextMenuOptions {
  onShowToast: ShowToastFn;
  setSortDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useSidebarContextMenu({
  onShowToast,
  setSortDropdownOpen,
}: UseSidebarContextMenuOptions) {
  const setActiveSessionId = useLayoutStore((s) => s.setActiveSessionId);
  const pinSession = useLayoutStore((s) => s.pinSession);
  const unpinSession = useLayoutStore((s) => s.unpinSession);
  const archiveSession = useLayoutStore((s) => s.archiveSession);
  const unarchiveSession = useLayoutStore((s) => s.unarchiveSession);
  const branchSession = useLayoutStore((s) => s.branchSession);
  const splitScreenWorkspace = useLayoutStore((s) => s.splitScreenWorkspace);

  const [contextMenu, setContextMenu] =
    useState<SessionContextMenuState | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(
    null
  );

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
    const { x, y } = clampContextMenuPosition(e.clientX, e.clientY);
    setContextMenu({ x, y, sessionId });
  };

  const handleAction = (action: SessionMenuAction) => {
    if (!contextMenu) return;
    const { sessionId } = contextMenu;
    const targetSession = getSessionStoreState().sessionsById[sessionId];
    setContextMenu(null);
    if (!targetSession) return;

    switch (action) {
      case 'open-current':
        setActiveSessionId(sessionId);
        break;
      case 'open-split':
        setActiveSessionId(sessionId);
        clearAgentPanelFocus();
        splitScreenWorkspace(sessionId);
        break;
      case 'open-new': {
        openSessionInNewWindow(targetSession);
        break;
      }
      case 'rename':
        setRenamingSessionId(sessionId);
        break;
      case 'pin':
        pinSession(sessionId);
        break;
      case 'unpin':
        unpinSession(sessionId);
        break;
      case 'archive': {
        const title = targetSession.title || '未命名会话';
        archiveSession(sessionId);
        onShowToast(archiveUndoToastMessage(title), () => {
          unarchiveSession(sessionId);
        });
        break;
      }
      case 'branch': {
        const title = targetSession.title || '未命名会话';
        const newTitle = `${title}${BRANCH_TITLE_SUFFIX}`;
        const oldId = sessionId;
        branchSession(sessionId, newTitle);
        const newBranchId = getSessionStoreState().activeSessionId;
        onShowToast(branchUndoToastMessage(title), () => {
          if (newBranchId && newBranchId !== oldId) {
            archiveSession(newBranchId);
          }
          setActiveSessionId(oldId);
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
              sessionsById: useLayoutStore.getState().sessionsById,
            });
            if (result.ok === false) {
              onShowToast(result.error || '导出失败');
            }
          } catch {
            onShowToast('导出失败');
          }
        })();
        break;
      }
      default:
        break;
    }
  };

  return {
    contextMenu,
    setContextMenu,
    renamingSessionId,
    setRenamingSessionId,
    menuRef,
    sortMenuRef,
    handleContextMenu,
    handleAction,
  };
}
