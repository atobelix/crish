import { useEffect } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import { getSessionById } from '../store/sessionStore';
import {
  archiveSession,
  branchSession,
  enterDraftMode,
  getSessionStoreState,
  openSettings,
  setActiveSessionId,
  toggleSettingsOverlay,
} from '../api/storeAccess';
import { ShortcutService } from '../services/ShortcutService';
import { emitUiEvent } from '../api/uiEvents';
import { formatBranchUndoToast } from '../hooks/useToastQueue';
import type { SettingsTabType } from '../store/types';

export interface UseAppShortcutsOptions {
  handleShowToast: (msg: string, undoAction?: () => void) => void;
  showCheatsheet: boolean;
  setShowCheatsheet: React.Dispatch<React.SetStateAction<boolean>>;
  showSettingsOverlay: boolean;
  setShowSettingsOverlay: (show: boolean) => void;
  showFirstRun: boolean;
  setShowTelemetry: (show: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export function useAppShortcuts({
  handleShowToast,
  showCheatsheet,
  setShowCheatsheet,
  showSettingsOverlay,
  setShowSettingsOverlay,
  showFirstRun,
  setShowTelemetry,
  setSidebarCollapsed,
}: UseAppShortcutsOptions) {
  useEffect(() => {
    const svc = ShortcutService.getInstance();
    svc.init(document);

    const openTab = (tab: SettingsTabType) => {
      openSettings(tab);
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showCheatsheet) {
        e.preventDefault();
        e.stopPropagation();
        setShowCheatsheet(false);
        return;
      }
      if (showSettingsOverlay) {
        e.preventDefault();
        e.stopPropagation();
        setShowSettingsOverlay(false);
        return;
      }
      if (showFirstRun) {
        e.stopPropagation();
        return;
      }
    };
    document.addEventListener('keydown', handleEscape, true);

    const unsub = svc.onMatch(({ actionId, originalEvent: e }) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      if (
        inEditable &&
        ![
          'toggle_settings',
          'toggle_sidebar',
          'toggle_runtime',
          'cheatsheet',
        ].includes(actionId)
      ) {
        return;
      }

      switch (actionId) {
        case 'toggle_settings':
          e.preventDefault();
          toggleSettingsOverlay();
          return;
        case 'new_session':
          e.preventDefault();
          enterDraftMode();
          return;
        case 'focus_composer':
          e.preventDefault();
          emitUiEvent('focus-composer');
          return;
        case 'stop_generation':
          e.preventDefault();
          emitUiEvent('stop-generation');
          return;
        case 'open_models':
          e.preventDefault();
          openTab('models');
          return;
        case 'open_usage':
          e.preventDefault();
          openTab('usage');
          return;
        case 'open_security':
          e.preventDefault();
          openTab('security');
          return;
        case 'open_shortcuts':
          e.preventDefault();
          openTab('shortcuts');
          return;
        case 'open_extensions':
          e.preventDefault();
          openTab('plugins');
          return;
        case 'open_schedule':
          e.preventDefault();
          openTab('schedule');
          return;
        case 'toggle_sidebar':
          e.preventDefault();
          setSidebarCollapsed(!useLayoutStore.getState().sidebarCollapsed);
          return;

        case 'toggle_plan_mode': {
          e.preventDefault();
          const st = useLayoutStore.getState();
          st.setPlanModeEnabled(!st.planModeEnabled);
          return;
        }
        case 'branch_session': {
          e.preventDefault();
          const oldSessionId = getSessionStoreState().activeSessionId;
          const activeSess = getSessionById(oldSessionId);
          if (activeSess) {
            const forkTitle = `${activeSess.title} - 双击ESC分叉`;
            branchSession(activeSess.id, forkTitle);
            const newBranchId = getSessionStoreState().activeSessionId;
            handleShowToast(formatBranchUndoToast(activeSess.title), () => {
              if (newBranchId && newBranchId !== oldSessionId) {
                archiveSession(newBranchId);
              }
              if (oldSessionId) {
                setActiveSessionId(oldSessionId);
              }
            });
          }
          return;
        }
        case 'cheatsheet':
          e.preventDefault();
          setShowCheatsheet((v) => !v);
          return;
        case 'export_logs':
          e.preventDefault();
          setShowTelemetry(true);
          return;
        default:
          break;
      }
    });

    return () => {
      unsub();
      document.removeEventListener('keydown', handleEscape, true);
      svc.destroy();
    };
  }, [
    handleShowToast,
    showCheatsheet,
    showSettingsOverlay,
    showFirstRun,
    setShowCheatsheet,
    setShowSettingsOverlay,
    setShowTelemetry,
    setSidebarCollapsed,
  ]);

  useEffect(() => {
    if (import.meta.env.DEV) {
      const conflicts = ShortcutService.getInstance().detectConflicts();
      if (conflicts.length > 0) {
        console.warn('[crish] 快捷键绑定冲突:', conflicts);
      }
    }
  }, []);
}
