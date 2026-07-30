/**
 * @crish/agent-model — 模型 / Provider 系统（Layer 3 middle）
 *
 * 导出 Provider 抽象层（SPI / Engines / Builtin）、Gateway、Transport、
 * Stream Contract、Model Routing、Model Catalog、Media、Pricing 等。
 *
 * 拓扑层（01-OVERVIEW.md §3.2）：Layer 3 (middle)。
 * 依赖约束：依赖 shared-types / shared-utils / agent-context / logger / telemetry，
 * 不依赖 agent-tools / agent-core / agent-mcp。
 *
 * 设计约束（禁令 10）：stream-parse / request-build 归入本包，禁止独立 agent-stream 包。
 * 设计约束（禁令 3）：不引入 DynamicModelRouter / FallbackChain。
 * 设计约束（禁令 6）：不引入 CircuitBreaker。
 */

// ─── Provider 核心（provider/index.ts）─────────────────────────
export type {
  DeclarativeProviderDef,
  NormalizedDeclarativeDef,
} from './provider/declarative-schema';
export { normalizeDeclarativeDef } from './provider/declarative-schema';
export type {
  DeclarativeProviderEntry,
  DeclarativeSourceType,
} from './provider/registry-v2';
export { ProviderRegistryV2Impl as ProviderRegistry } from './provider/registry-v2';
export { ProviderRegistryV2Impl } from './provider/registry-v2';
export type {
  ProviderRegistryV2,
  ProviderLifecycleState,
  ProviderLifecycleInfo,
} from './provider/registry-v2';
export { DeclarativeLoader } from './provider/loader';
export { ProviderFactory, EngineProvider } from './provider/factory';
export type {
  Engine,
  EngineOptions,
  EngineRequest,
  ProviderDef,
  AgentProvider,
  AgentProviderRequest,
} from './provider/types';
export { GatewayV2Bridge } from './provider/provider-gateway-v2';

// ─── SPI ────────────────────────────────────────────────────────
export type { ProviderClass } from './provider/spi/provider-class';
export type { ProviderFactory as SPIProviderFactory } from './provider/spi/provider-factory';
export type { EngineClass } from './provider/spi/engine-class';

// ─── Engines ───────────────────────────────────────────────────
export {
  AbstractBaseEngine,
  fetchWithRetry,
  OpenAICompatibleEngine,
  AnthropicMessagesEngine,
  OllamaEngine,
} from './provider/engines';
export type { ErrorClassification } from './provider/engines';

// ─── Auth ──────────────────────────────────────────────────────
export {
  createSecret,
  obfuscateSecret,
  AutoSecretStore,
  wipeSecret,
  EncryptedFileSecretStore,
  validateBaseUrl,
} from './provider/auth';
export type {
  SecretValue,
  AuthMethod,
  OAuth2Config,
  SecretStore,
  SecretStoreLayer,
  ValidationResult,
} from './provider/auth';

// ─── OAuth State Machine ───────────────────────────────────────
export {
  OAuthStateMachine,
  OAuthStateError,
  OAuthDeadlockError,
} from './provider/auth/oauth';
export type { OAuthState, OAuthStateMachineOptions } from './provider/auth/oauth';

// ─── CLI ───────────────────────────────────────────────────────
export {
  validateProviderFile,
  validateProviderDirectory,
  testProviderConnection,
  listProviders,
} from './provider/cli';
export type { ValidationReport, TestResult } from './provider/cli';

// ─── Builtin Providers ─────────────────────────────────────────
export { registerBuiltinProviders } from './provider/builtin';

// ─── Builtin Provider 实现（Anthropic / Gemini / OpenAI-Compatible）──
export * from './provider-anthropic';
export * from './anthropic-request-build';
export * from './provider-gemini';
export * from './gemini-request-build';
export * from './provider-openai-compatible';
export type { ProviderStreamEvent } from '@crish/shared-types';

// ─── FauxProvider（测试用）─────────────────────────────────────
export { FauxProvider } from './provider/faux-provider';
export type {
  FauxProviderOptions,
  FauxHealthCheckResult,
} from './provider/faux-provider';

// ─── Provider Gateway ──────────────────────────────────────────
// Re-export the full provider-gateway barrel (types + DefaultProviderGateway +
// createProviderGateway + StaticProviderRouteCatalog + factory helpers).
// Per Round 5 barrel fix: previously used NAMED exports which trapped
// ProviderGatewayError / ProviderGatewayPlan / ProviderGateway /
// ProviderRouteRequest / ProviderRouteOffer / ProviderFactoryPlan behind
// sub-barrels.
export * from './provider-gateway';

// ─── Model Routing (provider gateway companion types) ──────────
// ProviderEndpointSupport / ProviderStreamingSupport are referenced by
// provider-gateway/types.ts but live in model-routing; profileFromProviderRouteOffer
// is the public helper used to derive a ModelProfile from a route offer.
export type {
  ProviderEndpointSupport,
  ProviderStreamingSupport,
  TaskCapabilityRequest,
  ModelProfile,
} from './model-routing';
export { profileFromProviderRouteOffer } from './model-routing';

// ─── Provider field helpers ────────────────────────────────────
export { stringField } from './provider-openai-base';

// ─── Provider Transport ────────────────────────────────────────
export {
  ConnectionManager,
  StreamRecovery,
  StreamRecoveryError,
  TokenTracker,
  ConnectionError,
  StreamInterruptedError,
  type ProviderTransport,
  type TransportKind,
  type TransportStatsSnapshot,
  type ConnectionManagerSnapshot,
} from './provider-transport';

// ─── Provider Stream Contract ─────────────────────────────────
export type { ProviderStreamSequencer } from './provider-stream-contract';
export {
  repairToolCallJsonArguments,
  normalizeProviderStreamEvent,
  normalizeAndCoalesceProviderStreamEvents,
} from './provider-stream-contract';

// ─── Stream（streaming-tool-executor）──────────────────────────
export { StreamingToolExecutor } from './stream';

// ─── Model Routing ─────────────────────────────────────────────
export { routeModelByCapability, routeModelForTask } from './model-routing';

// ─── Model Catalog ─────────────────────────────────────────────
export { ModelCatalog, CatalogSyncManager } from './model-catalog';

// ─── Media ─────────────────────────────────────────────────────
export { MediaCache } from './media/media-cache';
export { MediaPreprocessor } from './media/media-preprocessor';
export { ProviderMediaAdapter } from './media/provider-media-adapter';

// ─── Pricing / Token / Preview ─────────────────────────────────
export { PricingEngine } from './pricing-engine';
export { TokenLedger } from './token-ledger';
export { PreviewQueue } from './preview-queue';

// ─── Provider 错误分类 ─────────────────────────────────────────
export { ProviderErrorClassifier } from './provider-error-classifier';

// ─── Provider 请求状态机 ──────────────────────────────────────
export { createProviderRequestMachine } from './provider-request-machine';
export type {
  ProviderRequestState,
  ProviderRequestEvent,
  ProviderRequestContext,
  ProviderRequestDiagnostic,
} from './provider-request-machine';

// ─── Cache Hints ───────────────────────────────────────────────
export { createProviderCacheHintPlan, DEFAULT_GEMINI_CONTEXT_CACHE_MIN_BYTES } from './provider-cache-hints';
export type { ProviderCacheHintPlan } from './provider-cache-hints';

// ─── Provider Stream Contract（事件类型）──────────────────────
export type { ProviderStreamContractEvent } from './provider-stream-contract';

// ─── Model Routing Enhanced ────────────────────────────────────
export { scoreProfileWithCost } from './model-routing-enhanced';
export type {
  EnhancedModelProfile,
  EnhancedTaskCapabilityRequest,
} from './model-routing-enhanced';

// ─── Model Routing Roles ───────────────────────────────────────
export { allocateModelRoles, reallocateRoles } from './model-routing-roles';
export type {
  MultiModelAssignment,
  RoleCapabilityConstraints,
} from './model-routing-roles';
