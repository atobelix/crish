import React, { useCallback, useRef, useState } from 'react';
import { useLayoutStore } from '../../store/layoutStore';
import { getActiveProjectId } from '../../api/projectStore';
import { setDraftFolder } from '../../api/storeAccess';
import { isPendingDraft } from '../../store/draftSession';
import { clearAgentPanelFocus } from '../../api/openAgentPanel';
import { emitUiEvent } from '../../api/uiEvents';
import type { FilterType } from './sidebarHelpers';
import { getCompositionRoot } from '../../app/compositionRoot';
import { currentWorkspaceFolderKey } from '../../api/workspaceChromeTabs';

export interface UseSidebarHandlersOptions {
  filterType: FilterType;
  setFilterType: React.Dispatch<React.SetStateAction<FilterType>>;
  setRenamingSessionId: (id: string | null) => void;
  setGeneralCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setPinnedCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setProjectsSectionCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setCollapsedProjects: React.Dispatch<
    React.SetStateAction<Record<string, boolean>>
  >;
  setActiveProjectId: (id: string | null) => void;
  setSortDropdownCoords: React.Dispatch<
    React.SetStateAction<{ x: number; y: number } | null>
  >;
  setSortDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setOverlayOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sidebarBehavior: string;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export function useSidebarHandlers({
  filterType,
  setFilterType,
  setRenamingSessionId,
  setGeneralCollapsed,
  setPinnedCollapsed,
  setProjectsSectionCollapsed,
  setCollapsedProjects,
  setActiveProjectId,
  setSortDropdownCoords,
  setSortDropdownOpen,
  setOverlayOpen,
  sidebarBehavior,
  sidebarCollapsed,
  setSidebarCollapsed,
}: UseSidebarHandlersOptions) {
  const renameSession = useLayoutStore((s) => s.renameSession);

  const [activeNav, setActiveNav] = useState('chat');
  const newSessionLockRef = useRef(false);

  const handleNewSession = useCallback(() => {
    if (newSessionLockRef.current) return;
    newSessionLockRef.current = true;
    try {
      if (filterType === 'pinned') setFilterType('all');
      setGeneralCollapsed(false);
      getCompositionRoot().shell.openNewDraftTab(
        getActiveProjectId() || undefined
      );
      setActiveNav('chat');
      setRenamingSessionId(null);
      emitUiEvent('open-chat');
    } finally {
      queueMicrotask(() => {
        newSessionLockRef.current = false;
      });
    }
  }, [filterType, setFilterType, setGeneralCollapsed, setRenamingSessionId]);

  const handleCommitRename = useCallback(
    (sessionId: string, title: string) => {
      setRenamingSessionId(null);
      if (!title) return;
      renameSession(sessionId, title);
    },
    [renameSession, setRenamingSessionId]
  );

  const handleOpenScheduled = useCallback(() => {
    setActiveNav('scheduled');
    emitUiEvent('open-scheduled');
  }, []);

  const handleSelectSession = useCallback(
    (id: string) => {
      const root = getCompositionRoot();
      const target = root.session.getState().sessionsById[id];
      root.session.openOrFocusSession(id, {
        title: target?.title,
        workspaceKey:
          target?.folder || currentWorkspaceFolderKey(getActiveProjectId()),
      });
      clearAgentPanelFocus();
      setActiveNav('chat');
      setRenamingSessionId(null);
      if (target && !target.isPinned) {
        setGeneralCollapsed(false);
        if (target.folder) {
          setCollapsedProjects((prev) =>
            prev[target.folder!] ? { ...prev, [target.folder!]: false } : prev
          );
        }
      }
      emitUiEvent('open-chat');
    },
    [setRenamingSessionId, setGeneralCollapsed, setCollapsedProjects]
  );

  const handleOpenProject = useCallback((id: string) => {
    setActiveProjectId(id);
    setCollapsedProjects((prev) => ({ ...prev, [id]: false }));
    if (isPendingDraft(getCompositionRoot().session.getActiveSessionId())) {
      setDraftFolder(id);
    }
  }, [setActiveProjectId, setCollapsedProjects]);

  const handleToggleProjectCollapsed = useCallback((id: string) => {
    setCollapsedProjects((prev) => ({ ...prev, [id]: !prev[id] }));
  }, [setCollapsedProjects]);

  const handleToggleGeneral = useCallback(() => {
    setGeneralCollapsed((v) => !v);
  }, [setGeneralCollapsed]);

  const handleTogglePinned = useCallback(() => {
    setPinnedCollapsed((v) => !v);
  }, [setPinnedCollapsed]);

  const handleToggleProjectsSection = useCallback(() => {
    setProjectsSectionCollapsed((v) => !v);
  }, [setProjectsSectionCollapsed]);

  const handleAddProject = useCallback(() => {
    emitUiEvent('pick-workspace');
  }, []);

  const handleStartRename = useCallback((id: string) => {
    setRenamingSessionId(id);
  }, [setRenamingSessionId]);

  const handleCancelRename = useCallback(() => {
    setRenamingSessionId(null);
  }, [setRenamingSessionId]);

  const handleSortBtnClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    const rect = btn.getBoundingClientRect();
    setSortDropdownCoords({ x: rect.left, y: rect.top + rect.height + 4 });
    setSortDropdownOpen((open) => !open);
  }, [setSortDropdownCoords, setSortDropdownOpen]);

  const handleOverlayClose = useCallback(() => {
    setOverlayOpen(false);
    setSidebarCollapsed(true);
  }, [setOverlayOpen, setSidebarCollapsed]);

  const handleHamburgerClick = useCallback(() => {
    if (sidebarBehavior === 'overlay') {
      setOverlayOpen(true);
      setSidebarCollapsed(false);
    } else {
      setSidebarCollapsed(!sidebarCollapsed);
    }
  }, [sidebarBehavior, sidebarCollapsed, setOverlayOpen, setSidebarCollapsed]);

  return {
    activeNav,
    handleNewSession,
    handleCommitRename,
    handleOpenScheduled,
    handleSelectSession,
    handleOpenProject,
    handleToggleProjectCollapsed,
    handleToggleGeneral,
    handleTogglePinned,
    handleToggleProjectsSection,
    handleAddProject,
    handleStartRename,
    handleCancelRename,
    handleSortBtnClick,
    handleOverlayClose,
    handleHamburgerClick,
  };
}
