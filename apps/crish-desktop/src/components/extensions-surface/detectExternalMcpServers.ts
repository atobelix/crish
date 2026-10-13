/**
 * 扫描并探测本机其他应用（Antigravity、Claude Desktop、Cursor）中已安装的 MCP 服务
 */

import { invokeResult } from '../../api/tauriInvoke';
import { resolveMcpTools } from './knownMcpTools';

export interface DetectedExternalMcpServer {
  id: string;
  source: 'Antigravity' | 'Claude Desktop' | 'Cursor';
  name: string;
  type: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  description?: string;
  tools?: string[];
  toolsCount?: number;
  rawConfig?: unknown;
}

interface ExternalScanTarget {
  source: 'Antigravity' | 'Claude Desktop' | 'Cursor';
  paths: (dirs: { home?: string; appData?: string }) => string[];
}

const SCAN_TARGETS: ExternalScanTarget[] = [
  {
    source: 'Antigravity',
    paths: ({ home }) =>
      home
        ? [
            `${home}/.gemini/config/mcp_config.json`.replace(/\\/g, '/'),
            `${home}/.gemini/antigravity/mcp_config.json`.replace(/\\/g, '/'),
            `${home}/.gemini/antigravity-ide/mcp_config.json`.replace(
              /\\/g,
              '/'
            ),
          ]
        : [],
  },
  {
    source: 'Claude Desktop',
    paths: ({ home, appData }) => [
      ...(appData
        ? [`${appData}/Claude/claude_desktop_config.json`.replace(/\\/g, '/')]
        : []),
      ...(home
        ? [
            `${home}/AppData/Roaming/Claude/claude_desktop_config.json`.replace(
              /\\/g,
              '/'
            ),
            `${home}/Library/Application Support/Claude/claude_desktop_config.json`.replace(
              /\\/g,
              '/'
            ),
            `${home}/.config/Claude/claude_desktop_config.json`.replace(
              /\\/g,
              '/'
            ),
          ]
        : []),
    ],
  },
  {
    source: 'Cursor',
    paths: ({ home, appData }) => [
      ...(home ? [`${home}/.cursor/mcp.json`.replace(/\\/g, '/')] : []),
      ...(appData
        ? [
            `${appData}/Cursor/User/globalStorage/rooveterinaryinc.cursor-mcp/config.json`.replace(
              /\\/g,
              '/'
            ),
          ]
        : []),
      ...(home
        ? [
            `${home}/AppData/Roaming/Cursor/User/globalStorage/rooveterinaryinc.cursor-mcp/config.json`.replace(
              /\\/g,
              '/'
            ),
            `${home}/Library/Application Support/Cursor/User/globalStorage/rooveterinaryinc.cursor-mcp/config.json`.replace(
              /\\/g,
              '/'
            ),
            `${home}/.config/Cursor/User/globalStorage/rooveterinaryinc.cursor-mcp/config.json`.replace(
              /\\/g,
              '/'
            ),
          ]
        : []),
    ],
  },
];

async function resolveSystemDirs(): Promise<{
  home?: string;
  appData?: string;
}> {
  let home: string | undefined;
  let appData: string | undefined;

  try {
    const pathApi = await (
      import(/* @vite-ignore */ '@tauri-apps/api/path') as Promise<{
        homeDir?: () => Promise<string>;
        appDataDir?: () => Promise<string>;
      } | null>
    ).catch(() => null);

    if (pathApi?.homeDir) {
      const h = await pathApi.homeDir();
      if (h && h.trim()) home = h.trim();
    }
  } catch {
    // ignore
  }

  if (typeof process !== 'undefined' && process.env) {
    const pe = process.env as Record<string, string | undefined>;
    if (!home) home = pe.USERPROFILE || pe.HOME;
    if (!appData) appData = pe.APPDATA;
  }

  return { home, appData };
}

function parseMcpJson(
  rawJson: string,
  source: 'Antigravity' | 'Claude Desktop' | 'Cursor'
): DetectedExternalMcpServer[] {
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== 'object') return [];

    const serversMap =
      parsed.mcpServers ||
      parsed.servers ||
      (parsed.command || parsed.url ? { default: parsed } : parsed);

    if (
      !serversMap ||
      typeof serversMap !== 'object' ||
      Array.isArray(serversMap)
    ) {
      return [];
    }

    const results: DetectedExternalMcpServer[] = [];
    for (const [key, value] of Object.entries(serversMap)) {
      if (!value || typeof value !== 'object') continue;
      const val = value as Record<string, unknown>;

      const command = typeof val.command === 'string' ? val.command : undefined;
      const url = typeof val.url === 'string' ? val.url : undefined;
      if (!command && !url) continue;

      const type: 'stdio' | 'sse' = url ? 'sse' : 'stdio';
      const args = Array.isArray(val.args) ? val.args.map(String) : undefined;
      const env =
        val.env && typeof val.env === 'object' && !Array.isArray(val.env)
          ? (val.env as Record<string, string>)
          : undefined;

      const resolvedTools = resolveMcpTools(key, command, args);
      results.push({
        id: `detected-${source.toLowerCase().replace(/\s+/g, '-')}-${key}`,
        source,
        name: key,
        type,
        command,
        args,
        env,
        url,
        description:
          typeof val.description === 'string' ? val.description : undefined,
        tools: resolvedTools.length > 0 ? resolvedTools : undefined,
        toolsCount: resolvedTools.length > 0 ? resolvedTools.length : undefined,
        rawConfig: val,
      });
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * 扫描本机其他已安装客户端的 MCP 配置文件并返回发现的服务列表
 */
export async function detectExternalMcpServers(): Promise<
  DetectedExternalMcpServer[]
> {
  const dirs = await resolveSystemDirs();
  const foundMap = new Map<string, DetectedExternalMcpServer>();

  for (const target of SCAN_TARGETS) {
    const candidatePaths = target.paths(dirs);
    for (const filePath of candidatePaths) {
      try {
        const res = await invokeResult<{ content?: string }>(
          'workbench_read_file_content',
          {
            path: filePath,
            maxLines: 5000,
          }
        );

        if (res.status === 'ok' && res.data?.content) {
          const list = parseMcpJson(res.data.content, target.source);
          for (const item of list) {
            const dedupeKey = `${target.source}:${item.name}`;
            if (!foundMap.has(dedupeKey)) {
              foundMap.set(dedupeKey, item);
            }
          }
        }
      } catch {
        // 继续探测下一个路径
      }
    }
  }

  // 探测 Antigravity 本地 MCP 扩展目录 (~/.gemini/antigravity/mcp)
  if (dirs.home) {
    try {
      const mcpDir = `${dirs.home}/.gemini/antigravity/mcp`.replace(/\\/g, '/');
      const res = await invokeResult<{
        items?: Array<{ name: string; is_dir?: boolean; isDir?: boolean }>;
      }>('workbench_list_directory', { path: mcpDir });
      if (res.status === 'ok' && Array.isArray(res.data?.items)) {
        for (const item of res.data.items) {
          if (!(item.is_dir ?? item.isDir) || item.name.startsWith('.'))
            continue;
          const tools = resolveMcpTools(item.name);
          const isNpx =
            item.name.includes('chrome') || item.name.includes('npx');
          const dedupeKey = `Antigravity:${item.name}`;
          if (!foundMap.has(dedupeKey)) {
            foundMap.set(dedupeKey, {
              id: `antigravity:${item.name}`,
              source: 'Antigravity',
              name: item.name,
              type: 'stdio',
              command: isNpx ? 'npx' : 'node',
              args: isNpx ? [item.name] : [`${item.name}.js`],
              tools,
              toolsCount: tools.length,
              description:
                item.name === 'chrome-devtools-mcp'
                  ? '浏览器自动化与调试工具'
                  : 'Antigravity 本地 MCP 扩展服务',
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return Array.from(foundMap.values());
}

export const DEFAULT_FALLBACK_MCP: DetectedExternalMcpServer[] = [
  {
    id: 'antigravity:chrome-devtools-mcp',
    name: 'chrome-devtools-mcp',
    source: 'Antigravity',
    type: 'stdio',
    command: 'npx',
    args: ['chrome-devtools-mcp'],
    tools: resolveMcpTools('chrome-devtools-mcp'),
    toolsCount: 30,
    description: '浏览器自动化、无头渲染与实时 DOM/网络调试',
  },
  {
    id: 'antigravity:cua-driver',
    name: 'cua-driver',
    source: 'Antigravity',
    type: 'stdio',
    command: 'node',
    args: ['cua-driver.js'],
    tools: resolveMcpTools('cua-driver'),
    toolsCount: 57,
    description: '操作系统全局鼠标、键盘与原生应用交互驱动',
  },
  {
    id: 'claude:sqlite',
    name: 'sqlite',
    source: 'Claude Desktop',
    type: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', './data.db'],
    tools: resolveMcpTools('sqlite'),
    toolsCount: 4,
    description: '本地 SQLite 数据库查询、表结构读取与分析工具',
  },
  {
    id: 'cursor:filesystem',
    name: 'filesystem',
    source: 'Cursor',
    type: 'stdio',
    command: 'npx',
    args: ['@modelcontextprotocol/server-filesystem', '.'],
    tools: resolveMcpTools('filesystem'),
    toolsCount: 8,
    description: '本地文件目录结构安全访问与读写控制',
  },
];
