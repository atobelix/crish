/**
 * Markdown 渲染 React Hooks。
 *
 * - `useMarkdownResult`：封口块/文档 chunk 的静态渲染（走批量调度 + 缓存）；
 * - `useStreamingMarkdownResult`：活跃尾块的 Rust 流式渲染（latest-wins 节流）；
 * - `useMarkdownPrewarm`：静态消息/文档挂载时批量预热。
 */
import { useEffect, useRef, useState } from 'react';
import type { MarkdownVariant } from '../rustCore';
import { renderMarkdownStream } from '../rustCore';
import {
  prewarmMarkdownResults,
  requestMarkdownResult,
} from '../markdownRenderScheduler';
import { getMarkdownResult } from '../markdownResultCache';
import { closeMarkdownDraftForRender } from './markdownDraftCloser';
import { MarkdownBlockScanner } from './markdownBlockScanner';

interface RenderState {
  key: string;
  html: string;
  truncated: boolean;
  loading: boolean;
  failed: boolean;
}

export interface MarkdownRenderState {
  html: string;
  truncated: boolean;
  loading: boolean;
  failed: boolean;
}

function keyOf(text: string, variant: MarkdownVariant): string {
  return `${variant}\u0000${text}`;
}

export function useMarkdownResult(
  text: string,
  variant: MarkdownVariant,
  enabled = true
): MarkdownRenderState {
  const key = keyOf(text, variant);
  const [state, setState] = useState<RenderState>(() => {
    const cached = enabled ? getMarkdownResult(variant, text) : undefined;
    return {
      key,
      html: cached?.html ?? '',
      truncated: cached?.truncated ?? false,
      loading: Boolean(enabled && text.trim() && !cached),
      failed: false,
    };
  });

  const cached = enabled ? getMarkdownResult(variant, text) : undefined;

  useEffect(() => {
    if (!enabled || !text.trim()) {
      setState({
        key,
        html: '',
        truncated: false,
        loading: false,
        failed: false,
      });
      return;
    }

    const hit = getMarkdownResult(variant, text);
    if (hit) {
      setState({
        key,
        html: hit.html,
        truncated: hit.truncated,
        loading: false,
        failed: false,
      });
      return;
    }

    let cancelled = false;
    setState({
      key,
      html: '',
      truncated: false,
      loading: true,
      failed: false,
    });

    void requestMarkdownResult(text, variant)
      .then((result) => {
        if (cancelled) return;
        if (result) {
          setState({
            key,
            html: result.html,
            truncated: result.truncated,
            loading: false,
            failed: false,
          });
        } else {
          setState({
            key,
            html: '',
            truncated: false,
            loading: false,
            failed: true,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            key,
            html: '',
            truncated: false,
            loading: false,
            failed: true,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [key, text, variant, enabled]);

  if (cached) {
    return {
      html: cached.html,
      truncated: cached.truncated,
      loading: false,
      failed: false,
    };
  }
  if (state.key !== key) {
    return {
      html: '',
      truncated: false,
      loading: Boolean(enabled && text.trim()),
      failed: false,
    };
  }
  return state;
}

export function useStreamingMarkdownResult(
  text: string,
  variant: MarkdownVariant,
  enabled = true
): MarkdownRenderState {
  const [state, setState] = useState<MarkdownRenderState>({
    html: '',
    truncated: false,
    loading: false,
    failed: false,
  });
  const textRef = useRef(text);
  textRef.current = text;
  const variantRef = useRef(variant);
  variantRef.current = variant;

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let timer: number | null = null;
    let inFlight = false;
    let lastAttempted = '';

    const tick = () => {
      if (stopped) return;
      const current = textRef.current;
      if (!current.trim()) {
        timer = window.setTimeout(tick, 33);
        return;
      }
      if (inFlight || current === lastAttempted) {
        timer = window.setTimeout(tick, current.length > 32_000 ? 120 : 33);
        return;
      }

      inFlight = true;
      lastAttempted = current;
      const source = closeMarkdownDraftForRender(current);
      const sourceVariant = variantRef.current;

      void renderMarkdownStream(source, sourceVariant)
        .then((result) => {
          if (stopped || textRef.current !== current) return;
          if (result) {
            setState({
              html: result.html,
              truncated: result.truncated,
              loading: false,
              failed: false,
            });
          } else {
            setState((prev) => ({ ...prev, loading: false, failed: true }));
          }
        })
        .catch(() => {
          if (!stopped && textRef.current === current) {
            setState((prev) => ({ ...prev, loading: false, failed: true }));
          }
        })
        .finally(() => {
          inFlight = false;
        });

      timer = window.setTimeout(tick, current.length > 32_000 ? 120 : 33);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [enabled]);

  return state;
}

/**
 * 静态消息/文档挂载时批量预热块；不阻塞渲染，不返回状态。
 * 流式活跃文本不要调用（会反复切分）。
 */
export function useMarkdownPrewarm(
  text: string,
  variant: MarkdownVariant,
  enabled = true
): void {
  useEffect(() => {
    if (!enabled || !text.trim()) return;
    const blocks = MarkdownBlockScanner.split(text);
    prewarmMarkdownResults(blocks, variant, 3);
  }, [text, variant, enabled]);
}
