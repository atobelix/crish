// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatEmptyState } from './ChatEmptyState';

describe('ChatEmptyState', () => {
  it('session-empty 不渲染可见内容：无标题 / 快捷 prompt / 项目钮，只留状态锚点', () => {
    const { container } = render(<ChatEmptyState kind="session-empty" />);
    const root = container.querySelector('[data-empty-kind="session-empty"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('role')).toBe('status');
    expect(root?.childElementCount).toBe(0);
    expect(container.textContent).toBe('');
    expect(container.querySelector('h3, button, [role="list"]')).toBeNull();
  });

  it('session-empty + messagesLoading：只打 data-messages-loading，不出可见文案', () => {
    const { container } = render(
      <ChatEmptyState kind="session-empty" messagesLoading />
    );
    const root = container.querySelector('[data-empty-kind="session-empty"]');
    expect(root?.getAttribute('data-messages-loading')).toBe('true');
    expect(container.textContent).toBe('');
  });

  it('filter-empty 仍出标题与清除过滤 CTA', () => {
    const onClearFilter = vi.fn();
    render(
      <ChatEmptyState
        kind="filter-empty"
        filterQuery="abc"
        onClearFilter={onClearFilter}
      />
    );
    expect(screen.getByRole('heading', { level: 3 })).toBeTruthy();
    const cta = document.querySelector('[data-empty-action="clear-filter"]');
    expect(cta).not.toBeNull();
    (cta as HTMLButtonElement).click();
    expect(onClearFilter).toHaveBeenCalled();
  });

  it('消费 useI18n 注入问候语与占位文案 (带 fallback)', () => {
    const { container } = render(<ChatEmptyState kind="session-empty" />);
    const root = container.querySelector('[data-empty-kind="session-empty"]');
    expect(root?.getAttribute('data-greeting')).toBe('欢迎');
    expect(root?.getAttribute('data-placeholder')).toBe('输入消息...');
  });
});
