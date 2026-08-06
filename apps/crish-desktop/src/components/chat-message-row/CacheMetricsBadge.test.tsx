// @vitest-environment jsdom
/**
 * CacheMetricsBadge 组件测试（重建——原测试文件在 F12 批量补环境注释时
 * 被编码工具损坏（GBK 解码断裂字符串字面量），本文件按组件 API 重写）。
 *
 * 契约（组件头注释）：metrics=null → 渲染 null；命中率优先 hitRatio、
 * 回退 hitRate；ratio 为 0/未上报 → 「未命中」而非 0%。
 */
import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CacheMetricsBadge } from './CacheMetricsBadge';
import type { CacheMetrics } from '@crish/shared-types';

afterEach(cleanup);

describe('CacheMetricsBadge', () => {
  it('metrics 为 null 时渲染 null（隐藏而非 0%）', () => {
    const { container } = render(<CacheMetricsBadge metrics={null} />);
    expect(container.querySelector('[data-testid="cache-metrics-badge"]')).toBeNull();
  });

  it('命中率优先读 hitRatio 并展示百分比与读写 token', () => {
    const metrics: CacheMetrics = {
      hitRatio: 0.5,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
    };
    render(<CacheMetricsBadge metrics={metrics} />);
    expect(screen.getByTestId('cache-metrics-badge').textContent).toContain('缓存命中 50%');
    expect(screen.getByTestId('cache-metrics-badge').textContent).toContain('读 100');
    expect(screen.getByTestId('cache-metrics-badge').textContent).toContain('写 50');
  });

  it('hitRatio 缺失时回退 hitRate 兼容别名', () => {
    const metrics: CacheMetrics = {
      hitRate: 0.25,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    };
    render(<CacheMetricsBadge metrics={metrics} />);
    expect(screen.getByTestId('cache-metrics-badge').textContent).toContain('缓存命中 25%');
  });

  it('命中率为 0 或未上报时显示「未命中」而非 0%', () => {
    render(
      <CacheMetricsBadge
        metrics={{ cacheReadTokens: 0, cacheWriteTokens: 0 } as CacheMetrics}
      />
    );
    expect(screen.getByTestId('cache-metrics-badge').textContent).toContain('未命中');
  });
});
