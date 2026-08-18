// 端点解析（D4 §6.3 / M5 §4.1）：wss/https 同端口映射 + 平台默认 + 端口探测候选
// 网关默认端口 8765（裁决修正 6：原 7821 作废）；env 覆盖见 src/domain/types/env.ts
// （EXPO_PUBLIC_ENGINE_URL 优先级 1，D8 §6.2）。
//
// 探测端口范围 8765-8775（任务书口径）：桌面默认监听 8765（D3 §3.1），
// 端口被占时可能启动到后续端口；候选端点枚举为纯函数（host × 端口笛卡尔积），
// 实际探测（connect 超时）是 IO，由上层接线（R2-03 或数据层）。

import type { Platform } from '@crish/shared-types';

/** 网关默认端口（D3 §3.1 / 裁决修正 6：统一 8765） */
export const DEFAULT_GATEWAY_PORT = 8765;
/** 探测端口范围下界（含） */
export const GATEWAY_PORT_RANGE_MIN = 8765;
/** 探测端口范围上界（含） */
export const GATEWAY_PORT_RANGE_MAX = 8775;
/** 中继端口占位（中继服务本期不实现，D3 §3.1 仅协议留位） */
export const DEFAULT_RELAY_PORT = 8765;

/** WS 地址构造（生产强制 wss，v1 无「信任所有证书」开关，D4 §6.1.5；无 TLS 降级需显式开启） */
export function resolveWsUrl(
  host: string,
  port = DEFAULT_GATEWAY_PORT,
  tls = true
): string {
  return `${tls ? 'wss' : 'ws'}://${host}:${port}`;
}

/** HTTP 地址构造（配对握手 / 令牌刷新走 https 同端口） */
export function resolveHttpUrl(
  host: string,
  port = DEFAULT_GATEWAY_PORT,
  tls = true
): string {
  return `${tls ? 'https' : 'http'}://${host}:${port}`;
}

/** 中继地址占位（D3 §3.1 / M2 中继服务未实现；接口留位供 R2-04+ 接线） */
export function resolveRelayUrl(
  relayHost: string,
  port = DEFAULT_RELAY_PORT,
  tls = true
): string {
  return `${tls ? 'wss' : 'ws'}://${relayHost}:${port}`;
}

/** 候选端点（host × 端口；tls 承载标记） */
export interface CandidateEndpoint {
  host: string;
  port: number;
  tls: boolean;
  /** WS 地址 */
  wsUrl: string;
  /** HTTP 地址（配对握手 / 令牌刷新） */
  httpUrl: string;
}

export interface CandidateOptions {
  /** 端口范围 [min, max] 闭区间，默认 [8765, 8775] */
  portRange?: readonly [number, number];
  tls?: boolean;
}

/** 平台默认候选主机（真机须经 env EXPO_PUBLIC_ENGINE_URL 或手动输入，D8 §6.2） */
export function defaultHosts(
  platform: Platform,
  extra: string[] = []
): string[] {
  const hosts: string[] = [];
  if (platform === 'android') hosts.push('10.0.2.2', 'localhost');
  else if (platform === 'ios') hosts.push('localhost');
  for (const h of extra) if (!hosts.includes(h)) hosts.push(h);
  return hosts;
}

/** 候选端点枚举：hosts × 端口范围笛卡尔积（探测顺序 = 默认端口优先？不——按范围升序，含 8765 首） */
export function candidateEndpoints(
  hosts: string[],
  opts: CandidateOptions = {}
): CandidateEndpoint[] {
  const [min, max] = opts.portRange ?? [
    GATEWAY_PORT_RANGE_MIN,
    GATEWAY_PORT_RANGE_MAX,
  ];
  const tls = opts.tls ?? true;
  const out: CandidateEndpoint[] = [];
  for (const host of hosts) {
    for (let port = min; port <= max; port++) {
      out.push({
        host,
        port,
        tls,
        wsUrl: resolveWsUrl(host, port, tls),
        httpUrl: resolveHttpUrl(host, port, tls),
      });
    }
  }
  return out;
}

/** 探测结果（reachable 由上层 connect 探测产生；纯函数只消费结果做选择） */
export interface ProbeOutcome {
  wsUrl: string;
  reachable: boolean;
  /** 连通延迟（ms，探测测得） */
  latencyMs?: number;
}

/** 端点选择：首个可达优先，同可达取最小延迟（探测执行是 IO，本函数为纯选择逻辑） */
export function selectEndpoint(probes: ProbeOutcome[]): ProbeOutcome | null {
  const reachable = probes.filter((p) => p.reachable);
  if (reachable.length === 0) return null;
  reachable.sort(
    (a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity)
  );
  return reachable[0] ?? null;
}
