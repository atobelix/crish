import { describe, expect, it } from "vitest";
import type { ProviderCredentialResolutionContext } from "@crish/agent-runtime";
import {
  AccountCenterProviderCredentialResolver,
  AccountCenterProviderError,
  type AccountCenterFetch,
  createAccountCenterProviderConfigFromEnv,
  createAccountCenterProviderCredentialResolverFromEnv,
  hasAccountCenterProviderConfig,
  isAccountCenterProviderConfigured
} from "./account-center-provider";

describe("AccountCenterProviderCredentialResolver", () => {
  it("resolves account-backed credentials through account-center with injectable fetch", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock: AccountCenterFetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({
        externalApiKey: "sk-runtime",
        identity: {
          provider: "sub2api",
          externalApiKey: {
            configured: true,
            preview: "****time"
          }
        }
      });
    };
    const resolver = new AccountCenterProviderCredentialResolver({
      accountCenterUrl: " https://accounts.example/api ",
      accountToken: " account-token ",
      accountId: "acct_env",
      fetch: fetchMock
    });

    const credential = await resolver.resolveCredential(accountContext());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://accounts.example/api/billing/runtime-identity/external-key");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer account-token",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ rotate: false });
    expect(credential).toMatchObject({
      id: "account-center:flowbit:acct_1",
      source: "account",
      providerId: "flowbit",
      accountId: "acct_1",
      apiKey: "sk-runtime",
      baseUrl: "https://accounts.example/v1",
      metadata: {
        accountCenter: true,
        accountCenterUrl: "https://accounts.example",
        model: "claude-sonnet-4-20250514",
        keyClass: "external"
      }
    });
  });

  it("accepts future runtime credential payloads with headers and metadata", async () => {
    const resolver = new AccountCenterProviderCredentialResolver({
      accountCenterUrl: "https://accounts.example",
      accountToken: "account-token",
      fetch: async () =>
        jsonResponse({
          credential: {
            id: "cred_1",
            providerId: "account-center",
            accountId: "acct_payload",
            apiKey: "sk-payload",
            baseUrl: "https://gateway.example/v1",
            headers: { "x-flowbit-account": "acct_payload", ignored: 12 },
            metadata: { quota: "account" }
          }
        })
    });

    const credential = await resolver.resolveCredential(accountContext({ accountId: undefined }));

    expect(credential).toMatchObject({
      id: "cred_1",
      providerId: "account-center",
      accountId: "acct_payload",
      apiKey: "sk-payload",
      baseUrl: "https://gateway.example/v1",
      headers: { "x-flowbit-account": "acct_payload" },
      metadata: {
        quota: "account",
        accountCenter: true
      }
    });
  });

  it("does not intercept direct api-key credential sources", async () => {
    let called = false;
    const resolver = new AccountCenterProviderCredentialResolver({
      accountCenterUrl: "https://accounts.example",
      accountToken: "account-token",
      fetch: async () => {
        called = true;
        return jsonResponse({});
      }
    });

    const credential = await resolver.resolveCredential({
      request: { model: "mimo-v2.5" },
      route: {
        id: "direct",
        model: "mimo-v2.5",
        providerId: "flowbit",
        credentialSource: {
          type: "api-key",
          apiKey: "sk-direct"
        }
      },
      credentialSource: {
        type: "api-key",
        apiKey: "sk-direct"
      }
    });

    expect(credential).toBeNull();
    expect(called).toBe(false);
  });

  it("classifies missing account tokens as login-required", async () => {
    const resolver = new AccountCenterProviderCredentialResolver({
      accountCenterUrl: "https://accounts.example",
      fetch: async () => jsonResponse({})
    });

    await expect(resolver.resolveCredential(accountContext())).rejects.toMatchObject({
      name: "AccountCenterProviderError",
      kind: "login-required",
      code: "account_center_login_required"
    });
  });

  it("classifies account-center HTTP failures for daemon display", async () => {
    const cases: Array<{
      status: number;
      body: unknown;
      kind: AccountCenterProviderError["kind"];
      code: AccountCenterProviderError["code"];
    }> = [
      { status: 401, body: { error: "invalid_token" }, kind: "login-required", code: "account_center_login_required" },
      { status: 402, body: { error: "insufficient_balance" }, kind: "insufficient-quota", code: "account_center_insufficient_quota" },
      { status: 503, body: { error: "sub2api_not_configured" }, kind: "gateway-unavailable", code: "account_center_gateway_unavailable" }
    ];

    for (const item of cases) {
      const resolver = new AccountCenterProviderCredentialResolver({
        accountCenterUrl: "https://accounts.example",
        accountToken: "account-token",
        fetch: async () => jsonResponse(item.body, item.status)
      });

      await expect(resolver.resolveCredential(accountContext())).rejects.toMatchObject({
        kind: item.kind,
        code: item.code,
        status: item.status
      });
    }
  });

  it("classifies configured but unrevealed runtime keys as credential-unavailable", async () => {
    const resolver = new AccountCenterProviderCredentialResolver({
      accountCenterUrl: "https://accounts.example",
      accountToken: "account-token",
      fetch: async () =>
        jsonResponse({
          identity: {
            externalApiKey: {
              configured: true,
              preview: "****time"
            }
          }
        })
    });

    await expect(resolver.resolveCredential(accountContext())).rejects.toMatchObject({
      kind: "credential-unavailable",
      code: "account_center_runtime_credential_unavailable",
      metadata: {
        externalRuntimeKeyConfigured: true
      }
    });
  });

  it("exposes sanitized account-center readiness after success and failure", async () => {
    const successful = new AccountCenterProviderCredentialResolver({
      accountCenterUrl: "https://accounts.example",
      accountToken: "account-token",
      accountId: "acct_status",
      fetch: async () =>
        jsonResponse({
          externalApiKey: "sk-runtime",
        })
    });

    await successful.resolveCredential(accountContext({ accountId: "acct_status" }));
    expect(JSON.stringify(successful.getStatusSnapshot())).not.toContain("sk-runtime");
    expect(successful.getStatusSnapshot()).toMatchObject({
      configured: true,
      accountId: "acct_status",
      login: "ready",
      quota: "ready",
      gateway: "ready",
      runtimeCredential: "ready"
    });

    const insufficientQuota = new AccountCenterProviderCredentialResolver({
      accountCenterUrl: "https://accounts.example",
      accountToken: "account-token",
      accountId: "acct_status",
      fetch: async () => jsonResponse({ error: "insufficient_balance" }, 402)
    });

    await expect(insufficientQuota.resolveCredential(accountContext({ accountId: "acct_status" }))).rejects.toMatchObject({
      code: "account_center_insufficient_quota"
    });
    expect(insufficientQuota.getStatusSnapshot()).toMatchObject({
      configured: true,
      accountId: "acct_status",
      login: "ready",
      quota: "insufficient",
      gateway: "ready",
      runtimeCredential: "unavailable",
      lastDiagnostic: {
        code: "account_center_insufficient_quota"
      }
    });
  });
});

describe("account-center provider env config", () => {
  it("parses CRISH and FLOWBIT account-center environment variables", () => {
    const config = createAccountCenterProviderConfigFromEnv(
      {
        FLOWBIT_ACCOUNT_CENTER_URL: " https://flowbit.example ",
        FLOWBIT_ACCOUNT_TOKEN: " flowbit-token ",
        FLOWBIT_ACCOUNT_ID: " acct_flowbit ",
        CRISH_ACCOUNT_TOKEN: " crish-token ",
        FLOWBIT_ACCOUNT_CENTER_TIMEOUT_MS: "30000",
        FLOWBIT_ACCOUNT_CENTER_ROTATE_EXTERNAL_KEY: "true"
      },
      {
        providerId: "flowbit",
        model: "default-model"
      }
    );

    expect(config).toEqual({
      accountCenterUrl: "https://flowbit.example",
      accountToken: "crish-token",
      accountId: "acct_flowbit",
      providerId: "flowbit",
      model: "default-model",
      timeoutMs: 30_000,
      rotateExternalApiKey: true
    });
    expect(hasAccountCenterProviderConfig(config)).toBe(true);
    expect(isAccountCenterProviderConfigured(config)).toBe(true);
  });

  it("creates no resolver when account-center env is absent", () => {
    const resolver = createAccountCenterProviderCredentialResolverFromEnv(
      {},
      {
        providerId: "flowbit",
        model: "default-model"
      }
    );

    expect(resolver).toBeNull();
  });
});

function accountContext(input: { accountId?: string } = {}): ProviderCredentialResolutionContext {
  const accountId = "accountId" in input ? input.accountId : "acct_1";
  return {
    request: {
      model: "claude-sonnet-4-20250514",
      accountId
    },
    route: {
      id: "default:flowbit:claude-sonnet-4-20250514",
      model: "claude-sonnet-4-20250514",
      providerId: "flowbit",
      credentialSource: {
        type: "account",
        accountId,
        providerId: "flowbit",
        keyClass: "external"
      }
    },
    credentialSource: {
      type: "account",
      accountId,
      providerId: "flowbit",
      keyClass: "external"
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}
