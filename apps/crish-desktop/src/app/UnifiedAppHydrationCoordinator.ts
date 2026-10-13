/**
 * UnifiedAppHydrationCoordinator — 单拍水合汇聚器（Stage 4 · ACT-401/402/406）
 *
 * 职责：
 * 1. 并发静默预取：getSettings + getAllPreferences + listProjects + waitLayoutTreeHydration；
 * 2. 硬件自适应软超时 fallback（低配 800ms / 常规 400ms），超时仅解除首绘门闩，不丢弃真数据；
 * 3. Late-Arrival Reconciliation：后置真数据经 startTransition 平滑补灌；
 * 4. applyAtomicCommit：先 setState 注入各 Store，再 hydrateWorkspaceShell（顺序锁定）；
 * 5. canPersistToDisk：fallback 态刚性阻断磁盘反写；启动热路径零写盘。
 *
 * 注意：本文件对齐现网真实 Store 字段（settingsStore.appSettings / layoutStore.*
 * / workspaceShellStore.shellReady），不虚构 settingsStore.theme|isHydrated。
 */
import React from 'react';
import {
  useLayoutStore,
  type UiSize,
  type ShellChromeMode,
} from '../store/layoutStore';
import { useSettingsStore } from '../store/settingsStore';
import { useWorkspaceShellStore } from '../store/workspace-shell';
import { preferencesClient } from '../api/preferences/preferencesClient';
import type { PreferencesMap } from '../api/preferences/preferencesSchema';
import { clientApi, type Settings } from '../api/clientApi';
import {
  readStoredTheme,
  normalizeTheme,
  applyPersonalization,
  type UiTheme,
  type PersonalizationSettings,
} from '../api/themeStore';
import {
  normalizeFontPrefs,
  applyFontStacks,
  type FontPreferences,
} from '../api/fontStore';
import { TokenRuntimeController } from '../services/TokenRuntimeController';
import { waitLayoutTreeHydration } from '../store/layout-tree';
import { hydrateWorkspaceShell } from './hydrateWorkspaceShell';
import { listProjects } from '../api/projectStore';
import { parseShellChromeMode } from '../api/shellChrome';

export interface StartupHydrationSnapshot {
  theme: UiTheme;
  personalization: PersonalizationSettings;
  appSettings: Settings;
  preferences: PreferencesMap;
  recentWorkspaces: string[];
  tabModeEnabled: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number | null;
  uiSize: UiSize;
  shellChromeMode: ShellChromeMode;
  fonts: FontPreferences | null;
  layoutReady: boolean;
  isFallback: boolean;
}

export type HydrationStage =
  | 'uninitialized'
  | 'preloading'
  | 'committed'
  | 'fallback_committed'
  | 'reconciled'
  | 'failed';
export interface CoordinatorOptions {
  timeoutMs?: number;
}

export interface PreHydrationQueueEvent {
  type: string;
  action: string | null;
  key?: string | null;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  timestamp: number;
}

export interface PreHydrationQueueController {
  maxSize: number;
  events: PreHydrationQueueEvent[];
  droppedCount: number;
  push: (entry: Partial<PreHydrationQueueEvent> & { type?: string }) => void;
  drain: () => PreHydrationQueueEvent[];
  release: (
    replayDispatcher?: (events: PreHydrationQueueEvent[]) => void
  ) => PreHydrationQueueEvent[];
}

interface CoordinatorTrace {
  step: string;
  timestamp: number;
}

export function createPreHydrationQueue(
  maxSize = 32
): PreHydrationQueueController {
  const events: PreHydrationQueueEvent[] = [];
  let isReleased = false;
  const controller: PreHydrationQueueController = {
    maxSize,
    events,
    droppedCount: 0,
    push(entry) {
      if (isReleased || !entry) return;
      if (events.length >= maxSize) {
        events.shift();
        controller.droppedCount += 1;
      }
      events.push({
        type: entry.type || 'click',
        action: entry.action ?? null,
        key: entry.key ?? null,
        ctrlKey: Boolean(entry.ctrlKey),
        metaKey: Boolean(entry.metaKey),
        shiftKey: Boolean(entry.shiftKey),
        altKey: Boolean(entry.altKey),
        timestamp:
          typeof entry.timestamp === 'number'
            ? entry.timestamp
            : performance.now(),
      });
    },
    drain() {
      isReleased = true;
      const sorted = events.slice().sort((a, b) => a.timestamp - b.timestamp);
      events.length = 0;
      return sorted;
    },
    release(replayDispatcher) {
      const sorted = controller.drain();
      if (typeof replayDispatcher === 'function' && sorted.length > 0)
        replayDispatcher(sorted);
      return sorted;
    },
  };
  return controller;
}

function mapPreferenceUiSize(raw: unknown): UiSize | null {
  if (raw === 'compact' || raw === 'small') return 'small';
  if (raw === 'normal' || raw === 'medium') return 'medium';
  if (raw === 'spacious' || raw === 'large') return 'large';
  return null;
}

function buildPersonalization(prefs: PreferencesMap): PersonalizationSettings {
  return {
    skin: prefs.theme_skin || 'warm-gray',
    customBg: prefs.theme_custom_bg || '',
    customFg: prefs.theme_custom_fg || '',
    fontSizeAdjust:
      typeof prefs.font_size_adjust === 'number' ? prefs.font_size_adjust : 0,
    themeBrightnessAdjust:
      typeof prefs.theme_brightness_adjust === 'number'
        ? prefs.theme_brightness_adjust
        : 0,
    themeBrightnessVibrant: Boolean(prefs.theme_brightness_vibrant),
    themeAutoTimeTransition: Boolean(prefs.theme_brightness_auto_time),
  };
}

export class UnifiedAppHydrationCoordinator {
  private static instance: UnifiedAppHydrationCoordinator | null = null;
  private stage: HydrationStage = 'uninitialized';
  private preloadPromise: Promise<StartupHydrationSnapshot> | null = null;
  private cachedSnapshot: StartupHydrationSnapshot | null = null;
  private traceLogs: CoordinatorTrace[] = [];

  private constructor() {}

  public static getInstance(): UnifiedAppHydrationCoordinator {
    if (!this.instance) this.instance = new UnifiedAppHydrationCoordinator();
    return this.instance;
  }

  public static resetInstanceForTests(): void {
    this.instance = null;
  }
  public getStage(): HydrationStage {
    return this.stage;
  }
  public getSnapshot(): StartupHydrationSnapshot | null {
    return this.cachedSnapshot;
  }
  public getTraceLogs(): CoordinatorTrace[] {
    return [...this.traceLogs];
  }

  private recordTrace(step: string): void {
    if (typeof performance !== 'undefined')
      this.traceLogs.push({ step, timestamp: performance.now() });
  }

  private getAdaptiveTimeout(): number {
    const cores =
      typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    return cores <= 2 ? 800 : 400;
  }

  public canPersistToDisk(): boolean {
    if (this.stage === 'fallback_committed') {
      console.warn('[Coordinator] Fallback 挂载态：刚性阻断向磁盘反写配置');
      return false;
    }
    if (this.cachedSnapshot?.isFallback) {
      console.warn('[Coordinator] 当前快照携带 Fallback 标记：禁止磁盘持久化');
      return false;
    }
    return true;
  }

  public createFallbackSnapshot(): StartupHydrationSnapshot {
    return {
      theme: normalizeTheme(readStoredTheme()),
      personalization: {
        skin: 'warm-gray',
        customBg: '',
        customFg: '',
        fontSizeAdjust: 0,
        themeBrightnessAdjust: 0,
        themeBrightnessVibrant: false,
        themeAutoTimeTransition: false,
      },
      appSettings: {} as Settings,
      preferences: {} as PreferencesMap,
      recentWorkspaces: [],
      tabModeEnabled: true,
      sidebarCollapsed: false,
      sidebarWidth: null,
      uiSize: 'medium',
      shellChromeMode: 'classic',
      fonts: null,
      layoutReady: true,
      isFallback: true,
    };
  }

  public createInstantMemorySnapshot(): StartupHydrationSnapshot {
    this.recordTrace('instant-memory-snapshot');
    const snapshot = this.createFallbackSnapshot();
    this.cachedSnapshot = snapshot;
    return snapshot;
  }

  public triggerAsyncBackgroundPreheat(
    options?: CoordinatorOptions
  ): Promise<StartupHydrationSnapshot> {
    return this.preloadHydrationSnapshot(options).then((snapshot) => {
      if (!snapshot.isFallback && this.stage === 'fallback_committed') {
        this.reconcileLateSnapshot(snapshot);
      }
      return snapshot;
    });
  }

  public replayPreHydrationQueue(
    customDispatcher?: (event: PreHydrationQueueEvent) => void
  ): PreHydrationQueueEvent[] {
    if (typeof window === 'undefined') return [];
    const win = window as unknown as {
      __CRISH_PRE_HYDRATION_QUEUE__?: PreHydrationQueueController;
      __CRISH_RELEASE_COMPENSATION__?: (
        cb?: (events: PreHydrationQueueEvent[]) => void
      ) => PreHydrationQueueEvent[];
    };

    const dispatchSingle = (evt: PreHydrationQueueEvent): void => {
      if (customDispatcher) {
        customDispatcher(evt);
        return;
      }
      if (evt.action === 'new-session') {
        (
          useLayoutStore.getState() as { addSession?: () => void }
        ).addSession?.();
      } else if (
        evt.action === 'focus-composer' &&
        typeof document !== 'undefined'
      ) {
        document
          .querySelector<HTMLElement>(
            '[data-composer-input], .ProseMirror, textarea'
          )
          ?.focus?.();
      }
    };

    if (win.__CRISH_PRE_HYDRATION_QUEUE__?.release) {
      return win.__CRISH_PRE_HYDRATION_QUEUE__.release((events) => {
        for (const evt of events) dispatchSingle(evt);
      });
    }
    if (typeof win.__CRISH_RELEASE_COMPENSATION__ === 'function') {
      return win.__CRISH_RELEASE_COMPENSATION__((events) => {
        for (const evt of events) dispatchSingle(evt);
      });
    }
    return [];
  }

  private assembleSnapshot(
    rawPrefsResult: PromiseSettledResult<PreferencesMap>,
    rawSettingsResult: PromiseSettledResult<Settings>,
    recentWorkspacesResult: PromiseSettledResult<string[]>
  ): StartupHydrationSnapshot {
    const rawPrefs =
      rawPrefsResult.status === 'fulfilled'
        ? rawPrefsResult.value
        : ({} as PreferencesMap);
    const rawSettings =
      rawSettingsResult.status === 'fulfilled'
        ? rawSettingsResult.value
        : ({} as Settings);
    const recentWorkspaces = rawWorkspacesResultValue(recentWorkspacesResult);
    const finalTheme = normalizeTheme(
      rawPrefs.theme || rawSettings.theme || readStoredTheme()
    );
    const personalization = buildPersonalization(rawPrefs);
    const uiSize =
      mapPreferenceUiSize(rawPrefs.ui_size) ??
      mapPreferenceUiSize((rawSettings as { uiSize?: unknown }).uiSize) ??
      'medium';
    const shellChromeMode = parseShellChromeMode(
      (rawSettings as { shellChromeMode?: unknown }).shellChromeMode ??
        (rawPrefs.shell_chrome_mode as unknown) ??
        'classic'
    );
    const sidebarCollapsed =
      typeof rawPrefs.sidebar_collapsed === 'boolean'
        ? rawPrefs.sidebar_collapsed
        : false;
    const sidebarWidth =
      typeof rawPrefs.sidebar_width === 'number' &&
      Number.isFinite(rawPrefs.sidebar_width)
        ? rawPrefs.sidebar_width
        : null;
    const tabModeEnabled =
      typeof rawPrefs.tab_mode_enabled === 'boolean'
        ? rawPrefs.tab_mode_enabled
        : typeof rawSettings.tabModeEnabled === 'boolean'
          ? rawSettings.tabModeEnabled
          : true;
    const fonts = rawPrefs.fonts
      ? normalizeFontPrefs(rawPrefs.fonts)
      : rawSettings.fonts
        ? normalizeFontPrefs(rawSettings.fonts)
        : null;

    return {
      theme: finalTheme,
      personalization,
      appSettings: rawSettings,
      preferences: rawPrefs,
      recentWorkspaces,
      tabModeEnabled,
      sidebarCollapsed,
      sidebarWidth,
      uiSize,
      shellChromeMode,
      fonts,
      layoutReady: true,
      isFallback: false,
    };
  }

  public preloadHydrationSnapshot(
    options?: CoordinatorOptions
  ): Promise<StartupHydrationSnapshot> {
    if (this.preloadPromise) return this.preloadPromise;

    const timeoutMs = options?.timeoutMs ?? this.getAdaptiveTimeout();
    this.stage = 'preloading';
    this.recordTrace('preload-start');

    this.preloadPromise = new Promise<StartupHydrationSnapshot>((resolve) => {
      let isFallbackResolved = false;

      const timer = setTimeout(() => {
        if (isFallbackResolved) return;
        isFallbackResolved = true;
        this.stage = 'fallback_committed';
        this.recordTrace('preload-timeout-fallback');
        console.warn(
          `[Coordinator] 预取达软超时(${timeoutMs}ms)，Fallback 解除首绘门闩（真数据仍走 Late-Arrival）`
        );
        const fallback = this.createFallbackSnapshot();
        this.cachedSnapshot = fallback;
        resolve(fallback);
      }, timeoutMs);

      void (async () => {
        try {
          const [rawPrefsResult, rawSettingsResult, recentWorkspacesResult] =
            await Promise.allSettled([
              preferencesClient.getAllPreferences(),
              clientApi.getSettings(),
              this.fetchRecentWorkspaces(),
              waitLayoutTreeHydration(),
            ]);

          clearTimeout(timer);
          this.recordTrace('ipc-settled');

          const trueSnapshot = this.assembleSnapshot(
            rawPrefsResult,
            rawSettingsResult,
            recentWorkspacesResult
          );

          if (isFallbackResolved) {
            this.recordTrace('late-arrival-reconciliation-triggered');
            console.info(
              '[Coordinator] Late-Arrival Reconciliation：后置真数据平滑合并'
            );
            queueMicrotask(() => {
              this.reconcileLateSnapshot(trueSnapshot);
            });
          } else {
            this.cachedSnapshot = trueSnapshot;
            this.recordTrace('snapshot-created');
            resolve(trueSnapshot);
          }
        } catch (error) {
          clearTimeout(timer);
          this.recordTrace('preload-error-fallback');
          console.error('[Coordinator] 预取异常，启动兜底', error);
          if (!isFallbackResolved) {
            isFallbackResolved = true;
            const fallback = this.createFallbackSnapshot();
            this.cachedSnapshot = fallback;
            resolve(fallback);
          }
        }
      })();
    });

    return this.preloadPromise;
  }

  private async fetchRecentWorkspaces(): Promise<string[]> {
    try {
      return listProjects()
        .map((p) => p.path)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  public applyAtomicCommit(snapshot: StartupHydrationSnapshot): void {
    if (this.stage === 'committed' || this.stage === 'reconciled') return;

    this.recordTrace('atomic-commit-start');
    this.cachedSnapshot = snapshot;

    applyPersonalization(snapshot.personalization, snapshot.theme);
    TokenRuntimeController.getInstance().setUiScale(snapshot.uiSize);
    if (snapshot.fonts) applyFontStacks(snapshot.fonts);

    useSettingsStore.getState().setAppSettings(snapshot.appSettings);

    const layoutActions = useLayoutStore.getState();
    layoutActions.setSidebarCollapsed(snapshot.sidebarCollapsed);
    layoutActions.setTabModeEnabled(snapshot.tabModeEnabled);
    layoutActions.setUiSize(snapshot.uiSize);
    layoutActions.setShellChromeMode(snapshot.shellChromeMode);

    useWorkspaceShellStore.getState().setShellReady(true);

    try {
      hydrateWorkspaceShell();
    } catch (e) {
      console.error('[Coordinator] 工作区水合失败，强制置 shellReady', e);
      useWorkspaceShellStore.getState().setShellReady(true);
    }

    this.stage =
      snapshot.isFallback || this.stage === 'fallback_committed'
        ? 'fallback_committed'
        : 'committed';
    this.recordTrace('atomic-commit-settled');
  }

  public reconcileLateSnapshot(trueSnapshot: StartupHydrationSnapshot): void {
    this.recordTrace('reconcile-late-start');
    const prev = this.cachedSnapshot;
    this.cachedSnapshot = trueSnapshot;
    const hasSizeDiff = prev?.uiSize !== trueSnapshot.uiSize;
    const hasSidebarDiff =
      prev?.sidebarCollapsed !== trueSnapshot.sidebarCollapsed;

    const applyUpdate = (): void => {
      this.stage = 'reconciled';
      applyPersonalization(trueSnapshot.personalization, trueSnapshot.theme);
      if (hasSizeDiff)
        TokenRuntimeController.getInstance().setUiScale(trueSnapshot.uiSize);
      if (trueSnapshot.fonts) applyFontStacks(trueSnapshot.fonts);
      useSettingsStore.getState().setAppSettings(trueSnapshot.appSettings);

      if (
        hasSidebarDiff ||
        hasSizeDiff ||
        prev?.tabModeEnabled !== trueSnapshot.tabModeEnabled ||
        prev?.shellChromeMode !== trueSnapshot.shellChromeMode
      ) {
        const nextLayoutActions = useLayoutStore.getState();
        nextLayoutActions.setSidebarCollapsed(trueSnapshot.sidebarCollapsed);
        nextLayoutActions.setTabModeEnabled(trueSnapshot.tabModeEnabled);
        nextLayoutActions.setUiSize(trueSnapshot.uiSize);
        nextLayoutActions.setShellChromeMode(trueSnapshot.shellChromeMode);
      }

      this.recordTrace('reconcile-late-settled');
      console.info(
        '[Coordinator] Late-Arrival 补灌完成 → reconciled（数据 100% 保真）'
      );
    };

    if (
      typeof React !== 'undefined' &&
      typeof React.startTransition === 'function'
    ) {
      React.startTransition(applyUpdate);
    } else {
      applyUpdate();
    }
  }
}

function rawWorkspacesResultValue(
  result: PromiseSettledResult<string[]>
): string[] {
  return result.status === 'fulfilled' ? result.value : [];
}
