export {
  createSecret,
  obfuscateSecret,
  type SecretValue,
  type AuthMethod,
  type OAuth2Config,
} from './types';

export {
  AutoSecretStore,
  wipeSecret,
  type SecretStore,
  type SecretStoreLayer,
} from './secret-store';

export { EncryptedFileSecretStore } from './encrypted-file-store';

export { validateBaseUrl, type ValidationResult } from './base-url-validator';

export { sanitizeForLog, sanitizeHeaders } from './log-sanitizer';

export {
  CredentialResolver,
  type CredentialSource,
  type CredentialResolveResult,
  type CredentialResolverOptions,
} from './credential-resolver';

export {
  KeyRotationManager,
  MAX_COOLDOWN_MS,
  type RotationStrategy,
  type KeyEntry,
  type KeyRotationManagerOptions,
} from './key-rotation';

export {
  CredentialPool,
  type PooledCredential,
  type CredentialStatus,
  type CredentialAuthType,
  type PoolSelectionStrategy,
  type CredentialPoolOptions,
  type CredentialPoolStats,
} from './credential-pool';

export { authMethodToCredentialSource } from './auth-method-bridge';
