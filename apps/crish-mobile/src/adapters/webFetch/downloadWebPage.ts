/**
 * apps/crish-mobile/src/adapters/webFetch/downloadWebPage.ts
 *
 * 安全网页下载器（Safe Web Page Downloader）
 * 遵循方案文档《03-分维-QuickJS沙箱集成与端侧网页正文提纯方案》§3 & §5
 *
 * 核心安全特性：
 * 1. 位运算 SSRF 刚性门禁：全谱系 IP 分类、保留段拦截、协议白名单、凭证过滤门禁；
 * 2. 流式 300KB 硬尺寸截断：ReadableStream 分块累积，到达 300KB 立即主动 cancel() 关闭连接；
 * 3. 网络防线：默认伪装移动端高信誉 UA（Android Chrome Mobile）、10s 硬超时；
 * 4. 防 302 重定向死循环：上限 5 跳，且每一跳的目标 URL 必须全量重新过 SSRF 校验；
 * 5. 全局单并发插槽保护：AsyncSemaphore(1) 互斥排队，避免多并发引发端侧 OOM。
 */

import {
  validateSafeWebUrl,
  isIpv4Reserved,
  isIpv6Reserved,
  isLoopbackIp,
  isLocalHostname,
  isBlockedHostSuffix,
} from '@crish/shared-utils';
export { isLocalHostname, isBlockedHostSuffix };
import { globalWebFetchSemaphore, AsyncSemaphore } from './asyncSemaphore';
import {
  WebFetchError,
  type WebFetchOptions,
  type WebFetchResponse,
} from './types';

/**
 * 默认高信誉移动端 User-Agent（Android Chrome Mobile）
 */
export const DEFAULT_MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.113 Mobile Safari/537.36';

/**
 * 默认硬超时时间：10,000ms (10 秒)
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 默认单页最大下载字节限制：300KB (307,200 字节)
 */
export const DEFAULT_MAX_BYTES = 300 * 1024;

/**
 * 默认最大重定向跳数
 */
export const DEFAULT_MAX_REDIRECTS = 5;

/**
 * 默认允许的 Content-Type 白名单
 */
export const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
];

/**
 * 判定给定 IP 字符串是否属于内网、保留段或回环地址（纯位运算与格式解析）
 */
export function isPrivateOrRestrictedIp(ip: string): boolean {
  const clean = ip.trim().replace(/^\[|\]$/g, '');
  return isLoopbackIp(clean) || isIpv4Reserved(clean) || isIpv6Reserved(clean);
}

/**
 * 断言 URL 是否通过 SSRF 刚性门禁校验，非法或私有内网地址直接抛出 WebFetchError('SSRF_BLOCKED', ...)
 */
export function assertSafeUrl(rawUrl: string): string {
  const check = validateSafeWebUrl(rawUrl, { allowLoopback: false });
  if (!check.isSafe) {
    throw new WebFetchError(
      'SSRF_BLOCKED',
      `SSRF blocked: ${check.reason || 'Unsafe URL target'}`,
      rawUrl
    );
  }
  return check.normalizedUrl || rawUrl;
}

/**
 * 嗅探并提取 HTML 文本编码（优先 Header charset，其次前 4096 字节 meta 标签）
 */
function resolveCharset(buffer: Uint8Array, contentType: string): string {
  // 1. 尝试从 Content-Type Header 中提取 charset
  const headerMatch = contentType.match(/charset\s*=\s*['"]?([a-zA-Z0-9_-]+)/i);
  if (headerMatch && headerMatch[1]) {
    return headerMatch[1].toLowerCase();
  }

  // 2. 嗅探前 4096 字节中的 <meta charset="..."> 声明
  const probeLen = Math.min(buffer.length, 4096);
  if (probeLen > 0) {
    try {
      const probeStr = new TextDecoder('ascii', { fatal: false }).decode(
        buffer.subarray(0, probeLen)
      );
      const metaMatch =
        probeStr.match(/<meta[^>]+charset=['"]?([a-zA-Z0-9_-]+)/i) ||
        probeStr.match(/<meta[^>]+content=['"][^'"]*charset=([a-zA-Z0-9_-]+)/i);
      if (metaMatch && metaMatch[1]) {
        return metaMatch[1].toLowerCase();
      }
    } catch {
      // 嗅探失败回退 utf-8
    }
  }

  return 'utf-8';
}

/**
 * 解码 HTML 二进制字节流为文本字符串
 */
function decodeBufferToHtml(buffer: Uint8Array, contentType: string): string {
  if (buffer.length === 0) return '';
  const charset = resolveCharset(buffer, contentType);

  try {
    const decoder = new TextDecoder(charset);
    return decoder.decode(buffer);
  } catch {
    // 若特定 charset 不支持，回退 UTF-8 宽松解码
    const fallbackDecoder = new TextDecoder('utf-8', { fatal: false });
    return fallbackDecoder.decode(buffer);
  }
}

/**
 * 校验 Content-Type 是否属于被允许的文本/HTML 类型
 */
function validateContentType(
  contentType: string,
  allowedTypes: readonly string[]
): void {
  const ct = contentType.toLowerCase().trim();
  if (!ct) {
    // 很多简单服务器缺省 header，放行让后续流解析
    return;
  }

  // 严格拦截常见二进制格式，防止多媒体大文件读取
  const isBinaryType =
    ct.startsWith('image/') ||
    ct.startsWith('video/') ||
    ct.startsWith('audio/') ||
    ct === 'application/pdf' ||
    ct === 'application/zip' ||
    ct === 'application/gzip' ||
    ct === 'application/octet-stream' ||
    ct.includes('application/x-zip') ||
    ct.includes('application/x-tar');

  if (isBinaryType) {
    throw new WebFetchError(
      'NETWORK_ERROR',
      `Unsupported binary Content-Type: ${contentType}`
    );
  }

  // 匹配允许类型
  const mime = ct.split(';')[0]?.trim() || '';
  const isAllowed =
    allowedTypes.some((allowed) => mime === allowed) ||
    mime.startsWith('text/') ||
    mime.endsWith('+xml') ||
    mime === 'application/json';

  if (!isAllowed) {
    throw new WebFetchError(
      'NETWORK_ERROR',
      `Content-Type "${contentType}" is not in the allowed text/html MIME list`
    );
  }
}

/**
 * 执行底层单次 HTTP 请求并进行流式截断与解码
 */
async function executeStreamFetch(
  targetUrl: string,
  options: WebFetchOptions,
  controller: AbortController,
  fetchFn: typeof fetch
): Promise<{
  response: Response;
  chunks: Uint8Array[];
  totalBytes: number;
  truncated: boolean;
}> {
  const userAgent = options.userAgent ?? DEFAULT_MOBILE_UA;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const res = await fetchFn(targetUrl, {
    method: 'GET',
    headers: {
      'User-Agent': userAgent,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'Cache-Control': 'no-cache',
    },
    redirect: 'manual',
    signal: controller.signal,
  });

  // 如果是 30x 重定向，直接返回由外层状态机跟随
  if (res.status >= 300 && res.status < 400) {
    return {
      response: res,
      chunks: [],
      totalBytes: 0,
      truncated: false,
    };
  }

  if (!res.ok && res.status >= 400) {
    throw new WebFetchError(
      'NETWORK_ERROR',
      `HTTP request failed with status ${res.status} ${res.statusText}`,
      targetUrl,
      undefined,
      res.status
    );
  }

  const contentType = res.headers.get('content-type') || '';
  validateContentType(
    contentType,
    options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES
  );

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  // 1. 若支持 ReadableStream getReader()，执行真正的边读边累积流式截断
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || !value) {
          break;
        }

        const chunkLen = value.byteLength;
        if (totalBytes + chunkLen >= maxBytes) {
          const needed = maxBytes - totalBytes;
          if (needed > 0) {
            chunks.push(value.subarray(0, needed));
            totalBytes += needed;
          }
          truncated = true;
          try {
            await reader.cancel('Max download bytes reached');
          } catch {
            // 忽略流取消异常
          }
          break;
        } else {
          chunks.push(value);
          totalBytes += chunkLen;
        }
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        // 忽略 releaseLock 异常
      }
    }
  } else {
    // 2. 回退机制（适配非流式 Mock 或缺失 reader 的环境）
    const arrayBuf = await res.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuf);
    if (uint8.byteLength > maxBytes) {
      chunks.push(uint8.subarray(0, maxBytes));
      totalBytes = maxBytes;
      truncated = true;
    } else {
      chunks.push(uint8);
      totalBytes = uint8.byteLength;
    }
  }

  if (truncated && options.throwOnTruncate) {
    throw new WebFetchError(
      'PAYLOAD_TOO_LARGE',
      `Downloaded payload exceeded max size limit of ${maxBytes} bytes`,
      targetUrl
    );
  }

  return {
    response: res,
    chunks,
    totalBytes,
    truncated,
  };
}

/**
 * 安全下载网页 HTML 内容
 *
 * @param urlOrOptions 网页 URL 或详细下载参数
 * @returns 包含解码 HTML 与元数据的 WebFetchResponse
 */
export async function downloadWebPage(
  urlOrOptions: string | WebFetchOptions
): Promise<WebFetchResponse> {
  const options: WebFetchOptions =
    typeof urlOrOptions === 'string' ? { url: urlOrOptions } : urlOrOptions;

  const initialUrl = options.url?.trim();
  if (!initialUrl) {
    throw new WebFetchError('SSRF_BLOCKED', 'URL cannot be empty');
  }

  // 并发插槽：默认使用全局单并发插槽 globalWebFetchSemaphore，保护移动端不发生并发 OOM
  const semaphore: AsyncSemaphore | null =
    options.semaphore === null
      ? null
      : (options.semaphore ?? globalWebFetchSemaphore);

  const releaseSlot = semaphore
    ? await semaphore.acquire({
        timeoutMs: options.slotTimeoutMs,
        signal: options.signal,
      })
    : undefined;

  try {
    return await executeDownloadPipeline(initialUrl, options);
  } finally {
    releaseSlot?.();
  }
}

/**
 * 包含 SSRF 门禁与手动重定向追踪的下载管线
 */
async function executeDownloadPipeline(
  initialUrl: string,
  options: WebFetchOptions
): Promise<WebFetchResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const fetchFn = options.fetchFn ?? fetch;

  // 第一道刚性门禁：校验初始 URL
  let currentUrl = assertSafeUrl(initialUrl);

  const visitedUrls = new Set<string>();
  visitedUrls.add(currentUrl);

  // 滑动窗口超时与外部信号绑定
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  const onExternalAbort = () => {
    clearTimeout(timer);
    controller.abort(options.signal?.reason);
  };

  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      const abortReason = options.signal.reason;
      throw abortReason instanceof Error ? abortReason : new Error('Aborted');
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let redirectCount = 0;

  try {
    while (true) {
      let fetchResult: {
        response: Response;
        chunks: Uint8Array[];
        totalBytes: number;
        truncated: boolean;
      };

      try {
        fetchResult = await executeStreamFetch(
          currentUrl,
          options,
          controller,
          fetchFn
        );
      } catch (err) {
        if (timedOut) {
          throw new WebFetchError(
            'TIMEOUT',
            `Web fetch request timed out after ${timeoutMs}ms`,
            currentUrl
          );
        }
        if (options.signal?.aborted) {
          const reason = options.signal.reason;
          throw reason instanceof Error ? reason : new Error('Aborted');
        }
        if (err instanceof WebFetchError) {
          throw err;
        }
        throw new WebFetchError(
          'NETWORK_ERROR',
          `Network fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          currentUrl,
          err
        );
      }

      const { response: res, chunks, totalBytes, truncated } = fetchResult;

      // 处理 301, 302, 303, 307, 308 重定向
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          throw new WebFetchError(
            'NETWORK_ERROR',
            `HTTP ${res.status} redirect missing Location header`,
            currentUrl,
            undefined,
            res.status
          );
        }

        redirectCount += 1;
        if (redirectCount > maxRedirects) {
          throw new WebFetchError(
            'TOO_MANY_REDIRECTS',
            `Exceeded maximum redirect limit of ${maxRedirects} hops`,
            currentUrl
          );
        }

        // 解析重定向相对路径或绝对路径
        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).href;
        } catch (_err) {
          throw new WebFetchError(
            'SSRF_BLOCKED',
            `Invalid redirect target URL: ${location}`,
            currentUrl
          );
        }

        // 核心安全规则：重定向目标必须全量过 SSRF 校验
        const safeNextUrl = assertSafeUrl(nextUrl);

        // 重定向死循环检测
        if (visitedUrls.has(safeNextUrl)) {
          throw new WebFetchError(
            'TOO_MANY_REDIRECTS',
            `Redirect loop detected to: ${safeNextUrl}`,
            safeNextUrl
          );
        }

        visitedUrls.add(safeNextUrl);
        currentUrl = safeNextUrl;
        continue;
      }

      // 组装最终 buffer 并解码 HTML
      const finalBuffer = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        finalBuffer.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const contentType = res.headers.get('content-type') || '';
      const html = decodeBufferToHtml(finalBuffer, contentType);

      return {
        url: initialUrl,
        finalUrl: currentUrl,
        html,
        status: res.status,
        contentType,
        bytes: totalBytes,
        truncated,
      };
    }
  } finally {
    clearTimeout(timer);
    if (options.signal) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}
