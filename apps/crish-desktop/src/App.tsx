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
import { navigateToSurface } from './store/surfaceRouter';
import { usePreferencesHydration } from './hooks/usePreferencesHydration';
import { isDeveloperEngineUiEnabled } from './api/productMode';

// ── 关键路径组件：同步导入，与 App 同 chunk ──
import { Sidebar } from './components/sidebar/Sidebar';
import { SidebarToggle } from './components/sidebar/SidebarHeader';
import { AppTopBar } from './components/AppTopBar';
import { SessionTabDragProvider } from './components/shell/SessionTabDragContext';
// REDLINE-403：首屏核心工作区静态同步导入，消除 Suspense 悬挂闪烁
import { BinaryTreeWorkspace } from './components/binary-tree/BinaryTreeWorkspace';

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
      isDeveloperEngineUiEnabled();
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

// ── 非关键路径组件：代码分割，按需加载 ──

function App() {
  const { isHydrated } = usePreferencesHydration();
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
  const uiSize = useLayoutStore((s) => s.uiSize);
  const shellChromeMode = useLayoutStore((s) => s.shellChromeMode);
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
  // T16 密度档复活：真实 store 订阅值透传，驱动 body[data-ui-size] 生效
  useAppBootstrap({
    setAppSettings,
    productShell,
    uiSize,
    shellChromeMode,
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

  // 全局常驻主工作区路由守卫（统一接入 surfaceRouter）
  useEffect(() => {
    const offs = [
      onUiEvent('open-chat', () => {
        navigateToSurface('chat');
      }),
      onUiEvent('open-scheduled', () => {
        navigateToSurface('scheduled');
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
        data-preferences-hydrated={isHydrated ? 'true' : 'false'}
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
            {/* 流内顶栏：只盖工作区列，不再绝对定位横跨全宽 */}
            <AppTopBar
              onShowCheatsheet={() => setShowCheatsheet(true)}
            />
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
                  {/* Coordinator 已在挂载前 applyAtomicCommit + hydrateWorkspaceShell；
                      shellReady 常规路径为 true；fallback 兜底仍显示骨架 */}
                  {!shellReady ? (
                    <SkeletonFallback height={400} />
                  ) : (
                    <BinaryTreeWorkspace />
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
