/**
 * PricingEngine 对抗性测试套件
 *
 * 目标：暴露定价引擎在多 provider 歧义、单位混淆、边界输入下的资金正确性 bug。
 *
 * 期望暴露的 bug：
 *  - lookupPricing 在多 provider 场景下非确定性（Map 迭代顺序依赖）
 *  - entryToPricing 单位映射可能错误（per token vs per 1K token）
 *  - 空 modelId 触发 suffix match 误匹配
 *  - 负数 token / NaN rate 静默通过
 *  - calculateCost 不接收 provider 参数，无法消歧
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PricingEngine, type PricingEntry } from './pricing-engine';

function makeEntry(
  partial: Partial<PricingEntry> & Pick<PricingEntry, 'modelId' | 'provider'>
): PricingEntry {
  return {
    inputCostPer1KTokens: 0.01,
    outputCostPer1KTokens: 0.03,
    currency: 'USD',
    ...partial,
  };
}

describe('PricingEngine — 查找语义', () => {
  it('精确 provider+modelId 匹配优先', () => {
    const engine = new PricingEngine();
    engine.registerPricing(
      makeEntry({
        modelId: 'gpt-4',
        provider: 'openai',
        inputCostPer1KTokens: 0.01,
      })
    );
    engine.registerPricing(
      makeEntry({
        modelId: 'gpt-4',
        provider: 'azure',
        inputCostPer1KTokens: 99,
      })
    );
    const found = engine.lookupPricing('gpt-4', 'openai');
    expect(found?.inputCostPer1KTokens).toBe(0.01);
  });

  it('provider 不匹配时回退到 unqualified', () => {
    const engine = new PricingEngine();
    engine.registerPricing(
      makeEntry({ modelId: 'gpt-4', provider: '', inputCostPer1KTokens: 0.05 })
    );
    const found = engine.lookupPricing('gpt-4', 'openai');
    expect(found?.inputCostPer1KTokens).toBe(0.05);
  });

  it('暴露 bug: 无 provider 参数时，多 provider 同 modelId 返回非确定性结果', () => {
    // Map 的 values() 迭代顺序在 V8 中通常是插入顺序，但规范不保证
    // 当有多个 entry 满足 suffix match 时，返回第一个找到的
    const engine = new PricingEngine();
    engine.registerPricing(
      makeEntry({
        modelId: 'gpt-4',
        provider: 'openai',
        inputCostPer1KTokens: 0.01,
      })
    );
    engine.registerPricing(
      makeEntry({
        modelId: 'azure/gpt-4',
        provider: 'azure',
        inputCostPer1KTokens: 0.02,
      })
    );

    // 不传 provider，触发 suffix match
    const found = engine.lookupPricing('gpt-4');
    // 期望先匹配 unqualified（openai 的 gpt-4），但 openai 的 entry key 是 "openai::gpt-4"
    // unqualified 查找 modelId="gpt-4" 不会命中（因为存的是 "openai::gpt-4"）
    // 然后进入 suffix match，找到 "azure/gpt-4".endsWith("/gpt-4") = true
    expect(found?.modelId).toBe('azure/gpt-4');
    expect(found?.inputCostPer1KTokens).toBe(0.02);
  });

  it('暴露 bug: 空 modelId 触发 suffix match 误匹配', () => {
    const engine = new PricingEngine();
    engine.registerPricing(makeEntry({ modelId: 'foo/', provider: 'p' }));
    // lookupPricing("") → suffix match: "foo/".endsWith("/" + "") = "foo/".endsWith("/") = true
    const found = engine.lookupPricing('');
    expect(found).toBeDefined();
    expect(found?.modelId).toBe('foo/');
  });

  it('暴露 bug: suffix match 可匹配非预期 provider 路径', () => {
    const engine = new PricingEngine();
    engine.registerPricing(
      makeEntry({
        modelId: 'something/gpt-4',
        provider: 'weird',
        inputCostPer1KTokens: 999,
      })
    );
    const found = engine.lookupPricing('gpt-4');
    expect(found?.inputCostPer1KTokens).toBe(999);
  });

  it('查找不存在的 modelId 返回 undefined', () => {
    const engine = new PricingEngine();
    engine.registerPricing(makeEntry({ modelId: 'gpt-4', provider: 'openai' }));
    expect(engine.lookupPricing('claude-3')).toBeUndefined();
  });
});

describe('PricingEngine — 成本计算', () => {
  it('1000 tokens × 0.01/1K = 0.01 成本', () => {
    const engine = new PricingEngine();
    engine.registerPricing(
      makeEntry({
        modelId: 'gpt-4',
        provider: 'openai',
        inputCostPer1KTokens: 0.01,
      })
    );
    const cost = engine.calculateCost('gpt-4', { inputTokens: 1000 });
    expect(cost.inputCost).toBeCloseTo(0.01, 10);
    expect(cost.totalCost).toBeCloseTo(0.01, 10);
  });

  it('暴露 bug: 负数 token 产生负成本（无校验）', () => {
    const engine = new PricingEngine();
    engine.registerPricing(
      makeEntry({
        modelId: 'gpt-4',
        provider: 'openai',
        inputCostPer1KTokens: 0.01,
      })
    );
    const cost = engine.calculateCost('gpt-4', { inputTokens: -1000 });
    expect(cost.inputCost).toBe(-0.01);
    expect(cost.totalCost).toBeLessThan(0);
  });

  it('暴露 bug: calculateCost 不接收 provider 参数，无法消歧', () => {
    const engine = new PricingEngine();
    engine.registerPricing(
      makeEntry({
        modelId: 'gpt-4',
        provider: 'openai',
        inputCostPer1KTokens: 0.01,
      })
    );
    engine.registerPricing(
      makeEntry({
        modelId: 'azure/gpt-4',
        provider: 'azure',
        inputCostPer1KTokens: 0.02,
      })
    );
    // 无法指定 azure，只能依赖 suffix match
    const cost = engine.calculateCost('gpt-4', { inputTokens: 1000 });
    // 命中 azure/gpt-4（suffix match）
    expect(cost.inputCost).toBeCloseTo(0.02, 10);
    // 用户可能期望 0.01（openai）但实际得到 0.02
  });

  it('所有 token 字段为 0 时返回 0 成本', () => {
    const engine = new PricingEngine();
    engine.registerPricing(
      makeEntry({
        modelId: 'gpt-4',
        provider: 'openai',
        inputCostPer1KTokens: 0.01,
      })
    );
    const cost = engine.calculateCost('gpt-4', {});
    expect(cost.totalCost).toBe(0);
  });

  it('未注册 modelId 返回 0 成本 + USD 货币', () => {
    const engine = new PricingEngine();
    const cost = engine.calculateCost('unknown-model', { inputTokens: 1000 });
    expect(cost.totalCost).toBe(0);
    expect(cost.currency).toBe('USD');
  });

  it('cache + reasoning 字段独立计算', () => {
    const engine = new PricingEngine();
    engine.registerPricing(
      makeEntry({
        modelId: 'claude-3',
        provider: 'anthropic',
        inputCostPer1KTokens: 0.003,
        outputCostPer1KTokens: 0.015,
        cacheReadCostPer1KTokens: 0.0003,
        cacheCreationCostPer1KTokens: 0.00375,
        reasoningCostPer1KTokens: 0.018,
      })
    );
    const cost = engine.calculateCost('claude-3', {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheCreationTokens: 1000,
      reasoningTokens: 300,
    });
    expect(cost.inputCost).toBeCloseTo(0.003, 6);
    expect(cost.outputCost).toBeCloseTo(0.0075, 6);
    expect(cost.cacheReadCost).toBeCloseTo(0.0006, 6);
    expect(cost.cacheWriteCost).toBeCloseTo(0.00375, 6);
    expect(cost.reasoningCost).toBeCloseTo(0.0054, 6);
    expect(cost.totalCost).toBeCloseTo(0.02025, 6);
  });

  it('暴露 bug: rate=0 时 calc 返回 0（!rate 把 0 当 falsy）', () => {
    // 免费模型 rate=0，calc(0, 1000) 返回 0 — 结果正确但逻辑错误
    // 因为 !0 === true，所以返回 0。如果 rate 是 NaN，!NaN === true 也返回 0
    const engine = new PricingEngine();
    engine.registerPricing(
      makeEntry({ modelId: 'free', provider: 'p', inputCostPer1KTokens: 0 })
    );
    const cost = engine.calculateCost('free', { inputTokens: 1000 });
    expect(cost.inputCost).toBe(0); // 正确，但掩盖了 NaN 输入
  });

  it('属性测试: totalCost === 各分量之和', () => {
    const engine = new PricingEngine();
    engine.registerPricing(
      makeEntry({
        modelId: 'm',
        provider: 'p',
        inputCostPer1KTokens: 0.01,
        outputCostPer1KTokens: 0.03,
        cacheReadCostPer1KTokens: 0.001,
        cacheCreationCostPer1KTokens: 0.002,
        reasoningCostPer1KTokens: 0.005,
      })
    );
    fc.assert(
      fc.property(
        fc.record({
          inputTokens: fc.integer({ min: 0, max: 1_000_000 }),
          outputTokens: fc.integer({ min: 0, max: 1_000_000 }),
          cacheReadTokens: fc.integer({ min: 0, max: 1_000_000 }),
          cacheCreationTokens: fc.integer({ min: 0, max: 1_000_000 }),
          reasoningTokens: fc.integer({ min: 0, max: 1_000_000 }),
        }),
        (usage) => {
          const cost = engine.calculateCost('m', usage);
          const sum =
            cost.inputCost +
            cost.outputCost +
            cost.cacheReadCost +
            cost.cacheWriteCost +
            cost.reasoningCost;
          expect(cost.totalCost).toBeCloseTo(sum, 10);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('属性测试: 成本非负（在非负输入下）', () => {
    const engine = new PricingEngine();
    engine.registerPricing(
      makeEntry({
        modelId: 'm',
        provider: 'p',
        inputCostPer1KTokens: 0.01,
        outputCostPer1KTokens: 0.03,
      })
    );
    fc.assert(
      fc.property(
        fc.record({
          inputTokens: fc.integer({ min: 0, max: 1_000_000 }),
          outputTokens: fc.integer({ min: 0, max: 1_000_000 }),
        }),
        (usage) => {
          const cost = engine.calculateCost('m', usage);
          expect(cost.totalCost).toBeGreaterThanOrEqual(0);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('PricingEngine — loadFromCatalog 单位映射', () => {
  it('暴露 bug: entryToPricing 直接把 inputCostPerToken 当作 inputCostPer1KTokens', () => {
    // 这是个潜在的严重 bug：catalog 字段名是 perToken，但 engine 期望 per1KTokens
    // 如果 catalog 存的是真实 per-token 价格（如 0.00001），计算结果会错 1000 倍
    // 此测试用 mock catalog 验证映射
    const mockCatalog = {
      listAll: () => [
        {
          id: 'gpt-4',
          provider: 'openai',
          inputCostPerToken: 0.00001, // 真实 per-token 价格
          outputCostPerToken: 0.00003,
          cacheReadInputCostPerToken: 0.000001,
          cacheCreationInputCostPerToken: 0.00000125,
          outputCostPerReasoningToken: 0.00006,
        },
      ],
    };
    const engine = new PricingEngine();
    engine.loadFromCatalog(mockCatalog as any);
    const cost = engine.calculateCost('gpt-4', { inputTokens: 1000 });
    // 如果是 per-token 价格，1000 tokens × 0.00001 = 0.01
    // 但 engine 把它当 per-1K，所以 (1000/1000) × 0.00001 = 0.00001
    // 这俩相差 1000 倍！
    // 注意：这个测试假设 catalog 字段名是字面意义的 per-token
    // 如果实际 catalog 已经按 per-1K 存储，则无 bug
    // 但字段命名误导是确定的代码异味
    expect(cost.inputCost).toBe(0.00001); // 当前实现
    // 期望（如果字段名诚实）：0.01
  });
});
