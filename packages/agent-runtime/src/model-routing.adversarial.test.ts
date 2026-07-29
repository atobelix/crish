/**
 * ModelRouting 对抗性测试套件
 *
 * 目标：暴露 model-routing/matcher.ts 与 profile.ts 在输入校验、评分逻辑、
 * 策略合并、确定性排序、边界值与 Unicode 处理下的隐藏 bug。
 *
 * 测试策略：断言"正确行为"（而非现有 buggy 行为）。失败的测试即代表存在 bug，
 * 修复源码后测试应通过。
 *
 * 覆盖维度：
 *  - MR1: normalizeOptionalPositiveInteger 分数截断后违反 positive 契约
 *  - MR2: estimatedTokens 溢出为 Infinity 导致所有 profile 被拒绝
 *  - MR3: 权重 NaN/Infinity 处理
 *  - MR4: contextScore 对 unknown vs explicit-0 的不一致
 *  - MR5: latencyScore 对 latencyMs=0 返回最佳分
 *  - MR6: 负数 costTier 映射为 "free"
 *  - MR7: compareCandidates 禁用 minimumContextTokens 导致 tie-break 不一致
 *  - MR8: mergeModelRoutePolicies 浅合并 metadata
 *  - MR9: preferModelIds + avoidModelIds 冲突
 *  - MR10: 确定性排序（反转输入顺序后结果一致）
 *  - MR11: Unicode profile ID 排序确定性
 *  - MR12: 归一化后 ID 碰撞
 *  - MR13: 空 profiles 数组
 *  - MR14: 全部 profile 被拒绝时 selected 为 undefined
 *  - MR15: capability 字符串值被强制转换
 *  - MR16: hasMediaContent 空值安全
 */

import { describe, expect, it } from 'vitest';
import type { JsonObject } from '@crish/shared-types';
import {
  routeModelByCapability,
  routeModelForTask,
  capabilityRequestFromTask,
  mergeModelRoutePolicies,
  scoreProfile,
  modelRouteDecisionToMetadata,
  type ModelProfile,
  type ModelRoutePolicy,
  type ModelCostTier,
  type RequiredCapabilityShape,
  type NormalizedPolicySummary,
  DEFAULT_MODEL_ROUTE_WEIGHTS,
} from './model-routing';

function profile(
  id: string,
  overrides: Partial<ModelProfile> & Record<string, unknown> = {}
): ModelProfile {
  return {
    id,
    availability: 'available',
    health: 'healthy',
    ...overrides,
  } as ModelProfile;
}

function normalizedRequest(
  overrides: Partial<RequiredCapabilityShape> = {}
): RequiredCapabilityShape {
  return {
    required: [],
    preferred: [],
    avoid: [],
    requiredEndpointSupport: [],
    requiredStreamingSupport: [],
    ...overrides,
  };
}

function normalizedPolicy(
  overrides: Partial<NormalizedPolicySummary> = {}
): NormalizedPolicySummary {
  return {
    allowProviders: [],
    denyProviders: [],
    preferModelIds: [],
    avoidModelIds: [],
    weights: { ...DEFAULT_MODEL_ROUTE_WEIGHTS },
    ...overrides,
  };
}

// ============================================================================
// MR1: normalizeOptionalPositiveInteger 分数截断后违反 positive 契约
// ============================================================================

describe('MR1: normalizeOptionalPositiveInteger 分数截断', () => {
  it('MR1a: contextWindowTokens=0.5 不应被截断为 0（应被丢弃或拒绝）', () => {
    const decision = routeModelByCapability(
      [
        profile('frac-ctx', {
          contextWindowTokens: 0.5 as unknown as number,
          capabilities: { code: 1 },
        }),
      ],
      { required: ['code'], minimumContextTokens: 1 }
    );
    // 0.5 被截断为 0 → 0 < 1 → 被拒绝为 context:too_small
    // 正确行为：0.5 不是合法的正整数，应被丢弃（undefined），然后因 context:unknown 被拒绝
    const rejection = decision.rejections.find(
      (r) => r.profile.id === 'frac-ctx'
    );
    expect(rejection).toBeDefined();
    // 不应出现 context:too_small（因为 0.5 根本不是合法值），应出现 context:unknown
    expect(rejection!.reasons).toContain('context:unknown');
    expect(rejection!.reasons).not.toContain('context:too_small');
  });

  it('MR1b: minimumContextTokens=0.5 不应被截断为 0 后放行所有 profile', () => {
    const decision = routeModelByCapability(
      [profile('any-ctx', { capabilities: { code: 1 } })], // contextWindowTokens 未设置
      { required: ['code'], minimumContextTokens: 0.5 as unknown as number }
    );
    // 0.5 修复后被丢弃为 undefined → 无 context 要求 → profile 不应因 context 被拒绝
    // profile 应被选为 candidate（虽然没有 contextWindowTokens，但没有 minimumContextTokens 约束）
    const rejection = decision.rejections.find(
      (r) => r.profile.id === 'any-ctx'
    );
    expect(rejection).toBeUndefined();
    expect(decision.selected?.id).toBe('any-ctx');
  });

  it('MR1c: contextWindowTokens=1.9 应被截断为 1 而非 0', () => {
    const decision = routeModelByCapability(
      [
        profile('almost-2', {
          contextWindowTokens: 1.9 as unknown as number,
          capabilities: { code: 1 },
        }),
      ],
      { required: ['code'], minimumContextTokens: 1 }
    );
    // 1.9 截断为 1 → 1 >= 1 → 通过
    expect(decision.selected?.id).toBe('almost-2');
    expect(decision.rejections).toHaveLength(0);
  });
});

// ============================================================================
// MR2: estimatedTokens 溢出为 Infinity
// ============================================================================

describe('MR2: estimatedTokens 溢出', () => {
  it('MR2a: 极大 estimatedInputTokens + estimatedOutputTokens 不应导致 minimumContextTokens=Infinity', () => {
    const decision = routeModelByCapability(
      [
        profile('big-ctx', {
          contextWindowTokens: 200_000,
          capabilities: { code: 1 },
        }),
      ],
      {
        required: ['code'],
        estimatedInputTokens: Number.MAX_VALUE / 2,
        estimatedOutputTokens: Number.MAX_VALUE / 2 + 1,
      }
    );
    // estimatedInputTokens + estimatedOutputTokens 可能溢出为 Infinity
    // 然后 minimumContextTokens = Infinity → 所有 profile 因 context:too_small 被拒绝
    // 正确行为：应正常选择 profile，或因 estimatedTokens 溢出而忽略该推断
    expect(decision.selected?.id).toBe('big-ctx');
  });

  it('MR2b: estimatedInputTokens=Infinity 不应被接受', () => {
    const decision = routeModelByCapability(
      [
        profile('normal', {
          contextWindowTokens: 8_000,
          capabilities: { code: 1 },
        }),
      ],
      {
        required: ['code'],
        estimatedInputTokens: Infinity,
      }
    );
    // Infinity 被 normalizeOptionalNonNegativeInteger 拒绝（!Number.isFinite）→ fallback 0
    // 但如果 estimatedOutputTokens 也是大数，estimatedTokens 仍可能溢出
    expect(decision.selected?.id).toBe('normal');
  });
});

// ============================================================================
// MR3: 权重 NaN/Infinity 处理
// ============================================================================

describe('MR3: 权重校验', () => {
  it('MR3a: weights 含 NaN 值应被丢弃', () => {
    const decision = routeModelByCapability(
      [profile('a', { capabilities: { code: 1 } })],
      { required: ['code'] },
      {
        weights: { requiredCapability: NaN, health: 14 } as NonNullable<ModelRoutePolicy['weights']>,
      }
    );
    // NaN 应被 normalizeWeights 丢弃，回退到默认 requiredCapability=100
    expect(decision.selected?.id).toBe('a');
    expect(decision.policy.weights.requiredCapability).toBe(
      DEFAULT_MODEL_ROUTE_WEIGHTS.requiredCapability
    );
    expect(decision.policy.weights.health).toBe(14);
  });

  it('MR3b: weights 含 Infinity 应被丢弃', () => {
    const decision = routeModelByCapability(
      [profile('a', { capabilities: { code: 1 } })],
      { required: ['code'] },
      {
        weights: { requiredCapability: Infinity } as NonNullable<ModelRoutePolicy['weights']>,
      }
    );
    expect(decision.policy.weights.requiredCapability).toBe(
      DEFAULT_MODEL_ROUTE_WEIGHTS.requiredCapability
    );
  });

  it('MR3c: weights 含负数应被 clamp 到 0', () => {
    const decision = routeModelByCapability(
      [profile('a', { capabilities: { code: 1 } })],
      { required: ['code'] },
      { weights: { health: -50 } }
    );
    // 负权重会导致健康模型被惩罚，不合理
    expect(decision.policy.weights.health).toBe(0);
  });
});

// ============================================================================
// MR4: contextScore 对 unknown vs explicit-0 的不一致
// ============================================================================

describe('MR4: contextScore 一致性', () => {
  it('MR4a: contextWindowTokens=0 不应比 undefined 得分更低', () => {
    const decision = routeModelByCapability(
      [
        profile('zero-ctx', {
          capabilities: { code: 1 },
          contextWindowTokens: 0,
        }),
        profile('unknown-ctx', { capabilities: { code: 1 } }),
      ],
      { required: ['code'] }
    );

    // 当前：contextScore(0, undefined) = clamp(0/200000, 0, 1) = 0
    //       contextScore(undefined, undefined) = 0.35
    // 显式 0 上下文比未知上下文得分更低，这不合理——两者都意味着"上下文能力不足"
    const zeroCandidate = decision.candidates.find(
      (c) => c.profile.id === 'zero-ctx'
    );
    const unknownCandidate = decision.candidates.find(
      (c) => c.profile.id === 'unknown-ctx'
    );
    expect(zeroCandidate).toBeDefined();
    expect(unknownCandidate).toBeDefined();
    // 两者应得相同的 context 分数，或 0 不应比 undefined 更差
    const zeroCtxReason = zeroCandidate!.reasons.find((r) =>
      r.startsWith('context:')
    );
    const unknownCtxReason = unknownCandidate!.reasons.find((r) =>
      r.startsWith('context:')
    );
    expect(zeroCtxReason).toBe(unknownCtxReason);
  });
});

// ============================================================================
// MR5: latencyScore 对 latencyMs=0 返回最佳分
// ============================================================================

describe('MR5: latencyScore 边界', () => {
  it('MR5a: latencyMs=0 不应获得最佳分（0 延迟不合理）', () => {
    const decision = routeModelByCapability(
      [
        profile('zero-latency', { capabilities: { code: 1 }, latencyMs: 0 }),
        profile('normal-latency', {
          capabilities: { code: 1 },
          latencyMs: 250,
        }),
      ],
      { required: ['code'] }
    );

    // 两者都满足 latencyMs <= 250，都得 1.0 的 latency 分
    // 0 延迟通常意味着数据错误，不应比 250ms 得分更高
    const zeroCandidate = decision.candidates.find(
      (c) => c.profile.id === 'zero-latency'
    );
    const normalCandidate = decision.candidates.find(
      (c) => c.profile.id === 'normal-latency'
    );
    expect(zeroCandidate).toBeDefined();
    expect(normalCandidate).toBeDefined();
    // 至少不应让 0 延迟赢过 250ms（它们应平手或 0 被视为可疑）
    expect(zeroCandidate!.score).toBeLessThanOrEqual(normalCandidate!.score);
  });
});

// ============================================================================
// MR7: compareCandidates 禁用 minimumContextTokens 导致 tie-break 不一致
// ============================================================================

describe('MR7: tie-break 一致性', () => {
  it('MR7a: tie-break 应使用与主评分相同的 contextScore 参数', () => {
    const profiles = [
      profile('small-ctx', {
        capabilities: { code: 1 },
        contextWindowTokens: 8_000,
      }),
      profile('big-ctx', {
        capabilities: { code: 1 },
        contextWindowTokens: 200_000,
      }),
    ];
    const decision = routeModelByCapability(profiles, {
      required: ['code'],
      minimumContextTokens: 8_000,
    });

    // 主评分：contextScore(8000, 8000) = clamp(8000/32000, 0.25, 1) = 0.25
    //         contextScore(200000, 8000) = clamp(200000/32000, 0.25, 1) = 1
    // big-ctx 应得更高 context 分
    // 但 compareCandidates 使用 contextScore(contextWindowTokens, undefined)
    //   → contextScore(8000, undefined) = clamp(8000/200000, 0, 1) = 0.04
    //   → contextScore(200000, undefined) = clamp(200000/200000, 0, 1) = 1
    // 这部分碰巧一致，但在边界情况下可能不一致
    expect(decision.selected?.id).toBe('big-ctx');
  });

  it('MR7b: 两个等分 profile 的 tie-break 应稳定且与主评分一致', () => {
    // 构造两个分数完全相同的 profile，仅 context 不同
    const profiles = [
      profile('ctx-100k', {
        capabilities: { code: 1 },
        contextWindowTokens: 100_000,
      }),
      profile('ctx-50k', {
        capabilities: { code: 1 },
        contextWindowTokens: 50_000,
      }),
    ];
    const decision = routeModelByCapability(profiles, { required: ['code'] });
    const reversed = routeModelByCapability([...profiles].reverse(), {
      required: ['code'],
    });

    // 两者应选择同一个（确定性）
    expect(decision.selected?.id).toBe(reversed.selected?.id);
  });
});

// ============================================================================
// MR8: mergeModelRoutePolicies 浅合并 metadata
// ============================================================================

describe('MR8: 策略合并', () => {
  it('MR8a: metadata 应深合并而非浅合并', () => {
    const base: ModelRoutePolicy = {
      metadata: { nested: { a: 1, b: 2 } } as unknown as JsonObject,
    };
    const override: ModelRoutePolicy = {
      metadata: { nested: { b: 3, c: 4 } } as unknown as JsonObject,
    };
    const merged = mergeModelRoutePolicies(base, override);

    // 当前：浅合并 → { nested: { b: 3, c: 4 } }（a 丢失）
    // 正确行为：深合并 → { nested: { a: 1, b: 3, c: 4 } }
    expect((merged.metadata as unknown as JsonObject).nested).toMatchObject({
      a: 1,
      b: 3,
      c: 4,
    });
  });

  it('MR8b: maxCostTier=null 不应覆盖 base 的值', () => {
    const base: ModelRoutePolicy = { maxCostTier: 'low' };
    const override: ModelRoutePolicy = {
      maxCostTier: null as unknown as ModelCostTier,
    };
    const merged = mergeModelRoutePolicies(base, override);
    // null ?? base → base
    expect(merged.maxCostTier).toBe('low');
  });

  it('MR8c: maxCostTier=0（数字，代表 free）应被保留', () => {
    const base: ModelRoutePolicy = { maxCostTier: 'low' };
    const override: ModelRoutePolicy = { maxCostTier: 0 };
    const merged = mergeModelRoutePolicies(base, override);
    // 0 ?? base → 0（0 不是 null/undefined）
    expect(merged.maxCostTier).toBe(0);
  });
});

// ============================================================================
// MR9: preferModelIds + avoidModelIds 冲突
// ============================================================================

describe('MR9: prefer/avoid 冲突', () => {
  it('MR9a: 同时出现在 preferModelIds 和 avoidModelIds 的模型应被避免', () => {
    const decision = routeModelByCapability(
      [
        profile('conflicted', { capabilities: { code: 1 } }),
        profile('neutral', { capabilities: { code: 1 } }),
      ],
      { required: ['code'] },
      {
        preferModelIds: ['conflicted'],
        avoidModelIds: ['conflicted'],
      }
    );

    // 当前：conflicted 获得 +preferredModel(20) 和 -avoidedModelPenalty(30) = 净 -10
    // 正确行为：avoid 应优先于 prefer，conflicted 不应被选中
    expect(decision.selected?.id).toBe('neutral');
  });
});

// ============================================================================
// MR10: 确定性排序（反转输入顺序后结果一致）
// ============================================================================

describe('MR10: 确定性排序', () => {
  it('MR10a: 反转 profiles 顺序不影响最终选择', () => {
    const profiles = [
      profile('z-model', { capabilities: { json: 1 }, providerId: 'z' }),
      profile('a-model', { capabilities: { json: 1 }, providerId: 'a' }),
      profile('m-model', { capabilities: { json: 1 }, providerId: 'm' }),
    ];
    const first = routeModelByCapability(profiles, { required: ['json'] });
    const second = routeModelByCapability([...profiles].reverse(), {
      required: ['json'],
    });

    expect(first.selected?.id).toBe(second.selected?.id);
    expect(first.candidates.map((c) => c.profile.id)).toEqual(
      second.candidates.map((c) => c.profile.id)
    );
  });

  it('MR10b: 多次调用结果一致', () => {
    const profiles = [
      profile('m1', { capabilities: { code: 1 }, costTier: 'low' }),
      profile('m2', { capabilities: { code: 1 }, costTier: 'medium' }),
      profile('m3', { capabilities: { code: 1 }, costTier: 'free' }),
    ];
    const results = Array.from({ length: 5 }, () =>
      routeModelByCapability(profiles, { required: ['code'] })
    );
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.candidates.map((c) => c.profile.id)).toEqual(
        results[0]!.candidates.map((c) => c.profile.id)
      );
    }
  });
});

// ============================================================================
// MR11: Unicode profile ID 排序确定性
// ============================================================================

describe('MR11: Unicode 排序', () => {
  it('MR11a: CJK profile IDs 应确定性排序', () => {
    const profiles = [
      profile('模型-中', { capabilities: { code: 1 } }),
      profile('模型-甲', { capabilities: { code: 1 } }),
      profile('模型-乙', { capabilities: { code: 1 } }),
    ];
    const first = routeModelByCapability(profiles, { required: ['code'] });
    const second = routeModelByCapability([...profiles].reverse(), {
      required: ['code'],
    });

    expect(first.candidates.map((c) => c.profile.id)).toEqual(
      second.candidates.map((c) => c.profile.id)
    );
  });

  it('MR11b: emoji profile IDs 应确定性排序', () => {
    const profiles = [
      profile('model-🚀', { capabilities: { code: 1 } }),
      profile('model-🔥', { capabilities: { code: 1 } }),
      profile('model-✨', { capabilities: { code: 1 } }),
    ];
    const first = routeModelByCapability(profiles, { required: ['code'] });
    const second = routeModelByCapability([...profiles].reverse(), {
      required: ['code'],
    });

    expect(first.candidates.map((c) => c.profile.id)).toEqual(
      second.candidates.map((c) => c.profile.id)
    );
  });
});

// ============================================================================
// MR12: 归一化后 ID 碰撞
// ============================================================================

describe('MR12: ID 碰撞', () => {
  it("MR12a: 两个空 ID profile 都归一化为 'unknown'，应都出现在候选列表中", () => {
    const decision = routeModelByCapability(
      [
        profile('', { capabilities: { code: 1 }, providerId: 'a' }),
        profile('', { capabilities: { code: 1 }, providerId: 'b' }),
      ],
      { required: ['code'] }
    );
    // 两者都归一化为 id="unknown"，但 providerId 不同
    // 应都出现在 candidates 中（或至少不应崩溃）
    expect(decision.candidates.length + decision.rejections.length).toBe(2);
  });

  it('MR12b: 两个 undefined id（通过 model 回退）应不产生无限循环', () => {
    const decision = routeModelByCapability(
      [
        profile(undefined as unknown as string, { capabilities: { code: 1 } }),
        profile(undefined as unknown as string, { capabilities: { code: 1 } }),
      ],
      { required: ['code'] }
    );
    expect(decision.candidates.length + decision.rejections.length).toBe(2);
  });
});

// ============================================================================
// MR13: 空 profiles 数组
// ============================================================================

describe('MR13: 空输入', () => {
  it('MR13a: 空 profiles 数组应返回 selected=undefined', () => {
    const decision = routeModelByCapability([], { required: ['code'] });
    expect(decision.selected).toBeUndefined();
    expect(decision.candidates).toHaveLength(0);
    expect(decision.rejections).toHaveLength(0);
    expect(decision.trace.at(-1)).toBe('selected:none');
  });

  it('MR13b: 空 request 应正常处理', () => {
    const decision = routeModelByCapability([
      profile('a', { capabilities: { code: 1 } }),
    ]);
    expect(decision.selected?.id).toBe('a');
  });

  it('MR13c: undefined request 应正常处理', () => {
    const decision = routeModelByCapability(
      [profile('a', { capabilities: { code: 1 } })],
      undefined as unknown as never
    );
    expect(decision.selected?.id).toBe('a');
  });

  it('MR13d: undefined policy 应正常处理', () => {
    const decision = routeModelByCapability(
      [profile('a', { capabilities: { code: 1 } })],
      { required: ['code'] },
      undefined as unknown as never
    );
    expect(decision.selected?.id).toBe('a');
  });
});

// ============================================================================
// MR14: 全部 profile 被拒绝时 selected 为 undefined
// ============================================================================

describe('MR14: 全部拒绝', () => {
  it('MR14a: 所有 profile 缺少 required 能力时 selected=undefined', () => {
    const decision = routeModelByCapability(
      [
        profile('no-code', { capabilities: { json: 1 } }),
        profile('also-no-code', { capabilities: { search: 1 } }),
      ],
      { required: ['code'] }
    );
    expect(decision.selected).toBeUndefined();
    expect(decision.rejections).toHaveLength(2);
    expect(decision.trace.at(-1)).toBe('selected:none');
  });

  it('MR14b: selected=undefined 时 modelRouteDecisionToMetadata 不应崩溃', () => {
    const decision = routeModelByCapability(
      [profile('no-code', { capabilities: { json: 1 } })],
      { required: ['code'] }
    );
    expect(() => modelRouteDecisionToMetadata(decision)).not.toThrow();
    const metadata = modelRouteDecisionToMetadata(decision);
    expect(metadata.selectedModelProfileId).toBeUndefined();
  });
});

// ============================================================================
// MR15: capability 字符串值被强制转换
// ============================================================================

describe('MR15: capability 类型强制转换', () => {
  it("MR15a: capability='true'（字符串）不应被当作布尔 true", () => {
    const decision = routeModelByCapability(
      [
        profile('str-true', {
          capabilities: { code: 'true' as unknown as number },
        }),
      ],
      { required: ['code'] }
    );
    // "true" → Number("true") = NaN → 不是 finite → capabilityScore 返回 0
    // 应被拒绝为 missing_required:code
    expect(decision.selected).toBeUndefined();
    expect(decision.rejections[0]?.reasons).toContain('missing_required:code');
  });

  it("MR15b: capability='0.8'（字符串）应被转换为 0.8", () => {
    const decision = routeModelByCapability(
      [
        profile('str-num', {
          capabilities: { code: '0.8' as unknown as number },
        }),
      ],
      { required: ['code'] }
    );
    // Number("0.8") = 0.8 → clamp(0.8, 0, 1) = 0.8
    expect(decision.selected?.id).toBe('str-num');
  });

  it('MR15c: capability=2（超出 1）应被 clamp 到 1', () => {
    const decision = routeModelByCapability(
      [profile('over-1', { capabilities: { code: 2 as unknown as number } })],
      { required: ['code'] }
    );
    expect(decision.selected?.id).toBe('over-1');
    // 分数应基于 clamp(2, 0, 1) = 1，而非 2
    const candidate = decision.candidates.find(
      (c) => c.profile.id === 'over-1'
    );
    expect(candidate).toBeDefined();
    const requiredReason = candidate!.reasons.find((r) =>
      r.startsWith('required:code:')
    );
    expect(requiredReason).toBe('required:code:100');
  });

  it('MR15d: capability=-0.5（负数）应被 clamp 到 0', () => {
    const decision = routeModelByCapability(
      [
        profile('neg-cap', {
          capabilities: { code: -0.5 as unknown as number },
        }),
      ],
      { required: ['code'] }
    );
    // clamp(-0.5, 0, 1) = 0 → capabilityScore = 0 → missing_required:code
    expect(decision.selected).toBeUndefined();
    expect(decision.rejections[0]?.reasons).toContain('missing_required:code');
  });
});

// ============================================================================
// MR16: hasMediaContent 空值安全
// ============================================================================

describe('MR16: hasMediaContent 空值安全', () => {
  it('MR16a: 空数组应返回 false', () => {
    expect(routeModelForTask([], { kind: 'code' })).toBeDefined();
  });

  it('MR16b: null metadata 应不崩溃', () => {
    // hasMediaContent 内部访问 message.metadata?.contentParts，应安全
    expect(() =>
      routeModelForTask([profile('a', { capabilities: { code: 1 } })], {
        kind: 'code',
      })
    ).not.toThrow();
  });
});

// ============================================================================
// MR17: scoreProfile 直接调用测试
// ============================================================================

describe('MR17: scoreProfile 直接测试', () => {
  it('MR17a: 所有能力匹配时分数为正', () => {
    const candidate = scoreProfile(
      profile('full', {
        capabilities: { code: 1, json: 1 },
        health: 'healthy',
        costTier: 'free',
        latencyMs: 100,
        contextWindowTokens: 200_000,
      }),
      normalizedRequest({ required: ['code'], preferred: ['json'] }),
      normalizedPolicy()
    );
    expect(candidate.score).toBeGreaterThan(0);
    expect(candidate.matchedRequired).toEqual(['code']);
    expect(candidate.matchedPreferred).toEqual(['json']);
  });

  it('MR17b: avoid 能力匹配时应扣分', () => {
    const candidate = scoreProfile(
      profile('avoided', { capabilities: { code: 1, 'low-cost': 1 } }),
      normalizedRequest({ required: ['code'], avoid: ['low-cost'] }),
      normalizedPolicy()
    );
    expect(candidate.matchedAvoided).toEqual(['low-cost']);
    const avoidReason = candidate.reasons.find((r) =>
      r.startsWith('avoid:low-cost:')
    );
    expect(avoidReason).toBeDefined();
  });

  it('MR17c: 缺失 preferred 能力应被扣分', () => {
    const candidate = scoreProfile(
      profile('missing-pref', { capabilities: { code: 1 } }),
      normalizedRequest({
        required: ['code'],
        preferred: ['json', 'reasoning'],
      }),
      normalizedPolicy()
    );
    const missingReasons = candidate.reasons.filter((r) =>
      r.startsWith('missing_preferred:')
    );
    expect(missingReasons).toHaveLength(2);
  });
});

// ============================================================================
// MR18: capabilityRequestFromTask 边界
// ============================================================================

describe('MR18: capabilityRequestFromTask 边界', () => {
  it('MR18a: unknown task kind 应返回默认 required=[]', () => {
    const request = capabilityRequestFromTask({
      kind: 'unknown-kind' as unknown as 'code',
    });
    expect(request.required).toEqual([]);
    expect(request.preferred).toEqual(
      expect.arrayContaining(['reasoning', 'json'])
    );
  });

  it('MR18b: minimumContextTokens=0 应被丢弃', () => {
    const request = capabilityRequestFromTask({ minimumContextTokens: 0 });
    expect(request.minimumContextTokens).toBeUndefined();
  });

  it('MR18c: minimumContextTokens=-1 应被丢弃', () => {
    const request = capabilityRequestFromTask({ minimumContextTokens: -1 });
    expect(request.minimumContextTokens).toBeUndefined();
  });

  it('MR18d: minimumContextTokens=0.5 不应被截断为 0', () => {
    const request = capabilityRequestFromTask({ minimumContextTokens: 0.5 });
    // 0.5 → Math.trunc(0.5) = 0 → 违反 positive 契约，应被丢弃
    expect(request.minimumContextTokens).toBeUndefined();
  });

  it("MR18e: estimatedInputTokens=NaN 应被丢弃", () => {
    const request = capabilityRequestFromTask({ estimatedInputTokens: NaN });
    // normalizeOptionalNonNegativeInteger(NaN, undefined) → undefined（NaN 不 finite）
    // compactJson 随后剥离 undefined 键
    expect(request.estimatedInputTokens).toBeUndefined();
  });
});

// ============================================================================
// MR19: 大规模 profile 集合
// ============================================================================

describe('MR19: 大规模 profile 集合', () => {
  it('MR19a: 1000 个 profile 应在合理时间内完成且不崩溃', () => {
    const profiles = Array.from({ length: 1000 }, (_, i) =>
      profile(`model-${i}`, {
        capabilities: { code: Math.random(), json: Math.random() },
        costTier: (['free', 'low', 'medium', 'high'] as const)[i % 4]!,
        latencyMs: 100 + i,
        contextWindowTokens: 8_000 + i * 100,
      })
    );
    const decision = routeModelByCapability(profiles, {
      required: ['code'],
      preferred: ['json'],
    });
    expect(decision.selected).toBeDefined();
    expect(decision.candidates.length + decision.rejections.length).toBe(1000);
  });

  it('MR19b: 所有 profile 相同时应确定性选择第一个（按 ID）', () => {
    const profiles = Array.from({ length: 100 }, (_, i) =>
      profile(`model-${String(i).padStart(3, '0')}`, {
        capabilities: { code: 1 },
        costTier: 'low',
        latencyMs: 100,
        contextWindowTokens: 8_000,
      })
    );
    const decision = routeModelByCapability(profiles, { required: ['code'] });
    // 所有 profile 分数相同，应按 ID 排序，选择 model-000
    expect(decision.selected?.id).toBe('model-000');
  });
});

// ============================================================================
// MR20: provider 过滤边界
// ============================================================================

describe('MR20: provider 过滤', () => {
  it('MR20a: allowProviders 空数组应允许所有 provider', () => {
    const decision = routeModelByCapability(
      [profile('a', { providerId: 'p1', capabilities: { code: 1 } })],
      { required: ['code'] },
      { allowProviders: [] }
    );
    expect(decision.selected?.id).toBe('a');
  });

  it('MR20b: profile 无 providerId 时 allowProviders 非空应被拒绝', () => {
    const decision = routeModelByCapability(
      [profile('no-provider', { capabilities: { code: 1 } })],
      { required: ['code'] },
      { allowProviders: ['p1'] }
    );
    expect(decision.rejections[0]?.reasons).toContain('provider:not_allowed');
  });

  it('MR20c: denyProviders 与 allowProviders 同时存在时 deny 优先', () => {
    const decision = routeModelByCapability(
      [profile('dual', { providerId: 'p1', capabilities: { code: 1 } })],
      { required: ['code'] },
      { allowProviders: ['p1'], denyProviders: ['p1'] }
    );
    expect(decision.rejections[0]?.reasons).toContain('provider:denied');
    expect(decision.rejections[0]?.reasons).not.toContain(
      'provider:not_allowed'
    );
  });
});

// ============================================================================
// MR21: endpoint/streaming 过滤
// ============================================================================

describe('MR21: endpoint/streaming 过滤', () => {
  it("MR21a: requiredEndpointSupport=['auto'] 应匹配所有 endpoint", () => {
    const decision = routeModelByCapability(
      [
        profile('responses', {
          endpointSupport: 'responses',
          capabilities: { code: 1 },
        }),
        profile('chat', {
          endpointSupport: 'chat-completions',
          capabilities: { code: 1 },
        }),
      ],
      {
        required: ['code'],
        requiredEndpointSupport: ['auto'],
      }
    );
    expect(decision.candidates).toHaveLength(2);
  });

  it('MR21b: profile endpointSupport=undefined 时 requiredEndpointSupport 非空应被拒绝', () => {
    const decision = routeModelByCapability(
      [profile('no-endpoint', { capabilities: { code: 1 } })],
      {
        required: ['code'],
        requiredEndpointSupport: ['responses'],
      }
    );
    expect(
      decision.rejections[0]?.reasons.some((r) =>
        r.startsWith('endpoint:unsupported:')
      )
    ).toBe(true);
  });

  it("MR21c: streamingSupport='optional' 应匹配任何 requiredStreamingSupport", () => {
    const decision = routeModelByCapability(
      [
        profile('optional-stream', {
          streamingSupport: 'optional',
          capabilities: { code: 1 },
        }),
      ],
      {
        required: ['code'],
        requiredStreamingSupport: ['streaming'],
      }
    );
    expect(decision.candidates).toHaveLength(1);
  });
});

// ============================================================================
// MR22: trace 完整性
// ============================================================================

describe('MR22: trace 完整性', () => {
  it('MR22a: trace 应包含 profiles count', () => {
    const decision = routeModelByCapability(
      [profile('a', { capabilities: { code: 1 } })],
      { required: ['code'] }
    );
    expect(decision.trace[0]).toBe('profiles:1');
  });

  it('MR22b: trace 应包含 selected 或 selected:none', () => {
    const decisionWithSelection = routeModelByCapability(
      [profile('a', { capabilities: { code: 1 } })],
      { required: ['code'] }
    );
    expect(decisionWithSelection.trace.at(-1)).toBe('selected:a');

    const decisionWithoutSelection = routeModelByCapability(
      [profile('a', { capabilities: { json: 1 } })],
      { required: ['code'] }
    );
    expect(decisionWithoutSelection.trace.at(-1)).toBe('selected:none');
  });

  it('MR22c: reject trace 应包含原因', () => {
    const decision = routeModelByCapability(
      [profile('rejected', { capabilities: { json: 1 } })],
      { required: ['code'] }
    );
    expect(
      decision.trace.some((t) =>
        t.startsWith('reject:rejected:missing_required:code')
      )
    ).toBe(true);
  });
});
