// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RunNoticeBar } from './RunNoticeBar';

describe('RunNoticeBar', () => {
  it('does not render when runNotice is null', () => {
    const { container } = render(
      <RunNoticeBar runNotice={null} onDismiss={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('does not render when runNotice text is empty or blank', () => {
    const { container } = render(
      <RunNoticeBar runNotice={{ text: '   ' }} onDismiss={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders kicker, text, detail and dismiss button', () => {
    const onDismiss = vi.fn();
    render(
      <RunNoticeBar
        runNotice={{
          text: '连接超时',
          detail: '504 Gateway Timeout',
          kind: 'error',
          persistent: true,
        }}
        onDismiss={onDismiss}
      />
    );

    const notice = screen.getByTestId('run-notice');
    expect(notice).toBeDefined();
    expect(notice.getAttribute('data-persistent')).toBe('true');
    expect(notice.getAttribute('aria-live')).toBe('assertive');

    expect(screen.getByText('运行提示')).toBeDefined();
    expect(screen.getByTestId('run-notice-text').textContent).toBe('连接超时');
    expect(screen.getByText('504 Gateway Timeout')).toBeDefined();

    const dismissBtn = screen.getByRole('button', { name: '关闭提示' });
    fireEvent.click(dismissBtn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
