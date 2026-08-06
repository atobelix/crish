/**
 * cacheEventsStore 测试（T-48）。
 *
 * 会话级缓存统计面板数据源：cache-stats-updated 累计、cache-waste-alert
 * 入列去重、cold-cache-warning / warmUntilMs tick 冷缓存提示（每 run 一次）。
 * null 语义（P6 C15）：无事件 → runStats 恒 null（面板空态隐藏）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  accumulateRunStats,
  MAX_PANEL_ALERTS,
  runStatsToCacheMetrics,
  useCacheEventsStore,
} from './cacheEventsStore';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { CacheMetrics, RunCacheStats } from '@crish/shared-types';

function makeStats(overrides?: Partial<RunCacheStats>): RunCacheStats {
  return {
    promptTokens: 12000,
    completionTokens: 400,
    totalTokens: 12400,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissTokens: 12000,
    sampleCount: 1,
    missedTokens: 0,
    ...overrides,
  };
}

beforeEach(() => {
  useCacheEventsStore.setState({
    runStats: null,
    lastRunStats: null,
    lastRunId: '',
    alerts: [],
    coldHint: null,
    coldWarnedRunIds: [],
  });
});

describe('runStatsToCacheMetrics（C9：inputTotal = miss + read + write）', () => {
  it('hitRatio = read / inputTotal；0 是合法报告值', () => {
    const m = runStatsToCacheMetrics(
      makeStats({ cacheReadTokens: 9000, cacheWriteTokens: 500, cacheMissTokens: 2500 })
    );
    expect(m.inputTotal).toBe(12000);
    expect(m.hitRatio).toBeCloseTo(0.75);
    const zero = runStatsToCacheMetrics(makeStats());
    expect(zero.hitRatio).toBe(0);
  });

  it('全零统计 → inputTotal 0，不写 hitRatio（未上报隐藏而非 0%）', () => {
    const m = runStatsToCacheMetrics(
      makeStats({
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheMissTokens: 0,
        promptTokens: 0,
      })
    );
    expect(m.inputTotal).toBeUndefined();
    expect(m.hitRatio).toBeUndefined();
  });

  it('warmUntilMs 透出（冷缓存 tick 数据源）', () => {
    const m = runStatsToCacheMetrics(makeStats({ warmUntilMs: 12345 }));
    expect(m.warmUntilMs).toBe(12345);
  });
});

describe('accumulateRunStats（用例①面板累计）', () => {
  it('多 run 累计 read/write/miss 并重算 hitRatio', () => {
    const r1 = runStatsToCacheMetrics(makeStats());
    const r2 = runStatsToCacheMetrics(
      makeStats({ cacheReadTokens: 10500, cacheMissTokens: 3500 })
    );
    const acc = accumulateRunStats(r1, r2);
    expect(acc.cacheReadTokens).toBe(10500);
    expect(acc.cacheMissTokens).toBe(15500);
    expect(acc.inputTotal).toBe(26000);
    // 10500 / 26000（0 → 40.4% 递增）
    expect(acc.hitRatio).toBeCloseTo(10500 / 26000);
  });

  it('空统计不参与累计', () => {
    const empty = runStatsToCacheMetrics(
      makeStats({
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheMissTokens: 0,
        promptTokens: 0,
      })
    );
    const acc = accumulateRunStats(null, empty);
    expect(acc.cacheReadTokens).toBe(0);
    expect(acc.inputTotal).toBeUndefined();
  });
});

describe('useCacheEventsStore（事件 → store 展示链路）', () => {
  it('applyRunStats：累计 + 最近一 run 记录（warmUntilMs）', () => {
    const s = useCacheEventsStore.getState();
    s.applyRunStats(
      makeStats({ cacheReadTokens: 10500, cacheMissTokens: 3500, warmUntilMs: 9876 }),
      'run-a'
    );
    const st = useCacheEventsStore.getState();
    expect(st.runStats?.cacheReadTokens).toBe(10500);
    expect(st.runStats?.hitRatio).toBeCloseTo(0.75);
    expect(st.lastRunStats?.warmUntilMs).toBe(9876);
    expect(st.lastRunId).toBe('run-a');
  });

  it('pushWasteAlert：同 run 同归因去重、超上限丢最旧', () => {
    const s = useCacheEventsStore.getState();
    for (let i = 0; i < MAX_PANEL_ALERTS + 2; i++) {
      s.pushWasteAlert({
        runId: `run-${i}`,
        attribution: 'prefix-changed',
        missedTokens: 20000 + i,
      });
    }
    let st = useCacheEventsStore.getState();
    expect(st.alerts.length).toBe(MAX_PANEL_ALERTS);
    // 去重：同 run 同归因不重复入列
    st.pushWasteAlert({
      runId: 'run-5',
      attribution: 'prefix-changed',
      missedTokens: 999,
    });
    st = useCacheEventsStore.getState();
    expect(st.alerts.length).toBe(MAX_PANEL_ALERTS);
  });

  it('setColdHint（事件路径）：提示置位且该 run 记已提示', () => {
    const s = useCacheEventsStore.getState();
    s.setColdHint({ runId: 'run-cold', resendEstimateTokens: 14000 });
    const st = useCacheEventsStore.getState();
    expect(st.coldHint?.resendEstimateTokens).toBe(14000);
    expect(st.coldWarnedRunIds).toContain('run-cold');
  });

  it('tickColdCheck：warmUntilMs 过期 → 提示且每 run 只一次', () => {
    const s = useCacheEventsStore.getState();
    s.applyRunStats(
      makeStats({ warmUntilMs: 1000, cacheReadTokens: 5000, cacheMissTokens: 9000 }),
      'run-tick'
    );
    // now > warmUntilMs：首次 tick 产生提示
    expect(useCacheEventsStore.getState().tickColdCheck(2000)).toBe(true);
    let st = useCacheEventsStore.getState();
    expect(st.coldHint?.runId).toBe('run-tick');
    expect(st.coldHint?.resendEstimateTokens).toBe(14000);
    // 再次 tick：不再重复提示
    expect(useCacheEventsStore.getState().tickColdCheck(3000)).toBe(false);
    st = useCacheEventsStore.getState();
    expect(st.coldHint?.resendEstimateTokens).toBe(14000);
  });

  it('tickColdCheck：warmUntilMs 未过期 / 缺失 → 不提示', () => {
    const s = useCacheEventsStore.getState();
    s.applyRunStats(makeStats({ warmUntilMs: 99999 }), 'run-future');
    expect(useCacheEventsStore.getState().tickColdCheck(2000)).toBe(false);
    expect(useCacheEventsStore.getState().coldHint).toBeNull();
    s.applyRunStats(makeStats(), 'run-none');
    expect(useCacheEventsStore.getState().tickColdCheck(999999)).toBe(false);
  });
});
