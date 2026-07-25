import type { JsonObject } from "@crish/shared-types";
import type { ModelProfile, ModelProviderRouteMetadata, ModelRouteDecision, ProviderEndpointSupport, ProviderRouteHealthEvent, TaskCapabilityRequest } from "../model-routing";
import type { ProviderRouteHealth, ProviderRouteHealthStatus, ProviderRouteOffer, ProviderRouteResult, ProviderRouteSelection, ProviderRouteCatalog, ProviderRouteCatalogQuery, ProviderRouteRequest, ProviderGatewayPlan, ProviderGatewayPlanCode, StaticProviderRouteCatalogOptions, ProviderCredentialSource, RedactedProviderCredentialSource } from "./types";

type JsonRedactionContext = "credential-source" | "diagnostic-metadata";
import { cloneStringRecord } from "./credential-resolver";

function compactDefined<T extends object>(obj: T | undefined): Partial<T> {
  if (!obj) return {};
  return Object.fromEntries(Object.entries(obj as Record<string, unknown>).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------------------
// StaticProviderRouteCatalog
// ---------------------------------------------------------------------------

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
    const mergedMetadata = mergeMetadata(current.metadata, result.metadata);
    const next: ProviderRouteHealth = {
      ...compactDefined(current),
      status: result.ok ? "healthy" : cooldownUntil && cooldownUntil > now ? "unhealthy" : "degraded",
      successCount,
      failureCount,
      consecutiveFailures,
      cooldownUntil,
      lastSuccessAt: result.ok ? now : current.lastSuccessAt ?? null,
      lastFailureAt: result.ok ? current.lastFailureAt ?? null : now,
      ...(result.ok
        ? { lastSuccess: routeHealthEvent(now, result.latencyMs, null, result.metadata) }
        : current.lastSuccess !== undefined
          ? { lastSuccess: current.lastSuccess }
          : {}),
      ...(!result.ok
        ? { lastFailure: routeHealthEvent(now, result.latencyMs, result.errorCode?.trim() || "provider_failed", result.metadata) }
        : current.lastFailure !== undefined
          ? { lastFailure: current.lastFailure }
          : {}),
      lastErrorCode: result.ok ? null : result.errorCode?.trim() || "provider_failed",
      lastLatencyMs: result.latencyMs == null ? current.lastLatencyMs ?? null : normalizeNonNegativeInteger(result.latencyMs, 0),
      updatedAt: now,
      ...(mergedMetadata !== undefined ? { metadata: mergedMetadata } : {})
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

  hasRoute(routeId: string): boolean {
    return this.routes.has(normalizeText(routeId));
  }

  removeRoute(routeId: string): boolean {
    const id = normalizeText(routeId);
    if (!id) return false;
    return this.routes.delete(id);
  }

  private resolveCooldownMs(consecutiveFailures: number): number {
    const value = typeof this.cooldownMs === "function" ? this.cooldownMs(consecutiveFailures) : this.cooldownMs;
    return normalizePositiveInteger(value, defaultCooldownMs(consecutiveFailures));
  }
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

export function routeMatchesRequest(route: ProviderRouteOffer, request: ProviderRouteRequest, requestedModel: string): boolean {
  if (request.routeId && route.id !== request.routeId) return false;
  if (request.providerId && route.providerId !== request.providerId) return false;
  const selectedProfile = request.modelRouteDecision?.selected;
  if (selectedProfile?.routeId && route.id !== selectedProfile.routeId) return false;
  if (selectedProfile?.providerId && route.providerId !== selectedProfile.providerId) return false;
  return routeMatchesModel(route, requestedModel);
}

export function routeMatchesModel(route: ProviderRouteOffer, model: string): boolean {
  const requested = normalizeText(model);
  if (!requested) return false;
  if (route.model === requested) return true;
  return Boolean(route.aliases?.includes(requested));
}

export function routeInCooldown(route: ProviderRouteOffer, now: number): boolean {
  return Boolean(route.health?.cooldownUntil && route.health.cooldownUntil > now);
}

export function compareRouteOffers(a: ProviderRouteOffer, b: ProviderRouteOffer, now: number): number {
  return (
    normalizeNonNegativeInteger(b.priority, 100) - normalizeNonNegativeInteger(a.priority, 100) ||
    routeHealthScore(b, now) - routeHealthScore(a, now) ||
    normalizeNonNegativeInteger(b.routingWeight, 100) - normalizeNonNegativeInteger(a.routingWeight, 100) ||
    a.id.localeCompare(b.id)
  );
}

export function toRouteSelection(route: ProviderRouteOffer, requestedModel: string, now: number): ProviderRouteSelection {
  const endpointSupportValue = route.endpointSupport ?? (route.endpointType !== undefined ? endpointSupportFromEndpointType(route.endpointType) : undefined);
  return {
    routeId: route.id,
    providerId: route.providerId,
    requestedModel,
    model: route.model,
    upstreamModel: route.upstreamModel ?? route.model,
    ...(route.endpointType !== undefined ? { endpointType: route.endpointType } : {}),
    ...(endpointSupportValue !== undefined ? { endpointSupport: endpointSupportValue } : {}),
    ...(route.streamingSupport !== undefined ? { streamingSupport: route.streamingSupport } : {}),
    priority: normalizeNonNegativeInteger(route.priority, 100),
    routingWeight: normalizeNonNegativeInteger(route.routingWeight, 100),
    healthScore: routeHealthScore(route, now),
    fallback: Boolean(route.fallback),
    credentialSourceType: route.credentialSource.type,
    credentialSource: redactCredentialSource(route.credentialSource),
    ...(route.health?.lastSuccess !== undefined ? { lastSuccess: route.health.lastSuccess } : {}),
    ...(route.health?.lastFailure !== undefined ? { lastFailure: route.health.lastFailure } : {})
  };
}

// ---------------------------------------------------------------------------
// Health scoring
// ---------------------------------------------------------------------------

export function routeHealthScore(route: ProviderRouteOffer, now: number): number {
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

export function statusHealthScore(status: ProviderRouteHealthStatus | undefined): number {
  if (status === "healthy") return 100;
  if (status === "degraded") return 60;
  if (status === "unhealthy") return 20;
  return 80;
}

// ---------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------

export function failurePlan(input: {
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
    ...(input.selectedRoute !== undefined ? { selectedRoute: input.selectedRoute } : {}),
    credentialConfigured: false,
    ...(input.capabilityRequest !== undefined ? { capabilityRequest: input.capabilityRequest } : {}),
    ...(input.modelRouteDecision !== undefined ? { modelRouteDecision: input.modelRouteDecision } : {}),
    candidateCount: input.candidateCount,
    availableCandidateCount: input.availableCandidateCount,
    cooldownCandidateCount: input.cooldownCandidateCount,
    fallbackUsed: input.fallbackUsed,
    routeDecision: input.routeDecision
  };
}

export function modelRoutingRouteDecision(request: ProviderRouteRequest): string[] {
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

export function hasEndpointOrStreamingRequirement(request: ModelRouteDecision["request"]): boolean {
  return request.requiredEndpointSupport.length > 0 || request.requiredStreamingSupport.length > 0;
}

// ---------------------------------------------------------------------------
// Clone helpers
// ---------------------------------------------------------------------------

export function cloneRouteOffer(route: ProviderRouteOffer): ProviderRouteOffer {
  return {
    id: route.id,
    model: route.model,
    providerId: route.providerId,
    ...(route.aliases !== undefined ? { aliases: [...route.aliases] } : {}),
    upstreamModel: route.upstreamModel ?? route.model,
    ...(route.endpointType !== undefined ? { endpointType: route.endpointType } : {}),
    ...(route.endpointSupport !== undefined ? { endpointSupport: route.endpointSupport } : {}),
    ...(route.streamingSupport !== undefined ? { streamingSupport: route.streamingSupport } : {}),
    ...(route.priority !== undefined ? { priority: route.priority } : {}),
    ...(route.routingWeight !== undefined ? { routingWeight: route.routingWeight } : {}),
    ...(route.fallback !== undefined ? { fallback: route.fallback } : {}),
    ...(route.status !== undefined ? { status: route.status } : {}),
    credentialSource: cloneCredentialSource(route.credentialSource),
    ...(route.health !== undefined ? { health: cloneRouteHealth(route.health) } : {}),
    ...(route.modelProfile !== undefined ? { modelProfile: cloneModelProfile(route.modelProfile) } : {}),
    ...(route.provider !== undefined ? { provider: route.provider } : {}),
    ...(route.providerFactory !== undefined ? { providerFactory: route.providerFactory } : {}),
    ...(route.providerOptions !== undefined ? { providerOptions: cloneJsonObject(route.providerOptions) } : {}),
    ...(route.metadata !== undefined ? { metadata: cloneJsonObject(route.metadata) } : {})
  } as ProviderRouteOffer;
}

export function cloneModelProfile(profile: ModelProfile | undefined): ModelProfile | undefined {
  if (!profile) return undefined;
  return {
    id: profile.id,
    ...compactDefined(profile as unknown as Record<string, unknown>),
    ...(profile.aliases !== undefined ? { aliases: [...profile.aliases] } : {}),
    ...(profile.capabilities !== undefined ? { capabilities: { ...profile.capabilities } } : {}),
    ...(profile.credentialSource !== undefined ? { credentialSource: cloneJsonObject(profile.credentialSource) } : {}),
    route: profile.route
      ? ({
          ...(profile.route.providerId !== undefined ? { providerId: profile.route.providerId } : {}),
          ...(profile.route.routeId !== undefined ? { routeId: profile.route.routeId } : {}),
          ...(profile.route.model !== undefined ? { model: profile.route.model } : {}),
          ...(profile.route.upstreamModel !== undefined ? { upstreamModel: profile.route.upstreamModel } : {}),
          ...(profile.route.endpointSupport !== undefined ? { endpointSupport: profile.route.endpointSupport } : {}),
          ...(profile.route.streamingSupport !== undefined ? { streamingSupport: profile.route.streamingSupport } : {}),
          ...(profile.route.credentialSource !== undefined ? { credentialSource: cloneJsonObject(profile.route.credentialSource) } : {}),
          ...(profile.route.health !== undefined ? { health: profile.route.health } : {}),
          ...(profile.route.lastSuccess !== undefined ? { lastSuccess: cloneRouteHealthEvent(profile.route.lastSuccess) } : {}),
          ...(profile.route.lastFailure !== undefined ? { lastFailure: cloneRouteHealthEvent(profile.route.lastFailure) } : {}),
          ...(profile.route.metadata !== undefined ? { metadata: cloneJsonObject(profile.route.metadata) } : {})
        } as ModelProviderRouteMetadata)
      : undefined,
    ...(profile.lastSuccess !== undefined ? { lastSuccess: cloneRouteHealthEvent(profile.lastSuccess) } : {}),
    ...(profile.lastFailure !== undefined ? { lastFailure: cloneRouteHealthEvent(profile.lastFailure) } : {}),
    ...(profile.metadata !== undefined ? { metadata: cloneJsonObject(profile.metadata) } : {})
  } as ModelProfile;
}

export function cloneCredentialSource(source: ProviderCredentialSource): ProviderCredentialSource {
  if (source.type === "account") {
    return {
      type: "account",
      ...(source.accountId !== undefined ? { accountId: source.accountId } : {}),
      ...(source.providerId !== undefined ? { providerId: source.providerId } : {}),
      ...(source.keyClass !== undefined ? { keyClass: source.keyClass } : {}),
      ...(source.credentialId !== undefined ? { credentialId: source.credentialId } : {}),
      ...(source.metadata !== undefined ? { metadata: cloneJsonObject(source.metadata) } : {})
    } as ProviderCredentialSource;
  }
  return {
    type: "api-key",
    apiKey: source.apiKey,
    ...(source.providerId !== undefined ? { providerId: source.providerId } : {}),
    ...(source.credentialId !== undefined ? { credentialId: source.credentialId } : {}),
    ...(source.baseUrl !== undefined ? { baseUrl: source.baseUrl } : {}),
    headers: cloneStringRecord(source.headers),
    ...(source.metadata !== undefined ? { metadata: cloneJsonObject(source.metadata) } : {})
  } as ProviderCredentialSource;
}

export function cloneRouteHealth(health: ProviderRouteHealth | undefined): ProviderRouteHealth | undefined {
  if (!health) return undefined;
  return {
    ...compactDefined(health as unknown as Record<string, unknown>),
    ...(health.lastSuccess !== undefined ? { lastSuccess: cloneRouteHealthEvent(health.lastSuccess) } : {}),
    ...(health.lastFailure !== undefined ? { lastFailure: cloneRouteHealthEvent(health.lastFailure) } : {}),
    ...(health.metadata !== undefined ? { metadata: cloneJsonObject(health.metadata) } : {})
  } as ProviderRouteHealth;
}

export function cloneRouteHealthEvent(event: ProviderRouteHealthEvent | undefined): ProviderRouteHealthEvent | undefined {
  if (!event) return undefined;
  return {
    ...compactDefined(event as unknown as Record<string, unknown>),
    ...(event.metadata !== undefined ? { metadata: cloneJsonObject(event.metadata) } : {})
  } as ProviderRouteHealthEvent;
}

export function cloneJsonObject(value: JsonObject | undefined): JsonObject | undefined {
  return value ? { ...value } : undefined;
}

export function mergeMetadata(left: JsonObject | undefined, right: JsonObject | undefined): JsonObject | undefined {
  if (!left && !right) return undefined;
  return {
    ...(left ?? {}),
    ...(right ?? {})
  };
}

export function capabilityMetadata(request: ProviderRouteRequest): JsonObject | undefined {
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

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

export function redactCredentialSource(source: ProviderCredentialSource): RedactedProviderCredentialSource {
  if (source.type === "account") {
    return {
      type: "account",
      ...(source.accountId !== undefined ? { accountId: source.accountId } : {}),
      ...(source.providerId !== undefined ? { providerId: source.providerId } : {}),
      ...(source.keyClass !== undefined ? { keyClass: source.keyClass } : {}),
      ...(source.credentialId !== undefined ? { credentialId: source.credentialId } : {}),
      ...(source.metadata !== undefined ? { metadata: redactJsonObject(source.metadata, "credential-source") } : {})
    } as RedactedProviderCredentialSource;
  }
  return {
    type: "api-key",
    ...(source.providerId !== undefined ? { providerId: source.providerId } : {}),
    ...(source.credentialId !== undefined ? { credentialId: source.credentialId } : {}),
    ...(source.baseUrl !== undefined ? { baseUrl: source.baseUrl } : {}),
    headerNames: Object.keys(source.headers ?? {}).sort(),
    ...(source.metadata !== undefined ? { metadata: redactJsonObject(source.metadata, "credential-source") } : {})
  } as RedactedProviderCredentialSource;
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

// ---------------------------------------------------------------------------
// General utilities
// ---------------------------------------------------------------------------

export function routeHealthEvent(
  at: number,
  latencyMs: number | null | undefined,
  errorCode: string | null,
  metadata: JsonObject | undefined
): ProviderRouteHealthEvent {
  return {
    at,
    latencyMs: latencyMs == null ? null : normalizeNonNegativeInteger(latencyMs, 0),
    errorCode,
    ...(metadata !== undefined ? { metadata: cloneJsonObject(metadata) } : {})
  } as ProviderRouteHealthEvent;
}

function endpointSupportFromEndpointType(value: string | undefined): ProviderEndpointSupport | undefined {
  if (value === "responses" || value === "chat-completions" || value === "auto") return value;
  return undefined;
}

export function normalizeText(value: string | undefined): string {
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
