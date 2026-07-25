import type { JsonObject, JsonValue } from "@crish/shared-types";
import { isRecord } from "@crish/shared-utils";
import {
  type ModelCapabilityTag,
  type ModelProfile,
  type ModelTaskKind,
  type ModelTaskPriority,
  type ModelCostTier,
  type ModelHealthStatus,
  type ModelAvailability,
  type TaskCapabilityRequest,
  type ModelTaskRoutingHint,
  type ModelRoutePolicy,
  type ModelRouteWeights,
  type ModelRouteCandidate,
  type ModelRouteRejection,
  type ModelRouteDecision,
  type RequiredCapabilityShape,
  type NormalizedPolicySummary,
  DEFAULT_MODEL_ROUTE_WEIGHTS,
} from "./types";
import {
  normalizeProfile,
  endpointSupportMatches,
  streamingSupportMatches,
  costTierField,
  uniqueEndpointSupport,
  uniqueStreamingSupport,
  uniqueTags,
  uniqueStrings,
  compactJson,
  clamp,
  roundScore,
  formatScore,
  normalizeOptionalNonNegativeInteger,
  normalizeOptionalPositiveInteger,
} from "./profile";

export function routeModelByCapability(
  profiles: ModelProfile[],
  request: TaskCapabilityRequest = {},
  policy: ModelRoutePolicy = {}
): ModelRouteDecision {
  const normalizedRequest = normalizeCapabilityRequest(request, policy);
  const normalizedPolicy = normalizePolicy(policy);
  const trace = [
    `profiles:${profiles.length}`,
    `required:${normalizedRequest.required.join(",") || "none"}`,
    `preferred:${normalizedRequest.preferred.join(",") || "none"}`,
    `avoid:${normalizedRequest.avoid.join(",") || "none"}`
  ];
  if (normalizedRequest.requiredEndpointSupport.length > 0) trace.push(`required_endpoint_support:${normalizedRequest.requiredEndpointSupport.join(",")}`);
  if (normalizedRequest.requiredStreamingSupport.length > 0) trace.push(`required_streaming_support:${normalizedRequest.requiredStreamingSupport.join(",")}`);
  if (normalizedRequest.minimumContextTokens !== undefined) trace.push(`minimum_context_tokens:${normalizedRequest.minimumContextTokens}`);
  if (normalizedPolicy.allowProviders.length > 0) trace.push(`allow_providers:${normalizedPolicy.allowProviders.join(",")}`);
  if (normalizedPolicy.denyProviders.length > 0) trace.push(`deny_providers:${normalizedPolicy.denyProviders.join(",")}`);
  if (normalizedPolicy.maxCostTier !== undefined) trace.push(`max_cost_tier:${normalizedPolicy.maxCostTier}`);

  const rejections: ModelRouteRejection[] = [];
  const candidates: Omit<ModelRouteCandidate, "rank">[] = [];

  for (const profile of profiles) {
    const normalizedProfile = normalizeProfile(profile);
    const rejectionReasons = rejectionReasonsForProfile(normalizedProfile, normalizedRequest, normalizedPolicy);
    if (rejectionReasons.length > 0) {
      rejections.push({ profile: normalizedProfile, reasons: rejectionReasons });
      trace.push(`reject:${normalizedProfile.id}:${rejectionReasons.join("|")}`);
      continue;
    }

    const candidate = scoreProfile(normalizedProfile, normalizedRequest, normalizedPolicy);
    candidates.push(candidate);
    trace.push(`candidate:${normalizedProfile.id}:score:${formatScore(candidate.score)}`);
  }

  const ranked = candidates
    .sort((a, b) => compareCandidates(a, b))
    .map((candidate, index): ModelRouteCandidate => ({ ...candidate, rank: index + 1 }));
  const selected = ranked[0]?.profile;
  trace.push(selected ? `selected:${selected.id}` : "selected:none");

  return {
    ...(selected !== undefined ? { selected } : {}),
    candidates: ranked,
    rejections: rejections.sort((a, b) => a.profile.id.localeCompare(b.profile.id)),
    trace,
    request: normalizedRequest,
    policy: normalizedPolicy
  };
}

export function routeModelForTask(
  profiles: ModelProfile[],
  task: ModelTaskRoutingHint = {},
  policy: ModelRoutePolicy = {}
): ModelRouteDecision {
  return routeModelByCapability(profiles, capabilityRequestFromTask(task), mergeModelRoutePolicies(policyFromTask(task), policy));
}

export function capabilityRequestFromTask(task: ModelTaskRoutingHint = {}): TaskCapabilityRequest {
  const defaults = capabilityDefaultsForTask(task.kind ?? "general");
  const required = uniqueTags([
    ...defaults.required,
    ...(task.needsVision ? ["vision" as const] : []),
    ...(task.needsSearch ? ["search" as const] : []),
    ...(task.needsChineseWriting ? ["chinese-writing" as const] : []),
    ...(task.required ?? [])
  ]);
  const preferred = uniqueTags([
    ...defaults.preferred,
    ...(task.needsToolUse ? ["tool-use" as const] : []),
    ...(task.needsJson ? ["json" as const] : []),
    ...(task.needsLongContext ? ["long-context" as const] : []),
    ...priorityPreferredCapabilities(task.priority),
    ...(task.preferred ?? [])
  ]).filter((tag) => !required.includes(tag));
  const avoid = uniqueTags([...(defaults.avoid ?? []), ...(task.avoid ?? [])]).filter((tag) => !required.includes(tag));

  return compactJson({
    required,
    preferred,
    avoid,
    estimatedInputTokens: normalizeOptionalNonNegativeInteger(task.estimatedInputTokens, undefined),
    estimatedOutputTokens: normalizeOptionalNonNegativeInteger(task.estimatedOutputTokens, undefined),
    ...(normalizeOptionalPositiveInteger(task.minimumContextTokens, undefined) !== undefined ? { minimumContextTokens: normalizeOptionalPositiveInteger(task.minimumContextTokens, undefined) } : {}),
    ...(task.metadata !== undefined ? { metadata: task.metadata } : {})
  }) as unknown as TaskCapabilityRequest;
}

export function policyFromTask(task: ModelTaskRoutingHint = {}): ModelRoutePolicy {
  const priority = task.priority ?? "balanced";
  const weights: Partial<ModelRouteWeights> | undefined =
    priority === "quality"
      ? {
          preferredCapability: 24,
          missingPreferredPenalty: 2,
          health: 20,
          cost: 4,
          latency: 5,
          context: 10,
          priority: 8
        }
      : priority === "latency"
        ? {
            preferredCapability: 14,
            missingPreferredPenalty: 2,
            latency: 24,
            health: 16,
            cost: 6
          }
        : priority === "cost"
          ? {
              preferredCapability: 14,
              missingPreferredPenalty: 2,
              cost: 24,
              latency: 8,
              health: 12
            }
          : undefined;

  return compactJson({
    preferred: priorityPreferredCapabilities(priority),
    weights,
    metadata: task.metadata
  }) as unknown as ModelRoutePolicy;
}

export function hasMediaContent(messages: { metadata?: { contentParts?: unknown[] } }[]): boolean {
  for (const message of messages) {
    const parts = message.metadata?.contentParts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part && typeof part === "object" && !Array.isArray(part)) {
          const p = part as Record<string, unknown>;
          if (p.type === "image_url" || p.type === "input_audio" || p.type === "input_video" || p.type === "input_file") {
            return true;
          }
        }
      }
    }
  }
  return false;
}

export function mergeModelRoutePolicies(base: ModelRoutePolicy = {}, override: ModelRoutePolicy = {}): ModelRoutePolicy {
  return compactJson({
    required: uniqueTags([...(base.required ?? []), ...(override.required ?? [])]),
    preferred: uniqueTags([...(base.preferred ?? []), ...(override.preferred ?? [])]),
    avoid: uniqueTags([...(base.avoid ?? []), ...(override.avoid ?? [])]),
    requiredEndpointSupport: uniqueEndpointSupport([...(base.requiredEndpointSupport ?? []), ...(override.requiredEndpointSupport ?? [])]),
    requiredStreamingSupport: uniqueStreamingSupport([...(base.requiredStreamingSupport ?? []), ...(override.requiredStreamingSupport ?? [])]),
    allowProviders: uniqueStrings([...(base.allowProviders ?? []), ...(override.allowProviders ?? [])]),
    denyProviders: uniqueStrings([...(base.denyProviders ?? []), ...(override.denyProviders ?? [])]),
    maxCostTier: override.maxCostTier ?? base.maxCostTier,
    minimumContextTokens: override.minimumContextTokens ?? base.minimumContextTokens,
    weights: {
      ...(base.weights ?? {}),
      ...(override.weights ?? {})
    },
    preferModelIds: uniqueStrings([...(base.preferModelIds ?? []), ...(override.preferModelIds ?? [])]),
    avoidModelIds: uniqueStrings([...(base.avoidModelIds ?? []), ...(override.avoidModelIds ?? [])]),
    metadata: deepMergeJsonObjects(base.metadata, override.metadata)
  }) as unknown as ModelRoutePolicy;
}

/**
 * 递归深合并两个 JsonObject：对同为 record 的键递归合并，其余键 override 胜出。
 * 避免浅展开导致嵌套 metadata 被整体覆盖。
 */
function deepMergeJsonObjects(base: JsonObject | undefined, override: JsonObject | undefined): JsonObject | undefined {
  if (!base && !override) return undefined;
  if (!base) return override;
  if (!override) return base;
  const result: JsonObject = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
  for (const key of keys) {
    const baseValue = base[key] as JsonValue | undefined;
    const overrideValue = override[key] as JsonValue | undefined;
    if (overrideValue === undefined) {
      if (baseValue !== undefined) result[key] = baseValue;
    } else if (baseValue === undefined) {
      result[key] = overrideValue;
    } else if (isRecord(baseValue) && isRecord(overrideValue)) {
      const merged = deepMergeJsonObjects(baseValue as JsonObject, overrideValue as JsonObject);
      if (merged !== undefined) result[key] = merged;
    } else {
      result[key] = overrideValue;
    }
  }
  return result;
}

export function modelRouteDecisionToMetadata(decision: ModelRouteDecision): JsonObject {
  return compactJson({
    selectedModelProfileId: decision.selected?.id,
    candidates: decision.candidates.map((candidate) =>
      compactJson({
        id: candidate.profile.id,
        providerId: candidate.profile.providerId,
        routeId: candidate.profile.routeId,
        endpointSupport: candidate.profile.endpointSupport,
        streamingSupport: candidate.profile.streamingSupport,
        score: roundScore(candidate.score),
        rank: candidate.rank,
        matchedRequired: candidate.matchedRequired,
        matchedPreferred: candidate.matchedPreferred,
        matchedAvoided: candidate.matchedAvoided,
        reasons: candidate.reasons
      })
    ),
    rejections: decision.rejections.map((rejection) => ({
      id: rejection.profile.id,
      providerId: rejection.profile.providerId ?? null,
      routeId: rejection.profile.routeId ?? null,
      reasons: rejection.reasons
    })),
    trace: decision.trace
  });
}

export function scoreProfile(
  profile: ModelProfile,
  request: RequiredCapabilityShape,
  policy: NormalizedPolicySummary
): Omit<ModelRouteCandidate, "rank"> {
  const weights = policy.weights;
  const reasons: string[] = [];
  const matchedRequired = request.required.filter((tag) => capabilityScore(profile, tag) > 0);
  const matchedPreferred = request.preferred.filter((tag) => capabilityScore(profile, tag) > 0);
  const matchedAvoided = request.avoid.filter((tag) => capabilityScore(profile, tag) > 0);
  let score = 0;

  for (const tag of matchedRequired) {
    const contribution = capabilityScore(profile, tag) * weights.requiredCapability;
    score += contribution;
    reasons.push(`required:${tag}:${formatScore(contribution)}`);
  }

  for (const tag of request.preferred) {
    const capability = capabilityScore(profile, tag);
    if (capability > 0) {
      const contribution = capability * weights.preferredCapability;
      score += contribution;
      reasons.push(`preferred:${tag}:${formatScore(contribution)}`);
    } else if (weights.missingPreferredPenalty > 0) {
      score -= weights.missingPreferredPenalty;
      reasons.push(`missing_preferred:${tag}:-${formatScore(weights.missingPreferredPenalty)}`);
    }
  }

  for (const tag of matchedAvoided) {
    const penalty = capabilityScore(profile, tag) * weights.avoidCapabilityPenalty;
    score -= penalty;
    reasons.push(`avoid:${tag}:-${formatScore(penalty)}`);
  }

  const health = healthScore(profile.health) * weights.health;
  const availability = availabilityScore(profile.availability) * weights.availability;
  const cost = costScore(profile.costTier) * weights.cost;
  const latency = latencyScore(profile.latencyMs) * weights.latency;
  const context = contextScore(profile.contextWindowTokens, request.minimumContextTokens) * weights.context;
  const priority = priorityScore(profile.priority) * weights.priority;
  score += health + availability + cost + latency + context + priority;
  reasons.push(`health:${formatScore(health)}`);
  reasons.push(`availability:${formatScore(availability)}`);
  reasons.push(`cost:${formatScore(cost)}`);
  reasons.push(`latency:${formatScore(latency)}`);
  reasons.push(`context:${formatScore(context)}`);
  reasons.push(`priority:${formatScore(priority)}`);

  if (policy.preferModelIds.includes(profile.id)) {
    score += weights.preferredModel;
    reasons.push(`preferred_model:${formatScore(weights.preferredModel)}`);
  }
  if (policy.avoidModelIds.includes(profile.id)) {
    score -= weights.avoidedModelPenalty;
    reasons.push(`avoided_model:-${formatScore(weights.avoidedModelPenalty)}`);
  }

  return {
    profile,
    score: roundScore(score),
    matchedRequired,
    matchedPreferred,
    matchedAvoided,
    reasons
  };
}

function compareCandidates(a: Omit<ModelRouteCandidate, "rank">, b: Omit<ModelRouteCandidate, "rank">): number {
  return (
    b.score - a.score ||
    healthScore(b.profile.health) - healthScore(a.profile.health) ||
    costScore(b.profile.costTier) - costScore(a.profile.costTier) ||
    latencyScore(b.profile.latencyMs) - latencyScore(a.profile.latencyMs) ||
    contextScore(b.profile.contextWindowTokens, undefined) - contextScore(a.profile.contextWindowTokens, undefined) ||
    priorityScore(b.profile.priority) - priorityScore(a.profile.priority) ||
    a.profile.id.localeCompare(b.profile.id)
  );
}

function capabilityScore(profile: ModelProfile, tag: ModelCapabilityTag): number {
  const raw = profile.capabilities?.[tag];
  if (raw === true) return 1;
  if (raw === false) return 0;
  if (raw !== undefined) {
    const number = Number(raw);
    if (Number.isFinite(number)) return clamp(number, 0, 1);
  }
  const enhanced = profile as { capabilityFlags?: Record<string, boolean | undefined> };
  const flagMap: Record<string, string> = {
    vision: "supportsVision",
    "tool-use": "supportsFunctionCalling",
    reasoning: "supportsReasoning",
  };
  const flagKey = flagMap[tag];
  if (flagKey && enhanced.capabilityFlags?.[flagKey]) return 1;
  return 0;
}

function healthScore(status: ModelHealthStatus | undefined): number {
  if (status === "healthy") return 1;
  if (status === "degraded") return 0.45;
  if (status === "unhealthy") return 0;
  return 0.5;
}

function availabilityScore(status: ModelAvailability | undefined): number {
  if (status === "available") return 1;
  if (status === "limited") return 0.55;
  if (status === "unavailable") return 0;
  return 0.45;
}

function costScore(tier: ModelCostTier | number | undefined): number {
  const rank = costTierRank(tier);
  if (rank === undefined) return 0.35;
  return clamp(1 - rank / 5, 0, 1);
}

function latencyScore(latencyMs: number | undefined): number {
  if (latencyMs === undefined) return 0.35;
  if (latencyMs <= 250) return 1;
  if (latencyMs >= 10_000) return 0;
  return clamp(1 - (latencyMs - 250) / 9_750, 0, 1);
}

function contextScore(contextWindowTokens: number | undefined, minimumContextTokens: number | undefined): number {
  if (contextWindowTokens === undefined) return minimumContextTokens === undefined ? 0.35 : 0;
  if (minimumContextTokens === undefined) return clamp(contextWindowTokens / 200_000, 0, 1);
  if (contextWindowTokens < minimumContextTokens) return 0;
  return clamp(contextWindowTokens / Math.max(minimumContextTokens * 4, 1), 0.25, 1);
}

function priorityScore(priority: number | undefined): number {
  if (priority === undefined) return 0;
  return clamp(priority / 100, 0, 1);
}

function costTierRank(tier: ModelCostTier | number | undefined): number | undefined {
  if (typeof tier === "number" && Number.isFinite(tier)) return clamp(Math.trunc(tier), 0, 5);
  if (tier === "free") return 0;
  if (tier === "low") return 1;
  if (tier === "medium") return 2;
  if (tier === "high") return 3;
  if (tier === "premium") return 4;
  if (tier === "unknown") return undefined;
  return undefined;
}

function compareCostTier(actual: ModelCostTier | number | undefined, maximum: ModelCostTier | number): number {
  const actualRank = costTierRank(actual);
  const maximumRank = costTierRank(maximum);
  if (actualRank === undefined) return 1;
  if (maximumRank === undefined) return 0;
  return actualRank - maximumRank;
}

function normalizeWeights(weights: Partial<ModelRouteWeights> | undefined): Partial<ModelRouteWeights> {
  if (!weights) return {};
  const next: Partial<ModelRouteWeights> = {};
  for (const [key, value] of Object.entries(weights) as Array<[keyof ModelRouteWeights, number | undefined]>) {
    if (typeof value === "number" && Number.isFinite(value)) next[key] = Math.max(0, value);
  }
  return next;
}

function normalizeCapabilityRequest(request: TaskCapabilityRequest, policy: ModelRoutePolicy): RequiredCapabilityShape {
  const estimatedInputTokens = normalizeOptionalNonNegativeInteger(request.estimatedInputTokens, 0);
  const estimatedOutputTokens = normalizeOptionalNonNegativeInteger(request.estimatedOutputTokens, 0);
  const estimatedTokens = estimatedInputTokens + estimatedOutputTokens;
  // 防护 estimatedTokens 溢出或过大：两个 MAX_SAFE_INTEGER 相加会超出安全整数范围
  const minimumContextTokens =
    normalizeOptionalPositiveInteger(policy.minimumContextTokens, undefined) ??
    normalizeOptionalPositiveInteger(request.minimumContextTokens, undefined) ??
    (Number.isFinite(estimatedTokens) && estimatedTokens > 0 && estimatedTokens <= Number.MAX_SAFE_INTEGER
      ? estimatedTokens
      : undefined);
  return compactJson({
    required: uniqueTags([...(request.required ?? []), ...(policy.required ?? [])]),
    preferred: uniqueTags([...(request.preferred ?? []), ...(policy.preferred ?? [])]),
    avoid: uniqueTags([...(request.avoid ?? []), ...(policy.avoid ?? [])]),
    requiredEndpointSupport: uniqueEndpointSupport([...(request.requiredEndpointSupport ?? []), ...(policy.requiredEndpointSupport ?? [])]),
    requiredStreamingSupport: uniqueStreamingSupport([...(request.requiredStreamingSupport ?? []), ...(policy.requiredStreamingSupport ?? [])]),
    ...(minimumContextTokens !== undefined ? { minimumContextTokens } : {})
  }) as unknown as RequiredCapabilityShape;
}

function capabilityDefaultsForTask(kind: ModelTaskKind): {
  required: ModelCapabilityTag[];
  preferred: ModelCapabilityTag[];
  avoid?: ModelCapabilityTag[];
} {
  switch (kind) {
    case "code":
      return { required: ["code"], preferred: ["tool-use", "json", "reasoning", "cache-friendly"] };
    case "code-review":
      return { required: ["code"], preferred: ["code-review", "reasoning", "json", "long-context"] };
    case "search":
      return { required: ["search"], preferred: ["reasoning", "json", "low-latency"] };
    case "vision":
      return { required: ["vision"], preferred: ["reasoning", "json"] };
    case "chinese-writing":
      return { required: ["chinese-writing"], preferred: ["reasoning", "low-cost"] };
    case "planning":
      return { required: ["reasoning"], preferred: ["planning", "json", "long-context", "tool-use"] };
    case "requirements-alignment":
      return { required: ["reasoning"], preferred: ["requirements-alignment", "chinese-writing", "json", "long-context"] };
    case "workflow":
      return { required: ["tool-use"], preferred: ["workflow", "json", "low-cost"] };
    case "background":
      return { required: [], preferred: ["low-cost", "json", "tool-use"] };
    default:
      return { required: [], preferred: ["reasoning", "json"] };
  }
}

function priorityPreferredCapabilities(priority: ModelTaskPriority | undefined): ModelCapabilityTag[] {
  if (priority === "latency") return ["low-latency"];
  if (priority === "cost") return ["low-cost"];
  if (priority === "quality") return ["reasoning", "long-context"];
  return [];
}

function normalizePolicy(policy: ModelRoutePolicy): NormalizedPolicySummary {
  const maxCostTier = costTierField(policy.maxCostTier);
  return {
    allowProviders: uniqueStrings(policy.allowProviders ?? []),
    denyProviders: uniqueStrings(policy.denyProviders ?? []),
    ...(maxCostTier !== undefined ? { maxCostTier } : {}),
    preferModelIds: uniqueStrings(policy.preferModelIds ?? []),
    avoidModelIds: uniqueStrings(policy.avoidModelIds ?? []),
    weights: {
      ...DEFAULT_MODEL_ROUTE_WEIGHTS,
      ...normalizeWeights(policy.weights)
    }
  };
}

function rejectionReasonsForProfile(profile: ModelProfile, request: RequiredCapabilityShape, policy: NormalizedPolicySummary): string[] {
  const reasons: string[] = [];
  if (profile.availability === "unavailable") reasons.push("availability:unavailable");
  if (profile.health === "unhealthy") reasons.push("health:unhealthy");
  if (policy.allowProviders.length > 0 && (!profile.providerId || !policy.allowProviders.includes(profile.providerId))) {
    reasons.push("provider:not_allowed");
  }
  if (profile.providerId && policy.denyProviders.includes(profile.providerId)) reasons.push("provider:denied");
  if (policy.maxCostTier !== undefined && compareCostTier(profile.costTier, policy.maxCostTier) > 0) reasons.push("cost:above_policy");
  if (request.minimumContextTokens !== undefined) {
    if (profile.contextWindowTokens === undefined) reasons.push("context:unknown");
    else if (profile.contextWindowTokens < request.minimumContextTokens) reasons.push("context:too_small");
  }
  if (request.requiredEndpointSupport.length > 0 && !endpointSupportMatches(profile.endpointSupport, request.requiredEndpointSupport)) {
    reasons.push(`endpoint:unsupported:${request.requiredEndpointSupport.join(",")}`);
  }
  if (request.requiredStreamingSupport.length > 0 && !streamingSupportMatches(profile.streamingSupport, request.requiredStreamingSupport)) {
    reasons.push(`streaming:unsupported:${request.requiredStreamingSupport.join(",")}`);
  }
  for (const tag of request.required) {
    if (capabilityScore(profile, tag) <= 0) reasons.push(`missing_required:${tag}`);
  }
  return reasons;
}
