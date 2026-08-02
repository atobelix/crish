import {
  useState,
  useEffect,
  useRef,
  lazy,
  Suspense,
  useMemo,
} from 'react';
import { useLayoutStore } from './store/layoutStore';
import { useSettingsStore } from './store/settingsStore';
import { isDemoModeFast, isProductShellFast, isTreeWorkspaceFast } from './createSsrGlobals';
import {
  PlatformAdaptationCtx,
  usePlatformAdaptation,
} from '@crish/shared-utils/browser';
import { createDebounced } from './api/debouncedValue';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { useToastQueue } from './hooks/useToastQueue';
import { shouldShowFirstRunWizard } from './components/firstRunWizardLib';
import styles from './App.module.css';

import { useAppBootstrap } from './app/AppBootstrap';
import { useEngineBootstrap } from './app/useEngineBootstrap';
import { useAppShortcuts } from './app/AppShortcuts';
import { AppGlobalDialogs, SkeletonFallback } from './app/AppGlobalDialogs';
import { useWorkspaceShellStore } from './store/workspace-shell';

// ── 关键路径组件：同步导入，与 App 同 chunk ──
import { Sidebar } from './components/sidebar/Sidebar';
import { Workspace } from './components/workspace/Workspace';
import { AppTopBar } from './components/AppTopBar';
import { SessionTabDragProvider } from './components/shell/SessionTabDragContext';

// D2-3：仅 DEV 懒加载；旗标关闭时不 import chunk、无 interval / store
const DevHealthOverlayLazy = import.meta.env.DEV
  ? lazy(() =>
      import('./dev/DevHealthOverlay').then((m) => ({
        default: m.DevHealthOverlay,
      }))
    )
  : null;

/** 同步门控：避免 DEV 下未开旗标仍拉 DevHealthOverlay chunk */
function DevHealthOverlayMount() {
  if (!DevHealthOverlayLazy) return null;
  let on = false;
  try {
    on =
      localStorage.getItem('crish_dev_health') === '1' ||
      localStorage.getItem('crish_show_engine_settings') === '1';
  } catch {
    /* ignore */
  }
  if (!on) return null;
  const Overlay = DevHealthOverlayLazy;
  return (
    <Suspense fallback={null}>
      <Overlay />
    </Suspense>
  );
}

// 二叉树工作区（重构后默认入口；代码分割避免影响旧路径首屏）
const BinaryTreeWorkspace = lazy(() =>
  import('./components/binary-tree/BinaryTreeWorkspace').then((m) => ({
    default: m.BinaryTreeWorkspace,
  }))
);

// ── 非关键路径组件：代码分割，按需加载 ──

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
  const setAppSettings = useSettingsStore((s) => s.setAppSettings);



  const { toasts, showToast: handleShowToast, dismissToast } = useToastQueue();
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [sessionSearchInput, setSessionSearchInput] = useState('');
  const [sessionSearch, setSessionSearch] = useState('');
  const searchDebounceRef = useRef(
    createDebounced<string>((q) => setSessionSearch(q), 220)
  );
  useEffect(() => {
    const debounced = searchDebounceRef.current;
    debounced.schedule(sessionSearchInput);
    return () => debounced.cancel();
  }, [sessionSearchInput]);

  const productShell = isProductShellFast();
  const useTreeWorkspace = isTreeWorkspaceFast();
  const shellReady = useWorkspaceShellStore((s) => s.shellReady);
  const [showFirstRun, setShowFirstRun] = useState(
    () => !isDemoModeFast() && shouldShowFirstRunWizard()
  );
  // 引擎就绪门闩（T06.8 归一：useEngineBootstrap 取代 useAppBootstrap setEngineReady）
  const engineReady = useEngineBootstrap();

  const [isHoveredExpanded, setIsHoveredExpanded] = useState(false);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // App startup & service hydration
  useAppBootstrap({
    setAppSettings,
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
      <SessionTabDragProvider>
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

        <AppTopBar
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
          onShowCheatsheet={() => setShowCheatsheet(true)}
        />

        <main
          id="crish-main"
          className="main-layout"
          aria-label="主工作区"
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
            className={`sidebar-wrapper ${sidebarCollapsed ? 'collapsed' : ''} ${sidebarCollapsed && isHoveredExpanded ? 'hoverExpanded' : ''}`}
            role="navigation"
            aria-label="会话侧栏"
            aria-hidden={
              sidebarCollapsed && !isHoveredExpanded ? true : undefined
            }
            style={{
              width:
                sidebarCollapsed && !isHoveredExpanded
                  ? 0
                  : 'var(--sidebar-width)',
              height: '100%',
              flexShrink: 0,
              transition: 'width 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)',
              overflow: 'visible',
              position: 'relative',
              zIndex: sidebarCollapsed && isHoveredExpanded ? 'var(--z-sidebar)' : undefined,
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
                  {!shellReady ? (
                    <SkeletonFallback height={400} />
                  ) : (
                    <Suspense fallback={<SkeletonFallback height={400} />}>
                      {useTreeWorkspace ? (
                        <BinaryTreeWorkspace onShowToast={handleShowToast} />
                      ) : (
                        workspaceIds.map((id) => (
                          <Workspace
                            key={id}
                            wsId={id}
                            onShowToast={handleShowToast}
                          />
                        ))
                      )}
                    </Suspense>
                  )}
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

        <DevHealthOverlayMount />
      </div>
      </SessionTabDragProvider>
    </PlatformAdaptationCtx.Provider>
  );
}

export default App;
