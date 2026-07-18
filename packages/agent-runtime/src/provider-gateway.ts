import type { JsonObject } from "@crish/shared-types";
import type { AgentProvider } from "./types";
import type {
  ModelProfile,
  ModelRouteDecision,
  ProviderEndpointSupport,
  ProviderRouteHealthEvent,
  ProviderStreamingSupport,
  TaskCapabilityRequest
} from "./model-routing";

export type ProviderCredentialSource = AccountBackedProviderCredentialSource | DirectApiKeyProviderCredentialSource;

export interface AccountBackedProviderCredentialSource {
  type: "account";
  accountId?: string;
  providerId?: string;
  keyClass?: "internal" | "external";
  credentialId?: string;
  metadata?: JsonObject;
}

export interface DirectApiKeyProviderCredentialSource {
  type: "api-key";
  apiKey: string;
  providerId?: string;
  credentialId?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  metadata?: JsonObject;
}

export interface ResolvedProviderCredential {
  id: string;
  source: ProviderCredentialSource["type"];
  providerId: string;
  accountId?: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  metadata?: JsonObject;
}

export type ProviderRouteStatus = "active" | "disabled";
export type ProviderRouteHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

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

export type AgentProviderFactory = (plan: ProviderFactoryPlan) => AgentProvider | Promise<AgentProvider>;

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
  provider?: AgentProvider;
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
  listRoutes(query: ProviderRouteCatalogQuery): ProviderRouteOffer[] | Promise<ProviderRouteOffer[]>;
  recordRouteResult?(result: ProviderRouteResult): ProviderRouteHealth | void | Promise<ProviderRouteHealth | void>;
}

export interface ProviderCredentialResolutionContext {
  request: ProviderRouteRequest;
  route: ProviderRouteOffer;
  credentialSource: ProviderCredentialSource;
}

export interface ProviderCredentialResolver {
  resolveCredential(context: ProviderCredentialResolutionContext): ResolvedProviderCredential | null | Promise<ResolvedProviderCredential | null>;
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
  credentialSourceType: ProviderCredentialSource["type"];
  credentialSource: RedactedProviderCredentialSource;
  lastSuccess?: ProviderRouteHealthEvent;
  lastFailure?: ProviderRouteHealthEvent;
}

export type RedactedProviderCredentialSource =
  | {
      type: "account";
      accountId?: string;
      providerId?: string;
      keyClass?: "internal" | "external";
      credentialId?: string;
      metadata?: JsonObject;
    }
  | {
      type: "api-key";
      providerId?: string;
      credentialId?: string;
      baseUrl?: string;
      headerNames?: string[];
      metadata?: JsonObject;
    };

export interface ProviderFactoryPlan {
  kind: "provider-factory-plan";
  route: ProviderRouteSelection;
  credential: ResolvedProviderCredential;
  providerOptions?: JsonObject;
  modelProfile?: ModelProfile;
  capabilityRequest?: TaskCapabilityRequest;
  modelRouteDecision?: ModelRouteDecision;
  metadata?: JsonObject;
}

export type ProviderGatewayPlanCode =
  | "model_required"
  | "route_not_found"
  | "route_in_cooldown"
  | "provider_credential_missing";

type JsonRedactionContext = "credential-source" | "diagnostic-metadata";

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
  resolveProvider(request: ProviderRouteRequest): Promise<AgentProvider | ProviderFactoryPlan>;
  recordRouteResult(result: ProviderRouteResult): ProviderRouteHealth | void | Promise<ProviderRouteHealth | void>;
}

export interface ProviderGatewayOptions {
  catalog?: ProviderRouteCatalog;
  routes?: ProviderRouteOffer[];
  credentialResolver?: ProviderCredentialResolver;
  now?: () => number;
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
    this.name = "ProviderGatewayError";
  }
}

export class DefaultProviderGateway implements ProviderGateway {
  private readonly catalog: ProviderRouteCatalog;
  private readonly credentialResolver?: ProviderCredentialResolver;
  private readonly now: () => number;

  constructor(options: ProviderGatewayOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.catalog = options.catalog ?? new StaticProviderRouteCatalog(options.routes ?? [], { now: this.now });
    this.credentialResolver = options.credentialResolver;
  }

  async planRoute(request: ProviderRouteRequest): Promise<ProviderGatewayPlan> {
    return (await this.planWithRoute(request)).plan;
  }

  async resolveProvider(request: ProviderRouteRequest): Promise<AgentProvider | ProviderFactoryPlan> {
    const planned = await this.planWithRoute(request);
    const plan = planned.plan;
    if (!plan.ok || !plan.providerPlan || !planned.route) {
      throw new ProviderGatewayError(plan.code ?? "route_not_found", plan);
    }

    if (request.materializeProvider !== false) {
      if (planned.route.provider) return planned.route.provider;
      if (planned.route.providerFactory) return planned.route.providerFactory(plan.providerPlan);
    }

    return plan.providerPlan;
  }

  recordRouteResult(result: ProviderRouteResult): ProviderRouteHealth | void | Promise<ProviderRouteHealth | void> {
    return this.catalog.recordRouteResult?.(result);
  }

  private async planWithRoute(request: ProviderRouteRequest): Promise<{ plan: ProviderGatewayPlan; route?: ProviderRouteOffer }> {
    const requestedModel = normalizeText(request.model);
    const routeDecision = requestedModel ? [`requested_model:${requestedModel}`] : ["model_required"];
    routeDecision.push(...modelRoutingRouteDecision(request));
    if (!requestedModel) {
      return {
        plan: failurePlan({
          code: "model_required",
          requestedModel,
          routeDecision,
          candidateCount: 0,
          availableCandidateCount: 0,
          cooldownCandidateCount: 0,
          fallbackUsed: false
        })
      };
    }

    const routes = await this.catalog.listRoutes({
      model: requestedModel,
      providerId: request.providerId,
      accountId: request.accountId
    });
    if (request.modelRouteDecision && !request.modelRouteDecision.selected && hasEndpointOrStreamingRequirement(request.modelRouteDecision.request)) {
      routeDecision.push("model_route_capability_rejected_all");
      routeDecision.push("route_not_found");
      return {
        plan: failurePlan({
          code: "route_not_found",
          requestedModel,
          routeDecision,
          candidateCount: 0,
          availableCandidateCount: 0,
          cooldownCandidateCount: 0,
          fallbackUsed: false,
          capabilityRequest: request.capabilityRequest,
          modelRouteDecision: request.modelRouteDecision
        })
      };
    }
    const matching = routes.filter((route) => routeMatchesRequest(route, request, requestedModel));
    const active = matching.filter((route) => route.status !== "disabled");
    const now = this.now();
    const cooldown: typeof active = [];
    const available: typeof active = [];
    for (const route of active) {
      if (routeInCooldown(route, now)) cooldown.push(route);
      else available.push(route);
    }

    routeDecision.push(`candidate_routes:${active.length}`);
    routeDecision.push(`available_routes:${available.length}`);
    if (cooldown.length > 0) routeDecision.push(`cooldown_routes:${cooldown.length}`);

    if (active.length === 0) {
      routeDecision.push("route_not_found");
      return {
        plan: failurePlan({
          code: "route_not_found",
          requestedModel,
          routeDecision,
          candidateCount: 0,
          availableCandidateCount: 0,
          cooldownCandidateCount: 0,
          fallbackUsed: false
        })
      };
    }

    const primaryCandidates = available.filter((route) => !route.fallback);
    const fallbackCandidates = available.filter((route) => route.fallback);
    const fallbackUsed = primaryCandidates.length === 0 && request.allowFallback !== false && fallbackCandidates.length > 0;
    const candidatePool = fallbackUsed ? fallbackCandidates : primaryCandidates;
    if (fallbackUsed) routeDecision.push("fallback_route_used");
    if (primaryCandidates.length === 0 && fallbackCandidates.length > 0 && request.allowFallback === false) {
      routeDecision.push("fallback_route_disabled");
    }

    if (candidatePool.length === 0) {
      const code = cooldown.length === active.length ? "route_in_cooldown" : "route_not_found";
      routeDecision.push(code);
      return {
        plan: failurePlan({
          code,
          requestedModel,
          routeDecision,
          candidateCount: active.length,
          availableCandidateCount: available.length,
          cooldownCandidateCount: cooldown.length,
          fallbackUsed
        })
      };
    }

    const selected = [...candidatePool].sort((a, b) => compareRouteOffers(a, b, this.now()))[0]!;
    const selectedRoute = toRouteSelection(selected, requestedModel, this.now());
    routeDecision.push(`selected_provider:${selectedRoute.providerId}`);
    routeDecision.push(`selected_route:${selectedRoute.routeId}`);

    const credential = await this.resolveCredential(selected, request);
    if (!credential) {
      routeDecision.push("credential_missing");
      return {
        plan: failurePlan({
          code: "provider_credential_missing",
          requestedModel,
          routeDecision,
          selectedRoute,
          candidateCount: active.length,
          availableCandidateCount: available.length,
          cooldownCandidateCount: cooldown.length,
          fallbackUsed
        }),
        route: selected
      };
    }

    const providerPlan: ProviderFactoryPlan = {
      kind: "provider-factory-plan",
      route: selectedRoute,
      credential,
      providerOptions: selected.providerOptions,
      modelProfile: selected.modelProfile,
      capabilityRequest: request.capabilityRequest,
      modelRouteDecision: request.modelRouteDecision,
      metadata: mergeMetadata(selected.metadata, capabilityMetadata(request))
    };

    return {
      plan: {
        ok: true,
        requestedModel,
        selectedRoute,
        credentialConfigured: true,
        credential,
        providerPlan,
        capabilityRequest: request.capabilityRequest,
        modelRouteDecision: request.modelRouteDecision,
        candidateCount: active.length,
        availableCandidateCount: available.length,
        cooldownCandidateCount: cooldown.length,
        fallbackUsed,
        routeDecision
      },
      route: selected
    };
  }

  private async resolveCredential(route: ProviderRouteOffer, request: ProviderRouteRequest): Promise<ResolvedProviderCredential | null> {
    const credentialSource = normalizeCredentialSource(route.credentialSource, route, request);
    if (this.credentialResolver) {
      const resolved = await this.credentialResolver.resolveCredential({
        request,
        route,
        credentialSource
      });
      if (resolved) return normalizeResolvedCredential(resolved, route, credentialSource);
    }

    if (credentialSource.type !== "api-key") return null;
    const apiKey = credentialSource.apiKey.trim();
    if (!apiKey) return null;
    return {
      id: credentialSource.credentialId ?? `${route.id}:api-key`,
      source: "api-key",
      providerId: credentialSource.providerId ?? route.providerId,
      apiKey,
      baseUrl: credentialSource.baseUrl,
      headers: cloneStringRecord(credentialSource.headers),
      metadata: credentialSource.metadata
    };
  }
}

export class StaticProviderRouteCatalog implements ProviderRouteCatalog {
  private readonly routes = new Map<string, ProviderRouteOffer>();
  private readonly now: () => number;
  private readonly failureCooldownThreshold: number;
  private readonly cooldownMs: number | ((consecutiveFailures: number) => number);

  constructor(routes: ProviderRouteOffer[] = [], options: StaticProviderRouteCatalogOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.failureCooldownThreshold = normalizePositiveInteger(options.failureCooldownThreshold, 5);
    this.cooldownMs = options.cooldownMs ?? defaultCooldownMs;
    for (const route of routes) this.addRoute(route);
  }

  listRoutes(query: ProviderRouteCatalogQuery = {}): ProviderRouteOffer[] {
    return [...this.routes.values()]
      .filter((route) => query.includeDisabled || route.status !== "disabled")
      .filter((route) => !query.providerId || route.providerId === query.providerId)
      .filter((route) => !query.model || routeMatchesModel(route, query.model))
      .map(cloneRouteOffer);
  }

  recordRouteResult(result: ProviderRouteResult): ProviderRouteHealth | void {
    const route = this.routes.get(result.routeId);
    if (!route) return undefined;

    const now = this.now();
    const current = route.health ?? {};
    const successCount = normalizeNonNegativeInteger(current.successCount, 0) + (result.ok ? 1 : 0);
    const failureCount = normalizeNonNegativeInteger(current.failureCount, 0) + (result.ok ? 0 : 1);
    const consecutiveFailures = result.ok ? 0 : normalizeNonNegativeInteger(current.consecutiveFailures, 0) + 1;
    const cooldownUntil = result.ok
      ? null
      : result.cooldownUntil ?? (consecutiveFailures >= this.failureCooldownThreshold ? now + this.resolveCooldownMs(consecutiveFailures) : current.cooldownUntil ?? null);
    const next: ProviderRouteHealth = {
      ...current,
      status: result.ok ? "healthy" : cooldownUntil && cooldownUntil > now ? "unhealthy" : "degraded",
      successCount,
      failureCount,
      consecutiveFailures,
      cooldownUntil,
      lastSuccessAt: result.ok ? now : current.lastSuccessAt ?? null,
      lastFailureAt: result.ok ? current.lastFailureAt ?? null : now,
      lastSuccess: result.ok
        ? routeHealthEvent(now, result.latencyMs, null, result.metadata)
        : current.lastSuccess,
      lastFailure: result.ok
        ? current.lastFailure
        : routeHealthEvent(now, result.latencyMs, result.errorCode?.trim() || "provider_failed", result.metadata),
      lastErrorCode: result.ok ? null : result.errorCode?.trim() || "provider_failed",
      lastLatencyMs: result.latencyMs == null ? current.lastLatencyMs ?? null : normalizeNonNegativeInteger(result.latencyMs, 0),
      updatedAt: now,
      metadata: mergeMetadata(current.metadata, result.metadata)
    };
    route.health = next;
    return cloneRouteHealth(next);
  }

  addRoute(route: ProviderRouteOffer): void {
    const id = normalizeText(route.id);
    if (!id) throw new Error("Provider route id is required");
    if (this.routes.has(id)) throw new Error(`Provider route id already exists: ${id}`);
    this.routes.set(id, cloneRouteOffer({ ...route, id }));
  }

  private resolveCooldownMs(consecutiveFailures: number): number {
    const value = typeof this.cooldownMs === "function" ? this.cooldownMs(consecutiveFailures) : this.cooldownMs;
    return normalizePositiveInteger(value, defaultCooldownMs(consecutiveFailures));
  }
}

export function createProviderGateway(options: ProviderGatewayOptions = {}): ProviderGateway {
  return new DefaultProviderGateway(options);
}

function failurePlan(input: {
  code: ProviderGatewayPlanCode;
  requestedModel: string;
  routeDecision: string[];
  candidateCount: number;
  availableCandidateCount: number;
  cooldownCandidateCount: number;
  fallbackUsed: boolean;
  selectedRoute?: ProviderRouteSelection;
  capabilityRequest?: TaskCapabilityRequest;
  modelRouteDecision?: ModelRouteDecision;
}): ProviderGatewayPlan {
  return {
    ok: false,
    code: input.code,
    requestedModel: input.requestedModel,
    selectedRoute: input.selectedRoute,
    credentialConfigured: false,
    capabilityRequest: input.capabilityRequest,
    modelRouteDecision: input.modelRouteDecision,
    candidateCount: input.candidateCount,
    availableCandidateCount: input.availableCandidateCount,
    cooldownCandidateCount: input.cooldownCandidateCount,
    fallbackUsed: input.fallbackUsed,
    routeDecision: input.routeDecision
  };
}

function routeMatchesRequest(route: ProviderRouteOffer, request: ProviderRouteRequest, requestedModel: string): boolean {
  if (request.routeId && route.id !== request.routeId) return false;
  if (request.providerId && route.providerId !== request.providerId) return false;
  const selectedProfile = request.modelRouteDecision?.selected;
  if (selectedProfile?.routeId && route.id !== selectedProfile.routeId) return false;
  if (selectedProfile?.providerId && route.providerId !== selectedProfile.providerId) return false;
  return routeMatchesModel(route, requestedModel);
}

function routeMatchesModel(route: ProviderRouteOffer, model: string): boolean {
  const requested = normalizeText(model);
  if (!requested) return false;
  if (route.model === requested) return true;
  return Boolean(route.aliases?.includes(requested));
}

function routeInCooldown(route: ProviderRouteOffer, now: number): boolean {
  return Boolean(route.health?.cooldownUntil && route.health.cooldownUntil > now);
}

function compareRouteOffers(a: ProviderRouteOffer, b: ProviderRouteOffer, now: number): number {
  return (
    normalizeNonNegativeInteger(b.priority, 100) - normalizeNonNegativeInteger(a.priority, 100) ||
    routeHealthScore(b, now) - routeHealthScore(a, now) ||
    normalizeNonNegativeInteger(b.routingWeight, 100) - normalizeNonNegativeInteger(a.routingWeight, 100) ||
    a.id.localeCompare(b.id)
  );
}

function toRouteSelection(route: ProviderRouteOffer, requestedModel: string, now: number): ProviderRouteSelection {
  return {
    routeId: route.id,
    providerId: route.providerId,
    requestedModel,
    model: route.model,
    upstreamModel: route.upstreamModel ?? route.model,
    endpointType: route.endpointType,
    endpointSupport: route.endpointSupport ?? endpointSupportFromEndpointType(route.endpointType),
    streamingSupport: route.streamingSupport,
    priority: normalizeNonNegativeInteger(route.priority, 100),
    routingWeight: normalizeNonNegativeInteger(route.routingWeight, 100),
    healthScore: routeHealthScore(route, now),
    fallback: Boolean(route.fallback),
    credentialSourceType: route.credentialSource.type,
    credentialSource: redactCredentialSource(route.credentialSource),
    lastSuccess: route.health?.lastSuccess,
    lastFailure: route.health?.lastFailure
  };
}

function routeHealthScore(route: ProviderRouteOffer, now: number): number {
  const health = route.health;
  if (!health) return 80;
  if (routeInCooldown(route, now)) return 0;

  let score = statusHealthScore(health.status);
  const successCount = normalizeNonNegativeInteger(health.successCount, 0);
  const failureCount = normalizeNonNegativeInteger(health.failureCount, 0);
  const total = successCount + failureCount;
  if (total > 0) score += Math.round((successCount / total - 0.5) * 20);
  score -= Math.min(60, normalizeNonNegativeInteger(health.consecutiveFailures, 0) * 15);
  score -= Math.min(20, Math.floor(normalizeNonNegativeInteger(health.lastLatencyMs, 0) / 1000));
  return clamp(score, 0, 100);
}

function statusHealthScore(status: ProviderRouteHealthStatus | undefined): number {
  if (status === "healthy") return 100;
  if (status === "degraded") return 60;
  if (status === "unhealthy") return 20;
  return 80;
}

function normalizeCredentialSource(source: ProviderCredentialSource, route: ProviderRouteOffer, request: ProviderRouteRequest): ProviderCredentialSource {
  if (source.type === "account") {
    return {
      ...source,
      providerId: source.providerId ?? route.providerId,
      accountId: source.accountId ?? request.accountId
    };
  }
  return {
    ...source,
    providerId: source.providerId ?? route.providerId,
    headers: cloneStringRecord(source.headers)
  };
}

function normalizeResolvedCredential(
  credential: ResolvedProviderCredential,
  route: ProviderRouteOffer,
  source: ProviderCredentialSource
): ResolvedProviderCredential {
  return {
    ...credential,
    source: credential.source ?? source.type,
    providerId: credential.providerId || source.providerId || route.providerId,
    accountId: credential.accountId ?? (source.type === "account" ? source.accountId : undefined),
    headers: cloneStringRecord(credential.headers)
  };
}

function cloneRouteOffer(route: ProviderRouteOffer): ProviderRouteOffer {
  return {
    ...route,
    aliases: route.aliases ? [...route.aliases] : undefined,
    credentialSource: cloneCredentialSource(route.credentialSource),
    health: cloneRouteHealth(route.health),
    modelProfile: cloneModelProfile(route.modelProfile),
    providerOptions: cloneJsonObject(route.providerOptions),
    metadata: cloneJsonObject(route.metadata)
  };
}

function cloneModelProfile(profile: ModelProfile | undefined): ModelProfile | undefined {
  if (!profile) return undefined;
  return {
    ...profile,
    aliases: profile.aliases ? [...profile.aliases] : undefined,
    capabilities: profile.capabilities ? { ...profile.capabilities } : undefined,
    credentialSource: cloneJsonObject(profile.credentialSource),
    route: profile.route
      ? {
          ...profile.route,
          credentialSource: cloneJsonObject(profile.route.credentialSource),
          lastSuccess: cloneRouteHealthEvent(profile.route.lastSuccess),
          lastFailure: cloneRouteHealthEvent(profile.route.lastFailure),
          metadata: cloneJsonObject(profile.route.metadata)
        }
      : undefined,
    lastSuccess: cloneRouteHealthEvent(profile.lastSuccess),
    lastFailure: cloneRouteHealthEvent(profile.lastFailure),
    metadata: cloneJsonObject(profile.metadata)
  };
}

function cloneCredentialSource(source: ProviderCredentialSource): ProviderCredentialSource {
  if (source.type === "account") {
    return {
      ...source,
      metadata: cloneJsonObject(source.metadata)
    };
  }
  return {
    ...source,
    headers: cloneStringRecord(source.headers),
    metadata: cloneJsonObject(source.metadata)
  };
}

function cloneRouteHealth(health: ProviderRouteHealth | undefined): ProviderRouteHealth | undefined {
  if (!health) return undefined;
  return {
    ...health,
    lastSuccess: cloneRouteHealthEvent(health.lastSuccess),
    lastFailure: cloneRouteHealthEvent(health.lastFailure),
    metadata: cloneJsonObject(health.metadata)
  };
}

function cloneRouteHealthEvent(event: ProviderRouteHealthEvent | undefined): ProviderRouteHealthEvent | undefined {
  if (!event) return undefined;
  return {
    ...event,
    metadata: cloneJsonObject(event.metadata)
  };
}

function cloneJsonObject(value: JsonObject | undefined): JsonObject | undefined {
  return value ? { ...value } : undefined;
}

function cloneStringRecord(value: Record<string, string> | undefined): Record<string, string> | undefined {
  return value ? { ...value } : undefined;
}

function mergeMetadata(left: JsonObject | undefined, right: JsonObject | undefined): JsonObject | undefined {
  if (!left && !right) return undefined;
  return {
    ...(left ?? {}),
    ...(right ?? {})
  };
}

function capabilityMetadata(request: ProviderRouteRequest): JsonObject | undefined {
  if (!request.capabilityRequest && !request.modelRouteDecision) return undefined;
  const metadata: JsonObject = {};
  if (request.capabilityRequest) {
    metadata.capabilityRequest = {
      ...(request.capabilityRequest.required ? { required: [...request.capabilityRequest.required] } : {}),
      ...(request.capabilityRequest.preferred ? { preferred: [...request.capabilityRequest.preferred] } : {}),
      ...(request.capabilityRequest.avoid ? { avoid: [...request.capabilityRequest.avoid] } : {}),
      ...(request.capabilityRequest.requiredEndpointSupport ? { requiredEndpointSupport: [...request.capabilityRequest.requiredEndpointSupport] } : {}),
      ...(request.capabilityRequest.requiredStreamingSupport ? { requiredStreamingSupport: [...request.capabilityRequest.requiredStreamingSupport] } : {}),
      ...(request.capabilityRequest.estimatedInputTokens !== undefined ? { estimatedInputTokens: request.capabilityRequest.estimatedInputTokens } : {}),
      ...(request.capabilityRequest.estimatedOutputTokens !== undefined ? { estimatedOutputTokens: request.capabilityRequest.estimatedOutputTokens } : {}),
      ...(request.capabilityRequest.minimumContextTokens !== undefined ? { minimumContextTokens: request.capabilityRequest.minimumContextTokens } : {})
    };
  }
  if (request.modelRouteDecision) {
    metadata.modelRouting = {
      selectedProfileId: request.modelRouteDecision.selected?.id ?? null,
      trace: [...request.modelRouteDecision.trace],
      candidateCount: request.modelRouteDecision.candidates.length,
      rejectionCount: request.modelRouteDecision.rejections.length
    };
  }
  return metadata;
}

function redactCredentialSource(source: ProviderCredentialSource): RedactedProviderCredentialSource {
  if (source.type === "account") {
    return {
      type: "account",
      accountId: source.accountId,
      providerId: source.providerId,
      keyClass: source.keyClass,
      credentialId: source.credentialId,
      metadata: redactJsonObject(source.metadata, "credential-source")
    };
  }
  return {
    type: "api-key",
    providerId: source.providerId,
    credentialId: source.credentialId,
    baseUrl: source.baseUrl,
    headerNames: Object.keys(source.headers ?? {}).sort(),
    metadata: redactJsonObject(source.metadata, "credential-source")
  };
}

function modelRoutingRouteDecision(request: ProviderRouteRequest): string[] {
  const decision = request.modelRouteDecision;
  if (!decision) return [];
  const output = [`model_route_selected:${decision.selected?.id ?? "none"}`];
  if (decision.request.required.length > 0) output.push(`capability_required:${decision.request.required.join(",")}`);
  if (decision.request.preferred.length > 0) output.push(`capability_preferred:${decision.request.preferred.join(",")}`);
  if (decision.request.requiredEndpointSupport.length > 0) output.push(`capability_required_endpoint:${decision.request.requiredEndpointSupport.join(",")}`);
  if (decision.request.requiredStreamingSupport.length > 0) output.push(`capability_required_streaming:${decision.request.requiredStreamingSupport.join(",")}`);
  if (decision.request.minimumContextTokens !== undefined) output.push(`capability_minimum_context:${decision.request.minimumContextTokens}`);
  const rejectionReasonCounts = new Map<string, number>();
  for (const rejection of decision.rejections) {
    for (const reason of rejection.reasons) rejectionReasonCounts.set(reason, (rejectionReasonCounts.get(reason) ?? 0) + 1);
  }
  for (const [reason, count] of [...rejectionReasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    output.push(`model_route_rejection:${reason}:${count}`);
  }
  if (!decision.selected && decision.rejections.length > 0) output.push("model_route_no_selected_candidate");
  return output;
}

function hasEndpointOrStreamingRequirement(request: ModelRouteDecision["request"]): boolean {
  return request.requiredEndpointSupport.length > 0 || request.requiredStreamingSupport.length > 0;
}

function redactJsonObject(value: JsonObject | undefined, context: JsonRedactionContext): JsonObject | undefined {
  if (!value) return undefined;
  const redacted = redactJsonValue(value, context);
  return isJsonObject(redacted) ? redacted : undefined;
}

function redactJsonValue(value: unknown, context: JsonRedactionContext): unknown {
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, context));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSensitiveJsonKey(key, context) ? "[redacted]" : redactJsonValue(item, context)
    ])
  );
}

function isSensitiveJsonKey(key: string, context: JsonRedactionContext): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.includes("apikey")) return true;
  if (normalized.includes("authorization")) return true;
  if (normalized.includes("bearertoken")) return true;
  if (normalized === "token" || normalized.endsWith("token")) return true;
  if (normalized.includes("secret")) return true;
  if (normalized.includes("password")) return true;
  return context === "credential-source" && normalized === "key";
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function routeHealthEvent(
  at: number,
  latencyMs: number | null | undefined,
  errorCode: string | null,
  metadata: JsonObject | undefined
): ProviderRouteHealthEvent {
  return {
    at,
    latencyMs: latencyMs == null ? null : normalizeNonNegativeInteger(latencyMs, 0),
    errorCode,
    metadata: cloneJsonObject(metadata)
  };
}

function endpointSupportFromEndpointType(value: string | undefined): ProviderEndpointSupport | undefined {
  if (value === "responses" || value === "chat-completions" || value === "auto") return value;
  return undefined;
}

function normalizeText(value: string | undefined): string {
  return String(value ?? "").trim();
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function defaultCooldownMs(consecutiveFailures: number): number {
  const minutes = Math.min(60, 5 * Math.max(1, consecutiveFailures - 4));
  return minutes * 60_000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
