// @vitest-environment jsdom
/**
 * NotePaperStrictHeader · 32px 紧凑顶栏与 EditableTitle 专项测试
 *
 * 迁移契约：
 * 1. 标题由 h2 升级为 EditableTitle 行内即时编辑组件（非 heading 角色，Enter 确认、失焦保存，零原生 DOM title）；
 * 2. 保全 3 大关键 testid 断言：
 *    - note-paper-strict-open-slash
 *    - note-paper-strict-refresh
 *    - note-paper-strict-close
 * 3. 严格使用项目原子 Tooltip 组件（零原生 title= 属性）。
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NotePaperStrictHeader } from './NotePaperStrictHeader';
import { DEFAULT_DELAY_SHOW_MS, resetTooltipControllerForTests } from '../ui/Tooltip/tooltipController';

afterEach(() => {
  cleanup();
  resetTooltipControllerForTests();
  vi.useRealTimers();
});

function renderHeader(
  slashWriteMode: 'readonly' | 'writable' = 'readonly',
  props: Partial<React.ComponentProps<typeof NotePaperStrictHeader>> = {}
) {
  return render(
    <NotePaperStrictHeader
      title="纸面标题"
      resolvedRev={3}
      blockCount={2}
      slashWriteMode={slashWriteMode}
      showOpenSlashButton={true}
      onReload={vi.fn()}
      onOpenSlash={vi.fn()}
      onRenameTitle={vi.fn()}
      {...props}
    />
  );
}

describe('NotePaperStrictHeader · 32px 紧凑顶栏平滑迁移测试套件', () => {
  it('slash 只读徽章无原生 title；hover 出 Tooltip', () => {
    vi.useFakeTimers();
    renderHeader('readonly');
    const badge = screen.getByTestId('note-paper-strict-slash-mode');
    expect(badge).toHaveAttribute('data-slash-write-mode', 'readonly');
    expect(badge).not.toHaveAttribute('title');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseEnter(badge);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(DEFAULT_DELAY_SHOW_MS);
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'slash 只读（未接 apply；≠假写）'
    );
  });

  it('slash 可写徽章 hover 文案对应 writable', () => {
    vi.useFakeTimers();
    renderHeader('writable');
    const badge = screen.getByTestId('note-paper-strict-slash-mode');
    expect(badge).not.toHaveAttribute('title');
    fireEvent.mouseEnter(badge);
    act(() => {
      vi.advanceTimersByTime(DEFAULT_DELAY_SHOW_MS);
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'slash 可写（Intent → sink）'
    );
  });

  it('title prop 渲染为 EditableTitle 交互组件，不是 h2，支持 Enter 确认重命名，且零原生 DOM title', () => {
    const onRenameTitle = vi.fn();
    renderHeader('readonly', { title: '纸面标题', onRenameTitle });

    // 1. 展示态：不再是 heading 角色，而是承载 data-testid="note-paper-strict-title" 的交互式按钮
    const titleEl = screen.getByTestId('note-paper-strict-title');
    expect(titleEl).toBeInTheDocument();
    expect(titleEl).toHaveTextContent('纸面标题');
    expect(titleEl).toHaveAttribute('role', 'button');
    expect(titleEl).not.toHaveAttribute('title'); // 严格杜绝原生 HTML title 属性

    // 2. 负向断言：旧 h2 标题标签物理彻底退役
    expect(screen.queryByRole('heading')).toBeNull();

    // 3. 点击标题进入编辑输入态
    fireEvent.click(titleEl);
    const input = screen.getByTestId('note-paper-strict-title-input');
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('纸面标题');
    expect(input).toHaveAttribute('aria-label', '编辑笔记标题');

    // 4. 输入新名称并回车确认重命名
    fireEvent.change(input, { target: { value: '重构架构详案' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(onRenameTitle).toHaveBeenCalledWith('重构架构详案');
  });

  it('EditableTitle 支持失焦（blur）自动保存重命名', () => {
    const onRenameTitle = vi.fn();
    renderHeader('readonly', { title: '纸面标题', onRenameTitle });

    const titleEl = screen.getByTestId('note-paper-strict-title');
    fireEvent.click(titleEl);

    const input = screen.getByTestId('note-paper-strict-title-input');
    fireEvent.change(input, { target: { value: '失焦自动保存标题' } });
    fireEvent.blur(input);

    expect(onRenameTitle).toHaveBeenCalledWith('失焦自动保存标题');
  });

  it('3 大关键 testid（open-slash, refresh, close）断言通过', () => {
    const onOpenSlash = vi.fn();
    const onReload = vi.fn();
    const onClose = vi.fn();

    renderHeader('readonly', {
      showOpenSlashButton: true,
      onOpenSlash,
      onReload,
      onClose,
    });

    // 1. 关键 testid: note-paper-strict-open-slash
    const slashBtn = screen.getByTestId('note-paper-strict-open-slash');
    expect(slashBtn).toBeInTheDocument();
    expect(slashBtn).toHaveAttribute('data-slash-open-trigger', '1');
    fireEvent.click(slashBtn);
    expect(onOpenSlash).toHaveBeenCalledTimes(1);

    // 2. 关键 testid: note-paper-strict-refresh
    const refreshBtn = screen.getByTestId('note-paper-strict-refresh');
    expect(refreshBtn).toBeInTheDocument();
    fireEvent.click(refreshBtn);
    expect(onReload).toHaveBeenCalledTimes(1);

    // 3. 关键 testid: note-paper-strict-close
    const closeBtn = screen.getByTestId('note-paper-strict-close');
    expect(closeBtn).toBeInTheDocument();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
