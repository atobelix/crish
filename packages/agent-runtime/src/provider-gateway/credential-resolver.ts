import { validateBaseUrl } from "../provider/auth/base-url-validator";
import type { ProviderCredentialSource, ProviderRouteOffer, ProviderRouteRequest, ResolvedProviderCredential } from "./types";
import { ProviderGatewayError } from "./types";

export function normalizeCredentialSource(source: ProviderCredentialSource, route: ProviderRouteOffer, request: ProviderRouteRequest): ProviderCredentialSource {
  if (source.type === "account") {
    return {
      type: "account",
      providerId: source.providerId ?? route.providerId,
      ...(source.accountId !== undefined ? { accountId: source.accountId } : request.accountId !== undefined ? { accountId: request.accountId } : {}),
      ...(source.keyClass !== undefined ? { keyClass: source.keyClass } : {}),
      ...(source.credentialId !== undefined ? { credentialId: source.credentialId } : {}),
      ...(source.metadata !== undefined ? { metadata: source.metadata } : {})
    };
  }
  const clonedHeaders = cloneStringRecord(source.headers);
  return {
    type: "api-key",
    apiKey: source.apiKey,
    providerId: source.providerId ?? route.providerId,
    ...(clonedHeaders !== undefined ? { headers: clonedHeaders } : {}),
    ...(source.credentialId !== undefined ? { credentialId: source.credentialId } : {}),
    ...(source.baseUrl !== undefined ? { baseUrl: source.baseUrl } : {}),
    ...(source.metadata !== undefined ? { metadata: source.metadata } : {})
  };
}

export function normalizeResolvedCredential(
  credential: ResolvedProviderCredential,
  route: ProviderRouteOffer,
  source: ProviderCredentialSource
): ResolvedProviderCredential {
  const clonedCredHeaders = cloneStringRecord(credential.headers);
  return {
    id: credential.id,
    source: credential.source ?? source.type,
    providerId: credential.providerId || source.providerId || route.providerId,
    ...(clonedCredHeaders !== undefined ? { headers: clonedCredHeaders } : {}),
    ...(credential.accountId !== undefined ? { accountId: credential.accountId } : source.type === "account" && source.accountId !== undefined ? { accountId: source.accountId } : {}),
    ...(credential.apiKey !== undefined ? { apiKey: credential.apiKey } : {}),
    ...(credential.baseUrl !== undefined ? { baseUrl: credential.baseUrl } : {}),
    ...(credential.metadata !== undefined ? { metadata: credential.metadata } : {})
  };
}

export function validateApiKey(apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  if (apiKey !== apiKey.trim()) {
    return 'API Key must not have leading or trailing whitespace';
  }
  if (apiKey.length < 16) {
    return 'API Key must be at least 16 characters long';
  }
  return null;
}

export function validateCredential(credential: ResolvedProviderCredential): void {
  if (credential.baseUrl) {
    const validation = validateBaseUrl(credential.baseUrl);
    if (!validation.valid) {
      throw new ProviderGatewayError("ssrf_rejected", {
        ok: false,
        code: "ssrf_rejected",
        requestedModel: "",
        candidateCount: 0,
        availableCandidateCount: 0,
        cooldownCandidateCount: 0,
        fallbackUsed: false,
        routeDecision: [`ssrf_rejected:${validation.error}`],
        credentialConfigured: false
      });
    }
  }

  const apiKeyError = validateApiKey(credential.apiKey);
  if (apiKeyError) {
    throw new ProviderGatewayError("provider_credential_missing", {
      ok: false,
      code: "provider_credential_missing",
      requestedModel: "",
      candidateCount: 0,
      availableCandidateCount: 0,
      cooldownCandidateCount: 0,
      fallbackUsed: false,
      routeDecision: [`credential_invalid:${apiKeyError}`],
      credentialConfigured: false
    });
  }
}

export function cloneStringRecord(value: Record<string, string> | undefined): Record<string, string> | undefined {
  return value ? { ...value } : undefined;
}
