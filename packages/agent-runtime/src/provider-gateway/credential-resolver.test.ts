import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { setAllowTestLocalhost } from "../provider/auth/base-url-validator";
import {
  validateApiKey,
  validateCredential,
  normalizeCredentialSource,
  normalizeResolvedCredential,
  cloneStringRecord,
} from "./credential-resolver";
import { ProviderGatewayError, type ResolvedProviderCredential, type ProviderRouteOffer } from "./types";
import type { ProviderRouteRequest } from "./types";

function route(overrides: Partial<ProviderRouteOffer> = {}): ProviderRouteOffer {
  return {
    id: "r1",
    model: "chat",
    providerId: "p1",
    credentialSource: { type: "api-key", apiKey: "sk-valid-key-12345" },
    ...overrides,
  };
}

function request(overrides: Partial<ProviderRouteRequest> = {}): ProviderRouteRequest {
  return { model: "chat", ...overrides };
}

describe("validateApiKey", () => {
  it("returns null for a valid key", () => {
    expect(validateApiKey("sk-valid-key-1234567890")).toBeNull();
  });

  it("returns null when key is 16 characters exactly", () => {
    expect(validateApiKey("a".repeat(16))).toBeNull();
  });

  it("returns null for undefined or empty key", () => {
    expect(validateApiKey(undefined)).toBeNull();
    expect(validateApiKey("")).toBeNull();
  });

  it("rejects key with leading whitespace", () => {
    const error = validateApiKey("  sk-key-1234567890");
    expect(error).toContain("whitespace");
  });

  it("rejects key with trailing whitespace", () => {
    const error = validateApiKey("sk-key-1234567890  ");
    expect(error).toContain("whitespace");
  });

  it("rejects key shorter than 16 characters", () => {
    const error = validateApiKey("short");
    expect(error).toContain("16 characters");
  });
});

describe("validateCredential", () => {
  function cred(overrides: Partial<ResolvedProviderCredential> = {}): ResolvedProviderCredential {
    return {
      id: "cred-1",
      source: "api-key",
      providerId: "p1",
      apiKey: "sk-valid-credential-key-12345",
      ...overrides,
    };
  }

  it("passes for a valid credential", () => {
    expect(() => validateCredential(cred())).not.toThrow();
  });

  describe("validateCredential SSRF checks", () => {
    beforeEach(() => {
      setAllowTestLocalhost(false);
    });
    afterEach(() => {
      setAllowTestLocalhost(true);
    });

    it("throws ProviderGatewayError with ssrf_rejected for localhost baseUrl", () => {
      expect(() => validateCredential(cred({ baseUrl: "http://localhost:8080" }))).toThrow(ProviderGatewayError);
      try {
        validateCredential(cred({ baseUrl: "http://localhost:8080" }));
      } catch (e) {
        expect((e as ProviderGatewayError).code).toBe("ssrf_rejected");
      }
    });

    it("throws ssrf_rejected for private IP baseUrl", () => {
      expect(() => validateCredential(cred({ baseUrl: "http://192.168.1.1" }))).toThrow(ProviderGatewayError);
      expect(() => validateCredential(cred({ baseUrl: "http://10.0.0.1/api" }))).toThrow(ProviderGatewayError);
      expect(() => validateCredential(cred({ baseUrl: "http://127.0.0.1" }))).toThrow(ProviderGatewayError);
    });

    it("throws ssrf_rejected for metadata service hostname", () => {
      expect(() => validateCredential(cred({ baseUrl: "http://169.254.169.254/latest" }))).toThrow(ProviderGatewayError);
    });
  });

  it("throws provider_credential_missing for invalid apiKey", () => {
    expect(() => validateCredential(cred({ apiKey: "short" }))).toThrow(ProviderGatewayError);
    try {
      validateCredential(cred({ apiKey: "short" }));
    } catch (e) {
      expect((e as ProviderGatewayError).code).toBe("provider_credential_missing");
    }
  });

  it("allows valid https baseUrl", () => {
    expect(() => validateCredential(cred({ baseUrl: "https://api.openai.com/v1" }))).not.toThrow();
  });

  it("allows credential without baseUrl", () => {
    expect(() => validateCredential(cred({}))).not.toThrow();
  });
});

describe("normalizeCredentialSource", () => {
  it("fills in providerId and accountId for account type", () => {
    const source = normalizeCredentialSource(
      { type: "account" },
      route(),
      request({ accountId: "acct_1" }),
    );
    expect(source).toMatchObject({ type: "account", providerId: "p1", accountId: "acct_1" });
  });

  it("preserves explicit accountId when set", () => {
    const source = normalizeCredentialSource(
      { type: "account", accountId: "explicit_acct", providerId: "custom" },
      route(),
      request(),
    );
    expect(source).toMatchObject({ accountId: "explicit_acct", providerId: "custom" });
  });

  it("fills in providerId for api-key type", () => {
    const source = normalizeCredentialSource(
      { type: "api-key", apiKey: "sk-key" },
      route(),
      request(),
    );
    expect(source).toMatchObject({ type: "api-key", providerId: "p1" });
  });

  it("clones headers for api-key type", () => {
    const headers = { Authorization: "Bearer token" };
    const source = normalizeCredentialSource(
      { type: "api-key", apiKey: "sk-key", headers },
      route(),
      request(),
    );
    expect(source).toMatchObject({ headers: { Authorization: "Bearer token" } });
    expect(source).not.toBe(headers);
  });
});

describe("normalizeResolvedCredential", () => {
  const routeOffer = route();
  const apiKeySource = { type: "api-key" as const, apiKey: "sk-key", providerId: "route-p" };

  it("fills missing fields from route and source", () => {
    const result = normalizeResolvedCredential(
      { id: "c1", source: "api-key", providerId: "", apiKey: "key" },
      routeOffer,
      apiKeySource,
    );
    expect(result.source).toBe("api-key");
    expect(result.providerId).toBe("route-p");
  });

  it("preserves existing providerId", () => {
    const result = normalizeResolvedCredential(
      { id: "c1", source: "api-key", providerId: "explicit", apiKey: "key" },
      routeOffer,
      apiKeySource,
    );
    expect(result.providerId).toBe("explicit");
  });

  it("clones headers", () => {
    const headers = { "x-custom": "value" };
    const result = normalizeResolvedCredential(
      { id: "c1", source: "api-key", providerId: "p", apiKey: "key", headers },
      routeOffer,
      apiKeySource,
    );
    expect(result.headers).toEqual(headers);
    expect(result.headers).not.toBe(headers);
  });
});

describe("cloneStringRecord", () => {
  it("returns undefined for undefined input", () => {
    expect(cloneStringRecord(undefined)).toBeUndefined();
  });

  it("clones a record", () => {
    const original = { a: "1", b: "2" };
    const cloned = cloneStringRecord(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
  });
});
