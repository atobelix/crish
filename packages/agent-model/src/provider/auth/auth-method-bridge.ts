import type { JsonObject } from '@crish/shared-types';
import type { AuthMethod } from './types';
import type { ResolvedProviderCredential } from '../../provider-gateway';

function toBase64(str: string): string {
  return Buffer.from(str, 'utf-8').toString('base64');
}

export function authMethodToCredentialSource(
  authMethod: AuthMethod
): ResolvedProviderCredential {
  const base = (
    overrides: Partial<ResolvedProviderCredential>
  ): ResolvedProviderCredential => ({
    id: `auth-method:${authMethod.type}`,
    source: 'api-key',
    providerId: '',
    ...overrides,
  });

  switch (authMethod.type) {
    case 'no_auth':
      return base({ apiKey: '' });

    case 'bearer_token':
      return base({
        apiKey: authMethod.token as string,
        headers: { Authorization: `Bearer ${authMethod.token as string}` },
      });

    case 'api_key':
      return base({
        apiKey: authMethod.key as string,
        headers: { [authMethod.headerName]: authMethod.key as string },
      });

    case 'basic':
      return base({
        apiKey: toBase64(
          `${authMethod.username}:${authMethod.password as string}`
        ),
      });

    case 'aws_sig_v4': {
      const headers: Record<string, string> = {
        'x-amz-access-key-id': authMethod.accessKeyId as string,
        'x-amz-secret-access-key': authMethod.secretAccessKey as string,
        'x-amz-region': authMethod.region,
      };
      if (authMethod.sessionToken) {
        headers['x-amz-session-token'] = authMethod.sessionToken as string;
      }
      return base({ apiKey: '', headers });
    }

    case 'azure_api_key':
      return base({
        apiKey: authMethod.key as string,
        headers: { 'api-key': authMethod.key as string },
      });

    case 'oauth':
      return base({
        apiKey: '',
        headers: {
          'x-oauth-provider': authMethod.provider,
          'x-oauth-client-id': authMethod.config.clientId,
          'x-oauth-scopes': authMethod.config.scopes.join(','),
        },
        metadata: { oauthProvider: authMethod.provider } as JsonObject,
      });

    case 'custom':
      return base({
        apiKey: '',
        headers: { ...authMethod.params },
      });

    case 'chain': {
      for (const method of authMethod.methods) {
        const result = authMethodToCredentialSource(method);
        if (
          result.apiKey ||
          (result.headers && Object.keys(result.headers).length > 0)
        ) {
          return result;
        }
      }
      return base({ apiKey: '' });
    }
  }
}
