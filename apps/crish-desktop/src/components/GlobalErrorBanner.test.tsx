// @vitest-environment jsdom
/**
 * GlobalErrorBanner 单测（T5-4 全局错误呈现面）：
 * - errorStore 存在 GLOBAL_UNCAUGHT_ERROR 活跃错误 → 横幅可见（文案 +
 *   technical 详情可展开）；
 * - dismiss → 横幅消失（resolveByCode）；
 * - 无该 code 错误 → 零渲染（不挂幽灵条）。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GlobalErrorBanner } from './GlobalErrorBanner';
import { errorStore } from '../services/ErrorStore';

const CODE = 'GLOBAL_UNCAUGHT_ERROR';

beforeEach(() => {
  errorStore.resolveByCode(CODE);
});

afterEach(() => {
  errorStore.resolveByCode(CODE);
});

function pushGlobalError(technical?: string): void {
  errorStore.push({
    code: CODE,
    module: 'TelemetryMonitor',
    severity: 'error',
    message: '发生一次未预期的错误',
    ...(technical !== undefined ? { technical } : {}),
  });
}

describe('GlobalErrorBanner（T5-4）', () => {
  it('无 GLOBAL_UNCAUGHT_ERROR 活跃错误 → 零渲染', () => {
    const { container } = render(<GlobalErrorBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('存在活跃全局错误 → 横幅可见（文案 + 详情可展开）', () => {
    pushGlobalError('Error: boom\n    at fn (a.js:1:1)');
    const { container } = render(<GlobalErrorBanner />);
    const banner = container.querySelector('[data-global-error-banner="true"]');
    expect(banner).toBeTruthy();
    expect(screen.getByText('发生一次未预期的错误')).toBeTruthy();
    // technical 经 <details> 折叠（默认收起，文本不在视区但存在于 DOM）
    const details = container.querySelector('details');
    expect(details).toBeTruthy();
    expect(container.textContent).toContain('Error: boom');
    // 非阻塞形态：role=status（非 alertdialog），不打断交互
    expect(banner?.getAttribute('role')).toBe('status');
  });

  it('dismiss（知道了）→ resolveByCode 关闭横幅', () => {
    pushGlobalError('boom');
    const { container, rerender } = render(<GlobalErrorBanner />);
    expect(
      container.querySelector('[data-global-error-banner="true"]')
    ).toBeTruthy();

    fireEvent.click(screen.getByText('知道了'));
    rerender(<GlobalErrorBanner />);
    expect(
      container.querySelector('[data-global-error-banner="true"]')
    ).toBeNull();
  });

  it('同 code 错误合并：再次 push 更新 timestamp，不产生第二条活跃错误', () => {
    pushGlobalError('first');
    pushGlobalError('second');
    render(<GlobalErrorBanner />);
    expect(screen.getAllByText('发生一次未预期的错误')).toHaveLength(1);
  });
});
