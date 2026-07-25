import type { AgentProvider } from "../types";
import { GatewayV2Bridge } from "../provider/provider-gateway-v2";
import { enrichProfileFromCatalog, profileFromProviderRouteOffer } from "../model-routing";
import { CredentialResolver } from "../provider/auth/credential-resolver";
import { createSecret } from "../provider/auth/types";

import type { ProviderRouteOffer, ProviderRouteRequest, ProviderRouteCatalog, ResolvedProviderCredential } from "./types";
import { ProviderGatewayError, type ProviderFactoryPlan, type ProviderGateway, type ProviderGatewayOptions, type ProviderGatewayPlan, type ProviderRouteResult, type ProviderRouteHealth } from "./types";
import { StaticProviderRouteCatalog, routeMatchesRequest, routeInCooldown, compareRouteOffers, toRouteSelection, failurePlan, modelRoutingRouteDecision, hasEndpointOrStreamingRequirement, normalizeText, capabilityMetadata, mergeMetadata } from "./route-selector";
import { normalizeCredentialSource, normalizeResolvedCredential, validateCredential, cloneStringRecord } from "./credential-resolver";

declare module "./types" {
  interface ProviderGatewayOptions {
    gatewayBridge?: GatewayV2Bridge;
  }
}

export class DefaultProviderGateway implements ProviderGateway {
  private readonly catalog: ProviderRouteCatalog;
  private readonly credentialResolver: import("./types").ProviderCredentialResolver | undefined;
  private readonly secretStore: import("../provider/auth/secret-store").SecretStore | undefined;
  private readonly now: () => number;
  private readonly modelCatalog: import("../model-catalog/types").ModelCatalog | undefined;
  private readonly gatewayBridge: GatewayV2Bridge | undefined;

  constructor(options: ProviderGatewayOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.catalog = options.catalog ?? new StaticProviderRouteCatalog(options.routes ?? [], { now: this.now });
    this.credentialResolver = options.credentialResolver;
    this.secretStore = options.secretStore;
    this.modelCatalog = options.modelCatalog;
    this.gatewayBridge = options.gatewayBridge;
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
      if (this.gatewayBridge) {
        const factory = this.gatewayBridge.getProviderFactory();
        const result = factory(plan.providerPlan);
        if (!(result instanceof Promise)) return result;
      }
    }

    return plan.providerPlan;
  }

  recordRouteResult(result: ProviderRouteResult): ProviderRouteHealth | void | Promise<ProviderRouteHealth | void> {
    return this.catalog.recordRouteResult?.(result);
  }

  private async planWithRoute(request: ProviderRouteRequest): Promise<{ plan: ProviderGatewayPlan; route?: ProviderRouteOffer }> {
    const requestedModel = normalizeText(request.model);

    if (request.hasMedia && request.capabilityRequest) {
      const hasVision = request.capabilityRequest.required?.includes("vision");
      if (!hasVision) {
        request.capabilityRequest = {
          ...request.capabilityRequest,
          required: [...(request.capabilityRequest.required ?? []), "vision"],
        };
      }
    } else if (request.hasMedia && !request.capabilityRequest) {
      request.capabilityRequest = { required: ["vision"] };
    }

    const routeDecision = requestedModel ? [`requested_model:${requestedModel}`] : ["model_required"];
    routeDecision.push(...modelRoutingRouteDecision(request));
    if (request.hasMedia) routeDecision.push("request_has_media:vision_auto_required");
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
      ...(request.providerId !== undefined ? { providerId: request.providerId } : {}),
      ...(request.accountId !== undefined ? { accountId: request.accountId } : {})
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
          ...(request.capabilityRequest !== undefined ? { capabilityRequest: request.capabilityRequest } : {}),
          ...(request.modelRouteDecision !== undefined ? { modelRouteDecision: request.modelRouteDecision } : {})
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

    if (this.modelCatalog) {
      const profile = selected.modelProfile ?? profileFromProviderRouteOffer({
        id: selected.id,
        model: selected.model,
        providerId: selected.providerId,
        ...(selected.aliases !== undefined ? { aliases: selected.aliases } : {}),
        ...(selected.upstreamModel !== undefined ? { upstreamModel: selected.upstreamModel } : {}),
        ...(selected.endpointType !== undefined ? { endpointType: selected.endpointType } : {}),
        ...(selected.endpointSupport !== undefined ? { endpointSupport: selected.endpointSupport } : {}),
        ...(selected.streamingSupport !== undefined ? { streamingSupport: selected.streamingSupport } : {}),
        ...(selected.priority !== undefined ? { priority: selected.priority } : {}),
      });
      selected.modelProfile = enrichProfileFromCatalog(profile, this.modelCatalog);
    }

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

    const mergedMeta = mergeMetadata(selected.metadata, capabilityMetadata(request));
    const providerPlan: ProviderFactoryPlan = {
      kind: "provider-factory-plan",
      route: selectedRoute,
      credential,
      ...(selected.providerOptions !== undefined ? { providerOptions: selected.providerOptions } : {}),
      ...(selected.modelProfile !== undefined ? { modelProfile: selected.modelProfile } : {}),
      ...(request.capabilityRequest !== undefined ? { capabilityRequest: request.capabilityRequest } : {}),
      ...(request.modelRouteDecision !== undefined ? { modelRouteDecision: request.modelRouteDecision } : {}),
      ...(mergedMeta !== undefined ? { metadata: mergedMeta } : {})
    };

    return {
      plan: {
        ok: true,
        requestedModel,
        selectedRoute,
        credentialConfigured: true,
        credential,
        providerPlan,
        ...(request.capabilityRequest !== undefined ? { capabilityRequest: request.capabilityRequest } : {}),
        ...(request.modelRouteDecision !== undefined ? { modelRouteDecision: request.modelRouteDecision } : {}),
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
      if (resolved) {
        const normalized = normalizeResolvedCredential(resolved, route, credentialSource);
        validateCredential(normalized);
        return normalized;
      }
    }

    if (credentialSource.type !== "api-key") return null;

    const resolver = new CredentialResolver({
      ...(credentialSource.apiKey?.trim() ? { directKey: createSecret(credentialSource.apiKey.trim()) } : {}),
      ...(this.secretStore !== undefined ? { secretStore: this.secretStore } : {}),
      envVarPrefix: "CONEX_API_KEY_"
    });
    const resolved = await resolver.resolve(credentialSource.providerId ?? route.providerId);
    if (!resolved) return null;

    const hdrs = cloneStringRecord(credentialSource.headers);
    const normalized: ResolvedProviderCredential = {
      id: credentialSource.credentialId ?? `${route.id}:api-key`,
      source: "api-key",
      providerId: credentialSource.providerId ?? route.providerId,
      apiKey: resolved.key,
      ...(credentialSource.baseUrl !== undefined ? { baseUrl: credentialSource.baseUrl } : {}),
      ...(hdrs !== undefined ? { headers: hdrs } : {}),
      ...(credentialSource.metadata !== undefined ? { metadata: credentialSource.metadata } : {})
    };

    validateCredential(normalized);
    return normalized;
  }
}

export function createProviderGateway(options: ProviderGatewayOptions = {}): ProviderGateway {
  return new DefaultProviderGateway(options);
}

// Barrel re-exports
export * from "./types";
export { StaticProviderRouteCatalog } from "./route-selector";
export { initProviderEngine, resolveProviderViaBridge, resetProviderEngine } from "./factory";
