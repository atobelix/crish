// @vitest-environment jsdom
/**
 * IndicatorBar 组件测试（P1-B2）：四态文案 / 暂停按钮可见性与切换语义 /
 * AI 动作文本透出 / 点击回调。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IndicatorBar } from './IndicatorBar';
import type { PanelStatus } from './browserPanelTypes';

function renderBar(status: PanelStatus, aiActionText: string | null = null) {
  const onTogglePause = vi.fn();
  render(
    <IndicatorBar
      status={status}
      aiActionText={aiActionText}
      onTogglePause={onTogglePause}
    />
  );
  return onTogglePause;
}

describe('IndicatorBar', () => {
  afterEach(() => {
    cleanup();
  });

  it('idle：显示「AI 空闲」，无暂停按钮（无在途动作可暂停）', () => {
    renderBar('idle');
    expect(screen.getByText('AI 空闲')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '暂停 AI 队列' })).toBeNull();
  });

  it('ai-busy：显示「AI 正在操作…」+ 暂停按钮', () => {
    renderBar('ai-busy');
    expect(screen.getByText('AI 正在操作…')).toBeTruthy();
    const btn = screen.getByRole('button', { name: '暂停 AI 队列' });
    expect(btn.textContent).toBe('暂停');
  });

  it('paused：显示「已暂停」+ 恢复按钮（切换语义）', () => {
    const onTogglePause = renderBar('paused');
    expect(screen.getByText('已暂停（AI 队列挂起）')).toBeTruthy();
    const btn = screen.getByRole('button', { name: '恢复 AI 队列' });
    expect(btn.textContent).toBe('恢复');
    fireEvent.click(btn);
    expect(onTogglePause).toHaveBeenCalledTimes(1);
  });

  it('user-taking-over：显示「已接管（AI 在途已吊销）」+ 暂停按钮', () => {
    renderBar('user-taking-over');
    expect(screen.getByText('已接管（AI 在途已吊销）')).toBeTruthy();
    expect(screen.getByRole('button', { name: '暂停 AI 队列' })).toBeTruthy();
  });

  it('ai-busy 点击暂停 → 回调触发（接线点：引擎 browser_pause 未注册前仅本地）', () => {
    const onTogglePause = renderBar('ai-busy');
    fireEvent.click(screen.getByRole('button', { name: '暂停 AI 队列' }));
    expect(onTogglePause).toHaveBeenCalledTimes(1);
  });

  it('AI 动作文本透出：ai-busy 时拼接「AI 正在点击元素 [3]…」', () => {
    renderBar('ai-busy', 'AI 正在点击元素 [3]…');
    expect(
      screen.getByText('AI 正在操作…（AI 正在点击元素 [3]…）')
    ).toBeTruthy();
  });

  it('状态根节点携带 data-status 标记（样式投影面）', () => {
    renderBar('paused');
    expect(screen.getByRole('status').getAttribute('data-status')).toBe(
      'paused'
    );
  });
});
