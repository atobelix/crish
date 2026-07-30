import type { JsonObject } from '@crish/shared-types';

export type ModelCapabilityTag =
  | 'code'
  | 'code-review'
  | 'vision'
  | 'search'
  | 'reasoning'
  | 'chinese-writing'
  | 'long-context'
  | 'low-latency'
  | 'low-cost'
  | 'tool-use'
  | 'json'
  | 'planning'
  | 'requirements-alignment'
  | 'cache-friendly'
  | 'workflow'
  | (string & {});

export type ModelTaskKind =
  | 'general'
  | 'code'
  | 'code-review'
  | 'search'
  | 'vision'
  | 'chinese-writing'
  | 'planning'
  | 'requirements-alignment'
  | 'workflow'
  | 'background'
  | (string & {});

export type ModelTaskPriority = 'balanced' | 'quality' | 'latency' | 'cost';

export type ModelAvailability =
  'available' | 'limited' | 'unavailable' | 'unknown';
export type ModelHealthStatus =
  'healthy' | 'degraded' | 'unhealthy' | 'unknown';
export type ModelCostTier =
  'free' | 'low' | 'medium' | 'high' | 'premium' | 'unknown';
export type ProviderEndpointSupport = 'responses' | 'chat-completions' | 'auto';
export type ProviderStreamingSupport =
  'streaming' | 'non-streaming' | 'optional' | 'unknown';

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

export type ModelRole =
  'primary' | 'fast' | 'editor' | 'embedding' | 'summarizer';

export interface EnhancedModelProfile extends ModelProfile {
  capabilityFlags?: Partial<ModelCapabilityFlags>;
  pricing?: {
    inputCostPerToken: number;
    outputCostPerToken: number;
    cacheReadCostPerToken?: number;
    reasoningTokenCost?: number;
    currency: string;
  };
  version?: {
    releaseDate?: string;
    deprecationDate?: string;
    isDeprecated?: boolean;
  };
  source: 'catalog' | 'runtime-api' | 'heuristic' | 'user-config';
}

export interface FallbackRequestConfig {
  enabled: boolean;
  strategy: 'error-specific' | 'sequential' | 'cost-aware';
  maxFallbacks: number;
}

export interface EnhancedTaskCapabilityRequest extends TaskCapabilityRequest {
  requiredCapabilities?: Partial<ModelCapabilityFlags>;
  preferredCapabilities?: Partial<ModelCapabilityFlags>;
  maxCostPerInput1KTokens?: number;
  maxCostPerOutput1KTokens?: number;
  maxTotalCostEstimate?: number;
  preferredRole?: ModelRole;
  fallback?: FallbackRequestConfig;
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
  avoidedModelPenalty: 30,
};

import type { ModelCapabilityFlags } from '../model-catalog/types';
