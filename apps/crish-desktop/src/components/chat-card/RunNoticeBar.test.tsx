/**
 * RunNoticeBar：persistent 变体渲染标记（data-persistent，供恢复驱动/测试断言）。
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunNoticeBar } from './RunNoticeBar';

describe('RunNoticeBar persistent 变体', () => {
  it('persistent notice 渲染 data-persistent=true', () => {
    render(
      <RunNoticeBar
        runNotice={{
          text: '服务暂时不可用，正在自动恢复，请稍后再试。',
          kind: 'network',
          persistent: true,
        }}
        onDismiss={vi.fn()}
      />
    );
    const bar = screen.getByTestId('run-notice');
    expect(bar).toHaveAttribute('data-persistent', 'true');
    expect(screen.getByTestId('run-notice-text').textContent).toBe(
      '服务暂时不可用，正在自动恢复，请稍后再试。'
    );
  });

  it('非 persistent notice 不渲染 data-persistent', () => {
    render(
      <RunNoticeBar
        runNotice={{ text: '这一轮没有文字回复。', kind: 'empty' }}
        onDismiss={vi.fn()}
      />
    );
    const bar = screen.getByTestId('run-notice');
    expect(bar).not.toHaveAttribute('data-persistent');
  });
});
