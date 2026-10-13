import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { getMarkdownHtmlCache, setMarkdownHtmlCache } from './markdownCache';
import { getWorkerPool, Priority } from '../workers';
import { renderMarkdown } from './rustCore';
import {
  IncrementalMarkdownSession,
  type IncrementalMarkdownFragmentKind,
  type IncrementalMarkdownUnitSnapshot,
} from './markdown/IncrementalMarkdownSession';

export {
  parseMarkdownAstAsync,
  useWorkerMarkdownAst,
  type MarkdownAstResult,
} from './markdownWorkerHook';

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
 * 空串时置 `failed=true`。展示层据此保持空白或上一份安全 HTML，禁止回退显示原文。
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
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (!markdown) {
      setHtml('');
      setLoading(false);
      setFailed(false);
      return () => {
        if (requestIdRef.current === requestId) requestIdRef.current += 1;
      };
    }
    const cached = getMarkdownHtmlCache(markdown);
    if (cached !== undefined) {
      setHtml(cached);
      setLoading(false);
      setFailed(false);
      return () => {
        if (requestIdRef.current === requestId) requestIdRef.current += 1;
      };
    }
    setLoading(true);
    setFailed(false);
    // 新 markdown 的异步结果尚未到达时，不能暂留上一段内容。
    // 旧 HTML 与当前输入无内容绑定，继续显示会把上一块短暂错投到新块。
    setHtml('');
    parseMarkdownToHtmlAsync(markdown, priority)
      .then((result) => {
        if (requestIdRef.current === requestId) {
          setHtml(result);
          setLoading(false);
          // T5-3：非空原文渲染出空串 = 渲染失败（Rust missing + worker
          // 空结果），置 failed 供纯文本回退
          setFailed(result === '' && markdown.trim() !== '');
        }
      })
      .catch(() => {
        if (requestIdRef.current === requestId) {
          setLoading(false);
          // T5-3：Rust missing + worker 也失败 → failed 标志（html 仍 ''）
          setFailed(true);
        }
      });
    return () => {
      if (requestIdRef.current === requestId) requestIdRef.current += 1;
    };
  }, [markdown, priority]);

  return { html, loading, failed };
}

/**
 * 流式活跃块的安全 HTML 渲染器（增量状态机与会话代次守护版）。
 *
 * 活跃块使用有状态的前端增量会话：累计输入只用于取得新增后缀，
 * Markdown 分隔符转成安全 HTML 状态，普通文本以增量片段交给现有
 * Rust/worker renderer。
 *
 * 批合并与代次守护：
 *   - 会话级 reset 代次（sessionEpochRef）：仅在 session.reset() 或 enabled 关闭/markdown 截断重置时递增，
 *     确保卸载或重置时安全丢弃死会话的在途 Promise；
 *   - 增量批次原子收口：单次 advance 产生的所有 textParts 通过 Promise.all 批收口；
 *     在途增量分片 resolveTextPart 结果平滑并入 unitsRef 与 session，绝不因后续无分片 tick
 *     或短片段先完成而误丢弃在途正文（根治 RC-06 空壳 <p> 锁存缺陷）。
 */
export function useStreamingMarkdownHtml(
  markdown: string,
  enabled: boolean,
  priority: Priority = Priority.High,
  unitsRef?: MutableRefObject<readonly IncrementalMarkdownUnitSnapshot[] | null>
): string {
  const [html, setHtml] = useState('');
  const [, setRenderVersion] = useState(0);
  const sessionRef = useRef<IncrementalMarkdownSession | null>(null);
  if (!sessionRef.current)
    sessionRef.current = new IncrementalMarkdownSession();
  const mountedRef = useRef(true);
  const sessionEpochRef = useRef(0);
  const unitRevisionMapRef = useRef<Map<number, number>>(new Map());
  const tickRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    const session = sessionRef.current;
    if (!session) return;

    if (!enabled || !markdown.trim()) {
      sessionEpochRef.current += 1;
      unitRevisionMapRef.current.clear();
      session.reset();
      if (unitsRef) {
        if (unitsRef.current !== null) {
          unitsRef.current = null;
          setRenderVersion((version) => version + 1);
        }
      } else {
        setHtml('');
      }
      return;
    }

    const advance = session.advance(markdown, !unitsRef);
    if (advance.reset) {
      sessionEpochRef.current += 1;
      unitRevisionMapRef.current.clear();
    }
    const sessionEpoch = sessionEpochRef.current;
    const currentTick = ++tickRef.current;

    const currentSnapshots = session.getUnitSnapshots();
    for (const u of currentSnapshots) {
      unitRevisionMapRef.current.set(u.id, currentTick);
    }

    if (advance.textParts.length === 0) {
      if (unitsRef) {
        unitsRef.current = currentSnapshots;
        setRenderVersion((version) => version + 1);
      } else {
        setHtml(advance.html);
      }
      return;
    }

    if (unitsRef) {
      // 结构已变化（如新增块包装器）时先同步更新单元快照引用，待全部分片批决议后统一触发 1 次重渲染
      unitsRef.current = currentSnapshots;
    }

    const partPromises = advance.textParts.map(async (part) => {
      try {
        const fragment = await parseMarkdownFragmentToHtmlAsync(
          part.source,
          priority,
          part.kind
        );
        return { id: part.id, fragment };
      } catch {
        // 渲染失败时保持该片段为空，绝不把 Markdown 原文写入 DOM。
        return { id: part.id, fragment: '' };
      }
    });

    void Promise.all(partPromises).then((results) => {
      if (!mountedRef.current) return;
      if (sessionEpochRef.current !== sessionEpoch) return;

      let anyResolved = false;
      for (const res of results) {
        if (session.resolveTextPart(res.id, res.fragment)) {
          anyResolved = true;
        }
      }
      if (!anyResolved) return;

      if (unitsRef) {
        unitsRef.current = session.getUnitSnapshots();
        setRenderVersion((version) => version + 1);
      } else {
        setHtml(session.toHtml());
      }
    });
  }, [markdown, enabled, priority, unitsRef]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      sessionEpochRef.current += 1;
      unitRevisionMapRef.current.clear();
      sessionRef.current?.reset();
    },
    []
  );

  return html;
}

/**
 * 渲染一个由增量会话切出的有界语义片段，并只返回安全 HTML。
 * 行内片段去掉 renderer 的块级包装器；标题和代码围栏保留完整结构，
 * 列表项只取安全的 `<li>` 节点。失败时返回空串，禁止原文回退。
 */
export async function parseMarkdownFragmentToHtmlAsync(
  fragment: string,
  priority: Priority = Priority.High,
  kind: IncrementalMarkdownFragmentKind = 'inline'
): Promise<string> {
  if (!fragment) return '';
  if (kind !== 'block' && /^[ \t]+$/.test(fragment)) {
    return ' ';
  }
  const rendered = await parseMarkdownToHtmlAsync(fragment, priority);
  if (!rendered) return '';

  if (kind === 'block') return rendered;

  const preserveInlineBoundarySpaces = (innerHtml: string): string => {
    if (!innerHtml) return innerHtml;
    const hasLeadingSpace = /^[ \t]+/.test(fragment);
    const hasTrailingSpace = /[ \t]+$/.test(fragment);
    const prefix = hasLeadingSpace && !/^\s/.test(innerHtml) ? ' ' : '';
    const suffix = hasTrailingSpace && !/\s$/.test(innerHtml) ? ' ' : '';
    return `${prefix}${innerHtml}${suffix}`;
  };

  if (typeof DOMParser !== 'undefined') {
    const template = document.createElement('template');
    template.innerHTML = rendered;
    if (kind === 'list-item') {
      const listItem = template.content.querySelector('li');
      if (listItem) return listItem.outerHTML;
      // 活跃列表项的外层 `<li>` 由增量会话维护；正文片段仍可直接
      // 使用普通 inline renderer，不能因为没有再次传入 `- ` 就丢失正文。
      const root = template.content.firstElementChild;
      return preserveInlineBoundarySpaces(root?.innerHTML ?? '');
    }
    const roots = Array.from(template.content.childNodes);
    if (roots.length === 1 && roots[0]?.nodeType === Node.ELEMENT_NODE) {
      return preserveInlineBoundarySpaces((roots[0] as Element).innerHTML);
    }
  }

  if (kind === 'list-item') {
    const listItem = rendered.match(/<li\b[^>]*>[\s\S]*<\/li>/i);
    if (listItem) return listItem[0];
    const paragraph = rendered.match(/^<p\b[^>]*>([\s\S]*)<\/p>$/i);
    return preserveInlineBoundarySpaces(paragraph?.[1] ?? '');
  }

  const paragraph = rendered.match(/^<p\b[^>]*>([\s\S]*)<\/p>$/i);
  return preserveInlineBoundarySpaces(paragraph?.[1] ?? rendered);
}
