/**
 * apps/crish-mobile/src/adapters/webSearch/providers/types.ts
 *
 * 移动端 BYOK 商业搜索引擎直连驱动统一类型与接口契约
 * 依据架构方案：docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §2, §4
 */

export interface SearchOptions {
  /** 最大返回结果条数（默认 5） */
  maxResults?: number;
  /** 单次网络请求超时时间（毫秒，默认 10000ms） */
  timeoutMs?: number;
  /** 可选的外部请求中断信号 */
  signal?: AbortSignal;
  /** 自定义 API 节点 Host（如私有化 SearXNG 实例地址或自定义反代端点） */
  customHost?: string;
  /** Google Programmable Search (CSE) 搜索引擎 ID (cx) */
  googleCseCx?: string;
  /** HTTP Basic Auth 认证对象（SearXNG 等） */
  basicAuth?: {
    username: string;
    password?: string;
  };
  basicAuthUsername?: string;
  basicAuthPassword?: string;
  /** 额外的自定义请求头注入 */
  headers?: Record<string, string>;
  /** 强制指定设备区域（用于测试或强制节点选择: 'mainland-china' | 'global'） */
  forceRegion?: 'mainland-china' | 'global';
}

/** 跨端统一的单条网页搜索结果事实源（Grounding Source） */
export interface WebSearchSource {
  /** 唯一标号（如 tavily-1, brave-2, tavily-direct-answer） */
  readonly id: string;
  /** 网页标题 */
  readonly title: string;
  /** 规范化后的目标 URL */
  readonly url: string;
  /** 网页核心摘要片段（已清洗 HTML 标签与多余空白） */
  readonly snippet: string;
  /** 站点域名（如 "github.com"，用于 UI 微胶囊徽标展示） */
  readonly domain: string;
  /** 搜索引擎来源标识（如 "tavily", "jina", "brave", "google_cse", "bocha", "searxng"） */
  readonly provider: string;
  /** 发布时间或快照抓取时间（可选） */
  readonly publishedDate?: string | undefined;
  /** 关联度评分（0.0 ~ 1.0，可选） */
  readonly score?: number | undefined;
  /** 站点 Favicon 图标地址（可选） */
  readonly faviconUrl?: string | undefined;
  /** 正文全文提取（可选，用于深度阅读与 Direct Answer） */
  readonly fullContent?: string | undefined;
}

/** 统一的搜索驱动适配器接口契约 */
export interface SearchProviderAdapter {
  /** 服务商唯一标识（如 'tavily', 'jina', 'brave', 'google_cse', 'bocha', 'searxng'） */
  readonly id: string;
  /** 服务商人类可读显示名称 */
  readonly name: string;
  /** 执行搜索检索并返回结构化结果列表 */
  search(
    query: string,
    apiKey: string,
    options?: SearchOptions
  ): Promise<WebSearchSource[]>;
  /** 检查 API Key 连通性与健康度（可选） */
  checkHealth?(
    apiKey: string,
    options?: SearchOptions
  ): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

export type SearchErrorCode =
  | 'AUTH_ERROR' // 401, 403 鉴权失败或 Key 无效
  | 'RATE_LIMIT' // 429 频控超限或配额耗尽
  | 'NETWORK_ERROR' // 网络断开、DNS 失败、连接超时
  | 'TIMEOUT' // 超时被中断
  | 'BAD_RESPONSE' // 5xx 或响应体非有效 JSON/畸变
  | 'CONFIG_ERROR'; // 缺少必填参数（如 Google CSE 缺少 cx）

export class SearchProviderError extends Error {
  constructor(
    message: string,
    public readonly providerId: string,
    public readonly status?: number,
    public readonly code?: SearchErrorCode,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = 'SearchProviderError';
  }
}

/**
 * 从 URL 安全提取主域名
 */
export function extractDomain(urlStr: string): string {
  if (!urlStr || typeof urlStr !== 'string') return '';
  try {
    const u = new URL(urlStr);
    return u.hostname || '';
  } catch {
    const match = urlStr.match(/^https?:\/\/([^/:]+)/i);
    return match?.[1] ?? '';
  }
}

/**
 * 跨平台安全 Base64 编码
 */
export function encodeBase64(str: string): string {
  if (typeof btoa === 'function') {
    return btoa(str);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'utf-8').toString('base64');
  }
  return '';
}

/**
 * 统一处理非 2xx HTTP 错误响应
 */
export async function handleHttpError(
  res: Response,
  providerId: string
): Promise<never> {
  const status = res.status;
  let errBody = '';
  try {
    errBody = await res.text();
  } catch {
    errBody = res.statusText;
  }

  let code: SearchErrorCode = 'BAD_RESPONSE';
  if (status === 401 || status === 403) {
    code = 'AUTH_ERROR';
  } else if (status === 429) {
    code = 'RATE_LIMIT';
  }

  throw new SearchProviderError(
    `[${providerId}] Request failed with HTTP ${status}: ${errBody.slice(0, 300)}`,
    providerId,
    status,
    code
  );
}

/**
 * 带有超时控制和 signal 级联的 fetch 包装
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  options?: SearchOptions
): Promise<Response> {
  const timeoutMs = options?.timeoutMs;
  const callerSignal = options?.signal;

  if (!timeoutMs && !callerSignal) {
    return await fetch(url, init);
  }

  const controller = new AbortController();
  let timeoutId: any = null;

  if (timeoutMs && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  const onCallerAbort = () => {
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal) {
    if (callerSignal.aborted) {
      if (timeoutId) clearTimeout(timeoutId);
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (controller.signal.aborted) {
      if (callerSignal?.aborted) {
        throw err;
      }
      throw new SearchProviderError(
        `Request timed out after ${timeoutMs}ms`,
        'network',
        undefined,
        'TIMEOUT',
        err
      );
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (callerSignal) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }
}

/**
 * 通用健康检查探针实现
 */
export async function checkHealthCommon(
  adapter: SearchProviderAdapter,
  apiKey: string,
  options?: SearchOptions
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await adapter.search('test', apiKey, {
      ...options,
      maxResults: 1,
      timeoutMs: options?.timeoutMs ?? 5000,
    });
    return {
      ok: true,
      latencyMs: Math.max(1, Date.now() - start),
    };
  } catch (err: any) {
    return {
      ok: false,
      latencyMs: Math.max(1, Date.now() - start),
      error: err?.message || String(err),
    };
  }
}
