import { Text, View } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import Tooltip from './Tooltip';

describe('Tooltip 原子组件（AGENTS.md §12）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('长按触发气泡展示，点击背景遮罩隐退', async () => {
    await render(
      <Tooltip content="气泡提示信息" testID="tooltip-trigger">
        <View>
          <Text>长按查看</Text>
        </View>
      </Tooltip>
    );

    expect(screen.getByText('长按查看')).toBeTruthy();
    expect(screen.queryByTestId('tooltip-bubble')).toBeNull();

    // 长按触发
    await fireEvent(screen.getByTestId('tooltip-trigger'), 'longPress');

    expect(screen.getByTestId('tooltip-bubble')).toBeTruthy();
    expect(screen.getByText('气泡提示信息')).toBeTruthy();

    // 点击遮罩关闭
    await fireEvent.press(screen.getByTestId('tooltip-backdrop'));
    expect(screen.queryByTestId('tooltip-bubble')).toBeNull();
  });

  it('展示 2.5 秒后自动隐退', async () => {
    await render(
      <Tooltip content="自动关闭提示" testID="tooltip-trigger">
        <View>
          <Text>触发按钮</Text>
        </View>
      </Tooltip>
    );

    await fireEvent(screen.getByTestId('tooltip-trigger'), 'longPress');
    expect(screen.getByTestId('tooltip-bubble')).toBeTruthy();

    // 推进 2500ms 定时器
    await act(async () => {
      jest.advanceTimersByTime(2500);
    });

    expect(screen.queryByTestId('tooltip-bubble')).toBeNull();
  });
});
