import {
  useState,
  useEffect,
  useRef,
  lazy,
  Suspense,
  useMemo,
  useCallback,
} from 'react';
import { useLayoutStore } from './store/layoutStore';
import { focusOrOpenPanel } from './api/storeAccess';
import { isDemoModeFast, isProductShellFast } from './createSsrGlobals';
import {
  PlatformAdaptationCtx,
  usePlatformAdaptation,
} from '@crish/shared-utils/browser';
import { emitUiEvent } from './api/uiEvents';
import { createDebounced } from './api/debouncedValue';
import { collapseToolColumnPreserve } from './store/layoutHelpers';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { Tooltip } from './components/Tooltip';
import { useToastQueue } from './hooks/useToastQueue';
import { shouldShowFirstRunWizard } from './components/FirstRunWizard';
import styles from './App.module.css';

import { useAppBootstrap, winCtl } from './app/AppBootstrap';
import { useAppShortcuts } from './app/AppShortcuts';
import { AppGlobalDialogs, SkeletonFallback } from './app/AppGlobalDialogs';

// ── 关键路径组件：同步导入，与 App 同 chunk ──
import { Sidebar } from './components/Sidebar';
import { Workspace } from './components/Workspace';

// ── 非关键路径组件：代码分割，按需加载 ──
const WorkspaceChromeBars = lazy(() =>
  import('./components/WorkspaceChromeBars').then((m) => ({
    default: m.WorkspaceChromeBars,
  }))
);
const IconSidebarLeft = lazy(() =>
  import('./components/SidebarToggleIcons').then((m) => ({
    default: m.IconSidebarLeft,
  }))
);
const IconSidebarRight = lazy(() =>
  import('./components/SidebarToggleIcons').then((m) => ({
    default: m.IconSidebarRight,
  }))
);
const LucideHelpCircle = lazy(() =>
  import('./components/WindowIcons').then((m) => ({ default: m.HelpCircle }))
);
const LucideMinus = lazy(() =>
  import('./components/WindowIcons').then((m) => ({ default: m.Minus }))
);
const LucideSquare = lazy(() =>
  import('./components/WindowIcons').then((m) => ({ default: m.Square }))
);
const LucideX = lazy(() =>
  import('./components/WindowIcons').then((m) => ({ default: m.X }))
);

function App() {
  const platformAdaptation = usePlatformAdaptation({
    autoApplyRender: true,
    autoStartEngine: true,
  });
  const workspaceIdsStr = useLayoutStore((s) =>
    s.workspaces.map((w) => w.id).join(',')
  );
  const workspaceIds = useMemo(
    () => (workspaceIdsStr ? workspaceIdsStr.split(',') : []),
    [workspaceIdsStr]
  );
  const activeWorkspaceId = useLayoutStore(
    (s) => s.workspaces[s.activeWorkspaceIndex]?.id || 'ws-0'
  );
  const uiSize = useLayoutStore((s) => s.uiSize);
  const shellChromeMode = useLayoutStore((s) => s.shellChromeMode);
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useLayoutStore((s) => s.setSidebarCollapsed);
  const showSettingsOverlay = useLayoutStore((s) => s.showSettingsOverlay);
  const setShowSettingsOverlay = useLayoutStore(
    (s) => s.setShowSettingsOverlay
  );
  const settingsActiveTab = useLayoutStore((s) => s.settingsActiveTab);
  const setAppSettings = useLayoutStore((s) => s.setAppSettings);

  const isRightSidebarCollapsed = useLayoutStore((s) => {
    const w = s.workspaces[s.activeWorkspaceIndex];
    if (!w) return true;
    const toolCol = w.columns.find(
      (c) => c.id !== 'col-chat' && !c.id.startsWith('col-chat-')
    );
    if (!toolCol) return true;
    return toolCol.widthRatio < 0.08;
  });

  const toggleRightSidebar = useCallback(() => {
    const state = useLayoutStore.getState();
    const activeWorkspace = state.workspaces[state.activeWorkspaceIndex];
    if (!activeWorkspace) return;
    const wsId = activeWorkspace.id;
    const toolCol = activeWorkspace.columns.find(
      (c) => c.id !== 'col-chat' && !c.id.startsWith('col-chat-')
    );
    const isCollapsed = !toolCol || toolCol.widthRatio < 0.08;

    if (isCollapsed) {
      const activeCardId = toolCol?.groups[0]?.activeCardId || 'overview';
      focusOrOpenPanel(wsId, activeCardId);
    } else {
      useLayoutStore.setState((st) => {
        const w = st.workspaces.find((x) => x.id === wsId);
        if (!w) return;
        collapseToolColumnPreserve(w);
      });
    }
  }, []);

  const { toasts, showToast: handleShowToast, dismissToast } = useToastQueue();
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [showCrashPrompt, setShowCrashPrompt] = useState(false);
  const [sessionSearchInput, setSessionSearchInput] = useState('');
  const [sessionSearch, setSessionSearch] = useState('');
  const searchDebounceRef = useRef(
    createDebounced<string>((q) => setSessionSearch(q), 220)
  );
  useEffect(() => {
    searchDebounceRef.current.schedule(sessionSearchInput);
    return () => searchDebounceRef.current.cancel();
  }, [sessionSearchInput]);

  const productShell = isProductShellFast();
  const [showFirstRun, setShowFirstRun] = useState(
    () => !isDemoModeFast() && shouldShowFirstRunWizard()
  );
  const [engineReady, setEngineReady] = useState(false);

  const [isHoveredExpanded, setIsHoveredExpanded] = useState(false);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // App startup & service hydration
  useAppBootstrap({
    setAppSettings,
    setEngineReady,
    setShowCrashPrompt,
    productShell,
    uiSize,
    shellChromeMode,
  });

  // Global keybindings
  useAppShortcuts({
    handleShowToast,
    showCheatsheet,
    setShowCheatsheet,
    showSettingsOverlay,
    setShowSettingsOverlay,
    showFirstRun,
    setShowTelemetry,
    setSidebarCollapsed,
  });

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

  const appModeClass = isDemoModeFast() ? 'app-mode-demo' : 'app-mode-normal';
  const shellDensity =
    uiSize === 'small'
      ? 'compact'
      : uiSize === 'large'
        ? 'comfortable'
        : 'default';

  return (
    <PlatformAdaptationCtx.Provider value={platformAdaptation}>
      <div
        className={`app-container ${appModeClass}`}
        data-ui-size={uiSize}
        data-density={shellDensity}
        data-shell-chrome={shellChromeMode || 'classic'}
        data-engine-ready={engineReady ? 'true' : 'false'}
        data-first-run={showFirstRun ? 'true' : 'false'}
        data-perf-level={
          platformAdaptation.hardwareReady
            ? String(platformAdaptation.level)
            : undefined
        }
      >
        <a href="#crish-main" className={styles.skipLink}>
          跳转到主要内容
        </a>

        {shellChromeMode !== 'inset' ? (
          <header
            className="app-header"
            role="banner"
            aria-label="应用顶栏"
            data-tauri-drag-region
          >
            <div className="app-header-left" data-tauri-drag-region>
              <Tooltip content={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}>
                <button
                  type="button"
                  className="header-btn no-drag"
                  aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
                  aria-expanded={!sidebarCollapsed}
                  aria-controls="crish-sidebar"
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                >
                  <Suspense
                    fallback={<SkeletonFallback width={15} height={15} />}
                  >
                    <IconSidebarLeft size={15} aria-hidden="true" />
                  </Suspense>
                </button>
              </Tooltip>
            </div>
            <div
              className="app-header-right no-drag"
              role="toolbar"
              aria-label="顶栏操作"
            >
              <Tooltip
                content={isRightSidebarCollapsed ? '展开右面板' : '收起右面板'}
              >
                <button
                  type="button"
                  className={`header-btn no-drag ${!isRightSidebarCollapsed ? 'active' : ''}`}
                  aria-label={
                    isRightSidebarCollapsed ? '展开右面板' : '收起右面板'
                  }
                  aria-pressed={!isRightSidebarCollapsed}
                  onClick={toggleRightSidebar}
                >
                  <Suspense
                    fallback={<SkeletonFallback width={15} height={15} />}
                  >
                    <IconSidebarRight size={15} aria-hidden="true" />
                  </Suspense>
                </button>
              </Tooltip>
              <Tooltip content="快捷键与帮助">
                <button
                  type="button"
                  className="header-btn"
                  onClick={() => setShowCheatsheet(true)}
                  aria-label="快捷键与帮助"
                  aria-haspopup="dialog"
                >
                  <Suspense
                    fallback={<SkeletonFallback width={16} height={16} />}
                  >
                    <LucideHelpCircle size={16} aria-hidden="true" />
                  </Suspense>
                </button>
              </Tooltip>

              <div
                className="window-controls no-drag"
                role="group"
                aria-label="窗口控制"
                data-tauri-drag-region="false"
              >
                <Tooltip content="最小化">
                  <button
                    type="button"
                    className="win-btn no-drag"
                    aria-label="最小化窗口"
                    data-tauri-drag-region="false"
                    onClick={() => void winCtl('minimize')}
                  >
                    <Suspense
                      fallback={<SkeletonFallback width={16} height={16} />}
                    >
                      <LucideMinus size={16} aria-hidden="true" />
                    </Suspense>
                  </button>
                </Tooltip>
                <Tooltip content="最大化">
                  <button
                    type="button"
                    className="win-btn no-drag"
                    aria-label="最大化或还原窗口"
                    data-tauri-drag-region="false"
                    onClick={() => void winCtl('toggleMaximize')}
                  >
                    <Suspense
                      fallback={<SkeletonFallback width={14} height={14} />}
                    >
                      <LucideSquare size={14} aria-hidden="true" />
                    </Suspense>
                  </button>
                </Tooltip>
                <Tooltip content="关闭">
                  <button
                    type="button"
                    className="win-btn close no-drag"
                    aria-label="关闭窗口"
                    data-tauri-drag-region="false"
                    onClick={() => void winCtl('close')}
                  >
                    <Suspense
                      fallback={<SkeletonFallback width={16} height={16} />}
                    >
                      <LucideX size={16} aria-hidden="true" />
                    </Suspense>
                  </button>
                </Tooltip>
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
              <Tooltip content={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}>
                <button
                  type="button"
                  className="header-btn no-drag ws-titlebar-sidebar-btn"
                  aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
                  aria-expanded={!sidebarCollapsed}
                  aria-controls="crish-sidebar"
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                >
                  <Suspense
                    fallback={<SkeletonFallback width={15} height={15} />}
                  >
                    <IconSidebarLeft size={15} aria-hidden="true" />
                  </Suspense>
                </button>
              </Tooltip>
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
                zIndex: 'var(--z-sidebar)',
                cursor: 'w-resize',
              }}
            />
          )}

          <div
            id="crish-sidebar"
            className={`sidebar-wrapper ${sidebarCollapsed ? 'collapsed' : ''}`}
            role="navigation"
            aria-label="会话侧栏"
            aria-hidden={
              sidebarCollapsed && !isHoveredExpanded ? true : undefined
            }
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
            <div
              className="workspaces-stack"
              role="region"
              aria-label="会话与面板"
            >
              <div
                className="workspaces-container"
                role="region"
                aria-label="工作区面板"
              >
                <AppErrorBoundary compact title="工作区出错">
                  <Suspense fallback={<SkeletonFallback height={400} />}>
                    {workspaceIds.map((id) => (
                      <Workspace
                        key={id}
                        wsId={id}
                        onShowToast={handleShowToast}
                      />
                    ))}
                  </Suspense>
                </AppErrorBoundary>
              </div>
            </div>
          </div>
        </main>

        <AppGlobalDialogs
          showFirstRun={showFirstRun}
          setShowFirstRun={setShowFirstRun}
          toasts={toasts}
          dismissToast={dismissToast}
          showCrashPrompt={showCrashPrompt}
          setShowCrashPrompt={setShowCrashPrompt}
          showTelemetry={showTelemetry}
          setShowTelemetry={setShowTelemetry}
          showCheatsheet={showCheatsheet}
          setShowCheatsheet={setShowCheatsheet}
          showSettingsOverlay={showSettingsOverlay}
          setShowSettingsOverlay={setShowSettingsOverlay}
          activeWorkspaceId={activeWorkspaceId}
          settingsActiveTab={settingsActiveTab}
          handleShowToast={handleShowToast}
        />
      </div>
    </PlatformAdaptationCtx.Provider>
  );
}

export default App;
