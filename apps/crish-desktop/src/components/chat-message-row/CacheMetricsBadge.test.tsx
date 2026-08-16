// @vitest-environment jsdom
/**
 * CacheMetricsBadge 四态语义测试。
 *
 * 契约：
 * - 态 1：metrics 为 null 或全 0 时渲染 null（隐藏）；
 * - 态 2：read > 0 时渲染「⚡ 缓存命中」并包含读/写 token 与百分比；
 * - 态 3：write > 0 且 read === 0 时渲染「💾 写入缓存」；
 * - 态 4：read === 0 且 write === 0 但存在输入总量时渲染「未命中」。
 */
import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CacheMetricsBadge } from './CacheMetricsBadge';
import type { CacheMetrics } from '@crish/shared-types';

afterEach(cleanup);

describe('CacheMetricsBadge 四态渲染测试', () => {
  it('态 1：metrics 为 null 时渲染 null（隐藏而非 0%）', () => {
    const { container } = render(<CacheMetricsBadge metrics={null} />);
    expect(
      container.querySelector('[data-testid="cache-metrics-badge"]')
    ).toBeNull();
  });

  it('态 2：命中率优先读 hitRatio 并展示百分比与读写 token', () => {
    const metrics: CacheMetrics = {
      hitRatio: 0.5,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
    };
    render(<CacheMetricsBadge metrics={metrics} />);
    const badge = screen.getByTestId('cache-metrics-badge');
    expect(badge.textContent).toContain('缓存命中 50%');
    expect(badge.textContent).toContain('读 100');
    expect(badge.textContent).toContain('写 50');
    expect(badge.getAttribute('data-state')).toBe('hit');
  });

  it('态 2：hitRatio 缺失时回退 hitRate 兼容别名', () => {
    const metrics: CacheMetrics = {
      hitRate: 0.25,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    };
    render(<CacheMetricsBadge metrics={metrics} />);
    expect(screen.getByTestId('cache-metrics-badge').textContent).toContain(
      '缓存命中 25%'
    );
  });

  it('态 3：首轮写入态 (write > 0 且 read === 0) 渲染「💾 写入缓存」', () => {
    const metrics: CacheMetrics = {
      cacheReadTokens: 0,
      cacheWriteTokens: 1250,
      inputTotal: 1250,
    };
    render(<CacheMetricsBadge metrics={metrics} />);
    const badge = screen.getByTestId('cache-metrics-badge');
    expect(badge.textContent).toContain('写入缓存 1,250');
    expect(badge.getAttribute('data-state')).toBe('write');
  });

  it('态 4：显式未命中时显示「未命中」而非 0%', () => {
    render(
      <CacheMetricsBadge
        metrics={
          {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            inputTotal: 500,
          } as CacheMetrics
        }
      />
    );
    const badge = screen.getByTestId('cache-metrics-badge');
    expect(badge.textContent).toContain('未命中');
    expect(badge.getAttribute('data-state')).toBe('miss');
  });
});
