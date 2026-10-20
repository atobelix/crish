// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAppearanceSchema } from '../useAppearanceSchema';

describe('useAppearanceSchema', () => {
  const defaultArgs = {
    activeTheme: 'default' as const,
    skinOptions: [{ value: 'warm-gray', label: 'Warm Gray' }],
    skinPreset: 'warm-gray',
  };

  it('非 Windows 11 设备 (isWin11 = false) 严禁展示云母效果选项', () => {
    const { result } = renderHook(() =>
      useAppearanceSchema({ ...defaultArgs, isWin11: false })
    );
    const allProps = result.current.flatMap((section) => section.properties);
    const micaProp = allProps.find((p) => p.key === 'enableMicaEffect');
    expect(micaProp).toBeUndefined();
  });

  it('Windows 11 设备 (isWin11 = true) 成功挂载云母效果选项并接线 i18n key', () => {
    const { result } = renderHook(() =>
      useAppearanceSchema({ ...defaultArgs, isWin11: true })
    );
    const allProps = result.current.flatMap((section) => section.properties);
    const micaProp = allProps.find((p) => p.key === 'enableMicaEffect');
    expect(micaProp).toBeDefined();
    expect(micaProp?.titleKey).toBe('appearance.micaTitle');
    expect(micaProp?.descKey).toBe('appearance.micaDesc');
  });
});
