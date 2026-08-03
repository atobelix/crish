// T-42 验收测试：缓存计量契约的序列化形状断言（camelCase、null 语义）。
// 类型级拒绝断言用 `@ts-expect-error`（由 `npm run typecheck` 校验：
// 无错误会报 TS2578），运行时断言由 vitest 校验。

import { describe, expect, it } from 'vitest';
import type {
  CacheBreakdown,
  CacheMetrics,
  CacheUsage,
  MessageCacheState,
  RunCacheStats,
  SessionCacheSnapshot,
  UsageMetadataShape,
} from './index';

describe('CacheBreakdown（对齐 Rust CacheBreakdown camelCase）', () => {
  it('wire 键为 read/write/miss/inputTotal（无 snake_case 键）', () => {
    const breakdown: CacheBreakdown = {
      read: 70,
      write: 10,
      miss: 20,
      inputTotal: 100,
    };
    expect(Object.keys(breakdown)).toEqual([
      'read',
      'write',
      'miss',
      'inputTotal',
    ]);
    expect(JSON.stringify(breakdown)).toContain('"inputTotal"');
    expect(JSON.stringify(breakdown)).not.toContain('input_total');
  });

  it('全可选：空对象与部分字段对象均合法（宽容挂载点）', () => {
    const empty: CacheBreakdown = {};
    expect(empty).toEqual({});
    const partial: CacheBreakdown = { read: 1, inputTotal: 1 };
    expect(partial.inputTotal).toBe(1);
  });

  it('类型拒绝 snake_case 键（Rust serde camelCase 双向一致）', () => {
    // @ts-expect-error —— Rust `input_total` 在 TS 契约面必须写 camelCase
    const bad: CacheBreakdown = { read: 1, input_total: 2 };
    expect(bad).toBeDefined();
  });
});

describe('CacheMetrics（全可选 + null 语义）', () => {
  it('全可选：空对象合法（未上报时挂空指标）', () => {
    const empty: CacheMetrics = {};
    expect(empty.hitRatio).toBeUndefined();
  });

  it('null 语义：null = 未上报，0 = 确已上报且为 0，两者可区分', () => {
    const notReported: CacheMetrics = { hitRatio: null, warmUntilMs: null };
    const reportedZero: CacheMetrics = { hitRatio: 0, warmUntilMs: 0 };
    expect(notReported.hitRatio === null).toBe(true);
    expect(reportedZero.hitRatio === null).toBe(false);
    expect(reportedZero.hitRatio).toBe(0);
    // 渲染层判定：metrics/hitRatio 为 null → 隐藏；为 0 → 显示"未命中"态
    const shouldHide = (m: CacheMetrics): boolean =>
      m.hitRatio === undefined || m.hitRatio === null;
    expect(shouldHide(notReported)).toBe(true);
    expect(shouldHide(reportedZero)).toBe(false);
  });

  it('字段名与 Rust RunCacheStats camelCase 对齐（全量可构造）', () => {
    const full: CacheMetrics = {
      cacheReadTokens: 9000,
      cacheWriteTokens: 500,
      cacheMissTokens: 2500,
      inputTotal: 12000,
      hitRatio: 0.75,
      writeRatio: 0.0417,
      missedTokens: 0,
      sampleCount: 1,
      warmUntilMs: 1750000000000,
    };
    expect(full.hitRatio).toBeCloseTo(0.75, 5);
    expect(full.inputTotal).toBe(12000);
  });

  it('hitRate 兼容别名可承载 T-41 computeCacheMetrics 产出形状', () => {
    const fromT41 = {
      cacheReadTokens: 9000,
      cacheWriteTokens: 500,
      cacheMissTokens: 2500,
      hitRate: 0.75,
      writeRatio: 0.0417,
      session: null,
      savingsUsd: null,
    } satisfies CacheMetrics;
    expect(fromT41.hitRate).toBeCloseTo(0.75, 5);
  });

  it('session 快照形状与 P6 §3.3.1 对齐（P6 阶段恒 null）', () => {
    const session: SessionCacheSnapshot = {
      cacheReadTokens: 9000,
      cacheWriteTokens: 500,
      inputTokens: 12000,
      hitRatio: 0.75,
    };
    expect(session.hitRatio).toBeCloseTo(0.75, 5);
    const pending: CacheMetrics = { session: null };
    expect(pending.session).toBeNull();
  });

  it('类型拒绝字符串命中率与 snake_case 字段', () => {
    // @ts-expect-error —— 命中率必须是数值（null 表示未上报）
    const badRatio: CacheMetrics = { hitRatio: '0.75' };
    expect(badRatio).toBeDefined();
    // @ts-expect-error —— Rust `cache_read_tokens` 在 TS 契约面必须写 camelCase
    const badSnake: CacheMetrics = { cache_read_tokens: 1 };
    expect(badSnake).toBeDefined();
  });
});

describe('RunCacheStats（re-export 自 ./events，T-38 同步，camelCase 对齐）', () => {
  it('12 字段键名与 Rust RunCacheStats serde camelCase 一一对应', () => {
    const stats: RunCacheStats = {
      promptTokens: 12000,
      completionTokens: 400,
      totalTokens: 12400,
      cacheReadTokens: 9000,
      cacheWriteTokens: 500,
      cacheMissTokens: 2500,
      sampleCount: 1,
      hitRatio: 0.75,
      writeRatio: 0.0417,
      missedTokens: 0,
      warmUntilMs: 1750000000000,
    };
    expect(Object.keys(stats)).toEqual([
      'promptTokens',
      'completionTokens',
      'totalTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'cacheMissTokens',
      'sampleCount',
      'hitRatio',
      'writeRatio',
      'missedTokens',
      'warmUntilMs',
    ]);
  });

  it('比例/时间字段未上报语义：类型面字段省略 = undefined（events.ts 注释同源；null 为解析器宽容输入，运行时容忍）', () => {
    const stats: RunCacheStats = {};
    expect(stats.hitRatio).toBeUndefined();
    expect(stats.writeRatio).toBeUndefined();
    expect(stats.warmUntilMs).toBeUndefined();
    const reported: RunCacheStats = { hitRatio: 0.75 };
    expect(reported.hitRatio).toBe(0.75);
  });

  it('类型拒绝 snake_case 字段', () => {
    // @ts-expect-error —— Rust `prompt_tokens` 在 TS 契约面必须写 camelCase
    const bad: RunCacheStats = { prompt_tokens: 1 };
    expect(bad).toBeDefined();
  });
});

describe('MessageCacheState / CacheUsage / UsageMetadataShape', () => {
  it('metrics: null = 老数据/无 cache 字段 → 渲染层隐藏（非 0% 误导）', () => {
    const legacy: MessageCacheState = { metrics: null, source: null };
    expect(legacy.metrics).toBeNull();
    // 渲染层判定：metrics === null → 不渲染
    expect(legacy.metrics === null).toBe(true);
  });

  it('source 枚举：engine-message-end / degraded-direct / null', () => {
    const fromEngine: MessageCacheState = {
      metrics: { hitRatio: 0.75 },
      source: 'engine-message-end',
    };
    const fromDegraded: MessageCacheState = {
      metrics: { hitRatio: 0.75 },
      source: 'degraded-direct',
    };
    expect(fromEngine.source).toBe('engine-message-end');
    expect(fromDegraded.source).toBe('degraded-direct');
    // @ts-expect-error —— source 只能是注册的三值
    const badSource: MessageCacheState = { metrics: null, source: 'unknown' };
    expect(badSource).toBeDefined();
  });

  it('CacheUsage 全可选（metadata.usage 宽容挂载点）', () => {
    const empty: CacheUsage = {};
    const full: CacheUsage = {
      promptTokens: 12000,
      completionTokens: 400,
      cacheReadTokens: 9000,
      cacheWriteTokens: 500,
      cacheMissTokens: 2500,
      reasoningTokens: 60,
    };
    expect(empty).toEqual({});
    expect(full.cacheMissTokens).toBe(2500);
  });

  it('UsageMetadataShape 承载 metadata.usage（Rust build_assistant_message 产出）', () => {
    const meta: UsageMetadataShape = {
      usage: { promptTokens: 12000, cacheReadTokens: 9000 },
    };
    expect(meta.usage?.cacheReadTokens).toBe(9000);
    const emptyMeta: UsageMetadataShape = {};
    expect(emptyMeta.usage).toBeUndefined();
  });
});
