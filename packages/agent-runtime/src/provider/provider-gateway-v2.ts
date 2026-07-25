import { ProviderRegistryV2Impl, type ProviderRegistryV2 } from "./registry-v2";
import { DeclarativeLoader } from "./loader";
import { validateBaseUrl } from "./auth/base-url-validator";
import { authMethodToCredentialSource } from "./auth/auth-method-bridge";
import { CredentialResolver } from "./auth/credential-resolver";
import { createSecret, type AuthMethod } from "./auth/types";
import type { AgentProviderFactory, ProviderFactoryPlan, ProviderGatewayPlan, ProviderGatewayPlanCode } from "../provider-gateway";
import { ProviderGatewayError } from "../provider-gateway";
import type { SecretStore } from "./auth/secret-store";

function validateApiKey(apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  if (apiKey !== apiKey.trim()) {
    return 'API Key must not have leading or trailing whitespace';
  }
  if (apiKey.length < 16) {
    return 'API Key must be at least 16 characters long';
  }
  return null;
}

function failurePlan(code: ProviderGatewayPlanCode, message: string): ProviderGatewayPlan {
  return {
    ok: false,
    code,
    requestedModel: "",
    credentialConfigured: false,
    candidateCount: 0,
    availableCandidateCount: 0,
    cooldownCandidateCount: 0,
    fallbackUsed: false,
    routeDecision: [message],
  };
}

export class GatewayV2Bridge {
  private registry: ProviderRegistryV2;
  private loader: DeclarativeLoader | null = null;
  private secretStore: SecretStore | undefined;

  constructor(registry?: ProviderRegistryV2, secretStore?: SecretStore) {
    this.registry = registry ?? new ProviderRegistryV2Impl();
    this.secretStore = secretStore;
  }

  loadProvidersFromDirectory(directory: string): void {
    this.loader?.stop();
    this.loader = new DeclarativeLoader(this.registry, directory);
    this.loader.start();
  }

  getProviderFactory(): AgentProviderFactory {
    return async (plan: ProviderFactoryPlan) => {
      const providerId = plan?.route?.providerId ?? (plan as any)?.provider;
      if (!providerId) throw new ProviderGatewayError("route_not_found", failurePlan("route_not_found", "No providerId in plan"));

      let resolvedApiKey = plan?.credential?.apiKey;
      let resolvedBaseUrl = plan?.credential?.baseUrl;
      let resolvedHeaders = plan?.credential?.headers;

      if (!resolvedApiKey && plan?.credential?.metadata?.authMethod) {
        const bridged = authMethodToCredentialSource(plan.credential.metadata.authMethod as AuthMethod);
        resolvedApiKey = bridged.apiKey ?? resolvedApiKey;
        resolvedBaseUrl = bridged.baseUrl ?? resolvedBaseUrl;
        resolvedHeaders = bridged.headers ?? resolvedHeaders;
      }

      const credentialResolver = new CredentialResolver({
        ...(resolvedApiKey ? { directKey: createSecret(resolvedApiKey) } : {}),
        ...(this.secretStore !== undefined ? { secretStore: this.secretStore } : {}),
      });
      const resolved = await credentialResolver.resolve(providerId);
      const apiKey = resolved?.key ?? resolvedApiKey;

      const apiKeyError = validateApiKey(apiKey);
      if (apiKeyError) {
        throw new ProviderGatewayError("provider_credential_missing", failurePlan("provider_credential_missing", apiKeyError));
      }

      const baseUrl = resolvedBaseUrl;
      if (baseUrl) {
        const urlCheck = validateBaseUrl(baseUrl);
        if (!urlCheck.valid) throw new ProviderGatewayError("ssrf_rejected", failurePlan("ssrf_rejected", urlCheck.error ?? "SSRF validation failed"));
      }

      return this.registry.createProvider(providerId, {
        type: "api-key",
        apiKey: apiKey ?? "",
        ...(resolvedBaseUrl !== undefined ? { baseUrl: resolvedBaseUrl } : {}),
        ...(resolvedHeaders !== undefined ? { headers: resolvedHeaders } : {}),
      } as const as any);
    };
  }

  registerBuiltinProviders(): void {
    const builtinDir = require("path").join(__dirname, "builtin", "providers");
    this.loadProvidersFromDirectory(builtinDir);
  }

  getRegistry(): ProviderRegistryV2 { return this.registry; }
  getSecretStore(): SecretStore | undefined { return this.secretStore; }
  dispose(): void { this.loader?.stop(); }
}
