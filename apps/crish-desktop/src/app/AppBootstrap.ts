import { useEffect, useLayoutEffect } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import { bootstrapStores } from '../store/bootstrapStores';
import { bootstrapServices } from '../bootstrap-services';
import { emitUiEvent, onUiEvent } from '../api/uiEvents';
import { syncTelemetryData } from '../api/storeAccess';
import { telemetry } from '../services/TelemetryService';
import { isDemoModeFast } from '../createSsrGlobals';
import type { AppSettings } from '../store/types';

/** Devtools / internal globals attached to window */
export type CrishWindow = Window & {
  useLayoutStore?: typeof useLayoutStore;
  AUTO_FOLD_DELAY?: number;
};

if (typeof window !== 'undefined') {
  (window as CrishWindow).useLayoutStore = useLayoutStore;
}

/** 浏览器标签 / 任务栏标题 */
export const APP_DOCUMENT_TITLE = 'Crish · AI 工作台';

export async function pickWorkspaceFolder(): Promise<void> {
  try {
    const dialogSpec = '@tauri-apps/plugin-dialog';
    const mod = (await import(/* @vite-ignore */ dialogSpec).catch(
      () => null
    )) as {
      open?: (opts: {
        directory: boolean;
        multiple: boolean;
      }) => Promise<string | string[] | null>;
    } | null;
    if (mod?.open) {
      const selected = await mod.open({ directory: true, multiple: false });
      if (typeof selected === 'string' && selected) {
        const { addProjectFromPath } = await import('../api/projectStore');
        addProjectFromPath(selected);
        return;
      }
    }
  } catch {
    /* native picker unavailable — fall back to in-app picker */
  }
  emitUiEvent('open-project-picker');
}

export async function winCtl(
  action: 'minimize' | 'toggleMaximize' | 'close'
): Promise<void> {
  try {
    const mod = await import('@tauri-apps/api/window');
    const win = mod.getCurrentWindow();
    if (action === 'minimize') await win.minimize();
    else if (action === 'toggleMaximize') {
      if (await win.isMaximized()) await win.unmaximize();
      else await win.maximize();
    } else await win.close();
  } catch {
    /* window controls unavailable outside Tauri */
  }
}

export interface UseAppBootstrapOptions {
  setAppSettings: (settings: AppSettings) => void;
  setEngineReady: (ready: boolean | ((prev: boolean) => boolean)) => void;
  setShowCrashPrompt: (show: boolean) => void;
  productShell: boolean;
  uiSize: string;
  shellChromeMode: string | undefined;
}

export function useAppBootstrap({
  setAppSettings,
  setEngineReady,
  setShowCrashPrompt,
  productShell,
  uiSize,
  shellChromeMode,
}: UseAppBootstrapOptions) {
  // 1. Initial window globals & document metadata
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const w = window as CrishWindow;
      if (w.AUTO_FOLD_DELAY === undefined) {
        w.AUTO_FOLD_DELAY = 5000;
      }
    }
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = 'zh-CN';
    if (document.title !== APP_DOCUMENT_TITLE) {
      document.title = APP_DOCUMENT_TITLE;
    }
  }, []);

  // 2. Persistence & services initialization
  useEffect(() => {
    import('../store/layoutStore').then(({ initLayoutStorePersistence }) =>
      initLayoutStorePersistence()
    );
  }, []);

  useEffect(() => {
    const cleanup = bootstrapServices();
    return () => {
      cleanup();
    };
  }, []);

  useEffect(() => {
    if (telemetry.hasPreviousCrash()) {
      setShowCrashPrompt(true);
    }
  }, [setShowCrashPrompt]);

  useEffect(() => {
    const cleanup = bootstrapStores();
    return () => cleanup();
  }, []);

  // 3. Early lazy initialization for daemon client connection status
  useEffect(() => {
    import('../api/daemonClient').then(({ getDesktopDaemonClient }) => {
      const client = getDesktopDaemonClient();
      if (client.hasEverConnected() || client.isConnected()) {
        setEngineReady(true);
      }
    });
  }, [setEngineReady]);

  // 4. Session folder rebinds
  useLayoutEffect(() => {
    const rebind = () => {
      try {
        import('../api/projectStore').then(
          ({
            listProjects,
            rebindSessionFoldersToProjects,
            rememberProjectFolderAlias,
          }) => {
            const projects = listProjects();
            for (const p of projects) rememberProjectFolderAlias(p.id, p.path);
            useLayoutStore.setState((state) => {
              const n = rebindSessionFoldersToProjects(
                state.sessions,
                projects
              );
              if (n > 0) {
                for (const s of state.sessions) {
                  if (s.folder && !state.folderOrder.includes(s.folder)) {
                    state.folderOrder.push(s.folder);
                  }
                }
                console.info('[crish] rebound session folders', n);
              }
            });
          }
        );
      } catch (e) {
        console.warn('[crish] session folder rebind failed', e);
      }
    };

    let raf1: number | null = null;
    let raf2: number | null = null;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        rebind();
      });
    });

    let prevSessions = useLayoutStore.getState().sessions;
    const unsubStore = useLayoutStore.subscribe((state) => {
      if (state.sessions !== prevSessions) {
        prevSessions = state.sessions;
        rebind();
      }
    });

    window.addEventListener('crish-project-changed', rebind);
    return () => {
      if (raf1 !== null) window.cancelAnimationFrame(raf1);
      if (raf2 !== null) window.cancelAnimationFrame(raf2);
      unsubStore();
      window.removeEventListener('crish-project-changed', rebind);
    };
  }, []);

  // 5. Workspace layout sync
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void import('../api/workspaceLayoutStore').then(
      ({ initWorkspaceLayoutSync }) => {
        if (cancelled) return;
        cleanup = initWorkspaceLayoutSync({
          onRestored: () => {},
        });
      }
    );
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  // 6. Theme, Font, and Settings bootstrap
  useEffect(() => {
    void import('../api/themeStore').then(({ bootstrapTheme }) =>
      bootstrapTheme()
    );
    void import('../api/fontStore').then(({ bootstrapFonts }) =>
      bootstrapFonts()
    );
    const initApp = async () => {
      try {
        const { clientApi } = await import('../api/clientApi');
        const settings = await clientApi.getSettings();
        if (settings) {
          setAppSettings(settings);
          if (settings.theme) {
            const { applyTheme, persistTheme, normalizeTheme } =
              await import('../api/themeStore');
            const t = normalizeTheme(settings.theme);
            applyTheme(t);
            persistTheme(t);
          }
          if (settings.fonts) {
            const { setFontPreferences, normalizeFontPrefs } =
              await import('../api/fontStore');
            await setFontPreferences(normalizeFontPrefs(settings.fonts));
          }
          if (typeof settings.tabModeEnabled === 'boolean') {
            useLayoutStore
              .getState()
              .setTabModeEnabled(settings.tabModeEnabled);
          } else {
            useLayoutStore.getState().setTabModeEnabled(true);
          }
        }
      } catch (err) {
        console.error('Failed to load settings or providers on startup', err);
      }
    };
    initApp();
  }, [setAppSettings]);

  // 7. Backend daemon engine initialization
  useEffect(() => {
    const initEngine = async () => {
      const { bootstrapDesktopBackend } = await import('../api/daemonClient');
      const client = bootstrapDesktopBackend();
      if (client.isConnected() || client.hasEverConnected()) {
        setEngineReady(true);
      }
      const unsub = client.onState((s) => {
        if (s === 'connected' || client.hasEverConnected()) {
          setEngineReady(true);
        }
      });
      const { ensureDaemonConnected } = await import('../api/daemonChatBridge');
      void ensureDaemonConnected().then((res) => {
        if (res.ok || client.hasEverConnected()) setEngineReady(true);
        else if (!productShell) {
          console.warn(
            '[crish-desktop] engine offline after boot wait (keep-alive continues)'
          );
        }
        if (res.ok) {
          void import('../api/providerProfiles').then(
            ({ syncActiveProfileToEngine }) => {
              void syncActiveProfileToEngine();
            }
          );
          void import('../api/sessionDaemonSync').then(
            ({ syncSessionsFromDaemon }) => {
              void syncSessionsFromDaemon(
                () => useLayoutStore.getState().sessions,
                (sessions) => useLayoutStore.getState().setSessions(sessions)
              );
            }
          );
        }
      });
      const gateTimer = window.setTimeout(
        () => {
          setEngineReady(true);
        },
        productShell ? 12_000 : 0
      );
      return () => {
        unsub();
        window.clearTimeout(gateTimer);
      };
    };
    const cleanupPromise = initEngine();
    return () => {
      cleanupPromise.then((cleanup) => cleanup?.());
    };
  }, [productShell, setEngineReady]);

  // 8. Resize listener
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

  // 9. Root data-attributes setup
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-ui-size', uiSize);
    const density =
      uiSize === 'small'
        ? 'compact'
        : uiSize === 'large'
          ? 'comfortable'
          : 'default';
    root.setAttribute('data-density', density);
    const chrome = shellChromeMode || 'classic';
    root.setAttribute('data-shell-chrome', chrome);
    document.body.setAttribute('data-ui-size', uiSize);
    document.body.setAttribute('data-density', density);
    document.body.setAttribute('data-shell-chrome', chrome);
  }, [uiSize, shellChromeMode]);

  // 10. App mode attribute
  useEffect(() => {
    const mode = isDemoModeFast() ? 'demo' : 'normal';
    document.body.setAttribute('data-app-mode', mode);
    document.documentElement.setAttribute('data-app-mode', mode);
  }, []);

  // 11. Telemetry subscription
  useEffect(() => {
    const unsubPromise = import('../api/clientApi').then(({ clientApi }) =>
      clientApi.subscribeTelemetry((data) => {
        syncTelemetryData(data);
      })
    );
    return () => {
      unsubPromise.then((unsub) => unsub());
    };
  }, []);

  // 12. Pick workspace UI event listener
  useEffect(() => {
    return onUiEvent('pick-workspace', () => {
      void pickWorkspaceFolder();
    });
  }, []);

  // 13. 二叉树布局迁移：旧 columns/groups → 新 LayoutTree
  // 触发条件：新 store 处于默认状态 + localStorage 存在旧布局数据
  // 幂等：本次会话仅执行一次；新 store 已有自定义布局则跳过
  // 安全：任何步骤失败都静默回退（不阻断启动），结果可 undo
  useEffect(() => {
    let cancelled = false;
    void import('../store/layout-tree/migration').then(
      ({ migrateLayoutIfNeeded }) => {
        if (cancelled) return;
        migrateLayoutIfNeeded();
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);
}
