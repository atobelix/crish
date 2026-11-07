// TokenPresetSheet 契约（P5 + P4）：
// - 数字输入获焦不升档：Sheet 面板 maxHeight 在 focus/blur 前后不变
//   （useSheetSearchRaise 只给搜索框，数字框挂上会在键盘动画期间改尺寸）；
// - 留空保存 = 未设置：onApply 回传 undefined，不把预填假值写回；
// - 校验失败停在编辑页：不保存、不关闭、显示原因。
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import { TokenPresetSheet } from './TokenPresetSheet';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

/** 面板宿主的 maxHeight（style 数组拍平后取，与 sheet.test 同款） */
function panelMaxHeight(
  view: { getByTestId: (id: string) => { props: Record<string, unknown> } },
  id: string
) {
  const style = view.getByTestId(id).props.style as unknown;
  const flat: Record<string, unknown>[] = [];
  const walk = (entry: unknown) => {
    if (Array.isArray(entry)) entry.forEach(walk);
    else if (entry && typeof entry === 'object')
      flat.push(entry as Record<string, unknown>);
  };
  walk(style);
  return flat.find((s) => 'maxHeight' in s)?.maxHeight;
}

describe('TokenPresetSheet', () => {
  it('数字输入获焦不改变 Sheet 尺寸（不升档）', async () => {
    const view = await render(
      <TokenPresetSheet
        visible
        onClose={() => undefined}
        title="上下文窗口容量"
        value={131072}
        presets={[131072]}
        onApply={() => undefined}
        testID="token-raise"
      />,
      { wrapper: Providers }
    );
    const before = panelMaxHeight(view, 'token-raise');
    expect(before).toBeDefined();
    await fireEvent(view.getByTestId('token-raise-input'), 'focus');
    expect(panelMaxHeight(view, 'token-raise')).toBe(before);
    await fireEvent(view.getByTestId('token-raise-input'), 'blur');
    expect(panelMaxHeight(view, 'token-raise')).toBe(before);
  });

  it('未设置时输入为空，留空保存回传 undefined', async () => {
    const onApply = jest.fn();
    const onClose = jest.fn();
    const view = await render(
      <TokenPresetSheet
        visible
        onClose={onClose}
        title="上下文窗口容量"
        value={undefined}
        presets={[131072]}
        onApply={onApply}
        testID="token-unset"
      />,
      { wrapper: Providers }
    );
    expect(view.getByTestId('token-unset-input').props.value).toBe('');
    await fireEvent.press(view.getByTestId('token-unset-apply'));
    expect(onApply).toHaveBeenCalledWith(undefined);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点预设填入数值，保存回传该数值', async () => {
    const onApply = jest.fn();
    const view = await render(
      <TokenPresetSheet
        visible
        onClose={() => undefined}
        title="最大输出长度"
        value={undefined}
        presets={[8192, 16384]}
        onApply={onApply}
        testID="token-preset"
      />,
      { wrapper: Providers }
    );
    await fireEvent.press(view.getByTestId('token-preset-pill-16384'));
    await fireEvent.press(view.getByTestId('token-preset-apply'));
    expect(onApply).toHaveBeenCalledWith(16384);
  });

  it('校验失败停在编辑页：不保存、不关闭、显示原因', async () => {
    const onApply = jest.fn();
    const onClose = jest.fn();
    const view = await render(
      <TokenPresetSheet
        visible
        onClose={onClose}
        title="最大输出长度"
        value={undefined}
        presets={[8192]}
        validate={(val) =>
          val !== undefined && val > 1000 ? '最大输出不能超过上下文窗口容量' : null
        }
        onApply={onApply}
        testID="token-invalid"
      />,
      { wrapper: Providers }
    );
    await fireEvent.changeText(view.getByTestId('token-invalid-input'), '8192');
    await fireEvent.press(view.getByTestId('token-invalid-apply'));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(view.getByTestId('token-invalid-error')).toBeTruthy();
  });
});
