/**
 * 引擎 MCP 列表与启停（正式版扩展服务）
 */

import { getDesktopDaemonClient } from './daemonClient';
import { logInternalError } from './userFacingErrors';

export type McpServerState =
  | 'ready'
  | 'running'
  | 'starting'
  | 'stopped'
  | 'error'
  | 'degraded'
  | 'unknown'
  | string;

export type McpServerInfo = {
  id: string;
  name: string;
  /** 引擎上报状态 */
  state: McpServerState;
  status?: string;
  tools: string[];
  toolCount?: number;
  transport?: string;
  lastError?: string;
  startedAt?: string;
  [key: string]: unknown;
};

export type McpStatusSnapshot = {
  configured: boolean;
  readiness?: string;
  updatedAt?: string;
  serverCount?: number;
};

export type McpListResult = {
  ok: boolean;
  configured: boolean;
  servers: McpServerInfo[];
  status?: McpStatusSnapshot;
  error?: string;
  errorCode?: string;
};

function normalizeState(raw: unknown): McpServerState {
  if (typeof raw !== 'string' || !raw.trim()) return 'unknown';
  return raw.trim().toLowerCase();
}

function mapServer(o: Record<string, unknown>, i: number): McpServerInfo {
  const id = String(o.id ?? o.name ?? `mcp-${i}`);
  const name = String(o.name ?? o.id ?? id);
  const toolsRaw = o.tools ?? o.toolNames ?? o.cachedTools;
  const tools = Array.isArray(toolsRaw)
    ? toolsRaw.map((t) =>
        typeof t === 'string' ? t : String((t as { name?: string }).name || t),
      )
    : [];
  const toolCount =
    typeof o.cachedToolCount === 'number'
      ? o.cachedToolCount
      : typeof o.toolCount === 'number'
        ? o.toolCount
        : tools.length || undefined;
  const state = normalizeState(o.state ?? o.status ?? o.readiness);
  return {
    id,
    name,
    state,
    status: typeof o.status === 'string' ? o.status : state,
    tools,
    toolCount,
    transport:
      typeof o.transport === 'string'
        ? o.transport
        : typeof o.type === 'string'
          ? o.type
          : undefined,
    lastError:
      typeof o.lastError === 'string'
        ? o.lastError
        : typeof o.error === 'string'
          ? o.error
          : undefined,
    startedAt: typeof o.startedAt === 'string' ? o.startedAt : undefined,
  };
}

async function ensureConnected(timeoutMs = 8_000): Promise<boolean> {
  const client = getDesktopDaemonClient();
  if (client.isConnected()) return true;
  return client.waitUntilConnected(timeoutMs);
}

export async function fetchMcpStatus(): Promise<McpStatusSnapshot> {
  const client = getDesktopDaemonClient();
  try {
    if (!(await ensureConnected())) {
      return { configured: false };
    }
    const status = (await client.request(
      { type: 'get-status' },
      'status-response',
      8_000,
    )) as Record<string, unknown>;
    const mcp = status.mcpStatus as Record<string, unknown> | undefined;
    if (!mcp || typeof mcp !== 'object') return { configured: false };
    return {
      configured: Boolean(mcp.configured),
      readiness: typeof mcp.readiness === 'string' ? mcp.readiness : undefined,
      updatedAt: typeof mcp.updatedAt === 'string' ? mcp.updatedAt : undefined,
      serverCount:
        typeof mcp.serverCount === 'number'
          ? mcp.serverCount
          : Array.isArray(mcp.servers)
            ? mcp.servers.length
            : undefined,
    };
  } catch {
    return { configured: false };
  }
}

export async function listMcpServers(): Promise<McpListResult> {
  const client = getDesktopDaemonClient();
  try {
    if (!(await ensureConnected())) {
      return {
        ok: false,
        configured: false,
        servers: [],
        error: '引擎未连接',
        errorCode: 'not_connected',
      };
    }

    let statusSnap = await fetchMcpStatus();
    let configured = statusSnap.configured;

    const res = (await client.request(
      { type: 'list-mcp-servers' },
      'mcp-servers-listed',
      10_000,
    )) as Record<string, unknown>;

    const list = Array.isArray(res.servers) ? res.servers : [];
    const servers: McpServerInfo[] = list
      .map((s, i) => {
        if (!s || typeof s !== 'object') return null;
        return mapServer(s as Record<string, unknown>, i);
      })
      .filter(Boolean) as McpServerInfo[];

    if (servers.length > 0) configured = true;
    statusSnap = { ...statusSnap, configured, serverCount: servers.length };

    return { ok: true, configured, servers, status: statusSnap };
  } catch (e) {
    logInternalError('listMcpServers', e);
    return {
      ok: false,
      configured: false,
      servers: [],
      error: e instanceof Error ? e.message : String(e),
      errorCode: 'list_failed',
    };
  }
}

export type McpControlResult = {
  ok: boolean;
  serverId: string;
  state?: string;
  error?: string;
};

export async function startMcpServer(serverId: string): Promise<McpControlResult> {
  const client = getDesktopDaemonClient();
  try {
    if (!(await ensureConnected())) {
      return { ok: false, serverId, error: '引擎未连接' };
    }
    const res = (await client.request(
      { type: 'start-mcp-server', serverId },
      'mcp-server-started',
      30_000,
    )) as Record<string, unknown>;
    return {
      ok: true,
      serverId,
      state: typeof res.state === 'string' ? res.state : 'starting',
    };
  } catch (e) {
    logInternalError('startMcpServer', e);
    return {
      ok: false,
      serverId,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function stopMcpServer(serverId: string): Promise<McpControlResult> {
  const client = getDesktopDaemonClient();
  try {
    if (!(await ensureConnected())) {
      return { ok: false, serverId, error: '引擎未连接' };
    }
    const res = (await client.request(
      { type: 'stop-mcp-server', serverId },
      'mcp-server-stopped',
      20_000,
    )) as Record<string, unknown>;
    return {
      ok: true,
      serverId,
      state: typeof res.state === 'string' ? res.state : 'stopped',
    };
  } catch (e) {
    logInternalError('stopMcpServer', e);
    return {
      ok: false,
      serverId,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function mcpStateLabel(state: string | undefined): string {
  const s = (state || 'unknown').toLowerCase();
  if (s === 'ready' || s === 'running' || s === 'connected') return '运行中';
  if (s === 'starting') return '启动中';
  if (s === 'stopped' || s === 'idle') return '已停止';
  if (s === 'degraded') return '降级';
  if (s === 'error' || s === 'failed') return '错误';
  if (s === 'unknown') return '未知';
  return state || '未知';
}

export function mcpStateKind(
  state: string | undefined,
): 'ok' | 'warn' | 'err' | 'idle' {
  const s = (state || '').toLowerCase();
  if (s === 'ready' || s === 'running' || s === 'connected') return 'ok';
  if (s === 'starting' || s === 'degraded') return 'warn';
  if (s === 'error' || s === 'failed') return 'err';
  return 'idle';
}
