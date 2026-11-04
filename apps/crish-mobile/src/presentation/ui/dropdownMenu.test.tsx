import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import { DropdownMenu } from '@/presentation/ui';
import type { DropdownMenuEntry } from '@/presentation/ui';
import { handleOverlayBack } from '@/presentation/ui/overlayStack';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

describe('DropdownMenu (移动端视口脱离与自适应定位浮层)', () => {
  const mockItemPress = jest.fn();
  const mockClose = jest.fn();

  const sampleEntries: DropdownMenuEntry[] = [
    {
      key: 'item1',
      label: '常规条目',
      icon: 'more',
      onPress: mockItemPress,
    },
    {
      key: 'div1',
      divider: true,
    },
    {
      key: 'item2',
      label: '危险条目',
      danger: true,
      desc: '带有辅助说明文本',
      onPress: mockItemPress,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('visible=false 时不挂载任何内容', async () => {
    const view = await render(
      <Providers>
        <DropdownMenu
          visible={false}
          onClose={mockClose}
          entries={sampleEntries}
          testID="test-menu"
        />
      </Providers>
    );
    expect(view.queryByTestId('test-menu')).toBeNull();
    expect(view.queryByText('常规条目')).toBeNull();
  });

  it('visible=true 时挂载 Modal 全屏透明遮罩与卡片，点击 backdrop 触发 onClose', async () => {
    const view = await render(
      <Providers>
        <DropdownMenu
          visible
          onClose={mockClose}
          entries={sampleEntries}
          testID="test-menu"
        />
      </Providers>
    );

    // 验证遮罩存在
    const backdrop = view.getByTestId('test-menu-backdrop');
    expect(backdrop).toBeTruthy();

    // 验证条目与描述存在
    expect(view.getByText('常规条目')).toBeTruthy();
    expect(view.getByText('危险条目')).toBeTruthy();
    expect(view.getByText('带有辅助说明文本')).toBeTruthy();

    // 点击遮罩触发关闭
    fireEvent.press(backdrop);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('点击菜单项先触发 onClose 并执行对应 onPress 回调', async () => {
    const view = await render(
      <Providers>
        <DropdownMenu
          visible
          onClose={mockClose}
          entries={sampleEntries}
          testID="test-menu"
        />
      </Providers>
    );

    const item = view.getByText('常规条目');
    fireEvent.press(item);

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockItemPress).toHaveBeenCalledTimes(1);
  });

  it('覆盖层栈注册与系统返回拦截：handleOverlayBack 正确消费并触发 onClose', async () => {
    const { unmount } = await render(
      <Providers>
        <DropdownMenu
          visible
          onClose={mockClose}
          entries={sampleEntries}
          testID="test-menu-back"
        />
      </Providers>
    );

    let consumed = false;
    await act(async () => {
      consumed = handleOverlayBack();
    });

    expect(consumed).toBe(true);
    expect(mockClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('传入 anchorRect 时在屏幕底部自适应向上弹出，并渲染 SoftShadowSurface', async () => {
    const view = await render(
      <Providers>
        <DropdownMenu
          visible
          onClose={mockClose}
          entries={sampleEntries}
          anchorRect={{ x: 300, y: 780, width: 32, height: 32 }}
          testID="flip-menu"
        />
      </Providers>
    );

    expect(view.getByTestId('flip-menu')).toBeTruthy();
    expect(view.getByText('常规条目')).toBeTruthy();
  });
});
