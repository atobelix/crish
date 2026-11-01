// theme.ts 测试：主题投影 / 浅深 token 结构一致 / useTheme 订阅 / 持久化往返。
import { act, renderHook } from '@testing-library/react-native';
import {
  darkTheme,
  lightTheme,
  neutralTheme,
  projectTheme,
  resetThemeModeForTest,
  setThemeMode,
  useTheme,
} from './theme';
import {
  settingsStore,
  configureSettingsPersistence,
  type SettingsPersist,
} from '@/domain/store/settingsStore';

function makeKvPersist(): SettingsPersist & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: jest.fn(async (key: string) => map.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      map.set(key, value);
    }),
    getAll: jest.fn(async () =>
      [...map.entries()].map(([key, value]) => ({ key, value }))
    ),
  };
}

beforeEach(() => {
  resetThemeModeForTest();
  configureSettingsPersistence(null);
});

describe('projectTheme', () => {
  it('system → 透传系统方案', () => {
    expect(projectTheme('system', lightTheme)).toBe(lightTheme);
    expect(projectTheme('system', darkTheme)).toBe(darkTheme);
  });

  it('light/dark → 对应完整主题', () => {
    expect(projectTheme('light', darkTheme)).toBe(lightTheme);
    expect(projectTheme('dark', lightTheme)).toBe(darkTheme);
  });

  it('neutral → 纯净中性灰主题（与系统方案无关，M7 推导档）', () => {
    expect(projectTheme('neutral', lightTheme)).toBe(neutralTheme);
    expect(projectTheme('neutral', darkTheme)).toBe(neutralTheme);
    expect(neutralTheme.dark).toBe(false);
  });

  it('浅深两套颜色键集合一致', () => {
    expect(Object.keys(darkTheme.colors).sort()).toEqual(
      Object.keys(lightTheme.colors).sort()
    );
  });

  it('中性灰与浅色颜色键集合一致（同构全键）', () => {
    expect(Object.keys(neutralTheme.colors).sort()).toEqual(
      Object.keys(lightTheme.colors).sort()
    );
  });
});

describe('useTheme 订阅', () => {
  it('默认 system 档（jest 环境浅色）', async () => {
    const { result } = await renderHook(() => useTheme());
    expect(result.current).toBe(lightTheme);
  });

  it('setThemeMode 切换深色 → 即时投影深色主题', async () => {
    const { result } = await renderHook(() => useTheme());
    expect(result.current).toBe(lightTheme);
    await act(async () => {
      setThemeMode('dark');
    });
    expect(result.current).toBe(darkTheme);
    await act(async () => {
      setThemeMode('light');
    });
    expect(result.current).toBe(lightTheme);
  });

  it('setThemeMode 切换中性灰 → 即时投影中性灰主题', async () => {
    const { result } = await renderHook(() => useTheme());
    await act(async () => {
      setThemeMode('neutral');
    });
    expect(result.current).toBe(neutralTheme);
  });
});

describe('projectTheme 字号 / 等宽变体（W-A）', () => {
  // 字阶基准随原型对齐改 14 中心制（M1,2026-11-01)：乘数机制不变（1 / 1.125 / 1.25)，
  // 基准 body 14/21 → large 15.8/23.6、xlarge 17.5/26.3(scaled 同乘后 0.1 取整）
  it('large：字阶同乘 1.125（body 14→15.8 / 行高 21→23.6）', () => {
    const variant = projectTheme('light', darkTheme, {
      fontScale: 'large',
      monoFont: 'system',
    });
    expect(variant).not.toBe(lightTheme);
    expect(variant.type.body.fontSize).toBe(15.8);
    expect(variant.type.body.lineHeight).toBe(23.6);
    // 色板与几何不随字号变体改变（同一引用）
    expect(variant.colors).toBe(lightTheme.colors);
  });

  it('xlarge：字阶同乘 1.25（body 14→17.5 / 行高 21→26.3）', () => {
    const variant = projectTheme('dark', lightTheme, {
      fontScale: 'xlarge',
      monoFont: 'system',
    });
    expect(variant.type.body.fontSize).toBe(17.5);
    expect(variant.type.body.lineHeight).toBe(26.3);
  });

  it('monoFont=jetbrains：mono 走 400 族、codeDigit 走 600 族（Q2）', () => {
    const variant = projectTheme('light', darkTheme, {
      fontScale: 'standard',
      monoFont: 'jetbrains',
    });
    expect(variant.type.mono.fontFamily).toBe('JetBrainsMono_400Regular');
    expect(variant.type.codeDigit.fontFamily).toBe('JetBrainsMono_600SemiBold');
  });

  it('monoFont=fira：mono 走 400 族、codeDigit 走 600 族（Q2）', () => {
    const variant = projectTheme('light', darkTheme, {
      fontScale: 'standard',
      monoFont: 'fira',
    });
    expect(variant.type.mono.fontFamily).toBe('FiraCode_400Regular');
    expect(variant.type.codeDigit.fontFamily).toBe('FiraCode_600SemiBold');
  });

  it('变体缓存：同偏好同引用、异偏好异引用', () => {
    const prefs = { fontScale: 'large', monoFont: 'fira' } as const;
    const a = projectTheme('light', darkTheme, prefs);
    const b = projectTheme('light', darkTheme, prefs);
    expect(a).toBe(b);
    const c = projectTheme('light', darkTheme, {
      fontScale: 'xlarge',
      monoFont: 'fira',
    });
    expect(c).not.toBe(a);
  });

  it('变体缓存隔离：中性灰与浅色同偏好不串键（同为 dark=false 基座）', () => {
    const prefs = { fontScale: 'large', monoFont: 'system' } as const;
    const lightVariant = projectTheme('light', darkTheme, prefs);
    const neutralVariant = projectTheme('neutral', darkTheme, prefs);
    expect(neutralVariant).not.toBe(lightVariant);
    expect(neutralVariant.colors).toBe(neutralTheme.colors);
    expect(lightVariant.colors).toBe(lightTheme.colors);
    // 同偏好重复投影命中同一缓存引用
    expect(projectTheme('neutral', lightTheme, prefs)).toBe(neutralVariant);
  });

  it('standard + system 偏好 → 基座单例（身份稳定）', () => {
    expect(
      projectTheme('light', darkTheme, {
        fontScale: 'standard',
        monoFont: 'system',
      })
    ).toBe(lightTheme);
  });
});

describe('主题持久化往返', () => {
  it('setThemeMode 写 kv → 模拟重启 hydrate → useTheme 恢复所选档', async () => {
    const persist = makeKvPersist();
    configureSettingsPersistence(persist);
    await act(async () => {
      setThemeMode('dark');
    });
    expect(persist.map.get('settings.appearance')).toBeDefined();
    resetThemeModeForTest();
    expect(settingsStore.getState().groups.appearance.theme).toBe('system');
    await act(async () => {
      await settingsStore.getState().hydrate(persist);
    });
    expect(settingsStore.getState().groups.appearance.theme).toBe('dark');
    const { result } = await renderHook(() => useTheme());
    expect(result.current).toBe(darkTheme);
  });

  it('中性灰档持久化往返：写 kv → hydrate → 恢复 neutral（存量三档值不受影响）', async () => {
    const persist = makeKvPersist();
    configureSettingsPersistence(persist);
    await act(async () => {
      setThemeMode('neutral');
    });
    expect(persist.map.get('settings.appearance')).toBeDefined();
    resetThemeModeForTest();
    await act(async () => {
      await settingsStore.getState().hydrate(persist);
    });
    expect(settingsStore.getState().groups.appearance.theme).toBe('neutral');
    const { result } = await renderHook(() => useTheme());
    expect(result.current).toBe(neutralTheme);
  });
});
