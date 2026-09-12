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
import { useLayoutStore } from '../store/layoutStore';
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
import type { UiSize, ShellChromeMode } from '../store/layout-helpers/store-types';
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

interface CoordinatorTrace {
  step: string;
  timestamp: number;
}

/** 偏好 ui_size（compact/normal/spacious）→ layoutStore UiSize（small/medium/large） */
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

/**
 * 全局统一应用水合汇聚协调器。
 * 冷启动生命周期内仅一次 preload → 一次原子 Commit；fallback 后允许 Late-Arrival。
 */
export class UnifiedAppHydrationCoordinator {
  private static instance: UnifiedAppHydrationCoordinator | null = null;
  private stage: HydrationStage = 'uninitialized';
  private preloadPromise: Promise<StartupHydrationSnapshot> | null = null;
  private cachedSnapshot: StartupHydrationSnapshot | null = null;
  private traceLogs: CoordinatorTrace[] = [];

  private constructor() {}

  public static getInstance(): UnifiedAppHydrationCoordinator {
    if (!this.instance) {
      this.instance = new UnifiedAppHydrationCoordinator();
    }
    return this.instance;
  }

  /** 测试隔离：重置单例状态（仅单测调用） */
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
    if (typeof performance !== 'undefined') {
      this.traceLogs.push({ step, timestamp: performance.now() });
    }
  }

  /**
   * 硬件自适应软超时：双核及以下 800ms，常规 400ms。
   */
  private getAdaptiveTimeout(): number {
    const cores =
      typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    return cores <= 2 ? 800 : 400;
  }

  /**
   * Fallback 磁盘写入拦截铁闸。
   * fallback_committed 期间严禁将默认配置写盘覆写真实数据。
   */
  public canPersistToDisk(): boolean {
    if (this.stage === 'fallback_committed') {
      console.warn(
        '[Coordinator] Fallback 挂载态：刚性阻断向磁盘反写配置'
      );
      return false;
    }
    if (this.cachedSnapshot?.isFallback) {
      console.warn(
        '[Coordinator] 当前快照携带 Fallback 标记：禁止磁盘持久化'
      );
      return false;
    }
    return true;
  }

  /**
   * 构建安全保底快照（软超时 / 预取异常时使用；isFallback=true）。
   */
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

  private assembleSnapshot(
    rawPrefsResult: PromiseSettledResult<PreferencesMap>,
    rawSettingsResult: PromiseSettledResult<Settings>,
    recentWorkspacesResult: PromiseSettledResult<string[]>
  ): StartupHydrationSnapshot {
    const rawPrefs: PreferencesMap =
      rawPrefsResult.status === 'fulfilled'
        ? rawPrefsResult.value
        : ({} as PreferencesMap);
    const rawSettings: Settings =
      rawSettingsResult.status === 'fulfilled'
        ? rawSettingsResult.value
        : ({} as Settings);
    const recentWorkspaces =
      rawWorkspacesResultValue(recentWorkspacesResult);

    const localStoredTheme = readStoredTheme();
    const themeSource = rawPrefs.theme || rawSettings.theme || localStoredTheme;
    const finalTheme = normalizeTheme(themeSource);

    const personalization = buildPersonalization(rawPrefs);

    const uiSize =
      mapPreferenceUiSize(rawPrefs.ui_size) ??
      (mapPreferenceUiSize((rawSettings as { uiSize?: unknown }).uiSize) ??
        'medium');

    const shellChromeMode = parseShellChromeMode(
      rawSettings.shellChromeMode ??
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

    let fonts: FontPreferences | null = null;
    if (rawPrefs.fonts) {
      fonts = normalizeFontPrefs(rawPrefs.fonts);
    } else if (rawSettings.fonts) {
      fonts = normalizeFontPrefs(rawSettings.fonts);
    }

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

  /**
   * 并发静默预取。超时仅 resolve fallback（绝不丢弃后置真数据）。
   * 非 async：保证二次调用返回同一 Promise 引用（async 会包装新 Promise）。
   */
  public preloadHydrationSnapshot(
    options?: CoordinatorOptions
  ): Promise<StartupHydrationSnapshot> {
    if (this.preloadPromise) {
      return this.preloadPromise;
    }

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
            // ACT-406：后置真数据绝不丢弃，微任务调度 Late-Arrival 补灌
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

  /**
   * 近期工作区路径（现网无 getRecentWorkspaces IPC；以 projectStore.listProjects 为真源）。
   */
  private async fetchRecentWorkspaces(): Promise<string[]> {
    try {
      const projects = listProjects();
      return projects.map((p) => p.path).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * 单拍原子 Commit：先 setState 注入 Store，再 hydrateWorkspaceShell。
   *
   * 顺序锁定（单测断言）：
   * 1. Token/字体/主题内存应用；
   * 2. settingsStore / layoutStore setState；
   * 3. shellReady 预置位；
   * 4. hydrateWorkspaceShell（依赖 step 2 的 getAppSettings）。
   *
   * 启动热路径零磁盘写入（REDLINE-402）：不调用 persistTheme / persistFonts / settings 回写。
   */
  public applyAtomicCommit(snapshot: StartupHydrationSnapshot): void {
    if (this.stage === 'committed' || this.stage === 'reconciled') {
      return;
    }

    this.recordTrace('atomic-commit-start');
    this.cachedSnapshot = snapshot;

    // 1. 主题 + 个性化 Token（纯内存应用）
    applyPersonalization(snapshot.personalization, snapshot.theme);
    TokenRuntimeController.getInstance().setUiScale(snapshot.uiSize);

    // 2. 字体（仅 apply；禁止 persistFonts 写盘）
    if (snapshot.fonts) {
      applyFontStacks(snapshot.fonts);
    }

    // 3. Store 批量注入 —— 必须先于 hydrateWorkspaceShell
    //    （readRestoreLastWorkspace 依赖 layout.getAppSettings 读到本次快照）
    useSettingsStore.setState({ appSettings: snapshot.appSettings });

    useLayoutStore.setState({
      sidebarCollapsed: snapshot.sidebarCollapsed,
      tabModeEnabled: snapshot.tabModeEnabled,
      uiSize: snapshot.uiSize,
      shellChromeMode: snapshot.shellChromeMode,
    });

    // 4. shellReady 预置位（hydrateWorkspaceShell 内部也会 setShellReady）
    useWorkspaceShellStore.getState().setShellReady(true);

    // 5. 全量快照写入完毕后再触发工作区 Shell 水合
    try {
      hydrateWorkspaceShell();
    } catch (e) {
      console.error('[Coordinator] 工作区水合失败，强制置 shellReady', e);
      useWorkspaceShellStore.getState().setShellReady(true);
    }

    // fallback 快照保持 fallback_committed 闸；真数据进入 committed
    if (snapshot.isFallback || this.stage === 'fallback_committed') {
      this.stage = 'fallback_committed';
    } else {
      this.stage = 'committed';
    }
    this.recordTrace('atomic-commit-settled');
  }

  /**
   * Late-Arrival Reconciliation：fallback 首绘后，迟到真数据经 startTransition 补灌。
   * 绝不把 fallback 默认值写盘；canPersistToDisk 闸在切换 reconciled 后对真数据放行。
   */
  public reconcileLateSnapshot(trueSnapshot: StartupHydrationSnapshot): void {
    this.recordTrace('reconcile-late-start');
    const prev = this.cachedSnapshot;
    this.cachedSnapshot = trueSnapshot;

    const hasThemeDiff = prev?.theme !== trueSnapshot.theme;
    const hasSkinDiff =
      prev?.personalization.skin !== trueSnapshot.personalization.skin;
    const hasSizeDiff = prev?.uiSize !== trueSnapshot.uiSize;
    const hasSidebarDiff =
      prev?.sidebarCollapsed !== trueSnapshot.sidebarCollapsed;

    const applyUpdate = (): void => {
      // 真数据就绪后解除 fallback 闸，允许未来用户主动持久化
      this.stage = 'reconciled';

      if (hasThemeDiff || hasSkinDiff) {
        applyPersonalization(trueSnapshot.personalization, trueSnapshot.theme);
      } else {
        applyPersonalization(trueSnapshot.personalization, trueSnapshot.theme);
      }

      if (hasSizeDiff) {
        TokenRuntimeController.getInstance().setUiScale(trueSnapshot.uiSize);
      }

      if (trueSnapshot.fonts) {
        applyFontStacks(trueSnapshot.fonts);
      }

      useSettingsStore.setState({ appSettings: trueSnapshot.appSettings });

      if (
        hasSidebarDiff ||
        hasSizeDiff ||
        prev?.tabModeEnabled !== trueSnapshot.tabModeEnabled ||
        prev?.shellChromeMode !== trueSnapshot.shellChromeMode
      ) {
        useLayoutStore.setState({
          sidebarCollapsed: trueSnapshot.sidebarCollapsed,
          tabModeEnabled: trueSnapshot.tabModeEnabled,
          uiSize: trueSnapshot.uiSize,
          shellChromeMode: trueSnapshot.shellChromeMode,
        });
      }

      this.recordTrace('reconcile-late-settled');
      console.info(
        '[Coordinator] Late-Arrival 补灌完成 → reconciled（数据 100% 保真）'
      );
    };

    if (typeof React !== 'undefined' && typeof React.startTransition === 'function') {
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
