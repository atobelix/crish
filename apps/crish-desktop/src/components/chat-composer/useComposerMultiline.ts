/**
 * 单行胶囊 ↔ 多行网格：
 * 1. 单例 Canvas 2D 离屏度量（彻底废弃 DOM <span> 挂载）
 * 2. 虚拟单行基准解耦（Decoupled Baseline，基于 layoutW - used 纯单行容量）
 * 3. 24px 双门限施密特迟滞区间（Schmitt Trigger Deadband，死区内锁定上一帧状态）
 * 4. 120ms 振荡自愈熔断器（120ms 内翻转 >= 3 次触发 400ms 强制多行锁定）
 * 5. ResizeObserver 回调结合 RAF 防抖批处理调度
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export const GRID_GUTTER_PX = 18;
export const MIN_CAPACITY_PX = 200;
export const HYSTERESIS_BUFFER_PX = 24;
export const FLIP_WINDOW_MS = 120;
export const FLIP_THRESHOLD = 3;
export const LOCKOUT_DURATION_MS = 400;

let sharedCanvas: HTMLCanvasElement | null = null;
let sharedCtx: CanvasRenderingContext2D | null = null;

export function measureTextWidthCanvas(text: string, font: string): number {
  if (typeof window === 'undefined' && typeof document === 'undefined') return 0;
  if (!sharedCanvas && typeof document !== 'undefined') {
    sharedCanvas = document.createElement('canvas');
    sharedCtx = sharedCanvas.getContext('2d');
  }
  if (!sharedCtx && sharedCanvas) {
    sharedCtx = sharedCanvas.getContext('2d');
  }
  if (!sharedCtx) return text.length * 8;
  sharedCtx.font = font;
  return sharedCtx.measureText(text).width;
}

export function useComposerMultiline(opts: {
  text: string;
  hasAttachments: boolean;
  layoutRef: React.RefObject<HTMLElement | null>;
}): boolean {
  const { text, hasAttachments, layoutRef } = opts;
  const [multiline, setMultiline] = useState(
    () => hasAttachments || text.includes('\n')
  );
  const fontRef = useRef<string>('');
  const multilineRef = useRef(multiline);
  multilineRef.current = multiline;

  // 振荡熔断状态追踪
  const flipHistoryRef = useRef<number[]>([]);
  const lockedUntilRef = useRef<number>(0);

  const measure = useCallback(() => {
    if (hasAttachments || text.includes('\n')) {
      setMultiline(true);
      return;
    }
    const layout = layoutRef.current;
    if (!layout) {
      setMultiline(false);
      return;
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now < lockedUntilRef.current) {
      return; // 熔断锁定期间，保持多行
    }

    const left = layout.querySelector(
      '[data-composer-grid="left"]'
    ) as HTMLElement | null;
    const perm = layout.querySelector(
      '[data-composer-grid="perm"]'
    ) as HTMLElement | null;
    const right = layout.querySelector(
      '[data-composer-grid="right"]'
    ) as HTMLElement | null;
    const editable = layout.querySelector(
      '[contenteditable="true"], textarea'
    ) as HTMLElement | null;

    // DOM 多行实体判定：检查编辑器中是否存在多个段落、硬换行或滚动高度溢出
    const hasDomMultiBlocks = Boolean(
      editable &&
        ((editable instanceof HTMLTextAreaElement && editable.value.includes('\n')) ||
          editable.children.length > 1 ||
          editable.querySelector(
            'p + p, pre, blockquote, ul, ol, li, br:not(.ProseMirror-trailingBreak)'
          ) ||
          editable.scrollHeight > 32)
    );

    if (hasDomMultiBlocks) {
      setMultiline(true);
      return;
    }

    const layoutW = layout.clientWidth;
    const used =
      (left?.offsetWidth ?? 0) +
      (perm?.offsetWidth ?? 0) +
      (right?.offsetWidth ?? 0) +
      GRID_GUTTER_PX;
    const capacity = Math.max(MIN_CAPACITY_PX, layoutW - used);

    if (editable) {
      const cs = getComputedStyle(editable);
      fontRef.current = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    }

    const clean = text.replace(/\u200B/g, '').trim();
    if (!clean) {
      setMultiline(false);
      return;
    }

    const textWidth = measureTextWidthCanvas(
      clean,
      fontRef.current || '14px sans-serif'
    );
    const isCurrentlyMulti = multilineRef.current;

    let nextState = isCurrentlyMulti;
    if (!isCurrentlyMulti && textWidth >= capacity) {
      nextState = true; // 突破上门限，展开
    } else if (isCurrentlyMulti && textWidth < capacity - HYSTERESIS_BUFFER_PX) {
      nextState = false; // 跌破下门限，收起
    }

    if (nextState !== isCurrentlyMulti) {
      // 记录翻转历史并清理超出窗口的时间戳
      const history = flipHistoryRef.current.filter(
        (t) => now - t < FLIP_WINDOW_MS
      );
      history.push(now);
      flipHistoryRef.current = history;

      if (history.length >= FLIP_THRESHOLD) {
        // 触发 400ms 熔断保护，强制锁定多行态
        lockedUntilRef.current = now + LOCKOUT_DURATION_MS;
        setMultiline(true);
        return;
      }
      setMultiline(nextState);
    }
  }, [hasAttachments, layoutRef, text]);

  useLayoutEffect(() => {
    measure();
    const el = layoutRef.current;
    if (!el) return;

    // 用户在输入框按回车或输入时，input 事件同步触发，0ms 立即切换多行展开
    const onInput = () => {
      measure();
    };
    el.addEventListener('input', onInput);

    let rafId: number | null = null;
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      try {
        ro = new ResizeObserver(() => {
          if (typeof window !== 'undefined' && window.requestAnimationFrame) {
            if (rafId !== null) {
              window.cancelAnimationFrame(rafId);
            }
            rafId = window.requestAnimationFrame(() => {
              rafId = null;
              measure();
            });
          } else {
            measure();
          }
        });
        if (ro && typeof ro.observe === 'function') {
          ro.observe(el);
        }
      } catch {
        ro = null;
      }
    }

    return () => {
      el.removeEventListener('input', onInput);
      if (
        rafId !== null &&
        typeof window !== 'undefined' &&
        window.cancelAnimationFrame
      ) {
        window.cancelAnimationFrame(rafId);
      }
      if (ro && typeof ro.disconnect === 'function') {
        ro.disconnect();
      }
    };
  }, [layoutRef, measure]);

  return multiline;
}
