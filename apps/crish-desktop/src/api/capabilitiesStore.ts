/**
 * T7 轻量 product capabilities 门闩：
 * 缓存 daemon list-capabilities + MCP probe，供设置/MCP 展示诚实状态。
 * 复用 mcpApi（probeMcpControl / fetchMcpLifecycleCapability），非能力系统重写。
 */

import {
  fetchMcpLifecycleCapability,
  getListCapabilitiesSnapshot,
  invalidateListCapabilitiesCache,
  probeMcpControl,
  type McpControlProbe,
} from './mcpApi';
import { logInternalError } from './userFacingErrors';

const CACHE_TTL_MS = 60_000;

export type CachedCapabilities = {
  at: number;
  /** mcp.lifecycle capability state（若已知） */
  mcp?: string;
  raw?: unknown;
  probe?: McpControlProbe;
};

let cache: CachedCapabilities | null = null;
let inflight: Promise<CachedCapabilities> | null = null;

function isFresh(c: CachedCapabilities | null): boolean {
  return !!c && Date.now() - c.at < CACHE_TTL_MS;
}

/** 最近一次 product capabilities 快照（可能过期；UI 可读 at 自判） */
export function getCachedCapabilities(): CachedCapabilities | null {
  return cache;
}

/**
 * 设置页 / MCP 用：probeMcpControl + list-capabilities（经 mcpApi 60s 缓存）。
 */
export async function refreshProductCapabilities(
  force = false,
): Promise<CachedCapabilities> {
  if (!force && isFresh(cache) && cache) return cache;
  if (inflight) return inflight;

  inflight = (async (): Promise<CachedCapabilities> => {
    if (force) invalidateListCapabilitiesCache();

    let probe: McpControlProbe | undefined;
    try {
      // probe 内会 list-mcp-servers + fetchMcpLifecycleCapability（带 list-caps 缓存）
      probe = await probeMcpControl();
    } catch (e) {
      logInternalError('refreshProductCapabilities.probe', e);
      // 即使 list 失败，仍尽量拉 capabilities
      try {
        await fetchMcpLifecycleCapability({ force });
      } catch (e2) {
        logInternalError('refreshProductCapabilities.caps', e2);
      }
    }

    const snap = getListCapabilitiesSnapshot();
    const mcp = snap?.mcp ?? probe?.capabilityState;
    const next: CachedCapabilities = {
      at: Date.now(),
      ...(mcp !== undefined && { mcp }),
      ...(snap?.raw !== undefined && { raw: snap.raw }),
      ...(probe !== undefined && { probe }),
    };
    cache = next;
    return next;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
