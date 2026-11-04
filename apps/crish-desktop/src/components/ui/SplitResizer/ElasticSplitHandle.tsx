/**
 * apps/crish-desktop/src/components/ui/SplitResizer/ElasticSplitHandle.tsx
 *
 * 弹性手柄呈现组件（纯 SVG + 贝塞尔曲线，挂载于任意分栏/分界线上）。
 *
 * 统一契约：
 * 1. 纯 SVG 贝塞尔曲线绘制，随拖拽拉长变细，弧向严格跟随当前鼠标物理移动方向；
 * 2. 悬停/聚焦时通过弹簧平滑浮现为胶囊，松手/离开后平滑淡出；
 * 3. 逐帧经 ref 直写 SVG path 属性，零 React 重渲染，零性能开销；
 * 4. 全站中性灰，无辉光无高亮色。
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
} from 'react';
import {
  ElasticHandleEngine,
  FALLBACK_REST_RGB,
  type SplitResizerOrientation,
  type Rgb,
} from './elasticHandle';
import styles from './SplitResizer.module.css';

export interface ElasticSplitHandleProps {
  /** 分割线方向：vertical = 竖向线调宽；horizontal = 横向线调高 */
  orientation: SplitResizerOrientation;
  /** 是否正在拖拽 */
  isDragging?: boolean;
  /** 是否处于折叠区 */
  collapsed?: boolean;
  /** 外部指定的悬停态（若不传则自动监听父元素 hover） */
  isHovered?: boolean;
  className?: string;
  style?: CSSProperties;
}

function parseCssRgb(raw: string | undefined): Rgb | null {
  if (!raw) return null;
  const text = raw.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(text)?.[1];
  if (hex !== undefined) {
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(text);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return null;
}

export const ElasticSplitHandle: React.FC<ElasticSplitHandleProps> = React.memo(
  function ElasticSplitHandle({
    orientation,
    isDragging = false,
    collapsed = false,
    isHovered,
    className,
    style,
  }) {
    const svgRef = useRef<SVGSVGElement | null>(null);
    const pathRef = useRef<SVGPathElement | null>(null);
    const engineRef = useRef<ElasticHandleEngine | null>(null);
    const rafRef = useRef<number | null>(null);
    const lastTsRef = useRef<number | null>(null);

    if (engineRef.current === null) {
      engineRef.current = new ElasticHandleEngine();
    }
    const engine = engineRef.current;

    const refreshColors = useCallback(() => {
      const el = svgRef.current;
      if (!el) return;
      try {
        const computed = window
          .getComputedStyle(el)
          .getPropertyValue('--border-color');
        const restRgb = parseCssRgb(computed) ?? FALLBACK_REST_RGB;
        engine.setColors(restRgb);
      } catch {
        /* ignore */
      }
    }, [engine]);

    const paintFrame = useCallback(() => {
      const path = pathRef.current;
      if (!path) return;
      path.setAttribute('d', engine.pathD(orientation));
      path.setAttribute('stroke-width', String(engine.strokeWidthValue));
      path.setAttribute('stroke', engine.strokeColor());
      path.setAttribute('opacity', String(engine.opacityValue));
    }, [engine, orientation]);

    const ensureLoop = useCallback(() => {
      if (rafRef.current !== null) return;
      lastTsRef.current = null;
      const frame = (ts: number) => {
        rafRef.current = null;
        const last = lastTsRef.current;
        lastTsRef.current = ts;
        engine.step(last === null ? 16 : ts - last);
        paintFrame();
        if (!engine.isAtRest()) {
          rafRef.current = requestAnimationFrame(frame);
        }
      };
      rafRef.current = requestAnimationFrame(frame);
    }, [engine, paintFrame]);

    // 悬停监听：若外部未传 isHovered，则监听父元素 pointerenter / pointerleave / focusin / focusout
    useEffect(() => {
      if (isHovered !== undefined) {
        engine.setHover(isHovered);
        refreshColors();
        ensureLoop();
        return;
      }
      const parent = svgRef.current?.parentElement;
      if (!parent) return;

      const onEnter = () => {
        engine.setHover(true);
        refreshColors();
        ensureLoop();
      };
      const onLeave = () => {
        engine.setHover(false);
        ensureLoop();
      };
      const onFocus = () => {
        engine.setFocused(true);
        refreshColors();
        ensureLoop();
      };
      const onBlur = () => {
        engine.setFocused(false);
        ensureLoop();
      };

      parent.addEventListener('pointerenter', onEnter);
      parent.addEventListener('pointerleave', onLeave);
      parent.addEventListener('focusin', onFocus);
      parent.addEventListener('focusout', onBlur);

      return () => {
        parent.removeEventListener('pointerenter', onEnter);
        parent.removeEventListener('pointerleave', onLeave);
        parent.removeEventListener('focusin', onFocus);
        parent.removeEventListener('focusout', onBlur);
      };
    }, [isHovered, engine, ensureLoop, refreshColors]);

    // 拖拽手势生命周期与物理移动方向跟随
    useEffect(() => {
      if (!isDragging) {
        if (engine.getMode() === 'drag') {
          engine.endDrag(false);
          ensureLoop();
        }
        return;
      }

      refreshColors();
      engine.beginDrag(0, -100_000, 100_000);
      ensureLoop();

      let lastCoord: number | null = null;
      const onPointerMove = (e: PointerEvent) => {
        const coord = orientation === 'vertical' ? e.clientX : e.clientY;
        if (lastCoord !== null) {
          const step = coord - lastCoord;
          // 只要发生有效物理位移（超过 1px），圆弧立刻随当前手势移动方向弯曲
          if (Math.abs(step) >= 2) {
            const motion = step > 0 ? 24 : -24;
            engine.updateDrag(coord, collapsed, motion);
          }
        }
        lastCoord = coord;
        ensureLoop();
      };

      window.addEventListener('pointermove', onPointerMove, { passive: true });
      return () => {
        window.removeEventListener('pointermove', onPointerMove);
      };
    }, [isDragging, collapsed, orientation, engine, ensureLoop, refreshColors]);

    // 卸载保底
    useEffect(() => {
      return () => {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      };
    }, []);

    return (
      <svg
        ref={svgRef}
        className={`${styles.handle} ${className ?? ''}`}
        viewBox={
          orientation === 'vertical' ? '-60 -70 120 140' : '-70 -60 140 120'
        }
        width={orientation === 'vertical' ? 120 : 140}
        height={orientation === 'vertical' ? 140 : 120}
        aria-hidden="true"
        focusable="false"
        style={style}
      >
        <path
          ref={pathRef}
          d={
            orientation === 'vertical'
              ? 'M 0 -19.5 Q 0 0 0 19.5'
              : 'M -19.5 0 Q 0 0 19.5 0'
          }
          fill="none"
          strokeLinecap="round"
          strokeWidth={9.5}
          opacity={0}
        />
      </svg>
    );
  }
);

ElasticSplitHandle.displayName = 'ElasticSplitHandle';
