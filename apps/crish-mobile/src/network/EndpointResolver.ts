// 端点解析（D4 §6.3 / M5 §4.1）：wss/https 同端口映射 + 平台默认
// 网关默认端口 8765（裁决修正 6：原 7821 作废）；env 覆盖见 src/domain/types/env.ts
export const DEFAULT_GATEWAY_PORT = 8765;

/** WS 地址构造（生产强制 wss，v1 无「信任所有证书」开关，D4 §6.1.5） */
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
