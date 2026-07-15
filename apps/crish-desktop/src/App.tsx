import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useLayoutStore, initLayoutStorePersistence } from './store/layoutStore';
import { clientApi } from './api/clientApi';
import { ensureDaemonConnected } from './api/daemonChatBridge';
import { bootstrapDesktopBackend, getDesktopDaemonClient } from './api/daemonClient';
import { isProductShell } from './api/productMode';
import { productStartingMessage } from './api/userFacingErrors';
import { isDemoMode } from './api/appMode';
import {
  FirstRunWizard,
  shouldShowFirstRunWizard,
} from './components/FirstRunWizard';
import { Sidebar } from './components/Sidebar';
import { Workspace } from './components/Workspace';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { ToastStack } from './components/ToastStack';
import { useToastQueue } from './hooks/useToastQueue';
import * as Lucide from 'lucide-react';
import type { SettingsTabType } from './components/SettingsPanel';
import { RuntimeFloatPanel } from './components/RuntimeFloatPanel';
import { emitUiEvent, onUiEvent } from './api/uiEvents';
import { createDebounced } from './api/debouncedValue';

const SettingsPanel = lazy(() =>
  import('./components/SettingsPanel')
    .then((m) => {
      if (!m.SettingsPanel) {
        throw new Error('SettingsPanel 导出缺失');
      }
      return { default: m.SettingsPanel };
    })
    .catch((err) => {
      console.error('[crish] SettingsPanel lazy load failed', err);
      throw err;
    }),
);

/** Devtools / internal globals attached to window (no `as any`) */
type CrishWindow = Window & {
  useLayoutStore?: typeof useLayoutStore;
  AUTO_FOLD_DELAY?: number;
};

if (typeof window !== 'undefined') {
  (window as CrishWindow).useLayoutStore = useLayoutStore;
}

function App() {
  const workspaces = useLayoutStore((s) => s.workspaces);
  const activeWorkspaceIndex = useLayoutStore((s) => s.activeWorkspaceIndex);
  const uiSize = useLayoutStore((s) => s.uiSize);
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useLayoutStore((s) => s.setSidebarCollapsed);
  const showSettingsOverlay = useLayoutStore((s) => s.showSettingsOverlay);
  const setShowSettingsOverlay = useLayoutStore((s) => s.setShowSettingsOverlay);
  const settingsActiveTab = useLayoutStore((s) => s.settingsActiveTab);
  const setAppSettings = useLayoutStore((s) => s.setAppSettings);

  const { toasts, showToast: handleShowToast, dismissToast } = useToastQueue();
  const activeWorkspace = workspaces[activeWorkspaceIndex];
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  const [runtimeFloatOpen, setRuntimeFloatOpen] = useState(false);
  /** 搜索框即时输入 */
  const [sessionSearchInput, setSessionSearchInput] = useState('');
  /** 防抖后的查询，供侧栏过滤（避免每键全量扫 sessions） */
  const [sessionSearch, setSessionSearch] = useState('');
  const searchDebounceRef = useRef(
    createDebounced<string>((q) => setSessionSearch(q), 220),
  );
  useEffect(() => {
    searchDebounceRef.current.schedule(sessionSearchInput);
    return () => searchDebounceRef.current.cancel();
  }, [sessionSearchInput]);
  const productShell = isProductShell();
  const [showFirstRun, setShowFirstRun] = useState(
    () => !isDemoMode() && shouldShowFirstRunWizard(),
  );

  const pickWorkspaceFolder = async () => {
    try {
      // Optional desktop plugin (not always installed in browser/dev); avoid Function()
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
    } catch {
      /* fall through */
    }
    // No native dialog: open polished in-chat project picker instead of window.prompt
    emitUiEvent('open-project-picker');
  };
  /** Product: block main chrome until engine has connected at least once. */
  const [engineReady, setEngineReady] = useState(
    () => !productShell || getDesktopDaemonClient().hasEverConnected() || getDesktopDaemonClient().isConnected(),
  );

  // Sidebar hover overlay state & handlers
  const [isHoveredExpanded, setIsHoveredExpanded] = useState(false);
  const hoverTimeoutRef = useRef<any>(null);

  // 工具自动折叠默认值（原面板菜单已移除；仍供内部读取）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as CrishWindow;
    if (w.AUTO_FOLD_DELAY === undefined) {
      w.AUTO_FOLD_DELAY = 5000;
    }
  }, []);

  // 会话 index / JSONL 防抖落盘 + 磁盘镜像回灌（demo 模式 no-op）
  useEffect(() => initLayoutStorePersistence(), []);

  // 按项目路径保存/恢复右侧工作区布局（localStorage + session 防覆盖）
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void import('./api/workspaceLayoutStore').then(({ initWorkspaceLayoutSync }) => {
      if (cancelled) return;
      cleanup = initWorkspaceLayoutSync({
        onRestored: () => handleShowToast('已恢复项目工作区布局'),
      });
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [handleShowToast]);

  // Initial load theme & settings sync
  useEffect(() => {
    // 同步本地主题/字体（settings 异步前就已在 main/html 里 bootstrap）
    void import('./api/themeStore').then(({ bootstrapTheme }) => bootstrapTheme());
    void import('./api/fontStore').then(({ bootstrapFonts }) => bootstrapFonts());
    const initApp = async () => {
      try {
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
        }
        // 模型/密钥走 providerProfiles，不再 seed 假 clientApi providers
      } catch (err) {
        console.error("Failed to load settings or providers on startup", err);
      }
    };
    initApp();
  }, []);

  // Engine keep-alive from first frame. Product: gate UI until first connect (no flicker chip after).
  useEffect(() => {
    const client = bootstrapDesktopBackend();
    if (client.isConnected() || client.hasEverConnected()) {
      setEngineReady(true);
    }
    const unsub = client.onState((s) => {
      if (s === 'connected' || client.hasEverConnected()) {
        setEngineReady(true);
      }
    });
    void ensureDaemonConnected().then((res) => {
      if (res.ok || client.hasEverConnected()) setEngineReady(true);
      else if (!productShell) {
        console.warn('[crish-desktop] engine offline after boot wait (keep-alive continues)');
      }
      if (res.ok) {
        // 正式版：把本地活动服务商配置写回引擎
        void import('./api/providerProfiles').then(({ syncActiveProfileToEngine }) => {
          void syncActiveProfileToEngine();
        });
        // Best-effort daemon session list merge (does not wipe local messages)
        void import('./api/sessionDaemonSync').then(({ syncSessionsFromDaemon }) => {
          void syncSessionsFromDaemon(
            () => useLayoutStore.getState().sessions,
            (sessions) => useLayoutStore.getState().setSessions(sessions),
          );
        });
      }
    });
    // 防止引擎长时间不可达时整窗空白：超时后仍进入主界面（引擎保持后台重连）
    const gateTimer = window.setTimeout(() => {
      setEngineReady(true);
    }, productShell ? 12_000 : 0);
    return () => {
      unsub();
      window.clearTimeout(gateTimer);
    };
  }, [productShell]);

  // Resize Throttling (80ms) + Debounce (400ms) with elastic transition support
  const [resizeWidth, setResizeWidth] = useState<number | null>(null);
  useEffect(() => {
    let throttleTimer: any = null;
    let debounceTimer: any = null;
    let lastExecuted = 0;

    const handleResize = () => {
      document.body.classList.add('window-resizing');
      const now = Date.now();
      const currentWidth = window.innerWidth;

      if (now - lastExecuted >= 80) {
        setResizeWidth(currentWidth);
        lastExecuted = now;
      } else {
        if (throttleTimer) clearTimeout(throttleTimer);
        throttleTimer = setTimeout(() => {
          setResizeWidth(currentWidth);
          lastExecuted = Date.now();
        }, 80 - (now - lastExecuted));
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        setResizeWidth(null);
        document.body.classList.remove('window-resizing');
      }, 400);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (throttleTimer) clearTimeout(throttleTimer);
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

  // Sync UI size attribute on root HTML element
  useEffect(() => {
    document.documentElement.setAttribute('data-ui-size', uiSize);
  }, [uiSize]);

  // 全局快捷键：Ctrl/Cmd+, 切换设置；双击 Esc（300ms 内）分叉当前会话
  useEffect(() => {
    let lastEscTime = 0;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        const show = useLayoutStore.getState().showSettingsOverlay;
        useLayoutStore.getState().setShowSettingsOverlay(!show);
        return;
      }
      if (e.key === 'Escape') {
        const now = Date.now();
        if (now - lastEscTime <= 300) {
          e.preventDefault();
          const state = useLayoutStore.getState();
          const oldSessionId = state.activeSessionId;
          const activeSess = state.sessions.find((s) => s.id === oldSessionId);
          if (activeSess) {
            state.branchSession(activeSess.id, `${activeSess.title} - 双击ESC分叉`);
            const newBranchId = useLayoutStore.getState().activeSessionId;
            handleShowToast(`已通过双击 Escape 快捷分叉会话: ${activeSess.title}`, () => {
              const st = useLayoutStore.getState();
              // 无 deleteSession：归档新分叉并切回原会话
              if (newBranchId && newBranchId !== oldSessionId) {
                st.archiveSession(newBranchId);
              }
              if (oldSessionId) {
                st.setActiveSessionId(oldSessionId);
              }
            });
          }
        }
        lastEscTime = now;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleShowToast]);

  // Connect and subscribe to WebSocket Telemetry
  useEffect(() => {
    const unsubscribe = clientApi.subscribeTelemetry((data) => {
      useLayoutStore.getState().syncTelemetryData(data);
    });
    return () => unsubscribe();
  }, []);

  // Native folder pick → projectStore (no trust wall)
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
    } catch {
      /* browser host */
    }
  };

  return (
    <div className={`app-container ${isDemoMode() ? 'app-mode-demo' : 'app-mode-normal'}`}>
      {/* 本地壳立刻显示；引擎连接仅顶栏轻提示，不再整页挡死 */}
      {productShell && !engineReady ? (
        <div className="app-boot-banner" role="status" aria-live="polite">
          <span className="app-boot-banner-dot" aria-hidden />
          <span>{productStartingMessage()}</span>
        </div>
      ) : null}
      {showFirstRun && (
        <FirstRunWizard
          onDone={() => {
            setShowFirstRun(false);
            // U5：空会话时轻提示下一步
            const st = useLayoutStore.getState();
            const sess = st.sessions.find((s) => s.id === st.activeSessionId);
            const empty = !sess?.messages?.length;
            if (empty) {
              handleShowToast('下一步：选择项目或直接提问');
            }
          }}
          onOpenSettings={() => {
            setShowFirstRun(false);
            useLayoutStore.getState().openSettings('models');
          }}
        />
      )}
      {/* Titlebar — drag region for frameless Tauri window */}
      <header className="app-header" data-tauri-drag-region>
        <div className="app-header-left" data-tauri-drag-region>
          <button
            type="button"
            className="header-btn no-drag"
            title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            <Lucide.PanelLeft size={16} />
          </button>

          <div className="search-bar no-drag" data-tauri-drag-region="false">
            <Lucide.Search className="search-icon" size={16} />
            <input
              type="text"
              placeholder="搜索会话与消息…"
              value={sessionSearchInput}
              onChange={(e) => setSessionSearchInput(e.target.value)}
            />
          </div>

        </div>

        <div className="app-header-right no-drag">
          <button
            type="button"
            className="header-btn"
            onClick={() => setShowCheatsheet(true)}
            title="快捷键与帮助"
          >
            <Lucide.HelpCircle size={16} />
          </button>

          <button
            type="button"
            className={`header-btn ${runtimeFloatOpen ? 'active' : ''}`}
            title="运行状态"
            onClick={() => setRuntimeFloatOpen((v) => !v)}
          >
            <Lucide.Activity size={16} />
          </button>

          <div className="window-controls">
            <button type="button" className="win-btn" title="最小化" onClick={() => void winCtl('minimize')}>
              <Lucide.Minus size={16} />
            </button>
            <button type="button" className="win-btn" title="最大化" onClick={() => void winCtl('toggleMaximize')}>
              <Lucide.Square size={14} />
            </button>
            <button type="button" className="win-btn close" title="关闭" onClick={() => void winCtl('close')}>
              <Lucide.X size={16} />
            </button>
          </div>
        </div>
      </header>

      {/* Main content body with Sidebar and workspaces side by side */}
      <main
        className="main-layout"
        style={{
          position: 'relative',
          width: resizeWidth ? `${resizeWidth}px` : '100%',
          margin: '0 auto',
        }}
      >
        {sidebarCollapsed && (
          <div
            className="sidebar-hover-trigger"
            onMouseEnter={handleHoverTriggerEnter}
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
          className={`sidebar-wrapper ${sidebarCollapsed ? 'collapsed' : ''}`}
          style={{
            width: sidebarCollapsed ? 0 : 'var(--sidebar-width)',
            height: '100%',
            flexShrink: 0,
            transition: 'width 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)',
            overflow: 'visible',
            position: 'relative',
          }}
        >
          <Sidebar
            onShowToast={handleShowToast}
            hoverExpanded={sidebarCollapsed && isHoveredExpanded}
            onHoverLeave={handleSidebarHoverLeave}
            onHoverEnter={handleSidebarHoverEnter}
            onOpenRuntime={() => setRuntimeFloatOpen(true)}
            searchQuery={sessionSearch}
          />
        </div>

        <div className="workspaces-container">
          {workspaces.map((ws) => (
            <Workspace key={ws.id} ws={ws} onShowToast={handleShowToast} />
          ))}
        </div>
      </main>

      <RuntimeFloatPanel
        open={runtimeFloatOpen}
        onClose={() => setRuntimeFloatOpen(false)}
        onShowToast={handleShowToast}
      />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {/* Centered Lightweight Approval Dialog and Floating Plan Panel removed for clean UI */}
      
      {/* Centered Cheatsheet Modal Overlay */}
      {showCheatsheet && (
        <div className="cheatsheet-overlay" onClick={() => setShowCheatsheet(false)}>
          <div className="cheatsheet-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cheatsheet-header">
              <div className="cheatsheet-title-wrap">
                <Lucide.Keyboard size={16} style={{ color: 'var(--accent-color)' }} />
                <h3 className="cheatsheet-title">快捷键</h3>
              </div>
              <button onClick={() => setShowCheatsheet(false)} className="cheatsheet-close-btn">
                <Lucide.X size={16} />
              </button>
            </div>
            
            <div className="cheatsheet-body">
              <div className="cheatsheet-row">
                <span className="cheatsheet-label">打开系统设置</span>
                <kbd className="cheatsheet-key">Ctrl + ,</kbd>
              </div>
              <div className="cheatsheet-row">
                <span className="cheatsheet-label">分支分叉当前会话</span>
                <kbd className="cheatsheet-key">双击 Escape</kbd>
              </div>
              <div className="cheatsheet-row">
                <span className="cheatsheet-label">聊天命令行提示</span>
                <kbd className="cheatsheet-key">输入 /</kbd>
              </div>
              <div className="cheatsheet-row">
                <span className="cheatsheet-label">关闭当前选中卡片</span>
                <kbd className="cheatsheet-key">中键点击标签页</kbd>
              </div>
            </div>
            
            <div className="cheatsheet-footer-tip">
              <strong>布局提示：</strong>
              工作区卡片支持拖拽与合并。拖动标签页在其他卡片边缘悬停即可快速分屏，或在标签栏中拖拽重排。
            </div>
          </div>
        </div>
      )}

      {/* 设置：全覆盖；z-index 与 settings.css(.settings-cover=13000) 双保险；ErrorBoundary 展示真实错误 */}
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
                <div className="settings-suspense-fallback" aria-busy="true">
                  <div className="settings-suspense-skel settings-suspense-skel--nav" />
                  <div className="settings-suspense-skel settings-suspense-skel--main" />
                </div>
              }
            >
              <SettingsPanel
                wsId={activeWorkspace?.id || 'ws-0'}
                onShowToast={handleShowToast}
                onClose={() => setShowSettingsOverlay(false)}
                initialTab={(settingsActiveTab as SettingsTabType) || 'profile'}
              />
            </Suspense>
          </AppErrorBoundary>
        </div>
      )}
    </div>
  );
}

export default App;
