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
import type { CustomPluginItem } from './customPluginStorage';
import { useSettingsStore } from '../../store/storeAccess';
import { isPluginEnabled } from '../settings-extensions/pluginRegistryAdapter';
import { resolveMcpTools } from './McpConnectModal';

export type PlatformSource = 'Claude Code' | 'Codex' | 'Antigravity' | 'Cursor';

export interface PlatformMetadata {
  platform: PlatformSource;
  source: PlatformSource;
  icon: IconName;
  descriptionPrefix: string;
}

/**
 * 探测项目是否来自外部主流 Agent 客户端与生态（Claude Code / Codex / Antigravity / Cursor）
 */
export function detectPlatformMeta(item: {
  id?: string;
  name?: string;
  source?: string;
  filePath?: string;
  installRef?: string;
  command?: string;
  detail?: string;
  description?: string;
}): PlatformMetadata | null {
  const rawSource = (item.source || '').trim().toLowerCase();
  const text =
    `${item.id || ''} ${item.name || ''} ${item.filePath || ''} ${item.installRef || ''} ${item.command || ''} ${item.detail || ''}`.toLowerCase();

  // 1. Antigravity
  if (
    rawSource === 'antigravity' ||
    text.includes('antigravity') ||
    text.includes('.gemini')
  ) {
    return {
      platform: 'Antigravity',
      source: 'Antigravity',
      icon: 'sparkles',
      descriptionPrefix: '来自 Antigravity 的',
    };
  }

  // 2. Claude Code (含 Claude / Claude Desktop)
  if (
    rawSource === 'claude code' ||
    rawSource === 'claude-code' ||
    rawSource === 'claude desktop' ||
    rawSource === 'claude' ||
    text.includes('claude-code') ||
    text.includes('claude code') ||
    text.includes('claude_desktop') ||
    text.includes('.claude') ||
    (text.includes('claude') && !text.includes('import-claude-codex'))
  ) {
    return {
      platform: 'Claude Code',
      source: 'Claude Code',
      icon: 'bot',
      descriptionPrefix: '来自 Claude Code 的',
    };
  }

  // 3. Codex
  if (
    rawSource === 'codex' ||
    rawSource === 'openai codex' ||
    text.includes('.codex') ||
    (text.includes('codex') && !text.includes('import-claude-codex'))
  ) {
    return {
      platform: 'Codex',
      source: 'Codex',
      icon: 'terminal',
      descriptionPrefix: '来自 Codex 的',
    };
  }

  // 4. Cursor
  if (
    rawSource === 'cursor' ||
    text.includes('.cursor') ||
    text.includes('cursor')
  ) {
    return {
      platform: 'Cursor',
      source: 'Cursor',
      icon: 'code',
      descriptionPrefix: '来自 Cursor 的',
    };
  }

  return null;
}

function normalizeTools(
  name: string,
  rawTools: unknown,
  cmd?: string,
  args?: string[]
): string[] {
  const resolved = resolveMcpTools(name, cmd, args);
  let tools = Array.isArray(rawTools) ? rawTools.map(String) : [];
  if (
    tools.length === 0 ||
    (tools.length < 10 && resolved.length > 10) ||
    ((name || '').toLowerCase().includes('devtools') && tools.length < 30)
  ) {
    if (resolved.length > 0) tools = resolved;
  }
  return tools;
}

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
    const isEnabled =
      s.activation === 'enabled' || s.activation === 'recommended';
    const id = `local-skill:${s.id}`;
    const meta = detectPlatformMeta({
      id: s.id,
      name: s.name,
      filePath: s.filePath,
      description: s.description,
      source: (s as unknown as { source?: string }).source,
    });
    const source = meta ? meta.source : s.system ? 'official' : 'local';
    const icon: IconName = meta ? meta.icon : 'blocks';
    const description =
      s.description ||
      (meta
        ? `${meta.descriptionPrefix}工作流与提示词技能`
        : '自定义提示词与工作流技能');

    const inst: InstalledExtension = {
      id,
      kind: 'skill',
      source: meta
        ? (meta.source as unknown as InstalledExtension['source'])
        : s.system
          ? 'official'
          : 'local',
      name: s.name,
      description,
      fromSystem: true,
      skillContent: s.content,
      skillRaw: s.raw,
      skillPath: s.filePath,
    };
    list.push({
      id,
      kind: 'skill',
      scope: 'installed',
      source,
      name: s.name,
      description,
      icon,
      isEnabled,
      isInstalled: true,
      isOfficial: Boolean(s.system),
      rawSkill: s,
      installedItem: inst,
      nativeItem: inst,
    });
    addedIds.add(id);
    addedIds.add(`skill:${s.id}`);
    addedIds.add(`skill:${s.name}`);
  }

  // 3. 本机 MCP 服务（Engine 上报）
  for (const m of mcpServers) {
    const isOnline = m.status
      ? m.status !== 'disconnected'
      : m.state === 'running' || m.state === 'ready';
    const tools = normalizeTools(m.name || m.id, m.tools);
    const meta = detectPlatformMeta({
      id: m.id,
      name: m.name,
      source: (m as unknown as { source?: string }).source,
      detail: (m as unknown as { detail?: string }).detail,
    });
    const source = meta
      ? meta.source
      : (m as unknown as { source?: string }).source || 'local';
    const icon: IconName = meta ? meta.icon : 'cpu';
    const description =
      tools.length > 0
        ? `${tools.length} 个可用工具`
        : meta
          ? `${meta.descriptionPrefix} MCP 服务`
          : 'MCP 服务';

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
      source: meta
        ? (meta.source as unknown as InstalledExtension['source'])
        : 'local',
      name: m.name || m.id,
      description: tools.length > 0 ? `${tools.length} 个工具` : description,
      fromSystem: true,
      mcpId: m.id,
      mcpTools: tools,
      mcpState: m.state,
    };
    list.push({
      id,
      kind: 'mcp',
      scope: 'installed',
      source,
      name: m.name || m.id,
      description,
      icon,
      isEnabled: isOnline,
      isInstalled: true,
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

  // 3.5. settingsStore MCP 服务合并去重（表单/词法 JSON/外部导入）
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

    const tools = normalizeTools(s.name, s.tools, s.command, s.args);
    const isConnected = s.status !== 'disconnected';
    const meta = detectPlatformMeta({
      id: s.id,
      name: s.name,
      command: s.command,
      source: (s as unknown as { source?: string }).source,
      detail: s.url,
    });
    const source = meta
      ? meta.source
      : (s as unknown as { source?: string }).source || 'local';
    const icon: IconName = meta ? meta.icon : 'cpu';
    const description =
      tools.length > 0
        ? `${tools.length} 个可用工具`
        : meta
          ? `${meta.descriptionPrefix} MCP 服务`
          : 'MCP 服务';

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
      source: meta
        ? (meta.source as unknown as InstalledExtension['source'])
        : 'local',
      name: s.name,
      description: tools.length > 0 ? `${tools.length} 个工具` : description,
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
      source,
      name: s.name,
      description,
      icon,
      isEnabled: isConnected,
      isInstalled: true,
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

  // 4. 用户自定义插件（customPlugins）
  if (customPlugins && customPlugins.length > 0) {
    for (const cp of customPlugins) {
      const id = `custom-plugin:${cp.id}`;
      if (addedIds.has(id) || addedIds.has(cp.id)) continue;

      const meta = detectPlatformMeta({
        id: cp.id,
        name: cp.name,
        description: cp.description,
      });
      const source = meta ? meta.source : 'local';
      const icon: IconName = meta ? meta.icon : 'puzzle';
      const description =
        cp.description ||
        (meta ? `${meta.descriptionPrefix}自定义扩展插件` : '自定义扩展插件');

      const inst: InstalledExtension = {
        id,
        kind: 'plugin',
        source: meta
          ? (meta.source as unknown as InstalledExtension['source'])
          : 'local',
        name: cp.name,
        description,
        fromSystem: false,
        detail: cp.version ? `v${cp.version}` : undefined,
      };
      list.push({
        id,
        kind: 'plugin',
        scope: 'installed',
        source,
        name: cp.name,
        description,
        icon,
        isOfficial: false,
        isEnabled: isPluginEnabled(id),
        isInstalled: true,
        installedItem: inst,
        nativeItem: inst,
      });
      addedIds.add(id);
    }
  }

  // 5. 已安装的其他扩展项（InstalledExtension 列表）
  for (const item of installed) {
    if (isImportClaudeCodexPlugin(item)) continue;
    if (addedIds.has(item.id)) continue;

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
        (c.name.toLowerCase() === item.name.toLowerCase() &&
          c.kind === item.kind)
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

    list.push({
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
    });
    addedIds.add(item.id);
  }

  // 6. EXTENSION_CATALOG 扩展货架（全生态发现：官方插件与货架生态条目全量展示）
  for (const entry of EXTENSION_CATALOG) {
    if (isImportClaudeCodexPlugin(entry)) continue;

    const existing = list.find(
      (it) =>
        it.id === entry.id ||
        (it.name.toLowerCase() === entry.name.toLowerCase() &&
          it.kind === entry.kind)
    );
    if (existing) {
      existing.scope = 'both';
      existing.catalogEntry = existing.catalogEntry || entry;
      existing.isInstalled = true;
      if (!existing.installRef && entry.installRef) {
        existing.installRef = entry.installRef;
      }
      continue;
    }

    if (addedIds.has(entry.id) || addedIds.has(`${entry.kind}:${entry.name}`))
      continue;

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

    list.push({
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
    });
    addedIds.add(entry.id);
  }

  return list;
}
