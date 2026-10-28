// theme.ts 测试（R2UX-06-05 深色模式三选）：存储默认/切换 / projectThemeTokens
// 投影 / token 键集合完整性（浅深两套）/ useTheme 订阅行为
import { act, renderHook } from '@testing-library/react-native';
import {
  darkTokens,
  lightTokens,
  projectThemeTokens,
  resetThemeModeForTest,
  themeModeStore,
  useTheme,
  useThemeMode,
} from './theme';

beforeEach(() => {
  resetThemeModeForTest();
});

describe('themeModeStore（F6 §9 主题三选存储面）', () => {
  it('默认跟随系统（system）', () => {
    expect(themeModeStore.getState().mode).toBe('system');
  });

  it('setMode 切换三选', () => {
    themeModeStore.getState().setMode('light');
    expect(themeModeStore.getState().mode).toBe('light');
    themeModeStore.getState().setMode('dark');
    expect(themeModeStore.getState().mode).toBe('dark');
    themeModeStore.getState().setMode('system');
    expect(themeModeStore.getState().mode).toBe('system');
  });
});

describe('useThemeMode 订阅', () => {
  it('模式变更驱动订阅更新', async () => {
    const { result } = await renderHook(() => useThemeMode((s) => s.mode));
    expect(result.current).toBe('system');
    await act(async () => {
      themeModeStore.getState().setMode('dark');
    });
    expect(result.current).toBe('dark');
  });
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

describe('useTheme', () => {
  it('system 模式返回系统方案（jest 环境默认浅色）', async () => {
    const { result } = await renderHook(() => useTheme());
    expect(result.current).toBe(lightTokens);
  });

  it('深色模式返回深色 token 表', async () => {
    themeModeStore.getState().setMode('dark');
    const { result } = await renderHook(() => useTheme());
    expect(result.current).toBe(darkTokens);
  });

  it('三选切换驱动 useTheme 变化', async () => {
    const { result } = await renderHook(() => useTheme());
    expect(result.current).toBe(lightTokens);
    await act(async () => {
      themeModeStore.getState().setMode('dark');
    });
    expect(result.current).toBe(darkTokens);
  });
});
