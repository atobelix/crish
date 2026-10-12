import { useEffect, useRef, useState } from 'react';
import {
  getMarkdownHtmlCache,
  setMarkdownHtmlCache,
  getMarkdownAstCache,
  setMarkdownAstCache,
} from './markdownCache';
import { getWorkerPool, Priority } from '../workers';
import type { MarkdownAstResult } from '../workers/markdown-render-standalone';

export type { MarkdownAstResult };

const pendingAstRenders = new Map<string, Promise<MarkdownAstResult>>();

/**
 * 异步通过 Web Worker 将 Markdown 源文本解析为 Block AST / 预高亮 Token 树。
 *
 * 路径与收益：
 * 1. LRU 缓存命中 → 同步返回，0 Worker IPC 往返；
 * 2. 缓存未命中 → 调度到 WorkerPool('render', 'markdown.parse.ast') 离线解析；
 * 3. 耗时词法解析与语法高亮计算 100% 卸载出主线程，主线程耗时近乎为 0；
 * 4. 自动预热与同步写入 HTML LRU 缓存与 AST LRU 缓存。
 */
export async function parseMarkdownAstAsync(
  raw: string,
  priority: Priority = Priority.Normal
): Promise<MarkdownAstResult> {
  if (!raw || !raw.trim()) {
    return {
      raw: raw || '',
      blocks: [],
      fullHtml: '',
      hasCode: false,
      hasTable: false,
      codeBlocksCount: 0,
    };
  }

  // 1. LRU 命中：不再触发任何 Worker 任务
  const cached = getMarkdownAstCache(raw);
  if (cached !== undefined) return cached;

  // 2. 去重并发请求
  const pending = pendingAstRenders.get(raw);
  if (pending) return pending;

  const promise = (async () => {
    const ast = await getWorkerPool().schedule<MarkdownAstResult>(
      'render',
      'markdown.parse.ast',
      { raw },
      priority
    );
    if (ast) {
      setMarkdownAstCache(raw, ast);
      if (ast.fullHtml) {
        setMarkdownHtmlCache(raw, ast.fullHtml);
      }
    }
    return ast;
  })().finally(() => {
    pendingAstRenders.delete(raw);
  });

  pendingAstRenders.set(raw, promise);
  return promise;
}

/**
 * React Hook：异步通过 Web Worker 离线解析 Markdown 为 Block AST 与预高亮 Token 树。
 * 主线程只接收结果并绑定到虚拟 DOM，零正则与高亮计算阻塞。
 */
export function useWorkerMarkdownAst(
  markdown: string,
  enabled: boolean = true,
  priority: Priority = Priority.Normal
): {
  ast: MarkdownAstResult | null;
  html: string;
  loading: boolean;
  failed: boolean;
} {
  const [ast, setAst] = useState<MarkdownAstResult | null>(() => {
    if (!markdown || !enabled) return null;
    return getMarkdownAstCache(markdown) ?? null;
  });
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (!enabled || !markdown) {
      setAst(null);
      setLoading(false);
      setFailed(false);
      return () => {
        if (requestIdRef.current === requestId) requestIdRef.current += 1;
      };
    }

    const cached = getMarkdownAstCache(markdown);
    if (cached !== undefined) {
      setAst(cached);
      setLoading(false);
      setFailed(false);
      return () => {
        if (requestIdRef.current === requestId) requestIdRef.current += 1;
      };
    }

    setLoading(true);
    setFailed(false);

    parseMarkdownAstAsync(markdown, priority)
      .then((result) => {
        if (requestIdRef.current === requestId) {
          setAst(result);
          setLoading(false);
          setFailed(!result || (!result.fullHtml && markdown.trim() !== ''));
        }
      })
      .catch(() => {
        if (requestIdRef.current === requestId) {
          setLoading(false);
          setFailed(true);
        }
      });

    return () => {
      if (requestIdRef.current === requestId) requestIdRef.current += 1;
    };
  }, [markdown, enabled, priority]);

  const html =
    ast?.fullHtml ?? (markdown ? (getMarkdownHtmlCache(markdown) ?? '') : '');
  return { ast, html, loading, failed };
}
