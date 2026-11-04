/**
 * apps/crish-mobile/src/adapters/tools/webFetchTool.ts
 *
 * 端侧网页正文提取工具（web_fetch）适配器
 * 严格对齐《04-分维-移动端本地Agent循环与通用端侧工具体系方案.md》§4.3 与《03-分维》§3/§4/§5
 *
 * 核心特性：
 * 1. 协同调用 downloadWebPage（位运算 SSRF 防护、防重定向环路、单并发插槽、流式体积截断）；
 * 2. 协同调用 extractPageContent（DOM 规范化、安全清洗、Readability、Turndown GFM 转换）；
 * 3. 严格受 4K Token (约 24,000 字符) 预算截断守门；
 * 4. 针对网络不可达、内网拦截、404 等错误注入防复读熔断指示。
 */

import { downloadWebPage } from '../webFetch/downloadWebPage';
import type { WebFetchOptions, WebFetchResponse } from '../webFetch/types';
import {
  extractPageContent,
  type ExtractionOptions,
  type ExtractedPage,
} from '../extraction/extractPageContent';
import type {
  MobileToolContext,
  MobileToolDefinition,
  ToolExecutionResult,
} from './types';

/** 单页 4K Token 守门硬顶 */
export const WEB_FETCH_MAX_TOKENS_CAP = 4000;
/** 单 Token 折算字符比例 (6 字符/Token) */
export const CHARS_PER_TOKEN = 6;
/** 4K Tokens 折算最大字符数：4000 * 6 = 24,000 字符 */
export const MAX_CHARACTERS_AT_4K = WEB_FETCH_MAX_TOKENS_CAP * CHARS_PER_TOKEN;

export interface WebFetchToolOptions {
  /** 自定义下载器注入（供测试使用） */
  downloader?: (options: WebFetchOptions) => Promise<WebFetchResponse>;
  /** 自定义正文提取器注入（供测试使用） */
  extractor?: (html: string, options: ExtractionOptions) => ExtractedPage;
}

/**
 * 创建端侧网页提取工具实例
 */
export function createWebFetchTool(
  options: WebFetchToolOptions = {}
): MobileToolDefinition {
  return {
    name: 'web_fetch',
    description:
      '提取指定 HTTP(S) URL 网页的正文内容并转换为纯净的 Markdown 文本。' +
      '具备端侧内网 SSRF 安全拦截与 4K Token 长度截断保护。' +
      '适用于深入阅读特定参考链接或搜索结果中的重点网页。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            '需要抓取正文的网页绝对 URL (必须以 http:// 或 https:// 开头)',
        },
        max_tokens: {
          type: 'number',
          description: '提取正文的最大 Token 预算上限（默认 4000，硬顶 4000）',
        },
      },
      required: ['url'],
    },
    approval: 'auto',
    concurrency: 'parallel',
    timeoutMs: 15000,

    async execute(
      args: Record<string, unknown>,
      context: MobileToolContext
    ): Promise<ToolExecutionResult> {
      const startTime = Date.now();
      const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';

      // 1. URL 格式前置校验
      if (
        !rawUrl ||
        (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://'))
      ) {
        return {
          toolCallId: '',
          toolName: 'web_fetch',
          ok: false,
          output: JSON.stringify({
            status: 'error',
            error:
              'Invalid URL. Must be an absolute URL starting with http:// or https://.',
            system_note:
              'Please provide a valid HTTP or HTTPS URL to fetch webpage content.',
          }),
          error: 'invalid_url',
          metadata: { elapsedMs: 0 },
        };
      }

      // 2. 4K Token 预算截断守门解析
      const requestedTokens =
        typeof args.max_tokens === 'number' && Number.isFinite(args.max_tokens)
          ? Math.floor(args.max_tokens)
          : WEB_FETCH_MAX_TOKENS_CAP;
      const activeMaxTokens = Math.max(
        100,
        Math.min(requestedTokens, WEB_FETCH_MAX_TOKENS_CAP)
      );

      // 3. 进度通知
      context.onProgress?.(`Fetching web page: ${rawUrl}`);

      try {
        // 4. 调用安全下载器
        const downloadFn = options.downloader ?? downloadWebPage;
        const fetchResponse = await downloadFn({
          url: rawUrl,
          signal: context.signal,
          timeoutMs: 12000,
        });

        // 校验 HTTP 状态码
        if (fetchResponse.status >= 400) {
          return {
            toolCallId: '',
            toolName: 'web_fetch',
            ok: false,
            output: JSON.stringify({
              status: 'error',
              error: `HTTP ${fetchResponse.status} received when fetching ${rawUrl}`,
              system_note: `The webpage returned HTTP error ${fetchResponse.status}. Do not retry this URL in this turn.`,
            }),
            error: `http_${fetchResponse.status}`,
            metadata: {
              status: fetchResponse.status,
              elapsedMs: Date.now() - startTime,
            },
          };
        }

        const isHtml =
          fetchResponse.contentType.includes('html') ||
          fetchResponse.contentType.includes('xhtml') ||
          fetchResponse.html.includes('<html') ||
          fetchResponse.html.includes('<!DOCTYPE');

        let title = '';
        let markdownBody = '';
        let excerpt = '';
        let wordCount = 0;
        let estimatedTokens = 0;
        let wasTruncated = fetchResponse.truncated;

        if (isHtml) {
          // 5. 调用正文提纯引擎
          const extractFn = options.extractor ?? extractPageContent;
          const extracted = extractFn(fetchResponse.html, {
            targetUrl: fetchResponse.finalUrl || rawUrl,
            maxTokens: activeMaxTokens,
            includeMarkdown: true,
          });

          title = extracted.title;
          excerpt = extracted.excerpt;
          markdownBody = extracted.markdown || extracted.text;
          wordCount = extracted.wordCount;
          estimatedTokens = extracted.estimatedTokens;
          wasTruncated = wasTruncated || extracted.truncated;
        } else {
          // 纯文本或 Markdown 直出，执行严格字符截断
          const maxAllowedChars = activeMaxTokens * CHARS_PER_TOKEN;
          markdownBody = fetchResponse.html;
          if (markdownBody.length > maxAllowedChars) {
            markdownBody = markdownBody.slice(0, maxAllowedChars);
            wasTruncated = true;
          }
          wordCount = markdownBody.split(/\s+/).filter(Boolean).length;
          estimatedTokens = Math.ceil(markdownBody.length / CHARS_PER_TOKEN);
        }

        // 6. 组装输出文本
        const lines: string[] = [];
        if (title) lines.push(`# ${title}`);
        lines.push(`URL: ${fetchResponse.finalUrl || rawUrl}`);
        if (excerpt) lines.push(`> 摘要: ${excerpt}`);
        lines.push('');
        lines.push(markdownBody.trim());
        if (wasTruncated) {
          lines.push('\n\n[Content truncated at 4K token budget]');
        }

        const output = lines.join('\n');

        return {
          toolCallId: '',
          toolName: 'web_fetch',
          ok: true,
          output,
          metadata: {
            url: fetchResponse.finalUrl || rawUrl,
            title,
            wordCount,
            estimatedTokens,
            truncated: wasTruncated,
            bytesDownloaded: fetchResponse.bytes,
            status: fetchResponse.status,
            elapsedMs: Date.now() - startTime,
          },
        };
      } catch (err: unknown) {
        const errorMsg =
          err instanceof Error
            ? err.message
            : String(err || 'Web fetch failed');
        const errorCode =
          typeof (err as { code?: unknown })?.code === 'string'
            ? (err as { code: string }).code
            : 'web_fetch_error';

        return {
          toolCallId: '',
          toolName: 'web_fetch',
          ok: false,
          output: JSON.stringify({
            status: 'error',
            error: errorMsg,
            url: rawUrl,
            system_note:
              `Failed to fetch URL: ${errorMsg}. ` +
              'Do not attempt to re-fetch this URL in this session. ' +
              'Explain the issue to the user or search for alternative sources.',
          }),
          error: errorCode,
          metadata: {
            url: rawUrl,
            elapsedMs: Date.now() - startTime,
          },
        };
      }
    },
  };
}

/** 默认端侧网页正文提取工具单例定义 */
export const webFetchTool: MobileToolDefinition = createWebFetchTool();
