/**
 * 单轨代码块语法高亮与封口快照缓存（_sealedHighlightCache）。
 *
 * 彻底废除旧版按行 split('\n') 逐行高亮与无界全局 LINE_CACHE：
 * 1. 流式未封口期（isSealed = false）：原生 TextNode 直通追加或纯文本转义，零正则高亮开销；
 * 2. 闭合封口期（isSealed = true）：单轨整块 AST 着色（保留多行注释与模板字符串跨行上下文），
 *    并写入有界纯内存快照缓存 `_sealedHighlightCache`，保障虚拟滚动分桶重挂载 0ms 秒开零闪烁。
 */

import { highlightCode } from './codeHighlight';

const MAX_SEALED_HIGHLIGHT_CACHE = 2000;

/**
 * 纯内存封口代码块高亮 HTML 快照缓存（防虚拟滚动分桶卸载回滚二次闪烁）。
 * Key 规范：`${sessionId}::${messageId}::${blockId}` 或 `${language}::${code}`
 */
export const _sealedHighlightCache = new Map<string, string>();

export function makeSealedHighlightCacheKey(
  sessionId: string,
  messageId: string,
  blockId: number | string
): string {
  return `${sessionId}::${messageId}::${blockId}`;
}

export function getSealedHighlightCache(cacheKey: string): string | undefined {
  const cached = _sealedHighlightCache.get(cacheKey);
  if (cached !== undefined) {
    // LRU 刷新访问序
    _sealedHighlightCache.delete(cacheKey);
    _sealedHighlightCache.set(cacheKey, cached);
  }
  return cached;
}

export function setSealedHighlightCache(cacheKey: string, html: string): void {
  if (!cacheKey) return;
  if (_sealedHighlightCache.has(cacheKey)) {
    _sealedHighlightCache.delete(cacheKey);
  } else if (_sealedHighlightCache.size >= MAX_SEALED_HIGHLIGHT_CACHE) {
    const oldestKey = _sealedHighlightCache.keys().next().value;
    if (oldestKey !== undefined) {
      _sealedHighlightCache.delete(oldestKey);
    }
  }
  _sealedHighlightCache.set(cacheKey, html);
}

/**
 * 会话销毁或切换时按 sessionId 批量驱逐封口高亮快照，防止跨会话内存积压。
 */
export function evictSealedHighlightCacheBySession(sessionId: string): number {
  if (!sessionId) return 0;
  const prefix = `${sessionId}::`;
  let evicted = 0;
  for (const key of Array.from(_sealedHighlightCache.keys())) {
    if (key.startsWith(prefix)) {
      _sealedHighlightCache.delete(key);
      evicted++;
    }
  }
  return evicted;
}

export function clearSealedHighlightCache(): void {
  _sealedHighlightCache.clear();
}

/**
 * 宿主挂接工具：由外层流式代码块调用，执行 O(1) 原生 DOM TextNode 追加，零 React VDOM 损耗。
 */
export function appendChunkToCodeBlock(
  _codeEl: HTMLElement,
  textNode: Text,
  deltaText: string,
  accumulatedRef: { current: string }
): void {
  if (!deltaText) return;
  accumulatedRef.current += deltaText;
  textNode.appendData(deltaText);
}

export interface StreamingHighlightOptions {
  isSealed?: boolean;
  cacheKey?: string;
}

/**
 * 单轨代码块高亮器：支持流式增量累积、整块多行上下文高亮与封口缓存命中。
 */
export class StreamingCodeHighlighter {
  private accumulatedCode = '';
  private readonly language: string;
  private readonly defaultCacheKey: string | undefined;

  constructor(language = '', cacheKey?: string) {
    this.language = language || '';
    this.defaultCacheKey = cacheKey;
  }

  public appendChunk(delta: string): string {
    if (delta) {
      this.accumulatedCode += delta;
    }
    return this.accumulatedCode;
  }

  public getAccumulatedCode(): string {
    return this.accumulatedCode;
  }

  /**
   * 推入代码并返回着色结果：
   * - 当 options?.isSealed === false 时返回纯转义文本（未封口直通态，零高亮开销）；
   * - 当封口或默认在 Worker 内调用时执行整块单轨语法高亮并写入 `_sealedHighlightCache`。
   */
  public push(code: string, options?: StreamingHighlightOptions): string {
    this.accumulatedCode = code;
    if (!code) return '';

    if (options?.isSealed === false) {
      return this.escapeHtml(code);
    }

    const key =
      options?.cacheKey ?? this.defaultCacheKey ?? `${this.language}::${code}`;
    const cached = getSealedHighlightCache(key);
    if (cached !== undefined) {
      return cached;
    }

    const highlighted = this.highlightBlock(code);
    setSealedHighlightCache(key, highlighted);
    return highlighted;
  }

  /**
   * 显式封口并生成/读取缓存的高亮 HTML 快照。
   */
  public seal(code?: string, cacheKey?: string): string {
    const targetCode = code !== undefined ? code : this.accumulatedCode;
    return this.push(targetCode, {
      isSealed: true,
      ...(cacheKey !== undefined
        ? { cacheKey }
        : this.defaultCacheKey !== undefined
          ? { cacheKey: this.defaultCacheKey }
          : {}),
    });
  }

  public reset(): void {
    this.accumulatedCode = '';
  }

  private highlightBlock(code: string): string {
    if (!code) return '';
    try {
      return highlightCode(code, this.language || undefined);
    } catch {
      return this.escapeHtml(code);
    }
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
