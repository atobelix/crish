// PricingSheet 未设置口径契约（P4）：
// - 未设置的单价以空串呈现，打开什么都不改直接保存，不得把 1.00/2.00 写回；
// - 单项清空 = 该项回到未设置（字段不写）；
// - 非法输入停在编辑页：不保存、不关闭。
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import { PricingSheet } from './PricingSheet';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

describe('PricingSheet 价格缺省口径', () => {
  it('pricing 未设置时两行皆空，保存回传 undefined（不写 1.00/2.00）', async () => {
    const onApply = jest.fn();
    const onClose = jest.fn();
    const view = await render(
      <PricingSheet
        visible
        onClose={onClose}
        pricing={undefined}
        onApply={onApply}
        testID="pricing-under-test"
      />,
      { wrapper: Providers }
    );
    expect(view.getByTestId('pricing-under-test-input-price').props.value).toBe(
      ''
    );
    expect(
      view.getByTestId('pricing-under-test-output-price').props.value
    ).toBe('');
    await fireEvent.press(view.getByTestId('pricing-under-test-apply-button'));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(undefined);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('只填输入价时输出保持未设置（字段缺席，不写 2.00）', async () => {
    const onApply = jest.fn();
    const view = await render(
      <PricingSheet
        visible
        onClose={() => undefined}
        pricing={undefined}
        onApply={onApply}
        testID="pricing-partial"
      />,
      { wrapper: Providers }
    );
    await fireEvent.changeText(
      view.getByTestId('pricing-partial-input-price'),
      '3.5'
    );
    await fireEvent.press(view.getByTestId('pricing-partial-apply-button'));
    expect(onApply).toHaveBeenCalledTimes(1);
    const payload = onApply.mock.calls[0][0];
    expect(payload.input).toBe(3.5);
    expect(payload.output).toBeUndefined();
    expect('output' in payload).toBe(false);
    expect(payload.currency).toBe('CNY');
  });

  it('已设价格清空后保存，该字段回到未设置且其余字段保留', async () => {
    const onApply = jest.fn();
    const view = await render(
      <PricingSheet
        visible
        onClose={() => undefined}
        pricing={{ currency: 'USD', input: 1.5, output: 4 }}
        onApply={onApply}
        testID="pricing-clear"
      />,
      { wrapper: Providers }
    );
    expect(view.getByTestId('pricing-clear-input-price').props.value).toBe(
      '1.5'
    );
    await fireEvent.changeText(view.getByTestId('pricing-clear-input-price'), '');
    await fireEvent.press(view.getByTestId('pricing-clear-apply-button'));
    const payload = onApply.mock.calls[0][0];
    expect(payload.input).toBeUndefined();
    expect('input' in payload).toBe(false);
    expect(payload.output).toBe(4);
    expect(payload.currency).toBe('USD');
  });

  it('非法单价停在编辑页：不保存、不关闭、给出错误', async () => {
    const onApply = jest.fn();
    const onClose = jest.fn();
    const view = await render(
      <PricingSheet
        visible
        onClose={onClose}
        pricing={undefined}
        onApply={onApply}
        testID="pricing-invalid"
      />,
      { wrapper: Providers }
    );
    await fireEvent.changeText(
      view.getByTestId('pricing-invalid-input-price'),
      'abc'
    );
    await fireEvent.press(view.getByTestId('pricing-invalid-apply-button'));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(view.getByTestId('pricing-invalid-error')).toBeTruthy();
  });
});
