// packages/plugin-sdk 公共入口
// W4-C：导出 contribute points View 轨；保留 definePlugin 轻量约定

export interface Plugin {
  name: string;
  version: string;
  description?: string;
  hooks?: {
    onSessionStart?(id: string): void | Promise<void>;
    onSessionEnd?(id: string): void | Promise<void>;
    onToolCall?(call: unknown): void | Promise<void>;
    onMessage?(msg: unknown): void | Promise<void>;
  };
  permissions?: string[];
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

// ─── W4-C contribute points（View 轨）+ M4 registerFlavour ───
export type {
  ContributeKind,
  ContributePermission,
  ContributeBase,
  SlashItemContribution,
  BlockViewContribution,
  WidgetContribution,
  KeymapContribution,
  Contribution,
  ViewDescriptor,
  ViewDescriptorBase,
  SlashItemViewDescriptor,
  BlockViewViewDescriptor,
  WidgetViewDescriptor,
  KeymapViewDescriptor,
  RegisterErrorCode,
  RegisterResult,
  UnknownFlavourPolicy,
  ContributePointRegistryOptions,
  FlavourDefinition,
  FlavourDescriptor,
  RegisterFlavourResult,
} from './contribute';

export {
  CONTRIBUTE_KINDS,
  CONTRIBUTE_PERMISSIONS,
  REQUIRED_CONTRIBUTE_PERMISSION,
  FLAVOUR_REGISTER_PERMISSIONS,
  DEFAULT_KNOWN_FLAVOURS,
  createKnownFlavourSet,
  isKnownFlavour,
  ContributePointRegistry,
  createContributePointRegistry,
  makeRegistrationKey,
} from './contribute';

// ─── 权限面（含 ui:contribute / note:read|write|extend）────
export type {
  PluginPermission,
  PluginTrustLevel,
  PluginOrigin,
} from './manifest';

export {
  PLUGIN_PERMISSIONS,
  PLUGIN_TRUST_LEVELS,
  PLUGIN_ORIGINS,
} from './manifest';
