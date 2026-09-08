/**
 * ComposerNoticeBar (输入框上方高级提示条组件) 专属单元测试
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, act, cleanup } from '@testing-library/react';
import { ComposerNoticeBar, type ComposerNotice } from '../ComposerNoticeBar';
import {
  DEFAULT_DELAY_SHOW_MS,
  resetTooltipControllerForTests,
} from '../../ui/Tooltip/tooltipController';

describe('ComposerNoticeBar (输入框上方高级提示条组件)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
    resetTooltipControllerForTests();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('1. notice 为 null 时不渲染任何 DOM', () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <ComposerNoticeBar notice={null} onDismiss={onDismiss} />
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('composer-notice-bar')).toBeNull();
  });

  it('2. 正常渲染 message 与不同类型（info / warning / error）', () => {
    const onDismiss = vi.fn();

    // 2a. info 类型
    const infoNotice: ComposerNotice = {
      id: 'info-1',
      type: 'info',
      message: '已切换至极速回复模式',
    };
    const { rerender } = render(
      <ComposerNoticeBar notice={infoNotice} onDismiss={onDismiss} />
    );
    const infoBar = screen.getByTestId('composer-notice-bar');
    expect(infoBar).toHaveAttribute('data-notice-type', 'info');
    expect(screen.getByText('已切换至极速回复模式')).toBeInTheDocument();

    // 2b. warning 类型
    const warningNotice: ComposerNotice = {
      id: 'warning-1',
      type: 'warning',
      message: '上下文窗口接近上限（85%）',
    };
    rerender(<ComposerNoticeBar notice={warningNotice} onDismiss={onDismiss} />);
    const warningBar = screen.getByTestId('composer-notice-bar');
    expect(warningBar).toHaveAttribute('data-notice-type', 'warning');
    expect(screen.getByText('上下文窗口接近上限（85%）')).toBeInTheDocument();

    // 2c. error 类型
    const errorNotice: ComposerNotice = {
      id: 'error-1',
      type: 'error',
      message: '模型连接中断，请检查网络或代理配置',
    };
    rerender(<ComposerNoticeBar notice={errorNotice} onDismiss={onDismiss} />);
    const errorBar = screen.getByTestId('composer-notice-bar');
    expect(errorBar).toHaveAttribute('data-notice-type', 'error');
    expect(screen.getByText('模型连接中断，请检查网络或代理配置')).toBeInTheDocument();
  });

  it('3. 传递自定义 className 正确合并到容器类名', () => {
    const notice: ComposerNotice = {
      id: 'custom-class-1',
      type: 'info',
      message: '测试类名注入',
    };
    render(
      <ComposerNoticeBar
        notice={notice}
        onDismiss={vi.fn()}
        className="test-custom-class"
      />
    );

    const bar = screen.getByTestId('composer-notice-bar');
    expect(bar).toHaveClass('test-custom-class');
  });

  it('4. 叹号徽标及其 Tooltip：鼠标 Hover 展示完整技术/上下文详细错误', () => {
    const notice: ComposerNotice = {
      id: 'detail-1',
      type: 'error',
      message: '执行 Shell 失败',
      detail: 'Error: exit status 127: command not found: unknown-tool',
    };

    render(<ComposerNoticeBar notice={notice} onDismiss={vi.fn()} />);

    const badge = screen.getByTestId('composer-notice-detail-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('!');

    // 悬停前无 Tooltip
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    // 鼠标悬停进入
    act(() => {
      fireEvent.mouseEnter(badge);
    });

    // 未满停留阈值时不展示
    act(() => {
      vi.advanceTimersByTime(DEFAULT_DELAY_SHOW_MS - 10);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    // 满停留阈值后弹出完整技术详情
    act(() => {
      vi.advanceTimersByTime(20);
    });
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent(
      'Error: exit status 127: command not found: unknown-tool'
    );

    act(() => {
      fireEvent.mouseLeave(badge);
      vi.advanceTimersByTime(100);
    });
  });

  it('5. 当未提供 detail 时，Tooltip 优雅回退到展示 message 简述', () => {
    const noticeWithoutDetail: ComposerNotice = {
      id: 'detail-fallback',
      type: 'warning',
      message: '仅有简述但无单独 detail 的警告信息',
    };

    render(
      <ComposerNoticeBar notice={noticeWithoutDetail} onDismiss={vi.fn()} />
    );

    const badge = screen.getByTestId('composer-notice-detail-badge');
    act(() => {
      fireEvent.mouseEnter(badge);
    });

    act(() => {
      vi.advanceTimersByTime(DEFAULT_DELAY_SHOW_MS + 50);
    });

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent('仅有简述但无单独 detail 的警告信息');

    act(() => {
      fireEvent.mouseLeave(badge);
      vi.advanceTimersByTime(100);
    });
  });

  it('6. 点击复制按钮将 detail/message 写入剪贴板，并呈现 1.2s 的“已复制”对勾反馈', () => {
    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextSpy,
      },
    });

    const noticeWithDetail: ComposerNotice = {
      id: 'copy-1',
      type: 'error',
      message: '编译失败',
      detail: 'tsc: src/App.tsx(10,5): error TS2304: Cannot find name "foo".',
    };

    const { rerender } = render(
      <ComposerNoticeBar notice={noticeWithDetail} onDismiss={vi.fn()} />
    );

    const copyBtn = screen.getByTestId('composer-notice-copy-btn');
    expect(copyBtn).toHaveTextContent('复制');

    // 点击复制
    act(() => {
      fireEvent.click(copyBtn);
    });

    expect(writeTextSpy).toHaveBeenCalledTimes(1);
    expect(writeTextSpy).toHaveBeenCalledWith(
      'tsc: src/App.tsx(10,5): error TS2304: Cannot find name "foo".'
    );

    // 立即呈现“已复制”反馈
    expect(copyBtn).toHaveTextContent('已复制');

    // 1.1s 后依然维持“已复制”
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(copyBtn).toHaveTextContent('已复制');

    // 满 1.2s 后自动恢复“复制”字样
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(copyBtn).toHaveTextContent('复制');

    // 针对无 detail 的 notice，复制应使用 message
    const noticeWithoutDetail: ComposerNotice = {
      id: 'copy-2',
      type: 'info',
      message: '纯文本无详情拷贝',
    };
    rerender(
      <ComposerNoticeBar notice={noticeWithoutDetail} onDismiss={vi.fn()} />
    );

    act(() => {
      fireEvent.click(copyBtn);
    });
    expect(writeTextSpy).toHaveBeenCalledTimes(2);
    expect(writeTextSpy).toHaveBeenLastCalledWith('纯文本无详情拷贝');
  });

  it('7. 点击反馈按钮调用 onFeedback 回调（若未提供则安全不抛错）', () => {
    const onFeedback = vi.fn();
    const notice: ComposerNotice = {
      id: 'feedback-1',
      type: 'error',
      message: '未知系统异常',
    };

    const { rerender } = render(
      <ComposerNoticeBar
        notice={notice}
        onDismiss={vi.fn()}
        onFeedback={onFeedback}
      />
    );

    const feedbackBtn = screen.getByTestId('composer-notice-feedback-btn');
    fireEvent.click(feedbackBtn);
    expect(onFeedback).toHaveBeenCalledTimes(1);

    // 未传递 onFeedback 时点击不发生异常
    rerender(<ComposerNoticeBar notice={notice} onDismiss={vi.fn()} />);
    expect(() => {
      fireEvent.click(feedbackBtn);
    }).not.toThrow();
  });

  it('8. 点击关闭按钮调用 onDismiss 回调', () => {
    const onDismiss = vi.fn();
    const notice: ComposerNotice = {
      id: 'dismiss-1',
      type: 'warning',
      message: '关闭测试提示',
    };

    render(<ComposerNoticeBar notice={notice} onDismiss={onDismiss} />);

    const dismissBtn = screen.getByTestId('composer-notice-dismiss-btn');
    fireEvent.click(dismissBtn);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
