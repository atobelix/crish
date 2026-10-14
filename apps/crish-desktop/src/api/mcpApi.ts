/**
 * 引擎 MCP 列表、启停与细粒度工具控制（BC11-1 生产真实接入）
 *
 * 契约：BC11-1 真实控制面与动态反射
 * - workbench_list_mcp_servers：动态自省已注册的 MCP 服务与反射工具
 * - workbench_start_mcp_server / workbench_stop_mcp_server：真实控制 MCP 进程生命周期
 * - workbench_toggle_mcp_tool：细粒度开关工具，同步引擎 ToolRegistry 掩码与持久化
 */

import { getTransport } from './transport';
import { logInternalError } from './userFacingErrors';
import { invokeTyped } from './tauriInvoke';

export type McpServerState =
  | 'ready'
  | 'running'
  | 'starting'
  | 'stopped'
  | 'error'
  | 'degraded'
  | 'unknown'
  | string;

export type McpToolDefinitionDto = {
  name: string;
  prefixedName?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  enabled?: boolean;
};

export type McpServerInfo = {
  id: string;
  name: string;
  /** 引擎上报状态 */
  state: McpServerState;
  status?: string;
  tools: string[];
  toolDefs?: McpToolDefinitionDto[];
  toolCount?: number;
  transport?: string;
  lastError?: string;
  startedAt?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  autoStart?: boolean;
  disabledTools?: string[];
  [key: string]: unknown;
};

export type McpServerDetailDto = McpServerInfo;

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

export type McpControlResult = {
  ok: boolean;
  serverId: string;
  state?: string;
  error?: string;
  errorCode?: string;
};

export type McpControlProbe = {
  canList: boolean;
  canStartStop: boolean;
  message?: string;
  configured?: boolean;
  capabilityState?: string;
};

/** list-capabilities 短缓存（T7） */
const LIST_CAPS_TTL_MS = 60_000;

export type ListCapabilitiesSnapshot = {
  at: number;
  /** mcp.lifecycle.state if present */
  mcp?: string;
  raw?: unknown;
  lifecycle?: {
    state?: string;
    reason?: string;
    configuredHint?: boolean;
  } | null;
};

let listCapsCache: ListCapabilitiesSnapshot | null = null;

export function getListCapabilitiesSnapshot(): ListCapabilitiesSnapshot | null {
  if (!listCapsCache) return null;
  if (Date.now() - listCapsCache.at > LIST_CAPS_TTL_MS) return null;
  return listCapsCache;
}

export function invalidateListCapabilitiesCache(): void {
  listCapsCache = null;
}

export async function fetchMcpLifecycleCapability(opts?: {
  force?: boolean;
}): Promise<{
  state?: string;
  reason?: string;
  configuredHint?: boolean;
} | null> {
  void opts;
  return null;
}

export async function fetchMcpStatus(): Promise<McpStatusSnapshot> {
  const transport = getTransport();
  try {
    if (!transport.isReady()) {
      const ok = await transport.waitUntilConnected(2_000);
      if (!ok) {
        return { configured: false };
      }
    }
    const status = (await transport.request<Record<string, unknown>>(
      'core_get_status',
      {},
      { timeoutMs: 8_000 }
    )) as Record<string, unknown>;
    const mcp = status.mcpStatus as Record<string, unknown> | undefined;
    if (!mcp || typeof mcp !== 'object') return { configured: false };
    const readiness =
      typeof mcp.readiness === 'string' ? mcp.readiness : undefined;
    const updatedAt =
      typeof mcp.updatedAt === 'string' ? mcp.updatedAt : undefined;
    const serverCount =
      typeof mcp.serverCount === 'number'
        ? mcp.serverCount
        : Array.isArray(mcp.servers)
          ? mcp.servers.length
          : undefined;
    return {
      configured: Boolean(mcp.configured),
      ...(readiness !== undefined && { readiness }),
      ...(updatedAt !== undefined && { updatedAt }),
      ...(serverCount !== undefined && { serverCount }),
    };
  } catch (e) {
    logInternalError('fetchMcpStatus', e);
    return { configured: false };
  }
}

export async function listMcpServers(): Promise<McpListResult> {
  const res = await invokeTyped<unknown>('workbench_list_mcp_servers');
  if (res.status === 'ok') {
    const raw = res.data;
    const rawList = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as any)?.servers)
        ? (raw as any).servers
        : [];
    const servers: McpServerInfo[] = rawList.map((item: any) => {
      const rawTools = Array.isArray(item?.tools) ? item.tools : [];
      const toolNames: string[] = rawTools.map((t: any) =>
        typeof t === 'string'
          ? t
          : typeof t?.name === 'string'
            ? t.name
            : String(t)
      );
      const toolDefs: McpToolDefinitionDto[] = rawTools
        .filter((t: any) => t && typeof t === 'object')
        .map((t: any) => ({
          name: t.name || '',
          prefixedName: t.prefixedName,
          description: t.description,
          inputSchema: t.inputSchema,
          enabled: t.enabled !== false,
        }));
      return {
        ...item,
        state:
          item.state || (item.status === 'connected' ? 'ready' : 'stopped'),
        tools: toolNames,
        ...(toolDefs.length > 0 && { toolDefs }),
      };
    });
    return {
      ok: true,
      configured: servers.length > 0,
      servers,
    };
  }
  if (res.status === 'missing') {
    return {
      ok: false,
      configured: false,
      servers: [],
      error: 'workbench_list_mcp_servers command not registered',
      errorCode: 'missing',
    };
  }
  return {
    ok: false,
    configured: false,
    servers: [],
    error: res.message || 'Failed to list MCP servers',
    errorCode: res.kind || 'error',
  };
}

export async function probeMcpControl(
  listResult?: McpListResult
): Promise<McpControlProbe> {
  const list = listResult ?? (await listMcpServers());
  const canList = list.ok;

  if (!canList) {
    return {
      canList: false,
      canStartStop: false,
      configured: list.configured,
      message: list.error || 'Failed to list MCP servers',
    };
  }

  return {
    canList: true,
    canStartStop: true,
    configured: list.configured || list.servers.length > 0,
    capabilityState: 'ready',
  };
}

export async function startMcpServer(
  serverId: string
): Promise<McpControlResult> {
  const res = await invokeTyped<{ state?: string } | boolean | void>(
    'workbench_start_mcp_server',
    { serverId }
  );
  if (res.status === 'ok') {
    const state =
      res.data && typeof res.data === 'object' && 'state' in res.data
        ? (res.data as any).state
        : 'ready';
    return {
      ok: true,
      serverId,
      state,
    };
  }
  if (res.status === 'missing') {
    return {
      ok: false,
      serverId,
      error: 'workbench_start_mcp_server command not ready',
      errorCode: 'missing',
    };
  }
  return {
    ok: false,
    serverId,
    error: res.message || 'Failed to start MCP server',
    errorCode: res.kind || 'error',
  };
}

export async function stopMcpServer(
  serverId: string
): Promise<McpControlResult> {
  const res = await invokeTyped<{ state?: string } | boolean | void>(
    'workbench_stop_mcp_server',
    { serverId }
  );
  if (res.status === 'ok') {
    const state =
      res.data && typeof res.data === 'object' && 'state' in res.data
        ? (res.data as any).state
        : 'stopped';
    return {
      ok: true,
      serverId,
      state,
    };
  }
  if (res.status === 'missing') {
    return {
      ok: false,
      serverId,
      error: 'workbench_stop_mcp_server command not ready',
      errorCode: 'missing',
    };
  }
  return {
    ok: false,
    serverId,
    error: res.message || 'Failed to stop MCP server',
    errorCode: res.kind || 'error',
  };
}

export async function toggleMcpTool(
  serverId: string,
  toolName: string,
  enabled: boolean
): Promise<boolean> {
  try {
    const res = await invokeTyped('workbench_toggle_mcp_tool', {
      serverId,
      toolName,
      enabled,
    });
    if (res.status === 'ok') {
      return true;
    }
    if (res.status === 'missing') {
      return false;
    }
    logInternalError('toggleMcpTool', res.message);
    return false;
  } catch (e) {
    logInternalError('toggleMcpTool', e);
    return false;
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
  state: string | undefined
): 'ok' | 'warn' | 'err' | 'idle' {
  const s = (state || '').toLowerCase();
  if (s === 'ready' || s === 'running' || s === 'connected') return 'ok';
  if (s === 'starting' || s === 'degraded') return 'warn';
  if (s === 'error' || s === 'failed') return 'err';
  return 'idle';
}

export function resetMcpControlProbeMemory(): void {
  /* 兼容保留 */
}
