import type { IconName } from '@/components/ui/icons';
import type { McpServer } from '../../api/clientApi';
import {
  EXTENSION_CATALOG,
  type CatalogEntry,
  type InstalledExtension,
} from '../../api/extensionCatalog';
import type { UnifiedExtensionItem } from './buildUnifiedItems';
import { detectPlatformMeta } from './buildUnifiedItems.sources';

/**
 * 合并去重与已装/货架条目构建（从 buildUnifiedItems.ts 拆分而来，行为不变）：
 * - isSettingsMcpDuplicate：settingsStore MCP 与已入列条目的去重判定；
 * - buildInstalledItem：已安装扩展列表（InstalledExtension）→ 统一条目；
 * - mergeCatalogEntryIntoExisting / buildCatalogShelfItem：EXTENSION_CATALOG 货架合流。
 */

/** settingsStore MCP 是否与已入列条目重复（按 名称/ID 多口径命中） */
export function isSettingsMcpDuplicate(
  addedIds: Set<string>,
  s: McpServer
): boolean {
  const id = `local-mcp:${s.name}`;
  return (
    addedIds.has(id) ||
    addedIds.has(`mcp:${s.name}`) ||
    (!!s.id &&
      (addedIds.has(`local-mcp:${s.id}`) ||
        addedIds.has(`mcp:${s.id}`) ||
        addedIds.has(s.id))) ||
    addedIds.has(s.name)
  );
}

/** 已安装扩展项（InstalledExtension 列表）→ 统一条目 */
export function buildInstalledItem(
  item: InstalledExtension
): UnifiedExtensionItem {
  const isEnabled =
    'pluginEnabled' in item
      ? (item as { pluginEnabled?: boolean }).pluginEnabled !== false
      : true;
  const meta = detectPlatformMeta({
    id: item.id,
    name: item.name,
    source: item.source,
    installRef: item.installRef,
    detail: item.detail,
    description: item.description,
  });
  const source = meta ? meta.source : item.source || 'local';
  const defaultIcon: IconName =
    item.kind === 'mcp' ? 'cpu' : item.kind === 'skill' ? 'blocks' : 'puzzle';
  const icon: IconName = meta ? meta.icon : defaultIcon;
  const defaultDesc =
    item.kind === 'mcp'
      ? `${item.mcpTools?.length || 0} 个可用工具`
      : item.kind === 'skill'
        ? '扩展技能'
        : '扩展插件';
  const description =
    item.description ||
    (meta
      ? `${meta.descriptionPrefix}${item.kind === 'mcp' ? ' MCP 服务' : item.kind === 'skill' ? '技能' : '扩展插件'}`
      : defaultDesc);

  const matchingCatalog = EXTENSION_CATALOG.find(
    (c) =>
      c.id === item.id ||
      (c.name.toLowerCase() === item.name.toLowerCase() && c.kind === item.kind)
  );
  const catalogEntry =
    matchingCatalog ||
    (item.kind === 'plugin'
      ? {
          id: item.id,
          kind: 'plugin' as const,
          source: (item.source as any) || 'community',
          name: item.name,
          description: item.description || '扩展插件',
          installRef: item.installRef || item.id,
        }
      : undefined);

  return {
    id: item.id,
    kind: item.kind || 'plugin',
    scope: catalogEntry ? 'both' : 'installed',
    source,
    name: item.name,
    description,
    icon,
    isOfficial: item.source === 'official',
    isEnabled,
    isInstalled: true,
    installRef: item.installRef || catalogEntry?.installRef,
    catalogEntry,
    installedItem: item,
    nativeItem: item,
  };
}

/**
 * 货架条目与已入列条目合流：命中既有条目时补齐 scope/catalogEntry/installRef，
 * 命中返回 true（调用方据此跳过新增）。
 */
export function mergeCatalogEntryIntoExisting(
  list: UnifiedExtensionItem[],
  entry: CatalogEntry
): boolean {
  const existing = list.find(
    (it) =>
      it.id === entry.id ||
      (it.name.toLowerCase() === entry.name.toLowerCase() &&
        it.kind === entry.kind)
  );
  if (!existing) return false;

  existing.scope = 'both';
  existing.catalogEntry = existing.catalogEntry || entry;
  existing.isInstalled = true;
  if (!existing.installRef && entry.installRef) {
    existing.installRef = entry.installRef;
  }
  return true;
}

/** EXTENSION_CATALOG 新货架条目 → 统一条目 */
export function buildCatalogShelfItem(
  entry: CatalogEntry,
  catalogInstalled: Set<string>
): UnifiedExtensionItem {
  const isAlreadyInstalled = catalogInstalled.has(entry.id);
  const meta = detectPlatformMeta({
    id: entry.id,
    name: entry.name,
    source: entry.source,
    installRef: entry.installRef,
    description: entry.description,
  });
  const source = meta ? meta.source : entry.source;

  let icon: IconName = meta ? meta.icon : 'puzzle';
  if (!meta) {
    if (entry.kind === 'plugin') {
      icon = entry.id.includes('audit')
        ? 'shield-check'
        : entry.id.includes('doc')
          ? 'file-text'
          : 'puzzle';
    } else if (entry.kind === 'mcp') {
      icon = 'cpu';
    } else if (entry.kind === 'skill') {
      icon = 'blocks';
    }
  }

  return {
    id: entry.id,
    kind: entry.kind,
    scope: isAlreadyInstalled ? 'both' : 'catalog',
    source,
    name: entry.name,
    description: entry.description,
    icon,
    isOfficial: entry.source === 'official',
    isEnabled: isAlreadyInstalled,
    isInstalled: isAlreadyInstalled,
    installRef: entry.installRef,
    catalogEntry: entry,
    nativeItem: entry,
  };
}
