// packages/plugin-sdk/src/manifest/index.ts
// Barrel：声明式能力清单 + 权限模型 + TrustGate 契约（Agent 8-A 范围）

export type {
  HookEventName,
  PluginManifest,
  PluginEntrypoints,
  PluginAuthor,
} from './manifest';

export {
  HOOK_EVENT_NAMES,
} from './manifest';

export type {
  PluginPermission,
  PluginTrustLevel,
  PluginOrigin,
} from './permissions';

export {
  PLUGIN_PERMISSIONS,
  PLUGIN_TRUST_LEVELS,
  PLUGIN_ORIGINS,
} from './permissions';

export type {
  SemVerRange,
  PluginEngineConstraint,
} from './engine-constraint';

export {
  isValidSemver,
  isValidSemverRange,
  isEngineCompatible,
} from './engine-constraint';

export type {
  ManifestValidationResult,
  ManifestValidationError,
} from './validate';

export {
  validateManifest,
} from './validate';

export type {
  TrustGateLike,
  TrustGateFactory,
} from './trust-gate';
