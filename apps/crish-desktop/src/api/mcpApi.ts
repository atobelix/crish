/**
 * 引擎 MCP 列表与启停（正式版扩展服务）
 *
 * 契约：ENGINE-MCP（见 docs/plans/2026-07-product-trust-topdown.md §1 / §4）
 * - T03.7 裁决后：list-capabilities 回补 core_get_status.mcpStatus；
 *   list-mcp-servers / start-mcp-server / stop-mcp-server 为幽灵命令（Rust 侧无），
 *   界面启停显式不可用（错误码 'unavailable'），不再走 transport 请求。
 * - 真实 MCP 管理经 mcpClientManager（R4-A2 SDK 直连）与 mcpClient 集成。
 *
 * R4-A2 (2026-07)：MCP SDK 直连客户端（mcpClientManager），用于直接管理 stdio MCP 服务器。
 */

import { getTransport } from './transport';
import { logInternalError } from './userFacingErrors';
import { mcpClientManager } from './mcpClient';
import { eventBus } from '../services/EventBus';

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

/**
 * 一次失败后记住：库存引擎不支持界面启停（T03.7 后恒为不支持态）。
 */
let rememberedStartStopUnsupported = true;
let rememberedStartStopMessage: string | undefined;

const START_STOP_UNSUPPORTED_HINT =
  '当前引擎不支持从界面启停；MCP 通常随任务运行时连接';

/** list-capabilities 短缓存（T7）：T03.7 后不再写入，保留签名兼容 capabilitiesStore */
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

/** 读取 list-capabilities 缓存（T03.7 后恒 null，显式不可用） */
export function getListCapabilitiesSnapshot(): ListCapabilitiesSnapshot | null {
  if (!listCapsCache) return null;
  if (Date.now() - listCapsCache.at > LIST_CAPS_TTL_MS) return null;
  return listCapsCache;
}

export function invalidateListCapabilitiesCache(): void {
  listCapsCache = null;
}

/**
 * 从 list-capabilities 取 mcp.lifecycle（可选，失败则忽略）。
 * T03.7：list-capabilities 幽灵命令已删（回补 core_get_status.mcpStatus），
 * 本函数恒返回 null（显式不可用），保留签名供 capabilitiesStore 兼容。
 */
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
    // T03.7：list-capabilities 回补 core_get_status.mcpStatus
    const status = (await transport.request<Record<string, unknown>>(
      'core_get_status',
      {},
      { timeoutMs: 8_000 },
    )) as Record<string, unknown>;
    const mcp = status.mcpStatus as Record<string, unknown> | undefined;
    if (!mcp || typeof mcp !== 'object') return { configured: false };
    const readiness = typeof mcp.readiness === 'string' ? mcp.readiness : undefined;
    const updatedAt = typeof mcp.updatedAt === 'string' ? mcp.updatedAt : undefined;
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

/** 引擎侧 MCP 列表不可用提示（T03.7：Rust 侧无 list-mcp-servers） */
const MCP_LIST_UNAVAILABLE_HINT =
  '当前引擎不支持从界面读取 MCP 列表；MCP 工具随任务运行时连接';

export async function listMcpServers(): Promise<McpListResult> {
  // T03.7：幽灵命令，显式不可用（不发起 transport 请求）
  return {
    ok: false,
    configured: false,
    servers: [],
    error: MCP_LIST_UNAVAILABLE_HINT,
    errorCode: 'unavailable',
  };
}

/**
 * 探测列表与启停是否可用。
 * T03.7：list-mcp-servers / start / stop 均为幽灵命令（Rust 侧无），
 * 恒返回不可用（canList=false, canStartStop=false），显式不降级。
 * @param listResult 可选；兼容旧调用签名
 */
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
      message: list.error || '无法列出 MCP 服务',
    };
  }

  return {
    canList: true,
    canStartStop: false,
    configured: list.configured || list.servers.length > 0,
    capabilityState: 'backend-not-wired',
    message: START_STOP_UNSUPPORTED_HINT,
  };
}

export async function startMcpServer(
  serverId: string
): Promise<McpControlResult> {
  // T03.7：Rust 侧无 start-mcp-server，界面启停显式不可用
  return {
    ok: false,
    serverId,
    error: START_STOP_UNSUPPORTED_HINT,
    errorCode: 'unsupported',
  };
}

export async function stopMcpServer(
  serverId: string
): Promise<McpControlResult> {
  // T03.7：Rust 侧无 stop-mcp-server，界面启停显式不可用
  return {
    ok: false,
    serverId,
    error: START_STOP_UNSUPPORTED_HINT,
    errorCode: 'unsupported',
  };
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

/** 测试/重置用：清除「启停不支持」记忆 */
export function resetMcpControlProbeMemory(): void {
  rememberedStartStopUnsupported = false;
  rememberedStartStopMessage = undefined;
}

// ── R4-A2: MCP SDK 直连集成 ──────────────────────────────────────────

export { mcpClientManager };

export type DirectMcpServerConfig = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type DirectMcpToolInfo = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type DirectMcpConnectResult = {
  ok: boolean;
  serverId: string;
  error?: string;
};

export type DirectMcpListToolsResult = {
  ok: boolean;
  tools: DirectMcpToolInfo[];
  error?: string;
};

export type DirectMcpCallToolResult = {
  ok: boolean;
  result: unknown;
  error?: string;
};

export type DirectMcpDisconnectResult = {
  ok: boolean;
  serverId: string;
  error?: string;
};

export async function connectDirectMcpServer(
  serverId: string,
  config: DirectMcpServerConfig
): Promise<DirectMcpConnectResult> {
  try {
    await mcpClientManager.connect(serverId, config);
    return { ok: true, serverId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, serverId, error: msg };
  }
}

export async function disconnectDirectMcpServer(
  serverId: string
): Promise<DirectMcpDisconnectResult> {
  try {
    await mcpClientManager.disconnect(serverId);
    eventBus.emit('mcp:tools:changed', { serverId });
    return { ok: true, serverId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, serverId, error: msg };
  }
}

export async function disconnectAllDirectMcpServers(): Promise<void> {
  await mcpClientManager.disconnectAll();
}

export async function getDirectMcpTools(
  serverId: string
): Promise<DirectMcpListToolsResult> {
  try {
    const tools = await mcpClientManager.listTools(serverId);
    return { ok: true, tools };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, tools: [], error: msg };
  }
}

export async function callDirectMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<DirectMcpCallToolResult> {
  try {
    const result = await mcpClientManager.callTool(serverId, toolName, args);
    return { ok: true, result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, result: undefined, error: msg };
  }
}

export function getConnectedDirectMcpServers(): string[] {
  return mcpClientManager.getConnectedServers();
}

export function invalidateDirectMcpToolCache(serverId: string): void {
  mcpClientManager.invalidateToolCache(serverId);
}
