/**
 * 活跃本地开发端口与服务探测模块：
 * 负责通过双轨机制发现处于运行状态的本地 Web 服务：
 * 1. Vite dev server 中间件 `GET /__crish_active_ports`
 * 2. 原生前端并发探针（通过 no-cors 快速探测本地常见开发端口），支持生产构建与桌面环境
 * 具备快速超时熔断、内存降级缓存与服务类型智能推断。
 * UTF-8 无 BOM，遵循单向数据流与架构干净收敛。
 */
import React from 'react';

let cachedPorts: number[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 4000;
const DEFAULT_TIMEOUT_MS = 800;
const PROBE_TIMEOUT_MS = 250;

/**
 * 常见 Web 开发端口池（覆盖现代前端框架、后端及常用 AI/Web 应用默认端口）
 */
export const DEFAULT_DEV_PORTS = [
  // Vite & 现代前端工具链
  5173, 5174, 5175, 5176,
  // Next.js, Create React App, Nuxt, Express, Nest
  3000, 3001, 3002, 3003,
  // Vite 产物预览
  4173, 4174,
  // Webpack, Java Spring, Vue CLI, 通用 HTTP
  8080, 8081, 8082, 8000, 8001,
  // Flask, ASP.NET Core
  5000, 5001,
  // Angular CLI
  4200,
  // Python Streamlit 数据应用
  8501,
  // Python Gradio (AI / LLM 演示界面)
  7860,
  // Jupyter Notebook / Lab
  8888,
  // GraphQL / Hexo / Node 服务
  4000,
  // 微服务 / Go / MinIO
  9000, 9090,
  // Parcel 打包服务
  1234,
];

export interface ActiveServiceInfo {
  port: number;
  url: string;
  name: string;
  tag: string;
  description?: string;
}

/**
 * 根据端口号推断服务类型与友好展示标签
 */
export function inferServiceInfo(port: number): ActiveServiceInfo {
  const url = `http://localhost:${port}`;
  if (port >= 5173 && port <= 5179) {
    return {
      port,
      url,
      name: 'Vite Dev Server',
      tag: 'Vite / Web',
      description: 'Frontend HMR dev server',
    };
  }
  if (port >= 3000 && port <= 3009) {
    return {
      port,
      url,
      name: 'Web App Server',
      tag: 'Next.js / Node',
      description: 'Full-stack development server',
    };
  }
  if (port >= 4173 && port <= 4175) {
    return {
      port,
      url,
      name: 'Vite Preview',
      tag: 'Vite Preview',
      description: 'Production build preview server',
    };
  }
  if (port >= 8080 && port <= 8089) {
    return {
      port,
      url,
      name: 'Local Web Server',
      tag: 'Web Server',
      description: 'General web application server',
    };
  }
  if (port >= 8000 && port <= 8009) {
    return {
      port,
      url,
      name: 'Backend API Server',
      tag: 'FastAPI / Django',
      description: 'Python or backend API server',
    };
  }
  if (port >= 5000 && port <= 5005) {
    return {
      port,
      url,
      name: 'Flask / Backend Service',
      tag: 'Flask / ASP.NET',
      description: 'Local backend service',
    };
  }
  if (port === 4200) {
    return {
      port,
      url,
      name: 'Angular Dev Server',
      tag: 'Angular',
      description: 'Angular CLI development server',
    };
  }
  if (port === 8501) {
    return {
      port,
      url,
      name: 'Streamlit App',
      tag: 'Streamlit',
      description: 'Python interactive data application',
    };
  }
  if (port === 7860) {
    return {
      port,
      url,
      name: 'Gradio AI App',
      tag: 'Gradio',
      description: 'AI model demo interface',
    };
  }
  if (port === 8888) {
    return {
      port,
      url,
      name: 'Jupyter Notebook',
      tag: 'Jupyter',
      description: 'Interactive notebook server',
    };
  }
  if (port === 4000) {
    return {
      port,
      url,
      name: 'Local App Server',
      tag: 'Node / Web',
      description: 'Local application service',
    };
  }
  return {
    port,
    url,
    name: `Local Service :${port}`,
    tag: 'Web Service',
    description: 'Active local network service',
  };
}

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

/**
 * 原生前端单端口 HTTP 探测（带超时）：
 * 基于 mode: 'no-cors' 请求 loopback 地址。
 * 若端口上有 HTTP 监听，握手成功并 resolve；未开端口内核立即拒绝抛出异常。
 */
export async function probeSinglePort(
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<boolean> {
  if (typeof fetch !== 'function') return false;
  // 排除宿主自身的开发端口（避免内嵌自身）
  if (typeof window !== 'undefined' && window.location?.port) {
    const cur = parseInt(window.location.port, 10);
    if (cur === port) return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      /* swallow */
    }
  }, timeoutMs);

  try {
    // 优先通过 localhost 探测，覆盖 IPv6 (::1) 与 IPv4 (127.0.0.1) 双栈开发服务
    await fetch(`http://localhost:${port}`, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    });
    return true;
  } catch {
    // 回退尝试 127.0.0.1 纯 IPv4 地址
    try {
      const fallbackController = new AbortController();
      const fallbackTimer = setTimeout(() => {
        try {
          fallbackController.abort();
        } catch {
          /* swallow */
        }
      }, timeoutMs);
      await fetch(`http://127.0.0.1:${port}`, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        signal: fallbackController.signal,
      });
      clearTimeout(fallbackTimer);
      return true;
    } catch {
      return false;
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并发探测指定候选端口列表，返回所有活跃可连接的端口
 */
export async function probeLocalDevPorts(
  candidatePorts: number[] = DEFAULT_DEV_PORTS,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<number[]> {
  const uniquePorts = Array.from(new Set(candidatePorts));
  const results = await Promise.allSettled(
    uniquePorts.map(async (port) => {
      const active = await probeSinglePort(port, timeoutMs);
      return active ? port : null;
    })
  );

  const activePorts: number[] = [];
  for (const res of results) {
    if (res.status === 'fulfilled' && res.value !== null) {
      activePorts.push(res.value);
    }
  }
  return activePorts.sort((a, b) => a - b);
}

export interface FetchActiveDevPortsOptions {
  timeoutMs?: number;
  skipCache?: boolean;
  candidatePorts?: number[];
}

/**
 * 发起活跃端口探测网络请求（带超时控制、双轨探测与降级缓存）：
 * 优先读取 TTL 内的内存缓存；
 * 优先通过 `/__crish_active_ports` 请求后端探测；
 * 若返回 404（生产构建或非 Vite dev 模式）或空端口，则平滑降级为前端 direct probing；
 * 若网络错误或测试 Mock 拒绝，平滑降级返回既有缓存或空数组。
 */
export async function fetchActiveDevPorts(
  options?: FetchActiveDevPortsOptions
): Promise<number[]> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const skipCache = options?.skipCache ?? false;
  const now = Date.now();

  if (
    !skipCache &&
    cachedPorts !== null &&
    now - lastFetchTime < CACHE_TTL_MS
  ) {
    return [...cachedPorts];
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

    if (res.ok) {
      const json = await res.json();
      const ports = sanitizePortList(json);
      cachedPorts = ports;
      lastFetchTime = Date.now();
      return ports;
    }

    // 若中间件返回 404（生产包或端点不存在），尝试直接端口探测
    if (res.status === 404) {
      const direct = await probeLocalDevPorts(options?.candidatePorts);
      cachedPorts = direct;
      lastFetchTime = Date.now();
      return direct;
    }

    return cachedPorts ? [...cachedPorts] : [];
  } catch {
    // 网络错误或超时：降级返回既有缓存或空数组，不阻塞渲染
    return cachedPorts ? [...cachedPorts] : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 获取活跃服务全量信息列表（端口 + 服务名称 + 类型标签）
 */
export async function fetchActiveServices(
  options?: FetchActiveDevPortsOptions
): Promise<ActiveServiceInfo[]> {
  let ports = await fetchActiveDevPorts(options);
  // 若中间件返回空且允许回退，补充快速探测
  if (ports.length === 0 && typeof window !== 'undefined') {
    const direct = await probeLocalDevPorts(options?.candidatePorts, 200);
    if (direct.length > 0) {
      ports = direct;
      setCachedActivePorts(direct);
    }
  }
  return ports.map(inferServiceInfo);
}

export interface ActiveDevPortsState {
  ports: number[];
  services: ActiveServiceInfo[];
  loading: boolean;
  refresh: () => Promise<number[]>;
}

/**
 * React Hook: 获取并订阅当前活跃的本地开发端口与服务。
 * 组件挂载时自动探测；纯对象 API。
 */
export function useActiveDevPorts(): ActiveDevPortsState {
  const [ports, setPorts] = React.useState<number[]>(() => cachedPorts ?? []);
  const [loading, setLoading] = React.useState<boolean>(cachedPorts === null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      let detected = await fetchActiveDevPorts({ skipCache: true });
      // 如果 dev 中间件没有发现任何端口，自动进行一次本地候选端口直测
      if (detected.length === 0 && typeof window !== 'undefined') {
        const direct = await probeLocalDevPorts(DEFAULT_DEV_PORTS, 250);
        if (direct.length > 0) {
          detected = direct;
          setCachedActivePorts(direct);
        }
      }
      setPorts(detected);
      return detected;
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    let mounted = true;
    fetchActiveDevPorts().then(async (res) => {
      if (!mounted) return;
      let finalPorts = res;
      if (finalPorts.length === 0 && typeof window !== 'undefined') {
        const direct = await probeLocalDevPorts(DEFAULT_DEV_PORTS, 200);
        if (direct.length > 0) {
          finalPorts = direct;
          setCachedActivePorts(direct);
        }
      }
      if (!mounted) return;
      setPorts((prev) => {
        if (
          prev.length === finalPorts.length &&
          prev.every((val, idx) => val === finalPorts[idx])
        ) {
          return prev;
        }
        return finalPorts;
      });
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const services = React.useMemo(() => ports.map(inferServiceInfo), [ports]);

  return React.useMemo(
    () => ({
      ports,
      services,
      loading,
      refresh,
    }),
    [ports, services, loading, refresh]
  );
}
