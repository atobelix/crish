import type { IconName } from '../ui/icons/index';
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
import { useSettingsStore } from '../../store/settingsStore';
import { isPluginEnabled } from '../settings-extensions/pluginRegistryAdapter';

import { resolveMcpTools } from './McpConnectModal';

export interface UnifiedExtensionItem {
  id: string;
  kind: 'plugin' | 'skill' | 'mcp';
  scope: 'installed' | 'catalog';
  name: string;
  description: string;
  icon: IconName;
  isOfficial?: boolean;
  isEnabled: boolean;
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
}

export function buildUnifiedItems({
  skills,
  mcpServers,
  settingsMcpServers,
  installed,
  catalogInstalled,
}: BuildUnifiedItemsParams): UnifiedExtensionItem[] {
  const list: UnifiedExtensionItem[] = [];
  const addedIds = new Set<string>();

  // 1. 核心官方置顶：外部历史对话接续与导入（支持用户自由卸载与重新安装）
  const isImportUninstalled = isOfficialPluginUninstalled(
    CANONICAL_IMPORT_PLUGIN_ID
  );
  const importItem: InstalledExtension = {
    id: CANONICAL_IMPORT_PLUGIN_ID,
    kind: 'plugin',
    source: 'official',
    name: '外部历史对话接续与导入',
    description: '探测并接续本机 Claude 与 Codex 会话记录，一键导入迁移',
    fromSystem: true,
    installRef: '@crish/plugin-import-claude-codex',
  };
  list.push({
    id: CANONICAL_IMPORT_PLUGIN_ID,
    kind: 'plugin',
    scope: isImportUninstalled ? 'catalog' : 'installed',
    name: importItem.name,
    description: importItem.description,
    icon: 'history',
    isOfficial: true,
    isEnabled: isImportUninstalled
      ? false
      : isPluginEnabled(CANONICAL_IMPORT_PLUGIN_ID),
    installedItem: importItem,
    nativeItem: importItem,
  });
  addedIds.add(CANONICAL_IMPORT_PLUGIN_ID);

  // 2. 本机原生技能
  for (const s of skills) {
    const isEnabled =
      s.activation === 'enabled' || s.activation === 'recommended';
    const id = `local-skill:${s.id}`;
    const inst: InstalledExtension = {
      id,
      kind: 'skill',
      source: s.system ? 'official' : 'local',
      name: s.name,
      description: s.description || '自定义提示词与工作流技能',
      fromSystem: true,
      skillContent: s.content,
      skillRaw: s.raw,
      skillPath: s.filePath,
    };
    list.push({
      id,
      kind: 'skill',
      scope: 'installed',
      name: s.name,
      description: s.description || '自定义提示词与工作流技能',
      icon: 'blocks',
      isEnabled,
      isOfficial: Boolean(s.system),
      rawSkill: s,
      installedItem: inst,
      nativeItem: inst,
    });
    addedIds.add(id);
    addedIds.add(`skill:${s.id}`);
    addedIds.add(`skill:${s.name}`);
  }

  // 3. 本机 MCP 服务
  for (const m of mcpServers) {
    const isOnline = m.status
      ? m.status !== 'disconnected'
      : m.state === 'running' || m.state === 'ready';
    const resolved = resolveMcpTools(m.name || m.id);
    let tools = Array.isArray(m.tools) ? m.tools.map(String) : [];
    if (
      tools.length === 0 ||
      (tools.length < 10 && resolved.length > 10) ||
      ((m.name || m.id || '').toLowerCase().includes('devtools') &&
        tools.length < 30)
    ) {
      if (resolved.length > 0) {
        tools = resolved;
      }
    }
    const id = `local-mcp:${m.id}`;
    const rawMcp: McpServerInfo = {
      ...m,
      status: m.status || (isOnline ? 'connected' : 'disconnected'),
      tools,
      toolCount: tools.length,
    };
    const inst: InstalledExtension = {
      id,
      kind: 'mcp',
      source: 'local',
      name: m.name || m.id,
      description: tools.length > 0 ? `${tools.length} 个工具` : 'MCP 服务',
      fromSystem: true,
      mcpId: m.id,
      mcpTools: tools,
      mcpState: m.state,
    };
    list.push({
      id,
      kind: 'mcp',
      scope: 'installed',
      name: m.name || m.id,
      description: `${tools.length} 个可用工具`,
      icon: 'cpu',
      isEnabled: isOnline,
      rawMcp,
      installedItem: inst,
      nativeItem: inst,
    });
    addedIds.add(id);
    addedIds.add(`mcp:${m.id}`);
    if (m.name) {
      addedIds.add(`local-mcp:${m.name}`);
      addedIds.add(`mcp:${m.name}`);
    }
  }

  // settingsStore MCP 服务合并去重（响应式支持用户通过表单、词法 JSON 或本机扫描添加的 MCP）
  const resolvedSettingsMcp =
    settingsMcpServers ??
    (typeof useSettingsStore !== 'undefined'
      ? useSettingsStore.getState?.()?.mcpServers || []
      : []);

  for (const s of resolvedSettingsMcp) {
    const id = `local-mcp:${s.name}`;
    if (
      addedIds.has(id) ||
      addedIds.has(`mcp:${s.name}`) ||
      (s.id &&
        (addedIds.has(`local-mcp:${s.id}`) ||
          addedIds.has(`mcp:${s.id}`) ||
          addedIds.has(s.id))) ||
      addedIds.has(s.name)
    ) {
      continue;
    }

    const resolved = resolveMcpTools(s.name, s.command, s.args);
    let tools =
      Array.isArray(s.tools) && s.tools.length > 0 ? s.tools.map(String) : [];
    if (
      tools.length === 0 ||
      (tools.length < 10 && resolved.length > 10) ||
      ((s.name || s.id || '').toLowerCase().includes('devtools') &&
        tools.length < 30)
    ) {
      if (resolved.length > 0) {
        tools = resolved;
      }
    }
    const isConnected = s.status !== 'disconnected';

    const rawMcp: McpServerInfo = {
      id: s.id || s.name,
      name: s.name,
      state: isConnected ? 'running' : 'stopped',
      status: s.status || (isConnected ? 'connected' : 'disconnected'),
      tools,
      toolCount: tools.length,
      transport: s.type,
    };

    const inst: InstalledExtension = {
      id,
      kind: 'mcp',
      source: 'local',
      name: s.name,
      description: tools.length > 0 ? `${tools.length} 个工具` : 'MCP 服务',
      detail:
        s.type === 'sse' ? s.url || 'SSE 传输' : s.command || 'stdio 传输',
      fromSystem: false,
      mcpId: s.id || s.name,
      mcpTools: tools,
      mcpTransport: s.type,
      mcpState: rawMcp.state,
    };

    list.push({
      id,
      kind: 'mcp',
      scope: 'installed',
      name: s.name,
      description: `${tools.length} 个可用工具`,
      icon: 'cpu',
      isEnabled: isConnected,
      rawMcp,
      installedItem: inst,
      nativeItem: inst,
    });

    addedIds.add(id);
    addedIds.add(`mcp:${s.name}`);
    if (s.id) {
      addedIds.add(`local-mcp:${s.id}`);
      addedIds.add(`mcp:${s.id}`);
    }
  }

  // 4. 已安装的其他插件（过滤掉导入插件）
  for (const item of installed) {
    if (isImportClaudeCodexPlugin(item)) continue;
    if (item.kind === 'skill' || item.kind === 'mcp') continue;
    if (addedIds.has(item.id)) continue;

    const isEnabled =
      'pluginEnabled' in item
        ? (item as { pluginEnabled?: boolean }).pluginEnabled !== false
        : true;

    list.push({
      id: item.id,
      kind: 'plugin',
      scope: 'installed',
      name: item.name,
      description: item.description || '扩展插件',
      icon: 'puzzle',
      isOfficial: item.source === 'official',
      isEnabled,
      installedItem: item,
      nativeItem: item,
    });
    addedIds.add(item.id);
  }

  // 5. EXTENSION_CATALOG 扩展货架（全生态发现：代码审计助手、文档生成、社区主题包、精选技能与 MCP）
  for (const entry of EXTENSION_CATALOG) {
    if (isImportClaudeCodexPlugin(entry)) continue;
    const isAlreadyInstalled = catalogInstalled.has(entry.id);
    if (addedIds.has(entry.id) || addedIds.has(`${entry.kind}:${entry.name}`))
      continue;

    let icon: IconName = 'puzzle';
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

    list.push({
      id: entry.id,
      kind: entry.kind,
      scope: isAlreadyInstalled ? 'installed' : 'catalog',
      name: entry.name,
      description: entry.description,
      icon,
      isOfficial: entry.source === 'official',
      isEnabled: isAlreadyInstalled,
      installRef: entry.installRef,
      catalogEntry: entry,
      nativeItem: entry,
    });
    addedIds.add(entry.id);
  }

  return list;
}
