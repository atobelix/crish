// TerminalView 组件测试（R2UX-05-07 验收：固定行高 + 环形截断标记 + 自动滚动跟随/暂停）
// 覆盖：行渲染（纯文本行，ANSI 已在缓冲层剥离）、固定行高（getItemLayout prop）、
// 「已截断 N 行」标记、自动滚底（新行到达触发 scrollToEnd）、上翻暂停跟随
// （onFollowChange(false)）、回到底部恢复跟随（onFollowChange(true)）、空态。
// 注：@testing-library/react-native v14 render/fireEvent 为异步 API，全部 await
import { createRef } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import {
  TerminalView,
  AUTO_FOLLOW_THRESHOLD_DP,
  TERMINAL_LINE_HEIGHT,
} from './TerminalView';

describe('TerminalView 行渲染与固定行高（R2UX-05-07）', () => {
  it('渲染纯文本行（testID 按绝对下标稳定）', async () => {
    await render(
      <TerminalView
        lines={['line-0', 'line-1', 'line-2']}
        startIndex={0}
        truncatedCount={0}
      />
    );
    expect(screen.getByText('line-0')).toBeTruthy();
    expect(screen.getByText('line-1')).toBeTruthy();
    expect(screen.getByTestId('terminal-row-0')).toBeTruthy();
    expect(screen.getByTestId('terminal-row-2')).toBeTruthy();
  });

  it('固定行高导出 + 渲染行固定高度（虚拟化定位数据面）', async () => {
    expect(TERMINAL_LINE_HEIGHT).toBe(24);
    await render(
      <TerminalView lines={['a', 'b']} startIndex={0} truncatedCount={0} />
    );
    const list = screen.getByTestId('terminal-list');
    expect(list).toBeTruthy();
    // getItemLayout 的 length 数据源是 TERMINAL_LINE_HEIGHT（RNTL v14 仅暴露宿主元素，
    // 不提供 composite prop 查询）；断言渲染行样式高度与常量一致，即固定行高落地面
    const row0 = StyleSheet.flatten(
      screen.getByTestId('terminal-row-0').props.style
    ) as {
      height?: number;
    };
    const row1 = StyleSheet.flatten(
      screen.getByTestId('terminal-row-1').props.style
    ) as {
      height?: number;
    };
    expect(row0.height).toBe(TERMINAL_LINE_HEIGHT);
    expect(row1.height).toBe(TERMINAL_LINE_HEIGHT);
  });

  it('环形截断标记（truncatedCount > 0 显示「已截断 N 行」，F3 §4.3）', async () => {
    await render(
      <TerminalView
        lines={['l1']}
        startIndex={42}
        truncatedCount={42}
        follow={false}
      />
    );
    expect(screen.getByTestId('terminal-truncated')).toBeTruthy();
    expect(screen.getByText('已省略 42 行较早输出')).toBeTruthy();
  });

  it('truncatedCount = 0 不显示截断标记', async () => {
    await render(
      <TerminalView lines={['l1']} startIndex={0} truncatedCount={0} />
    );
    expect(screen.queryByTestId('terminal-truncated')).toBeNull();
  });

  it('空态（无行 → 主文案 + 副文案，M4 §5.9）', async () => {
    await render(
      <TerminalView
        lines={[]}
        startIndex={0}
        truncatedCount={0}
        follow={false}
      />
    );
    expect(screen.getByTestId('terminal-empty')).toBeTruthy();
    expect(screen.getByText('暂无终端输出')).toBeTruthy();
  });
});

describe('TerminalView 自动滚动跟随（R2UX-05-03 / F3 §4.3）', () => {
  function scrollEvent(distanceFromEnd: number) {
    return {
      nativeEvent: {
        contentOffset: { y: 0, x: 0 },
        contentSize: { height: 1000 + distanceFromEnd, width: 320 },
        layoutMeasurement: { height: 1000, width: 320 },
      },
    };
  }

  it('follow=true 时新行到达调用 scrollToEnd（吸底跟随）', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      await render(
        <TerminalView lines={['a']} startIndex={0} truncatedCount={0} follow />
      );
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('上翻超吸底阈值 → onFollowChange(false)（用户上滑暂停跟随）', async () => {
    const onFollowChange = jest.fn();
    await render(
      <TerminalView
        lines={['a', 'b', 'c']}
        startIndex={0}
        truncatedCount={0}
        follow
        onFollowChange={onFollowChange}
      />
    );
    await fireEvent.scroll(
      screen.getByTestId('terminal-list'),
      scrollEvent(AUTO_FOLLOW_THRESHOLD_DP + 1)
    );
    expect(onFollowChange).toHaveBeenCalledWith(false);
  });

  it('滚回底部（阈值内）→ onFollowChange(true)（恢复跟随）', async () => {
    const onFollowChange = jest.fn();
    await render(
      <TerminalView
        lines={['a', 'b', 'c']}
        startIndex={0}
        truncatedCount={0}
        follow={false}
        onFollowChange={onFollowChange}
      />
    );
    await fireEvent.scroll(
      screen.getByTestId('terminal-list'),
      scrollEvent(AUTO_FOLLOW_THRESHOLD_DP - 1)
    );
    expect(onFollowChange).toHaveBeenCalledWith(true);
  });

  it('阈值内滚动不重复通知（状态未翻转）', async () => {
    const onFollowChange = jest.fn();
    await render(
      <TerminalView
        lines={['a']}
        startIndex={0}
        truncatedCount={0}
        follow
        onFollowChange={onFollowChange}
      />
    );
    await fireEvent.scroll(
      screen.getByTestId('terminal-list'),
      scrollEvent(10)
    );
    expect(onFollowChange).not.toHaveBeenCalled();
  });

  it('listRef 转发（页面「回到底部」按钮可触发 scrollToEnd）', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    const listRef = createRef<FlatList<string> | null>();
    try {
      await render(
        <TerminalView
          lines={['a']}
          startIndex={0}
          truncatedCount={0}
          listRef={listRef}
        />
      );
      expect(listRef.current).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
