import type { JsonObject } from '@crish/shared-types';
import type {
  ModelProfile,
  ModelProviderRouteMetadata,
  ModelRouteDecision,
  ModelHealthStatus,
  ProviderEndpointSupport,
  ProviderRouteHealthEvent,
  ProviderStreamingSupport,
  TaskCapabilityRequest,
} from '../model-routing';

export type ProviderCredentialSource =
  AccountBackedProviderCredentialSource | DirectApiKeyProviderCredentialSource;

export interface AccountBackedProviderCredentialSource {
  type: 'account';
  accountId?: string;
  providerId?: string;
  keyClass?: 'internal' | 'external';
  credentialId?: string;
  metadata?: JsonObject;
}

export interface DirectApiKeyProviderCredentialSource {
  type: 'api-key';
  apiKey: string;
  providerId?: string;
  credentialId?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  metadata?: JsonObject;
}

export interface ResolvedProviderCredential {
  id: string;
  source: ProviderCredentialSource['type'];
  providerId: string;
  accountId?: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  metadata?: JsonObject;
}

export type ProviderRouteStatus = 'active' | 'disabled';
export type ProviderRouteHealthStatus =
  'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface ProviderRouteHealth {
  status?: ProviderRouteHealthStatus;
  successCount?: number;
  failureCount?: number;
  consecutiveFailures?: number;
  cooldownUntil?: number | null;
  lastSuccessAt?: number | null;
  lastFailureAt?: number | null;
  lastSuccess?: ProviderRouteHealthEvent;
  lastFailure?: ProviderRouteHealthEvent;
  lastErrorCode?: string | null;
  lastLatencyMs?: number | null;
  updatedAt?: number;
  metadata?: JsonObject;
}

export type AgentProviderFactory = (
  plan: ProviderFactoryPlan
) =>
  | import('../provider/types').AgentProvider
  | Promise<import('../provider/types').AgentProvider>;

export interface ProviderRouteOffer {
  id: string;
  model: string;
  aliases?: string[];
  providerId: string;
  upstreamModel?: string;
  endpointType?: string;
  endpointSupport?: ProviderEndpointSupport;
  streamingSupport?: ProviderStreamingSupport;
  priority?: number;
  routingWeight?: number;
  fallback?: boolean;
  status?: ProviderRouteStatus;
  credentialSource: ProviderCredentialSource;
  health?: ProviderRouteHealth;
  modelProfile?: ModelProfile;
  provider?: import('../provider/types').AgentProvider;
  providerFactory?: AgentProviderFactory;
  providerOptions?: JsonObject;
  metadata?: JsonObject;
}

export interface ProviderRouteCatalogQuery {
  model?: string;
  providerId?: string;
  accountId?: string;
  includeDisabled?: boolean;
}

export interface ProviderRouteCatalog {
  listRoutes(
    query: ProviderRouteCatalogQuery
  ): ProviderRouteOffer[] | Promise<ProviderRouteOffer[]>;
  recordRouteResult?(
    result: ProviderRouteResult
  ): ProviderRouteHealth | void | Promise<ProviderRouteHealth | void>;
}

export interface ProviderCredentialResolutionContext {
  request: ProviderRouteRequest;
  route: ProviderRouteOffer;
  credentialSource: ProviderCredentialSource;
}

export interface ProviderCredentialResolver {
  resolveCredential(
    context: ProviderCredentialResolutionContext
  ):
    | ResolvedProviderCredential
    | null
    | Promise<ResolvedProviderCredential | null>;
}

export interface ProviderRouteRequest {
  model: string;
  accountId?: string;
  providerId?: string;
  routeId?: string;
  allowFallback?: boolean;
  materializeProvider?: boolean;
  capabilityRequest?: TaskCapabilityRequest;
  modelRouteDecision?: ModelRouteDecision;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  hasMedia?: boolean;
  metadata?: JsonObject;
}

export interface ProviderRouteSelection {
  routeId: string;
  providerId: string;
  requestedModel: string;
  model: string;
  upstreamModel: string;
  endpointType?: string;
  endpointSupport?: ProviderEndpointSupport;
  streamingSupport?: ProviderStreamingSupport;
  priority: number;
  routingWeight: number;
  healthScore: number;
  fallback: boolean;
  credentialSourceType: ProviderCredentialSource['type'];
  credentialSource: RedactedProviderCredentialSource;
  lastSuccess?: ProviderRouteHealthEvent;
  lastFailure?: ProviderRouteHealthEvent;
}

export type RedactedProviderCredentialSource =
  | {
      type: 'account';
      accountId?: string;
      providerId?: string;
      keyClass?: 'internal' | 'external';
      credentialId?: string;
      metadata?: JsonObject;
    }
  | {
      type: 'api-key';
      providerId?: string;
      credentialId?: string;
      baseUrl?: string;
      headerNames?: string[];
      metadata?: JsonObject;
    };

export interface ProviderFactoryPlan {
  kind: 'provider-factory-plan';
  provider?: string;
  route: ProviderRouteSelection;
  credential: ResolvedProviderCredential;
  providerOptions?: JsonObject;
  modelProfile?: ModelProfile;
  capabilityRequest?: TaskCapabilityRequest;
  modelRouteDecision?: ModelRouteDecision;
  metadata?: JsonObject;
}

export type ProviderGatewayPlanCode =
  | 'model_required'
  | 'route_not_found'
  | 'route_in_cooldown'
  | 'provider_credential_missing'
  | 'ssrf_rejected';

export interface ProviderGatewayPlan {
  ok: boolean;
  code?: ProviderGatewayPlanCode;
  requestedModel: string;
  selectedRoute?: ProviderRouteSelection;
  credentialConfigured: boolean;
  credential?: ResolvedProviderCredential;
  providerPlan?: ProviderFactoryPlan;
  capabilityRequest?: TaskCapabilityRequest;
  modelRouteDecision?: ModelRouteDecision;
  candidateCount: number;
  availableCandidateCount: number;
  cooldownCandidateCount: number;
  fallbackUsed: boolean;
  routeDecision: string[];
}

export interface ProviderRouteResult {
  routeId: string;
  ok: boolean;
  errorCode?: string | null;
  latencyMs?: number | null;
  cooldownUntil?: number | null;
  metadata?: JsonObject;
}

export interface ProviderGateway {
  planRoute(request: ProviderRouteRequest): Promise<ProviderGatewayPlan>;
  resolveProvider(
    request: ProviderRouteRequest
  ): Promise<import('../provider/types').AgentProvider | ProviderFactoryPlan>;
  recordRouteResult(
    result: ProviderRouteResult
  ): ProviderRouteHealth | void | Promise<ProviderRouteHealth | void>;
}

export interface ProviderGatewayOptions {
  catalog?: ProviderRouteCatalog;
  routes?: ProviderRouteOffer[];
  credentialResolver?: ProviderCredentialResolver;
  secretStore?: import('../provider/auth/secret-store').SecretStore;
  now?: () => number;
  modelCatalog?: import('../model-catalog/types').ModelCatalog;
}

export interface StaticProviderRouteCatalogOptions {
  now?: () => number;
  failureCooldownThreshold?: number;
  cooldownMs?: number | ((consecutiveFailures: number) => number);
}

export class ProviderGatewayError extends Error {
  constructor(
    readonly code: ProviderGatewayPlanCode,
    readonly plan: ProviderGatewayPlan
  ) {
    super(code);
    this.name = 'ProviderGatewayError';
  }
}

export function deriveModelProfile(offer: ProviderRouteOffer): ModelProfile {
  const routeMetadata: ModelProviderRouteMetadata = {
    providerId: offer.providerId,
    routeId: offer.id,
    model: offer.model,
    upstreamModel: offer.upstreamModel ?? offer.model,
  };
  if (offer.endpointSupport)
    routeMetadata.endpointSupport = offer.endpointSupport;
  if (offer.streamingSupport)
    routeMetadata.streamingSupport = offer.streamingSupport;
  if (offer.credentialSource)
    routeMetadata.credentialSource =
      offer.credentialSource as unknown as JsonObject;
  if (offer.health?.status)
    routeMetadata.health = offer.health.status as ModelHealthStatus;
  if (offer.health?.lastSuccess)
    routeMetadata.lastSuccess = offer.health.lastSuccess;
  if (offer.health?.lastFailure)
    routeMetadata.lastFailure = offer.health.lastFailure;
  if (offer.metadata) routeMetadata.metadata = offer.metadata;

  const profile: ModelProfile = { id: offer.id, route: routeMetadata };
  if (offer.providerId) profile.providerId = offer.providerId;
  profile.routeId = offer.id;
  if (offer.model) profile.model = offer.model;
  if (offer.upstreamModel) profile.upstreamModel = offer.upstreamModel;
  if (offer.endpointSupport) profile.endpointSupport = offer.endpointSupport;
  if (offer.streamingSupport) profile.streamingSupport = offer.streamingSupport;
  if (offer.credentialSource)
    profile.credentialSource = offer.credentialSource as unknown as JsonObject;
  if (offer.aliases) profile.aliases = offer.aliases;
  if (offer.modelProfile?.capabilities)
    profile.capabilities = offer.modelProfile.capabilities;
  if (offer.modelProfile?.costTier)
    profile.costTier = offer.modelProfile.costTier;
  if (offer.modelProfile?.latencyMs != null)
    profile.latencyMs = offer.modelProfile.latencyMs;
  else if (offer.health?.lastLatencyMs != null)
    profile.latencyMs = offer.health.lastLatencyMs;
  if (offer.modelProfile?.contextWindowTokens)
    profile.contextWindowTokens = offer.modelProfile.contextWindowTokens;
  if (offer.modelProfile?.availability)
    profile.availability = offer.modelProfile.availability;
  if (offer.modelProfile?.health != null)
    profile.health = offer.modelProfile.health as ModelHealthStatus;
  else if (offer.health?.status)
    profile.health = offer.health.status as ModelHealthStatus;
  if (offer.modelProfile?.lastSuccess)
    profile.lastSuccess = offer.modelProfile.lastSuccess;
  else if (offer.health?.lastSuccess)
    profile.lastSuccess = offer.health.lastSuccess;
  if (offer.modelProfile?.lastFailure)
    profile.lastFailure = offer.modelProfile.lastFailure;
  else if (offer.health?.lastFailure)
    profile.lastFailure = offer.health.lastFailure;
  if (offer.modelProfile?.priority != null)
    profile.priority = offer.modelProfile.priority;
  else if (offer.priority != null) profile.priority = offer.priority;
  else if (offer.routingWeight != null) profile.priority = offer.routingWeight;
  if (offer.modelProfile?.metadata)
    profile.metadata = offer.modelProfile.metadata;
  else if (offer.metadata) profile.metadata = offer.metadata;
  return profile;
}
