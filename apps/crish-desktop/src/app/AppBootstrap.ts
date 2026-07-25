import { useEffect, useLayoutEffect } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import { bootstrapStores } from '../store/bootstrapStores';
import { bootstrapServices } from '../bootstrap-services';
import { emitUiEvent, onUiEvent } from '../api/uiEvents';
import { syncTelemetryData } from '../api/storeAccess';
import { telemetry } from '../services/TelemetryService';
import { isDemoModeFast } from '../createSsrGlobals';

type CrishWindow = Window & { AUTO_FOLD_DELAY?: number };

const APP_DOCUMENT_TITLE = 'Crish · AI 工作台';

export function useAppBootstrap(uiSize: string, shellChromeMode: string, setAppSettings: (s: any) => void, setShowCrashPrompt: (v: boolean) => void, pickWorkspaceFolder: () => Promise<void>) {
  useEffect(() => {
    import('../store/layoutStore').then(({ initLayoutStorePersistence }) => initLayoutStorePersistence());
  }, []);

  useEffect(() => {
    const cleanup = bootstrapServices();
    return () => { cleanup(); };
  }, []);

  useEffect(() => {
    if (telemetry.hasPreviousCrash()) {
      setShowCrashPrompt(true);
    }
  }, []);

  useEffect(() => {
    const cleanup = bootstrapStores();
    return () => cleanup();
  }, []);

  useLayoutEffect(() => {
    const rebind = () => {
      try {
        import('../api/projectStore').then(({ listProjects, rebindSessionFoldersToProjects, rememberProjectFolderAlias }) => {
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
    let raf1: number | null = null;
    let raf2: number | null = null;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => { rebind(); });
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

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void import('../api/workspaceLayoutStore').then(({ initWorkspaceLayoutSync }) => {
      if (cancelled) return;
      cleanup = initWorkspaceLayoutSync({ onRestored: () => {} });
    });
    return () => { cancelled = true; cleanup?.(); };
  }, []);

  useEffect(() => {
    void import('../api/themeStore').then(({ bootstrapTheme }) => bootstrapTheme());
    void import('../api/fontStore').then(({ bootstrapFonts }) => bootstrapFonts());
    const initApp = async () => {
      try {
        const { clientApi } = await import('../api/clientApi');
        const settings = await clientApi.getSettings();
        if (settings) {
          setAppSettings(settings);
          if (settings.theme) {
            const { applyTheme, persistTheme, normalizeTheme } = await import('../api/themeStore');
            const t = normalizeTheme(settings.theme);
            applyTheme(t);
            persistTheme(t);
          }
          if (settings.fonts) {
            const { setFontPreferences, normalizeFontPrefs } = await import('../api/fontStore');
            await setFontPreferences(normalizeFontPrefs(settings.fonts));
          }
          if (typeof settings.tabModeEnabled === 'boolean') {
            useLayoutStore.getState().setTabModeEnabled(settings.tabModeEnabled);
          } else {
            useLayoutStore.getState().setTabModeEnabled(true);
          }
        }
      } catch (err) {
        console.error('Failed to load settings or providers on startup', err);
      }
    };
    initApp();
    return () => {
      import('../api/themeStore').then(({ disposeSolarTimer }) => disposeSolarTimer());
    };
  }, []);

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
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      document.body.classList.add('window-resizing');
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { document.body.classList.remove('window-resizing'); }, 100);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, []);

  useEffect(() => {
    return () => {
      /* hover timeout cleanup handled inline in App.tsx */
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-ui-size', uiSize);
    const density = uiSize === 'small' ? 'compact' : uiSize === 'large' ? 'comfortable' : 'default';
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
    const unsubPromise = import('../api/clientApi').then(({ clientApi }) =>
      clientApi.subscribeTelemetry((data) => { syncTelemetryData(data); })
    );
    return () => { unsubPromise.then((unsub) => unsub()); };
  }, []);

  useEffect(() => {
    return onUiEvent('pick-workspace', () => { void pickWorkspaceFolder(); });
  }, []);
}
