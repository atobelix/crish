// ModalityCard 选中点契约（P3 余半，与 ModelSelectCard 同一选中语言）：
// - 边框恒 hairline，选中不涂 brand / actionPrimary；
// - 选中 = textPrimary 实心点（size.dot），未选 = hairline 空心同尺寸点；
// - accessibilityRole=checkbox 与 accessibilityState.checked 保留。
// ModalitySelectSheet：未知模态字符串原样留在已选里，不丢。
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import { useTheme, type Theme } from '@/adapters/platform/theme';
import {
  ModalityCard,
  ModalitySelectSheet,
  type ModalityOption,
} from './ModalitySelectSheet';

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

const item: ModalityOption = { key: 'image', label: '图片 / 视觉 (Vision)', icon: 'image' };

describe('ModalityCard 选中点', () => {
  it('选中：实心 textPrimary 点、边框 hairline、checked 为真', async () => {
    const view = await render(
      <>
        <ThemeProbe />
        <ModalityCard
          item={item}
          selected
          onPress={() => undefined}
          testID="mod-card-on"
        />
      </>,
      { wrapper: Providers }
    );
    const theme = capturedTheme!;
    const cardStyle = flattenStyle(view.getByTestId('mod-card-on').props.style);
    expect(cardStyle.borderColor).toBe(theme.colors.hairline);
    expect(cardStyle.borderColor).not.toBe(theme.colors.brand);
    const dotStyle = flattenStyle(view.getByTestId('mod-card-on-dot').props.style);
    expect(dotStyle.backgroundColor).toBe(theme.colors.textPrimary);
    expect(dotStyle.borderWidth).toBe(0);
    expect(dotStyle.width).toBe(theme.size.dot);
    expect(dotStyle.height).toBe(theme.size.dot);
    expect(view.getByTestId('mod-card-on').props.accessibilityState).toEqual({
      checked: true,
    });
  });

  it('未选：hairline 空心点同尺寸、边框仍 hairline、checked 为假', async () => {
    const view = await render(
      <>
        <ThemeProbe />
        <ModalityCard
          item={item}
          selected={false}
          onPress={() => undefined}
          testID="mod-card-off"
        />
      </>,
      { wrapper: Providers }
    );
    const theme = capturedTheme!;
    const cardStyle = flattenStyle(
      view.getByTestId('mod-card-off').props.style
    );
    expect(cardStyle.borderColor).toBe(theme.colors.hairline);
    const dotStyle = flattenStyle(
      view.getByTestId('mod-card-off-dot').props.style
    );
    expect(dotStyle.backgroundColor).toBe('transparent');
    expect(dotStyle.borderWidth).toBe(1);
    expect(dotStyle.borderColor).toBe(theme.colors.hairline);
    expect(dotStyle.width).toBe(theme.size.dot);
    expect(view.getByTestId('mod-card-off').props.accessibilityState).toEqual({
      checked: false,
    });
  });
});

describe('ModalitySelectSheet 未知模态保留', () => {
  it('已选中的未知模态字符串在保存时原样保留', async () => {
    const onApply = jest.fn();
    const view = await render(
      <ModalitySelectSheet
        visible
        onClose={() => undefined}
        type="input"
        selected={['text', 'lidar']}
        onApply={onApply}
        testID="mod-sheet"
      />,
      { wrapper: Providers }
    );
    await fireEvent.press(view.getByTestId('mod-sheet-apply-button'));
    expect(onApply).toHaveBeenCalledTimes(1);
    const applied = onApply.mock.calls[0][0] as string[];
    expect(applied).toContain('text');
    expect(applied).toContain('lidar');
  });
});
