import {
  EXTENSION_CATALOG,
  type InstalledExtension,
} from '../../api/extensionCatalog';
import type { PackageSource } from '../../api/clientApi';
import type { DesktopSkill } from '../../api/skillsApi';
import type { McpServerInfo } from '../../api/mcpApi';
import type { PluginCardState } from './pluginRegistryAdapter';
import type { PluginInstalledExtension } from './types';

function packageName(pkg: string | PackageSource): string {
  return typeof pkg === 'string' ? pkg : pkg.source;
}

export { packageName };

/** 由本地来源（skills/mcp/packages/plugins/catalog）合并出已安装列表（03-detail T10 拆分） */
export function buildInstalledExtensions({
  skills,
  mcpServers,
  packages,
  catalogInstalled,
  plugins,
}: {
  skills: DesktopSkill[];
  mcpServers: McpServerInfo[];
  packages: (string | PackageSource)[];
  catalogInstalled: Set<string>;
  plugins: PluginCardState[];
}): InstalledExtension[] {
  const out: InstalledExtension[] = [];

  for (const s of skills) {
    out.push({
      id: `local-skill:${s.id}`,
      kind: 'skill',
      source: s.system ? 'official' : 'local',
      name: s.name,
      description: s.description || '本机技能',
      fromSystem: true,
      skillContent: s.content,
      skillRaw: s.raw,
      skillPath: s.filePath,
    });
  }

  for (const m of mcpServers) {
    const tools = Array.isArray(m.tools) ? m.tools.map(String) : [];
    out.push({
      id: `local-mcp:${m.id}`,
      kind: 'mcp',
      source: 'local',
      name: m.name || m.id,
      description:
        tools.length > 0
          ? `${tools.length} 个工具`
          : m.transport
            ? String(m.transport)
            : 'MCP 服务',
      fromSystem: true,
      mcpId: m.id,
      mcpTools: tools,
      ...(m.transport !== undefined && { mcpTransport: m.transport }),
      mcpState: m.state,
    });
  }

  packages.forEach((pkg, idx) => {
    const name = packageName(pkg);
    out.push({
      id: `local-plugin:${idx}:${name}`,
      kind: 'plugin',
      source: 'local',
      name,
      description: '已安装的扩展包，在工作区工具链中可用',
      fromSystem: true,
      installRef: name,
    });
  });

  for (const p of plugins) {
    const already = out.some(
      (x) =>
        x.kind === 'plugin' &&
        (x.name.toLowerCase() === p.name.toLowerCase() ||
          x.id === `plugin:${p.id}`)
    );
    if (already) continue;
    const item: PluginInstalledExtension = {
      id: `plugin:${p.id}`,
      kind: 'plugin',
      source: p.source,
      name: p.name,
      description: p.description,
      fromSystem: p.fromSystem,
      installRef: p.installRef,
      pluginId: p.id,
      pluginVersion: p.version,
      pluginTools: p.declaredTools,
      pluginHooks: p.declaredHooks,
      pluginTrustLevel: p.trustLevel,
      pluginEnabled: p.enabled,
    };
    out.push(item);
  }

  for (const entry of EXTENSION_CATALOG) {
    if (!catalogInstalled.has(entry.id)) continue;
    const already = out.some(
      (x) =>
        x.name.toLowerCase() === entry.name.toLowerCase() &&
        x.kind === entry.kind
    );
    if (already) continue;
    out.push({
      id: entry.id,
      kind: entry.kind,
      source: entry.source,
      name: entry.name,
      description: entry.description,
      fromSystem: false,
      installRef: entry.installRef,
    });
  }

  return out;
}
