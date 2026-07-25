import { useEffect } from 'react';
import { useLayoutStore } from '../../store/layoutStore';
import { ShortcutService } from '../../services/ShortcutService';
import { openSettings, toggleSettingsOverlay } from '../../api/storeAccess';
import type { UseAppKeyboardOpts } from '../useAppKeyboard';
import type { SettingsTabType } from '../../store/types';

export function useKeyboardNavigation(opts: UseAppKeyboardOpts): void {
  const {
    showCheatsheet,
    setShowCheatsheet,
    showSettingsOverlay,
    setShowSettingsOverlay,
    showFirstRun,
    setSidebarCollapsed,
    setShowTelemetry,
  } = opts;

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
    showCheatsheet,
    showSettingsOverlay,
    showFirstRun,
    setShowSettingsOverlay,
    setSidebarCollapsed,
    setShowCheatsheet,
    setShowTelemetry,
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
