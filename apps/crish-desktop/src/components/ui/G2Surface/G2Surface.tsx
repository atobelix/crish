/**
 * apps/crish-desktop/src/components/ui/G2Surface/G2Surface.tsx
 *
 * G² 连续曲率圆角 · 接入形态 A（组件）——立项方案 §2.3 定死：
 * 接入形态二选一，本产品取组件形态；全局工具类形态（形态 B）不并行存在，
 * 如未来确需，其挂接点在 styles/design-system.css，须另行裁决（对账项登记于
 * 第 0 波施工报告）。接入面只声明档位名或名义半径，不出现路径数据——
 * 轮廓一律由 utils/cornerPath.ts 的 cornerPath 在尺寸落定时生成。
 *
 * 承载形态（§2.2-3/6）：
 * - mode="measured"（默认）：ResizeObserver 实测尺寸生成行内 SVG 背景层；
 *   尺寸落定才重算，动画/拖拽中由宿主保持挂载尺寸即天然冻结（生成结果按
 *   (w,h,R) 记忆，尺寸未变不重复生成）；
 * - mode="stretch"：可拉伸 SVG 背景层（preserveAspectRatio="none"），
 *   适合 max-content 宽表面；须传 width/height 作为生成尺寸口径；
 * - 带阴影面：dropShadow 以 filter: drop-shadow 跟随轮廓（§2.2-6）；
 * - clip：内容需裁进轮廓时，内层以同一路径 clip-path 裁切（内容层布局
 *   样式经 contentStyle 透传，第一波乙槽 C 补）；
 * - 带边框面（待裁决 #5 默认 (a) 同路径描边，第一波甲接入）：stroke 给定时
 *   在填充轮廓内侧以同一生成路径描边——描边路径按 concentricRadius(R,
 *   strokeWidth/2) 内缩生成并居中描画，外缘与填充轮廓的外缘重合（等价于
 *   CSS border 画在 border-box 内侧的口径）。仅 measured 形态支持描边；
 *   stretch 形态的 data URI 只承载填充（描边面不得用 stretch 接入）。
 *   描边绘制宽度经生成层 deviceSnappedStrokeWidth 按 devicePixelRatio
 *   对齐设备像素网格：被替代的 CSS 边框在引擎中恰按 1 设备 px 绘制，
 *   矢量描边不对齐时在分数 DPR 下摊宽发糊（2026-11-06 活测诊断批）。
 * - fill / stroke 经 style 传递（不用 presentation attribute）：CSS var() /
 *   color-mix() 等主题驱动值只有在 style 中才解析，属性写法会静默失效。
 * - ref 转发（G² 第一波丙接入）：根节点 ref 向外转发，组件可直接充当
 *   Radix asChild / Base UI render 的弹层元素（SEP 主面板、Menu/Popover
 *   弹窗、.leafBody 的量测 ref 均挂在此根节点上）；内部量测仍用 hostRef。
 * - 轮廓方案（双方案体系）：生成时经真源选择点 getCornerScheme() 现读
 *   （与 DPR 同口径，每次渲染现读）；默认 'g2' 时产物与既往逐字一致，
 *   切到 'concentric' 时填充/描边/clip/拉伸四路同换同心圆弧轮廓。
 *
 * 回滚口径（§2.5）：宿主原 border-radius 声明不由本组件删除；本组件根节点
 * 以同名义半径的普通圆弧作兜底（borderRadius 样式），摘掉 SVG 层即回到
 * 当前普通圆弧外观。第 0 波为空壳交付：无生产表面接入，视觉零变化。
 */
import React from 'react';
import {
  G2_TIERS,
  concentricRadius,
  cornerPath,
  cornerSvgDataUri,
  deviceSnappedStrokeWidth,
  getCornerScheme,
  type CornerRadii,
  type CornerRadiiInput,
  type G2RadiusTier,
} from '../../../utils/cornerPath';
import { ResizeObserverManager } from '../../../utils/ResizeObserverManager';

export interface G2SurfaceProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'className' | 'style' | 'children' | 'defaultValue'
> {
  /** 档位名（首选）或名义半径数值/逐角对象——接入面只声明档位或名义值 */
  radius: G2RadiusTier | CornerRadiiInput;
  /** 填充色（形状层的唯一绘制色）；不传则不画背景层（仅 clip 形态可用） */
  fill?: string;
  /**
   * 同路径描边色（待裁决 #5 默认 (a)）：带边框面传入原 border 颜色，
   * 边框改由生成路径描画（仅 measured 形态）；不传则无描边
   */
  stroke?: string;
  /**
   * 描边宽（名义 CSS px，默认 1）；绘制时按 devicePixelRatio 对齐设备
   * 像素网格（deviceSnappedStrokeWidth），与被替代的 CSS 边框在引擎中的
   * 实际绘制宽度一致——DPR 1 时恒等
   */
  strokeWidth?: number;
  /** 承载形态：实测生成（默认）或可拉伸背景层 */
  mode?: 'measured' | 'stretch';
  /** drop-shadow 滤镜值（如 '0 4px 16px rgba(0,0,0,0.08)'），跟随轮廓 */
  dropShadow?: string;
  /** 内容是否以同一轮廓 clip-path 裁切（接入清单的「裁切需求：有」时开启） */
  clip?: boolean;
  /**
   * clip 内容层样式透传（第一波乙槽 C 接入）：内容层须承接宿主 flex 链时
   * （如 Dialog 面板的纵列 flex + Body 伸展）在此声明；与内容层的
   * position/height/clipPath 合并，接入面只补布局属性
   */
  contentStyle?: React.CSSProperties;
  /** 显式尺寸：定尺寸面跳过测量；stretch 形态的生成尺寸口径亦在此声明 */
  width?: number;
  height?: number;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
  testID?: string;
}

/** 描边内缩半径：逐角按 concentricRadius(R, strokeWidth/2) 收口（生成层同心纪律） */
function insetRadiiForStroke(
  input: CornerRadiiInput,
  inset: number
): CornerRadiiInput {
  if (typeof input === 'number') return concentricRadius(input, inset);
  const out: Partial<CornerRadii> = {};
  (Object.keys(input) as Array<keyof CornerRadii>).forEach((k) => {
    const v = input[k];
    if (v !== undefined) out[k] = concentricRadius(v, inset);
  });
  return out;
}

function resolveRadii(radius: G2SurfaceProps['radius']): {
  input: CornerRadiiInput;
  fallback: number;
} {
  if (typeof radius === 'string') {
    const v = G2_TIERS[radius];
    return { input: v, fallback: v };
  }
  if (typeof radius === 'number') return { input: radius, fallback: radius };
  const parts = [
    radius.tl ?? 0,
    radius.tr ?? 0,
    radius.br ?? 0,
    radius.bl ?? 0,
  ];
  return { input: radius, fallback: Math.max(...parts) };
}

export const G2Surface = React.forwardRef<HTMLDivElement, G2SurfaceProps>(
  function G2Surface(
    {
      radius,
      fill,
      stroke,
      strokeWidth = 1,
      mode = 'measured',
      dropShadow,
      clip = false,
      contentStyle,
      width,
      height,
      className,
      style,
      children,
      testID,
      ...rest
    },
    ref
  ) {
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    // ref 合并：内部量测（hostRef）与外部转发 ref 指向同一根节点。
    const setHostRef = React.useCallback(
      (el: HTMLDivElement | null) => {
        hostRef.current = el;
        if (typeof ref === 'function') {
          ref(el);
        } else if (ref) {
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }
      },
      [ref]
    );
    const [measured, setMeasured] = React.useState<{ w: number; h: number }>({
      w: 0,
      h: 0,
    });

    React.useLayoutEffect(() => {
      if (mode !== 'measured' || width !== undefined || height !== undefined) {
        return;
      }
      const el = hostRef.current;
      if (!el || typeof ResizeObserver === 'undefined') return;
      // 统一批处理（G-03 2026-11-06 修复）：经 ResizeObserverManager 单例
      // 订阅，禁止裸 new ResizeObserver()（并发观测面合并到单一实例，
      // 避免观察器实例随接入面数量线性爆炸）
      const ro = ResizeObserverManager.getInstance();
      // 【G² 第一波甲订正】管理器 ResizeCallback 的口径是逐 entry 分发
      // （(entry) => void），原接入按原生 ResizeObserverCallback（entries
      // 数组）写 entries[0]——类型不符（TS2345）且运行时恒取不到 contentRect、
      // measured 形态永不落尺寸。改按管理器口径逐 entry 消费。
      const cb = (entry: ResizeObserverEntry) => {
        const rect = entry.contentRect;
        if (!rect) return;
        setMeasured((prev) =>
          Math.abs(prev.w - rect.width) > 0.5 ||
          Math.abs(prev.h - rect.height) > 0.5
            ? { w: rect.width, h: rect.height }
            : prev
        );
      };
      ro.observe(el, cb);
      return () => ro.unobserve(el, cb);
    }, [mode, width, height]);

    const { input, fallback } = resolveRadii(radius);
    const w = width ?? measured.w;
    const h = height ?? measured.h;
    const sizeKnown = w > 0 && h > 0;
    // 圆角方案：每次渲染现读真源选择点（与下方 DPR 同口径）——主题/设置层
    // 注入新方案后，下一次渲染/量测即按新方案生成；默认 'g2' 时产物逐字不变。
    const scheme = getCornerScheme();
    const d = React.useMemo(
      () => (sizeKnown ? cornerPath(w, h, input, undefined, scheme) : ''),
      [sizeKnown, w, h, input, scheme]
    );
    // 描边绘制宽度：名义宽按当前 devicePixelRatio 对齐设备像素网格（生成层
    // 收口）。每次渲染现读——DPR 随窗口跨屏变化时下一次渲染即跟随；jsdom/无
    // window 环境按 1 处理（恒等，既有产物断言口径不变）。
    const dpr =
      typeof window !== 'undefined' &&
      Number.isFinite(window.devicePixelRatio) &&
      window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
    const strokeWidthSnapped = deviceSnappedStrokeWidth(strokeWidth, dpr);
    // 同路径描边：以 (w−sw, h−sw) + 逐角 R−sw/2 生成内缩轮廓，平移 sw/2 后
    // 居中描画——描边外缘恰与填充轮廓外缘重合（CSS border 的内侧口径）；
    // sw 取对齐后宽度，内缩几何与绘制宽度同源
    const strokeD = React.useMemo(() => {
      if (!stroke || !sizeKnown || mode !== 'measured') return '';
      const sw = Math.max(0, strokeWidthSnapped);
      if (!(sw > 0) || w - sw <= 0 || h - sw <= 0) return '';
      return cornerPath(
        w - sw,
        h - sw,
        insetRadiiForStroke(input, sw / 2),
        undefined,
        scheme
      );
    }, [stroke, sizeKnown, mode, w, h, input, strokeWidthSnapped, scheme]);

    const tierAttr = typeof radius === 'string' ? radius : undefined;
    const hasLayer = Boolean(fill || (stroke && strokeD));

    return (
      <div
        ref={setHostRef}
        className={className}
        data-testid={testID}
        data-g2-radius={tierAttr}
        data-g2-mode={mode}
        style={{ position: 'relative', borderRadius: fallback, ...style }}
        {...rest}
      >
        {fill && mode === 'stretch' && sizeKnown ? (
          <div
            aria-hidden
            data-g2-layer="stretch"
            style={{
              position: 'absolute',
              inset: 0,
              backgroundImage: `url("${cornerSvgDataUri(w, h, input, fill, undefined, scheme)}")`,
              backgroundSize: '100% 100%',
              backgroundRepeat: 'no-repeat',
              filter: dropShadow ? `drop-shadow(${dropShadow})` : undefined,
              pointerEvents: 'none',
            }}
          />
        ) : null}
        {hasLayer && mode === 'measured' && sizeKnown ? (
          <svg
            aria-hidden
            data-g2-layer="measured"
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            style={{
              position: 'absolute',
              inset: 0,
              filter: dropShadow ? `drop-shadow(${dropShadow})` : undefined,
              pointerEvents: 'none',
            }}
          >
            {fill ? <path d={d} style={{ fill }} /> : null}
            {stroke && strokeD ? (
              <path
                d={strokeD}
                transform={`translate(${strokeWidthSnapped / 2} ${strokeWidthSnapped / 2})`}
                style={{
                  fill: 'none',
                  stroke,
                  strokeWidth: strokeWidthSnapped,
                }}
              />
            ) : null}
          </svg>
        ) : null}
        {clip && sizeKnown ? (
          <div
            style={{
              position: 'relative',
              height: '100%',
              clipPath: `path('${d}')`,
              ...contentStyle,
            }}
          >
            {children}
          </div>
        ) : (
          children
        )}
      </div>
    );
  }
);

G2Surface.displayName = 'G2Surface';
