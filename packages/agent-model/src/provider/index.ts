export type {
  DeclarativeProviderDef,
  NormalizedDeclarativeDef,
} from './declarative-schema';
export { normalizeDeclarativeDef } from './declarative-schema';
export type {
  DeclarativeProviderEntry,
  DeclarativeSourceType,
} from './registry-v2';
export { ProviderRegistryV2Impl as ProviderRegistry } from './registry-v2';
export { ProviderRegistryV2Impl } from './registry-v2';
export type {
  ProviderRegistryV2,
  ProviderLifecycleState,
  ProviderLifecycleInfo,
} from './registry-v2';
export { DeclarativeLoader } from './loader';
export { ProviderFactory, EngineProvider } from './factory';
export type {
  Engine,
  EngineOptions,
  EngineRequest,
  ProviderDef,
  AgentProvider,
  AgentProviderRequest,
} from './types';
export { GatewayV2Bridge } from './provider-gateway-v2';

// SPI
export type { ProviderClass } from './spi/provider-class';
export type { ProviderFactory as SPIProviderFactory } from './spi/provider-factory';
export type { EngineClass } from './spi/engine-class';

// Engines
export {
  AbstractBaseEngine,
  fetchWithRetry,
  OpenAICompatibleEngine,
  AnthropicMessagesEngine,
  OllamaEngine,
} from './engines';
export type { ErrorClassification } from './engines';

// Auth
export {
  createSecret,
  obfuscateSecret,
  AutoSecretStore,
  wipeSecret,
  EncryptedFileSecretStore,
  validateBaseUrl,
} from './auth';
export type {
  SecretValue,
  AuthMethod,
  OAuth2Config,
  SecretStore,
  SecretStoreLayer,
  ValidationResult,
} from './auth';

// CLI
export {
  validateProviderFile,
  validateProviderDirectory,
  testProviderConnection,
  listProviders,
} from './cli';
export type { ValidationReport, TestResult } from './cli';

// Builtin
export { registerBuiltinProviders } from './builtin';

// FauxProvider for testing
export { FauxProvider } from './faux-provider';
export type {
  FauxProviderOptions,
  FauxHealthCheckResult,
} from './faux-provider';
