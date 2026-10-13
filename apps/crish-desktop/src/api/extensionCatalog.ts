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

function loadMcpToolDisabled(): Record<string, string[]> {
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
  disabled: boolean
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

/** 官方 + 三方策展（仅展示真实落地的扩展生态，杜绝虚假占位 Mock 项） */
export const EXTENSION_CATALOG: readonly CatalogEntry[] = [];

export function kindLabel(kind: ExtensionKind): string {
  if (kind === 'plugin') return '插件';
  if (kind === 'mcp') return 'MCP';
  return '技能';
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

function saveCatalogInstalledIds(ids: Set<string>): void {
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

const UNINSTALLED_OFFICIAL_KEY = 'crish_official_plugins_uninstalled_v1';

export function isOfficialPluginUninstalled(id: string): boolean {
  try {
    const raw = localStorage.getItem(UNINSTALLED_OFFICIAL_KEY);
    if (!raw) return false;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.includes(id);
  } catch {
    return false;
  }
}

export function setOfficialPluginUninstalled(
  id: string,
  uninstalled: boolean
): void {
  try {
    const raw = localStorage.getItem(UNINSTALLED_OFFICIAL_KEY);
    const arr: string[] = raw ? JSON.parse(raw) : [];
    const set = new Set(Array.isArray(arr) ? arr : []);
    if (uninstalled) set.add(id);
    else set.delete(id);
    localStorage.setItem(UNINSTALLED_OFFICIAL_KEY, JSON.stringify([...set]));
  } catch {
    /* quota */
  }
}
