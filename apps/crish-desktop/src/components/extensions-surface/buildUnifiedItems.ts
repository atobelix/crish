import type { IconName } from '@/components/ui/icons';
import {
  CANONICAL_IMPORT_PLUGIN_ID,
  isImportClaudeCodexPlugin,
} from './extensionIdentity';
import {
  EXTENSION_CATALOG,
  isOfficialPluginUninstalled,
  type CatalogEntry,
  type InstalledExtension,
} from '../../api/extensionCatalog';
import type { DesktopSkill } from '../../api/skillsApi';
import type { McpServerInfo } from '../../api/mcpApi';
import type { McpServer } from '../../api/clientApi';
import type { CustomPluginItem } from './customPluginStorage';
import { isPluginEnabled } from '../settings-extensions/pluginRegistryAdapter';
import {
  buildCustomPluginItem,
  buildEngineMcpItem,
  buildLocalSkillItem,
  buildSettingsMcpItem,
  resolveSettingsMcpServers,
} from './buildUnifiedItems.sources';
import {
  buildCatalogShelfItem,
  buildInstalledItem,
  isSettingsMcpDuplicate,
  mergeCatalogEntryIntoExisting,
} from './buildUnifiedItems.merge';
import { isSkillDismissed } from './skillDismissState';

// 公开面保持稳定：平台探测能力已迁至 buildUnifiedItems.sources，
// 消费方仍从本模块取用（import 路径不变）。
export { detectPlatformMeta } from './buildUnifiedItems.sources';
export type {
  PlatformMetadata,
  PlatformSource,
} from './buildUnifiedItems.sources';

export interface UnifiedExtensionItem {
  id: string;
  kind: 'plugin' | 'skill' | 'mcp';
  scope: 'installed' | 'catalog' | 'both';
  source?: string;
  name: string;
  description: string;
  icon: IconName;
  isOfficial?: boolean;
  isEnabled: boolean;
  isInstalled: boolean;
  installRef?: string;
  rawSkill?: DesktopSkill;
  rawMcp?: McpServerInfo;
  catalogEntry?: CatalogEntry;
  installedItem?: InstalledExtension;
  nativeItem: InstalledExtension | CatalogEntry;
}

export interface BuildUnifiedItemsParams {
  skills: DesktopSkill[];
  mcpServers: McpServerInfo[];
  settingsMcpServers?: McpServer[];
  installed: InstalledExtension[];
  catalogInstalled: Set<string>;
  customPlugins?: CustomPluginItem[];
}

export function buildUnifiedItems({
  skills,
  mcpServers,
  settingsMcpServers,
  installed,
  catalogInstalled,
  customPlugins,
}: BuildUnifiedItemsParams): UnifiedExtensionItem[] {
  const list: UnifiedExtensionItem[] = [];
  const addedIds = new Set<string>();

  // 1. 核心官方置顶：外部历史对话接续与导入（支持自由卸载与重装，市场始终可浏览）
  const isImportUninstalled = isOfficialPluginUninstalled(
    CANONICAL_IMPORT_PLUGIN_ID
  );
  const isImportInstalled = !isImportUninstalled;
  const importItem: InstalledExtension = {
    id: CANONICAL_IMPORT_PLUGIN_ID,
    kind: 'plugin',
    source: 'official',
    name: '外部历史对话接续与导入',
    description: '探测并接续本机 Claude 与 Codex 会话记录，一键导入迁移',
    fromSystem: true,
    installRef: '@crish/plugin-import-claude-codex',
  };
  const importCatalogEntry: CatalogEntry = {
    id: CANONICAL_IMPORT_PLUGIN_ID,
    kind: 'plugin',
    source: 'official',
    name: importItem.name,
    description: importItem.description,
    installRef: '@crish/plugin-import-claude-codex',
    tags: ['官方', '导入'],
  };
  list.push({
    id: CANONICAL_IMPORT_PLUGIN_ID,
    kind: 'plugin',
    scope: isImportInstalled ? 'both' : 'catalog',
    source: 'official',
    name: importItem.name,
    description: importItem.description,
    icon: 'history',
    isOfficial: true,
    isEnabled: isImportInstalled
      ? isPluginEnabled(CANONICAL_IMPORT_PLUGIN_ID)
      : false,
    isInstalled: isImportInstalled,
    installRef: importItem.installRef,
    catalogEntry: importCatalogEntry,
    installedItem: isImportInstalled ? importItem : undefined,
    nativeItem: isImportInstalled ? importItem : importCatalogEntry,
  });
  addedIds.add(CANONICAL_IMPORT_PLUGIN_ID);

  // 2. 本机原生技能
  for (const s of skills) {
    if (isSkillDismissed(s.name)) continue;
    const item = buildLocalSkillItem(s);
    list.push(item);
    addedIds.add(item.id);
    addedIds.add(`skill:${s.id}`);
    addedIds.add(`skill:${s.name}`);
  }

  // 3. 本机 MCP 服务（Engine 上报）
  for (const m of mcpServers) {
    const item = buildEngineMcpItem(m);
    list.push(item);
    addedIds.add(item.id);
    addedIds.add(`mcp:${m.id}`);
    if (m.name) {
      addedIds.add(`local-mcp:${m.name}`);
      addedIds.add(`mcp:${m.name}`);
    }
  }

  // 3.5. settingsStore MCP 服务合并去重（表单/词法 JSON/外部导入）
  const resolvedSettingsMcp = resolveSettingsMcpServers(settingsMcpServers);

  for (const s of resolvedSettingsMcp) {
    if (isSettingsMcpDuplicate(addedIds, s)) continue;

    list.push(buildSettingsMcpItem(s));

    addedIds.add(`local-mcp:${s.name}`);
    addedIds.add(`mcp:${s.name}`);
    if (s.id) {
      addedIds.add(`local-mcp:${s.id}`);
      addedIds.add(`mcp:${s.id}`);
    }
  }

  // 4. 用户自定义插件（customPlugins）
  if (customPlugins && customPlugins.length > 0) {
    for (const cp of customPlugins) {
      const id = `custom-plugin:${cp.id}`;
      if (addedIds.has(id) || addedIds.has(cp.id)) continue;

      list.push(buildCustomPluginItem(cp));
      addedIds.add(id);
    }
  }

  // 5. 已安装的其他扩展项（InstalledExtension 列表）
  for (const item of installed) {
    if (isImportClaudeCodexPlugin(item)) continue;
    if (addedIds.has(item.id)) continue;

    list.push(buildInstalledItem(item));
    addedIds.add(item.id);
  }

  // 6. EXTENSION_CATALOG 扩展货架（全生态发现：官方插件与货架生态条目全量展示）
  for (const entry of EXTENSION_CATALOG) {
    if (isImportClaudeCodexPlugin(entry)) continue;

    if (mergeCatalogEntryIntoExisting(list, entry)) continue;

    if (addedIds.has(entry.id) || addedIds.has(`${entry.kind}:${entry.name}`))
      continue;

    list.push(buildCatalogShelfItem(entry, catalogInstalled));
    addedIds.add(entry.id);
  }

  return list;
}
