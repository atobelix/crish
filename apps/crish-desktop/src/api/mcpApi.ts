/**
 * 引擎 MCP 列表与启停（正式版扩展服务）
 *
 * 契约：ENGINE-MCP（见 docs/plans/2026-07-product-trust-topdown.md §1 / §4）
 * - list：有 mcpServers 注入时非空（含 idle state=configured）
 * - start/stop：R1 已对齐 lifecycle.startServer/stopServer；有配置时 canStartStop 可 true
 * - 正式模式禁止用 clientApi.saveMcpServer 冒充引擎配置
 *
 * R4-A2 (2026-07)：MCP SDK 直连客户端（mcpClientManager），用于直接管理 stdio MCP 服务器。
 */

import { getDesktopDaemonClient } from './daemonClient';
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

/** 一次失败后记住：库存引擎不支持界面启停 */
let rememberedStartStopUnsupported = false;
let rememberedStartStopMessage: string | undefined;

const START_STOP_UNSUPPORTED_HINT =
  '当前引擎不支持从界面启停；MCP 通常随任务运行时连接';

/** list-capabilities 短缓存（T7）：避免设置页与 MCP tab 重复探测 */
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

/** 读取 list-capabilities 缓存（过期则 null） */
export function getListCapabilitiesSnapshot(): ListCapabilitiesSnapshot | null {
  if (!listCapsCache) return null;
  if (Date.now() - listCapsCache.at > LIST_CAPS_TTL_MS) return null;
  return listCapsCache;
}

export function invalidateListCapabilitiesCache(): void {
  listCapsCache = null;
}

function parseMcpLifecycleFromCapsResponse(res: Record<string, unknown>): {
  state?: string;
  reason?: string;
  configuredHint?: boolean;
} | null {
  const snapshot = res.snapshot as Record<string, unknown> | undefined;
  const caps = Array.isArray(snapshot?.capabilities)
    ? (snapshot!.capabilities as Record<string, unknown>[])
    : Array.isArray(res.capabilities)
      ? (res.capabilities as Record<string, unknown>[])
      : [];
  const mcp = caps.find((c) => String(c.id ?? '') === 'mcp.lifecycle');
  if (!mcp) return null;
  const state = typeof mcp.state === 'string' ? mcp.state : undefined;
  const reason = typeof mcp.reason === 'string' ? mcp.reason : undefined;
  // unsupported 时常表示未配置 lifecycle manager
  const configuredHint = state !== 'unsupported';
  return {
    ...(state !== undefined && { state }),
    ...(reason !== undefined && { reason }),
    configuredHint,
  };
}

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
        typeof t === 'string' ? t : String((t as { name?: string }).name || t)
      )
    : [];
  const toolCount =
    typeof o.cachedToolCount === 'number'
      ? o.cachedToolCount
      : typeof o.toolCount === 'number'
        ? o.toolCount
        : tools.length || undefined;
  const state = normalizeState(o.state ?? o.status ?? o.readiness);
  const transport =
    typeof o.transport === 'string'
      ? o.transport
      : typeof o.type === 'string'
        ? o.type
        : undefined;
  const lastError =
    typeof o.lastError === 'string'
      ? o.lastError
      : typeof o.error === 'string'
        ? o.error
        : undefined;
  const startedAt = typeof o.startedAt === 'string' ? o.startedAt : undefined;
  return {
    id,
    name,
    state,
    status: typeof o.status === 'string' ? o.status : state,
    tools,
    ...(toolCount !== undefined && { toolCount }),
    ...(transport !== undefined && { transport }),
    ...(lastError !== undefined && { lastError }),
    ...(startedAt !== undefined && { startedAt }),
  };
}

async function ensureConnected(timeoutMs = 500): Promise<boolean> {
  const client = getDesktopDaemonClient();
  if (client.isConnected()) return true;
  return client.waitUntilConnected(timeoutMs);
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || String(e);
  return String(e ?? '');
}

/** 识别引擎「不支持启停」类错误 */
export function isMcpStartStopUnsupportedError(input: unknown): boolean {
  const text = errorText(input).toLowerCase();
  if (!text) return false;
  return (
    /not supported|unsupported|unsupported_capability|no such method|is not a function|mcp server (start|stop) not supported/.test(
      text
    ) ||
    (/startserver|stopserver/.test(text) && /not|missing|undefined/.test(text))
  );
}

function rememberStartStopUnsupported(detail?: string): void {
  rememberedStartStopUnsupported = true;
  rememberedStartStopMessage =
    detail?.trim() || rememberedStartStopMessage || START_STOP_UNSUPPORTED_HINT;
}

/**
 * 从 list-capabilities 取 mcp.lifecycle（可选，失败则忽略）。
 * 60s 内复用缓存，供 MCP 设置与 T7 product capabilities 共用。
 */
export async function fetchMcpLifecycleCapability(opts?: {
  force?: boolean;
}): Promise<{
  state?: string;
  reason?: string;
  configuredHint?: boolean;
} | null> {
  if (!opts?.force) {
    const hit = getListCapabilitiesSnapshot();
    if (hit) return hit.lifecycle ?? null;
  }

  const client = getDesktopDaemonClient();
  try {
    if (!(await ensureConnected())) return null;
    const res = (await client.request(
      { type: 'list-capabilities' },
      'capabilities-response',
      8_000
    )) as Record<string, unknown>;
    const lifecycle = parseMcpLifecycleFromCapsResponse(res);
    listCapsCache = {
      at: Date.now(),
      ...(lifecycle?.state !== undefined && { mcp: lifecycle.state }),
      ...(res !== undefined && { raw: res }),
      lifecycle,
    };
    return lifecycle;
  } catch (e) {
    logInternalError('fetchMcpLifecycleCapability', e);
    // 缓存失败结果的短窗口，避免设置页连打
    listCapsCache = {
      at: Date.now(),
      lifecycle: null,
    };
    return null;
  }
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
      8_000
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

export async function listMcpServers(): Promise<McpListResult> {
  const client = getDesktopDaemonClient();
  try {
    if (!(await ensureConnected())) {
      return {
        ok: false,
        configured: false,
        servers: [],
        error: '引擎未连接，无法读取 MCP 列表',
        errorCode: 'not_connected',
      };
    }

    let statusSnap = await fetchMcpStatus();
    let configured = statusSnap.configured;

    const res = (await client.request(
      { type: 'list-mcp-servers' },
      'mcp-servers-listed',
      10_000
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
    const msg = errorText(e);
    const errorCode = /timeout/i.test(msg)
      ? 'list_timeout'
      : /not connected|disconnected/i.test(msg)
        ? 'not_connected'
        : 'list_failed';
    return {
      ok: false,
      configured: false,
      servers: [],
      error: msg || '读取 MCP 列表失败',
      errorCode,
    };
  }
}

/**
 * 探测列表与启停是否可用（不发起真实 start/stop，除非此前已记住失败）。
 * - list 成功 → canList
 * - 列表能返回 servers 且 start 未记过 unsupported → 允许 canStartStop
 * - 未配置且列表空 / capability unsupported / 曾记过 unsupported → canStartStop false
 * - experimental 不再一律 false（R1 已对齐 startServer/stopServer）
 * @param listResult 可选；传入可避免重复 list-mcp-servers
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

  let capabilityState: string | undefined;
  let capabilityReason: string | undefined;
  const cap = await fetchMcpLifecycleCapability();
  if (cap) {
    capabilityState = cap.state;
    capabilityReason = cap.reason;
  }

  const configured = list.configured || list.servers.length > 0;
  const emptyUnconfigured = list.servers.length === 0 && !configured;

  // 仅真正 unsupported / 后端未接线时禁用；experimental/implemented/degraded 允许启停
  const capBlocksStart =
    capabilityState === 'unsupported' ||
    capabilityState === 'backend-not-wired';

  let canStartStop = true;
  let message: string | undefined;

  if (rememberedStartStopUnsupported) {
    canStartStop = false;
    message = rememberedStartStopMessage || START_STOP_UNSUPPORTED_HINT;
  } else if (emptyUnconfigured || capBlocksStart) {
    canStartStop = false;
    message =
      capabilityReason?.trim() ||
      (emptyUnconfigured
        ? '引擎侧未配置 MCP 服务；列表为空时无法从界面启停'
        : START_STOP_UNSUPPORTED_HINT);
  } else if (list.servers.length > 0 || configured) {
    // list 非空或已配置：允许启停（experimental 不再一刀切禁用）
    canStartStop = true;
    message = capabilityReason?.trim();
  }

  return {
    canList: true,
    canStartStop,
    configured,
    ...(capabilityState !== undefined && { capabilityState }),
    ...(message !== undefined && { message }),
  };
}

export async function startMcpServer(
  serverId: string
): Promise<McpControlResult> {
  if (rememberedStartStopUnsupported) {
    return {
      ok: false,
      serverId,
      error: rememberedStartStopMessage || START_STOP_UNSUPPORTED_HINT,
      errorCode: 'unsupported',
    };
  }

  const client = getDesktopDaemonClient();
  try {
    if (!(await ensureConnected())) {
      return {
        ok: false,
        serverId,
        error: '引擎未连接，无法启动 MCP',
        errorCode: 'not_connected',
      };
    }
    const res = (await client.request(
      { type: 'start-mcp-server', serverId },
      'mcp-server-started',
      30_000
    )) as Record<string, unknown>;
    return {
      ok: true,
      serverId,
      state: typeof res.state === 'string' ? res.state : 'starting',
    };
  } catch (e) {
    logInternalError('startMcpServer', e);
    const msg = errorText(e);
    if (isMcpStartStopUnsupportedError(msg)) {
      rememberStartStopUnsupported(START_STOP_UNSUPPORTED_HINT);
      return {
        ok: false,
        serverId,
        error: START_STOP_UNSUPPORTED_HINT,
        errorCode: 'unsupported',
      };
    }
    return {
      ok: false,
      serverId,
      error: msg || '启动 MCP 失败',
      errorCode: 'start_failed',
    };
  }
}

export async function stopMcpServer(
  serverId: string
): Promise<McpControlResult> {
  if (rememberedStartStopUnsupported) {
    return {
      ok: false,
      serverId,
      error: rememberedStartStopMessage || START_STOP_UNSUPPORTED_HINT,
      errorCode: 'unsupported',
    };
  }

  const client = getDesktopDaemonClient();
  try {
    if (!(await ensureConnected())) {
      return {
        ok: false,
        serverId,
        error: '引擎未连接，无法停止 MCP',
        errorCode: 'not_connected',
      };
    }
    const res = (await client.request(
      { type: 'stop-mcp-server', serverId },
      'mcp-server-stopped',
      20_000
    )) as Record<string, unknown>;
    return {
      ok: true,
      serverId,
      state: typeof res.state === 'string' ? res.state : 'stopped',
    };
  } catch (e) {
    logInternalError('stopMcpServer', e);
    const msg = errorText(e);
    if (isMcpStartStopUnsupportedError(msg)) {
      rememberStartStopUnsupported(START_STOP_UNSUPPORTED_HINT);
      return {
        ok: false,
        serverId,
        error: START_STOP_UNSUPPORTED_HINT,
        errorCode: 'unsupported',
      };
    }
    return {
      ok: false,
      serverId,
      error: msg || '停止 MCP 失败',
      errorCode: 'stop_failed',
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
