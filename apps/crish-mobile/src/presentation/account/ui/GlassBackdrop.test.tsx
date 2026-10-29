// 磨砂玻璃底层：iOS 走 BlurView（intensity 40 / tint 随深浅色），降低透明度时实色兜底。
import { AccessibilityInfo } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';
import { GLASS_BLUR_INTENSITY, GlassBackdrop } from './GlassBackdrop';

describe('GlassBackdrop', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('默认渲染 BlurView，强度 40、浅色 tint', async () => {
    await render(<GlassBackdrop tone="glass" />);
    const blur = screen.getByTestId('glass-blur');
    expect(blur.props.intensity).toBe(GLASS_BLUR_INTENSITY);
    expect(blur.props.tint).toBe('light');
  });

  it('系统开启降低透明度时改用实色', async () => {
    jest
      .spyOn(AccessibilityInfo, 'isReduceTransparencyEnabled')
      .mockResolvedValue(true);
    await render(<GlassBackdrop tone="glassSheet" />);
    await waitFor(() => {
      expect(screen.getByTestId('glass-solid')).toBeTruthy();
    });
    expect(screen.queryByTestId('glass-blur')).toBeNull();
  });
});
