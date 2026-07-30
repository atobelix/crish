/**
 * Daemon MCP 配置：可序列化条目、env/文件加载、转成 McpServerDefinition。
 *
 * adapter 本身不可 JSON 序列化；stdio adapter 在此由配置构造。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { McpServerAdapter, McpServerDefinition } from "@crish/agent-mcp";
import type { DaemonMcpServerConfig } from './types.js';
import { createStdioMcpAdapter } from './mcp-stdio-adapter.js';

/** 环境变量：JSON 数组，或指向 mcp.json 的路径 */
export const CRISH_MCP_SERVERS_ENV = 'CRISH_MCP_SERVERS';
/** 环境变量：mcp 配置文件绝对/相对路径（优先于默认 home 路径） */
export const CRISH_MCP_CONFIG_ENV = 'CRISH_MCP_CONFIG';

/**
 * 规范化未知 JSON 为 DaemonMcpServerConfig[]。
 * 支持数组，或 { mcpServers: [...] } / { servers: [...] } 包装。
 */
export function normalizeDaemonMcpServers(
  raw: unknown
): DaemonMcpServerConfig[] {
  if (raw == null) return [];

  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.mcpServers)) list = obj.mcpServers;
    else if (Array.isArray(obj.servers)) list = obj.servers;
    else return [];
  } else {
    return [];
  }

  const out: DaemonMcpServerConfig[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = stringField(o.name) ?? stringField(o.id);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const transport =
      stringField(o.transport) ?? (stringField(o.url) ? 'sse' : 'stdio');
    const command = stringField(o.command);
    const args = stringArrayField(o.args);
    const cwd = stringField(o.cwd);
    const url = stringField(o.url);
    const label = stringField(o.label) ?? stringField(o.title);
    const env = stringRecordField(o.env);

    out.push({
      name,
      label: label ?? undefined,
      transport,
      command: command ?? undefined,
      args: args ?? undefined,
      env: env ?? undefined,
      cwd: cwd ?? undefined,
      url: url ?? undefined,
    });
  }

  return out;
}

/** 从环境变量解析 MCP 配置（JSON 数组字符串，或文件路径） */
export function loadMcpServersFromEnv(
  env: NodeJS.ProcessEnv = process.env
): DaemonMcpServerConfig[] {
  const configPath = env[CRISH_MCP_CONFIG_ENV]?.trim();
  if (configPath) {
    return loadMcpServersFromFile(configPath);
  }

  const raw = env[CRISH_MCP_SERVERS_ENV]?.trim();
  if (!raw) return [];

  // 若像路径且文件存在，按文件加载
  if (!raw.startsWith('[') && !raw.startsWith('{')) {
    if (existsSync(raw)) return loadMcpServersFromFile(raw);
    return [];
  }

  try {
    return normalizeDaemonMcpServers(JSON.parse(raw));
  } catch {
    console.warn(
      '[Daemon] Failed to parse CRISH_MCP_SERVERS as JSON; ignoring.'
    );
    return [];
  }
}

/** 从 JSON 文件加载（不存在则 []） */
export function loadMcpServersFromFile(
  filePath: string
): DaemonMcpServerConfig[] {
  const path = resolve(filePath);
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, 'utf8');
    return normalizeDaemonMcpServers(JSON.parse(text));
  } catch (error) {
    console.warn(
      `[Daemon] Failed to load MCP config from ${path}:`,
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}

/**
 * 默认配置文件：`$CRISH_DAEMON_HOME/mcp.json` 或平台默认 daemon data 目录。
 */
export function defaultMcpConfigPath(daemonHome?: string): string {
  if (daemonHome) return join(resolve(daemonHome), 'mcp.json');
  if (process.env.CRISH_DAEMON_HOME) {
    return join(resolve(process.env.CRISH_DAEMON_HOME), 'mcp.json');
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'Crish', 'agent-daemon', 'mcp.json');
  }
  if (process.env.XDG_STATE_HOME) {
    return join(
      process.env.XDG_STATE_HOME,
      'crish',
      'agent-daemon',
      'mcp.json'
    );
  }
  return join(
    process.env.HOME || process.env.USERPROFILE || '.',
    '.crish',
    'agent-daemon',
    'mcp.json'
  );
}

/**
 * 合并配置来源优先级：显式 config > env > 默认 mcp.json
 */
export function resolveDaemonMcpServers(input: {
  configServers?: DaemonMcpServerConfig[] | null;
  env?: NodeJS.ProcessEnv;
  daemonHome?: string;
  loadDefaultFile?: boolean;
}): DaemonMcpServerConfig[] {
  if (input.configServers && input.configServers.length > 0) {
    return normalizeDaemonMcpServers(input.configServers);
  }

  const fromEnv = loadMcpServersFromEnv(input.env ?? process.env);
  if (fromEnv.length > 0) return fromEnv;

  if (input.loadDefaultFile === false) return [];
  return loadMcpServersFromFile(defaultMcpConfigPath(input.daemonHome));
}

/**
 * 将可序列化配置转为 runtime McpServerDefinition（含 adapter）。
 * - stdio：createStdioMcpAdapter
 * - 无 command 的 stdio：deferred adapter（list 可见，start 会 degraded）
 * - 非 stdio：deferred adapter（明确不支持）
 */
export function buildMcpServerDefinitions(
  configs: DaemonMcpServerConfig[],
  confirmStart?: (command: string, args: string[]) => boolean | Promise<boolean>,
): McpServerDefinition[] {
  return configs.map((config) => ({
    name: config.name,
    label: config.label ?? config.name,
    adapter: createAdapterForConfig(config, confirmStart),
  }));
}

function createAdapterForConfig(
  config: DaemonMcpServerConfig,
  confirmStart?: (command: string, args: string[]) => boolean | Promise<boolean>,
): McpServerAdapter {
  const transport = (config.transport ?? 'stdio').toLowerCase();
  if (transport === 'stdio' && config.command?.trim()) {
    return createStdioMcpAdapter({
      name: config.name,
      command: config.command.trim(),
      args: config.args ?? [],
      env: config.env,
      cwd: config.cwd,
      confirmStart,
    });
  }

  const reason =
    transport !== 'stdio'
      ? `MCP transport "${transport}" is not wired in daemon yet`
      : `MCP server "${config.name}" has no stdio command configured`;

  return createDeferredMcpAdapter(reason);
}

/** list/配置可见，connect 时抛错（状态 degraded，不伪装 ready） */
export function createDeferredMcpAdapter(reason: string): McpServerAdapter {
  return {
    connect() {
      throw new Error(reason);
    },
  };
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t || undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const args = value.filter((v): v is string => typeof v === 'string');
  return args;
}

function stringRecordField(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
