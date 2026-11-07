// ThinkingTiersSheet 可选档多选契约（P4 思考组）：
// - 选中语言用点：选中 = textPrimary 实心（size.dot），未选 = hairline 空心；
// - 行 accessibilityRole=checkbox + checked；
// - 保存按标准档位顺序回传，只含勾选档位。
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import { useTheme, type Theme } from '@/adapters/platform/theme';
import { ThinkingTiersSheet } from './ThinkingTiersSheet';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

let capturedTheme: Theme | null = null;
function ThemeProbe() {
  capturedTheme = useTheme();
  return null;
}

function flattenStyle(style: unknown): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  const walk = (entry: unknown) => {
    if (Array.isArray(entry)) entry.forEach(walk);
    else if (entry && typeof entry === 'object')
      Object.assign(flat, entry as Record<string, unknown>);
  };
  walk(style);
  return flat;
}

describe('ThinkingTiersSheet', () => {
  it('点的选中/未选形态与勾选状态正确', async () => {
    const view = await render(
      <>
        <ThemeProbe />
        <ThinkingTiersSheet
          visible
          onClose={() => undefined}
          selectedTiers={['off', 'low']}
          onApply={() => undefined}
          testID="tiers-under-test"
        />
      </>,
      { wrapper: Providers }
    );
    const theme = capturedTheme!;
    const lowDot = flattenStyle(
      view.getByTestId('tiers-under-test-dot-low').props.style
    );
    expect(lowDot.backgroundColor).toBe(theme.colors.textPrimary);
    expect(lowDot.borderWidth).toBe(0);
    expect(lowDot.width).toBe(theme.size.dot);
    const highDot = flattenStyle(
      view.getByTestId('tiers-under-test-dot-high').props.style
    );
    expect(highDot.backgroundColor).toBe('transparent');
    expect(highDot.borderWidth).toBe(1);
    expect(highDot.borderColor).toBe(theme.colors.hairline);
    expect(
      view.getByTestId('tiers-under-test-option-low').props.accessibilityState
    ).toEqual({ checked: true });
    expect(
      view.getByTestId('tiers-under-test-option-high').props.accessibilityState
    ).toEqual({ checked: false });
  });

  it('增减档位后按标准顺序回传', async () => {
    const onApply = jest.fn();
    const view = await render(
      <ThinkingTiersSheet
        visible
        onClose={() => undefined}
        selectedTiers={['off', 'low', 'high']}
        onApply={onApply}
        testID="tiers-apply"
      />,
      { wrapper: Providers }
    );
    await fireEvent.press(view.getByTestId('tiers-apply-option-low'));
    await fireEvent.press(view.getByTestId('tiers-apply-option-medium'));
    await fireEvent.press(view.getByTestId('tiers-apply-apply'));
    expect(onApply).toHaveBeenCalledWith(['off', 'medium', 'high']);
  });
});
