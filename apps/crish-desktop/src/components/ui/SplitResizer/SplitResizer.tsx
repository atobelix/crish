/**
 * apps/crish-desktop/src/components/ui/SplitResizer/SplitResizer.tsx
 *
 * ui/SplitResizer 统一分栏拖拽组件（分割线统一组件方案 · 波次 1 组件本体）。
 *
 * 分工：
 * - 手势 / 键盘 / 提交协议：统一 hook `useSplitResize`（指针捕获、rAF 节流、
 *   Esc 取消、单一 body 协议、提交模式可配、钳位与折叠阈值由调用方传入）；
 * - 呈现：弹性手柄引擎 `elasticHandle`（SVG 单路径 + 7 量弹簧系统），每帧经
 *   ref 直写 path 属性与 live CSS 变量，禁止每帧 setState / 重渲染。
 * - 域侧副作用出口：`onDragStateChange`（手势起止，与引擎状态机同点透传）
 *   与 `onRest`（呈现静止且 live 变量撤下时触发），供调用方挂与手势绑定的
 *   全局状态并在呈现收尾后幂等收束——回弹收尾同样被覆盖，调用方无须也不应
 *   另设定时器猜测收敛点。
 *
 * 视觉口径（用户 2026-11-02 裁决）：全站中性灰、不带任何颜色——描边色端点由
 * `--border-color` 起按相对台阶推导（静止端点 = --border-color 本值，激活端点
 * 向对比极走 30%）；无辉光、无激活加粗（粗细编码由手柄形态自身承担）。
 *
 * 布局契约：本组件渲染为分栏容器中的一个 flex 子项（宽/高 = 热区，默认 8px），
 * 由调用方放置在分界线上。拖拽期呈现尺寸经 live CSS 变量写到目标元素
 * （默认父元素），调用方以 `width: var(--split-resizer-live, <state>px)` 消费；
 * 提交后变量在弹簧静止时移除，控制权交回调用方状态。
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type MutableRefObject,
} from 'react';
import { useI18n } from '../../../i18n';
import {
  useSplitResize,
  type SplitResizeCommitMode,
  type SplitResizeOrientation,
} from './useSplitResize';
import {
  ElasticHandleEngine,
  FALLBACK_REST_RGB,
  type ElasticHandleParams,
  type ElasticSpringKey,
  type Rgb,
  type SpringConfig,
} from './elasticHandle';
import styles from './SplitResizer.module.css';

export type { SplitResizeCommitMode, SplitResizeOrientation };
export type SplitResizerRestMode = 'hidden' | 'hairline';

export interface SplitResizerProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'onDoubleClick' | 'onResize' | 'onPointerDown' | 'onKeyDown' | 'defaultValue'
> {
  /** 当前已提交尺寸（px，受控） */
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  /** 分界线方向：vertical = 竖线调宽（默认）；horizontal = 横线调高 */
  orientation?: SplitResizeOrientation;
  /** 轴向符号：-1 = 指针沿轴正向移动时尺寸减小（被调面板在分界线另一侧） */
  axisSign?: 1 | -1;
  /** 静止呈现：hidden = 靠相邻表面分界（默认）；hairline = 1px 常显 --border-subtle */
  rest?: SplitResizerRestMode;
  /** 热区宽（px，默认 8） */
  hitArea?: number;
  step?: number;
  largeStep?: number;
  commitMode?: SplitResizeCommitMode;
  collapseBelow?: number;
  onCollapse?: () => void;
  /**
   * 实时折叠（默认关，透传 useSplitResize）：开启后拖过 collapseBelow
   * 时呈现尺寸在拖拽流中即由弹簧收至 0（面板当场收起）、拖回即恢复，
   * 折叠提交仍在松手时经 onCollapse 落定。仅对「拖到边即收起」语义的
   * 面板开启（如主侧边栏，用户 2026-11-03 裁决）；其余分栏保持松手判定。
   */
  liveCollapse?: boolean;
  /** 双击复位目标（px） */
  defaultValue?: number;
  onReset?: () => void;
  /** rAF 节流的钳制后实时值（调用方自行绘制面板时使用） */
  onLiveChange?: (value: number) => void;
  /**
   * live CSS 变量名（默认 '--split-resizer-live'）；传 null 关闭变量绘制，
   * 改用 onLiveChange 自行绘制。多个实例共用一个目标元素时须各自命名。
   */
  liveVarName?: string | null;
  /** live 变量的写入目标（默认组件父元素） */
  liveVarTargetRef?: MutableRefObject<HTMLElement | null>;
  /**
   * 接近显隐距离（px，默认 16）：指针距分界线不超过此值时手柄浮现。
   * 传 0 关闭接近显隐（仅悬停热区 / 聚焦时浮现）。
   */
  proximity?: number;
  /** 描边色端点覆盖（CSS 颜色字符串）；默认由 --border-color 推导 */
  colors?: { rest?: string; active?: string };
  /** 手柄形态参数覆盖 */
  handle?: Partial<ElasticHandleParams>;
  /** 弹簧参数覆盖 */
  springs?: Partial<Record<ElasticSpringKey, Partial<SpringConfig>>>;
  /** 减动效覆盖；默认跟随系统 prefers-reduced-motion */
  reducedMotion?: boolean;
  disabled?: boolean;
  /**
   * 拖拽开始 / 结束（含 Esc 取消与中断兜底）时透传，与引擎内部状态机同点
   * 触发；供调用方挂域侧副作用（如全局 body 类、遮罩）。键盘 / 双击的
   * 程序化提交不经过此回调（走 onCommit）。
   */
  onDragStateChange?: (dragging: boolean) => void;
  /**
   * 呈现引擎进入静止且 live 变量已撤下时触发：拖拽回弹收尾、悬停淡出、
   * 程序化设定收敛、挂载后首帧均可能触发，语义为「呈现循环停转」通知——
   * 调用方应做幂等收束（如移除手势期全局类），不得假设它只跟随拖拽。
   */
  onRest?: () => void;
}

const DEFAULT_HIT_AREA = 8;
const DEFAULT_PROXIMITY = 16;
/** 释放时「指针仍近」的判定半径 = proximity + 本值（演示 32px 对 28px 的迟滞关系） */
const RELEASE_NEAR_SLACK = 16;
/** 接近判定用的分界几何缓存有效期（ms）；过期在指针事件中惰性刷新，不进 rAF 循环读布局 */
const GEOMETRY_CACHE_MS = 250;
/**
 * WindowResizeBridge 在窗口缩放（含最大化 / 还原）稳定 150ms 后派发的事件。
 * G-03 口径：业务组件禁止裸监听 window resize，几何缓存失效统一订阅此事件
 *（与 components/shell/windowSnapOverlay 同一消费范式）；缩放进行中缓存仅被
 * 指针移动消费，指针彼时被系统窗框捕获，稳定后失效与即时失效行为等价。
 */
const WINDOW_RESIZE_SETTLED_EVENT = 'app:window-resize-settled';

function parseCssColor(raw: string | undefined): Rgb | null {
  if (!raw) return null;
  const text = raw.trim();
  const hexDigits = /^#([0-9a-f]{6})$/i.exec(text)?.[1];
  if (hexDigits !== undefined) {
    const n = parseInt(hexDigits, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(text);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return null;
}

export const SplitResizer = forwardRef<HTMLDivElement, SplitResizerProps>(
  function SplitResizer(props, forwardedRef) {
    const {
      value,
      min,
      max,
      onCommit,
      orientation = 'vertical',
      axisSign = 1,
      rest = 'hidden',
      hitArea = DEFAULT_HIT_AREA,
      step,
      largeStep,
      commitMode = 'release',
      collapseBelow,
      onCollapse,
      liveCollapse,
      defaultValue,
      onReset,
      onLiveChange,
      liveVarName = '--split-resizer-live',
      liveVarTargetRef,
      proximity = DEFAULT_PROXIMITY,
      colors,
      handle,
      springs,
      reducedMotion,
      onDragStateChange,
      onRest,
      disabled = false,
      className,
      style,
      'aria-label': ariaLabelProp,
      ...restProps
    } = props;

    const { t } = useI18n();
    const rootRef = useRef<HTMLDivElement | null>(null);
    const svgRef = useRef<SVGSVGElement | null>(null);
    const pathRef = useRef<SVGPathElement | null>(null);
    const engineRef = useRef<ElasticHandleEngine | null>(null);
    const rafRef = useRef<number | null>(null);
    const lastTsRef = useRef<number | null>(null);
    const liveVarActiveRef = useRef(false);
    const geometryRef = useRef<{
      line: number;
      crossMin: number;
      crossMax: number;
      at: number;
    } | null>(null);
    const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

    if (engineRef.current === null) {
      engineRef.current = new ElasticHandleEngine({
        params: handle,
        springs,
        initialValue: value,
        reducedMotion: reducedMotion ?? false,
        axisSign,
      });
    }
    const engine = engineRef.current;

    useEffect(() => {
      engine.setAxisSign(axisSign);
    }, [axisSign, engine]);

    // 调用方回调经 ref 转发：回调身份随渲染变化时不重建手势与呈现循环
    const callbacksRef = useRef<{
      onDragStateChange?: (dragging: boolean) => void;
      onRest?: () => void;
    }>({});
    callbacksRef.current = { onDragStateChange, onRest };

    // ── live 变量写入（呈现尺寸 → 调用方布局） ──────────────────────

    const liveVarTarget = useCallback((): HTMLElement | null => {
      if (liveVarName === null) return null;
      return (
        liveVarTargetRef?.current ?? rootRef.current?.parentElement ?? null
      );
    }, [liveVarName, liveVarTargetRef]);

    const paintLiveVar = useCallback(
      (px: number | null) => {
        const target = liveVarTarget();
        if (!target || liveVarName === null) return;
        if (px === null) {
          if (liveVarActiveRef.current) {
            target.style.removeProperty(liveVarName);
            liveVarActiveRef.current = false;
          }
        } else {
          // 弹簧欠阻尼在目标归 0（实时折叠）等大步阶跃时可有约 1px 级
          // 负过冲；负尺寸写入 CSS 变量会使 width/height 声明失效一帧，
          // 呈现值在写入点钳至 0（引擎内部弹簧值不受影响、照常收敛）。
          target.style.setProperty(
            liveVarName,
            `${Math.max(0, Math.round(px * 100) / 100)}px`
          );
          liveVarActiveRef.current = true;
        }
      },
      [liveVarTarget, liveVarName]
    );

    // ── 颜色端点解析（手势 / 唤醒时读取一次计算样式，不进帧循环） ──

    const refreshColors = useCallback(() => {
      const root = rootRef.current;
      let restRgb = parseCssColor(colors?.rest);
      if (!restRgb && root) {
        try {
          restRgb = parseCssColor(
            window.getComputedStyle(root).getPropertyValue('--border-color')
          );
        } catch {
          restRgb = null;
        }
      }
      const activeRgb = parseCssColor(colors?.active) ?? undefined;
      engine.setColors(restRgb ?? FALLBACK_REST_RGB, activeRgb);
    }, [colors?.rest, colors?.active, engine]);

    // ── rAF 呈现循环（按需启停；每帧只直写 DOM，不 setState） ──────

    const paintFrame = useCallback(() => {
      const path = pathRef.current;
      if (path) {
        path.setAttribute('d', engine.pathD(orientation));
        path.setAttribute('stroke-width', String(engine.strokeWidthValue));
        path.setAttribute('stroke', engine.strokeColor());
        path.setAttribute('opacity', String(engine.opacityValue));
      }
      paintLiveVar(engine.displayValue);
    }, [engine, orientation, paintLiveVar]);

    const ensureLoop = useCallback(() => {
      if (rafRef.current !== null) return;
      lastTsRef.current = null;
      const frame = (ts: number) => {
        rafRef.current = null;
        const last = lastTsRef.current;
        lastTsRef.current = ts;
        // 拖拽中：先把 hook 的最新原始目标喂给引擎（形态 + 橡皮筋位置），
        // 再推进弹簧——目标与形态在同一帧生效，不迟到一帧
        const draggingNow = resizeRef.current?.phaseRef.current === 'dragging';
        if (draggingNow) {
          engine.updateDrag(
            resizeRef.current.rawValueRef.current,
            resizeRef.current.collapseZoneRef.current
          );
        }
        engine.step(last === null ? 16 : ts - last);
        paintFrame();
        if (engine.isAtRest()) {
          lastTsRef.current = null;
          if (draggingNow) {
            // 拖拽中静止：停循环但保留 live 变量（宽度仍由弹簧值托管），
            // 后续 pointermove 会经窗口监听重新唤醒循环
            return;
          }
          // 非拖拽静止后撤下 live 变量，布局控制权交回调用方状态，
          // 并通知调用方呈现循环已停转（手势期全局状态在此收束）
          paintLiveVar(null);
          callbacksRef.current.onRest?.();
          return;
        }
        rafRef.current = requestAnimationFrame(frame);
      };
      rafRef.current = requestAnimationFrame(frame);
    }, [engine, paintFrame, paintLiveVar]);

    // ── 统一拖拽 hook ──────────────────────────────────────────────

    const resize = useSplitResize({
      value,
      min,
      max,
      orientation,
      axisSign,
      step,
      largeStep,
      commitMode,
      collapseBelow,
      liveCollapse,
      defaultValue,
      disabled,
      onCommit,
      onLiveChange,
      onCollapse,
      onReset,
      onWakeRequest: ensureLoop,
      onDragStateChange: (nowDragging) => {
        if (nowDragging) {
          refreshColors();
          engine.beginDrag(
            resizeRef.current?.liveValueRef.current ?? value,
            min,
            max
          );
        } else {
          const pointer = lastPointerRef.current;
          const near =
            pointer !== null &&
            pointerDistanceToLine(pointer) <= proximity + RELEASE_NEAR_SLACK;
          engine.endDrag(near);
          engine.setExternalValue(
            resizeRef.current?.liveValueRef.current ?? value
          );
        }
        callbacksRef.current.onDragStateChange?.(nowDragging);
        ensureLoop();
      },
    });
    const resizeRef = useRef(resize);
    resizeRef.current = resize;

    // ── 接近显隐（window pointermove + 缓存的分界几何） ────────────

    const readGeometry = useCallback(() => {
      const root = rootRef.current;
      if (!root) return null;
      const rect = root.getBoundingClientRect();
      const geo =
        orientation === 'vertical'
          ? {
              line: rect.left + rect.width / 2,
              crossMin: rect.top,
              crossMax: rect.bottom,
            }
          : {
              line: rect.top + rect.height / 2,
              crossMin: rect.left,
              crossMax: rect.right,
            };
      geometryRef.current = { ...geo, at: performance.now() };
      return geo;
    }, [orientation]);

    const pointerDistanceToLine = useCallback(
      (pointer: { x: number; y: number }): number => {
        let geo = geometryRef.current;
        if (!geo || performance.now() - geo.at > GEOMETRY_CACHE_MS) {
          geo = readGeometry() ? geometryRef.current : null;
        }
        if (!geo) return Number.POSITIVE_INFINITY;
        const along = orientation === 'vertical' ? pointer.x : pointer.y;
        const cross = orientation === 'vertical' ? pointer.y : pointer.x;
        if (cross < geo.crossMin || cross > geo.crossMax) {
          return Number.POSITIVE_INFINITY;
        }
        return Math.abs(along - geo.line);
      },
      [orientation, readGeometry]
    );

    useEffect(() => {
      if (disabled) return;
      const handlePointerMove = (e: PointerEvent) => {
        const pointer = { x: e.clientX, y: e.clientY };
        lastPointerRef.current = pointer;
        // 任意指针移动都可唤醒呈现循环（循环在静止时自停）；
        // 拖拽中静止停循环后，新目标靠这条路径重新驱动
        ensureLoop();
        if (resizeRef.current?.phaseRef.current === 'dragging') return;
        const distance = pointerDistanceToLine(pointer);
        engine.setHover(distance <= proximity);
        if (distance <= proximity) {
          refreshColors();
          ensureLoop();
        } else if (!engine.isAtRest()) {
          ensureLoop();
        }
      };
      const handlePointerLeave = () => {
        lastPointerRef.current = null;
        engine.setHover(false);
        ensureLoop();
      };
      const invalidateGeometry = () => {
        geometryRef.current = null;
      };
      window.addEventListener('pointermove', handlePointerMove, {
        passive: true,
      });
      document.documentElement.addEventListener(
        'pointerleave',
        handlePointerLeave
      );
      window.addEventListener(WINDOW_RESIZE_SETTLED_EVENT, invalidateGeometry);
      window.addEventListener('scroll', invalidateGeometry, {
        capture: true,
        passive: true,
      });
      return () => {
        window.removeEventListener('pointermove', handlePointerMove);
        document.documentElement.removeEventListener(
          'pointerleave',
          handlePointerLeave
        );
        window.removeEventListener(
          WINDOW_RESIZE_SETTLED_EVENT,
          invalidateGeometry
        );
        window.removeEventListener('scroll', invalidateGeometry, {
          capture: true,
        });
      };
    }, [
      disabled,
      engine,
      ensureLoop,
      pointerDistanceToLine,
      proximity,
      refreshColors,
    ]);

    // ── 受控值 / 系统减动效 / 卸载 ──────────────────────────────────

    useEffect(() => {
      engine.setExternalValue(value);
      ensureLoop();
    }, [engine, ensureLoop, value]);

    useEffect(() => {
      if (reducedMotion !== undefined) {
        engine.setReducedMotion(reducedMotion);
        return;
      }
      const query = window.matchMedia('(prefers-reduced-motion: reduce)');
      engine.setReducedMotion(query.matches);
      const handleChange = () => {
        engine.setReducedMotion(query.matches);
        ensureLoop();
      };
      query.addEventListener('change', handleChange);
      return () => query.removeEventListener('change', handleChange);
    }, [engine, ensureLoop, reducedMotion]);

    useEffect(() => {
      return () => {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        paintLiveVar(null);
      };
    }, [paintLiveVar]);

    const setRootRef = useCallback(
      (node: HTMLDivElement | null) => {
        rootRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) {
          (forwardedRef as MutableRefObject<HTMLDivElement | null>).current =
            node;
        }
      },
      [forwardedRef]
    );

    const ariaLabel = ariaLabelProp ?? t('common.splitResizerLabel');
    const ariaValueText = t('common.splitResizerValueText', {
      value: Math.round(value),
    });

    const mergedStyle: CSSProperties = {
      ...(style ?? {}),
      ['--sr-hit' as string]: `${hitArea}px`,
    } as CSSProperties;

    return (
      <div
        {...restProps}
        {...resize.separatorProps}
        ref={setRootRef}
        aria-label={ariaLabel}
        aria-valuetext={ariaValueText}
        className={`${styles.root} ${
          orientation === 'horizontal' ? styles.horizontal : styles.vertical
        } ${className ?? ''}`}
        style={mergedStyle}
        data-orientation={orientation}
        data-rest={rest}
        onFocus={(e) => {
          restProps.onFocus?.(e);
          engine.setFocused(true);
          refreshColors();
          ensureLoop();
        }}
        onBlur={(e) => {
          restProps.onBlur?.(e);
          engine.setFocused(false);
          ensureLoop();
        }}
      >
        {rest === 'hairline' && (
          <div className={styles.hairline} aria-hidden="true" />
        )}
        <svg
          ref={svgRef}
          className={styles.handle}
          viewBox={
            orientation === 'vertical' ? '-60 -70 120 140' : '-70 -60 140 120'
          }
          width={orientation === 'vertical' ? 120 : 140}
          height={orientation === 'vertical' ? 140 : 120}
          aria-hidden="true"
          focusable="false"
        >
          <path
            ref={pathRef}
            d="M 0 -19.5 Q 0 0 0 19.5"
            fill="none"
            strokeLinecap="round"
            strokeWidth={9.5}
            opacity={0}
          />
        </svg>
      </div>
    );
  }
);
