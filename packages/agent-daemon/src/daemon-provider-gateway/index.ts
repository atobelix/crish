import { DefaultProviderGateway, ProviderGatewayError, routeModelByCapability } from "@crish/agent-model";
import type { AgentProvider, ProviderCredentialSource, ProviderGateway, ProviderGatewayPlan, ProviderRouteOffer, ProviderRouteRequest } from "@crish/agent-model";
import type { JsonObject } from "@crish/shared-types";
import { normalizeConfig } from "./credential-modes.js";
import type { NormalizedDaemonProviderRuntimeConfig } from "./types.js";
import {
  formatProviderGatewayError,
  redactedApiKeyStatus,
  resolveReadiness,
  credentialSourceSnapshot,
  toProviderDiagnostic,
} from "./health.js";
import {
  createProviderFromPlan,
  isProviderFactoryPlan,
  capabilityRequestFromConfig,
  streamingSupportFromConfig,
  providerOptionsMetadata,
  routeMetadataFromConfig,
  profileFromDaemonRouteOffer,
  redactProviderGatewayPlan,
} from "./provider-factory.js";
import type {
  DaemonProviderFactoryMetadata,
  DaemonProviderGatewayControllerOptions,
  DaemonProviderRuntimeConfig,
  DaemonProviderRuntimeConfigUpdate,
  DaemonProviderFactoryWithStatus,
} from "./types.js";
import type { DaemonProviderStatusSnapshot } from '../types.js';
import { cloneHeaders, nonEmpty } from "./types.js";

function definedConfigUpdate(
  update: DaemonProviderRuntimeConfigUpdate
): Partial<DaemonProviderRuntimeConfig> {
  const next: Partial<DaemonProviderRuntimeConfig> = {};
  if (update.credentialMode !== undefined) {
    next.credentialMode = update.credentialMode;
  }
  if (update.apiKey !== undefined) {
    next.apiKey = update.apiKey;
    next.apiKeySource = nonEmpty(update.apiKey) ? 'runtime-update' : 'unset';
  }
  if (update.accountId !== undefined) next.accountId = update.accountId;
  if (update.baseUrl !== undefined) next.baseUrl = update.baseUrl;
  if (update.model !== undefined) next.model = update.model;
  if (update.endpoint !== undefined) next.endpoint = update.endpoint;
  if (update.stream !== undefined) next.stream = update.stream;
  if (update.systemPromptWireMode !== undefined)
    next.systemPromptWireMode = update.systemPromptWireMode;
  return next;
}

export class DaemonProviderGatewayController {
  private config: NormalizedDaemonProviderRuntimeConfig;
  private gatewayValue: ProviderGateway;
  private lastPlan: ProviderGatewayPlan | undefined;
  private lastDiagnostic: import('../types.js').DaemonProviderDiagnostic | undefined;
  private lastStatusAt: string | undefined;

  constructor(
    config: DaemonProviderRuntimeConfig,
    private readonly options: DaemonProviderGatewayControllerOptions = {}
  ) {
    this.config = normalizeConfig(config);
    this.gatewayValue = this.createGateway();
  }

  get gateway(): ProviderGateway {
    return this.gatewayValue;
  }

  getConfig(): DaemonProviderRuntimeConfig {
    return { ...this.config, headers: cloneHeaders(this.config.headers) };
  }

  update(update: DaemonProviderRuntimeConfigUpdate): void {
    const nextConfig = {
      ...this.config,
      ...definedConfigUpdate(update),
    } as DaemonProviderRuntimeConfig;
    if (
      update.model !== undefined &&
      this.config.upstreamModel === this.config.model
    ) {
      (nextConfig as unknown as Record<string, unknown>).upstreamModel = undefined;
    }
    this.config = normalizeConfig(nextConfig);
    this.gatewayValue = this.createGateway();
    this.lastPlan = undefined;
    this.lastDiagnostic = undefined;
    this.lastStatusAt = new Date().toISOString();
  }

  async planProvider(
    metadata?: Partial<DaemonProviderFactoryMetadata>
  ): Promise<ProviderGatewayPlan> {
    try {
      const plan = await this.gatewayValue.planRoute(this.request(metadata));
      this.recordPlan(plan);
      return plan;
    } catch (cause) {
      this.recordFailure(cause);
      throw cause;
    }
  }

  async createProvider(
    metadata: DaemonProviderFactoryMetadata
  ): Promise<AgentProvider> {
    try {
      const provider = await this.gatewayValue.resolveProvider(
        this.request(metadata)
      );
      if (isProviderFactoryPlan(provider)) {
        throw new Error(
          `Provider gateway returned an unresolved plan for route ${provider.route.routeId}.`
        );
      }
      this.recordReady();
      return provider;
    } catch (cause) {
      if (cause instanceof ProviderGatewayError) {
        this.recordPlan(cause.plan);
        throw new Error(formatProviderGatewayError(cause.plan));
      }
      this.recordFailure(cause);
      throw cause;
    }
  }

  getStatusSnapshot(): DaemonProviderStatusSnapshot {
    const credentialMode = this.config.credentialMode;
    const activeCredentialMode = this.activeCredentialMode();
    const apiKeyLast4Exposure = (this.config as unknown as Record<string, unknown>).apiKeyLast4Exposure as string | undefined;
    const apiKey = redactedApiKeyStatus(this.config, apiKeyLast4Exposure);
    const lastDiagnostic = this.lastDiagnostic;
    const readiness = resolveReadiness({
      credentialMode: activeCredentialMode,
      hasDirectApiKey: apiKey.hasApiKey,
      ...(lastDiagnostic !== undefined ? { lastDiagnostic } : {}),
    });
    const updatedAt = this.lastStatusAt ?? new Date().toISOString();

    return {
      credentialMode,
      readiness,
      providerId: this.config.providerId,
      routeId: this.config.routeId,
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      upstreamModel: this.config.upstreamModel,
      endpoint: this.config.endpoint,
      stream: this.config.stream,
      systemPromptWireMode: this.config.systemPromptWireMode,
      apiKey,
      hasDirectApiKey: apiKey.hasApiKey,
      apiKeySource: apiKey.source,
      gateway: {
        ready: readiness === 'ready',
        credentialConfigured:
          this.lastPlan?.credentialConfigured ?? apiKey.hasApiKey,
        routeDecision: this.lastPlan?.routeDecision ?? [],
        ...(this.lastPlan?.code ? { code: this.lastPlan.code } : {}),
        selectedRouteId:
          this.lastPlan?.selectedRoute?.routeId ?? this.config.routeId,
        selectedProviderId:
          this.lastPlan?.selectedRoute?.providerId ?? this.config.providerId,
        ...(this.lastPlan?.selectedRoute?.endpointSupport
          ? { selectedEndpointSupport: this.lastPlan.selectedRoute.endpointSupport }
          : { selectedEndpointSupport: this.config.endpoint }),
        ...(this.lastPlan?.selectedRoute?.streamingSupport
          ? { selectedStreamingSupport: this.lastPlan.selectedRoute.streamingSupport }
          : { selectedStreamingSupport: streamingSupportFromConfig(this.config) }),
        ...(credentialSourceSnapshot(this.lastPlan)
          ? {
              selectedCredentialSource: credentialSourceSnapshot(this.lastPlan),
            }
          : {}),
        ...(this.lastPlan?.selectedRoute?.lastSuccess
          ? {
              lastSuccess: this.lastPlan.selectedRoute
                .lastSuccess as JsonObject,
            }
          : {}),
        ...(this.lastPlan?.selectedRoute?.lastFailure
          ? {
              lastFailure: this.lastPlan.selectedRoute
                .lastFailure as JsonObject,
            }
          : {}),
        ...(this.lastStatusAt ? { updatedAt: this.lastStatusAt } : {}),
      } as import('../types.js').DaemonProviderGatewayStatusSnapshot,
      ...(lastDiagnostic ? { lastDiagnostic } : {}),
      updatedAt,
    } as DaemonProviderStatusSnapshot;
  }

  private activeCredentialMode(): 'direct' {
    return 'direct';
  }

  private request(
    metadata: Partial<DaemonProviderFactoryMetadata> = {}
  ): ProviderRouteRequest {
    const capabilityRequest = capabilityRequestFromConfig(this.config);
    const modelRouteDecision = routeModelByCapability(
      this.routesForPlanning().map((route) =>
        profileFromDaemonRouteOffer(route)
      ),
      capabilityRequest
    );
    const selectedRouteId = modelRouteDecision.selected?.routeId;
    return {
      model: this.config.model,
      ...(this.config.accountId !== undefined ? { accountId: this.config.accountId } : {}),
      ...(selectedRouteId !== undefined ? { routeId: selectedRouteId } : {}),
      materializeProvider: true,
      capabilityRequest,
      modelRouteDecision,
      metadata: {
        daemon: true,
        ...(metadata.runId ? { runId: metadata.runId } : {}),
        ...(metadata.cwd ? { cwd: metadata.cwd } : {}),
      },
    };
  }

  private createGateway(): ProviderGateway {
    return new DefaultProviderGateway({
      routes: this.routesForPlanning(),
    });
  }

  private recordPlan(plan: ProviderGatewayPlan): void {
    this.lastPlan = redactProviderGatewayPlan(plan);
    this.lastStatusAt = new Date().toISOString();
    if (plan.ok) {
      this.lastDiagnostic = undefined;
    } else {
      this.lastDiagnostic = {
        code: plan.code ?? 'provider_gateway_unavailable',
        message: formatProviderGatewayError(plan),
        updatedAt: this.lastStatusAt as string,
      };
    }
  }

  private recordReady(): void {
    this.lastStatusAt = new Date().toISOString();
    this.lastDiagnostic = undefined;
  }

  private recordFailure(cause: unknown): void {
    this.lastStatusAt = new Date().toISOString();
    this.lastDiagnostic = toProviderDiagnostic(cause, this.lastStatusAt as string);
  }

  private createRoute(): ProviderRouteOffer {
    const credentialSource: ProviderCredentialSource =
      this.activeCredentialMode() === 'direct'
        ? {
            type: 'api-key' as const,
            apiKey: this.config.apiKey ?? '',
            providerId: this.config.providerId!,
            baseUrl: this.config.baseUrl,
            ...(cloneHeaders(this.config.headers) !== undefined ? { headers: cloneHeaders(this.config.headers) as Record<string, string> } : {}),
          }
        : {
            type: 'account' as const,
            ...(this.config.accountId !== undefined ? { accountId: this.config.accountId } : {}),
            providerId: this.config.providerId!,
            keyClass: 'external' as const,
          };

    return {
      id: this.config.routeId!,
      model: this.config.model,
      aliases: [this.config.upstreamModel].filter(
        (value) => value && value !== this.config.model
      ) as string[],
      providerId: this.config.providerId!,
      upstreamModel: this.config.upstreamModel!,
      endpointType: this.config.endpoint!,
      endpointSupport: this.config.endpoint!,
      streamingSupport: streamingSupportFromConfig(this.config),
      priority: 100,
      credentialSource,
      providerOptions: providerOptionsMetadata(this.config),
      metadata: routeMetadataFromConfig(this.config),
      providerFactory: (plan) => createProviderFromPlan(plan, this.config),
    };
  }

  private routesForPlanning(): ProviderRouteOffer[] {
    if (typeof this.options.routes === 'function')
      return this.options
        .routes()
        .map((route) => this.routeWithDefaultFactory(route));
    if (this.options.routes)
      return this.options.routes.map((route) =>
        this.routeWithDefaultFactory(route)
      );
    return [this.createRoute()];
  }

  private routeWithDefaultFactory(
    route: ProviderRouteOffer
  ): ProviderRouteOffer {
    if (route.provider || route.providerFactory) return route;
    return {
      ...route,
      providerOptions:
        route.providerOptions ?? providerOptionsMetadata(this.config),
      metadata: route.metadata ?? routeMetadataFromConfig(this.config),
      providerFactory: (plan) => createProviderFromPlan(plan, this.config),
    };
  }
}

export function createDaemonProviderGatewayController(
  config: DaemonProviderRuntimeConfig,
  options: DaemonProviderGatewayControllerOptions = {}
): DaemonProviderGatewayController {
  return new DaemonProviderGatewayController(config, options);
}

export function createDaemonProviderFactory(
  controller: DaemonProviderGatewayController
): (runId: string, cwd: string) => Promise<AgentProvider> {
  const factory = ((runId: string, cwd: string) =>
    controller.createProvider({
      runId,
      cwd,
    })) as DaemonProviderFactoryWithStatus;
  factory.getProviderStatusSnapshot = () => controller.getStatusSnapshot();
  return factory;
}

export type {
  DaemonProviderRuntimeConfig,
  DaemonProviderRuntimeConfigUpdate,
  DaemonProviderRuntimeConfigSources,
  DaemonProviderGatewayControllerOptions,
  DaemonProviderFactoryMetadata,
} from "./types.js";

export {
  DAEMON_PROVIDER_CONFIG_PRECEDENCE,
  type DaemonProviderFactoryWithStatus,
} from "./types.js";

export { providerPlanMetadata } from "./health.js";
export { createDaemonProviderRuntimeConfig, createDaemonProviderRuntimeConfigFromEnv } from "./credential-modes.js";
