import type { JsonObject, JsonValue } from "@crish/shared-types";
import { isRecord } from "@crish/shared-utils";

export type ModelCapabilityTag =
  | "code"
  | "code-review"
  | "vision"
  | "search"
  | "reasoning"
  | "chinese-writing"
  | "long-context"
  | "low-latency"
  | "low-cost"
  | "tool-use"
  | "json"
  | "planning"
  | "requirements-alignment"
  | "cache-friendly"
  | "workflow"
  | (string & {});

export type ModelTaskKind =
  | "general"
  | "code"
  | "code-review"
  | "search"
  | "vision"
  | "chinese-writing"
  | "planning"
  | "requirements-alignment"
  | "workflow"
  | "background"
  | (string & {});

export type ModelTaskPriority = "balanced" | "quality" | "latency" | "cost";

export type ModelAvailability = "available" | "limited" | "unavailable" | "unknown";
export type ModelHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";
export type ModelCostTier = "free" | "low" | "medium" | "high" | "premium" | "unknown";
export type ProviderEndpointSupport = "responses" | "chat-completions" | "auto";
export type ProviderStreamingSupport = "streaming" | "non-streaming" | "optional" | "unknown";

export interface ProviderRouteHealthEvent {
  at?: number | null;
  latencyMs?: number | null;
  errorCode?: string | null;
  metadata?: JsonObject;
}

export interface ModelProviderRouteMetadata {
  providerId?: string;
  routeId?: string;
  model?: string;
  upstreamModel?: string;
  endpointSupport?: ProviderEndpointSupport;
  streamingSupport?: ProviderStreamingSupport;
  credentialSource?: JsonObject;
  health?: ModelHealthStatus;
  lastSuccess?: ProviderRouteHealthEvent;
  lastFailure?: ProviderRouteHealthEvent;
  metadata?: JsonObject;
}

export interface ModelProfile {
  id: string;
  providerId?: string;
  routeId?: string;
  model?: string;
  upstreamModel?: string;
  endpointSupport?: ProviderEndpointSupport;
  streamingSupport?: ProviderStreamingSupport;
  credentialSource?: JsonObject;
  route?: ModelProviderRouteMetadata;
  aliases?: string[];
  capabilities?: Partial<Record<ModelCapabilityTag, number | boolean>>;
  costTier?: ModelCostTier | number;
  latencyMs?: number;
  contextWindowTokens?: number;
  availability?: ModelAvailability;
  health?: ModelHealthStatus;
  lastSuccess?: ProviderRouteHealthEvent;
  lastFailure?: ProviderRouteHealthEvent;
  priority?: number;
  metadata?: JsonObject;
}

export interface TaskCapabilityRequest {
  required?: ModelCapabilityTag[];
  preferred?: ModelCapabilityTag[];
  avoid?: ModelCapabilityTag[];
  requiredEndpointSupport?: ProviderEndpointSupport[];
  requiredStreamingSupport?: ProviderStreamingSupport[];
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  minimumContextTokens?: number;
  metadata?: JsonObject;
}

export interface ModelTaskRoutingHint {
  kind?: ModelTaskKind;
  priority?: ModelTaskPriority;
  required?: ModelCapabilityTag[];
  preferred?: ModelCapabilityTag[];
  avoid?: ModelCapabilityTag[];
  needsToolUse?: boolean;
  needsJson?: boolean;
  needsLongContext?: boolean;
  needsVision?: boolean;
  needsSearch?: boolean;
  needsChineseWriting?: boolean;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  minimumContextTokens?: number;
  metadata?: JsonObject;
}

export interface ModelRoutePolicy {
  required?: ModelCapabilityTag[];
  preferred?: ModelCapabilityTag[];
  avoid?: ModelCapabilityTag[];
  requiredEndpointSupport?: ProviderEndpointSupport[];
  requiredStreamingSupport?: ProviderStreamingSupport[];
  allowProviders?: string[];
  denyProviders?: string[];
  maxCostTier?: ModelCostTier | number;
  minimumContextTokens?: number;
  weights?: Partial<ModelRouteWeights>;
  preferModelIds?: string[];
  avoidModelIds?: string[];
  metadata?: JsonObject;
}

export interface ModelRouteWeights {
  requiredCapability: number;
  preferredCapability: number;
  missingPreferredPenalty: number;
  avoidCapabilityPenalty: number;
  health: number;
  availability: number;
  cost: number;
  latency: number;
  context: number;
  priority: number;
  preferredModel: number;
  avoidedModelPenalty: number;
}

export interface ModelRouteCandidate {
  profile: ModelProfile;
  score: number;
  rank: number;
  matchedRequired: ModelCapabilityTag[];
  matchedPreferred: ModelCapabilityTag[];
  matchedAvoided: ModelCapabilityTag[];
  reasons: string[];
}

export interface ModelRouteRejection {
  profile: ModelProfile;
  reasons: string[];
}

export interface ModelRouteDecision {
  selected?: ModelProfile;
  candidates: ModelRouteCandidate[];
  rejections: ModelRouteRejection[];
  trace: string[];
  request: RequiredCapabilityShape;
  policy: NormalizedPolicySummary;
}

export interface RequiredCapabilityShape {
  required: ModelCapabilityTag[];
  preferred: ModelCapabilityTag[];
  avoid: ModelCapabilityTag[];
  requiredEndpointSupport: ProviderEndpointSupport[];
  requiredStreamingSupport: ProviderStreamingSupport[];
  minimumContextTokens?: number;
}

export interface NormalizedPolicySummary {
  allowProviders: string[];
  denyProviders: string[];
  maxCostTier?: ModelCostTier | number;
  preferModelIds: string[];
  avoidModelIds: string[];
  weights: ModelRouteWeights;
}

export interface ProviderRouteOfferLike {
  id: string;
  model: string;
  aliases?: string[];
  providerId: string;
  upstreamModel?: string;
  endpointType?: string;
  endpointSupport?: ProviderEndpointSupport;
  streamingSupport?: ProviderStreamingSupport;
  credentialSource?: JsonObject;
  priority?: number;
  routingWeight?: number;
  health?: {
    status?: ModelHealthStatus;
    lastLatencyMs?: number | null;
    lastSuccessAt?: number | null;
    lastFailureAt?: number | null;
    lastSuccess?: ProviderRouteHealthEvent;
    lastFailure?: ProviderRouteHealthEvent;
    metadata?: JsonObject;
  };
  metadata?: JsonObject;
}

export const DEFAULT_MODEL_ROUTE_WEIGHTS: ModelRouteWeights = {
  requiredCapability: 100,
  preferredCapability: 18,
  missingPreferredPenalty: 3,
  avoidCapabilityPenalty: 35,
  health: 14,
  availability: 12,
  cost: 10,
  latency: 8,
  context: 6,
  priority: 4,
  preferredModel: 20,
  avoidedModelPenalty: 30
};

const KNOWN_COST_TIERS: ModelCostTier[] = ["free", "low", "medium", "high", "premium", "unknown"];

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
    selected,
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
    minimumContextTokens: normalizeOptionalPositiveInteger(task.minimumContextTokens, undefined),
    metadata: task.metadata
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
    metadata: compactJson({
      ...(base.metadata ?? {}),
      ...(override.metadata ?? {})
    })
  }) as unknown as ModelRoutePolicy;
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

export function profileFromProviderRouteOffer(offer: ProviderRouteOfferLike): ModelProfile {
  const metadataProfile = modelProfileFromMetadata(offer.metadata?.modelProfile);
  const healthProfile = modelProfileFromMetadata(offer.health?.metadata?.modelProfile);
  return normalizeProfile({
    id: metadataProfile?.id ?? healthProfile?.id ?? offer.id,
    providerId: metadataProfile?.providerId ?? healthProfile?.providerId ?? offer.providerId,
    routeId: metadataProfile?.routeId ?? healthProfile?.routeId ?? offer.id,
    model: metadataProfile?.model ?? healthProfile?.model ?? offer.model,
    upstreamModel: metadataProfile?.upstreamModel ?? healthProfile?.upstreamModel ?? offer.upstreamModel ?? offer.model,
    endpointSupport: metadataProfile?.endpointSupport ?? healthProfile?.endpointSupport ?? endpointSupportField(offer.endpointSupport ?? offer.endpointType),
    streamingSupport: metadataProfile?.streamingSupport ?? healthProfile?.streamingSupport ?? streamingSupportField(offer.streamingSupport),
    credentialSource: metadataProfile?.credentialSource ?? healthProfile?.credentialSource ?? offer.credentialSource,
    route: routeMetadataFromOffer(offer, metadataProfile?.route ?? healthProfile?.route),
    aliases: metadataProfile?.aliases ?? healthProfile?.aliases ?? offer.aliases,
    capabilities: metadataProfile?.capabilities ?? healthProfile?.capabilities,
    costTier: metadataProfile?.costTier ?? healthProfile?.costTier,
    latencyMs: metadataProfile?.latencyMs ?? healthProfile?.latencyMs ?? nullableNumberToUndefined(offer.health?.lastLatencyMs),
    contextWindowTokens: metadataProfile?.contextWindowTokens ?? healthProfile?.contextWindowTokens,
    availability: metadataProfile?.availability ?? healthProfile?.availability,
    health: metadataProfile?.health ?? healthProfile?.health ?? offer.health?.status,
    lastSuccess: metadataProfile?.lastSuccess ?? healthProfile?.lastSuccess ?? routeHealthEventField(offer.health?.lastSuccess, offer.health?.lastSuccessAt, offer.health?.lastLatencyMs),
    lastFailure: metadataProfile?.lastFailure ?? healthProfile?.lastFailure ?? routeHealthEventField(offer.health?.lastFailure, offer.health?.lastFailureAt, undefined),
    priority: metadataProfile?.priority ?? healthProfile?.priority ?? offer.priority ?? offer.routingWeight,
    metadata: metadataProfile?.metadata ?? healthProfile?.metadata
  });
}

export function modelProfileFromMetadata(value: unknown): ModelProfile | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringField(value.id);
  const model = stringField(value.model);
  if (!id && !model) return undefined;
  return normalizeProfile({
    id: id ?? model ?? "unknown",
    providerId: stringField(value.providerId),
    routeId: stringField(value.routeId),
    model,
    upstreamModel: stringField(value.upstreamModel),
    endpointSupport: endpointSupportField(value.endpointSupport),
    streamingSupport: streamingSupportField(value.streamingSupport),
    credentialSource: jsonObjectField(value.credentialSource),
    route: routeMetadataField(value.route),
    aliases: stringArrayField(value.aliases),
    capabilities: capabilitiesField(value.capabilities),
    costTier: costTierField(value.costTier),
    latencyMs: nonNegativeNumberField(value.latencyMs),
    contextWindowTokens: positiveIntegerField(value.contextWindowTokens),
    availability: availabilityField(value.availability),
    health: healthField(value.health),
    lastSuccess: routeHealthEventField(value.lastSuccess),
    lastFailure: routeHealthEventField(value.lastFailure),
    priority: nonNegativeNumberField(value.priority),
    metadata: jsonObjectField(value.metadata)
  });
}

function normalizeCapabilityRequest(request: TaskCapabilityRequest, policy: ModelRoutePolicy): RequiredCapabilityShape {
  const estimatedInputTokens = normalizeOptionalNonNegativeInteger(request.estimatedInputTokens, 0);
  const estimatedOutputTokens = normalizeOptionalNonNegativeInteger(request.estimatedOutputTokens, 0);
  const estimatedTokens = estimatedInputTokens + estimatedOutputTokens;
  const minimumContextTokens =
    normalizeOptionalPositiveInteger(policy.minimumContextTokens, undefined) ??
    normalizeOptionalPositiveInteger(request.minimumContextTokens, undefined) ??
    (estimatedTokens > 0 ? estimatedTokens : undefined);
  return compactJson({
    required: uniqueTags([...(request.required ?? []), ...(policy.required ?? [])]),
    preferred: uniqueTags([...(request.preferred ?? []), ...(policy.preferred ?? [])]),
    avoid: uniqueTags([...(request.avoid ?? []), ...(policy.avoid ?? [])]),
    requiredEndpointSupport: uniqueEndpointSupport([...(request.requiredEndpointSupport ?? []), ...(policy.requiredEndpointSupport ?? [])]),
    requiredStreamingSupport: uniqueStreamingSupport([...(request.requiredStreamingSupport ?? []), ...(policy.requiredStreamingSupport ?? [])]),
    minimumContextTokens
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
  return {
    allowProviders: uniqueStrings(policy.allowProviders ?? []),
    denyProviders: uniqueStrings(policy.denyProviders ?? []),
    maxCostTier: costTierField(policy.maxCostTier),
    preferModelIds: uniqueStrings(policy.preferModelIds ?? []),
    avoidModelIds: uniqueStrings(policy.avoidModelIds ?? []),
    weights: {
      ...DEFAULT_MODEL_ROUTE_WEIGHTS,
      ...normalizeWeights(policy.weights)
    }
  };
}

function normalizeProfile(profile: ModelProfile): ModelProfile {
  const capabilities = normalizeCapabilities(profile.capabilities);
  return {
    id: normalizeString(profile.id) || normalizeString(profile.model) || "unknown",
    providerId: normalizeOptionalString(profile.providerId),
    routeId: normalizeOptionalString(profile.routeId),
    model: normalizeOptionalString(profile.model),
    upstreamModel: normalizeOptionalString(profile.upstreamModel),
    endpointSupport: endpointSupportField(profile.endpointSupport),
    streamingSupport: streamingSupportField(profile.streamingSupport),
    credentialSource: jsonObjectField(profile.credentialSource),
    route: routeMetadataField(profile.route),
    aliases: uniqueStrings(profile.aliases ?? []),
    capabilities,
    costTier: costTierField(profile.costTier),
    latencyMs: normalizeOptionalNonNegativeInteger(profile.latencyMs, undefined),
    contextWindowTokens: normalizeOptionalPositiveInteger(profile.contextWindowTokens, undefined),
    availability: availabilityField(profile.availability),
    health: healthField(profile.health),
    lastSuccess: routeHealthEventField(profile.lastSuccess),
    lastFailure: routeHealthEventField(profile.lastFailure),
    priority: normalizeOptionalNonNegativeInteger(profile.priority, undefined),
    metadata: profile.metadata
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

function scoreProfile(
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
  if (raw === false || raw === undefined) return 0;
  const number = Number(raw);
  if (!Number.isFinite(number)) return 0;
  return clamp(number, 0, 1);
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

function compareCostTier(actual: ModelCostTier | number | undefined, maximum: ModelCostTier | number): number {
  const actualRank = costTierRank(actual);
  const maximumRank = costTierRank(maximum);
  if (actualRank === undefined) return 1;
  if (maximumRank === undefined) return 0;
  return actualRank - maximumRank;
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

function normalizeWeights(weights: Partial<ModelRouteWeights> | undefined): Partial<ModelRouteWeights> {
  if (!weights) return {};
  const next: Partial<ModelRouteWeights> = {};
  for (const [key, value] of Object.entries(weights) as Array<[keyof ModelRouteWeights, number | undefined]>) {
    if (typeof value === "number" && Number.isFinite(value)) next[key] = Math.max(0, value);
  }
  return next;
}

function normalizeCapabilities(capabilities: Partial<Record<ModelCapabilityTag, number | boolean>> | undefined): Partial<Record<ModelCapabilityTag, number>> | undefined {
  if (!capabilities) return undefined;
  const entries = Object.entries(capabilities)
    .map(([tag, value]): [ModelCapabilityTag, number] | undefined => {
      const normalizedTag = normalizeString(tag);
      if (!normalizedTag) return undefined;
      if (value === true) return [normalizedTag, 1];
      if (value === false) return [normalizedTag, 0];
      const number = Number(value);
      if (!Number.isFinite(number)) return undefined;
      return [normalizedTag, clamp(number, 0, 1)];
    })
    .filter((entry): entry is [ModelCapabilityTag, number] => Boolean(entry));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function capabilitiesField(value: unknown): Partial<Record<ModelCapabilityTag, number>> | undefined {
  if (!isRecord(value)) return undefined;
  return normalizeCapabilities(value as Partial<Record<ModelCapabilityTag, number | boolean>>);
}

function costTierField(value: unknown): ModelCostTier | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return clamp(Math.trunc(value), 0, 5);
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return KNOWN_COST_TIERS.includes(normalized as ModelCostTier) ? (normalized as ModelCostTier) : undefined;
}

function availabilityField(value: unknown): ModelAvailability | undefined {
  if (value === "available" || value === "limited" || value === "unavailable" || value === "unknown") return value;
  return undefined;
}

function healthField(value: unknown): ModelHealthStatus | undefined {
  if (value === "healthy" || value === "degraded" || value === "unhealthy" || value === "unknown") return value;
  return undefined;
}

function endpointSupportField(value: unknown): ProviderEndpointSupport | undefined {
  if (value === "responses" || value === "chat-completions" || value === "auto") return value;
  return undefined;
}

function streamingSupportField(value: unknown): ProviderStreamingSupport | undefined {
  if (value === "streaming" || value === "non-streaming" || value === "optional" || value === "unknown") return value;
  if (value === true) return "streaming";
  if (value === false) return "non-streaming";
  return undefined;
}

function endpointSupportMatches(actual: ProviderEndpointSupport | undefined, required: ProviderEndpointSupport[]): boolean {
  if (!actual) return false;
  if (actual === "auto") return true;
  return required.includes(actual) || required.includes("auto");
}

function streamingSupportMatches(actual: ProviderStreamingSupport | undefined, required: ProviderStreamingSupport[]): boolean {
  if (!actual) return false;
  if (actual === "optional") return true;
  return required.includes(actual) || required.includes("optional");
}

function uniqueEndpointSupport(values: unknown[]): ProviderEndpointSupport[] {
  return uniqueStrings(values).filter((value): value is ProviderEndpointSupport => endpointSupportField(value) !== undefined);
}

function uniqueStreamingSupport(values: unknown[]): ProviderStreamingSupport[] {
  return uniqueStrings(values).filter((value): value is ProviderStreamingSupport => streamingSupportField(value) !== undefined);
}

function routeHealthEventField(value: unknown, at?: number | null, latencyMs?: number | null): ProviderRouteHealthEvent | undefined {
  const event = isRecord(value) ? value : undefined;
  const normalizedAt = nullableNumberField(event?.at ?? at);
  const normalizedLatency = nullableNumberField(event?.latencyMs ?? latencyMs);
  const errorCode = nullableStringField(event?.errorCode);
  const metadata = jsonObjectField(event?.metadata);
  if (normalizedAt === undefined && normalizedLatency === undefined && errorCode === undefined && metadata === undefined) return undefined;
  return compactJson({
    at: normalizedAt ?? null,
    latencyMs: normalizedLatency ?? null,
    errorCode: errorCode ?? null,
    metadata
  }) as unknown as ProviderRouteHealthEvent;
}

function routeMetadataField(value: unknown): ModelProviderRouteMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const providerId = stringField(value.providerId);
  const routeId = stringField(value.routeId);
  const model = stringField(value.model);
  const upstreamModel = stringField(value.upstreamModel);
  const endpointSupport = endpointSupportField(value.endpointSupport);
  const streamingSupport = streamingSupportField(value.streamingSupport);
  const credentialSource = jsonObjectField(value.credentialSource);
  const health = healthField(value.health);
  const lastSuccess = routeHealthEventField(value.lastSuccess);
  const lastFailure = routeHealthEventField(value.lastFailure);
  const metadata = jsonObjectField(value.metadata);
  if (
    providerId === undefined &&
    routeId === undefined &&
    model === undefined &&
    upstreamModel === undefined &&
    endpointSupport === undefined &&
    streamingSupport === undefined &&
    credentialSource === undefined &&
    health === undefined &&
    lastSuccess === undefined &&
    lastFailure === undefined &&
    metadata === undefined
  ) {
    return undefined;
  }
  return compactJson({
    providerId,
    routeId,
    model,
    upstreamModel,
    endpointSupport,
    streamingSupport,
    credentialSource,
    health,
    lastSuccess: lastSuccess as unknown as JsonObject | undefined,
    lastFailure: lastFailure as unknown as JsonObject | undefined,
    metadata
  }) as unknown as ModelProviderRouteMetadata;
}

function routeMetadataFromOffer(offer: ProviderRouteOfferLike, override: ModelProviderRouteMetadata | undefined): ModelProviderRouteMetadata {
  return {
    providerId: override?.providerId ?? offer.providerId,
    routeId: override?.routeId ?? offer.id,
    model: override?.model ?? offer.model,
    upstreamModel: override?.upstreamModel ?? offer.upstreamModel ?? offer.model,
    endpointSupport: override?.endpointSupport ?? endpointSupportField(offer.endpointSupport ?? offer.endpointType),
    streamingSupport: override?.streamingSupport ?? streamingSupportField(offer.streamingSupport),
    credentialSource: override?.credentialSource ?? offer.credentialSource,
    health: override?.health ?? offer.health?.status,
    lastSuccess: override?.lastSuccess ?? routeHealthEventField(offer.health?.lastSuccess, offer.health?.lastSuccessAt, offer.health?.lastLatencyMs),
    lastFailure: override?.lastFailure ?? routeHealthEventField(offer.health?.lastFailure, offer.health?.lastFailureAt, undefined),
    metadata: override?.metadata
  };
}

function stringArrayField(value: unknown): string[] | undefined {
  return Array.isArray(value) ? uniqueStrings(value) : undefined;
}

function jsonObjectField(value: unknown): JsonObject | undefined {
  return isRecord(value) ? (value as JsonObject) : undefined;
}

function uniqueTags(values: ModelCapabilityTag[]): ModelCapabilityTag[] {
  return uniqueStrings(values) as ModelCapabilityTag[];
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map((value) => normalizeString(value)).filter((value) => value.length > 0))].sort();
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  return normalized || undefined;
}

function stringField(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

function nonNegativeNumberField(value: unknown): number | undefined {
  return normalizeOptionalNonNegativeInteger(value, undefined);
}

function positiveIntegerField(value: unknown): number | undefined {
  return normalizeOptionalPositiveInteger(value, undefined);
}

function normalizeOptionalNonNegativeInteger(value: unknown, fallback: number): number;
function normalizeOptionalNonNegativeInteger(value: unknown, fallback: undefined): number | undefined;
function normalizeOptionalNonNegativeInteger(value: unknown, fallback: number | undefined): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.trunc(number));
}

function normalizeOptionalPositiveInteger(value: unknown, fallback: number): number;
function normalizeOptionalPositiveInteger(value: unknown, fallback: undefined): number | undefined;
function normalizeOptionalPositiveInteger(value: unknown, fallback: number | undefined): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.trunc(number);
}

function nullableNumberToUndefined(value: number | null | undefined): number | undefined {
  return value == null ? undefined : value;
}

function nullableNumberField(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : undefined;
}

function nullableStringField(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return stringField(value);
}

function compactJson(input: Record<string, JsonValue | undefined>): JsonObject {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as JsonObject;
}


function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatScore(value: number): string {
  return roundScore(value).toString();
}
