// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import React from 'react';
import { TerminalToolbar } from './TerminalToolbar';

describe('TerminalToolbar 终端操作工具栏', () => {
  const defaultProps = {
    splitMode: 'none' as const,
    activePaneIndex: 0,
    onSelectPane: vi.fn(),
    onNewTerminal: vi.fn(),
    onSplitHorizontal: vi.fn(),
    onSplitVertical: vi.fn(),
    onClear: vi.fn(),
    onCloseSplit: vi.fn(),
  };

  it('非分屏状态下渲染单个 pwsh 标签，不展示关闭分屏按钮', () => {
    const { getByText, queryByLabelText, getByLabelText } = render(
      <TerminalToolbar {...defaultProps} />
    );

    expect(getByText('pwsh')).toBeTruthy();
    expect(queryByLabelText('关闭当前分屏')).toBeNull();
    expect(getByLabelText('新建独立终端')).toBeTruthy();
    expect(getByLabelText('左右分屏')).toBeTruthy();
    expect(getByLabelText('上下分屏')).toBeTruthy();
    expect(getByLabelText('清空当前终端屏幕')).toBeTruthy();
  });

  it('支持自定义 title 显示', () => {
    const { getByText } = render(
      <TerminalToolbar {...defaultProps} title="pwsh 2" />
    );
    expect(getByText('pwsh 2')).toBeTruthy();
  });

  it('分屏状态下展示树状分支标识符与分屏标签', () => {
    const { getByText, getByLabelText } = render(
      <TerminalToolbar
        {...defaultProps}
        splitMode="horizontal"
        activePaneIndex={0}
      />
    );

    expect(getByText('pwsh 1')).toBeTruthy();
    expect(getByText('pwsh 2')).toBeTruthy();
    expect(getByLabelText('关闭当前分屏')).toBeTruthy();
  });

  it('点击工具栏各个原子按钮触发对应回调', () => {
    const onNewTerminal = vi.fn();
    const onSplitHorizontal = vi.fn();
    const onSplitVertical = vi.fn();
    const onClear = vi.fn();
    const onCloseSplit = vi.fn();

    const { getByLabelText } = render(
      <TerminalToolbar
        {...defaultProps}
        splitMode="vertical"
        onNewTerminal={onNewTerminal}
        onSplitHorizontal={onSplitHorizontal}
        onSplitVertical={onSplitVertical}
        onClear={onClear}
        onCloseSplit={onCloseSplit}
      />
    );

    fireEvent.click(getByLabelText('新建独立终端'));
    expect(onNewTerminal).toHaveBeenCalledTimes(1);

    fireEvent.click(getByLabelText('左右分屏'));
    expect(onSplitHorizontal).toHaveBeenCalledTimes(1);

    fireEvent.click(getByLabelText('上下分屏'));
    expect(onSplitVertical).toHaveBeenCalledTimes(1);

    fireEvent.click(getByLabelText('清空当前终端屏幕'));
    expect(onClear).toHaveBeenCalledTimes(1);

    fireEvent.click(getByLabelText('关闭当前分屏'));
    expect(onCloseSplit).toHaveBeenCalledTimes(1);
  });

  it('点击分屏分支项目触发 onSelectPane 切换激活窗格', () => {
    const onSelectPane = vi.fn();
    const { getByLabelText } = render(
      <TerminalToolbar
        {...defaultProps}
        splitMode="horizontal"
        activePaneIndex={0}
        onSelectPane={onSelectPane}
      />
    );

    fireEvent.click(getByLabelText('切换到副分屏终端'));
    expect(onSelectPane).toHaveBeenCalledWith(1);

    fireEvent.click(getByLabelText('切换到主分屏终端'));
    expect(onSelectPane).toHaveBeenCalledWith(0);
  });
});
