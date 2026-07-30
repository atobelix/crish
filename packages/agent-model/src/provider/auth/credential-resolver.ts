import { createSecret, type AuthMethod, type SecretValue } from './types';
import type { SecretStore } from './secret-store';

export type CredentialSource =
  | { type: 'direct'; key: SecretValue }
  | { type: 'secret-store'; storeKey: string }
  | { type: 'env-var'; varName: string }
  | {
      type: 'ref';
      source: CredentialSource;
      transform?: (raw: string) => string;
    };

export interface CredentialResolveResult {
  key: SecretValue;
  source: CredentialSource['type'];
}

export interface CredentialResolverOptions {
  directKey?: SecretValue;
  secretStore?: SecretStore;
  envVarPrefix?: string;
}

export class CredentialResolver {
  private directKey: SecretValue | undefined;
  private secretStore: SecretStore | undefined;
  private envVarPrefix: string;

  constructor(options: CredentialResolverOptions = {}) {
    this.directKey = options.directKey;
    this.secretStore = options.secretStore;
    this.envVarPrefix = options.envVarPrefix ?? 'CONEX_API_KEY_';
  }

  async resolve(keyHint?: string): Promise<CredentialResolveResult | null> {
    if (this.directKey) {
      return { key: this.directKey, source: 'direct' };
    }

    if (this.secretStore && keyHint) {
      try {
        const stored = await this.secretStore.load(keyHint);
        if (stored) {
          return { key: stored, source: 'secret-store' };
        }
      } catch {
        // degrade to next source
      }
    }

    if (keyHint) {
      const envKey = `${this.envVarPrefix}${keyHint.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
      const envVal = process.env[envKey];
      if (envVal) {
        return { key: createSecret(envVal), source: 'env-var' };
      }
    }

    return null;
  }

  async resolveAuthMethod(
    method: AuthMethod
  ): Promise<CredentialResolveResult | null> {
    if (method.type === 'chain') {
      for (const sub of method.methods) {
        const result = await this.resolveAuthMethod(sub);
        if (result) return result;
      }
      return null;
    }

    if (method.type === 'no_auth') return null;

    if (method.type === 'bearer_token') {
      return { key: method.token, source: 'direct' };
    }

    if (method.type === 'api_key') {
      return { key: method.key, source: 'direct' };
    }

    if (method.type === 'basic') {
      const encoded = Buffer.from(
        `${method.username}:${method.password}`
      ).toString('base64');
      return { key: createSecret(encoded), source: 'direct' };
    }

    if (method.type === 'azure_api_key') {
      return { key: method.key, source: 'direct' };
    }

    if (method.type === 'custom') {
      const raw =
        method.params['apiKey'] ??
        method.params['key'] ??
        method.params['token'];
      if (raw) {
        return { key: createSecret(raw), source: 'direct' };
      }
    }

    return null;
  }

  setDirectKey(key: SecretValue): void {
    this.directKey = key;
  }

  clearDirectKey(): void {
    this.directKey = undefined;
  }
}
