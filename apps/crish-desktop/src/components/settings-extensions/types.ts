import type { ExtensionKind } from '../../api/extensionCatalog';
import type { InstalledExtension } from '../../api/extensionCatalog';

export type MainView = 'installed' | 'discover';
export type KindFilter = 'all' | ExtensionKind;
export type ManageKind = null | 'skill' | 'mcp';
export type ExpandMode = 'detail' | 'config';

export type ExpandTarget =
  | { scope: 'installed'; id: string; mode: ExpandMode }
  | { scope: 'catalog'; id: string; mode: ExpandMode };

export interface PendingExpand {
  name: string;
  kind: ExtensionKind;
  mode: ExpandMode;
  fallbackId: string;
}

/**
 * 插件卡片条目（在 InstalledExtension 上追加 manifest 元数据，E3 UI 泛化）。
 * 仅 settings-extensions 域内构造；ExtensionCard 用 'pluginVersion' in item 收窄。
 */
export type PluginInstalledExtension = InstalledExtension & {
  /** manifest.id（@crish/import-claude-codex 等） */
  pluginId?: string;
  pluginVersion?: string;
  pluginTools?: string[];
  pluginHooks?: string[];
  pluginTrustLevel?: string;
  pluginEnabled?: boolean;
};
