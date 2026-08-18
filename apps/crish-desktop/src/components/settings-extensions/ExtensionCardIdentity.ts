import type { CatalogEntry, InstalledExtension } from '../../api/extensionCatalog';
import type { PluginInstalledExtension } from './types';

/**
 * 插件卡片收窄：manifest 元数据条目（useExtensionMarket 构造，id 恒有 pluginId）。
 * 由 ExtensionCard 与 ExtensionBody 共享。
 */
export function isPluginCardItem(
  item: InstalledExtension | CatalogEntry,
): item is PluginInstalledExtension {
  return 'pluginId' in item && item.kind === 'plugin';
}
