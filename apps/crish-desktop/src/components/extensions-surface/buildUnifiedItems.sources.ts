import type { IconName } from '@/components/ui/icons';
import type { DesktopSkill } from '../../api/skillsApi';
import type { McpServerInfo } from '../../api/mcpApi';
import type { McpServer } from '../../api/clientApi';
import type { InstalledExtension } from '../../api/extensionCatalog';
import type { CustomPluginItem } from './customPluginStorage';
import type { UnifiedExtensionItem } from './buildUnifiedItems';
import { useSettingsStore } from '../../store/storeAccess';
import { isPluginEnabled } from '../settings-extensions/pluginRegistryAdapter';
import { resolveMcpTools } from './McpConnectModal';

/**
 * 外部来源探测与「本机发现条目」构建（从 buildUnifiedItems.ts 拆分而来，行为不变）：
 * - detectPlatformMeta / normalizeTools：平台元信息探测与工具清单归一；
 * - build*Item：技能 / Engine MCP / settingsStore MCP / 自定义插件的统一条目装配。
 */

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

/** 归一 MCP 工具清单：优先使用静态解析结果补齐/升级上报的工具数组 */
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

/**
 * settingsStore MCP 服务读取面（显式入参优先，否则回落到 settings store 快照）
 */
export function resolveSettingsMcpServers(
  settingsMcpServers?: McpServer[]
): McpServer[] {
  return (
    settingsMcpServers ??
    (typeof useSettingsStore !== 'undefined'
      ? useSettingsStore.getState?.()?.mcpServers || []
      : [])
  );
}

/** 本机原生技能 → 统一条目 */
export function buildLocalSkillItem(s: DesktopSkill): UnifiedExtensionItem {
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
  return {
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
  };
}

/** 本机 MCP 服务（Engine 上报）→ 统一条目 */
export function buildEngineMcpItem(m: McpServerInfo): UnifiedExtensionItem {
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
  return {
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
  };
}

/** settingsStore MCP 服务（表单/词法 JSON/外部导入）→ 统一条目 */
export function buildSettingsMcpItem(s: McpServer): UnifiedExtensionItem {
  const id = `local-mcp:${s.name}`;
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
    detail: s.type === 'sse' ? s.url || 'SSE 传输' : s.command || 'stdio 传输',
    fromSystem: false,
    mcpId: s.id || s.name,
    mcpTools: tools,
    mcpTransport: s.type,
    mcpState: rawMcp.state,
  };

  return {
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
  };
}

/** 用户自定义插件（customPlugins）→ 统一条目 */
export function buildCustomPluginItem(
  cp: CustomPluginItem
): UnifiedExtensionItem {
  const id = `custom-plugin:${cp.id}`;
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
  return {
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
  };
}
