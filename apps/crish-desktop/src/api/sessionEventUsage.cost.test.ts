// @vitest-environment jsdom
/**
 * plans/05 T5.6 前端测：parseRunSnapshotUsage cost 三态 + applyUsageDelta 引擎累计。
 * 断言对象 = 引擎 CostBreakdown 的 wire 形状（camelCase）与三态文案，不是 JS 浮点。
 */
import { describe, expect, it } from 'vitest';
import {
  applyUsageDelta,
  parseRunSnapshotUsage,
  type UsageDeltaState,
} from './sessionEventUsage';

const emptyState: UsageDeltaState = {
  input: 0,
  output: 0,
  costStatus: 'unpriced',
  cost: 0,
  inputMax: 160000,
  outputMax: 40000,
};

describe('parseRunSnapshotUsage cost 三态', () => {
  it('引擎有价账（USD）→ cost 解析为 RunUsageCost', () => {
    const parsed = parseRunSnapshotUsage({
      snapshot: {
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          sampleCount: 1,
          cost: {
            currency: 'USD',
            inputMicros: 60000,
            outputMicros: 45000,
            cacheReadMicros: 0,
            cacheWriteMicros: 0,
            totalMicros: 105000,
            formattedTotal: '$0.1050',
            isFree: false,
          },
        },
      },
    });
    expect(parsed?.cost?.currency).toBe('USD');
    expect(parsed?.cost?.totalMicros).toBe(105000);
    expect(parsed?.cost?.formattedTotal).toBe('$0.1050');
    expect(parsed?.cost?.isFree).toBe(false);
  });

  it('引擎免费账 → cost.isFree 为 true', () => {
    const parsed = parseRunSnapshotUsage({
      snapshot: {
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          sampleCount: 1,
          cost: {
            currency: 'CNY',
            inputMicros: 0,
            outputMicros: 0,
            cacheReadMicros: 0,
            cacheWriteMicros: 0,
            totalMicros: 0,
            formattedTotal: '免费',
            isFree: true,
          },
        },
      },
    });
    expect(parsed?.cost?.isFree).toBe(true);
  });

  it('无 cost 字段（未定价）→ cost 为 undefined', () => {
    const parsed = parseRunSnapshotUsage({
      snapshot: {
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          sampleCount: 1,
        },
      },
    });
    expect(parsed?.cost).toBeUndefined();
  });
});

describe('applyUsageDelta 引擎三态累计', () => {
  it('有价账 → costStatus priced + formattedTotal 原样', () => {
    const next = applyUsageDelta(emptyState, {
      promptTokens: 100,
      completionTokens: 50,
      cost: {
        currency: 'CNY',
        inputMicros: 60000,
        outputMicros: 45000,
        cacheReadMicros: 0,
        cacheWriteMicros: 0,
        totalMicros: 105000,
        formattedTotal: '¥0.1050',
        isFree: false,
      },
    });
    expect(next.costStatus).toBe('priced');
    expect(next.currency).toBe('CNY');
    expect(next.costMicros).toBe(105000);
    expect(next.formattedCost).toBe('¥0.1050');
  });

  it('同币种累计 micros，formatted 更新为最近一次', () => {
    const first = applyUsageDelta(emptyState, {
      promptTokens: 100,
      completionTokens: 0,
      cost: {
        currency: 'CNY',
        inputMicros: 100000,
        outputMicros: 0,
        cacheReadMicros: 0,
        cacheWriteMicros: 0,
        totalMicros: 100000,
        formattedTotal: '¥0.1000',
        isFree: false,
      },
    });
    const second = applyUsageDelta(first, {
      promptTokens: 100,
      completionTokens: 0,
      cost: {
        currency: 'CNY',
        inputMicros: 50000,
        outputMicros: 0,
        cacheReadMicros: 0,
        cacheWriteMicros: 0,
        totalMicros: 50000,
        formattedTotal: '¥0.0500',
        isFree: false,
      },
    });
    expect(second.costMicros).toBe(150000);
    expect(second.formattedCost).toBe('¥0.0500');
  });

  it('免费账 → costStatus free + 「免费」', () => {
    const next = applyUsageDelta(emptyState, {
      promptTokens: 10,
      completionTokens: 0,
      cost: {
        currency: 'USD',
        inputMicros: 0,
        outputMicros: 0,
        cacheReadMicros: 0,
        cacheWriteMicros: 0,
        totalMicros: 0,
        formattedTotal: '免费',
        isFree: true,
      },
    });
    expect(next.costStatus).toBe('free');
    expect(next.formattedCost).toBe('免费');
  });

  it('无 cost（未定价）→ 保持 unpriced，不写费用', () => {
    const next = applyUsageDelta(emptyState, {
      promptTokens: 10,
      completionTokens: 5,
      cost: null,
    });
    expect(next.costStatus).toBe('unpriced');
    expect(next.formattedCost).toBeUndefined();
  });
});
