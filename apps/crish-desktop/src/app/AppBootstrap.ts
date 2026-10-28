import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import { usePermissionStore } from '../store/permissionStore';
import { bootstrapStores } from '../store/bootstrapStores';
import { bootstrapServices } from '../bootstrap-services';
import { emitUiEvent, onUiEvent } from '../api/uiEvents';
import { pickWorkspaceFolder } from '../api/pickWorkspaceFolder';
import { syncTelemetryData } from '../api/storeAccess';
import { telemetry } from '../services/TelemetryService';
import { toast } from '../services/toast';
import { isDemoModeFast } from '../createSsrGlobals';
import type { AppSettings } from '../store/types';
import { getCompositionRoot } from './compositionRoot';
import {
  completeWorkspaceAccessStartup,
  reserveWorkspaceAccessStartup,
} from '../api/workspaceAccessGate';
import { isTauriRuntimeAvailable } from '../api/tauriInvoke';
import { useI18n } from '../i18n';

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
   * Settings hydration is owned by UnifiedAppHydrationCoordinator
   * (entry-core preload → applyAtomicCommit). Setter kept for API compat;
   * AppBootstrap no longer performs getSettings / disk-write on startup.
   */
  setAppSettings?: (settings: AppSettings) => void;
  productShell: boolean;
  uiSize?: string;
  shellChromeMode?: string;
}

export function useAppBootstrap({
  setAppSettings: _setAppSettings,
  productShell: _productShell,
  uiSize: _uiSize,
  shellChromeMode: _shellChromeMode,
}: UseAppBootstrapOptions) {
  const { language, t } = useI18n();
  const startupTranslator = useRef(t);
  startupTranslator.current = t;
  // 首屏渲染时先关住工作区 IPC；授权 effect 完成或失败后再释放。
  reserveWorkspaceAccessStartup();

  // 1. Window globals & document metadata
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
    document.documentElement.lang = language;
    const title = t('workspace.documentTitle');
    if (document.title !== title) {
      document.title = title;
    }
  }, [language, t]);

  // 2. Session persistence init (layout tree hydrate is Coordinator-owned)
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

  // 异常退出：静默处理，不再弹窗打扰用户。
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
        telemetry.sendReport();
      }
    })();
  }, []);

  useEffect(() => {
    const cleanup = bootstrapStores();
    return () => cleanup();
  }, []);

  // 启动时只用 Rust recent 列表复授权 localStorage 当前项目；失败时提示重选。
  useEffect(() => {
    let disposed = false;
    const reportFailure = (error: unknown) => {
      const unavailable =
        error instanceof Error &&
        'code' in error &&
        error.code === 'command-unavailable' &&
        !isTauriRuntimeAvailable();
      completeWorkspaceAccessStartup(unavailable ? undefined : error);
      if (disposed || unavailable) return;
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : startupTranslator.current('workspace.startupAuthorizationFailed')
      );
      emitUiEvent('open-project-picker');
    };
    void import('../api/workspaceAccessApi')
      .then(
        ({ restoreActiveWorkspaceAtStartup }) =>
          void restoreActiveWorkspaceAtStartup().catch(reportFailure)
      )
      .catch(reportFailure);
    return () => {
      disposed = true;
    };
  }, []);

  // 3. Session folder rebind：Store 就绪事件驱动（ACT-405，铲除双 rAF）。
  //    启动一次 + crish-project-changed；isLayoutReady 后微任务执行 rebind。
  useLayoutEffect(() => {
    let disposed = false;
    let rebindScheduled = false;

    const rebind = () => {
      try {
        void import('../api/projectStore').then(
          ({ listProjects, rememberProjectFolderAlias }) => {
            if (disposed) return;
            const projects = listProjects();
            for (const p of projects) rememberProjectFolderAlias(p.id, p.path);
            getCompositionRoot()
              .session.getState()
              .rebindSessionFolders(projects);
          }
        );
      } catch (e) {
        console.warn('[crish] session folder rebind failed', e);
      }
    };

    // microtask 驱动：避免双 rAF 33~50ms 盲等；布局 Store 已在 Coordinator 预置 isHydrated
    const scheduleRebind = () => {
      if (rebindScheduled || disposed) return;
      rebindScheduled = true;
      queueMicrotask(() => {
        rebindScheduled = false;
        if (!disposed) rebind();
      });
    };

    scheduleRebind();
    window.addEventListener('crish-project-changed', rebind);
    return () => {
      disposed = true;
      window.removeEventListener('crish-project-changed', rebind);
    };
  }, []);

  // 4. Fonts bootstrap + theme/indent projections（settings 水合由 Coordinator 完成）
  useEffect(() => {
    void import('../api/fontStore').then(({ bootstrapFonts }) =>
      bootstrapFonts()
    );
    const unsubTheme = import('../store/themeProjection').then(
      ({ initThemeProjection }) => initThemeProjection()
    );
    const unsubIndent = import('../store/codeIndentProjection').then(
      ({ initCodeIndentProjection }) => initCodeIndentProjection()
    );
    // 启动期严禁 settings 反写磁盘（REDLINE-402 / ACT-402）；
    // 设置真源 = Coordinator.applyAtomicCommit → settingsStore.appSettings。
    return () => {
      void unsubTheme.then((unsub) => unsub());
      void unsubIndent.then((unsub) => unsub());
    };
  }, []);

  // 5. 旧明文密钥一次性迁移（幂等标记门控，失败不阻断启动）
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

  // 6. Fullscreen attribute（html[data-fullscreen]）
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let disposed = false;
    let unlistenTauri: (() => void) | null = null;

    const applyFullscreen = (isFullscreen: boolean): void => {
      document.documentElement.setAttribute(
        'data-fullscreen',
        isFullscreen ? 'true' : 'false'
      );
    };

    const onBrowserFullscreenChange = (): void => {
      applyFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onBrowserFullscreenChange);
    applyFullscreen(Boolean(document.fullscreenElement));

    void (async () => {
      try {
        const mod = await import('@tauri-apps/api/window');
        if (disposed) return;
        const win = mod.getCurrentWindow();
        const maybeFullscreenWin = win as typeof win & {
          onFullscreenChanged?: (
            handler: (event: { payload: boolean }) => void
          ) => Promise<() => void>;
        };
        if (typeof maybeFullscreenWin.onFullscreenChanged === 'function') {
          unlistenTauri = await maybeFullscreenWin.onFullscreenChanged(
            ({ payload }) => {
              if (!disposed) applyFullscreen(Boolean(payload));
            }
          );
        } else if (typeof win.onResized === 'function') {
          unlistenTauri = await win.onResized(async () => {
            if (disposed) return;
            try {
              applyFullscreen(await win.isFullscreen());
            } catch {
              /* window state unavailable mid-resize */
            }
          });
        }
        try {
          applyFullscreen(await win.isFullscreen());
        } catch {
          /* keep browser-derived value */
        }
      } catch {
        /* 非 Tauri / 单测环境：保留浏览器 fullscreenchange 降级 */
      }
    })();

    return () => {
      disposed = true;
      document.removeEventListener(
        'fullscreenchange',
        onBrowserFullscreenChange
      );
      try {
        unlistenTauri?.();
      } catch {
        /* unlisten best-effort */
      }
    };
  }, []);

  // 7. App mode attribute
  useEffect(() => {
    const mode = isDemoModeFast() ? 'demo' : 'normal';
    document.body.setAttribute('data-app-mode', mode);
    document.documentElement.setAttribute('data-app-mode', mode);
  }, []);

  // 8. Telemetry subscription
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

  // 9. Pick workspace UI event listener
  useEffect(() => {
    return onUiEvent('pick-workspace', () => {
      void pickWorkspaceFolder();
    });
  }, []);
}
