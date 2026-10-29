// theme.ts 测试：主题投影 / 浅深 token 结构一致 / useTheme 订阅 / 持久化往返。
import { act, renderHook } from '@testing-library/react-native';
import {
  darkTheme,
  lightTheme,
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

  it('浅深两套颜色键集合一致', () => {
    expect(Object.keys(darkTheme.colors).sort()).toEqual(
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
});
