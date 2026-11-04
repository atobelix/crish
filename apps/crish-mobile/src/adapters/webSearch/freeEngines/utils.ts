/**
 * apps/crish-mobile/src/adapters/webSearch/freeEngines/utils.ts
 *
 * 免 Key 开放引擎通用文本清洗与网络请求辅助工具
 */

/**
 * 常见 HTML 实体映射表
 */
const HTML_ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&#34;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&amp;': '&',
  '&#38;': '&',
  '&lt;': '<',
  '&#60;': '<',
  '&gt;': '>',
  '&#62;': '>',
  '&nbsp;': ' ',
  '&#160;': ' ',
  '&middot;': '·',
  '&#183;': '·',
  '&bull;': '•',
  '&ndash;': '–',
  '&#8211;': '–',
  '&mdash;': '—',
  '&#8212;': '—',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&hellip;': '…',
  '&#8230;': '…',
};

/**
 * 清洗 HTML 片段：剥离 HTML 标签，反转义 HTML 实体，消除多余空白
 */
export function cleanHtmlText(raw: string): string {
  if (!raw) return '';

  // 1. 移除 script 与 style 块（若存在）
  let text = raw.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');

  // 2. 区分块级标签与行内修饰标签：
  // 块级标签（如 br, p, div, li, h1-6 等）替换为空格隔开词汇；
  // 行内标签（如 b, em, strong, i, span, mark 等高亮标签）直接抹去，避免中英文词内被切断或产生多余空格
  text = text.replace(
    /<\/?(?:br|p|div|tr|td|th|li|ul|ol|h[1-6]|blockquote|hr)\b[^>]*\/?>/gi,
    ' '
  );
  text = text.replace(/<[^>]+>/g, '');

  // 3. 反转义命名实体
  for (const [entity, replacement] of Object.entries(HTML_ENTITIES)) {
    text = text.replaceAll(entity, replacement);
  }

  // 4. 反转义十进制数字实体 &#123;
  text = text.replace(/&#(\d+);/g, (_, dec) => {
    try {
      const code = parseInt(dec, 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    } catch {
      return '';
    }
  });

  // 5. 反转义十六进制实体 &#x1f;
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    try {
      const code = parseInt(hex, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    } catch {
      return '';
    }
  });

  // 6. 规整空白与标点符号紧密排版
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/\s+([，。！？、；：）》」』])/g, '$1');
  text = text.replace(/([（《「『])\s+/g, '$1');

  return text.trim();
}

/**
 * 包装带超时的 fetch 请求与 AbortSignal
 */
export async function fetchWithTimeout(
  input: string | URL,
  init?: RequestInit & { timeoutMs?: number; fetchFn?: typeof fetch }
): Promise<Response> {
  const fetchFn = init?.fetchFn || fetch;
  const timeoutMs = init?.timeoutMs ?? 5000;
  const externalSignal = init?.signal;

  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  const onExternalAbort = () => {
    clearTimeout(timer);
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    const res = await fetchFn(input, {
      ...init,
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    if (timedOut) {
      throw new Error(
        `Request to ${String(input)} timed out after ${timeoutMs}ms`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}
