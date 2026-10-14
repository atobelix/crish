/**
 * 扫描并探测本机其他应用（Antigravity、Claude Code、Codex、Claude Desktop、Cursor）
 * 中已安装的 MCP 服务 —— 本目录唯一的 MCP 探测 SSOT。
 *
 * 纪律：新增探测能力一律在本文件内演进，禁止再另起 parallel detector
 * （历史教训：externalMcpDetector.ts 曾与本文件双源漂移，类型枚举大小写不一致、
 * 缺去重、空结果自动混入 MOCK 假数据，已于 code review 中裁决删除并入）。
 */

import { invokeResult } from '../../api/tauriInvoke';
import { resolveMcpTools } from './knownMcpTools';
import { parseCodexToml } from './codexTomlParser';

export { parseCodexToml };

export type DetectedExternalMcpSource =
  'Claude Code' | 'Codex' | 'Antigravity' | 'Claude Desktop' | 'Cursor';

export interface DetectedExternalMcpServer {
  id: string;
  source: DetectedExternalMcpSource;
  name: string;
  type: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  description?: string;
  tools?: string[];
  toolsCount?: number;
}

interface ExternalScanTarget {
  source: DetectedExternalMcpSource;
  paths: (dirs: { home?: string; appData?: string }) => string[];
}

const SCAN_TARGETS: ExternalScanTarget[] = [
  {
    source: 'Claude Code',
    paths: ({ home }) =>
      home
        ? [
            `${home}/.claude.json`.replace(/\\/g, '/'),
            `${home}/.claude/settings.json`.replace(/\\/g, '/'),
            `${home}/.claude/config.json`.replace(/\\/g, '/'),
          ]
        : [],
  },
  {
    source: 'Codex',
    paths: ({ home }) =>
      home
        ? [
            `${home}/.codex/mcp.json`.replace(/\\/g, '/'),
            `${home}/.codex/config.json`.replace(/\\/g, '/'),
            `${home}/.codex/config.toml`.replace(/\\/g, '/'),
          ]
        : [],
  },
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
    if (pathApi?.appDataDir) {
      const a = await pathApi.appDataDir();
      if (a && a.trim()) appData = a.trim();
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

/**
 * 容错 JSON 解析：标准 JSON.parse 失败时，剥离行首 // 注释与尾逗号后重试。
 * 仅限行首注释（^//），不会误伤字符串内部的 URL（如 "https://..."，行首是引号）。
 */
function safeParseJsonWithComments(rawJson: string): unknown | null {
  try {
    return JSON.parse(rawJson);
  } catch {
    try {
      const sanitized = rawJson
        .replace(/^\s*\/\/[^\n\r]*/gm, '')
        .replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(sanitized);
    } catch {
      return null;
    }
  }
}

function parseMcpJson(
  rawJson: string,
  source: DetectedExternalMcpSource
): DetectedExternalMcpServer[] {
  const parsed = safeParseJsonWithComments(rawJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const record = parsed as Record<string, unknown>;

  // 宽松格式识别：mcpServers / servers / 单服务器对象 / 裸服务器映射
  const serversMap =
    record.mcpServers ||
    record.servers ||
    (record.command || record.url ? { default: record } : record);

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
    });
  }

  return results;
}

async function readConfigFile(filePath: string): Promise<string | null> {
  try {
    const res = await invokeResult<{ content?: string }>(
      'workbench_read_file_content',
      {
        path: filePath,
        maxLines: 5000,
      }
    );
    if (res.status === 'ok' && res.data?.content) return res.data.content;
  } catch {
    // 继续探测下一个路径
  }
  return null;
}

/** 探测单个 target：路径间并行读取，按扩展名分流 JSON / TOML 解析。 */
async function scanTarget(
  target: ExternalScanTarget,
  dirs: { home?: string; appData?: string }
): Promise<DetectedExternalMcpServer[]> {
  const candidatePaths = target.paths(dirs);
  const rawContents = await Promise.all(
    candidatePaths.map((filePath) => readConfigFile(filePath))
  );

  const list: DetectedExternalMcpServer[] = [];
  for (let i = 0; i < candidatePaths.length; i++) {
    const filePath = candidatePaths[i];
    const raw = rawContents[i];
    if (!filePath || !raw) continue;
    const parsed = filePath.toLowerCase().endsWith('.toml')
      ? parseCodexToml(raw, 'Codex')
      : parseMcpJson(raw, target.source);
    list.push(...parsed);
  }
  return list;
}

const ANTIGRAVITY_MCP_DIR_DESCRIPTIONS: Record<string, string> = {
  'chrome-devtools-mcp': '浏览器自动化与调试工具',
  'cua-driver': '操作系统与原生应用控制驱动',
  'tauri-mcp': 'Tauri 桌面应用自动化控制',
  'tauri-mcp-editor': 'Tauri 编辑器增强工具',
};

/**
 * 探测 Antigravity 本地 MCP 扩展目录 (~/.gemini/antigravity/mcp)：
 * 子目录名即服务名；工具列表优先取子目录内 *.json 工具定义文件名，
 * 无 json 定义时回退 knownMcpTools 预置映射。
 */
async function scanAntigravityMcpDir(
  home: string
): Promise<DetectedExternalMcpServer[]> {
  const mcpDir = `${home}/.gemini/antigravity/mcp`.replace(/\\/g, '/');
  let items: Array<{ name: string; is_dir?: boolean; isDir?: boolean }>;
  try {
    const res = await invokeResult<{
      items?: Array<{ name: string; is_dir?: boolean; isDir?: boolean }>;
    }>('workbench_list_directory', { path: mcpDir });
    if (res.status !== 'ok' || !Array.isArray(res.data?.items)) return [];
    items = res.data.items;
  } catch {
    return [];
  }

  const dirs = items.filter(
    (item) => (item.is_dir ?? item.isDir) && !item.name.startsWith('.')
  );

  return Promise.all(
    dirs.map(async (item) => {
      let jsonToolNames: string[] = [];
      try {
        const subRes = await invokeResult<{
          items?: Array<{ name: string; is_dir?: boolean; isDir?: boolean }>;
        }>('workbench_list_directory', {
          path: `${mcpDir}/${item.name}`,
        });
        if (subRes.status === 'ok' && Array.isArray(subRes.data?.items)) {
          jsonToolNames = subRes.data.items
            .filter((f) => !(f.is_dir ?? f.isDir) && /\.json$/i.test(f.name))
            .map((f) => f.name.replace(/\.json$/i, ''));
        }
      } catch {
        // 工具目录读取失败时回退预置映射
      }

      const tools =
        jsonToolNames.length > 0 ? jsonToolNames : resolveMcpTools(item.name);
      const isNpx = item.name.includes('chrome') || item.name.includes('npx');

      return {
        id: `antigravity:${item.name}`,
        source: 'Antigravity' as const,
        name: item.name,
        type: 'stdio' as const,
        command: isNpx ? 'npx' : 'node',
        args: isNpx ? [item.name] : [`${item.name}.js`],
        tools,
        toolsCount: tools.length,
        description:
          ANTIGRAVITY_MCP_DIR_DESCRIPTIONS[item.name] ||
          'Antigravity 本地 MCP 扩展服务',
      };
    })
  );
}

/**
 * 扫描本机其他已安装客户端的 MCP 配置文件并返回发现的服务列表。
 * target 间并行扫描；同名服务（source:name）以首个命中为准去重。
 * 探测为空时返回空数组 —— 展示层兜底（DEFAULT_FALLBACK_MCP）由 UI 决定，
 * 严禁在本层把预设假数据混入真实探测结果。
 */
export async function detectExternalMcpServers(): Promise<
  DetectedExternalMcpServer[]
> {
  const dirs = await resolveSystemDirs();
  if (!dirs.home && !dirs.appData) return [];

  const [targetLists, antigravityDirList] = await Promise.all([
    Promise.all(SCAN_TARGETS.map((target) => scanTarget(target, dirs))),
    dirs.home ? scanAntigravityMcpDir(dirs.home).catch(() => []) : [],
  ]);

  const foundMap = new Map<string, DetectedExternalMcpServer>();
  for (const list of [...targetLists.flat(), ...antigravityDirList]) {
    const dedupeKey = `${list.source}:${list.name}`;
    if (!foundMap.has(dedupeKey)) {
      foundMap.set(dedupeKey, list);
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
    id: 'claudecode:chrome-devtools',
    name: 'chrome-devtools',
    source: 'Claude Code',
    type: 'stdio',
    command: 'cmd',
    args: ['/c', 'chrome-devtools-mcp.js'],
    tools: resolveMcpTools('chrome-devtools'),
    toolsCount: 30,
    description: 'Claude Code 浏览器自动化与 DOM/网络调试',
  },
  {
    id: 'codex:node_repl',
    name: 'node_repl',
    source: 'Codex',
    type: 'stdio',
    command: 'node_repl.exe',
    args: [],
    tools: resolveMcpTools('node_repl'),
    toolsCount: 4,
    description: 'Codex 本地 Node.js 交互式 REPL 与上下文执行沙箱',
  },
  {
    id: 'claudecode:github',
    name: 'github',
    source: 'Claude Code',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    tools: resolveMcpTools('github'),
    toolsCount: 26,
    description: 'Claude Code 探测到的 GitHub 仓库、PR 与 Issue 协同管理工具',
  },
  {
    id: 'codex:fetch',
    name: 'fetch',
    source: 'Codex',
    type: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    tools: resolveMcpTools('fetch'),
    toolsCount: 2,
    description: 'Codex 探测到的网页内容与网络资源获取服务',
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
