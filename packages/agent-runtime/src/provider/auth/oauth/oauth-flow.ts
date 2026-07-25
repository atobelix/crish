import { generateCodeVerifier, generateCodeChallenge, generateState } from "./pkce";

export type OAuthFlowType = "pkce" | "device-code" | "client-credentials";

export interface OAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: string;
  scope?: string;
  idToken?: string;
}

export interface OAuthFlowOptions {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  refreshUrl?: string;
  scopes: string[];
  redirectUri: string;
}

export class OAuthFlowManager {
  private options: OAuthFlowOptions;

  constructor(options: OAuthFlowOptions) {
    this.options = options;
  }

  async startPKCE(): Promise<{ authorizationUrl: string; codeVerifier: string; state: string }> {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = generateState();

    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      scope: this.options.scopes.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    return {
      authorizationUrl: `${this.options.authorizeUrl}?${params.toString()}`,
      codeVerifier,
      state,
    };
  }

  async exchangeCode(code: string, codeVerifier: string, expectedState: string, receivedState: string): Promise<OAuthTokenResponse> {
    if (expectedState !== receivedState) {
      throw new Error("OAuth state mismatch: possible CSRF attack");
    }
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.options.clientId,
      code,
      redirect_uri: this.options.redirectUri,
      code_verifier: codeVerifier,
    });

    const response = await fetch(this.options.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OAuth token exchange failed: ${response.status} ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      scope: data.scope,
      idToken: data.id_token,
    };
  }

  async refreshToken(refreshToken: string): Promise<OAuthTokenResponse> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.options.clientId,
      refresh_token: refreshToken,
    });

    const tokenUrl = this.options.refreshUrl ?? this.options.tokenUrl;
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OAuth token refresh failed: ${response.status} ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      scope: data.scope,
    };
  }
}
