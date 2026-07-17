/**
 * 扩展中心：插件 / MCP / 技能 的发现目录 + 本机已安装合并用类型。
 * 目录为官方/三方策展数据（后续可换接口）；安装态写入 localStorage。
 */

export type ExtensionKind = 'plugin' | 'mcp' | 'skill';
export type ExtensionSource = 'official' | 'community' | 'local';

export type CatalogEntry = {
  id: string;
  kind: ExtensionKind;
  source: ExtensionSource;
  name: string;
  description: string;
  /** 安装源：npm / 路径提示 / MCP 命令等 */
  installRef: string;
  tags?: string[];
};

export type InstalledExtension = {
  id: string;
  kind: ExtensionKind;
  source: ExtensionSource;
  name: string;
  description: string;
  /** 展示副文案（路径 / 状态 / 包名） */
  detail?: string;
  /** 是否来自本机扫描（技能目录、引擎 MCP 等） */
  fromSystem?: boolean;
  /** 技能详情：SKILL.md 正文 / 原文 */
  skillContent?: string;
  skillRaw?: string;
  skillPath?: string;
  /** MCP 详情：工具名列表 + 服务 id */
  mcpId?: string;
  mcpTools?: string[];
  mcpTransport?: string;
  mcpState?: string;
  /** 插件 / 目录安装引用 */
  installRef?: string;
};

/**
 * MCP 工具禁用：以 clientApi settings.mcpDisabledTools 为准（本机持久化 + run-task 下发引擎）。
 * 同步镜像一份到 sessionStorage 供同步读；写入必须走 persistMcpToolDisabled。
 */
const MCP_TOOL_DISABLED_CACHE = 'crish_mcp_tool_disabled_cache_v1';

export function loadMcpToolDisabled(): Record<string, string[]> {
  try {
    const raw = sessionStorage.getItem(MCP_TOOL_DISABLED_CACHE);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        const out: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
          if (Array.isArray(v)) out[k] = v.map(String).filter(Boolean);
        }
        return out;
      }
    }
  } catch {
    /* fall through */
  }
  return {};
}

export function cacheMcpToolDisabled(map: Record<string, string[]>): void {
  try {
    sessionStorage.setItem(MCP_TOOL_DISABLED_CACHE, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function isMcpToolDisabled(serverId: string, tool: string): boolean {
  return (loadMcpToolDisabled()[serverId] || []).includes(tool);
}

/** 更新缓存并返回新 map（调用方负责 saveSettingsEx） */
export function applyMcpToolDisabled(
  map: Record<string, string[]>,
  serverId: string,
  tool: string,
  disabled: boolean,
): Record<string, string[]> {
  const next: Record<string, string[]> = { ...map };
  const cur = new Set(next[serverId] || []);
  if (disabled) cur.add(tool);
  else cur.delete(tool);
  if (cur.size === 0) delete next[serverId];
  else next[serverId] = [...cur];
  cacheMcpToolDisabled(next);
  return next;
}

const INSTALLED_CATALOG_KEY = 'crish_extension_catalog_installed_v1';

/** 官方 + 三方策展（不预装，仅展示；安装后记入 INSTALLED_CATALOG_KEY） */
export const EXTENSION_CATALOG: readonly CatalogEntry[] = [
  // —— 官方插件 ——
  {
    id: 'plugin:conex-audit',
    kind: 'plugin',
    source: 'official',
    name: '代码审计助手',
    description: '工作区变更扫描、风险提示与提交前检查清单',
    installRef: '@conex/plugin-audit',
    tags: ['官方', '质量'],
  },
  {
    id: 'plugin:conex-docs',
    kind: 'plugin',
    source: 'official',
    name: '文档生成',
    description: '从会话与 diff 生成变更说明 / README 片段',
    installRef: '@conex/plugin-docs',
    tags: ['官方', '文档'],
  },
  // —— 三方插件 ——
  {
    id: 'plugin:community-theme-pack',
    kind: 'plugin',
    source: 'community',
    name: '社区主题包',
    description: '额外浅色 / 深色主题与字体预设',
    installRef: 'github:conex-community/theme-pack',
    tags: ['三方', '外观'],
  },
  // —— 官方 MCP ——
  {
    id: 'mcp:filesystem',
    kind: 'mcp',
    source: 'official',
    name: 'Filesystem',
    description: '安全范围内的文件读写与目录浏览（stdio）',
    installRef: 'npx -y @modelcontextprotocol/server-filesystem',
    tags: ['官方', '文件'],
  },
  {
    id: 'mcp:github',
    kind: 'mcp',
    source: 'official',
    name: 'GitHub',
    description: 'Issue / PR / 仓库检索（需 token）',
    installRef: 'npx -y @modelcontextprotocol/server-github',
    tags: ['官方', '协作'],
  },
  {
    id: 'mcp:memory',
    kind: 'mcp',
    source: 'community',
    name: 'Memory',
    description: '跨会话知识片段记忆（社区实现）',
    installRef: 'npx -y @modelcontextprotocol/server-memory',
    tags: ['三方', '记忆'],
  },
  // —— 官方 / 常见技能 ——
  {
    id: 'skill:git-pr',
    kind: 'skill',
    source: 'official',
    name: 'Git PR 助手',
    description: '整理提交说明、生成 PR 描述与检查清单',
    installRef: 'skill:git-pr',
    tags: ['官方', 'Git'],
  },
  {
    id: 'skill:code-review',
    kind: 'skill',
    source: 'official',
    name: '代码审阅',
    description: '按项目规则审阅 diff，输出问题分级',
    installRef: 'skill:code-review',
    tags: ['官方', '质量'],
  },
  {
    id: 'skill:docx',
    kind: 'skill',
    source: 'community',
    name: 'Word 文档',
    description: '读写与生成 .docx（社区 skill）',
    installRef: 'skill:docx',
    tags: ['三方', '文档'],
  },
  {
    id: 'skill:web-research',
    kind: 'skill',
    source: 'community',
    name: '网页调研',
    description: '结构化检索与摘要（需网络权限）',
    installRef: 'skill:web-research',
    tags: ['三方', '检索'],
  },
] as const;

export function kindLabel(kind: ExtensionKind): string {
  if (kind === 'plugin') return '插件';
  if (kind === 'mcp') return 'MCP';
  return '技能';
}

export function sourceLabel(source: ExtensionSource): string {
  if (source === 'official') return '官方';
  if (source === 'community') return '三方';
  return '本机';
}

export function loadCatalogInstalledIds(): Set<string> {
  try {
    const raw = localStorage.getItem(INSTALLED_CATALOG_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map(String).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function saveCatalogInstalledIds(ids: Set<string>): void {
  try {
    localStorage.setItem(INSTALLED_CATALOG_KEY, JSON.stringify([...ids]));
  } catch {
    /* quota */
  }
}

export function markCatalogInstalled(id: string): void {
  const s = loadCatalogInstalledIds();
  s.add(id);
  saveCatalogInstalledIds(s);
}

export function unmarkCatalogInstalled(id: string): void {
  const s = loadCatalogInstalledIds();
  s.delete(id);
  saveCatalogInstalledIds(s);
}

export function isCatalogInstalled(id: string): boolean {
  return loadCatalogInstalledIds().has(id);
}
