import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { ScrollToBottomButton } from './ScrollToBottomButton';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

describe('ScrollToBottomButton - Symbolic & Left Anchor', () => {
  it('renders symbolic chevron-down icon without text and supports left alignment', async () => {
    const onPress = jest.fn();
    const view = await render(
      <ScrollToBottomButton
        onPress={onPress}
        alignment="left"
        testID="test-scroll-bottom"
      />,
      { wrapper: Providers }
    );
    const btn = view.getByTestId('test-scroll-bottom');
    expect(btn).toBeTruthy();
    expect(btn.props.accessibilityLabel).toBe('回到底部');
    // 断言界面上不再渲染冗余文字“回到底部”
    expect(view.queryByText('回到底部')).toBeNull();

    fireEvent.press(btn);
    expect(onPress).toHaveBeenCalled();
  });

  it('supports center alignment mode', async () => {
    const onPress = jest.fn();
    const view = await render(
      <ScrollToBottomButton
        onPress={onPress}
        alignment="center"
        testID="test-scroll-bottom-center"
      />,
      { wrapper: Providers }
    );
    const btn = view.getByTestId('test-scroll-bottom-center');
    expect(btn).toBeTruthy();
    expect(btn.props.accessibilityLabel).toBe('回到底部');
    expect(view.queryByText('回到底部')).toBeNull();

    fireEvent.press(btn);
    expect(onPress).toHaveBeenCalled();
  });
});
