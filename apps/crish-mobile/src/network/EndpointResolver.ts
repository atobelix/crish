// 端点解析：WS/HTTP 同端口映射（网关默认 8765）。
// env 覆盖见 EXPO_PUBLIC_ENGINE_URL（优先级 1）。

/** 网关默认端口（D3 §3.1：统一 8765） */
export const DEFAULT_GATEWAY_PORT = 8765;

/** 引擎传输安全开关（仅开发构建可关闭）：生产构建恒 wss；
 *  开发构建仅在精确值 `false` 时使用明文 ws（联调 harness），其它取值 → wss。 */
export function engineTlsEnabled(): boolean {
  if (!__DEV__) return true;
  return process.env.EXPO_PUBLIC_ENGINE_TLS !== 'false';
}

/** WS 地址构造（必须挂载 /v1/events 路由；已认证会话携带 ?token= 查询参数） */
export function resolveWsUrl(
  host: string,
  port = DEFAULT_GATEWAY_PORT,
  tls = true,
  token?: string
): string {
  const protocol = tls ? 'wss' : 'ws';
  const basePath = `${protocol}://${host}:${port}/v1/events`;
  if (token && token.trim().length > 0) {
    return `${basePath}?token=${encodeURIComponent(token.trim())}`;
  }
  return basePath;
}

/** 注入鉴权 token 的 WS 地址安全构造 */
export function buildAuthenticatedWsUrl(
  rawUrl: string,
  params: { token?: string }
): string {
  if (!params.token) return rawUrl;
  const separator = rawUrl.includes('?') ? '&' : '?';
  if (rawUrl.includes('token=')) return rawUrl;
  return `${rawUrl}${separator}token=${encodeURIComponent(params.token)}`;
}
