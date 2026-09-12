// @vitest-environment jsdom
/**
 * UnifiedAppHydrationCoordinator 单测
 * 锁定：commit 顺序（setState 先于 hydrateShell）、Late-Arrival、canPersistToDisk 闸。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnifiedAppHydrationCoordinator } from '../UnifiedAppHydrationCoordinator';
import { useSettingsStore } from '../../store/settingsStore';
import { useLayoutStore } from '../../store/layoutStore';
import { useWorkspaceShellStore } from '../../store/workspace-shell';

vi.mock('../hydrateWorkspaceShell', () => ({
  hydrateWorkspaceShell: vi.fn(),
}));

vi.mock('../../api/preferences/preferencesClient', () => ({
  preferencesClient: {
    getAllPreferences: vi.fn(async () => ({
      theme: 'dark',
      theme_skin: 'warm-gray',
      theme_custom_bg: '',
      theme_custom_fg: '',
      font_size_adjust: 0,
      theme_brightness_adjust: 0,
      theme_brightness_vibrant: false,
      theme_brightness_auto_time: false,
      ui_size: 'spacious',
      shell_chrome_mode: 'frameless',
      sidebar_collapsed: true,
      sidebar_width: 280,
      tab_mode_enabled: true,
      files_list_ratio: 0.35,
      file_viewer_word_wrap: true,
      fonts: { uiFont: 'inter', monoFont: 'jetbrains-mono', monoLigatures: true, v: 1 },
      app_mode: 'normal',
      product_shell: false,
      show_engine_settings: false,
    })),
  },
}));

vi.mock('../../api/clientApi', () => ({
  clientApi: {
    getSettings: vi.fn(async () => ({
      theme: 'dark',
      tabModeEnabled: true,
      shellChromeMode: 'classic',
    })),
  },
}));

vi.mock('../../api/projectStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/projectStore')>();
  return {
    ...actual,
    listProjects: vi.fn(() => [
      { id: 'p1', path: 'C:/work/a' },
      { id: 'p2', path: 'C:/work/b' },
    ]),
  };
});

vi.mock('../../store/layout-tree', () => ({
  waitLayoutTreeHydration: vi.fn(async () => undefined),
}));

vi.mock('../../api/themeStore', () => ({
  readStoredTheme: () => 'dark',
  normalizeTheme: (raw: unknown) => (raw === 'dark' ? 'dark' : 'default'),
  applyPersonalization: vi.fn(),
}));

vi.mock('../../api/fontStore', () => ({
  normalizeFontPrefs: (raw: unknown) => raw,
  applyFontStacks: vi.fn(),
}));

vi.mock('../../services/TokenRuntimeController', () => ({
  TokenRuntimeController: {
    getInstance: () => ({
      applyTokens: vi.fn(),
      setUiScale: vi.fn(),
    }),
  },
}));

const { hydrateWorkspaceShell } = await import('../hydrateWorkspaceShell');

function resetStores() {
  useSettingsStore.setState({ appSettings: null });
  useLayoutStore.setState({
    sidebarCollapsed: false,
    tabModeEnabled: false,
    uiSize: 'medium',
    shellChromeMode: 'classic',
  });
  useWorkspaceShellStore.setState({ shellReady: false });
}

describe('UnifiedAppHydrationCoordinator', () => {
  beforeEach(() => {
    UnifiedAppHydrationCoordinator.resetInstanceForTests();
    vi.clearAllMocks();
    resetStores();
  });

  it('applyAtomicCommit：先 setState 再 hydrateWorkspaceShell（顺序锁定）', () => {
    let settingsAtHydrate: unknown = null;
    let layoutAtHydrate: { sidebarCollapsed: boolean; uiSize: string } | null =
      null;
    (hydrateWorkspaceShell as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        settingsAtHydrate = useSettingsStore.getState().appSettings;
        layoutAtHydrate = {
          sidebarCollapsed: useLayoutStore.getState().sidebarCollapsed,
          uiSize: useLayoutStore.getState().uiSize,
        };
      }
    );

    const coordinator = UnifiedAppHydrationCoordinator.getInstance();
    coordinator.applyAtomicCommit({
      ...coordinator.createFallbackSnapshot(),
      isFallback: false,
      appSettings: { theme: 'dark' } as never,
      sidebarCollapsed: true,
      uiSize: 'large',
    });

    // hydrate 执行瞬间，Store 必须已持有本次快照写入的值
    expect(settingsAtHydrate).toMatchObject({ theme: 'dark' });
    expect(layoutAtHydrate).toEqual({
      sidebarCollapsed: true,
      uiSize: 'large',
    });
    expect(coordinator.getStage()).toBe('committed');
    expect(useWorkspaceShellStore.getState().shellReady).toBe(true);
  });

  it('applyAtomicCommit 注入真快照：layout 与 settings 均收到值', () => {
    const coordinator = UnifiedAppHydrationCoordinator.getInstance();
    const base = coordinator.createFallbackSnapshot();
    const snapshot = {
      ...base,
      isFallback: false,
      appSettings: { theme: 'dark', tabModeEnabled: false } as never,
      sidebarCollapsed: true,
      uiSize: 'large' as const,
      tabModeEnabled: false,
    };
    coordinator.applyAtomicCommit(snapshot);

    expect(coordinator.getStage()).toBe('committed');
    expect(useSettingsStore.getState().appSettings).toMatchObject({
      theme: 'dark',
    });
    expect(useLayoutStore.getState().sidebarCollapsed).toBe(true);
    expect(useLayoutStore.getState().uiSize).toBe('large');
    expect(coordinator.canPersistToDisk()).toBe(true);
  });

  it('fallback 态 canPersistToDisk=false；reconcile 后放行且数据保真', () => {
    const coordinator = UnifiedAppHydrationCoordinator.getInstance();
    const fallback = coordinator.createFallbackSnapshot();
    coordinator.applyAtomicCommit(fallback);
    expect(coordinator.getStage()).toBe('fallback_committed');
    expect(coordinator.canPersistToDisk()).toBe(false);

    const trueSnapshot = {
      ...fallback,
      theme: 'dark' as const,
      uiSize: 'large' as const,
      sidebarCollapsed: true,
      isFallback: false,
    };
    coordinator.reconcileLateSnapshot(trueSnapshot);

    expect(coordinator.getStage()).toBe('reconciled');
    expect(coordinator.getSnapshot()?.uiSize).toBe('large');
    expect(coordinator.getSnapshot()?.isFallback).toBe(false);
    expect(coordinator.canPersistToDisk()).toBe(true);
  });

  it('二次 applyAtomicCommit 幂等（已 committed 不再重入）', () => {
    const coordinator = UnifiedAppHydrationCoordinator.getInstance();
    const snapshot = {
      ...coordinator.createFallbackSnapshot(),
      isFallback: false,
    };
    coordinator.applyAtomicCommit(snapshot);
    expect(coordinator.getStage()).toBe('committed');

    (hydrateWorkspaceShell as ReturnType<typeof vi.fn>).mockClear();
    coordinator.applyAtomicCommit(snapshot);
    expect(hydrateWorkspaceShell).not.toHaveBeenCalled();
  });

  it('preloadHydrationSnapshot：正常路径组装真快照并缓存', async () => {
    const coordinator = UnifiedAppHydrationCoordinator.getInstance();
    const snapshot = await coordinator.preloadHydrationSnapshot({
      timeoutMs: 5_000,
    });

    expect(snapshot.isFallback).toBe(false);
    expect(snapshot.theme).toBe('dark');
    expect(snapshot.sidebarCollapsed).toBe(true);
    expect(snapshot.uiSize).toBe('large');
    expect(snapshot.recentWorkspaces).toEqual(['C:/work/a', 'C:/work/b']);
    expect(coordinator.getStage()).toBe('preloading');
    expect(coordinator.getSnapshot()).toBe(snapshot);
  });

  it('preload 幂等：二次调用返回同一 promise', async () => {
    const coordinator = UnifiedAppHydrationCoordinator.getInstance();
    const p1 = coordinator.preloadHydrationSnapshot({ timeoutMs: 5_000 });
    const p2 = coordinator.preloadHydrationSnapshot({ timeoutMs: 5_000 });
    expect(p1).toBe(p2);
    await p1;
  });
});
