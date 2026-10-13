/**
 * 外部 MCP 配置文件检测器（Antigravity / Claude Desktop / Cursor 等）
 *
 * 探测本机与常用 AI 软件的外部 MCP 服务配置：
 * 1. Antigravity: ~/.gemini/antigravity/mcp 子目录及工具定义文件
 * 2. Claude Desktop: %APPDATA%\Claude\claude_desktop_config.json 或 ~/.config/Claude/...
 * 3. Cursor: ~/.cursor/mcp.json
 * 4. 纯 Web / 沙箱无文件权限时回退预置精选默认 MCP
 */

import { tryHomeDir, listDirAny, readTextAny } from '../../api/skillsApiFs';
import { joinPath } from '../../api/skillsApiHelpers';
import { resolveMcpTools, KNOWN_MCP_TOOL_MAP } from './knownMcpTools';

export type DetectedExternalMcpServer = {
  id: string;
  name: string;
  type: 'stdio' | 'sse';
  source: 'antigravity' | 'claude' | 'cursor' | 'other';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  toolsCount?: number;
  tools?: string[];
  description?: string;
};

const ANTIGRAVITY_DESCRIPTIONS: Record<string, string> = {
  'chrome-devtools-mcp': '浏览器自动化与调试工具',
  'cua-driver': '操作系统与原生应用控制驱动',
  'tauri-mcp': 'Tauri 桌面应用自动化控制',
  'tauri-mcp-editor': 'Tauri 编辑器增强工具',
};

export const DEFAULT_MOCK_SERVERS: DetectedExternalMcpServer[] = [
  {
    id: 'antigravity:chrome-devtools-mcp',
    name: 'chrome-devtools-mcp',
    type: 'stdio',
    source: 'antigravity',
    command: 'npx',
    args: ['chrome-devtools-mcp'],
    toolsCount: 30,
    tools: [...(KNOWN_MCP_TOOL_MAP['chrome-devtools-mcp'] || [])],
    description: ANTIGRAVITY_DESCRIPTIONS['chrome-devtools-mcp'],
  },
  {
    id: 'antigravity:cua-driver',
    name: 'cua-driver',
    type: 'stdio',
    source: 'antigravity',
    command: 'node',
    args: ['cua-driver.js'],
    toolsCount: 57,
    tools: [...(KNOWN_MCP_TOOL_MAP['cua-driver'] || [])],
    description: ANTIGRAVITY_DESCRIPTIONS['cua-driver'],
  },
  {
    id: 'antigravity:tauri-mcp',
    name: 'tauri-mcp',
    type: 'stdio',
    source: 'antigravity',
    command: 'node',
    args: ['tauri-mcp.js'],
    toolsCount: 19,
    tools: [...(KNOWN_MCP_TOOL_MAP['tauri-mcp'] || [])],
    description: ANTIGRAVITY_DESCRIPTIONS['tauri-mcp'],
  },
  {
    id: 'antigravity:tauri-mcp-editor',
    name: 'tauri-mcp-editor',
    type: 'stdio',
    source: 'antigravity',
    command: 'node',
    args: ['tauri-mcp-editor.js'],
    toolsCount: 19,
    tools: [...(KNOWN_MCP_TOOL_MAP['tauri-mcp-editor'] || [])],
    description: ANTIGRAVITY_DESCRIPTIONS['tauri-mcp-editor'],
  },
];

const join = (...parts: string[]) => parts.reduce(joinPath);

async function resolveHome(): Promise<string | null> {
  const tauriHome = await tryHomeDir();
  if (tauriHome?.trim()) return tauriHome.trim();
  if (typeof process !== 'undefined' && process.env) {
    const pHome = process.env.USERPROFILE || process.env.HOME;
    if (pHome?.trim()) return pHome.trim();
  }
  return null;
}

function isWindows(home: string): boolean {
  if (typeof process !== 'undefined' && process.platform) {
    return process.platform === 'win32';
  }
  return home.includes('\\') || /^[a-zA-Z]:/.test(home);
}

function safeParseJson(
  content: string
): { mcpServers?: Record<string, Record<string, unknown>> } | null {
  try {
    return JSON.parse(content);
  } catch {
    try {
      const sanitized = content
        .replace(/^\s*\/\/[^\n\r]*/gm, '')
        .replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(sanitized);
    } catch {
      return null;
    }
  }
}

function parseMcpConfigFile(
  content: string,
  source: 'claude' | 'cursor',
  defaultDesc: string
): DetectedExternalMcpServer[] {
  const parsed = safeParseJson(content);
  if (!parsed?.mcpServers || typeof parsed.mcpServers !== 'object') return [];

  return Object.entries(parsed.mcpServers)
    .filter(([_, cfg]) => cfg && typeof cfg === 'object')
    .map(([name, cfg]) => {
      const isSse =
        Boolean(cfg.url) || cfg.type === 'sse' || cfg.transport === 'sse';
      return {
        id: `${source}:${name}`,
        name,
        type: isSse ? 'sse' : 'stdio',
        source,
        command: typeof cfg.command === 'string' ? cfg.command : undefined,
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
        url: typeof cfg.url === 'string' ? cfg.url : undefined,
        env:
          cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)
            ? (cfg.env as Record<string, string>)
            : undefined,
        description:
          typeof cfg.description === 'string' ? cfg.description : defaultDesc,
      };
    });
}

async function detectAntigravityMcp(
  home: string
): Promise<DetectedExternalMcpServer[]> {
  const mcpDir = join(home, '.gemini', 'antigravity', 'mcp');
  const entries = await listDirAny(mcpDir);
  if (!entries?.length) return [];

  const list: DetectedExternalMcpServer[] = [];
  for (const entry of entries) {
    if (
      (!entry.isDir && !(entry.name in ANTIGRAVITY_DESCRIPTIONS)) ||
      entry.name.startsWith('.')
    ) {
      continue;
    }
    const subFiles = await listDirAny(entry.path);
    const jsonFiles = subFiles.filter(
      (f) => !f.isDir && f.name.toLowerCase().endsWith('.json')
    );
    let tools = jsonFiles.map((f) => f.name.replace(/\.json$/i, ''));
    if (tools.length === 0) {
      tools = resolveMcpTools(entry.name);
    }
    const toolsCount =
      jsonFiles.length > 0
        ? jsonFiles.length
        : tools.length > 0
          ? tools.length
          : 0;
    const isNpx = entry.name.includes('chrome') || entry.name.includes('npx');
    list.push({
      id: `antigravity:${entry.name}`,
      name: entry.name,
      type: 'stdio',
      source: 'antigravity',
      command: isNpx ? 'npx' : 'node',
      args: isNpx ? [entry.name] : [`${entry.name}.js`],
      tools,
      toolsCount,
      description:
        ANTIGRAVITY_DESCRIPTIONS[entry.name] || 'Antigravity 本地 MCP 扩展服务',
    });
  }
  return list;
}

async function detectClaudeMcp(
  home: string
): Promise<DetectedExternalMcpServer[]> {
  const appData =
    (typeof process !== 'undefined' && process.env?.APPDATA) ||
    join(home, 'AppData', 'Roaming');
  const configPath = isWindows(home)
    ? join(appData, 'Claude', 'claude_desktop_config.json')
    : join(home, '.config', 'Claude', 'claude_desktop_config.json');
  const raw = await readTextAny(configPath);
  return raw
    ? parseMcpConfigFile(raw, 'claude', 'Claude Desktop MCP 服务')
    : [];
}

async function detectCursorMcp(
  home: string
): Promise<DetectedExternalMcpServer[]> {
  const configPath = join(home, '.cursor', 'mcp.json');
  const raw = await readTextAny(configPath);
  return raw ? parseMcpConfigFile(raw, 'cursor', 'Cursor 本地 MCP 服务') : [];
}

/**
 * 探测本机与常用宿主的外部 MCP 配置文件
 * 优先读取真实 FS；在纯 Web / 沙箱无文件权限时返回默认精选 MCP 项
 */
export async function detectExternalMcpServers(): Promise<
  DetectedExternalMcpServer[]
> {
  const home = await resolveHome();
  if (!home) return DEFAULT_MOCK_SERVERS;

  try {
    const [antigravity, claude, cursor] = await Promise.all([
      detectAntigravityMcp(home).catch(() => []),
      detectClaudeMcp(home).catch(() => []),
      detectCursorMcp(home).catch(() => []),
    ]);
    const all = [...antigravity, ...claude, ...cursor];
    return all.length > 0 ? all : DEFAULT_MOCK_SERVERS;
  } catch {
    return DEFAULT_MOCK_SERVERS;
  }
}
