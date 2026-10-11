import { useEffect } from 'react';
import { getSessionById } from '../store/sessionStore';
import {
  archiveSession,
  branchSession,
  openSettings,
  setActiveSessionId,
  toggleSettingsOverlay,
} from '../api/storeAccess';
import { getActiveProjectId } from '../api/projectStore';
import { ShortcutService } from '../services/ShortcutService';
import { emitUiEvent } from '../api/uiEvents';
import { formatBranchUndoToast } from '../hooks/useToastQueue';
import { toast } from '../services/toast/ToastContext';
import type { SettingsTabType } from '../store/types';
import { getCompositionRoot } from './compositionRoot';
import { navigateToNewDraft } from '../store/surfaceRouter';

export interface UseAppShortcutsOptions {
  showSettingsOverlay: boolean;
  setShowSettingsOverlay: (show: boolean) => void;
  showFirstRun: boolean;
  setShowTelemetry: (show: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export function useAppShortcuts({
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
        !['toggle_settings', 'toggle_sidebar'].includes(actionId)
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
          navigateToNewDraft();
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
        case 'toggle_sidebar': {
          e.preventDefault();
          // 写经 compositionRoot；同步 prop setter（与 useLayoutStore selector 同源）
          const layout = getCompositionRoot().layout;
          layout.toggleSidebarCollapsed();
          setSidebarCollapsed(layout.getSidebarCollapsed());
          return;
        }
        case 'toggle_plan_mode': {
          e.preventDefault();
          getCompositionRoot().layout.togglePlanMode();
          return;
        }
        case 'branch_session': {
          e.preventDefault();
          const session = getCompositionRoot().session;
          const oldSessionId = session.getActiveSessionId();
          const activeSess = getSessionById(oldSessionId);
          if (activeSess) {
            const forkTitle = `${activeSess.title} - Ctrl+Shift+F 分叉`;
            branchSession(activeSess.id, forkTitle);
            const newBranchId = session.getActiveSessionId();
            toast.show(formatBranchUndoToast(activeSess.title), () => {
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
    showSettingsOverlay,
    showFirstRun,
    setShowSettingsOverlay,
    setShowTelemetry,
    setSidebarCollapsed,
  ]);

  useEffect(() => {
    // 冲突检测生产接线（T2-2）：改键/注册表变更后任何环境都兜底告警，防绑定漂移静默生效
    const conflicts = ShortcutService.getInstance().detectConflicts();
    if (conflicts.length > 0) {
      console.warn('[crish] 快捷键绑定冲突:', conflicts);
      if (import.meta.env.DEV) {
        console.warn(
          '[crish] 冲突明细：',
          conflicts
            .map(
              (c) =>
                `${c.actionId}（${c.binding}）与 ${c.conflictsWith} 同绑定`
            )
            .join('；')
        );
      }
    }
  }, []);
}
