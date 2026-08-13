// SettingsThemeSelector 组件测试（R2UX-06-05 深色模式三选）：
// 三选渲染 / 当前值选中态 / 点击回调 / 无障碍 label
import { fireEvent, render, screen } from '@testing-library/react-native';
import { THEME_MODE_LABELS } from '@/adapters/settings/themeProjection';
import SettingsThemeSelector from './SettingsThemeSelector';

describe('SettingsThemeSelector（F6 §9 主题三选）', () => {
  it('三选渲染：跟随系统/浅色/深色', async () => {
    await render(<SettingsThemeSelector value="system" onChange={jest.fn()} />);
    expect(screen.getByText(THEME_MODE_LABELS.system)).toBeTruthy();
    expect(screen.getByText(THEME_MODE_LABELS.light)).toBeTruthy();
    expect(screen.getByText(THEME_MODE_LABELS.dark)).toBeTruthy();
  });

  it('当前值选中态（accessibilityState.selected 双通道）', async () => {
    await render(<SettingsThemeSelector value="dark" onChange={jest.fn()} />);
    expect(
      screen.getByTestId('setting-theme-dark').props.accessibilityState.selected
    ).toBe(true);
    expect(
      screen.getByTestId('setting-theme-system').props.accessibilityState
        .selected
    ).toBe(false);
  });

  it('点击选项 → onChange(mode)', async () => {
    const onChange = jest.fn();
    await render(<SettingsThemeSelector value="system" onChange={onChange} />);
    await fireEvent.press(screen.getByTestId('setting-theme-light'));
    expect(onChange).toHaveBeenCalledWith('light');
    await fireEvent.press(screen.getByTestId('setting-theme-dark'));
    expect(onChange).toHaveBeenCalledWith('dark');
  });

  it('无障碍 label 含当前态（读屏播报）', async () => {
    await render(<SettingsThemeSelector value="dark" onChange={jest.fn()} />);
    expect(
      screen.getByTestId('setting-theme-dark').props.accessibilityLabel
    ).toBe('深色（当前）');
  });
});
