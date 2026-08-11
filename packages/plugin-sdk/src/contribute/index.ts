// packages/plugin-sdk/src/contribute/index.ts
// Barrel：W4-C contribute points View 轨（slash / block_view / widget / keymap）

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
} from './types';

export {
  CONTRIBUTE_KINDS,
  CONTRIBUTE_PERMISSIONS,
  REQUIRED_CONTRIBUTE_PERMISSION,
} from './types';

export {
  DEFAULT_KNOWN_FLAVOURS,
  createKnownFlavourSet,
  isKnownFlavour,
} from './flavours';

export {
  ContributePointRegistry,
  createContributePointRegistry,
  makeRegistrationKey,
} from './registry';
