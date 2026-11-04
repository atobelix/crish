import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { ConnectionBanner } from './ConnectionBanner';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

describe('ConnectionBanner (连接状态横幅与文字保全契约)', () => {
  const mockRetry = jest.fn();
  const mockSwitch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('展示 phaseLabel 状态文案，且在提供 lastError 时优先展示错误信息', async () => {
    const view = await render(
      <Providers>
        <ConnectionBanner
          phaseLabel="桌面未连接 · 正在使用本地对话"
          onRetry={mockRetry}
          onSwitch={mockSwitch}
        />
      </Providers>
    );

    expect(view.getByText('桌面未连接 · 正在使用本地对话')).toBeTruthy();

    await view.rerender(
      <Providers>
        <ConnectionBanner
          phaseLabel="桌面未连接 · 正在使用本地对话"
          lastError="网络连接已超时，请检查局域网环境"
          onRetry={mockRetry}
          onSwitch={mockSwitch}
        />
      </Providers>
    );

    expect(view.getByText('网络连接已超时，请检查局域网环境')).toBeTruthy();
    expect(view.queryByText('桌面未连接 · 正在使用本地对话')).toBeNull();
  });

  it('点击「重试」图标按钮触发 onRetry 回调', async () => {
    const view = await render(
      <Providers>
        <ConnectionBanner
          phaseLabel="未连接"
          onRetry={mockRetry}
          onSwitch={mockSwitch}
        />
      </Providers>
    );

    const retryBtn = view.getByLabelText('重新连接');
    fireEvent.press(retryBtn);

    expect(mockRetry).toHaveBeenCalledTimes(1);
    expect(mockSwitch).not.toHaveBeenCalled();
  });

  it('点击「切换」胶囊按钮触发 onSwitch 回调', async () => {
    const view = await render(
      <Providers>
        <ConnectionBanner
          phaseLabel="未连接"
          onRetry={mockRetry}
          onSwitch={mockSwitch}
        />
      </Providers>
    );

    const switchBtn = view.getByTestId('connection-switch');
    fireEvent.press(switchBtn);

    expect(mockSwitch).toHaveBeenCalledTimes(1);
    expect(mockRetry).not.toHaveBeenCalled();
  });

  it('未传 onSwitch 时回退触发 onRetry', async () => {
    const view = await render(
      <Providers>
        <ConnectionBanner phaseLabel="未连接" onRetry={mockRetry} />
      </Providers>
    );

    fireEvent.press(view.getByTestId('connection-switch'));
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it('点击「帮助」文字链唤起排障抽屉 ConnectionHelpSheet', async () => {
    const view = await render(
      <Providers>
        <ConnectionBanner
          phaseLabel="未连接"
          onRetry={mockRetry}
          onSwitch={mockSwitch}
        />
      </Providers>
    );

    const helpBtn = view.getByTestId('connection-help-entry');
    await act(async () => {
      fireEvent.press(helpBtn);
    });

    expect(await view.findByText('连接帮助')).toBeTruthy();
  });

  it('防坍塌布局契约断言：外层横向撑满、内层全宽、文字容器具备 flexShrink 与 60dp 最小保护宽', async () => {
    const view = await render(
      <Providers>
        <ConnectionBanner
          phaseLabel="桌面未连接 · 正在使用本地对话"
          onRetry={mockRetry}
          onSwitch={mockSwitch}
        />
      </Providers>
    );

    // 1. 验证外层 Animated.View 绝对不含 flexDirection: 'row'，规范为横向拉伸
    const bannerContainer = view.getByTestId('connection-banner');
    const flatBannerStyle = StyleSheet.flatten(bannerContainer.props.style);
    expect(flatBannerStyle.alignSelf).toBe('stretch');
    expect(flatBannerStyle.width).toBe('100%');
    expect(flatBannerStyle.flexDirection).toBeUndefined();

    // 2. 验证文字包裹容器
    const textNode = view.getByText('桌面未连接 · 正在使用本地对话');
    const textContainer = textNode.parent;
    expect(textContainer).toBeTruthy();
    const flatTextStyle = StyleSheet.flatten(textContainer?.props.style);
    expect(flatTextStyle.flex).toBe(1);
    expect(flatTextStyle.flexShrink).toBe(1);
    expect(flatTextStyle.minWidth).toBe(60);

    // 3. 验证切换胶囊不可被挤压
    const switchCapsule = view.getByTestId('connection-switch');
    const flatSwitchStyle = StyleSheet.flatten(switchCapsule.props.style);
    expect(flatSwitchStyle.flexShrink).toBe(0);
  });
});
