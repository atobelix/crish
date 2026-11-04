/**
 * apps/crish-mobile/src/adapters/webFetch/types.ts
 *
 * 安全网页下载器契约定义与异常分类
 * 遵循方案文档《03-分维-QuickJS沙箱集成与端侧网页正文提纯方案》§3 & §5
 */

import type { AsyncSemaphore } from './asyncSemaphore';

/**
 * 网页下载异常分类
 */
export type WebFetchErrorCode =
  | 'SSRF_BLOCKED'
  | 'PAYLOAD_TOO_LARGE'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'TOO_MANY_REDIRECTS';

/**
 * 网页下载专用异常类
 */
export class WebFetchError extends Error {
  readonly code: WebFetchErrorCode;
  readonly url?: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(
    code: WebFetchErrorCode,
    message: string,
    url?: string,
    details?: unknown,
    status?: number
  ) {
    super(message);
    this.name = 'WebFetchError';
    this.code = code;
    this.url = url;
    this.details = details;
    this.status = status;
    Object.setPrototypeOf(this, WebFetchError.prototype);
  }
}

/**
 * 网页下载配置选项
 */
export interface WebFetchOptions {
  /** 目标网页 URL */
  url: string;
  /** 单次请求超时时间（毫秒），默认 10,000ms (10s) */
  timeoutMs?: number;
  /** 外部中止信号 */
  signal?: AbortSignal;
  /** 最大接收字节数，默认 300 * 1024 (300KB) */
  maxBytes?: number;
  /** 若超出 maxBytes 是否直接抛出 PAYLOAD_TOO_LARGE（默认 false，截断并标记 truncated: true） */
  throwOnTruncate?: boolean;
  /** 用户代理伪装（User-Agent），默认 Android Chrome Mobile UA */
  userAgent?: string;
  /** 最大重定向跳数，默认 5 */
  maxRedirects?: number;
  /** 可选注入自定义 fetch 实现（便于单测与模拟） */
  fetchFn?: typeof fetch;
  /** 并发插槽获取超时时间（毫秒），可选 */
  slotTimeoutMs?: number;
  /** 自定义信号量插槽实例；传 null 则跳过插槽获取（当外层流水线已持有锁时） */
  semaphore?: AsyncSemaphore | null;
  /** 允许的 MIME 类型白名单，默认 text/html, application/xhtml+xml, text/plain, text/markdown */
  allowedContentTypes?: string[];
}

/**
 * 网页下载响应结构体
 */
export interface WebFetchResponse {
  /** 初始发起请求的 URL */
  url: string;
  /** 最终响应 URL（经历 30x 重定向后的终点 URL） */
  finalUrl: string;
  /** 解码后的 HTML 文本内容 */
  html: string;
  /** HTTP 状态码 */
  status: number;
  /** 响应的 Content-Type */
  contentType: string;
  /** 实际接收的字节数 */
  bytes: number;
  /** 是否因超过 maxBytes 被主动硬截断 */
  truncated: boolean;
}
