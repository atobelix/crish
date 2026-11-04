/**
 * apps/crish-mobile/src/adapters/webFetch/downloadWebPage.test.ts
 *
 * 安全网页下载器（downloadWebPage）与单并发插槽（AsyncSemaphore）立体化单元测试
 * 覆盖：
 * 1. SSRF 本地环回与私有 IP 阻断（localhost, 127.0.0.1, 192.168.1.1, 169.254.169.254 等）
 * 2. 正常 HTML 下载与规范编码解析（UTF-8, Chinese, Emoji, Content-Type, Mobile UA）
 * 3. 超过 300KB 流式硬截断（ReadableStream cancel、arrayBuffer 回退、throwOnTruncate）
 * 4. 302 重定向跟随、SSRF 穿透拦截与环路检测
 * 5. AsyncSemaphore(1) 单并发互斥、FIFO 排队与超时释放
 */

import {
  downloadWebPage,
  assertSafeUrl,
  isPrivateOrRestrictedIp,
  DEFAULT_MAX_BYTES,
  DEFAULT_MOBILE_UA,
} from './downloadWebPage';
import { AsyncSemaphore, globalWebFetchSemaphore } from './asyncSemaphore';
import { WebFetchError } from './types';
import * as webFetchModule from './index';

/**
 * 辅助构造 Mock 流式 Response
 */
function createMockStreamResponse(options: {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  chunks: Uint8Array[];
  onCancel?: (reason: string) => void;
}): Response {
  const {
    status = 200,
    statusText = 'OK',
    headers = {},
    chunks,
    onCancel,
  } = options;

  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]!);
        index += 1;
      } else {
        controller.close();
      }
    },
    cancel(reason) {
      onCancel?.(String(reason));
    },
  });

  const headerObj = new Headers({
    'content-type': 'text/html; charset=utf-8',
    ...headers,
  });

  return new Response(stream, {
    status,
    statusText,
    headers: headerObj,
  });
}

/**
 * 辅助构造纯文本 Response
 */
function createMockTextResponse(
  body: string,
  options: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
  } = {}
): Response {
  const { status = 200, statusText = 'OK', headers = {} } = options;
  return new Response(body, {
    status,
    statusText,
    headers: new Headers({
      'content-type': 'text/html; charset=utf-8',
      ...headers,
    }),
  });
}

describe('downloadWebPage 安全网页下载器', () => {
  // ── 1. SSRF 拦截测试 ──
  describe('SSRF 刚性拦截门禁', () => {
    const BLOCKED_URLS = [
      // 回环地址
      'http://localhost',
      'http://localhost:8080/admin',
      'http://localhost.localdomain/api',
      'http://127.0.0.1',
      'http://127.0.0.1:3000/metrics',
      'http://127.0.0.2',
      'http://127.255.255.254',
      // 私有 IPv4 网段
      'http://10.0.0.1/status',
      'http://10.255.255.255',
      'http://172.16.0.1',
      'http://172.20.10.1',
      'http://172.31.255.255',
      'http://192.168.0.1/login',
      'http://192.168.1.1',
      'http://192.168.254.254',
      // 云厂商元数据与链路本地地址
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.1.1',
      // 运营商级 NAT (CGNAT)
      'http://100.64.0.1',
      'http://100.100.100.100',
      'http://100.127.255.255',
      // IPv6 回环与私有段
      'http://[::1]',
      'http://[::1]:8080/test',
      'http://[fe80::1]/',
      'http://[fe80::200:5aee:feaa:20a2]',
      'http://[fc00::1]/',
      'http://[fd00::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:192.168.1.1]/',
      // 变形 IP
      'http://0x7f000001/',
      'http://2130706433/',
      'http://017700000001/',
      // 非法/危险协议
      'ftp://example.com/file.txt',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>bad</h1>',
      // 凭据内联
      'http://admin:secret@public-domain.com/',
      // 内部域名后缀
      'http://internal-host.local/',
      'http://api.internal/',
      'http://gateway.lan/',
      'http://router.localdomain/',
    ];

    it.each(BLOCKED_URLS)('应当刚性阻断非法与私有目标：%s', async (url) => {
      await expect(downloadWebPage(url)).rejects.toThrow(WebFetchError);
      await expect(downloadWebPage(url)).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
      });
    });

    it('assertSafeUrl 遇到非法或私有 URL 应当抛出 SSRF_BLOCKED', () => {
      expect(() => assertSafeUrl('http://127.0.0.1')).toThrow(WebFetchError);
      expect(() => assertSafeUrl('http://192.168.1.1')).toThrow(WebFetchError);
      expect(() => assertSafeUrl('http://169.254.169.254')).toThrow(
        WebFetchError
      );
      expect(() => assertSafeUrl('ftp://example.com')).toThrow(WebFetchError);
    });

    it('assertSafeUrl 遇到合法公网 URL 应当正常返回规范化地址', () => {
      const normalized = assertSafeUrl('https://example.com/test');
      expect(normalized).toBe('https://example.com/test');
    });

    it('isPrivateOrRestrictedIp 应当正确识别各类型受限 IP', () => {
      expect(isPrivateOrRestrictedIp('127.0.0.1')).toBe(true);
      expect(isPrivateOrRestrictedIp('10.0.0.1')).toBe(true);
      expect(isPrivateOrRestrictedIp('172.16.0.1')).toBe(true);
      expect(isPrivateOrRestrictedIp('192.168.1.100')).toBe(true);
      expect(isPrivateOrRestrictedIp('169.254.169.254')).toBe(true);
      expect(isPrivateOrRestrictedIp('100.64.0.1')).toBe(true);
      expect(isPrivateOrRestrictedIp('::1')).toBe(true);
      expect(isPrivateOrRestrictedIp('fe80::1')).toBe(true);
      expect(isPrivateOrRestrictedIp('fc00::1')).toBe(true);
      // 公网 IP 放行
      expect(isPrivateOrRestrictedIp('8.8.8.8')).toBe(false);
      expect(isPrivateOrRestrictedIp('1.1.1.1')).toBe(false);
      expect(isPrivateOrRestrictedIp('140.82.121.3')).toBe(false);
    });

    it('URL 为空字符串时应当抛出 SSRF_BLOCKED', async () => {
      await expect(downloadWebPage('')).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
      });
      await expect(downloadWebPage('   ')).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
      });
    });
  });

  // ── 2. 正常 HTML 下载与规范编码解析 ──
  describe('正常 HTML 下载与规范编码解析', () => {
    it('应当成功下载公网网页并返回完整元数据与默认移动端 UA', async () => {
      const mockHtml =
        '<!DOCTYPE html><html><head><title>Test Page</title></head><body><h1>你好世界 🚀</h1><p>这是一段中文段落</p></body></html>';
      let capturedRequest: any = null;

      const mockFetch: typeof fetch = jest.fn(async (input, init) => {
        const headers = init?.headers as Record<string, string>;
        capturedRequest = {
          url: String(input),
          headers,
        };
        return createMockTextResponse(mockHtml, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
          },
        });
      });

      const response = await downloadWebPage({
        url: 'https://example.com/news/article-1',
        fetchFn: mockFetch,
        semaphore: null, // 单测独立测试网络
      });

      expect(response.status).toBe(200);
      expect(response.url).toBe('https://example.com/news/article-1');
      expect(response.finalUrl).toBe('https://example.com/news/article-1');
      expect(response.html).toBe(mockHtml);
      expect(response.truncated).toBe(false);
      expect(response.bytes).toBe(
        new TextEncoder().encode(mockHtml).byteLength
      );
      expect(response.contentType).toBe('text/html; charset=utf-8');

      // 验证 User-Agent 伪装为 Android Chrome Mobile
      expect(capturedRequest?.headers?.['User-Agent']).toBe(DEFAULT_MOBILE_UA);
    });

    it('支持自定义 User-Agent', async () => {
      let passedUa = '';
      const mockFetch: typeof fetch = jest.fn(async (_, init) => {
        const headers = init?.headers as any;
        passedUa = String(headers?.['User-Agent'] ?? '');
        return createMockTextResponse('<html><body>OK</body></html>');
      });

      await downloadWebPage({
        url: 'https://example.com/ua-test',
        userAgent: 'Custom-Mobile-Bot/1.0',
        fetchFn: mockFetch,
        semaphore: null,
      });

      expect(passedUa).toBe('Custom-Mobile-Bot/1.0');
    });

    it('应当能嗅探 HTML meta 标签中的 charset 进行解码', async () => {
      const htmlWithMeta =
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>Meta Charset OK</p></body></html>';
      const encoded = new TextEncoder().encode(htmlWithMeta);

      const mockFetch: typeof fetch = jest.fn(async () => {
        return new Response(encoded, {
          status: 200,
          headers: new Headers({
            // Content-Type 未声明 charset
            'content-type': 'text/html',
          }),
        });
      });

      const res = await downloadWebPage({
        url: 'https://example.com/meta-charset',
        fetchFn: mockFetch,
        semaphore: null,
      });

      expect(res.html).toContain('Meta Charset OK');
    });

    it('非文本/二进制 Content-Type 应当立即被拦截抛出 NETWORK_ERROR', async () => {
      const mockFetch: typeof fetch = jest.fn(async () => {
        return new Response(new Uint8Array(100), {
          status: 200,
          headers: new Headers({
            'content-type': 'application/pdf',
          }),
        });
      });

      await expect(
        downloadWebPage({
          url: 'https://example.com/doc.pdf',
          fetchFn: mockFetch,
          semaphore: null,
        })
      ).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        message: expect.stringContaining('Unsupported binary Content-Type'),
      });
    });

    it('图片类型 Content-Type 应当被拦截', async () => {
      const mockFetch: typeof fetch = jest.fn(async () => {
        return new Response(new Uint8Array(50), {
          status: 200,
          headers: new Headers({
            'content-type': 'image/png',
          }),
        });
      });

      await expect(
        downloadWebPage({
          url: 'https://example.com/banner.png',
          fetchFn: mockFetch,
          semaphore: null,
        })
      ).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
      });
    });

    it('未知自定义非文本 Content-Type 应当被拦截', async () => {
      const mockFetch: typeof fetch = jest.fn(async () => {
        return new Response(new Uint8Array(50), {
          status: 200,
          headers: new Headers({
            'content-type': 'application/x-custom-binary-blob',
          }),
        });
      });

      await expect(
        downloadWebPage({
          url: 'https://example.com/data.bin',
          fetchFn: mockFetch,
          semaphore: null,
        })
      ).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        message: expect.stringContaining(
          'is not in the allowed text/html MIME list'
        ),
      });
    });

    it('遇未知编码名称时应当优雅回退 UTF-8 解码', async () => {
      const testContent = '<h1>Fallback Decode OK</h1>';
      const encoded = new TextEncoder().encode(testContent);

      const mockFetch: typeof fetch = jest.fn(async () => {
        return new Response(encoded, {
          status: 200,
          headers: new Headers({
            'content-type': 'text/html; charset=non-existent-encoding-xyz',
          }),
        });
      });

      const res = await downloadWebPage({
        url: 'https://example.com/fallback-encoding',
        fetchFn: mockFetch,
        semaphore: null,
      });

      expect(res.html).toContain('Fallback Decode OK');
    });

    it('空响应体应返回空字符串 HTML', async () => {
      const mockFetch: typeof fetch = jest.fn(async () => {
        return new Response('', {
          status: 200,
          headers: new Headers({
            'content-type': 'text/html; charset=utf-8',
          }),
        });
      });

      const res = await downloadWebPage({
        url: 'https://example.com/empty',
        fetchFn: mockFetch,
        semaphore: null,
      });

      expect(res.html).toBe('');
      expect(res.bytes).toBe(0);
    });
  });

  // ── 3. 流式 300KB 硬尺寸截断 ──
  describe('流式 300KB 硬尺寸截断', () => {
    it('当数据流超过 300KB 时，应在达到 300KB 时立即主动 cancel() 流并返回截断结果', async () => {
      let streamCancelled = false;
      let cancelReason = '';

      // 生成 6 个 64KB 的数据块（总共 384KB > 300KB）
      const chunkSize = 64 * 1024;
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < 6; i++) {
        const chunk = new Uint8Array(chunkSize);
        chunk.fill(65 + i); // 填充 'A', 'B', 'C', ...
        chunks.push(chunk);
      }

      const mockFetch: typeof fetch = jest.fn(async () => {
        return createMockStreamResponse({
          chunks,
          onCancel: (reason) => {
            streamCancelled = true;
            cancelReason = reason;
          },
        });
      });

      const res = await downloadWebPage({
        url: 'https://example.com/large-article',
        fetchFn: mockFetch,
        semaphore: null,
      });

      expect(res.truncated).toBe(true);
      expect(res.bytes).toBe(DEFAULT_MAX_BYTES); // 精确等于 300 * 1024 字节
      expect(cancelReason).toBeDefined();
      expect(streamCancelled).toBe(true);
      expect(new TextEncoder().encode(res.html).byteLength).toBe(
        DEFAULT_MAX_BYTES
      );
      expect(cancelReason).toBeDefined();
    });

    it('当数据量恰好小于等于 300KB 时，不应发生截断', async () => {
      const data = new Uint8Array(200 * 1024); // 200KB
      data.fill(88); // 'X'

      const mockFetch: typeof fetch = jest.fn(async () => {
        return createMockStreamResponse({
          chunks: [data],
        });
      });

      const res = await downloadWebPage({
        url: 'https://example.com/medium-page',
        fetchFn: mockFetch,
        semaphore: null,
      });

      expect(res.truncated).toBe(false);
      expect(res.bytes).toBe(200 * 1024);
    });

    it('在非流式 arrayBuffer 回退模式下，超过 300KB 也能正确截断', async () => {
      // 模拟没有 getReader() 的环境
      const largeArray = new Uint8Array(400 * 1024);
      largeArray.fill(90);

      const mockFetch: typeof fetch = jest.fn(async () => {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'text/html' }),
          body: null, // 无流 reader
          arrayBuffer: async () => largeArray.buffer,
        } as unknown as Response;
      });

      const res = await downloadWebPage({
        url: 'https://example.com/fallback-large',
        fetchFn: mockFetch,
        semaphore: null,
      });

      expect(res.truncated).toBe(true);
      expect(res.bytes).toBe(DEFAULT_MAX_BYTES);
    });

    it('若配置 throwOnTruncate: true，超限时应当直接抛出 PAYLOAD_TOO_LARGE', async () => {
      const largeData = new Uint8Array(350 * 1024);
      const mockFetch: typeof fetch = jest.fn(async () => {
        return createMockStreamResponse({
          chunks: [largeData],
        });
      });

      await expect(
        downloadWebPage({
          url: 'https://example.com/too-large',
          throwOnTruncate: true,
          fetchFn: mockFetch,
          semaphore: null,
        })
      ).rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
      });
    });
  });

  // ── 4. 302 重定向与死循环检测 ──
  describe('302 重定向与安全防护', () => {
    it('正常单次重定向应当正确跟随并更新 finalUrl', async () => {
      const mockFetch: typeof fetch = jest.fn(async (input) => {
        const urlStr = String(input);
        if (urlStr === 'https://example.com/short-link') {
          return new Response(null, {
            status: 302,
            headers: new Headers({
              location: 'https://example.com/destination',
            }),
          });
        }
        if (urlStr === 'https://example.com/destination') {
          return createMockTextResponse(
            '<html><body>Final Landing</body></html>'
          );
        }
        throw new Error('Unexpected URL');
      });

      const res = await downloadWebPage({
        url: 'https://example.com/short-link',
        fetchFn: mockFetch,
        semaphore: null,
      });

      expect(res.url).toBe('https://example.com/short-link');
      expect(res.finalUrl).toBe('https://example.com/destination');
      expect(res.status).toBe(200);
      expect(res.html).toContain('Final Landing');
    });

    it('支持相对路径重定向 Location 解析', async () => {
      const mockFetch: typeof fetch = jest.fn(async (input) => {
        const urlStr = String(input);
        if (urlStr === 'https://example.com/blog/intro') {
          return new Response(null, {
            status: 301,
            headers: new Headers({
              location: '/blog/full-article',
            }),
          });
        }
        if (urlStr === 'https://example.com/blog/full-article') {
          return createMockTextResponse(
            '<html><body>Relative OK</body></html>'
          );
        }
        throw new Error('Unexpected URL');
      });

      const res = await downloadWebPage({
        url: 'https://example.com/blog/intro',
        fetchFn: mockFetch,
        semaphore: null,
      });

      expect(res.finalUrl).toBe('https://example.com/blog/full-article');
      expect(res.html).toContain('Relative OK');
    });

    it('重定向目标为私有内网 IP 时，应当在跟随前被 SSRF 刚性阻断', async () => {
      const mockFetch: typeof fetch = jest.fn(async (input) => {
        const urlStr = String(input);
        if (urlStr === 'https://example.com/open-redirect') {
          return new Response(null, {
            status: 302,
            headers: new Headers({
              // 恶意跳往内网路由器或元数据
              location: 'http://192.168.1.1/admin',
            }),
          });
        }
        return createMockTextResponse('Should never reach');
      });

      await expect(
        downloadWebPage({
          url: 'https://example.com/open-redirect',
          fetchFn: mockFetch,
          semaphore: null,
        })
      ).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
        message: expect.stringContaining('SSRF blocked'),
      });
    });

    it('重定向目标为云元数据 169.254.169.254 时应当被阻断', async () => {
      const mockFetch: typeof fetch = jest.fn(async () => {
        return new Response(null, {
          status: 302,
          headers: new Headers({
            location: 'http://169.254.169.254/latest/meta-data/',
          }),
        });
      });

      await expect(
        downloadWebPage({
          url: 'https://example.com/meta-leak',
          fetchFn: mockFetch,
          semaphore: null,
        })
      ).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
      });
    });

    it('重定向次数超过上限时应当抛出 TOO_MANY_REDIRECTS', async () => {
      let hop = 0;
      const mockFetch: typeof fetch = jest.fn(async () => {
        hop += 1;
        return new Response(null, {
          status: 302,
          headers: new Headers({
            location: `https://example.com/hop-${hop}`,
          }),
        });
      });

      await expect(
        downloadWebPage({
          url: 'https://example.com/hop-0',
          maxRedirects: 3,
          fetchFn: mockFetch,
          semaphore: null,
        })
      ).rejects.toMatchObject({
        code: 'TOO_MANY_REDIRECTS',
        message: expect.stringContaining('Exceeded maximum redirect limit'),
      });
    });

    it('检测到重定向环路（A -> B -> A）时应当抛出 TOO_MANY_REDIRECTS', async () => {
      const mockFetch: typeof fetch = jest.fn(async (input) => {
        const urlStr = String(input);
        if (urlStr === 'https://example.com/loop-a') {
          return new Response(null, {
            status: 302,
            headers: new Headers({
              location: 'https://example.com/loop-b',
            }),
          });
        }
        if (urlStr === 'https://example.com/loop-b') {
          return new Response(null, {
            status: 302,
            headers: new Headers({
              location: 'https://example.com/loop-a', // 形成环
            }),
          });
        }
        throw new Error('Unexpected');
      });

      await expect(
        downloadWebPage({
          url: 'https://example.com/loop-a',
          fetchFn: mockFetch,
          semaphore: null,
        })
      ).rejects.toMatchObject({
        code: 'TOO_MANY_REDIRECTS',
        message: expect.stringContaining('Redirect loop detected'),
      });
    });

    it('302 重定向缺失 Location 响应头时应当抛出 NETWORK_ERROR', async () => {
      const mockFetch: typeof fetch = jest.fn(async () => {
        return new Response(null, {
          status: 302,
          // 没有 Location 头
          headers: new Headers(),
        });
      });

      await expect(
        downloadWebPage({
          url: 'https://example.com/missing-location',
          fetchFn: mockFetch,
          semaphore: null,
        })
      ).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        message: expect.stringContaining('missing Location header'),
      });
    });

    it('302 重定向到非法格式的 URL 时应当抛出 SSRF_BLOCKED', async () => {
      const mockFetch: typeof fetch = jest.fn(async () => {
        return new Response(null, {
          status: 302,
          headers: new Headers({
            location: 'http://[::invalid-ipv6-bracket',
          }),
        });
      });

      await expect(
        downloadWebPage({
          url: 'https://example.com/bad-location-syntax',
          fetchFn: mockFetch,
          semaphore: null,
        })
      ).rejects.toMatchObject({
        code: 'SSRF_BLOCKED',
        message: expect.stringContaining('Invalid redirect target URL'),
      });
    });
  });

  // ── 5. 网络超时与 HTTP 错误状态 ──
  describe('网络超时与异常处理', () => {
    it('请求超时应当抛出 TIMEOUT 错误', async () => {
      const mockFetch: typeof fetch = jest.fn(async (_, init) => {
        const signal = init?.signal;
        return new Promise<Response>((_, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new Error('AbortError'));
          });
        });
      });

      await expect(
        downloadWebPage({
          url: 'https://example.com/slow',
          timeoutMs: 50,
          fetchFn: mockFetch,
          semaphore: null,
        })
      ).rejects.toMatchObject({
        code: 'TIMEOUT',
        message: expect.stringContaining('timed out after 50ms'),
      });
    });

    it('HTTP 404 / 500 应当抛出 NETWORK_ERROR', async () => {
      const mockFetch: typeof fetch = jest.fn(async () => {
        return new Response('Not Found', {
          status: 404,
          statusText: 'Not Found',
        });
      });

      await expect(
        downloadWebPage({
          url: 'https://example.com/missing',
          fetchFn: mockFetch,
          semaphore: null,
        })
      ).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        status: 404,
      });
    });

    it('外部 AbortSignal 已触发时应直接终止请求', async () => {
      const controller = new AbortController();
      controller.abort(new Error('User cancelled download'));

      await expect(
        downloadWebPage({
          url: 'https://example.com/any',
          signal: controller.signal,
          semaphore: null,
        })
      ).rejects.toThrow('User cancelled download');
    });

    it('底层网络连接断开时应当封装为 NETWORK_ERROR 抛出', async () => {
      const mockFetch: typeof fetch = jest.fn(async () => {
        throw new TypeError('Failed to fetch: Connection refused');
      });

      await expect(
        downloadWebPage({
          url: 'https://example.com/disconnect',
          fetchFn: mockFetch,
          semaphore: null,
        })
      ).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        message: expect.stringContaining('Network fetch failed'),
      });
    });
  });

  // ── 6. AsyncSemaphore 单并发插槽与互斥排队 ──
  describe('AsyncSemaphore 单并发插槽行为断言', () => {
    it('全局默认插槽 globalWebFetchSemaphore 必须是单并发实例 (maxConcurrency = 1)', () => {
      expect(globalWebFetchSemaphore.maxConcurrency).toBe(1);
    });

    it('三个并发任务必须严格排队串行执行，任何时刻 activeCount <= 1', async () => {
      const sem = new AsyncSemaphore(1);
      const executionTimeline: { id: number; start: number; end: number }[] =
        [];
      let maxObservedActive = 0;

      const runTask = async (id: number, delayMs: number) => {
        return sem.runExclusive(async () => {
          if (sem.activeCount > maxObservedActive) {
            maxObservedActive = sem.activeCount;
          }
          const start = Date.now();
          await new Promise((r) => setTimeout(r, delayMs));
          const end = Date.now();
          executionTimeline.push({ id, start, end });
        });
      };

      // 同时启动 3 个任务
      await Promise.all([runTask(1, 40), runTask(2, 40), runTask(3, 40)]);

      // 验证互斥：最大并发严格等于 1
      expect(maxObservedActive).toBe(1);
      expect(executionTimeline.length).toBe(3);

      // 验证任务严格串行不重叠：前一个任务的 end <= 后一个任务的 start
      for (let i = 1; i < executionTimeline.length; i++) {
        const prev = executionTimeline[i - 1]!;
        const curr = executionTimeline[i]!;
        expect(curr.start).toBeGreaterThanOrEqual(prev.end - 5); // 容忍 5ms 调度抖动
      }
    });

    it('插槽获取支持 timeoutMs 超时断言', async () => {
      const sem = new AsyncSemaphore(1);

      // 任务 1 长期霸占插槽 200ms
      const release1 = await sem.acquire();
      setTimeout(release1, 200);

      // 任务 2 尝试获取，设置 50ms 超时
      await expect(sem.acquire({ timeoutMs: 50 })).rejects.toMatchObject({
        code: 'TIMEOUT',
        message: expect.stringContaining(
          'AsyncSemaphore acquire timed out after 50ms'
        ),
      });

      // 队列中等待者应当被及时清理
      expect(sem.pendingCount).toBe(0);
    });

    it('支持 AbortSignal 取消队列中排队的任务', async () => {
      const sem = new AsyncSemaphore(1);
      const release1 = await sem.acquire();

      const controller = new AbortController();
      const waitingPromise = sem.acquire({ signal: controller.signal });

      expect(sem.pendingCount).toBe(1);
      controller.abort(new Error('Cancelled by user'));

      await expect(waitingPromise).rejects.toThrow('Cancelled by user');
      expect(sem.pendingCount).toBe(0);

      // 释放任务 1，信号量状态完全正常，后续任务可正常进入
      release1();
      expect(sem.activeCount).toBe(0);
      const release2 = await sem.acquire();
      expect(sem.activeCount).toBe(1);
      release2();
      expect(sem.activeCount).toBe(0);
    });

    it('downloadWebPage 默认接入插槽互斥下载', async () => {
      const testSem = new AsyncSemaphore(1);
      let concurrentCount = 0;
      let peakConcurrency = 0;

      const mockFetch: typeof fetch = jest.fn(async () => {
        concurrentCount += 1;
        if (concurrentCount > peakConcurrency) {
          peakConcurrency = concurrentCount;
        }
        await new Promise((r) => setTimeout(r, 30));
        concurrentCount -= 1;
        return createMockTextResponse('<html><body>OK</body></html>');
      });

      await Promise.all([
        downloadWebPage({
          url: 'https://example.com/p1',
          fetchFn: mockFetch,
          semaphore: testSem,
        }),
        downloadWebPage({
          url: 'https://example.com/p2',
          fetchFn: mockFetch,
          semaphore: testSem,
        }),
        downloadWebPage({
          url: 'https://example.com/p3',
          fetchFn: mockFetch,
          semaphore: testSem,
        }),
      ]);

      // 峰值并发度受信号量保护严格为 1
      expect(peakConcurrency).toBe(1);
    });
  });

  // ── 7. index.ts 模块统一导出验证 ──
  describe('index.ts 统一导出完整性', () => {
    it('应当导出所有核心函数、类与单例', () => {
      expect(typeof webFetchModule.downloadWebPage).toBe('function');
      expect(typeof webFetchModule.assertSafeUrl).toBe('function');
      expect(typeof webFetchModule.isPrivateOrRestrictedIp).toBe('function');
      expect(webFetchModule.AsyncSemaphore).toBe(AsyncSemaphore);
      expect(webFetchModule.globalWebFetchSemaphore).toBe(
        globalWebFetchSemaphore
      );
      expect(webFetchModule.WebFetchError).toBe(WebFetchError);
    });
  });
});
