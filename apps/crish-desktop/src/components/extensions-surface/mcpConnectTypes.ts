/**
 * MCP 接入弹窗类型定义与预设模板
 */

export type ConnectTab = 'manual' | 'syntax' | 'quick';

export interface PresetItem {
  id: string;
  name: string;
  type: 'stdio' | 'sse';
  command: string;
  args: string;
  url?: string;
}

export const PRESET_TEMPLATES: PresetItem[] = [
  {
    id: 'filesystem',
    name: 'filesystem',
    type: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-filesystem C:\\',
  },
  {
    id: 'fetch',
    name: 'fetch',
    type: 'stdio',
    command: 'uvx',
    args: 'mcp-server-fetch',
  },
  {
    id: 'git',
    name: 'git',
    type: 'stdio',
    command: 'uvx',
    args: 'mcp-server-git',
  },
  {
    id: 'sqlite',
    name: 'sqlite',
    type: 'stdio',
    command: 'uvx',
    args: 'mcp-server-sqlite --db-path ./data.db',
  },
];

export const DEFAULT_SYNTAX_DEMO = JSON.stringify(
  {
    mcpServers: {
      sqlite: {
        command: 'uvx',
        args: ['mcp-server-sqlite', '--db-path', './data.db'],
      },
    },
  },
  null,
  2
);

export function parseArgs(argsStr: string): string[] {
  if (!argsStr.trim()) return [];
  if (argsStr.includes(',')) {
    return argsStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const match = argsStr.match(/(?:[^\s"]+|"[^"]*")+/g);
  return match
    ? match.map((s) => s.replace(/^"|"$/g, '').trim()).filter(Boolean)
    : [];
}

export function parseEnv(envStr: string): Record<string, string> | undefined {
  if (!envStr.trim()) return undefined;
  const lines = envStr.split(/[\r\n,]+/);
  const result: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
