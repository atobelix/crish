// @vitest-environment jsdom
/**
 * LiveTasksSection（RuntimePanel 活动任务区段）G² 挂载断言（第二波收口补）。
 *
 * 覆盖点：
 * - Tooltip 包裹的可点行挂 G2Surface control 档（8px），与 .row 的 CSS 兜底（--radius-md）同值
 * - 无会话行不包 Tooltip、仍挂 G2Surface control 档
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LiveTasksSection } from './LiveTasksSection';
import type { LiveTask } from './useRuntimePanelData';

afterEach(() => {
  cleanup();
});

function task(overrides: Partial<LiveTask> = {}): LiveTask {
  return {
    id: 'wk-1',
    taskName: '构建前端',
    elapsedSeconds: 42,
    sessionId: 'sess-1',
    kind: 'session',
    ...overrides,
  };
}

describe('LiveTasksSection G² 形状层', () => {
  it('Tooltip 包裹的可点行挂 G2Surface：control 档 8px', () => {
    const onFocusSession = vi.fn();
    const { container } = render(
      <LiveTasksSection
        liveTasks={[task()]}
        countLabel="1 个进行中"
        onFocusSession={onFocusSession}
      />
    );
    const rows = container.querySelectorAll('[data-g2-radius="control"]');
    expect(rows.length).toBe(1);
    const row = rows[0] as HTMLElement;
    expect(row.getAttribute('role')).toBe('button');
    expect(row.style.borderRadius).toBe('8px');
    expect(row.textContent).toContain('构建前端');
  });

  it('无会话行不包 Tooltip、仍挂 G2Surface control 档', () => {
    const onFocusSession = vi.fn();
    const { container } = render(
      <LiveTasksSection
        liveTasks={[task({ sessionId: undefined })]}
        countLabel="1 个进行中"
        onFocusSession={onFocusSession}
      />
    );
    const rows = container.querySelectorAll('[data-g2-radius="control"]');
    expect(rows.length).toBe(1);
    const row = rows[0] as HTMLElement;
    expect(row.getAttribute('role')).toBe('listitem');
    expect(row.style.borderRadius).toBe('8px');
  });
});
