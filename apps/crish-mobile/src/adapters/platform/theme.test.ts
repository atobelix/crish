// theme.ts 测试（R2UX-06-05 深色模式三选 + R4 批次2 持久化单真源）：
// projectThemeTokens 投影 / token 键集合完整性（浅深两套）/ useTheme 订阅行为 /
// setThemeMode 写入（settingsStore 落库语义）/ 持久化往返（set → 模拟重启 hydrate → 读取一致）
import { act, renderHook } from '@testing-library/react-native';
import {
  darkTokens,
  lightTokens,
  projectThemeTokens,
  resetThemeModeForTest,
  setThemeMode,
  useTheme,
} from './theme';
import {
  settingsStore,
  configureSettingsPersistence,
  type SettingsPersist,
} from '@/domain/store/settingsStore';

/** 内存 kv fake（模拟重启：同一 Map 重新 hydrate） */
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

describe('projectThemeTokens（R2UX-06-05 token 完整性）', () => {
  it('system → 透传系统方案 token', () => {
    expect(projectThemeTokens('system', lightTokens)).toBe(lightTokens);
    expect(projectThemeTokens('system', darkTokens)).toBe(darkTokens);
  });

  it('light/dark → 对应完整 token 表', () => {
    expect(projectThemeTokens('light', darkTokens)).toBe(lightTokens);
    expect(projectThemeTokens('dark', lightTokens)).toBe(darkTokens);
  });

  it('浅深两套 token 键集合一致（R2UX-06-05 完整性断言）', () => {
    expect(Object.keys(darkTokens).sort()).toEqual(
      Object.keys(lightTokens).sort()
    );
  });
});

describe('useTheme 订阅', () => {
  it('默认 system 档（jest 环境浅色）', async () => {
    const { result } = await renderHook(() => useTheme());
    expect(result.current).toBe(lightTokens);
  });

  it('setThemeMode 切换深色 → useTheme 即时投影深色 token 表', async () => {
    const { result } = await renderHook(() => useTheme());
    expect(result.current).toBe(lightTokens);
    await act(async () => {
      setThemeMode('dark');
    });
    expect(result.current).toBe(darkTokens);
    await act(async () => {
      setThemeMode('light');
    });
    expect(result.current).toBe(lightTokens);
  });
});

describe('主题持久化往返（R4 批次2：重启不丢偏好）', () => {
  it('setThemeMode 写 kv → 模拟重启 hydrate → useTheme 恢复所选档', async () => {
    const persist = makeKvPersist();
    configureSettingsPersistence(persist);
    await act(async () => {
      setThemeMode('dark');
    });
    expect(persist.map.get('settings.appearance')).toBeDefined();
    // 模拟重启：内存态复位（回到出厂默认）后从 kv 回填
    resetThemeModeForTest();
    expect(settingsStore.getState().groups.appearance.theme).toBe('system');
    await act(async () => {
      await settingsStore.getState().hydrate(persist);
    });
    expect(settingsStore.getState().groups.appearance.theme).toBe('dark');
    const { result } = await renderHook(() => useTheme());
    expect(result.current).toBe(darkTokens);
  });
});
