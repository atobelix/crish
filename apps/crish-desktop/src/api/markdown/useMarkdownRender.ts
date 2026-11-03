/**
 * Markdown 渲染 React Hooks。
 *
 * - `useMarkdownResult`：封口块/文档 chunk 的静态渲染（走批量调度 + 缓存）；
 * - `useMarkdownPrewarm`：静态消息/文档挂载时批量预热。
 */
import { useEffect, useState } from 'react';
import type { MarkdownVariant } from '../rustCore';
import {
  prewarmMarkdownResults,
  requestMarkdownResult,
} from '../markdownRenderScheduler';
import { getMarkdownResult } from '../markdownResultCache';
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
