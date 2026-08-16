// packages/plugin-sdk 公共入口
// 收敛（E1）：旧轻量插件入口接口已移除——插件契约真源为 shared-types
// PluginManifest/PluginActivationApi（跨端契约）与 hooks PluginLifecycle
// （A 轨运行时面 registry/*、api/plugin-api.ts、hooks/lifecycle.ts 保留给
// E2 评估）。contribute View 轨库 + registerFlavour 继续经本入口导出，
// 宿主接线待 E2 裁决（当前为有库无宿主，不作可点路径）。

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

// ─── 沙箱安全与 XML / HTML 净化面 ────
export {
  escapeXml,
  unescapeXml,
  sanitizeXmlTagName,
  sanitizeXmlAttributes,
  defangSystemTags,
  wrapInXmlSandbox,
  formatSkillOutput,
  escapeHtml,
  stripHtml,
  isSafeUrl,
  isSafeSrc,
  sanitizeHtml,
  DEFAULT_ALLOWED_TAGS,
  DEFAULT_GLOBAL_ATTRS,
  DEFAULT_TAG_SPECIFIC_ATTRS,
  type SanitizeHtmlOptions,
} from './sanitizer';
