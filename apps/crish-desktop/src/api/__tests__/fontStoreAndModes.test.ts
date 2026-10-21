// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyFontStacks,
  bootstrapFonts,
  DEFAULT_FONT_PREFS,
  describeActiveMono,
  describeActiveUi,
  loadStoredFonts,
  normalizeFontPrefs,
  persistFonts,
  readStoredFonts,
  setFontPreferences,
} from '../fontStore';
import {
  canUseDemoMode,
  getAppMode,
  isDemoMode,
  loadAppMode,
  setAppMode,
  switchAppMode,
} from '../appMode';
import {
  isDeveloperEngineUiEnabled,
  isProductShell,
  loadProductModePreferences,
  setDeveloperEngineUiEnabled,
  setProductShell,
} from '../productMode';
import { preferencesClient } from '../preferences/preferencesClient';

describe('fontStore - preferencesClient 集成与偏好读写', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizeFontPrefs 返回合规的字体偏好对象', () => {
    const res = normalizeFontPrefs({
      uiFont: 'system-ui',
      monoFont: 'system-mono',
      monoLigatures: true,
    });
    expect(res).toEqual({
      uiFont: 'system-ui',
      monoFont: 'system-mono',
      monoLigatures: true,
      v: 1,
    });
  });

  it('normalizeFontPrefs 在遇到非法值时回退默认配置', () => {
    const res = normalizeFontPrefs(null);
    expect(res).toEqual(DEFAULT_FONT_PREFS);
  });

  it('persistFonts 通过 preferencesClient.setPreference 持久化字体偏好', async () => {
    const setPrefSpy = vi
      .spyOn(preferencesClient, 'setPreference')
      .mockResolvedValue(undefined);

    persistFonts({
      uiFont: 'inter',
      monoFont: 'jetbrains-mono',
      monoLigatures: true,
      v: 1,
    });

    expect(readStoredFonts()).toEqual({
      uiFont: 'inter',
      monoFont: 'jetbrains-mono',
      monoLigatures: true,
      v: 1,
    });
    expect(setPrefSpy).toHaveBeenCalledWith('fonts', {
      uiFont: 'inter',
      monoFont: 'jetbrains-mono',
      monoLigatures: true,
      v: 1,
    });
  });

  it('loadStoredFonts 通过 preferencesClient.getPreference 异步加载字体偏好', async () => {
    vi.spyOn(preferencesClient, 'getPreference').mockResolvedValue({
      uiFont: 'ibm-plex-sans',
      monoFont: 'ibm-plex-mono',
      monoLigatures: false,
      v: 1,
    });

    const loaded = await loadStoredFonts();
    expect(loaded.uiFont).toBe('ibm-plex-sans');
    expect(loaded.monoFont).toBe('ibm-plex-mono');
    expect(readStoredFonts()).toEqual(loaded);
  });

  it('setFontPreferences 更新样式并持久化', async () => {
    const setPrefSpy = vi
      .spyOn(preferencesClient, 'setPreference')
      .mockResolvedValue(undefined);

    const result = await setFontPreferences({
      uiFont: 'system-ui',
      monoLigatures: true,
    });

    expect(result.uiFont).toBe('system-ui');
    expect(result.monoLigatures).toBe(true);
    expect(setPrefSpy).toHaveBeenCalledWith(
      'fonts',
      expect.objectContaining({
        uiFont: 'system-ui',
        monoLigatures: true,
      })
    );
  });

  it('bootstrapFonts 同步应用当前偏好并启动异步补载', () => {
    const loaded = bootstrapFonts();
    expect(loaded).toBeDefined();
    expect(
      document.documentElement.style.getPropertyValue('--user-font-sans')
    ).toBeTruthy();
  });

  it('describeActiveUi 与 describeActiveMono 返回描述文案', () => {
    const uiDesc = describeActiveUi({
      uiFont: 'system-ui',
      monoFont: 'system-mono',
      monoLigatures: false,
      v: 1,
    });
    const monoDesc = describeActiveMono({
      uiFont: 'system-ui',
      monoFont: 'system-mono',
      monoLigatures: false,
      v: 1,
    });
    expect(uiDesc).toBe('system-ui');
    expect(monoDesc).toBe('系统等宽');
  });
});

describe('appMode - preferencesClient 集成与运行模式控制', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('isDemoMode 始终返回 false', () => {
    expect(isDemoMode()).toBe(false);
  });

  it('canUseDemoMode 在非生产环境正常生效', () => {
    expect(typeof canUseDemoMode()).toBe('boolean');
  });

  it('setAppMode 通过 preferencesClient.setPreference 保存 app_mode', () => {
    const setPrefSpy = vi
      .spyOn(preferencesClient, 'setPreference')
      .mockResolvedValue(undefined);

    setAppMode('demo');
    if (canUseDemoMode()) {
      expect(getAppMode()).toBe('demo');
      expect(setPrefSpy).toHaveBeenCalledWith('app_mode', 'demo');
    }
  });

  it('loadAppMode 从 preferencesClient 加载模式配置', async () => {
    vi.spyOn(preferencesClient, 'getPreference').mockResolvedValue('demo');

    const mode = await loadAppMode();
    if (canUseDemoMode()) {
      expect(mode).toBe('demo');
      expect(getAppMode()).toBe('demo');
    }
  });

  it('switchAppMode 触发 setAppMode 并刷新页面', () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload: reloadMock, hostname: 'localhost' },
    });
    const setPrefSpy = vi
      .spyOn(preferencesClient, 'setPreference')
      .mockResolvedValue(undefined);

    switchAppMode('normal');
    expect(getAppMode()).toBe('normal');
  });
});

describe('productMode - preferencesClient 集成与产品壳层判定', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('setProductShell 通过 preferencesClient 持久化 product_shell 偏好', () => {
    const setPrefSpy = vi
      .spyOn(preferencesClient, 'setPreference')
      .mockResolvedValue(undefined);

    setProductShell(true);
    expect(isProductShell()).toBe(true);
    expect(setPrefSpy).toHaveBeenCalledWith('product_shell', true);
  });

  it('setDeveloperEngineUiEnabled 通过 preferencesClient 持久化 show_engine_settings 偏好', () => {
    const setPrefSpy = vi
      .spyOn(preferencesClient, 'setPreference')
      .mockResolvedValue(undefined);

    setDeveloperEngineUiEnabled(true);
    expect(isDeveloperEngineUiEnabled()).toBe(true);
    expect(setPrefSpy).toHaveBeenCalledWith('show_engine_settings', true);
  });

  it('loadProductModePreferences 从 preferencesClient 加载偏好', async () => {
    vi.spyOn(preferencesClient, 'getPreference').mockImplementation(
      async (key: string) => {
        if (key === 'product_shell') return true as any;
        if (key === 'show_engine_settings') return true as any;
        return false as any;
      }
    );

    await loadProductModePreferences();
    expect(isProductShell()).toBe(true);
    expect(isDeveloperEngineUiEnabled()).toBe(true);
  });
});
