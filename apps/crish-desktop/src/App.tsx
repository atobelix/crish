import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useLayoutStore, initLayoutStorePersistence } from './store/layoutStore';
import { getSessionById } from './store/sessionStore';
import {
  archiveSession,
  branchSession,
  createSession,
  getSessionStoreState,
  openSettings,
  setActiveSessionId,
  syncTelemetryData,
  toggleSettingsOverlay,
} from './api/storeAccess';
import { matchShortcutActions } from './api/shortcutBindings';
import type { SettingsTabType } from './store/types';
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
import { WorkspaceChromeBars } from './components/WorkspaceChromeBars';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { ToastStack } from './components/ToastStack';
import { formatBranchUndoToast, useToastQueue } from './hooks/useToastQueue';
import * as Lucide from 'lucide-react';

import { RuntimeFloatPanel } from './components/RuntimeFloatPanel';
import { emitUiEvent, onUiEvent } from './api/uiEvents';
import { createDebounced } from './api/debouncedValue';
import { getActiveModelId, getActiveProfileId } from './api/providerProfiles';
import { IconSidebarLeft } from './components/SidebarToggleIcons';
import {
  listProjects,
  rebindSessionFoldersToProjects,
  rememberProjectFolderAlias,
} from './api/projectStore';

/** 浏览器标签 / 任务栏标题（中文产品壳；html 内默认 crish-desktop 仅作占位） */
const APP_DOCUMENT_TITLE = 'Crish · AI 工作台';

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
  const shellChromeMode = useLayoutStore((s) => s.shellChromeMode);
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
  /** 跳过链接聚焦展开（无全局 sr-only CSS） */
  const [skipLinkFocused, setSkipLinkFocused] = useState(false);
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
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 工具自动折叠默认值（原面板菜单已移除；仍供内部读取）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as CrishWindow;
    if (w.AUTO_FOLD_DELAY === undefined) {
      w.AUTO_FOLD_DELAY = 5000;
    }
  }, []);

  // 文档标题 + 中文 a11y 语言（不改 index.html 编译产物时也能在运行时收口）
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = 'zh-CN';
    if (document.title !== APP_DOCUMENT_TITLE) {
      document.title = APP_DOCUMENT_TITLE;
    }
  }, []);

  // 会话 index / JSONL 防抖落盘 + 磁盘镜像回灌（demo 模式 no-op）
  // 注意：壳层不在此 createSession，避免冷启动幽灵空壳会话
  useEffect(() => initLayoutStorePersistence(), []);

  // 修复幽灵 proj-* folder：把旧项目 id 绑回当前路径对应项目（对话「丢了」主因）
  useEffect(() => {
    const rebind = () => {
      try {
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

  // 按项目路径保存/恢复右侧工作区布局（localStorage + session 防覆盖）
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void import('./api/workspaceLayoutStore').then(({ initWorkspaceLayoutSync }) => {
      if (cancelled) return;
      cleanup = initWorkspaceLayoutSync({
        // 布局恢复是预期行为，不 toast 刷屏
        onRestored: () => {},
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
          // tabMode：Settings 与 layoutStore 双写；默认 true（合并右侧标签）
          // hydrate 时以 Settings 为准；true 时折叠已有堆叠 group
          if (typeof settings.tabModeEnabled === 'boolean') {
            useLayoutStore.getState().setTabModeEnabled(settings.tabModeEnabled);
          } else {
            useLayoutStore.getState().setTabModeEnabled(true);
          }
          // hideThinkingBlock / responseStyle 已在 appSettings，下游订阅生效
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
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
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

  // 密度 / 字号 / 壳形态：同步到 <html> 与 body
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-ui-size', uiSize);
    // 壳层密度别名：小=紧凑 · 中=默认 · 大=宽松（子组件自有 density 时以局部为准）
    const density =
      uiSize === 'small' ? 'compact' : uiSize === 'large' ? 'comfortable' : 'default';
    root.setAttribute('data-density', density);
    const chrome = shellChromeMode || 'classic';
    root.setAttribute('data-shell-chrome', chrome);
    document.body.setAttribute('data-ui-size', uiSize);
    document.body.setAttribute('data-density', density);
    document.body.setAttribute('data-shell-chrome', chrome);
  }, [uiSize, shellChromeMode]);

  // 演示/正式模式写到 body，便于 CSS 与辅助技术区分
  useEffect(() => {
    const mode = isDemoMode() ? 'demo' : 'normal';
    document.body.setAttribute('data-app-mode', mode);
    document.documentElement.setAttribute('data-app-mode', mode);
  }, []);

  // 全局快捷键：设置页可改绑；Esc 优先关盖层；双击 Esc 分叉
  useEffect(() => {
    let lastEscTime = 0;
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
          lastEscTime = 0;
          return;
        }
        if (showSettingsOverlay) {
          e.preventDefault();
          setShowSettingsOverlay(false);
          lastEscTime = 0;
          return;
        }
        if (runtimeFloatOpen) {
          e.preventDefault();
          setRuntimeFloatOpen(false);
          lastEscTime = 0;
          return;
        }
        if (showFirstRun) {
          lastEscTime = 0;
          return;
        }
        const now = Date.now();
        if (now - lastEscTime <= 300) {
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
          lastEscTime = 0;
          return;
        }
        lastEscTime = now;
        return;
      }

      // 可编辑区：仅允许系统级（设置 / 侧栏 / 运行浮层），避免劫持输入
      const actions = matchShortcutActions(e);
      if (actions.length === 0) return;

      for (const action of actions) {
        if (inEditable && !['toggle_settings', 'toggle_sidebar', 'toggle_runtime', 'cheatsheet'].includes(action)) {
          continue;
        }
        switch (action) {
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
          case 'toggle_runtime':
            e.preventDefault();
            setRuntimeFloatOpen((v) => !v);
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
          default:
            break;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    handleShowToast,
    showCheatsheet,
    showSettingsOverlay,
    runtimeFloatOpen,
    showFirstRun,
    setShowSettingsOverlay,
    setSidebarCollapsed,
  ]);

  // Connect and subscribe to WebSocket Telemetry
  useEffect(() => {
    const unsubscribe = clientApi.subscribeTelemetry((data) => {
      syncTelemetryData(data);
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

  const appModeClass = isDemoMode() ? 'app-mode-demo' : 'app-mode-normal';
  const shellDensity =
    uiSize === 'small' ? 'compact' : uiSize === 'large' ? 'comfortable' : 'default';

  return (
    <div
      className={`app-container ${appModeClass}`}
      data-ui-size={uiSize}
      data-density={shellDensity}
      data-shell-chrome={shellChromeMode || 'classic'}
      data-engine-ready={engineReady ? 'true' : 'false'}
      data-first-run={showFirstRun ? 'true' : 'false'}
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

      {/* 本地壳立刻显示；引擎连接仅顶栏轻提示，不再整页挡死；不在此 createSession */}
      {productShell && !engineReady ? (
        <div
          className="app-boot-banner"
          role="status"
          aria-live="polite"
          aria-label="引擎启动状态"
        >
          <span className="app-boot-banner-dot" aria-hidden="true" />
          <span>{productStartingMessage()}</span>
        </div>
      ) : null}
      {showFirstRun && (
        <FirstRunWizard
          onDone={() => {
            setShowFirstRun(false);
            // 向导完成：不 toast、不建空会话；通知底栏按 providerProfiles 本地状态刷新
            const model = getActiveModelId();
            const profileId = getActiveProfileId();
            if (model && profileId) {
              emitUiEvent('model-changed', { profileId, model });
            }
          }}
          onOpenSettings={() => {
            setShowFirstRun(false);
            // 高级扫描在设置页；不 toast 引导、不预建会话
            openSettings('models');
          }}
        />
      )}
      {/* classic：完整顶栏搜索；inset：项目行作顶栏（无圆角，类 Terminal） */}
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
              <IconSidebarLeft size={15} aria-hidden="true" />
            </button>
            <div
              className="search-bar no-drag"
              role="search"
              aria-label="会话搜索"
              data-tauri-drag-region="false"
            >
              <Lucide.Search className="search-icon" size={16} aria-hidden="true" />
              <input
                type="search"
                placeholder="搜索会话与消息…"
                aria-label="搜索会话与消息"
                value={sessionSearchInput}
                onChange={(e) => setSessionSearchInput(e.target.value)}
              />
            </div>
          </div>
          <div className="app-header-right no-drag" role="toolbar" aria-label="顶栏操作">
            <button
              type="button"
              className="header-btn"
              onClick={() => setShowCheatsheet(true)}
              title="快捷键与帮助"
              aria-label="快捷键与帮助"
              aria-haspopup="dialog"
            >
              <Lucide.HelpCircle size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`header-btn ${runtimeFloatOpen ? 'active' : ''}`}
              title="运行状态"
              aria-label="运行状态"
              aria-pressed={runtimeFloatOpen}
              onClick={() => setRuntimeFloatOpen((v) => !v)}
            >
              <Lucide.Activity size={16} aria-hidden="true" />
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
                <Lucide.Minus size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="win-btn no-drag"
                title="最大化"
                aria-label="最大化或还原窗口"
                data-tauri-drag-region="false"
                onClick={() => void winCtl('toggleMaximize')}
              >
                <Lucide.Square size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="win-btn close no-drag"
                title="关闭"
                aria-label="关闭窗口"
                data-tauri-drag-region="false"
                onClick={() => void winCtl('close')}
              >
                <Lucide.X size={16} aria-hidden="true" />
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
          {/* 左格 = 侧栏同宽：侧栏钮落在「功能列」；右格与主内容卡左缘对齐 */}
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
              <IconSidebarLeft size={15} aria-hidden="true" />
            </button>
          </div>
          <div className="ws-titlebar-main" data-tauri-drag-region>
            <AppErrorBoundary compact title="工作区标签出错">
              <WorkspaceChromeBars
                variant="workspace"
                className="ws-chrome-row--titlebar"
                onAddProject={() => emitUiEvent('pick-workspace')}
                onOpenRuntime={() => setRuntimeFloatOpen((v) => !v)}
                onOpenHelp={() => setShowCheatsheet(true)}
                onWinMinimize={() => void winCtl('minimize')}
                onWinMaximize={() => void winCtl('toggleMaximize')}
                onWinClose={() => void winCtl('close')}
              />
            </AppErrorBoundary>
          </div>
        </div>
      )}

      {/* Main content body with Sidebar and workspaces side by side */}
      <main
        id="crish-main"
        className="main-layout"
        aria-label="主工作区"
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
            {/* inset：搜索从顶栏迁到侧栏顶，顶栏彻底变成壳层拖拽区 */}
            {shellChromeMode === 'inset' ? (
              <div
                className="sidebar-search-slot no-drag"
                role="search"
                aria-label="会话搜索"
              >
                <Lucide.Search className="search-icon" size={14} aria-hidden="true" />
                <input
                  type="search"
                  placeholder="搜索会话与消息…"
                  aria-label="搜索会话与消息"
                  value={sessionSearchInput}
                  onChange={(e) => setSessionSearchInput(e.target.value)}
                />
              </div>
            ) : null}
            <Sidebar
              onShowToast={handleShowToast}
              hoverExpanded={sidebarCollapsed && isHoveredExpanded}
              onHoverLeave={handleSidebarHoverLeave}
              onHoverEnter={handleSidebarHoverEnter}
              onOpenRuntime={() => setRuntimeFloatOpen(true)}
              searchQuery={sessionSearch}
            />
          </AppErrorBoundary>
        </div>

        {/* 圆角只包会话行 + 正文；项目行已在整窗顶栏 */}
        <div
          className={`workspaces-column${shellChromeMode === 'inset' ? ' workspaces-column--inset' : ''}`}
          role="region"
          aria-label="工作台内容"
        >
          <div className="workspaces-stack" role="region" aria-label="会话与面板">
            {/*
             * inset：会话条挂在聊天列顶（与右侧工具标签同排 = 第二行），
             * 不再在 stack 顶单独占满宽一行，避免右侧总览再起「第三行」。
             */}
            <div className="workspaces-container" role="region" aria-label="工作区面板">
              <AppErrorBoundary compact title="工作区出错">
                {workspaces.map((ws) => (
                  <Workspace key={ws.id} ws={ws} onShowToast={handleShowToast} />
                ))}
              </AppErrorBoundary>
            </div>
          </div>
        </div>
      </main>

      <RuntimeFloatPanel
        open={runtimeFloatOpen}
        onClose={() => setRuntimeFloatOpen(false)}
        onShowToast={handleShowToast}
      />

      <div role="region" aria-label="通知" aria-live="polite">
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>

      {/* Centered Lightweight Approval Dialog and Floating Plan Panel removed for clean UI */}
      
      {/* Centered Cheatsheet Modal Overlay */}
      {showCheatsheet && (
        <div
          className="cheatsheet-overlay"
          role="presentation"
          onClick={() => setShowCheatsheet(false)}
        >
          <div
            className="cheatsheet-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cheatsheet-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="cheatsheet-header">
              <div className="cheatsheet-title-wrap">
                <Lucide.Keyboard
                  size={16}
                  style={{ color: 'var(--accent-color)' }}
                  aria-hidden="true"
                />
                <h3 className="cheatsheet-title" id="cheatsheet-title">
                  快捷键
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCheatsheet(false)}
                className="cheatsheet-close-btn"
                aria-label="关闭快捷键帮助"
              >
                <Lucide.X size={16} aria-hidden="true" />
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
                wsId={activeWorkspace?.id || 'ws-0'}
                onShowToast={handleShowToast}
                onClose={() => setShowSettingsOverlay(false)}
                initialTab={settingsActiveTab || 'profile'}
              />
            </Suspense>
          </AppErrorBoundary>
        </div>
      )}
    </div>
  );
}

export default App;
