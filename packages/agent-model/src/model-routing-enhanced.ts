import type { ModelCapabilityFlags } from './model-catalog/types';
import type {
  ModelProfile,
  EnhancedModelProfile,
  EnhancedTaskCapabilityRequest,
  RequiredCapabilityShape,
  NormalizedPolicySummary,
} from './model-routing';
import { scoreProfile, DEFAULT_MODEL_ROUTE_WEIGHTS } from './model-routing';

export type {
  EnhancedModelProfile,
  EnhancedTaskCapabilityRequest,
} from './model-routing';

export function scoreProfileWithCost(
  profile: EnhancedModelProfile,
  request: EnhancedTaskCapabilityRequest,
  weights?: { cost: number; capability: number; latency: number }
): number {
  const w = weights ?? { cost: 0.3, capability: 0.5, latency: 0.2 };
  let score = 0;

  // 1. 成本评分
  if (profile.pricing && request.maxTotalCostEstimate !== undefined) {
    const estimatedTokens = request.estimatedInputTokens ?? 1000;
    const estimatedOutput = request.estimatedOutputTokens ?? 500;
    const totalCost =
      estimatedTokens * profile.pricing.inputCostPerToken +
      estimatedOutput * profile.pricing.outputCostPerToken;

    // 预算淘汰
    if (totalCost > request.maxTotalCostEstimate) return -Infinity;

    // 归一化成本评分（$0.0001=1.0, $0.10=0.0）
    const normalizedCost = Math.max(
      0,
      1 - Math.log10(1 + totalCost / 0.0001) / 4
    );
    score += normalizedCost * w.cost;
  }

  // 2. 能力匹配评分（增强版）
  const requiredFlags = request.requiredCapabilities;
  if (requiredFlags && profile.capabilityFlags) {
    const matchedRequired = countMatchingFlags(
      requiredFlags,
      profile.capabilityFlags
    );
    const totalRequired = countEnabledFlags(requiredFlags);
    if (totalRequired > 0) {
      // 缺少必需能力 → 淘汰
      if (matchedRequired < totalRequired) return -Infinity;
      score += (matchedRequired / totalRequired) * w.capability;
    }
  }

  // 3. 保留原有 scoreProfile 逻辑
  const shape = toRequiredCapabilityShape(request);
  const policy: NormalizedPolicySummary = {
    allowProviders: [],
    denyProviders: [],
    preferModelIds: [],
    avoidModelIds: [],
    weights: { ...DEFAULT_MODEL_ROUTE_WEIGHTS },
  };
  const baseResult = scoreProfile(profile as ModelProfile, shape, policy);
  const remainingWeight = 1 - w.cost - w.capability;
  if (remainingWeight > 0) {
    score +=
      (baseResult.score /
        Math.max(...Object.values(DEFAULT_MODEL_ROUTE_WEIGHTS), 1)) *
      remainingWeight;
  }

  return score;
}

function toRequiredCapabilityShape(
  request: EnhancedTaskCapabilityRequest
): RequiredCapabilityShape {
  const tags = request.required ?? [];
  const preferredTags = request.preferred ?? [];
  const avoidTags = request.avoid ?? [];

  return {
    required: tags,
    preferred: preferredTags,
    avoid: avoidTags,
    requiredEndpointSupport: request.requiredEndpointSupport ?? [],
    requiredStreamingSupport: request.requiredStreamingSupport ?? [],
    ...(request.minimumContextTokens !== undefined
      ? { minimumContextTokens: request.minimumContextTokens }
      : {}),
  };
}

function countMatchingFlags(
  required: Partial<ModelCapabilityFlags>,
  actual: Partial<ModelCapabilityFlags>
): number {
  let count = 0;
  for (const [key, value] of Object.entries(required)) {
    if (value && actual[key as keyof ModelCapabilityFlags]) count++;
  }
  return count;
}

function countEnabledFlags(flags: Partial<Record<string, boolean>>): number {
  return Object.values(flags).filter(Boolean).length;
}
