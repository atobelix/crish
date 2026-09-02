import {
  useState,
  useEffect,
  useRef,
  lazy,
  Suspense,
} from 'react';
import { useLayoutStore } from './store/layoutStore';
import { useSettingsStore } from './store/settingsStore';
import { useSettingsUiStore } from './store/settingsUiStore';
import { useWorkspaceStore } from './store/workspaceStore';
import { isDemoModeFast, isProductShellFast } from './createSsrGlobals';
import {
  PlatformAdaptationCtx,
  usePlatformAdaptation,
} from '@crish/shared-utils/browser';
import { createDebounced } from './api/debouncedValue';
import { onUiEvent } from './api/uiEvents';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { shouldShowFirstRunWizard } from './components/firstRunWizardLib';
import styles from './App.module.css';

import { useAppBootstrap } from './app/AppBootstrap';
import { useEngineBootstrap } from './app/useEngineBootstrap';
import { useAppShortcuts } from './app/AppShortcuts';
import { AppGlobalDialogs, SkeletonFallback } from './app/AppGlobalDialogs';
import { useWorkspaceShellStore } from './store/workspace-shell';

// ── 关键路径组件：同步导入，与 App 同 chunk ──
import { Sidebar } from './components/sidebar/Sidebar';
import { SidebarToggle } from './components/sidebar/SidebarHeader';
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
    /* swallow-ok: dev 旗标读取失败时保持默认关闭（仅影响调试面板挂载） */
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
  const activeWorkspaceId = useWorkspaceStore(
    (s) => s.workspaces[s.activeWorkspaceIndex]?.id || 'ws-0'
  );
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useLayoutStore((s) => s.setSidebarCollapsed);
  const chatMainSurface = useLayoutStore((s) => s.chatMainSurface) ?? 'chat';
  const showSettingsOverlay = useSettingsUiStore((s) => s.showSettingsOverlay);
  const setShowSettingsOverlay = useSettingsUiStore(
    (s) => s.setShowSettingsOverlay
  );
  const settingsActiveTab = useSettingsUiStore((s) => s.settingsActiveTab);
  const setAppSettings = useSettingsStore((s) => s.setAppSettings);

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
  const shellReady = useWorkspaceShellStore((s) => s.shellReady);
  const [showFirstRun, setShowFirstRun] = useState(
    () => !isDemoModeFast() && shouldShowFirstRunWizard()
  );
  // 引擎就绪门闩（T06.8 归一：useEngineBootstrap 取代 useAppBootstrap setEngineReady）
  const engineReady = useEngineBootstrap();

  // App startup & service hydration
  useAppBootstrap({
    setAppSettings,
    productShell,
  });

  // Global keybindings
  useAppShortcuts({
    showCheatsheet,
    setShowCheatsheet,
    showSettingsOverlay,
    setShowSettingsOverlay,
    showFirstRun,
    setShowTelemetry,
    setSidebarCollapsed,
  });

  // 快捷键 / 全局手势触发向导（测试 / 诊断入口）
  useEffect(() => {
    const handler = () => {
      setShowFirstRun(true);
    };
    window.addEventListener('crish-open-first-run', handler);
    return () => {
      window.removeEventListener('crish-open-first-run', handler);
    };
  }, []);

  // 全局常驻主工作区路由守卫（杜绝因子组件卸载导致 open-chat/open-scheduled 事件丢失）
  useEffect(() => {
    const offs = [
      onUiEvent('open-chat', () => {
        useLayoutStore.getState().setChatMainSurface('chat');
      }),
      onUiEvent('open-scheduled', () => {
        useLayoutStore.getState().setChatMainSurface('scheduled');
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const appModeClass = isDemoModeFast() ? 'app-mode-demo' : 'app-mode-normal';

  return (
    <PlatformAdaptationCtx.Provider value={platformAdaptation}>
      <SessionTabDragProvider>
      <div
        className={`app-container ${appModeClass}`}
        data-engine-ready={engineReady ? 'true' : 'false'}
        data-first-run={showFirstRun ? 'true' : 'false'}
        data-sidebar-collapsed={sidebarCollapsed ? 'true' : 'false'}
        data-perf-level={
          platformAdaptation.hardwareReady
            ? String(platformAdaptation.level)
            : undefined
        }
      >
        <a href="#crish-main" className={styles.skipLink}>
          跳转到主要内容
        </a>

        <AppTopBar onShowCheatsheet={() => setShowCheatsheet(true)} />

        <main
          id="crish-main"
          className="main-layout"
          aria-label="主工作区"
        >
          {sidebarCollapsed && (
            <SidebarToggle
              collapsed={sidebarCollapsed}
              onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
            />
          )}

          <div
            id="crish-sidebar"
            className={`sidebar-wrapper ${sidebarCollapsed ? 'collapsed' : ''}`}
            role="navigation"
            aria-label="会话侧栏"
            style={{
              width: sidebarCollapsed ? 0 : 'var(--sidebar-width)',
              height: '100%',
              flexShrink: 0,
              transition: 'width 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <AppErrorBoundary compact title="侧栏出错">
              <Suspense fallback={<SkeletonFallback height="100%" />}>
                <Sidebar
                  searchQuery={sessionSearch}
                  searchInput={sessionSearchInput}
                  onSearchChange={setSessionSearchInput}
                />
              </Suspense>
            </AppErrorBoundary>
          </div>

          <div
            className="workspaces-column"
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
                      <BinaryTreeWorkspace />
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
          showTelemetry={showTelemetry}
          setShowTelemetry={setShowTelemetry}
          showCheatsheet={showCheatsheet}
          setShowCheatsheet={setShowCheatsheet}
          showSettingsOverlay={showSettingsOverlay}
          setShowSettingsOverlay={setShowSettingsOverlay}
          activeWorkspaceId={activeWorkspaceId}
          settingsActiveTab={settingsActiveTab}
        />

        <DevHealthOverlayMount />
      </div>
      </SessionTabDragProvider>
    </PlatformAdaptationCtx.Provider>
  );
}

export default App;
