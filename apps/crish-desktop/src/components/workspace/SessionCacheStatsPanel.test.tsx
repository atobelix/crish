// @vitest-environment jsdom
/**
 * SessionCacheStatsPanel 组件测试（重建——原测试文件在 F12 批量补环境
 * 注释时被编码工具损坏（GBK 解码断裂字符串字面量），本文件按组件 API
 * 重写，覆盖组件头注释契约）。
 *
 * 契约：stats=null → 空态「暂无缓存统计数据」；stats 非 null → 命中率
 * （hitRatio 优先/hitRate 兼容）/读/写 token；coldHint → 冷缓存提示条；
 * alerts 非空 → 浪费预警列表。
 */
import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SessionCacheStatsPanel } from './SessionCacheStatsPanel';
import type { CacheMetrics } from '@crish/shared-types';

afterEach(cleanup);

describe('SessionCacheStatsPanel', () => {
  it('stats 为 null 时渲染空态', () => {
    render(<SessionCacheStatsPanel stats={null} />);
    expect(screen.getByTestId('session-cache-stats').textContent).toContain('暂无缓存统计数据');
  });

  it('命中率优先 hitRatio 并展示读写 token', () => {
    const stats: CacheMetrics = {
      hitRatio: 0.5,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
    };
    render(<SessionCacheStatsPanel stats={stats} />);
    expect(screen.getByTestId('session-cache-stats').textContent).toContain('命中率 50%');
    expect(screen.getByTestId('session-cache-stats').textContent).toContain('读 100 · 写 50');
  });

  it('hitRatio 缺失时回退 hitRate', () => {
    render(
      <SessionCacheStatsPanel
        stats={{ hitRate: 0.25, cacheReadTokens: 10, cacheWriteTokens: 5 } as CacheMetrics}
      />
    );
    expect(screen.getByTestId('session-cache-stats').textContent).toContain('命中率 25%');
  });

  it('coldHint 渲染冷缓存提示条', () => {
    render(
      <SessionCacheStatsPanel
        stats={{ cacheReadTokens: 0, cacheWriteTokens: 0 } as CacheMetrics}
        coldHint={{ resendEstimateTokens: 1200 }}
      />
    );
    expect(screen.getByTestId('cold-cache-hint').textContent).toContain('1,200');
  });

  it('alerts 非空时渲染浪费预警列表', () => {
    render(
      <SessionCacheStatsPanel
        stats={{ cacheReadTokens: 0, cacheWriteTokens: 0 } as CacheMetrics}
        alerts={[{ runId: 'r1', attribution: 'tool', missedTokens: 500 }]}
      />
    );
    expect(screen.getByTestId('cache-waste-alerts').textContent).toContain('500');
  });
});
