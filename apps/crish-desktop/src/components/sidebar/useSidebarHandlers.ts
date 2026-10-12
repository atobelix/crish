import React, { useCallback, useRef } from 'react';
import { useSessionStore, useMainSurface } from '../../store/storeAccess';
import { getActiveProjectId } from '../../api/projectStore';
import { setDraftFolder } from '../../api/storeAccess';
import { isPendingDraft } from '../../store/storeAccess';
import { emitUiEvent } from '../../api/uiEvents';
import type { FilterType } from './sidebarHelpers';
import { getCompositionRoot } from '../../app/compositionRoot';
import { currentWorkspaceFolderKey } from '../../api/workspaceChromeTabs';
import { treeUpdateTabTitle } from '../../store/workspace-shell/treeSessionCommands';

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
  setSortDropdownCoords: _setSortDropdownCoords,
  setSortDropdownOpen,
  setOverlayOpen,
  sidebarBehavior,
  sidebarCollapsed,
  setSidebarCollapsed,
}: UseSidebarHandlersOptions) {
  const renameSession = useSessionStore((s) => s.renameSession);
  const {
    meta: surfaceMeta,
    toggleSurface,
    navigateToChatSession,
    navigateToNewDraft,
  } = useMainSurface();
  const activeNav = surfaceMeta.sidebarNavKey;
  const newSessionLockRef = useRef(false);

  const handleNewSession = useCallback(() => {
    if (newSessionLockRef.current) return;
    newSessionLockRef.current = true;
    try {
      if (filterType === 'pinned') setFilterType('all');
      setGeneralCollapsed(false);
      setRenamingSessionId(null);
      navigateToNewDraft();
    } finally {
      queueMicrotask(() => {
        newSessionLockRef.current = false;
      });
    }
  }, [
    filterType,
    setFilterType,
    setGeneralCollapsed,
    setRenamingSessionId,
    navigateToNewDraft,
  ]);

  const handleCommitRename = useCallback(
    (sessionId: string, title: string) => {
      setRenamingSessionId(null);
      if (!title) return;
      renameSession(sessionId, title);
      treeUpdateTabTitle(sessionId, title);
    },
    [renameSession, setRenamingSessionId]
  );

  const handleOpenScheduled = useCallback(() => {
    toggleSurface('scheduled');
  }, [toggleSurface]);

  const handleSelectSession = useCallback(
    (id: string) => {
      const root = getCompositionRoot();
      const target = root.session.getState().sessionsById[id];
      navigateToChatSession(id, {
        title: target?.title,
        workspaceKey:
          target?.folder || currentWorkspaceFolderKey(getActiveProjectId()),
      });
      setRenamingSessionId(null);
      if (target && !target.isPinned) {
        setGeneralCollapsed(false);
        if (target.folder) {
          setCollapsedProjects((prev) =>
            prev[target.folder!] ? { ...prev, [target.folder!]: false } : prev
          );
        }
      }
    },
    [
      setRenamingSessionId,
      setGeneralCollapsed,
      setCollapsedProjects,
      navigateToChatSession,
    ]
  );

  const handleOpenProject = useCallback(
    (id: string) => {
      setActiveProjectId(id);
      setCollapsedProjects((prev) => ({ ...prev, [id]: false }));
      if (isPendingDraft(getCompositionRoot().session.getActiveSessionId())) {
        setDraftFolder(id);
      }
    },
    [setActiveProjectId, setCollapsedProjects]
  );

  const handleToggleProjectCollapsed = useCallback(
    (id: string) => {
      setCollapsedProjects((prev) => ({ ...prev, [id]: !prev[id] }));
    },
    [setCollapsedProjects]
  );

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

  const handleStartRename = useCallback(
    (id: string) => {
      setRenamingSessionId(id);
    },
    [setRenamingSessionId]
  );

  const handleCancelRename = useCallback(() => {
    setRenamingSessionId(null);
  }, [setRenamingSessionId]);

  const handleSortBtnClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setSortDropdownOpen((open) => !open);
    },
    [setSortDropdownOpen]
  );

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
