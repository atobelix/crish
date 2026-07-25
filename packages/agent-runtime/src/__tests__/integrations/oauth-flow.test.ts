import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { OAuthFlowManager } from "../../provider/auth/oauth/oauth-flow";

const TEST_OPTIONS = {
  clientId: "test-client",
  authorizeUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  refreshUrl: "https://auth.example.com/refresh",
  scopes: ["openid", "profile", "email"],
  redirectUri: "https://app.example.com/callback",
};

describe("OAuthFlowManager - PKCE startPKCE", () => {
  let manager: OAuthFlowManager;

  beforeEach(() => {
    manager = new OAuthFlowManager(TEST_OPTIONS);
  });

  it("generates a valid authorization URL with all required params", async () => {
    const result = await manager.startPKCE();

    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("test-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/callback");
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("returns a unique state and codeVerifier each call", async () => {
    const r1 = await manager.startPKCE();
    const r2 = await manager.startPKCE();
    expect(r1.state).not.toBe(r2.state);
    expect(r1.codeVerifier).not.toBe(r2.codeVerifier);
    expect((r1 as any).codeChallenge).not.toBeDefined();
  });

  it("produces a base64url-safe code_challenge", async () => {
    const result = await manager.startPKCE();
    const cc = new URL(result.authorizationUrl).searchParams.get("code_challenge")!;
    expect(cc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cc).not.toContain("=");
  });
});

describe("OAuthFlowManager - exchangeCode", () => {
  let manager: OAuthFlowManager;

  beforeEach(() => {
    manager = new OAuthFlowManager(TEST_OPTIONS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exchanges code for tokens on success", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          access_token: "at_valid_123",
          refresh_token: "rt_valid_456",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid profile",
          id_token: "id_token_xyz",
        }),
      text: () => Promise.resolve(""),
    } as Response;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await manager.exchangeCode("auth_code_abc", "verifier_123", "expected_state", "expected_state");

    expect(result.accessToken).toBe("at_valid_123");
    expect(result.refreshToken).toBe("rt_valid_456");
    expect(result.expiresIn).toBe(3600);
    expect(result.tokenType).toBe("Bearer");
    expect(result.scope).toBe("openid profile");
    expect(result.idToken).toBe("id_token_xyz");

    const fetchCall = (fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe("https://auth.example.com/token");
    expect(fetchCall[1].method).toBe("POST");
    const body = new URLSearchParams(fetchCall[1].body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth_code_abc");
    expect(body.get("code_verifier")).toBe("verifier_123");
  });

  it("throws on non-ok response with status text", async () => {
    const mockResponse = {
      ok: false,
      status: 400,
      text: () => Promise.resolve("invalid_grant: code expired"),
    } as Response;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    await expect(manager.exchangeCode("bad_code", "verifier", "expected_state", "expected_state")).rejects.toThrow(
      /400.*invalid_grant/,
    );
  });

  it("throws on state mismatch", async () => {
    await expect(
      manager.exchangeCode("code", "verifier", "expected_state", "wrong_state"),
    ).rejects.toThrow("OAuth state mismatch");
  });

  it("handles network failure gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(manager.exchangeCode("code", "verifier", "expected_state", "expected_state")).rejects.toThrow("ECONNREFUSED");
  });
});

describe("OAuthFlowManager - refreshToken", () => {
  let manager: OAuthFlowManager;

  beforeEach(() => {
    manager = new OAuthFlowManager(TEST_OPTIONS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes token successfully", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          access_token: "at_refreshed_789",
          refresh_token: "rt_rotated_000",
          expires_in: 7200,
          token_type: "Bearer",
        }),
      text: () => Promise.resolve(""),
    } as Response;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await manager.refreshToken("rt_old_token");

    expect(result.accessToken).toBe("at_refreshed_789");
    expect(result.refreshToken).toBe("rt_rotated_000");
    expect(result.expiresIn).toBe(7200);

    const fetchCall = (fetch as any).mock.calls[0];
    const body = new URLSearchParams(fetchCall[1].body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt_old_token");
  });

  it("falls back to tokenUrl when refreshUrl is not set", async () => {
    const { refreshUrl: _omit, ...restOptions } = TEST_OPTIONS;
    const managerNoRefresh = new OAuthFlowManager(restOptions);

    const mockResponse = {
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          access_token: "at_new",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      text: () => Promise.resolve(""),
    } as Response;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));
    await managerNoRefresh.refreshToken("rt_token");
    expect((fetch as any).mock.calls[0][0]).toBe("https://auth.example.com/token");
  });

  it("keeps old refreshToken when server does not return a new one", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          access_token: "at_new",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      text: () => Promise.resolve(""),
    } as Response;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));
    const result = await manager.refreshToken("rt_persistent");
    expect(result.refreshToken).toBe("rt_persistent");
  });

  it("throws on refresh failure", async () => {
    const mockResponse = {
      ok: false,
      status: 401,
      text: () => Promise.resolve("invalid_token"),
    } as Response;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));
    await expect(manager.refreshToken("rt_bad")).rejects.toThrow(/401.*invalid_token/);
  });
});
