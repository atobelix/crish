import { spawn } from 'node:child_process';
import type { SecretStore } from '../secret-store';
import { createSecret } from '../types';
import { LocalCallbackServer } from './local-server';
import { OAuthFlowManager, type OAuthFlowOptions } from './oauth-flow';
import { CHATGPT_OAUTH_CONFIG } from './pkce';

export interface OAuthResult {
  accountId: string;
  label: string;
}

export interface OAuthUIOptions {
  provider: 'chatgpt';
  secretStore: SecretStore;
  timeoutMs?: number;
  onStatusChange?: (status: OAuthUIStatus) => void;
}

export type OAuthUIStatus =
  | { stage: 'starting-server' }
  | { stage: 'generating-url' }
  | { stage: 'opening-browser'; url: string }
  | { stage: 'waiting-callback' }
  | { stage: 'exchanging-token' }
  | { stage: 'storing-token' }
  | { stage: 'done'; result: OAuthResult }
  | { stage: 'error'; error: Error };

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

const PROVIDER_CONFIG: Record<'chatgpt', OAuthFlowOptions> = {
  chatgpt: {
    clientId: CHATGPT_OAUTH_CONFIG.clientId,
    authorizeUrl: CHATGPT_OAUTH_CONFIG.authorizeUrl,
    tokenUrl: CHATGPT_OAUTH_CONFIG.tokenUrl,
    scopes: [...CHATGPT_OAUTH_CONFIG.scopes],
    redirectUri: '', // set dynamically
  },
};

function getRedirectUri(port: number): string {
  return `http://localhost:${port}/callback`;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === 'win32'
      ? 'start'
      : platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', shell: platform === 'win32' });
}

function generateAccountId(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  const hex = Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `chatgpt-${hex.slice(0, 12)}`;
}

function sanitizeLabel(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s@._-]/g, '')
    .trim()
    .slice(0, 64);
}

export async function startOAuthFlow(
  provider: 'chatgpt',
  secretStore: SecretStore,
  options?: Partial<OAuthUIOptions>
): Promise<OAuthResult> {
  const timeoutMs = options?.timeoutMs ?? OAUTH_TIMEOUT_MS;
  const notify = options?.onStatusChange ?? (() => {});

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(new Error(`OAuth flow timed out after ${timeoutMs / 1000}s`)),
      timeoutMs
    );
  });

  async function flow(): Promise<OAuthResult> {
    notify({ stage: 'starting-server' });

    let codeVerifier = '';
    let expectedState = '';

    const codePromise = new Promise<{ code: string; state: string }>(
      (resolve, reject) => {
        const server = new LocalCallbackServer({
          redirectUri: '', // not used by server, just placeholder
          onCodeReceived: (code, state) => resolve({ code, state }),
          onError: (error) => reject(error),
        });

        server
          .start()
          .then(async (port) => {
            const redirectUri = getRedirectUri(port);
            const config: OAuthFlowOptions = {
              ...PROVIDER_CONFIG[provider],
              redirectUri,
            };
            const flowManager = new OAuthFlowManager(config);

            notify({ stage: 'generating-url' });

            const pkce = await flowManager.startPKCE();
            codeVerifier = pkce.codeVerifier;
            expectedState = pkce.state;

            notify({ stage: 'opening-browser', url: pkce.authorizationUrl });

            try {
              openBrowser(pkce.authorizationUrl);
            } catch (err) {
              // Browser open failed - will be caught by timeout
              console.warn(
                '[OAuthUI] Failed to open browser automatically:',
                err
              );
            }

            notify({ stage: 'waiting-callback' });
          })
          .catch(reject);
      }
    );

    const { code, state } = await codePromise;

    notify({ stage: 'exchanging-token' });

    const redirectUri = getRedirectUri(0); // port not needed for exchange
    const config: OAuthFlowOptions = {
      ...PROVIDER_CONFIG[provider],
      redirectUri,
    };
    const flowManager = new OAuthFlowManager(config);
    const token = await flowManager.exchangeCode(
      code,
      codeVerifier,
      expectedState,
      state
    );

    notify({ stage: 'storing-token' });

    const accountId = generateAccountId();
    const label = sanitizeLabel(`ChatGPT ${new Date().toLocaleDateString()}`);

    await secretStore.store(
      `oauth:${provider}:${accountId}:access_token`,
      createSecret(token.accessToken)
    );
    if (token.refreshToken) {
      await secretStore.store(
        `oauth:${provider}:${accountId}:refresh_token`,
        createSecret(token.refreshToken)
      );
    }
    await secretStore.store(
      `oauth:${provider}:${accountId}:expires_at`,
      createSecret(String(Date.now() + token.expiresIn * 1000))
    );
    await secretStore.store(
      `oauth:${provider}:${accountId}:label`,
      createSecret(label)
    );

    const result: OAuthResult = { accountId, label };
    notify({ stage: 'done', result });
    return result;
  }

  return Promise.race([flow(), timeout]);
}
