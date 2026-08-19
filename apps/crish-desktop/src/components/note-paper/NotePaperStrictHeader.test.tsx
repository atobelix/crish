// @vitest-environment jsdom
/**
 * NotePaperStrictHeader · LR-V2
 *
 * slash 写模式悬停走项目 Tooltip；零原生 title=。
 * 面板标题 prop 仍渲染为 h2，不是 DOM title。
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

function renderHeader(slashWriteMode: 'readonly' | 'writable' = 'readonly') {
  return render(
    <NotePaperStrictHeader
      title="纸面标题"
      resolvedRev={3}
      blockCount={2}
      slashWriteMode={slashWriteMode}
      showOpenSlashButton={false}
      onReload={vi.fn()}
      onOpenSlash={vi.fn()}
    />
  );
}

describe('NotePaperStrictHeader · LR-V2 Tooltip', () => {
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

  it('title prop 是面板标题（h2），不是 DOM title', () => {
    renderHeader();
    expect(
      screen.getByRole('heading', { name: '纸面标题' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '纸面标题' })
    ).not.toHaveAttribute('title');
  });
});
