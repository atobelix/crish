import type { DetectedExternalMcpServer } from './detectExternalMcpServers';
import type { DetectedExternalSkill } from './detectExternalSkills';

/** 外部导入分类：MCP 服务 / 技能 */
export type ImportCategory = 'mcp' | 'skill';

/** 工作台列表项：MCP 服务与技能的统一展示模型 */
export interface ExternalImportItem {
  id: string;
  kind: 'mcp' | 'skill';
  source:
    | 'Claude Code'
    | 'Codex'
    | 'Antigravity'
    | 'Claude Desktop'
    | 'Cursor'
    | '本地'
    | 'Local';
  name: string;
  description: string;
  rawMcp?: DetectedExternalMcpServer;
  rawSkill?: DetectedExternalSkill;
}

/** 按当前分类把探测结果整形成统一列表项（纯数据整形，无副作用） */
export function buildImportItems(
  activeCategory: ImportCategory,
  mcpList: DetectedExternalMcpServer[],
  skillsList: DetectedExternalSkill[]
): ExternalImportItem[] {
  if (activeCategory === 'mcp') {
    return mcpList.map((m) => ({
      id: `mcp:${m.source}:${m.name}`,
      kind: 'mcp' as const,
      source: m.source,
      name: m.name,
      description: m.description || `${m.command || 'mcp'} 外部服务`,
      rawMcp: m,
    }));
  }
  return skillsList.map((s) => ({
    id: `skill:${s.source}:${s.name}`,
    kind: 'skill' as const,
    source: s.source === 'Local' ? '本地' : s.source,
    name: s.name,
    description: s.description || '外部扩展技能',
    rawSkill: s,
  }));
}
