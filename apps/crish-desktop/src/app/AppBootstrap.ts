import { useEffect, useLayoutEffect } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import { usePermissionStore } from '../store/permissionStore';
import { bootstrapStores } from '../store/bootstrapStores';
import { bootstrapServices } from '../bootstrap-services';
import { onUiEvent } from '../api/uiEvents';
import { pickWorkspaceFolder } from '../api/pickWorkspaceFolder';
import { syncTelemetryData } from '../api/storeAccess';
import { telemetry } from '../services/TelemetryService';
import { isDemoModeFast } from '../createSsrGlobals';
import type { AppSettings } from '../store/types';
import { hydrateWorkspaceShell } from './hydrateWorkspaceShell';
import { waitLayoutTreeHydration } from '../store/layout-tree';
import { getCompositionRoot } from './compositionRoot';

/** Devtools / internal globals attached to window */
export type CrishWindow = Window & {
  useLayoutStore?: typeof useLayoutStore;
  usePermissionStore?: typeof usePermissionStore;
  AUTO_FOLD_DELAY?: number;
};

if (typeof window !== 'undefined') {
  (window as CrishWindow).useLayoutStore = useLayoutStore;
  (window as CrishWindow).usePermissionStore = usePermissionStore;
}

/** 浏览器标签 / 任务栏标题 */
const APP_DOCUMENT_TITLE = 'Crish · AI 工作台';

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
  /**
   * Optional React-owned setter; when omitted, bootstrap writes via
   * `getCompositionRoot().layout.setAppSettings` (command path).
   * App.tsx may still pass store setter for backward compatibility.
   */
  setAppSettings?: (settings: AppSettings) => void;
  productShell: boolean;
  uiSize: string;
  shellChromeMode: string | undefined;
}

export function useAppBootstrap({
  setAppSettings,
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

  // 2b. Shell chrome 冷启动门闩（默认 clean draft；设置可 restore）
  // 必须等 layout-tree persist rehydrate 完成，否则脏多 leaf 会覆盖 resetTree
  useLayoutEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await waitLayoutTreeHydration();
        if (cancelled) return;
        hydrateWorkspaceShell();
      } catch (e) {
        console.warn('[hydrateWorkspaceShell]', e);
        if (!cancelled) {
          getCompositionRoot().shell.setShellReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cleanup = bootstrapServices();
    return () => {
      cleanup();
    };
  }, []);

  // 异常退出：静默处理，不再弹窗打扰用户。
  // 默认开启错误数据采集，用户可在设置中关闭；关闭时直接清空旧日志。
  useEffect(() => {
    if (!telemetry.hasPreviousCrash()) return;
    void (async () => {
      try {
        const { clientApi } = await import('../api/clientApi');
        const settings = await clientApi.getSettings();
        telemetry.setEnabled(settings.enableCrashTelemetry !== false);
        if (telemetry.isEnabled()) {
          telemetry.sendReport();
        } else {
          telemetry.clear();
        }
      } catch {
        // 读取设置失败时仍按默认开启处理
        telemetry.sendReport();
      }
    })();
  }, []);

  useEffect(() => {
    const cleanup = bootstrapStores();
    return () => cleanup();
  }, []);

  // 3. Session folder rebinds（引擎初始化已归一至 useEngineBootstrap，T06.8）
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

    let prevSessions = getCompositionRoot().layout.getSessions();
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
          // Bootstrap command: prefer prop when App wires React setter; else layout facade
          if (setAppSettings) {
            setAppSettings(settings);
          } else {
            getCompositionRoot().layout.setAppSettings(settings);
          }
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
            getCompositionRoot().layout.setTabModeEnabled(
              settings.tabModeEnabled
            );
          } else {
            getCompositionRoot().layout.setTabModeEnabled(true);
          }
        }
      } catch (err) {
        console.error('Failed to load settings or providers on startup', err);
      }
    };
    initApp();
  }, [setAppSettings]);

  // 7. Backend daemon engine initialization 已归一至 useEngineBootstrap（T06.8）：
  //    引擎启动门闩 = transport「核心已初始化」（isReady / onStatus / waitUntilConnected）。
  // 7b. 旧明文密钥一次性迁移（PE-07 T07.4-B；幂等标记门控，失败不阻断启动）
  // syncActiveProfileToEngine 已按 F5/C6 整体删除（密钥生效仅限用户主动路径）。
  useEffect(() => {
    let cancelled = false;
    void import('../api/providerProfiles').then(({ migrateLegacyProfiles }) => {
      if (cancelled) return;
      void migrateLegacyProfiles();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 8. Root data-attributes setup
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

  // 9. App mode attribute
  useEffect(() => {
    const mode = isDemoModeFast() ? 'demo' : 'normal';
    document.body.setAttribute('data-app-mode', mode);
    document.documentElement.setAttribute('data-app-mode', mode);
  }, []);

  // 10. Telemetry subscription
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

  // 11. Pick workspace UI event listener
  useEffect(() => {
    return onUiEvent('pick-workspace', () => {
      void pickWorkspaceFolder();
    });
  }, []);

  // 12. 二叉树布局迁移：旧 columns/groups → 新 LayoutTree
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
