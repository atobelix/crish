/**
 * 活跃本地开发端口探测模块：
 * 负责通过 Vite dev server 中间件 `GET /__crish_active_ports` 获取真实处于 LISTEN 状态的活跃开发端口。
 * 具备快速超时熔断、内存降级缓存与 React Hook 封装。
 * UTF-8 无 BOM，遵循单向数据流与架构干净收敛。
 */
import React from 'react';

let cachedPorts: number[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 4000;
const DEFAULT_TIMEOUT_MS = 800;

/**
 * 纯函数：校验端口数据格式合法性
 */
export function sanitizePortList(data: unknown): number[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (p): p is number =>
      typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536
  );
}

/**
 * 读取当前缓存的活跃端口（若存在）
 */
export function getCachedActivePorts(): number[] | null {
  return cachedPorts;
}

/**
 * 设置/更新活跃端口缓存（供单元测试注入与预热使用）
 */
export function setCachedActivePorts(ports: number[] | null): void {
  cachedPorts = ports ? [...ports] : null;
  lastFetchTime = Date.now();
}

/**
 * 清除活跃端口缓存
 */
export function clearActivePortCache(): void {
  cachedPorts = null;
  lastFetchTime = 0;
}

export interface FetchActiveDevPortsOptions {
  timeoutMs?: number;
  skipCache?: boolean;
}

/**
 * 发起活跃端口探测网络请求（带超时控制与降级缓存）：
 * 优先读取 TTL 内的内存缓存；若过期则通过 `/__crish_active_ports` 请求后端探测；
 * 若请求超时或失败，平滑降级返回既有缓存或空数组。
 */
export async function fetchActiveDevPorts(
  options?: FetchActiveDevPortsOptions
): Promise<number[]> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const skipCache = options?.skipCache ?? false;
  const now = Date.now();

  if (!skipCache && cachedPorts !== null && now - lastFetchTime < CACHE_TTL_MS) {
    return [...cachedPorts];
  }

  // audit-repair-202609 · T20：探测端点是 dev server 中间件，生产构建
  // 不存在——非 dev 环境直接返回空（不发必 404 请求），空态不展示
  // 「运行中的本地服务」。
  if (!import.meta.env.DEV) {
    return [];
  }

  // 跨运行环境判断：若无 globalThis.fetch 则回退
  if (typeof fetch !== 'function') {
    return cachedPorts ? [...cachedPorts] : [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // 忽略 abort 异常
    }
  }, timeoutMs);

  try {
    const res = await fetch('/__crish_active_ports', {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      return cachedPorts ? [...cachedPorts] : [];
    }

    const json = await res.json();
    const ports = sanitizePortList(json);
    cachedPorts = ports;
    lastFetchTime = Date.now();
    return ports;
  } catch {
    // 网络错误或超时：降级返回既有缓存或空数组，不阻塞渲染
    return cachedPorts ? [...cachedPorts] : [];
  } finally {
    clearTimeout(timer);
  }
}

export interface ActiveDevPortsState {
  ports: number[];
  loading: boolean;
  refresh: () => Promise<number[]>;
}

/**
 * React Hook: 获取并订阅当前活跃的本地开发端口。
 * 组件挂载时自动探测；纯对象 API（audit-repair-202609 · T25：移除为支持
 * 数组解构而生的 Iterable 杂交通道——唯一消费方只做对象解构）。
 */
export function useActiveDevPorts(): ActiveDevPortsState {
  const [ports, setPorts] = React.useState<number[]>(() => cachedPorts ?? []);
  const [loading, setLoading] = React.useState<boolean>(cachedPorts === null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const detected = await fetchActiveDevPorts({ skipCache: true });
      setPorts(detected);
      return detected;
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    let mounted = true;
    fetchActiveDevPorts().then((res) => {
      if (!mounted) return;
      setPorts((prev) => {
        if (
          prev.length === res.length &&
          prev.every((val, idx) => val === res[idx])
        ) {
          return prev;
        }
        return res;
      });
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return React.useMemo(
    () => ({
      ports,
      loading,
      refresh,
    }),
    [ports, loading, refresh]
  );
}
