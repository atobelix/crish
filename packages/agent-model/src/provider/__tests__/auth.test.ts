import { describe, it, expect } from 'vitest';
import { createSecret, obfuscateSecret } from '../auth/types';
import type { AuthMethod } from '../auth/types';

describe('SecretValue', () => {
  it('creates a branded SecretValue from a raw string', () => {
    const secret = createSecret('sk-live-abc123def456');
    // The branded type is a string at runtime
    expect(typeof secret).toBe('string');
    expect(secret).toBe('sk-live-abc123def456');
  });

  it('obfuscates long secrets correctly', () => {
    const long = 'sk-live-abcdefghijklmnopqrstuvwxyz123456';
    const secret = createSecret(long);
    const obfuscated = obfuscateSecret(secret);
    const asteriskCount = Math.min(long.length - 8, 12);
    expect(obfuscated).toBe('sk-l' + '*'.repeat(asteriskCount) + '3456');
    expect(obfuscated).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('obfuscates secrets of length 12 correctly', () => {
    const secret = createSecret('abcdefghijkl');
    expect(secret.length).toBe(12);
    const obfuscated = obfuscateSecret(secret);
    expect(obfuscated).toBe('abcd****ijkl');
  });

  it('obfuscates 9-char secret as first 4 + 1 asterisk + last 4', () => {
    const secret = createSecret('abcdefghi');
    expect(secret.length).toBe(9);
    const obfuscated = obfuscateSecret(secret);
    expect(obfuscated).toBe('abcd*fghi');
    expect(obfuscated.length).toBe(9);
  });

  it('obfuscates short secrets as ****', () => {
    const secrets = ['a', 'ab', 'abc', 'abcd', 'abcdefgh'];
    for (const s of secrets) {
      const secret = createSecret(s);
      expect(obfuscateSecret(secret)).toBe('****');
    }
  });

  it('handles empty string', () => {
    const secret = createSecret('');
    expect(obfuscateSecret(secret)).toBe('****');
  });

  it('preserves the last 4 characters of a long secret', () => {
    const suffix = 'xyz1';
    const secret = createSecret('sk-proj-' + 'a'.repeat(40) + suffix);
    const obfuscated = obfuscateSecret(secret);
    expect(obfuscated.endsWith(suffix)).toBe(true);
  });

  it('preserves the first 4 characters of a long secret', () => {
    const prefix = 'sk-p';
    const secret = createSecret(prefix + 'a'.repeat(40) + 'xyz1');
    const obfuscated = obfuscateSecret(secret);
    expect(obfuscated.startsWith(prefix)).toBe(true);
  });
});

describe('AuthMethod types', () => {
  it('creates a no_auth method', () => {
    const auth: AuthMethod = { type: 'no_auth' };
    expect(auth.type).toBe('no_auth');
  });

  it('creates a bearer_token method with SecretValue', () => {
    const auth: AuthMethod = {
      type: 'bearer_token',
      token: createSecret('tok-abc'),
    };
    expect(auth.type).toBe('bearer_token');
    expect(auth.token).toBe('tok-abc');
  });

  it('creates an api_key method with headerName and key', () => {
    const auth: AuthMethod = {
      type: 'api_key',
      headerName: 'X-API-Key',
      key: createSecret('key-123'),
    };
    expect(auth.type).toBe('api_key');
    expect(auth.headerName).toBe('X-API-Key');
    expect(auth.key).toBe('key-123');
  });

  it('creates a basic auth method', () => {
    const auth: AuthMethod = {
      type: 'basic',
      username: 'admin',
      password: createSecret('pass-456'),
    };
    expect(auth.type).toBe('basic');
    expect(auth.username).toBe('admin');
    expect(auth.password).toBe('pass-456');
  });

  it('creates an aws_sig_v4 method', () => {
    const auth: AuthMethod = {
      type: 'aws_sig_v4',
      region: 'us-east-1',
      accessKeyId: createSecret('AKID123'),
      secretAccessKey: createSecret('SAK456'),
    };
    expect(auth.type).toBe('aws_sig_v4');
    expect(auth.region).toBe('us-east-1');
  });

  it('creates an azure_api_key method', () => {
    const auth: AuthMethod = {
      type: 'azure_api_key',
      key: createSecret('az-key-789'),
    };
    expect(auth.type).toBe('azure_api_key');
    expect(auth.key).toBe('az-key-789');
  });

  it('creates an oauth method with OAuth2Config', () => {
    const auth: AuthMethod = {
      type: 'oauth',
      provider: 'github',
      config: {
        clientId: 'client-123',
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        scopes: ['repo'],
        redirectUri: 'http://localhost/callback',
      },
    };
    expect(auth.type).toBe('oauth');
    if (auth.type === 'oauth') {
      expect(auth.provider).toBe('github');
      expect(auth.config.scopes).toEqual(['repo']);
    }
  });

  it('creates a custom method', () => {
    const auth: AuthMethod = {
      type: 'custom',
      providerName: 'my-vendor',
      params: { key: 'value' },
    };
    expect(auth.type).toBe('custom');
    expect(auth.params).toEqual({ key: 'value' });
  });

  it('creates a chain of methods', () => {
    const auth: AuthMethod = {
      type: 'chain',
      methods: [
        { type: 'bearer_token', token: createSecret('tok') },
        { type: 'api_key', headerName: 'X-Custom', key: createSecret('key') },
      ],
    };
    expect(auth.type).toBe('chain');
    if (auth.type === 'chain') {
      expect(auth.methods).toHaveLength(2);
      expect(auth.methods[0]!.type).toBe('bearer_token');
      expect(auth.methods[1]!.type).toBe('api_key');
    }
  });

  it('obfuscates secrets within AuthMethod objects', () => {
    const auth: AuthMethod = {
      type: 'api_key',
      headerName: 'Authorization',
      key: createSecret('sk-live-abcdefghijklmnopqrstuvwxyz123456'),
    };
    if (auth.type === 'api_key') {
      const obfuscated = obfuscateSecret(auth.key);
      expect(obfuscated).not.toContain('abcdefghijklmnopqrstuvwxyz');
      expect(obfuscated.startsWith('sk-l')).toBe(true);
      expect(obfuscated.endsWith('3456')).toBe(true);
    }
  });
});
