/**
 * 引擎 MCP 列表（正式版 H3：仅展示，配置齐全时可见）
 */

import { getDesktopDaemonClient } from './daemonClient';
import { logInternalError } from './userFacingErrors';

export type McpServerInfo = {
  id: string;
  name: string;
  status?: string;
  tools?: string[];
  transport?: string;
  [key: string]: unknown;
};

export type McpListResult = {
  ok: boolean;
  configured: boolean;
  servers: McpServerInfo[];
  error?: string;
};

export async function listMcpServers(): Promise<McpListResult> {
  const client = getDesktopDaemonClient();
  try {
    if (!client.isConnected()) {
      const ok = await client.waitUntilConnected(8_000);
      if (!ok) return { ok: false, configured: false, servers: [], error: 'not_connected' };
    }

    // 先从 get-status 看是否配置
    let configured = false;
    try {
      const status = (await client.request(
        { type: 'get-status' },
        'status-response',
        8_000,
      )) as Record<string, unknown>;
      const mcp = status.mcpStatus as Record<string, unknown> | undefined;
      if (mcp && typeof mcp === 'object') {
        configured = Boolean(mcp.configured);
      }
    } catch {
      /* ignore */
    }

    const res = (await client.request(
      { type: 'list-mcp-servers' },
      'mcp-servers-listed',
      10_000,
    )) as Record<string, unknown>;

    const list = Array.isArray(res.servers) ? res.servers : [];
    const servers: McpServerInfo[] = list
      .map((s, i) => {
        const o = s as Record<string, unknown>;
        if (!o || typeof o !== 'object') return null;
        const id = String(o.id ?? o.name ?? `mcp-${i}`);
        const name = String(o.name ?? o.id ?? id);
        const tools = Array.isArray(o.tools)
          ? o.tools.map((t) => (typeof t === 'string' ? t : String((t as { name?: string }).name || t)))
          : [];
        return {
          id,
          name,
          status: typeof o.status === 'string' ? o.status : undefined,
          tools,
          transport: typeof o.transport === 'string' ? o.transport : typeof o.type === 'string' ? o.type : undefined,
        };
      })
      .filter(Boolean) as McpServerInfo[];

    if (servers.length > 0) configured = true;

    return { ok: true, configured, servers };
  } catch (e) {
    logInternalError('listMcpServers', e);
    return {
      ok: false,
      configured: false,
      servers: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
