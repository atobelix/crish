import { useEffect, useRef, useState } from 'react';
import { getMarkdownHtmlCache, setMarkdownHtmlCache } from './markdownCache';
import { getWorkerPool, Priority } from '../workers';
import { renderMarkdown } from './rustCore';

const pendingRenders = new Map<string, Promise<string>>();

/**
 * 异步渲染 markdown → HTML。
 *
 * 渲染路径优先级：
 *   1. 内存 LRU 缓存命中 → 同步返回
 *   2. Rust `md_render` 命令（pulldown-cmark + syntect + ammonia）→ 异步 IPC
 *   3. Rust 命令缺失（missing）/失败 → 回退到 worker pool（highlight.js 路径）
 *
 * Rust 路径优势：
 *   - 主线程不阻塞（CPU 密集任务走 spawn_blocking）
 *   - ammonia sanitize 一次到位，组件层无需重复 DOMPurify
 *   - HTML byte-for-byte 兼容现有 CSS 选择器
 *
 * Worker fallback 必须保留：旧壳 / 浏览器测试 / Rust 后端未注册时仍可用。
 */
export async function parseMarkdownToHtmlAsync(
  raw: string,
  priority: Priority = Priority.High
): Promise<string> {
  if (!raw || !raw.trim()) return '';

  // 1. LRU 命中：不再调任何 IPC
  const cached = getMarkdownHtmlCache(raw);
  if (cached !== undefined) return cached;

  // 2. 去重并发请求
  const pending = pendingRenders.get(raw);
  if (pending) return pending;

  const promise = (async () => {
    // 2a. 优先 Rust 渲染
    const rustHtml = await renderMarkdown(raw);
    if (rustHtml != null) {
      setMarkdownHtmlCache(raw, rustHtml);
      return rustHtml;
    }
    // 2b. Rust missing/error → 回退 worker pool（highlight.js 完整路径）
    const workerHtml = await getWorkerPool().schedule<string>(
      'render',
      'markdown.render',
      { raw },
      priority
    );
    if (workerHtml) setMarkdownHtmlCache(raw, workerHtml);
    return workerHtml;
  })().finally(() => {
    pendingRenders.delete(raw);
  });

  pendingRenders.set(raw, promise);
  return promise;
}

// =============================================================================
// 已删除的死代码：
//   - highlightCodeAsync（本文件副本；唯一 SoT 为 codeHighlight.highlightCodeAsync）
//   - parseUnifiedDiffsAsync / messagesToJsonlAsync / jsonlToMessagesAsync
//     → api-adapters.ts（Rust-first + 主线程 JS fallback）
// =============================================================================

/**
 * 异步渲染 Markdown 为 HTML 的 React Hook。
 *
 * 行为：
 *   - 空串 / 仅空白 → 立即返回 `{ html: '', loading: false, failed: false }`
 *   - 命中内存缓存 → 同步返回缓存值，loading 保持 false
 *   - 否则触发 Rust / worker 异步渲染，loading=true；完成后写入 state
 *   - 组件卸载 / markdown 变化时通过 cancelledRef 取消上一次回调，避免 stale state
 *
 * T5-3：暴露 `failed` 失败标志——Rust `core_md_render` missing + worker
 * 回退也失败（.catch 前置 loading=false、html 仍 ''）或对非空原文渲染出
 * 空串时置 `failed=true`，供完成态组件做「纯文本次优回退」（不再空白）。
 *
 * 设计原则：
 *   - 缓存命中不进入 loading 状态，避免无意义闪烁
 *   - cancelledRef 而非 AbortController：底层 Rust/worker 不接受 AbortSignal，
 *     仅需要在 React 端丢弃过期结果，无需真正中断底层任务
 *   - 返回值结构稳定：`{ html, loading, failed }`，便于解构
 *
 * @param markdown 待渲染的 Markdown 源文本
 * @param priority 渲染优先级，缺省 Priority.High（仅 fallback worker 路径消费）
 */
export function useAsyncMarkdownHtml(
  markdown: string,
  priority: Priority = Priority.High
): { html: string; loading: boolean; failed: boolean } {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!markdown) {
      setHtml('');
      setLoading(false);
      setFailed(false);
      return;
    }
    const cached = getMarkdownHtmlCache(markdown);
    if (cached !== undefined) {
      setHtml(cached);
      setLoading(false);
      setFailed(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    cancelledRef.current = false;
    parseMarkdownToHtmlAsync(markdown, priority)
      .then((result) => {
        if (!cancelledRef.current) {
          setHtml(result);
          setLoading(false);
          // T5-3：非空原文渲染出空串 = 渲染失败（Rust missing + worker
          // 空结果），置 failed 供纯文本回退
          setFailed(result === '' && markdown.trim() !== '');
        }
      })
      .catch(() => {
        if (!cancelledRef.current) {
          setLoading(false);
          // T5-3：Rust missing + worker 也失败 → failed 标志（html 仍 ''）
          setFailed(true);
        }
      });
    return () => {
      cancelledRef.current = true;
    };
  }, [markdown, priority]);

  return { html, loading, failed };
}
