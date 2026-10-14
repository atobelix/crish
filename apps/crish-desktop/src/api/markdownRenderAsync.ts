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

export interface MarkdownRenderAsyncOptions {
  signal?: AbortSignal;
  sessionId?: string;
}

const pendingRenders = new Map<string, Promise<string>>();

function bindAbortSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException('Task cancelled', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException('Task cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/**
 * 异步渲染 markdown → HTML。
 *
 * 渲染路径优先级：
 *   1. 内存 LRU 缓存命中 → 同步返回
 *   2. Rust `md_render` 命令（pulldown-cmark + syntect + ammonia）→ 异步 IPC
 *   3. Rust 命令缺失（missing）/失败 → 回退到 worker pool（highlight.js 路径），
 *      全链路贯穿传递 `AbortSignal` 与 `sessionId` 支持物理取消与会话强杀。
 */
export async function parseMarkdownToHtmlAsync(
  raw: string,
  priority: Priority = Priority.High,
  options?: MarkdownRenderAsyncOptions
): Promise<string> {
  if (!raw || !raw.trim()) return '';
  if (options?.signal?.aborted) {
    throw new DOMException('Task cancelled', 'AbortError');
  }

  // 1. LRU 命中：不再调任何 IPC
  const cached = getMarkdownHtmlCache(raw);
  if (cached !== undefined) return cached;

  // 2. 去重并发请求（当未传入独立取消信号时复用在途 Promise）
  const pending = pendingRenders.get(raw);
  if (pending) {
    return bindAbortSignal(pending, options?.signal);
  }

  const promise = (async () => {
    // 2a. 优先 Rust 渲染
    const rustHtml = await renderMarkdown(raw);
    if (rustHtml != null) {
      setMarkdownHtmlCache(raw, rustHtml);
      return rustHtml;
    }
    if (options?.signal?.aborted) {
      throw new DOMException('Task cancelled', 'AbortError');
    }
    // 2b. Rust missing/error → 回退 worker pool（透传 AbortSignal 与 sessionId）
    const hasWorkerOpts =
      options?.signal !== undefined || options?.sessionId !== undefined;
    const workerHtml = hasWorkerOpts
      ? await getWorkerPool().schedule<string>(
          'render',
          'markdown.render',
          { raw },
          priority,
          {
            ...(options?.signal !== undefined
              ? { signal: options.signal }
              : {}),
            ...(options?.sessionId !== undefined
              ? { sessionId: options.sessionId }
              : {}),
          }
        )
      : await getWorkerPool().schedule<string>(
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
  return bindAbortSignal(promise, options?.signal);
}

/**
 * 异步渲染 Markdown 为 HTML 的 React Hook。
 *
 * 行为：
 *   - 空串 / 仅空白 → 立即返回 `{ html: '', loading: false, failed: false }`
 *   - 命中内存缓存 → 同步返回缓存值，loading 保持 false
 *   - 否则触发 Rust / worker 异步渲染，loading=true；完成后写入 state
 *   - 组件卸载或入参变更时通过 AbortController 触发物理取消信号，并贯穿传递 sessionId
 *     至 WorkerPool，支持三级级联 Tier 1 会话强杀。
 */
export function useAsyncMarkdownHtml(
  markdown: string,
  priority: Priority = Priority.High,
  sessionId?: string
): { html: string; loading: boolean; failed: boolean } {
  const [html, setHtml] = useState(() =>
    markdown && markdown.trim() ? (getMarkdownHtmlCache(markdown) ?? '') : ''
  );
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!markdown || !markdown.trim()) {
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

    const abortController = new AbortController();
    setLoading(true);
    setFailed(false);
    setHtml('');

    parseMarkdownToHtmlAsync(markdown, priority, {
      signal: abortController.signal,
      ...(sessionId !== undefined ? { sessionId } : {}),
    })
      .then((result) => {
        if (!abortController.signal.aborted) {
          setHtml(result);
          setLoading(false);
          setFailed(result === '' && markdown.trim() !== '');
        }
      })
      .catch(() => {
        if (!abortController.signal.aborted) {
          setLoading(false);
          setFailed(true);
        }
      });

    return () => {
      abortController.abort();
    };
  }, [markdown, priority, sessionId]);

  return { html, loading, failed };
}

/**
 * 流式活跃块的安全 HTML 渲染器（增量状态机与会话代次守护版）。
 */
export function useStreamingMarkdownHtml(
  markdown: string,
  enabled: boolean,
  priority: Priority = Priority.High,
  unitsRef?: MutableRefObject<
    readonly IncrementalMarkdownUnitSnapshot[] | null
  >,
  sessionId?: string
): string {
  const [html, setHtml] = useState('');
  const [, setRenderVersion] = useState(0);
  const sessionRef = useRef<IncrementalMarkdownSession | null>(null);
  if (!sessionRef.current)
    sessionRef.current = new IncrementalMarkdownSession();
  const mountedRef = useRef(true);
  const sessionEpochRef = useRef(0);
  const epochAbortRef = useRef<AbortController | null>(null);
  const unitRevisionMapRef = useRef<Map<number, number>>(new Map());
  const tickRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    const session = sessionRef.current;
    if (!session) return;

    if (!enabled || !markdown.trim()) {
      sessionEpochRef.current += 1;
      epochAbortRef.current?.abort();
      epochAbortRef.current = null;
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
      epochAbortRef.current?.abort();
      epochAbortRef.current = null;
      unitRevisionMapRef.current.clear();
    }
    if (!epochAbortRef.current) {
      epochAbortRef.current = new AbortController();
    }
    const currentSignal = epochAbortRef.current.signal;
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
      unitsRef.current = currentSnapshots;
    }

    const partPromises = advance.textParts.map(async (part) => {
      try {
        const fragment = await parseMarkdownFragmentToHtmlAsync(
          part.source,
          priority,
          part.kind,
          {
            signal: currentSignal,
            ...(sessionId !== undefined ? { sessionId } : {}),
          }
        );
        return { id: part.id, fragment };
      } catch {
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
  }, [markdown, enabled, priority, unitsRef, sessionId]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      sessionEpochRef.current += 1;
      epochAbortRef.current?.abort();
      epochAbortRef.current = null;
      unitRevisionMapRef.current.clear();
      sessionRef.current?.reset();
    },
    []
  );

  return html;
}

/**
 * 渲染一个由增量会话切出的有界语义片段，并只返回安全 HTML。
 */
export async function parseMarkdownFragmentToHtmlAsync(
  fragment: string,
  priority: Priority = Priority.High,
  kind: IncrementalMarkdownFragmentKind = 'inline',
  options?: MarkdownRenderAsyncOptions
): Promise<string> {
  if (!fragment) return '';
  if (kind !== 'block' && /^[ \t]+$/.test(fragment)) {
    return ' ';
  }
  const rendered = await parseMarkdownToHtmlAsync(fragment, priority, options);
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
