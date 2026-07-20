import { useState, useEffect, useRef, lazy, Suspense, useMemo, useCallback } from 'react';
import { useLayoutStore } from './store/layoutStore';
import { getSessionById } from './store/sessionStore';
import {
  archiveSession,
  branchSession,
  createSession,
  focusOrOpenPanel,
  getSessionStoreState,
  openSettings,
  setActiveSessionId,
  syncTelemetryData,
  toggleSettingsOverlay,
} from './api/storeAccess';
import { ShortcutService } from './services/ShortcutService';
import { bootstrapServices } from './bootstrap-services';
import type { SettingsTabType } from './store/types';

import { isDemoModeFast, isProductShellFast } from './createSsrGlobals';
import { PlatformAdaptationCtx, usePlatformAdaptation } from '@crish/shared-utils/browser';
import { emitUiEvent, onUiEvent } from './api/uiEvents';
import { createDebounced } from './api/debouncedValue';
import { getActiveModelId, getActiveProfileId } from './api/providerProfiles';
import { collapseToolColumnPreserve } from './store/layoutHelpers';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { formatBranchUndoToast, useToastQueue } from './hooks/useToastQueue';
import { shouldShowFirstRunWizard } from './components/FirstRunWizard';

// ── 关键路径组件：同步导入，与 App 同 chunk ──
import { Sidebar } from './components/Sidebar';
import { Workspace } from './components/Workspace';

// ── 非关键路径组件：代码分割，按需加载 ──
const WorkspaceChromeBars = lazy(() => import('./components/WorkspaceChromeBars').then((m) => ({ default: m.WorkspaceChromeBars })));
const ToastStack = lazy(() => import('./components/ToastStack').then((m) => ({ default: m.ToastStack })));
const CheatsheetModal = lazy(() => import('./components/CheatsheetModal').then((m) => ({ default: m.CheatsheetModal })));
const FirstRunWizard = lazy(() => import('./components/FirstRunWizard').then((m) => ({ default: m.FirstRunWizard })));
const SettingsPanel = lazy(() => import('./components/SettingsPanel').then((m) => ({ default: m.SettingsPanel })).catch((err) => { console.error('[crish] SettingsPanel lazy load failed', err); throw err; }));
const IconSidebarLeft = lazy(() => import('./components/SidebarToggleIcons').then((m) => ({ default: m.IconSidebarLeft })));
const IconSidebarRight = lazy(() => import('./components/SidebarToggleIcons').then((m) => ({ default: m.IconSidebarRight })));
const LucideHelpCircle = lazy(() => import('lucide-react').then((m) => ({ default: m.HelpCircle })));
const LucideMinus = lazy(() => import('lucide-react').then((m) => ({ default: m.Minus })));
const LucideSquare = lazy(() => import('lucide-react').then((m) => ({ default: m.Square })));
const LucideX = lazy(() => import('lucide-react').then((m) => ({ default: m.X })));

/** 浏览器标签 / 任务栏标题 */
const APP_DOCUMENT_TITLE = 'Crish · AI 工作台';

/** Devtools / internal globals attached to window */
type CrishWindow = Window & {
  useLayoutStore?: typeof useLayoutStore;
  AUTO_FOLD_DELAY?: number;
};

if (typeof window !== 'undefined') {
  (window as CrishWindow).useLayoutStore = useLayoutStore;
}

/** 最小骨架 fallback：内联尺寸防布局抖动 */
function SkeletonFallback({ height, width }: { height?: number | string; width?: number | string }) {
  return (
    <div
      className="skel-shimmer"
      style={{ height: height || '100%', width: width || '100%', borderRadius: 6 }}
      aria-hidden="true"
    />
  );
}

function App() {
  const platformAdaptation = usePlatformAdaptation({
    autoApplyRender: true,
    autoStartEngine: true,
  });
  const workspaceIdsStr = useLayoutStore((s) => s.workspaces.map((w) => w.id).join(','));
  const workspaceIds = useMemo(() => workspaceIdsStr ? workspaceIdsStr.split(',') : [], [workspaceIdsStr]);
  const activeWorkspaceId = useLayoutStore(
    (s) => s.workspaces[s.activeWorkspaceIndex]?.id || 'ws-0'
  );
  const uiSize = useLayoutStore((s) => s.uiSize);
  const shellChromeMode = useLayoutStore((s) => s.shellChromeMode);
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useLayoutStore((s) => s.setSidebarCollapsed);
  const showSettingsOverlay = useLayoutStore((s) => s.showSettingsOverlay);
  const setShowSettingsOverlay = useLayoutStore((s) => s.setShowSettingsOverlay);
  const settingsActiveTab = useLayoutStore((s) => s.settingsActiveTab);
  const setAppSettings = useLayoutStore((s) => s.setAppSettings);

  const workspaces = useLayoutStore((s) => s.workspaces);
  const activeWorkspaceIndex = useLayoutStore((s) => s.activeWorkspaceIndex);
  const activeWorkspace = workspaces[activeWorkspaceIndex];

  const isRightSidebarCollapsed = useMemo(() => {
    if (!activeWorkspace) return true;
    const toolCol = activeWorkspace.columns.find((c) => c.id !== 'col-chat' && !c.id.startsWith('col-chat-'));
    if (!toolCol) return true;
    return toolCol.widthRatio < 0.08;
  }, [activeWorkspace]);

  const toggleRightSidebar = useCallback(() => {
    if (!activeWorkspace) return;
    const wsId = activeWorkspace.id;
    const toolCol = activeWorkspace.columns.find((c) => c.id !== 'col-chat' && !c.id.startsWith('col-chat-'));
    const isCollapsed = !toolCol || toolCol.widthRatio < 0.08;

    if (isCollapsed) {
      const activeCardId = toolCol?.groups[0]?.activeCardId || 'overview';
      focusOrOpenPanel(wsId, activeCardId);
    } else {
      useLayoutStore.setState((state) => {
        const w = state.workspaces.find((x) => x.id === wsId);
        if (!w) return;
        collapseToolColumnPreserve(w);
      });
    }
  }, [activeWorkspace]);

  const { toasts, showToast: handleShowToast, dismissToast } = useToastQueue();
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  const [skipLinkFocused, setSkipLinkFocused] = useState(false);
  const [sessionSearchInput, setSessionSearchInput] = useState('');
  const [sessionSearch, setSessionSearch] = useState('');
  const searchDebounceRef = useRef(
    createDebounced<string>((q) => setSessionSearch(q), 220),
  );
  useEffect(() => {
    searchDebounceRef.current.schedule(sessionSearchInput);
    return () => searchDebounceRef.current.cancel();
  }, [sessionSearchInput]);
  const productShell = isProductShellFast();
  const [showFirstRun, setShowFirstRun] = useState(
    () => !isDemoModeFast() && shouldShowFirstRunWizard(),
  );

  const [engineReady, setEngineReady] = useState(false);

  // 延迟初始化 engineReady：避免 import daemonClient 阻塞首帧
  useEffect(() => {
    import('./api/daemonClient').then(({ getDesktopDaemonClient }) => {
      const client = getDesktopDaemonClient();
      if (client.hasEverConnected() || client.isConnected()) {
        setEngineReady(true);
      }
    });
  }, []);

  const pickWorkspaceFolder = async () => {
    try {
      const dialogSpec = '@tauri-apps/plugin-dialog';
      const mod = (await import(/* @vite-ignore */ dialogSpec).catch(() => null)) as {
        open?: (opts: { directory: boolean; multiple: boolean }) => Promise<string | string[] | null>;
      } | null;
      if (mod?.open) {
        const selected = await mod.open({ directory: true, multiple: false });
        if (typeof selected === 'string' && selected) {
          const { addProjectFromPath } = await import('./api/projectStore');
          addProjectFromPath(selected);
          return;
        }
      }
    } catch {}
    emitUiEvent('open-project-picker');
  };

  const [isHoveredExpanded, setIsHoveredExpanded] = useState(false);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as CrishWindow;
    if (w.AUTO_FOLD_DELAY === undefined) {
      w.AUTO_FOLD_DELAY = 5000;
    }
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = 'zh-CN';
    if (document.title !== APP_DOCUMENT_TITLE) {
      document.title = APP_DOCUMENT_TITLE;
    }
  }, []);

  useEffect(() => {
    import('./store/layoutStore').then(({ initLayoutStorePersistence }) => initLayoutStorePersistence());
  }, []);

  useEffect(() => {
    const cleanup = bootstrapServices();
    return () => {
      cleanup();
    };
  }, []);

  useEffect(() => {
    const rebind = () => {
      try {
        import('./api/projectStore').then(({ listProjects, rebindSessionFoldersToProjects, rememberProjectFolderAlias }) => {
          const projects = listProjects();
          for (const p of projects) rememberProjectFolderAlias(p.id, p.path);
          useLayoutStore.setState((state) => {
            const n = rebindSessionFoldersToProjects(state.sessions, projects);
            if (n > 0) {
              for (const s of state.sessions) {
                if (s.folder && !state.folderOrder.includes(s.folder)) {
                  state.folderOrder.push(s.folder);
                }
              }
              console.info('[crish] rebound session folders', n);
            }
          });
        });
      } catch (e) {
        console.warn('[crish] session folder rebind failed', e);
      }
    };
    const t = window.setTimeout(rebind, 400);
    window.addEventListener('crish-project-changed', rebind);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('crish-project-changed', rebind);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void import('./api/workspaceLayoutStore').then(({ initWorkspaceLayoutSync }) => {
      if (cancelled) return;
      cleanup = initWorkspaceLayoutSync({
        onRestored: () => {},
      });
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    void import('./api/themeStore').then(({ bootstrapTheme }) => bootstrapTheme());
    void import('./api/fontStore').then(({ bootstrapFonts }) => bootstrapFonts());
    const initApp = async () => {
      try {
        const { clientApi } = await import('./api/clientApi');
        const settings = await clientApi.getSettings();
        if (settings) {
          setAppSettings(settings);
          if (settings.theme) {
            const { applyTheme, persistTheme, normalizeTheme } = await import('./api/themeStore');
            const t = normalizeTheme(settings.theme);
            applyTheme(t);
            persistTheme(t);
          }
          if (settings.fonts) {
            const { setFontPreferences, normalizeFontPrefs } = await import('./api/fontStore');
            await setFontPreferences(normalizeFontPrefs(settings.fonts));
          }
          if (typeof settings.tabModeEnabled === 'boolean') {
            useLayoutStore.getState().setTabModeEnabled(settings.tabModeEnabled);
          } else {
            useLayoutStore.getState().setTabModeEnabled(true);
          }
        }
      } catch (err) {
        console.error("Failed to load settings or providers on startup", err);
      }
    };
    initApp();
  }, []);

  useEffect(() => {
    const initEngine = async () => {
      const { bootstrapDesktopBackend, getDesktopDaemonClient } = await import('./api/daemonClient');
      const client = bootstrapDesktopBackend();
      if (client.isConnected() || client.hasEverConnected()) {
        setEngineReady(true);
      }
      const unsub = client.onState((s) => {
        if (s === 'connected' || client.hasEverConnected()) {
          setEngineReady(true);
        }
      });
      const { ensureDaemonConnected } = await import('./api/daemonChatBridge');
      void ensureDaemonConnected().then((res) => {
        if (res.ok || client.hasEverConnected()) setEngineReady(true);
        else if (!productShell) {
          console.warn('[crish-desktop] engine offline after boot wait (keep-alive continues)');
        }
        if (res.ok) {
          void import('./api/providerProfiles').then(({ syncActiveProfileToEngine }) => {
            void syncActiveProfileToEngine();
          });
          void import('./api/sessionDaemonSync').then(({ syncSessionsFromDaemon }) => {
            void syncSessionsFromDaemon(
              () => useLayoutStore.getState().sessions,
              (sessions) => useLayoutStore.getState().setSessions(sessions),
            );
          });
        }
      });
      const gateTimer = window.setTimeout(() => {
        setEngineReady(true);
      }, productShell ? 12_000 : 0);
      return () => {
        unsub();
        window.clearTimeout(gateTimer);
      };
    };
    const cleanupPromise = initEngine();
    return () => {
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [productShell]);

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const handleResize = () => {
      document.body.classList.add('window-resizing');

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        document.body.classList.remove('window-resizing');
      }, 100);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, []);

  const handleHoverTriggerEnter = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setIsHoveredExpanded(true);
  };

  const handleSidebarHoverEnter = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
  };

  const handleSidebarHoverLeave = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHoveredExpanded(false);
    }, 300);
  };

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-ui-size', uiSize);
    const density =
      uiSize === 'small' ? 'compact' : uiSize === 'large' ? 'comfortable' : 'default';
    root.setAttribute('data-density', density);
    const chrome = shellChromeMode || 'classic';
    root.setAttribute('data-shell-chrome', chrome);
    document.body.setAttribute('data-ui-size', uiSize);
    document.body.setAttribute('data-density', density);
    document.body.setAttribute('data-shell-chrome', chrome);
  }, [uiSize, shellChromeMode]);

  useEffect(() => {
    const mode = isDemoModeFast() ? 'demo' : 'normal';
    document.body.setAttribute('data-app-mode', mode);
    document.documentElement.setAttribute('data-app-mode', mode);
  }, []);

  useEffect(() => {
    const openTab = (tab: SettingsTabType) => {
      openSettings(tab);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      if (e.key === 'Escape') {
        if (showCheatsheet) {
          e.preventDefault();
          setShowCheatsheet(false);
          return;
        }
        if (showSettingsOverlay) {
          e.preventDefault();
          setShowSettingsOverlay(false);
          return;
        }
        if (showFirstRun) {
          return;
        }
      }

      const result = ShortcutService.getInstance().handleKeyDown(e);
      if (!result) return;

      const { actionId } = result;

      if (inEditable && !['toggle_settings', 'toggle_sidebar', 'toggle_runtime', 'cheatsheet'].includes(actionId)) {
        return;
      }

      switch (actionId) {
        case 'toggle_settings':
          e.preventDefault();
          toggleSettingsOverlay();
          return;
        case 'new_session':
          e.preventDefault();
          createSession({ activate: true });
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
        default:
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    handleShowToast,
    showCheatsheet,
    showSettingsOverlay,
    showFirstRun,
    setShowSettingsOverlay,
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

  useEffect(() => {
    const unsubPromise = import('./api/clientApi').then(({ clientApi }) =>
      clientApi.subscribeTelemetry((data) => {
        syncTelemetryData(data);
      })
    );
    return () => {
      unsubPromise.then(unsub => unsub());
    };
  }, []);

  useEffect(() => {
    return onUiEvent('pick-workspace', () => {
      void pickWorkspaceFolder();
    });
  }, []);

  const winCtl = async (action: 'minimize' | 'toggleMaximize' | 'close') => {
    try {
      const mod = await import('@tauri-apps/api/window');
      const win = mod.getCurrentWindow();
      if (action === 'minimize') await win.minimize();
      else if (action === 'toggleMaximize') {
        if (await win.isMaximized()) await win.unmaximize();
        else await win.maximize();
      } else await win.close();
    } catch {}
  };

  const appModeClass = isDemoModeFast() ? 'app-mode-demo' : 'app-mode-normal';
  const shellDensity =
    uiSize === 'small' ? 'compact' : uiSize === 'large' ? 'comfortable' : 'default';

  return (
    <PlatformAdaptationCtx.Provider value={platformAdaptation}>
    <div
      className={`app-container ${appModeClass}`}
      data-ui-size={uiSize}
      data-density={shellDensity}
      data-shell-chrome={shellChromeMode || 'classic'}
      data-engine-ready={engineReady ? 'true' : 'false'}
      data-first-run={showFirstRun ? 'true' : 'false'}
      data-perf-level={platformAdaptation.hardwareReady ? String(platformAdaptation.level) : undefined}
    >
      <a
        href="#crish-main"
        onFocus={() => setSkipLinkFocused(true)}
        onBlur={() => setSkipLinkFocused(false)}
        style={
          skipLinkFocused
            ? {
                position: 'absolute',
                zIndex: 100000,
                top: 8,
                left: 8,
                padding: '6px 12px',
                background: 'var(--bg-elevated, #fff)',
                color: 'var(--text-primary, #111)',
                borderRadius: 6,
                boxShadow: '0 2px 8px rgba(0,0,0,.12)',
                textDecoration: 'none',
                fontSize: 13,
              }
            : {
                position: 'absolute',
                width: 1,
                height: 1,
                padding: 0,
                margin: -1,
                overflow: 'hidden',
                clip: 'rect(0, 0, 0, 0)',
                whiteSpace: 'nowrap',
                border: 0,
              }
        }
      >
        跳到主内容
      </a>

      {showFirstRun && (
        <Suspense fallback={<SkeletonFallback height={400} />}>
          <FirstRunWizard
            onDone={() => {
              setShowFirstRun(false);
              const model = getActiveModelId();
              const profileId = getActiveProfileId();
              if (model && profileId) {
                emitUiEvent('model-changed', { profileId, model });
              }
            }}
            onOpenSettings={() => {
              setShowFirstRun(false);
              openSettings('models');
            }}
          />
        </Suspense>
      )}

      {shellChromeMode !== 'inset' ? (
        <header
          className="app-header"
          role="banner"
          aria-label="应用顶栏"
          data-tauri-drag-region
        >
          <div className="app-header-left" data-tauri-drag-region>
            <button
              type="button"
              className="header-btn no-drag"
              title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!sidebarCollapsed}
              aria-controls="crish-sidebar"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              <Suspense fallback={<SkeletonFallback width={15} height={15} />}>
                <IconSidebarLeft size={15} aria-hidden="true" />
              </Suspense>
            </button>
          </div>
          <div className="app-header-right no-drag" role="toolbar" aria-label="顶栏操作">
            <button
              type="button"
              className={`header-btn no-drag ${!isRightSidebarCollapsed ? 'active' : ''}`}
              title={isRightSidebarCollapsed ? '展开右面板' : '收起右面板'}
              aria-label={isRightSidebarCollapsed ? '展开右面板' : '收起右面板'}
              aria-pressed={!isRightSidebarCollapsed}
              onClick={toggleRightSidebar}
            >
              <Suspense fallback={<SkeletonFallback width={15} height={15} />}>
                <IconSidebarRight size={15} aria-hidden="true" />
              </Suspense>
            </button>
            <button
              type="button"
              className="header-btn"
              onClick={() => setShowCheatsheet(true)}
              title="快捷键与帮助"
              aria-label="快捷键与帮助"
              aria-haspopup="dialog"
            >
              <Suspense fallback={<SkeletonFallback width={16} height={16} />}>
                <LucideHelpCircle size={16} aria-hidden="true" />
              </Suspense>
            </button>

            <div
              className="window-controls no-drag"
              role="group"
              aria-label="窗口控制"
              data-tauri-drag-region="false"
            >
              <button
                type="button"
                className="win-btn no-drag"
                title="最小化"
                aria-label="最小化窗口"
                data-tauri-drag-region="false"
                onClick={() => void winCtl('minimize')}
              >
                <Suspense fallback={<SkeletonFallback width={16} height={16} />}>
                  <LucideMinus size={16} aria-hidden="true" />
                </Suspense>
              </button>
              <button
                type="button"
                className="win-btn no-drag"
                title="最大化"
                aria-label="最大化或还原窗口"
                data-tauri-drag-region="false"
                onClick={() => void winCtl('toggleMaximize')}
              >
                <Suspense fallback={<SkeletonFallback width={14} height={14} />}>
                  <LucideSquare size={14} aria-hidden="true" />
                </Suspense>
              </button>
              <button
                type="button"
                className="win-btn close no-drag"
                title="关闭"
                aria-label="关闭窗口"
                data-tauri-drag-region="false"
                onClick={() => void winCtl('close')}
              >
                <Suspense fallback={<SkeletonFallback width={16} height={16} />}>
                  <LucideX size={16} aria-hidden="true" />
                </Suspense>
              </button>
            </div>
          </div>
        </header>
      ) : (
        <div
          className={`ws-titlebar-host${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}
          role="banner"
          aria-label="项目顶栏"
          data-tauri-drag-region
        >
          <div className="ws-titlebar-rail" data-tauri-drag-region>
            <button
              type="button"
              className="header-btn no-drag ws-titlebar-sidebar-btn"
              title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!sidebarCollapsed}
              aria-controls="crish-sidebar"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              <Suspense fallback={<SkeletonFallback width={15} height={15} />}>
                <IconSidebarLeft size={15} aria-hidden="true" />
              </Suspense>
            </button>
          </div>
          <div className="ws-titlebar-main" data-tauri-drag-region>
            <AppErrorBoundary compact title="工作区标签出错">
              <Suspense fallback={<SkeletonFallback height={32} />}>
                <WorkspaceChromeBars
                  variant="workspace"
                  className="ws-chrome-row--titlebar"
                  onAddProject={() => emitUiEvent('pick-workspace')}
                  onOpenHelp={() => setShowCheatsheet(true)}
                  onWinMinimize={() => void winCtl('minimize')}
                  onWinMaximize={() => void winCtl('toggleMaximize')}
                  onWinClose={() => void winCtl('close')}
                />
              </Suspense>
            </AppErrorBoundary>
          </div>
        </div>
      )}

      <main
        id="crish-main"
        className="main-layout"
        aria-label="主工作区"
        style={{
          position: 'relative',
          width: '100%',
        }}
      >
        {sidebarCollapsed && (
          <div
            className="sidebar-hover-trigger"
            onMouseEnter={handleHoverTriggerEnter}
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: '8px',
              zIndex: 9999,
              cursor: 'w-resize',
            }}
          />
        )}

        <div
          id="crish-sidebar"
          className={`sidebar-wrapper ${sidebarCollapsed ? 'collapsed' : ''}`}
          role="navigation"
          aria-label="会话侧栏"
          aria-hidden={sidebarCollapsed && !isHoveredExpanded ? true : undefined}
          style={{
            width: sidebarCollapsed ? 0 : 'var(--sidebar-width)',
            height: '100%',
            flexShrink: 0,
            transition: 'width 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)',
            overflow: 'visible',
            position: 'relative',
          }}
        >
          <AppErrorBoundary compact title="侧栏出错">
            <Suspense fallback={<SkeletonFallback height="100%" />}>
              <Sidebar
                onShowToast={handleShowToast}
                hoverExpanded={sidebarCollapsed && isHoveredExpanded}
                onHoverLeave={handleSidebarHoverLeave}
                onHoverEnter={handleSidebarHoverEnter}
                searchQuery={sessionSearch}
                searchInput={sessionSearchInput}
                onSearchChange={setSessionSearchInput}
              />
            </Suspense>
          </AppErrorBoundary>
        </div>

        <div
          className={`workspaces-column${shellChromeMode === 'inset' ? ' workspaces-column--inset' : ''}`}
          role="region"
          aria-label="工作台内容"
        >
          <div className="workspaces-stack" role="region" aria-label="会话与面板">
            <div className="workspaces-container" role="region" aria-label="工作区面板">
              <AppErrorBoundary compact title="工作区出错">
                <Suspense fallback={<SkeletonFallback height={400} />}>
                  {workspaceIds.map((id) => (
                    <Workspace key={id} wsId={id} onShowToast={handleShowToast} />
                  ))}
                </Suspense>
              </AppErrorBoundary>
            </div>
          </div>
        </div>
      </main>



      <div role="region" aria-label="通知" aria-live="polite">
        <Suspense fallback={null}>
          <ToastStack toasts={toasts} onDismiss={dismissToast} />
        </Suspense>
      </div>

      {showCheatsheet && (
        <Suspense fallback={<SkeletonFallback height={300} />}>
          <CheatsheetModal onClose={() => setShowCheatsheet(false)} />
        </Suspense>
      )}

      {showSettingsOverlay && (
        <div
          className="settings-cover"
          role="dialog"
          aria-modal="true"
          aria-label="设置"
          style={{ zIndex: 13000 }}
        >
          <AppErrorBoundary
            title="设置加载失败"
            onReset={() => {
              setShowSettingsOverlay(false);
              window.setTimeout(() => setShowSettingsOverlay(true), 50);
            }}
          >
            <Suspense
              fallback={
                <div
                  className="settings-suspense-fallback"
                  aria-busy="true"
                  aria-label="正在加载设置"
                  role="status"
                >
                  <div className="settings-suspense-skel settings-suspense-skel--nav" aria-hidden="true" />
                  <div className="settings-suspense-skel settings-suspense-skel--main" aria-hidden="true" />
                </div>
              }
            >
              <SettingsPanel
                wsId={activeWorkspaceId}
                onShowToast={handleShowToast}
                onClose={() => setShowSettingsOverlay(false)}
                initialTab={settingsActiveTab || 'profile'}
              />
            </Suspense>
          </AppErrorBoundary>
        </div>
      )}
    </div>
    </PlatformAdaptationCtx.Provider>
  );
}

export default App;
