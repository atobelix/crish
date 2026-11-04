import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
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

    // 默认 leftOffset 为 insets.left (0) + theme.space.lg (16) = 16
    // 默认 baseBottom 为 insets.bottom (34) + 24 = 58
    expect(btn.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bottom: 58, left: 16 }),
      ])
    );

    fireEvent.press(btn);
    expect(onPress).toHaveBeenCalled();
  });

  it('supports center alignment mode', async () => {
    const onPress = jest.fn();
    const view = await render(
      <ScrollToBottomButton
        onPress={onPress}
        alignment="center"
        bottomOffset={148}
        testID="test-scroll-bottom-center"
      />,
      { wrapper: Providers }
    );
    const btn = view.getByTestId('test-scroll-bottom-center');
    expect(btn).toBeTruthy();
    expect(btn.props.accessibilityLabel).toBe('回到底部');
    expect(view.queryByText('回到底部')).toBeNull();

    expect(btn.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bottom: 148, alignSelf: 'center' }),
      ])
    );

    fireEvent.press(btn);
    expect(onPress).toHaveBeenCalled();
  });
});

describe('ScrollToBottomButton - 键盘解耦与打字态原地淡出（Wave 4 铁律）', () => {
  const mockAnim = useReanimatedKeyboardAnimation as jest.Mock;

  afterEach(() => {
    mockAnim.mockReturnValue({
      progress: { value: 0 },
      height: { value: 0 },
    });
  });

  it('软键盘完全收起（0dp）：透明度为 1，不增加任何键盘位移', async () => {
    mockAnim.mockReturnValue({
      progress: { value: 0 },
      height: { value: 0 },
    });

    const view = await render(
      <ScrollToBottomButton
        onPress={jest.fn()}
        bottomOffset={148}
        testID="test-scroll-bottom-kb-0"
      />,
      { wrapper: Providers }
    );

    const btn = view.getByTestId('test-scroll-bottom-kb-0');
    expect(btn).toBeTruthy();
    // 纯静态底距保持 148，严禁叠加位移
    expect(btn.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ bottom: 148 })])
    );

    // 外层宿主应用 keyboardFadeStyle：opacity = 1，pointerEvents = 'box-none'
    const host = btn.parent;
    expect(host?.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ opacity: 1, pointerEvents: 'box-none' }),
      ])
    );
  });

  it('软键盘弹起过程中（20dp）：在 40dp 行程内平滑线性衰减至 0.5', async () => {
    mockAnim.mockReturnValue({
      progress: { value: 0.2 },
      height: { value: -20 },
    });

    const view = await render(
      <ScrollToBottomButton
        onPress={jest.fn()}
        bottomOffset={148}
        testID="test-scroll-bottom-kb-20"
      />,
      { wrapper: Providers }
    );

    const btn = view.getByTestId('test-scroll-bottom-kb-20');
    // 底距仍恒等于静态 148，绝不上推！
    expect(btn.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ bottom: 148 })])
    );

    const host = btn.parent;
    // 1 - 20/40 = 0.5
    expect(host?.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ opacity: 0.5, pointerEvents: 'box-none' }),
      ])
    );
  });

  it('软键盘完全弹起（336dp）：原地淡出至 0 并置 pointerEvents="none"，绝不上推推飞', async () => {
    mockAnim.mockReturnValue({
      progress: { value: 1 },
      height: { value: -336 },
    });

    const view = await render(
      <ScrollToBottomButton
        onPress={jest.fn()}
        bottomOffset={148}
        testID="test-scroll-bottom-kb-full"
      />,
      { wrapper: Providers }
    );

    const btn = view.getByTestId('test-scroll-bottom-kb-full');
    // 关键断言：底距绝不变成 148 + 336 = 484 或 148 + 672 = 820，始终锚定在输入框基准 148！
    expect(btn.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ bottom: 148 })])
    );

    const host = btn.parent;
    // 完全升起时：opacity = 0，pointerEvents = 'none'（静默避让，不拦截打字触控）
    expect(host?.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ opacity: 0, pointerEvents: 'none' }),
      ])
    );
  });

  it('废弃兼容属性 followKeyboard 不会导致崩溃或叠加二次高度', async () => {
    mockAnim.mockReturnValue({
      progress: { value: 1 },
      height: { value: -336 },
    });

    const view = await render(
      <ScrollToBottomButton
        onPress={jest.fn()}
        bottomOffset={148}
        followKeyboard={true}
        testID="test-scroll-bottom-deprecated"
      />,
      { wrapper: Providers }
    );

    const btn = view.getByTestId('test-scroll-bottom-deprecated');
    // 即使传入遗留 followKeyboard=true，内部也已彻底废除上推计算，底距仍为 148
    expect(btn.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ bottom: 148 })])
    );
  });

  it('支持关闭 hideOnKeyboard（hideOnKeyboard=false）：不注入淡出样式', async () => {
    mockAnim.mockReturnValue({
      progress: { value: 1 },
      height: { value: -336 },
    });

    const view = await render(
      <ScrollToBottomButton
        onPress={jest.fn()}
        bottomOffset={148}
        hideOnKeyboard={false}
        testID="test-scroll-bottom-no-fade"
      />,
      { wrapper: Providers }
    );

    const btn = view.getByTestId('test-scroll-bottom-no-fade');
    const host = btn.parent;
    // hideOnKeyboard 为 false 时，keyboardFadeStyle 返回 {}，不强制把 opacity 变成 0
    expect(host?.props.style).toEqual(
      expect.arrayContaining([expect.not.objectContaining({ opacity: 0 })])
    );
  });
});
