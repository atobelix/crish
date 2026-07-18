import {
  DefaultProviderGateway,
  OpenAICompatibleProvider,
  ProviderGatewayError,
  type AgentProvider,
  type OpenAICompatibleAuthHeader,
  type OpenAICompatibleEndpoint,
  type OpenAICompatibleMaxTokensField,
  type OpenAICompatibleProviderOptions,
  type OpenAICompatibleTransport,
  type SystemPromptWireMode,
  profileFromProviderRouteOffer,
  type ProviderEndpointSupport,
  type ProviderFactoryPlan,
  type ProviderGateway,
  type ProviderGatewayPlan,
  type ProviderRouteRequest,
  type ProviderRouteOffer,
  type ProviderStreamingSupport,
  routeModelByCapability,
  type TaskCapabilityRequest
} from "@crish/agent-runtime";
import type { JsonObject } from "@crish/shared-types";
import { isJsonObject } from "@crish/shared-utils";
import {
  ConfigMerger,
  PROVIDER_CONFIG_SCHEMA,
  type ConfigValidationResult,
  type ConfigValidationError,
  type ConfigSourcePriority,
} from "@crish/agent-runtime";
import type {
  DaemonProviderApiKeySource,
  DaemonProviderCredentialMode,
  DaemonProviderDiagnostic,
  DaemonProviderRedactedApiKeyStatus,
  DaemonProviderReadiness,
  DaemonProviderStatusSnapshot,
} from "./types.js";

export interface DaemonProviderRuntimeConfig {
  credentialMode?: DaemonProviderCredentialMode;
  apiKey?: string;
  apiKeySource?: DaemonProviderApiKeySource;
  accountId?: string;
  baseUrl: string;
  model: string;
  providerId?: string;
  routeId?: string;
  upstreamModel?: string;
  endpoint?: OpenAICompatibleEndpoint;
  authHeader?: OpenAICompatibleAuthHeader;
  maxTokensField?: OpenAICompatibleMaxTokensField;
  maxTokens?: number;
  stream?: boolean;
  diagnostics?: boolean;
  transport?: OpenAICompatibleTransport;
  systemPromptWireMode?: SystemPromptWireMode;
  requestTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  headers?: Record<string, string>;
}

export interface DaemonProviderRuntimeConfigUpdate {
  credentialMode?: DaemonProviderCredentialMode;
  apiKey?: string;
  accountId?: string;
  baseUrl?: string;
  model?: string;
  endpoint?: OpenAICompatibleEndpoint;
  stream?: boolean;
  systemPromptWireMode?: SystemPromptWireMode;
}

export interface DaemonProviderRuntimeConfigSources {
  defaults: Pick<DaemonProviderRuntimeConfig, "baseUrl" | "model"> & Partial<DaemonProviderRuntimeConfig>;
  env?: Record<string, string | undefined>;
  userConfig?: Partial<DaemonProviderRuntimeConfig>;
  workspaceConfig?: Partial<DaemonProviderRuntimeConfig>;
  runtimeConfig?: Partial<DaemonProviderRuntimeConfig>;
}

export interface DaemonProviderGatewayControllerOptions {
  routes?: ProviderRouteOffer[] | (() => ProviderRouteOffer[]);
}

export interface DaemonProviderFactoryMetadata {
  runId: string;
  cwd: string;
}

const DEFAULT_PROVIDER_ID = "crish";
const DEFAULT_ROUTE_ID = "default";
const DEFAULT_ENDPOINT: OpenAICompatibleEndpoint = "auto";
const DEFAULT_AUTH_HEADER: OpenAICompatibleAuthHeader = "authorization";
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 30_000;
export const DAEMON_PROVIDER_CONFIG_PRECEDENCE = [
  "default",
  "workspace-config",
  "user-config",
  "env",
  "runtime-update",
] as const;

/**
 * 共享的 Provider 配置合并器，基于 PROVIDER_CONFIG_SCHEMA 定义字段策略和校验规则。
 */
const providerConfigMerger = new ConfigMerger(PROVIDER_CONFIG_SCHEMA);

export class DaemonProviderGatewayController {
  private config: NormalizedDaemonProviderRuntimeConfig;
  private gatewayValue: ProviderGateway;
  private lastPlan?: ProviderGatewayPlan;
  private lastDiagnostic?: DaemonProviderDiagnostic;
  private lastStatusAt?: string;

  constructor(config: DaemonProviderRuntimeConfig, private readonly options: DaemonProviderGatewayControllerOptions = {}) {
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
    const nextConfig: DaemonProviderRuntimeConfig = {
      ...this.config,
      ...definedConfigUpdate(update)
    };
    if (update.model !== undefined && this.config.upstreamModel === this.config.model) {
      nextConfig.upstreamModel = undefined;
    }
    this.config = normalizeConfig(nextConfig);
    this.gatewayValue = this.createGateway();
    this.lastPlan = undefined;
    this.lastDiagnostic = undefined;
    this.lastStatusAt = new Date().toISOString();
  }

  async planProvider(metadata?: Partial<DaemonProviderFactoryMetadata>): Promise<ProviderGatewayPlan> {
    try {
      const plan = await this.gatewayValue.planRoute(this.request(metadata));
      this.recordPlan(plan);
      return plan;
    } catch (cause) {
      this.recordFailure(cause);
      throw cause;
    }
  }

  async createProvider(metadata: DaemonProviderFactoryMetadata): Promise<AgentProvider> {
    try {
      const provider = await this.gatewayValue.resolveProvider(this.request(metadata));
      if (isProviderFactoryPlan(provider)) {
        throw new Error(`Provider gateway returned an unresolved plan for route ${provider.route.routeId}.`);
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
    const apiKey = redactedApiKeyStatus(this.config);
    const lastDiagnostic = this.lastDiagnostic;
    const readiness = resolveReadiness({
      credentialMode: activeCredentialMode,
      hasDirectApiKey: apiKey.hasApiKey,
      lastDiagnostic,
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
        ready: readiness === "ready",
        credentialConfigured:
          this.lastPlan?.credentialConfigured ?? apiKey.hasApiKey,
        routeDecision: this.lastPlan?.routeDecision ?? [],
        ...(this.lastPlan?.code ? { code: this.lastPlan.code } : {}),
        selectedRouteId: this.lastPlan?.selectedRoute?.routeId ?? this.config.routeId,
        selectedProviderId: this.lastPlan?.selectedRoute?.providerId ?? this.config.providerId,
        selectedEndpointSupport: this.lastPlan?.selectedRoute?.endpointSupport ?? this.config.endpoint,
        selectedStreamingSupport: this.lastPlan?.selectedRoute?.streamingSupport ?? streamingSupportFromConfig(this.config),
        ...(credentialSourceSnapshot(this.lastPlan) ? { selectedCredentialSource: credentialSourceSnapshot(this.lastPlan) } : {}),
        ...(this.lastPlan?.selectedRoute?.lastSuccess ? { lastSuccess: this.lastPlan.selectedRoute.lastSuccess as JsonObject } : {}),
        ...(this.lastPlan?.selectedRoute?.lastFailure ? { lastFailure: this.lastPlan.selectedRoute.lastFailure as JsonObject } : {}),
        ...(this.lastStatusAt ? { updatedAt: this.lastStatusAt } : {}),
      },
      ...(lastDiagnostic ? { lastDiagnostic } : {}),
      updatedAt,
    };
  }

  private activeCredentialMode(): "direct" {
    return "direct";
  }

  private request(metadata: Partial<DaemonProviderFactoryMetadata> = {}): ProviderRouteRequest {
    const capabilityRequest = capabilityRequestFromConfig(this.config);
    const modelRouteDecision = routeModelByCapability(
      this.routesForPlanning().map((route) => profileFromDaemonRouteOffer(route)),
      capabilityRequest
    );
    const selectedRouteId = modelRouteDecision.selected?.routeId;
    return {
      model: this.config.model,
      accountId: this.config.accountId,
      routeId: selectedRouteId,
      materializeProvider: true,
      capabilityRequest,
      modelRouteDecision,
      metadata: {
        daemon: true,
        ...(metadata.runId ? { runId: metadata.runId } : {}),
        ...(metadata.cwd ? { cwd: metadata.cwd } : {})
      }
    };
  }

  private createGateway(): ProviderGateway {
    return new DefaultProviderGateway({
      routes: this.routesForPlanning()
    });
  }

  private recordPlan(plan: ProviderGatewayPlan): void {
    this.lastPlan = redactProviderGatewayPlan(plan);
    this.lastStatusAt = new Date().toISOString();
    this.lastDiagnostic = plan.ok
      ? undefined
      : {
          code: plan.code ?? "provider_gateway_unavailable",
          message: formatProviderGatewayError(plan),
          updatedAt: this.lastStatusAt,
        };
  }

  private recordReady(): void {
    this.lastStatusAt = new Date().toISOString();
    this.lastDiagnostic = undefined;
  }

  private recordFailure(cause: unknown): void {
    this.lastStatusAt = new Date().toISOString();
    this.lastDiagnostic = toProviderDiagnostic(cause, this.lastStatusAt);
  }

  private createRoute(): ProviderRouteOffer {
    const credentialSource = this.activeCredentialMode() === "direct"
      ? {
          type: "api-key" as const,
          apiKey: this.config.apiKey ?? "",
          providerId: this.config.providerId,
          baseUrl: this.config.baseUrl,
          headers: cloneHeaders(this.config.headers)
        }
      : {
          type: "account" as const,
          accountId: this.config.accountId,
          providerId: this.config.providerId,
          keyClass: "external" as const
        };

    return {
      id: this.config.routeId,
      model: this.config.model,
      aliases: [this.config.upstreamModel].filter((value) => value && value !== this.config.model) as string[],
      providerId: this.config.providerId,
      upstreamModel: this.config.upstreamModel,
      endpointType: this.config.endpoint,
      endpointSupport: this.config.endpoint,
      streamingSupport: streamingSupportFromConfig(this.config),
      priority: 100,
      credentialSource,
      providerOptions: providerOptionsMetadata(this.config),
      providerFactory: (plan) => createOpenAICompatibleProviderFromPlan(plan, this.config)
    };
  }

  private routesForPlanning(): ProviderRouteOffer[] {
    if (typeof this.options.routes === "function") return this.options.routes().map((route) => this.routeWithDefaultFactory(route));
    if (this.options.routes) return this.options.routes.map((route) => this.routeWithDefaultFactory(route));
    return [this.createRoute()];
  }

  private routeWithDefaultFactory(route: ProviderRouteOffer): ProviderRouteOffer {
    if (route.provider || route.providerFactory) return route;
    return {
      ...route,
      providerOptions: route.providerOptions ?? providerOptionsMetadata(this.config),
      providerFactory: (plan) => createOpenAICompatibleProviderFromPlan(plan, this.config),
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
    controller.createProvider({ runId, cwd })) as DaemonProviderFactoryWithStatus;
  factory.getProviderStatusSnapshot = () => controller.getStatusSnapshot();
  return factory;
}

export function createDaemonProviderRuntimeConfigFromEnv(
  env: Record<string, string | undefined>,
  defaults: Pick<DaemonProviderRuntimeConfig, "baseUrl" | "model"> & Partial<DaemonProviderRuntimeConfig>
): DaemonProviderRuntimeConfig {
  return createDaemonProviderRuntimeConfig({
    defaults,
    env,
  });
}

export function createDaemonProviderRuntimeConfig(
  sources: DaemonProviderRuntimeConfigSources
): DaemonProviderRuntimeConfig {
  const layers = providerConfigLayers(sources);

  // 通过 ConfigMerger 合并所有层（使用 PROVIDER_CONFIG_SCHEMA 定义的合并策略和校验规则）
  const { config: baseConfig, validation } = providerConfigMerger.mergeAndValidate(
    layers.map((layer) => ({
      name: layer.source,
      priority: layerPriority(layer.source),
      config: layer.config as Record<string, unknown>,
    }))
  );

  // 记录校验失败（不阻断，仅产生诊断信息）
  logProviderConfigValidation(validation);

  // 对需要特殊解析的字段手动处理（多环境变量名映射、credential mode 推理等）
  const apiKey = resolveApiKey(layers);
  const credentialMode = resolveCredentialMode(layers);

  return normalizeConfig({
    ...baseConfig,
    credentialMode: credentialMode ?? (baseConfig.credentialMode as DaemonProviderCredentialMode) ?? "auto",
    apiKey: apiKey.value ?? baseConfig.apiKey as string | undefined,
    apiKeySource: apiKey.value ? apiKey.source : (baseConfig.apiKeySource as DaemonProviderApiKeySource),
    accountId: (resolveOptionalStringConfig(layers, "accountId") ?? baseConfig.accountId) as string | undefined,
    baseUrl: (resolveRequiredStringConfig(layers, "baseUrl") ?? baseConfig.baseUrl) as string,
    model: (resolveRequiredStringConfig(layers, "model") ?? baseConfig.model) as string,
    providerId: (resolveOptionalStringConfig(layers, "providerId") ?? baseConfig.providerId) as string | undefined,
    routeId: (resolveOptionalStringConfig(layers, "routeId") ?? baseConfig.routeId) as string | undefined,
    upstreamModel: (resolveOptionalStringConfig(layers, "upstreamModel") ?? baseConfig.upstreamModel) as string | undefined,
    endpoint: (resolveEndpointConfig(layers) ?? baseConfig.endpoint) as OpenAICompatibleEndpoint,
    stream: (resolveBooleanConfig(layers, "stream") ?? baseConfig.stream) as boolean | undefined,
  });
}

/**
 * 将来源名称映射到 CONFIG_PRIORITY 数值。
 */
function layerPriority(source: DaemonProviderRuntimeConfigSourceName): ConfigSourcePriority {
  switch (source) {
    case "default": return 0 as const;
    case "workspace-config": return 100 as const;
    case "user-config": return 200 as const;
    case "env": return 300 as const;
    case "runtime-update": return 500 as const;
    default: return 0 as const;
  }
}

/**
 * 记录 ConfigMerger 校验结果（日志输出，不阻断配置应用）。
 */
function logProviderConfigValidation(result: ConfigValidationResult): void {
  if (result.errors.length === 0) return;
  const errorMessages = result.errors
    .map((e) => `  [${e.path}] ${e.message}` + (e.received !== undefined ? ` (received: ${JSON.stringify(e.received)})` : ""))
    .join("\n");
  console.warn(`[daemon-provider-gateway] Provider config validation warnings:\n${errorMessages}`);
}

function createOpenAICompatibleProviderFromPlan(
  plan: ProviderFactoryPlan,
  config: NormalizedDaemonProviderRuntimeConfig
): OpenAICompatibleProvider {
  const options: OpenAICompatibleProviderOptions = {
    id: plan.route.providerId,
    baseUrl: plan.credential.baseUrl ?? config.baseUrl,
    apiKey: plan.credential.apiKey,
    model: plan.route.upstreamModel,
    endpoint: endpointFromSelectedRoute(plan.route.endpointSupport, config.endpoint),
    authHeader: config.authHeader,
    maxTokensField: config.maxTokensField,
    stream: config.stream,
    diagnostics: config.diagnostics,
    transport: config.transport,
    systemPromptWireMode: config.systemPromptWireMode,
    requestTimeoutMs: config.requestTimeoutMs,
    firstByteTimeoutMs: config.firstByteTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    headers: {
      ...cloneHeaders(config.headers),
      ...cloneHeaders(plan.credential.headers)
    }
  };
  if (config.maxTokens !== undefined) options.maxTokens = config.maxTokens;
  return new OpenAICompatibleProvider(options);
}

function endpointFromSelectedRoute(
  routeEndpointSupport: ProviderEndpointSupport | undefined,
  configuredEndpoint: OpenAICompatibleEndpoint
): OpenAICompatibleEndpoint {
  if (configuredEndpoint !== "auto") return configuredEndpoint;
  if (routeEndpointSupport === "responses" || routeEndpointSupport === "chat-completions") return routeEndpointSupport;
  return configuredEndpoint;
}

function providerOptionsMetadata(config: NormalizedDaemonProviderRuntimeConfig): JsonObject {
  return removeUndefinedJsonFields({
    endpoint: config.endpoint,
    authHeader: config.authHeader,
    maxTokensField: config.maxTokensField,
    maxTokens: config.maxTokens,
    stream: config.stream,
    diagnostics: config.diagnostics,
    transport: config.transport,
    systemPromptWireMode: config.systemPromptWireMode
  });
}

function capabilityRequestFromConfig(config: Pick<NormalizedDaemonProviderRuntimeConfig, "endpoint" | "stream">): TaskCapabilityRequest {
  return {
    requiredEndpointSupport: endpointRequirementFromConfig(config.endpoint),
    requiredStreamingSupport: [streamingSupportFromConfig(config)]
  };
}

function endpointRequirementFromConfig(endpoint: OpenAICompatibleEndpoint): ProviderEndpointSupport[] {
  return [endpoint];
}

function profileFromDaemonRouteOffer(route: ProviderRouteOffer) {
  return profileFromProviderRouteOffer({
    ...route,
    credentialSource: route.credentialSource as unknown as JsonObject
  });
}

function streamingSupportFromConfig(config: Pick<NormalizedDaemonProviderRuntimeConfig, "stream">): ProviderStreamingSupport {
  return config.stream ? "streaming" : "non-streaming";
}

function credentialSourceSnapshot(plan: ProviderGatewayPlan | undefined): JsonObject | undefined {
  return plan?.selectedRoute?.credentialSource as JsonObject | undefined;
}

function formatProviderGatewayError(plan: ProviderGatewayPlan): string {
  const selected = plan.selectedRoute ? ` selectedRoute=${plan.selectedRoute.routeId}` : "";
  return `Provider gateway failed: ${plan.code ?? "unknown"} model=${plan.requestedModel}${selected} decision=${plan.routeDecision.join(" > ")}`;
}

function definedConfigUpdate(update: DaemonProviderRuntimeConfigUpdate): Partial<DaemonProviderRuntimeConfig> {
  const next: Partial<DaemonProviderRuntimeConfig> = {};
  if (update.credentialMode !== undefined) {
    next.credentialMode = update.credentialMode;
  }
  if (update.apiKey !== undefined) {
    next.apiKey = update.apiKey;
    next.apiKeySource = nonEmpty(update.apiKey) ? "runtime-update" : "unset";
  }
  if (update.accountId !== undefined) next.accountId = update.accountId;
  if (update.baseUrl !== undefined) next.baseUrl = update.baseUrl;
  if (update.model !== undefined) next.model = update.model;
  if (update.endpoint !== undefined) next.endpoint = update.endpoint;
  if (update.stream !== undefined) next.stream = update.stream;
  if (update.systemPromptWireMode !== undefined) next.systemPromptWireMode = update.systemPromptWireMode;
  return next;
}

interface NormalizedDaemonProviderRuntimeConfig extends Required<
  Pick<
    DaemonProviderRuntimeConfig,
    | "credentialMode"
    | "baseUrl"
    | "model"
    | "providerId"
    | "routeId"
    | "upstreamModel"
    | "endpoint"
    | "authHeader"
    | "stream"
    | "diagnostics"
    | "transport"
    | "systemPromptWireMode"
    | "requestTimeoutMs"
    | "firstByteTimeoutMs"
  >
> {
  apiKey?: string;
  apiKeySource: DaemonProviderApiKeySource;
  accountId?: string;
  maxTokensField?: OpenAICompatibleMaxTokensField;
  maxTokens?: number;
  streamIdleTimeoutMs?: number;
  headers?: Record<string, string>;
}

function normalizeConfig(config: DaemonProviderRuntimeConfig): NormalizedDaemonProviderRuntimeConfig {
  const baseUrl = requireNonEmpty(config.baseUrl, "baseUrl");
  const model = requireNonEmpty(config.model, "model");
  const providerId = nonEmpty(config.providerId) ?? DEFAULT_PROVIDER_ID;
  const apiKey = nonEmpty(config.apiKey);
  const credentialMode = normalizeCredentialMode(config.credentialMode) ?? "auto";
  return {
    credentialMode,
    apiKey,
    apiKeySource: apiKey ? config.apiKeySource ?? "unknown" : "unset",
    accountId: nonEmpty(config.accountId),
    baseUrl,
    model,
    providerId,
    routeId: nonEmpty(config.routeId) ?? `${DEFAULT_ROUTE_ID}:${providerId}:${model}`,
    upstreamModel: nonEmpty(config.upstreamModel) ?? model,
    endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
    authHeader: config.authHeader ?? DEFAULT_AUTH_HEADER,
    maxTokensField: config.maxTokensField,
    maxTokens: positiveInteger(config.maxTokens),
    stream: config.stream ?? true,
    diagnostics: config.diagnostics ?? true,
    transport: config.transport ?? "auto",
    systemPromptWireMode: normalizeSystemPromptWireMode(config.systemPromptWireMode) ?? defaultSystemPromptWireMode({ baseUrl, credentialMode }),
    requestTimeoutMs: positiveInteger(config.requestTimeoutMs) ?? DEFAULT_REQUEST_TIMEOUT_MS,
    firstByteTimeoutMs: positiveInteger(config.firstByteTimeoutMs) ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    streamIdleTimeoutMs: positiveInteger(config.streamIdleTimeoutMs),
    headers: cloneHeaders(config.headers)
  };
}

function isProviderFactoryPlan(value: AgentProvider | ProviderFactoryPlan): value is ProviderFactoryPlan {
  return typeof value === "object" && value !== null && "kind" in value && (value as ProviderFactoryPlan).kind === "provider-factory-plan";
}

function cloneHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  return headers ? { ...headers } : undefined;
}

type DaemonProviderRuntimeConfigSourceName = typeof DAEMON_PROVIDER_CONFIG_PRECEDENCE[number];

interface ProviderConfigLayer {
  source: DaemonProviderRuntimeConfigSourceName;
  config: Partial<DaemonProviderRuntimeConfig>;
}

function providerConfigLayers(sources: DaemonProviderRuntimeConfigSources): ProviderConfigLayer[] {
  // 层叠顺序与 CONFIG_PRIORITY 一致：
  // DEFAULT(0) < WORKSPACE(100) < USER(200) < ENV(300) < RUNTIME(500)
  return [
    { source: "default", config: sources.defaults },
    { source: "workspace-config", config: sources.workspaceConfig ?? {} },
    { source: "user-config", config: sources.userConfig ?? {} },
    { source: "env", config: providerRuntimeConfigFromEnv(sources.env ?? {}) },
    { source: "runtime-update", config: sources.runtimeConfig ?? {} },
  ];
}

function providerRuntimeConfigFromEnv(env: Record<string, string | undefined>): Partial<DaemonProviderRuntimeConfig> {
  const apiKey = firstNonEmpty(env.CRISH_API_KEY, env.FLOWBIT_API_KEY, env.OPENAI_API_KEY);
  const credentialMode = normalizeCredentialMode(
    firstNonEmpty(
      env.CRISH_CREDENTIAL_MODE,
      env.FLOWBIT_CREDENTIAL_MODE,
      env.OPENAI_CREDENTIAL_MODE,
      env.CRISH_PROVIDER_CREDENTIAL_MODE,
      env.FLOWBIT_PROVIDER_CREDENTIAL_MODE
    )
  );
  return {
    ...(credentialMode ? { credentialMode } : {}),
    ...(apiKey ? { apiKey } : {}),
    apiKeySource: normalizeApiKeySource(firstNonEmpty(env.CRISH_API_KEY_SOURCE, env.FLOWBIT_API_KEY_SOURCE)),
    accountId: firstNonEmpty(env.CRISH_ACCOUNT_ID, env.FLOWBIT_ACCOUNT_ID),
    baseUrl: firstNonEmpty(env.CRISH_API_BASE_URL, env.FLOWBIT_API_BASE_URL, env.OPENAI_BASE_URL),
    model: firstNonEmpty(env.CRISH_MODEL, env.FLOWBIT_MODEL, env.OPENAI_MODEL),
    providerId: firstNonEmpty(env.CRISH_PROVIDER_ID, env.FLOWBIT_PROVIDER_ID),
    endpoint: normalizeEndpoint(firstNonEmpty(env.CRISH_PROVIDER_ENDPOINT, env.FLOWBIT_PROVIDER_ENDPOINT, env.OPENAI_PROVIDER_ENDPOINT)),
    stream: normalizeBoolean(firstNonEmpty(env.CRISH_PROVIDER_STREAM, env.FLOWBIT_PROVIDER_STREAM, env.OPENAI_PROVIDER_STREAM)),
    systemPromptWireMode: normalizeSystemPromptWireMode(
      firstNonEmpty(env.CRISH_SYSTEM_PROMPT_WIRE_MODE, env.FLOWBIT_SYSTEM_PROMPT_WIRE_MODE, env.OPENAI_SYSTEM_PROMPT_WIRE_MODE)
    ),
  };
}

function resolveApiKey(layers: ProviderConfigLayer[]): { value?: string; source: DaemonProviderApiKeySource } {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!hasOwnConfigValue(layer.config, "apiKey")) continue;
    const value = nonEmpty(layer.config.apiKey);
    return value ? { value, source: layer.config.apiKeySource ?? layer.source } : { source: "unset" };
  }
  return { source: "unset" };
}

function resolveCredentialMode(layers: ProviderConfigLayer[]): DaemonProviderCredentialMode | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!hasOwnConfigValue(layer.config, "credentialMode")) continue;
    const credentialMode = normalizeCredentialMode(layer.config.credentialMode);
    if (credentialMode) return credentialMode;
  }
  return undefined;
}

function resolveRequiredStringConfig(
  layers: ProviderConfigLayer[],
  key: "baseUrl" | "model"
): string | undefined {
  return resolveOptionalStringConfig(layers, key);
}

function resolveOptionalStringConfig(
  layers: ProviderConfigLayer[],
  key: "accountId" | "baseUrl" | "model" | "providerId" | "routeId" | "upstreamModel"
): string | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    const value = nonEmpty(layers[i].config[key]);
    if (value) return value;
  }
  return undefined;
}

function resolveEndpointConfig(layers: ProviderConfigLayer[]): OpenAICompatibleEndpoint | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!hasOwnConfigValue(layer.config, "endpoint")) continue;
    const endpoint = normalizeEndpoint(layer.config.endpoint);
    if (endpoint) return endpoint;
  }
  return undefined;
}

function resolveBooleanConfig(
  layers: ProviderConfigLayer[],
  key: "stream"
): boolean | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!hasOwnConfigValue(layer.config, key)) continue;
    const value = normalizeBoolean(layer.config[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function hasOwnConfigValue<K extends keyof DaemonProviderRuntimeConfig>(
  config: Partial<DaemonProviderRuntimeConfig>,
  key: K
): boolean {
  return Object.prototype.hasOwnProperty.call(config, key);
}

function removeUndefinedJsonFields(input: Record<string, JsonObject[keyof JsonObject] | undefined>): JsonObject {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, JsonObject[keyof JsonObject]] => entry[1] !== undefined));
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = nonEmpty(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCredentialMode(value: string | undefined): DaemonProviderCredentialMode | undefined {
  const normalized = nonEmpty(value);
  if (normalized === "direct" || normalized === "auto") return normalized;
  return undefined;
}

function normalizeEndpoint(value: string | undefined): OpenAICompatibleEndpoint | undefined {
  const normalized = nonEmpty(value)?.toLowerCase().replace(/_/g, "-").replace(/\//g, "-");
  if (normalized === "auto" || normalized === "responses" || normalized === "chat-completions") return normalized;
  if (normalized === "chat") return "chat-completions";
  if (normalized === "response") return "responses";
  return undefined;
}

function normalizeSystemPromptWireMode(value: string | undefined): SystemPromptWireMode | undefined {
  const normalized = nonEmpty(value)?.toLowerCase().replace(/_/g, "-").replace(/\//g, "-");
  if (normalized === "native" || normalized === "native-system-role" || normalized === "system") return "native-system-role";
  if (normalized === "user" || normalized === "user-prefix" || normalized === "prefix") return "user-prefix";
  return undefined;
}

function defaultSystemPromptWireMode(config: {
  baseUrl: string;
  credentialMode: DaemonProviderCredentialMode;
}): SystemPromptWireMode {
  return isOfficialOpenAIBaseUrl(config.baseUrl) ? "native-system-role" : "user-prefix";
}

function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com";
  } catch {
    return false;
  }
}

function normalizeBoolean(value: string | boolean | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  const normalized = nonEmpty(value)?.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  return undefined;
}

function normalizeApiKeySource(value: string | undefined): DaemonProviderApiKeySource | undefined {
  const normalized = nonEmpty(value);
  if (
    normalized === "default" ||
    normalized === "env" ||
    normalized === "runtime-update" ||
    normalized === "user-config" ||
    normalized === "workspace-config" ||
    normalized === "unset" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  return undefined;
}

function redactedApiKeyStatus(config: NormalizedDaemonProviderRuntimeConfig): DaemonProviderRedactedApiKeyStatus {
  return {
    hasApiKey: Boolean(config.apiKey),
    source: config.apiKeySource,
    ...(config.apiKey ? { last4: config.apiKey.slice(-4) } : {}),
  };
}

function requireNonEmpty(value: string | undefined, field: string): string {
  const normalized = nonEmpty(value);
  if (!normalized) throw new Error(`Daemon provider ${field} is required.`);
  return normalized;
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function providerPlanMetadata(plan: ProviderGatewayPlan): JsonObject {
  return {
    ok: plan.ok,
    code: plan.code ?? null,
    requestedModel: plan.requestedModel,
    selectedRoute: plan.selectedRoute ? (plan.selectedRoute as unknown as JsonObject) : null,
    credentialConfigured: plan.credentialConfigured,
    candidateCount: plan.candidateCount,
    availableCandidateCount: plan.availableCandidateCount,
    cooldownCandidateCount: plan.cooldownCandidateCount,
    fallbackUsed: plan.fallbackUsed,
    routeDecision: plan.routeDecision
  };
}

interface DaemonProviderFactoryWithStatus {
  (runId: string, cwd: string): Promise<AgentProvider>;
  getProviderStatusSnapshot(): DaemonProviderStatusSnapshot;
}

function resolveReadiness(input: {
  credentialMode: "direct";
  hasDirectApiKey: boolean;
  lastDiagnostic?: DaemonProviderDiagnostic;
}): DaemonProviderReadiness {
  if (input.credentialMode === "direct") {
    return input.hasDirectApiKey ? "ready" : "missing";
  }
  return "unknown";
}

function redactProviderGatewayPlan(plan: ProviderGatewayPlan): ProviderGatewayPlan {
  const { credential, providerPlan, ...safePlan } = plan;
  void credential;
  void providerPlan;
  return safePlan;
}

function toProviderDiagnostic(cause: unknown, updatedAt: string): DaemonProviderDiagnostic {
  if (cause instanceof ProviderGatewayError) {
    return {
      code: cause.code,
      message: formatProviderGatewayError(cause.plan),
      updatedAt,
    };
  }

  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code: "provider_gateway_unavailable",
    message: message || "Provider gateway is unavailable.",
    updatedAt,
  };
}
