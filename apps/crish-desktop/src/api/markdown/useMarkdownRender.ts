/**
 * Markdown 渲染 React Hooks。
 *
 * - `useMarkdownResult`：封口块/文档 chunk 的静态渲染（走批量调度 + 缓存）；
 * - `useStreamingMarkdownResult`：活跃尾块的 Rust 流式渲染（前缀有效落帧，settle 后立即追新）；
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

/**
 * 活跃尾块的轮询间隔（ms）：随尾块长度分档拉长并封顶。
 *
 * 尾块每帧走一次 Rust IPC 全量重渲，成本随长度近似线性增长；巨型单块
 * （整文件代码块、长表格）用更长的间隔把单位时间渲染次数压下来，
 * 短文本保持 33ms 的跟手感。
 */
export function streamPollIntervalMs(textLength: number): number {
  if (textLength <= 2_000) return 33;
  if (textLength <= 8_000) return 50;
  if (textLength <= 16_000) return 80;
  if (textLength <= 32_000) return 120;
  if (textLength <= 64_000) return 200;
  if (textLength <= 128_000) return 320;
  return 500;
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

    const schedule = (delay: number) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(tick, delay);
    };

    const tick = () => {
      if (stopped) return;
      timer = null;
      const current = textRef.current;
      if (!current.trim()) {
        schedule(33);
        return;
      }
      if (inFlight || current === lastAttempted) {
        schedule(streamPollIntervalMs(current.length));
        return;
      }

      inFlight = true;
      lastAttempted = current;
      const source = closeMarkdownDraftForRender(current);
      const sourceVariant = variantRef.current;
      // 本次尝试 settle 时仍落后于最新文本时为 true（前缀落帧后追新、
      // 或非前缀分叉丢弃后重试），finally 据此立即以最新文本再渲。
      let settledBehind = false;

      void renderMarkdownStream(source, sourceVariant)
        .then((result) => {
          if (stopped) return;
          const latest = textRef.current;
          if (latest !== current) {
            // 文本在 IPC 往返期间已前移。只追加的流里本次快照是最新文本
            // 的前缀：快照结果是合法进度而非过渡帧（下游 patch 对增长
            // 文本走增量追加，不是整块替换），直接落帧并立即追新——
            // 否则长尾块会陷入「往返期间必被前移追上 → 整帧丢弃」的
            // 饥饿—倾泻循环：长时间一字不出，偶尔落帧即积压全量。
            // 只有文本被改写（重试/编辑/回滚等非前缀分叉）才丢弃旧结果。
            if (
              result !== null &&
              variantRef.current === sourceVariant &&
              latest.startsWith(current)
            ) {
              setState({
                html: result.html,
                truncated: result.truncated,
                loading: false,
                failed: false,
              });
            }
            settledBehind = result !== null;
            return;
          }
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
          if (stopped) return;
          // 仍落后于最新文本 → 立即以最新文本再渲；已收敛/失败则按长度
          // 分档安排下一次轮询，失败不在此紧重试，避免 IPC 异常时空转。
          // 渲染尝试次数有上界：同一时刻至多一帧在飞，每次尝试只在上一
          // 帧 settle 后由 tick 发起、且快照取发起时刻的最新文本（同一
          // 文本不重复尝试），故尝试次数 ≤ settle 次数，不会因落帧语义
          // 放宽而出现无界追赶渲染。
          if (settledBehind) {
            schedule(0);
          } else {
            schedule(streamPollIntervalMs(textRef.current.length));
          }
        });
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
