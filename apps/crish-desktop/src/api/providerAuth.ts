import { isTauriShell } from "./productMode";
import { invokeCmd } from "./tauriInvoke";
import { getDesktopDaemonClient } from "./daemonClient";

export type AuthFlowState =
  | { stage: "idle" }
  | { stage: "preparing" }
  | { stage: "opening-browser"; url: string }
  | { stage: "waiting" }
  | { stage: "success"; accountId: string; label: string }
  | { stage: "error"; message: string }
  | { stage: "manual-input-needed"; url: string; exchangeCode: (code: string) => Promise<{ accountId: string; label: string } | null> }
  | { stage: "exchanging-code" }
  | { stage: "timeout" };

export interface StartOAuthFlowOptions {
  preferManual?: boolean;
  timeoutMs?: number;
}

export interface AuthFlowCallbacks {
  onStateChange: (state: AuthFlowState) => void;
}

const CHATGPT_OAUTH_CONFIG = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scopes: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "api.connectors.read",
    "api.connectors.invoke",
  ],
} as const;

async function tryOpenUrl(url: string): Promise<boolean> {
  if (isTauriShell()) {
    try {
      const shell: any = await Function(
        'return import("@tauri-apps/plugin-shell")',
      )().catch(() => null);
      if (shell?.open) {
        await shell.open(url);
        return true;
      }
    } catch {
      /* ignore */
    }
    try {
      const ok = await invokeCmd<boolean>("workbench_open_host_target", { target: url })
        .catch(() => invokeCmd<boolean>("open_url", { url }));
      if (ok) return true;
    } catch {
      /* ignore */
    }
    return false;
  }

  const popup = window.open(url, "_blank", "width=800,height=700");
  return popup != null && !popup.closed;
}

interface PKCEContext {
  codeVerifier: string;
  state: string;
  provider: string;
  timeout: ReturnType<typeof setTimeout>;
}

let currentPKCEContext: PKCEContext | null = null;

function clearPKCEContext(): void {
  if (currentPKCEContext) {
    clearTimeout(currentPKCEContext.timeout);
    currentPKCEContext = null;
  }
}

export async function startOAuthFlow(
  callbacks: AuthFlowCallbacks,
  options?: StartOAuthFlowOptions,
): Promise<{ accountId: string; label: string } | null> {
  clearPKCEContext();

  callbacks.onStateChange({ stage: "preparing" });

  const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000;

  return startFlowWithTimeout(callbacks, timeoutMs, options?.preferManual ?? false);
}

async function startFlowWithTimeout(
  callbacks: AuthFlowCallbacks,
  timeoutMs: number,
  preferManual: boolean,
): Promise<{ accountId: string; label: string } | null> {
  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => {
      clearPKCEContext();
      callbacks.onStateChange({ stage: "timeout" });
      resolve(null);
    }, timeoutMs);
  });

  const flowPromise = (async (): Promise<{ accountId: string; label: string } | null> => {
    try {
      if (!preferManual) {
        const daemon = await getDaemonClient();
        if (daemon && daemon.isConnected()) {
          const result = await startOAuthViaDaemon(daemon, callbacks);
          clearPKCEContext();
          return result;
        }
      }
      return await startOAuthLocally(callbacks);
    } catch (err) {
      clearPKCEContext();
      const message = err instanceof Error ? err.message : String(err);
      callbacks.onStateChange({ stage: "error", message });
      return null;
    }
  })();

  return Promise.race([flowPromise, timeoutPromise]);
}

export async function startChatGPTOAuth(
  callbacks: AuthFlowCallbacks,
): Promise<{ accountId: string; label: string } | null> {
  return startOAuthFlow(callbacks, { preferManual: false });
}

async function startOAuthViaDaemon(
  daemon: { request: Function },
  callbacks: AuthFlowCallbacks,
): Promise<{ accountId: string; label: string } | null> {
  callbacks.onStateChange({ stage: "waiting" });

  const result = await daemon.request(
    { type: "oauth-start", provider: "chatgpt" },
    "oauth-result",
    300_000,
  ) as any;

  if (result?.error) {
    callbacks.onStateChange({ stage: "error", message: result.error });
    return null;
  }

  const res = { accountId: result.accountId as string, label: result.label as string };
  callbacks.onStateChange({ stage: "success", ...res });
  return res;
}

async function getDaemonClient(): Promise<{ request: Function; isConnected: () => boolean } | null> {
  try {
    const client = getDesktopDaemonClient();
    if (client && typeof client.request === "function") {
      return client;
    }
  } catch {
    /* not available */
  }
  return null;
}

async function startOAuthLocally(
  callbacks: AuthFlowCallbacks,
): Promise<{ accountId: string; label: string } | null> {
  const redirectUri = "urn:ietf:wg:oauth:2.0:oob";

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CHATGPT_OAUTH_CONFIG.clientId,
    redirect_uri: redirectUri,
    scope: CHATGPT_OAUTH_CONFIG.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${CHATGPT_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`;

  currentPKCEContext = {
    codeVerifier,
    state,
    provider: "chatgpt",
    timeout: setTimeout(() => {
      clearPKCEContext();
      callbacks.onStateChange({ stage: "timeout" });
    }, 5 * 60 * 1000),
  };

  callbacks.onStateChange({ stage: "opening-browser", url: authUrl });

  const opened = await tryOpenUrl(authUrl);
  if (!opened) {
    callbacks.onStateChange({
      stage: "manual-input-needed",
      url: authUrl,
      exchangeCode: async (code: string) => {
        callbacks.onStateChange({ stage: "exchanging-code" });
        try {
          const tokenResponse = await exchangeChatGPTCode(code, codeVerifier, state);
          const accountId = generateAccountId();
          const label = `ChatGPT ${new Date().toLocaleDateString()}`;
          clearPKCEContext();
          callbacks.onStateChange({ stage: "success", accountId, label });
          return { accountId, label };
        } catch (err) {
          clearPKCEContext();
          const message = err instanceof Error ? err.message : String(err);
          callbacks.onStateChange({ stage: "error", message });
          return null;
        }
      },
    });
    return null;
  }

  callbacks.onStateChange({ stage: "waiting" });

  while (currentPKCEContext) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return null;
}

export async function exchangeChatGPTCode(
  code: string,
  codeVerifier: string,
  expectedState: string,
  receivedState?: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
  const actualState = receivedState ?? expectedState;
  if (expectedState !== actualState) {
    throw new Error("OAuth state mismatch: possible CSRF attack");
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CHATGPT_OAUTH_CONFIG.clientId,
    code,
    redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
    code_verifier: codeVerifier,
  });

  const response = await fetch(CHATGPT_OAUTH_CONFIG.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OAuth code exchange failed: ${response.status} ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

export function cancelOAuthFlow(): void {
  clearPKCEContext();
}

export interface ManualTokenPayload {
  token: string;
  label?: string;
}

export interface RefreshTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export async function refreshChatGPTToken(
  account: { id: string; provider: string; refreshToken?: string; oauthConfig?: { tokenUrl: string; clientId: string; clientSecret?: string; scopes?: string[]; refreshUrl?: string } },
): Promise<RefreshTokenResult | null> {
  if (!account.refreshToken) return null;

  const daemon = getDesktopDaemonClient();
  if (daemon && daemon.isConnected()) {
    try {
      const result = await daemon.request(
        { type: "oauth-refresh", provider: "chatgpt", accountId: account.id, refreshToken: account.refreshToken },
        "oauth-refresh-result",
        30_000,
      ) as any;
      if (result?.accessToken) {
        return {
          accessToken: result.accessToken as string,
          refreshToken: result.refreshToken as string | undefined,
          expiresAt: result.expiresAt as number,
        };
      }
    } catch {
      /* daemon unavailable, try local */
    }
  }

  try {
    const config = account.oauthConfig ?? {
      tokenUrl: CHATGPT_OAUTH_CONFIG.tokenUrl,
      clientId: CHATGPT_OAUTH_CONFIG.clientId,
      scopes: [...CHATGPT_OAUTH_CONFIG.scopes],
    };
    const refreshEndpoint = config.refreshUrl ?? config.tokenUrl;
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
      client_id: config.clientId,
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      ...(config.scopes?.length ? { scope: config.scopes.join(" ") } : {}),
    });

    const response = await fetch(refreshEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Token refresh failed: ${response.status} ${body.slice(0, 200)}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in * 1000 : 3600_000;
    return {
      accessToken: String(data.access_token ?? ""),
      refreshToken: String(data.refresh_token ?? account.refreshToken),
      expiresAt: Date.now() + expiresIn,
    };
  } catch (err) {
    console.error("[providerAuth] refresh failed:", err);
    return null;
  }
}

export function generateAccountId(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  const hex = Array.from(array).map(b => b.toString(16).padStart(2, "0")).join("");
  return `chatgpt-${hex.slice(0, 12)}`;
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64URLEncode(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64URLEncode(new Uint8Array(hash));
}

function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return base64URLEncode(array);
}

function base64URLEncode(buffer: Uint8Array): string {
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
