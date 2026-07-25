import {
  createAnthropicProviderFromPlan,
  createGeminiProviderFromPlan,
  OpenAICompatibleProvider,
  type AgentProvider,
  type OpenAICompatibleEndpoint,
  type OpenAICompatibleProviderOptions,
  type ProviderEndpointSupport,
  type ProviderFactoryPlan,
  type ProviderGatewayPlan,
  type ProviderRouteOffer,
  type ProviderStreamingSupport,
  stringField,
  profileFromProviderRouteOffer,
} from "@crish/agent-runtime";
import type { JsonObject } from "@crish/shared-types";
import { toJsonObject } from "@crish/shared-utils";
import type {
  NormalizedDaemonProviderRuntimeConfig,
} from "./types.js";
import {
  cloneHeaders,
  removeUndefinedJsonFields,
} from "./types.js";

export function createProviderFromPlan(
  plan: ProviderFactoryPlan,
  config: NormalizedDaemonProviderRuntimeConfig
): AgentProvider {
  const baseUrl = plan.credential.baseUrl ?? config.baseUrl;
  const metadata =
    plan.metadata && typeof plan.metadata === 'object'
      ? (plan.metadata as Record<string, unknown>)
      : undefined;
  const providerOptions =
    plan.providerOptions && typeof plan.providerOptions === 'object'
      ? (plan.providerOptions as Record<string, unknown>)
      : undefined;
  const family =
    stringField(metadata?.family) ??
    stringField(providerOptions?.family) ??
    stringField(providerOptions?.providerFamily);

  if (family === "anthropic") {
    return createAnthropicProviderFromPlan(plan, {
      baseUrl,
      apiKey: (plan.credential.apiKey ?? config.apiKey) as string,
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
      ...(config.stream !== undefined ? { stream: config.stream } : {}),
      ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
      headers: {
        ...(cloneHeaders(config.headers) ?? {}),
        ...(cloneHeaders(plan.credential.headers) ?? {}),
      },
    });
  }

  if (family === "gemini") {
    return createGeminiProviderFromPlan(plan, {
      baseUrl,
      apiKey: (plan.credential.apiKey ?? config.apiKey) as string,
      ...(config.maxTokens !== undefined ? { maxOutputTokens: config.maxTokens } : {}),
      ...(config.stream !== undefined ? { stream: config.stream } : {}),
      ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
      headers: {
        ...(cloneHeaders(config.headers) ?? {}),
        ...(cloneHeaders(plan.credential.headers) ?? {}),
      },
    });
  }

  return createOpenAICompatibleProviderFromPlan(plan, config);
}

function createOpenAICompatibleProviderFromPlan(
  plan: ProviderFactoryPlan,
  config: NormalizedDaemonProviderRuntimeConfig
): OpenAICompatibleProvider {
  const options: OpenAICompatibleProviderOptions = {
    id: plan.route.providerId,
    baseUrl: plan.credential.baseUrl ?? config.baseUrl,
    apiKey: plan.credential.apiKey as string,
    model: plan.route.upstreamModel,
    endpoint: endpointFromSelectedRoute(
      plan.route.endpointSupport,
      config.endpoint!
    ) as OpenAICompatibleEndpoint,
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
      ...(cloneHeaders(config.headers) ?? {}),
      ...(cloneHeaders(plan.credential.headers) ?? {}),
    },
  } as unknown as OpenAICompatibleProviderOptions;
  if (config.maxTokens !== undefined) (options as unknown as Record<string, unknown>).maxTokens = config.maxTokens;
  return new OpenAICompatibleProvider(options);
}

export function isProviderFactoryPlan(
  value: AgentProvider | ProviderFactoryPlan
): value is ProviderFactoryPlan {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as ProviderFactoryPlan).kind === 'provider-factory-plan'
  );
}

export function endpointFromSelectedRoute(
  routeEndpointSupport: ProviderEndpointSupport | undefined,
  configuredEndpoint: OpenAICompatibleEndpoint
): OpenAICompatibleEndpoint {
  if (configuredEndpoint !== 'auto') return configuredEndpoint;
  if (
    routeEndpointSupport === 'responses' ||
    routeEndpointSupport === 'chat-completions'
  )
    return routeEndpointSupport as unknown as OpenAICompatibleEndpoint;
  return configuredEndpoint;
}

export function streamingSupportFromConfig(
  config: Pick<NormalizedDaemonProviderRuntimeConfig, 'stream'>
): ProviderStreamingSupport {
  return config.stream ? 'streaming' : 'non-streaming';
}

export function capabilityRequestFromConfig(
  config: Pick<NormalizedDaemonProviderRuntimeConfig, 'endpoint' | 'stream'>
): import("@crish/agent-runtime").TaskCapabilityRequest {
  return {
    requiredEndpointSupport: [config.endpoint!],
    requiredStreamingSupport: [streamingSupportFromConfig(config)],
  };
}

export function profileFromDaemonRouteOffer(route: ProviderRouteOffer) {
  return profileFromProviderRouteOffer({
    ...route,
    credentialSource: toJsonObject(route.credentialSource)
  });
}

export function providerOptionsMetadata(
  config: NormalizedDaemonProviderRuntimeConfig
): JsonObject {
  return removeUndefinedJsonFields({
    endpoint: config.endpoint,
    authHeader: config.authHeader,
    maxTokensField: config.maxTokensField,
    maxTokens: config.maxTokens,
    stream: config.stream,
    diagnostics: config.diagnostics,
    transport: config.transport,
    systemPromptWireMode: config.systemPromptWireMode,
  });
}

export function redactProviderGatewayPlan(
  plan: ProviderGatewayPlan
): ProviderGatewayPlan {
  const { credential, providerPlan, ...safePlan } = plan;
  void credential;
  void providerPlan;
  return safePlan;
}

export function routeMetadataFromConfig(
  config: NormalizedDaemonProviderRuntimeConfig
): JsonObject {
  const providerId = (config.providerId ?? "").toLowerCase();
  const baseUrl = config.baseUrl.toLowerCase();
  if (
    providerId.includes("anthropic") ||
    providerId.includes("claude") ||
    baseUrl.includes("api.anthropic.com")
  ) {
    return { family: "anthropic" };
  }
  if (
    providerId.includes("gemini") ||
    providerId === "google" ||
    providerId.startsWith("google-") ||
    providerId.includes("google-ai") ||
    baseUrl.includes("generativelanguage.googleapis.com")
  ) {
    return { family: "gemini" };
  }
  return {};
}
