import { ProviderGatewayError } from "@crish/agent-runtime";
import type { ProviderGatewayPlan } from "@crish/agent-runtime";
import type { JsonObject } from "@crish/shared-types";
import { toJsonObject } from "@crish/shared-utils";
import type {
  DaemonProviderDiagnostic,
  DaemonProviderReadiness,
  DaemonProviderRedactedApiKeyStatus,
} from '../types.js';
import type { NormalizedDaemonProviderRuntimeConfig } from "./types.js";

export function formatProviderGatewayError(plan: ProviderGatewayPlan): string {
  const selected = plan.selectedRoute
    ? ` selectedRoute=${plan.selectedRoute.routeId}`
    : '';
  return `Provider gateway failed: ${plan.code ?? 'unknown'} model=${plan.requestedModel}${selected} decision=${plan.routeDecision.join(' > ')}`;
}

export function resolveReadiness(input: {
  credentialMode: 'direct';
  hasDirectApiKey: boolean;
  lastDiagnostic?: DaemonProviderDiagnostic | undefined;
}): DaemonProviderReadiness {
  if (input.credentialMode === 'direct') {
    return input.hasDirectApiKey ? 'ready' : 'missing';
  }
  return 'unknown';
}

export function redactedApiKeyStatus(
  config: NormalizedDaemonProviderRuntimeConfig,
  exposureLevel?: string
): DaemonProviderRedactedApiKeyStatus {
  if (!config.apiKey) {
    return { hasApiKey: false, source: config.apiKeySource };
  }
  const level = exposureLevel ?? "last4";
  switch (level) {
    case "none":
      return { hasApiKey: true, source: config.apiKeySource };
    case "full":
      return { hasApiKey: true, source: config.apiKeySource, last4: config.apiKey };
    case "last4":
    default:
      return { hasApiKey: true, source: config.apiKeySource, last4: config.apiKey.slice(-4) };
  }
}

export function credentialSourceSnapshot(
  plan: ProviderGatewayPlan | undefined
): JsonObject | undefined {
  return plan?.selectedRoute?.credentialSource as JsonObject | undefined;
}

export function toProviderDiagnostic(
  cause: unknown,
  updatedAt: string
): DaemonProviderDiagnostic {
  if (cause instanceof ProviderGatewayError) {
    return {
      code: cause.code,
      message: formatProviderGatewayError(cause.plan),
      updatedAt,
    };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code: 'provider_gateway_unavailable',
    message: message || 'Provider gateway is unavailable.',
    updatedAt,
  };
}

export function providerPlanMetadata(plan: ProviderGatewayPlan): JsonObject {
  return {
    ok: plan.ok,
    code: plan.code ?? null,
    requestedModel: plan.requestedModel,
    selectedRoute: plan.selectedRoute ? toJsonObject(plan.selectedRoute) : null,
    credentialConfigured: plan.credentialConfigured,
    candidateCount: plan.candidateCount,
    availableCandidateCount: plan.availableCandidateCount,
    cooldownCandidateCount: plan.cooldownCandidateCount,
    fallbackUsed: plan.fallbackUsed,
    routeDecision: plan.routeDecision,
  };
}
