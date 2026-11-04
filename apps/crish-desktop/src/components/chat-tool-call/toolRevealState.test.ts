// @vitest-environment jsdom
/**
 * AN4 · toolRevealState 单元钉：
 * - 入场门（未入场 / 实况窗口 [-500,2000) / 非结构直换 / 非降级 /
 *   调用方未就绪）；
 * - batch 交错认领：同批 50ms 步进、6 行封顶、总延时 ≤300ms、
 *   批次间隔后重新计数；
 * - 输出揭示分类与时长：≤240 直出、带内排空、>4600 淡入；
 *   时长 = 量 / steadyCap(2600) 夹进 [150, 900]ms；
 * - 排空注册表：settle 让位、unregister 通知全-settle 订阅者；
 * - 呈现/交互登记语义。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetToolRevealStateForTesting,
  AUTO_COLLAPSE_DRAIN_WAIT_CAP_MS,
  claimEntranceDelay,
  classifyOutputReveal,
  decideEntrance,
  DRAIN_BAND_MAX_CHARS,
  drainDurationMs,
  hasActiveToolDrain,
  hasPresentedOutput,
  hasToolInteracted,
  markEntered,
  markPresentedOutput,
  markToolInteracted,
  onAllToolDrainsSettled,
  registerToolDrain,
  settleToolReveal,
  unregisterToolDrain,
} from './toolRevealState';
import { TEXT_REVEAL_PACING } from '../../utils/revealPacing';

function mockReducedMotion(reduced: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const NOW = 10_000_000;

beforeEach(() => {
  _resetToolRevealStateForTesting();
  mockReducedMotion(false);
  document.documentElement.removeAttribute('data-perf-tier');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('decideEntrance · 入场门（分析 §五）', () => {
  it('实况新键入场，同键只入场一次', () => {
    expect(decideEntrance({ key: 'k1', eventTs: NOW - 100, now: NOW })).toBe(
      true
    );
    markEntered('k1');
    expect(decideEntrance({ key: 'k1', eventTs: NOW - 100, now: NOW })).toBe(
      false
    );
  });

  it('实况窗口边界：[-500, 2000)', () => {
    expect(decideEntrance({ key: 'a', eventTs: NOW + 500, now: NOW })).toBe(
      true
    );
    expect(decideEntrance({ key: 'b', eventTs: NOW + 501, now: NOW })).toBe(
      false
    );
    expect(decideEntrance({ key: 'c', eventTs: NOW - 1999, now: NOW })).toBe(
      true
    );
    expect(decideEntrance({ key: 'd', eventTs: NOW - 2000, now: NOW })).toBe(
      false
    );
    expect(decideEntrance({ key: 'e', eventTs: NOW - 60_000, now: NOW })).toBe(
      false
    );
  });

  it('结构直换 replaceHit 与调用方 disabled 均不入场', () => {
    expect(
      decideEntrance({ key: 'k2', eventTs: NOW, now: NOW, replaceHit: true })
    ).toBe(false);
    expect(
      decideEntrance({ key: 'k3', eventTs: NOW, now: NOW, disabled: true })
    ).toBe(false);
  });

  it('Reduce Motion 命中不入场（降级旁路）', () => {
    mockReducedMotion(true);
    expect(decideEntrance({ key: 'k4', eventTs: NOW, now: NOW })).toBe(false);
  });

  it('eco 性能档单独命中不降级（X1 解耦：减动效只认系统设置）', () => {
    document.documentElement.dataset.perfTier = 'eco';
    expect(decideEntrance({ key: 'k5', eventTs: NOW, now: NOW })).toBe(true);
    delete document.documentElement.dataset.perfTier;
  });

  it('空键、无时间戳永不入场', () => {
    expect(decideEntrance({ key: '', eventTs: NOW, now: NOW })).toBe(false);
    expect(decideEntrance({ key: 'k6', now: NOW })).toBe(false);
  });
});

describe('claimEntranceDelay · batch 交错（50ms/行、≤300ms）', () => {
  it('同批领取：0,50,…,250，第 7 行起零延时', () => {
    const delays = Array.from({ length: 8 }, () => claimEntranceDelay(NOW));
    expect(delays).toEqual([0, 50, 100, 150, 200, 250, 0, 0]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(300);
  });

  it('批次间隔（>120ms）后重新计数', () => {
    expect(claimEntranceDelay(NOW)).toBe(0);
    expect(claimEntranceDelay(NOW + 10)).toBe(50);
    expect(claimEntranceDelay(NOW + 200)).toBe(0);
    expect(claimEntranceDelay(NOW + 210)).toBe(50);
  });
});

describe('classifyOutputReveal / drainDurationMs · 量级带与时长', () => {
  it('分类边界：≤engage 门槛直出、带内排空、带外淡入', () => {
    const th = TEXT_REVEAL_PACING.engageThresholdChars;
    expect(th).toBe(240);
    expect(classifyOutputReveal(th)).toBe('direct');
    expect(classifyOutputReveal(th + 1)).toBe('drain');
    expect(classifyOutputReveal(DRAIN_BAND_MAX_CHARS)).toBe('drain');
    expect(classifyOutputReveal(DRAIN_BAND_MAX_CHARS + 1)).toBe('fade');
  });

  it('时长 = 量 / steadyCap 速率，夹进 [150, 900]ms', () => {
    const cap = TEXT_REVEAL_PACING.steadyCapCharsPerSec;
    expect(cap).toBe(2600);
    expect(drainDurationMs(1300)).toBe((1300 / cap) * 1000);
    expect(drainDurationMs(241)).toBe(150);
    expect(drainDurationMs(DRAIN_BAND_MAX_CHARS)).toBe(900);
  });

  it('自动折叠硬顶与排空总时长上限同值（900ms）', () => {
    expect(AUTO_COLLAPSE_DRAIN_WAIT_CAP_MS).toBe(900);
  });
});

describe('排空注册表 · settle / 订阅协调', () => {
  it('register → active；settleToolReveal 调用其 settle（让位）', () => {
    const settle = vi.fn();
    registerToolDrain('d1', settle);
    expect(hasActiveToolDrain('d1')).toBe(true);
    settleToolReveal('d1');
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('unregister 触发全-settle 订阅（多工具全部注销后才回调一次）', () => {
    const onAll = vi.fn();
    registerToolDrain('d2', vi.fn());
    registerToolDrain('d3', vi.fn());
    onAllToolDrainsSettled(['d2', 'd3'], onAll);
    unregisterToolDrain('d2');
    expect(onAll).not.toHaveBeenCalled();
    unregisterToolDrain('d3');
    expect(onAll).toHaveBeenCalledTimes(1);
    unregisterToolDrain('d3');
    expect(onAll).toHaveBeenCalledTimes(1);
  });

  it('取消订阅后 unregister 不再回调', () => {
    const onAll = vi.fn();
    registerToolDrain('d4', vi.fn());
    const unsub = onAllToolDrainsSettled(['d4'], onAll);
    unsub();
    unregisterToolDrain('d4');
    expect(onAll).not.toHaveBeenCalled();
  });

  it('呈现与交互登记', () => {
    expect(hasPresentedOutput('t9')).toBe(false);
    markPresentedOutput('t9');
    expect(hasPresentedOutput('t9')).toBe(true);
    expect(hasToolInteracted('t9')).toBe(false);
    markToolInteracted('t9');
    expect(hasToolInteracted('t9')).toBe(true);
  });
});
