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
 * - clip：内容需裁进轮廓时，内层以同一路径 clip-path 裁切。
 *
 * 回滚口径（§2.5）：宿主原 border-radius 声明不由本组件删除；本组件根节点
 * 以同名义半径的普通圆弧作兜底（borderRadius 样式），摘掉 SVG 层即回到
 * 当前普通圆弧外观。第 0 波为空壳交付：无生产表面接入，视觉零变化。
 */
import React from 'react';
import {
  CORNER_EXPONENT,
  G2_TIERS,
  cornerPath,
  cornerSvgDataUri,
  type CornerRadii,
  type CornerRadiiInput,
  type G2RadiusTier,
} from '../../../utils/cornerPath';

export interface G2SurfaceProps {
  /** 档位名（首选）或名义半径数值/逐角对象——接入面只声明档位或名义值 */
  radius: G2RadiusTier | CornerRadiiInput;
  /** 填充色（形状层的唯一绘制色）；不传则不画背景层（仅 clip 形态可用） */
  fill?: string;
  /** 承载形态：实测生成（默认）或可拉伸背景层 */
  mode?: 'measured' | 'stretch';
  /** drop-shadow 滤镜值（如 '0 4px 16px rgba(0,0,0,0.08)'），跟随轮廓 */
  dropShadow?: string;
  /** 内容是否以同一轮廓 clip-path 裁切（接入清单的「裁切需求：有」时开启） */
  clip?: boolean;
  /** 显式尺寸：定尺寸面跳过测量；stretch 形态的生成尺寸口径亦在此声明 */
  width?: number;
  height?: number;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
  testID?: string;
}

function resolveRadii(
  radius: G2SurfaceProps['radius'],
): { input: CornerRadiiInput; fallback: number } {
  if (typeof radius === 'string') {
    const v = G2_TIERS[radius];
    return { input: v, fallback: v };
  }
  if (typeof radius === 'number') return { input: radius, fallback: radius };
  const parts = [radius.tl ?? 0, radius.tr ?? 0, radius.br ?? 0, radius.bl ?? 0];
  return { input: radius, fallback: Math.max(...parts) };
}

export const G2Surface: React.FC<G2SurfaceProps> = ({
  radius,
  fill,
  mode = 'measured',
  dropShadow,
  clip = false,
  width,
  height,
  className,
  style,
  children,
  testID,
}) => {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
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
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setMeasured((prev) =>
        Math.abs(prev.w - rect.width) > 0.5 || Math.abs(prev.h - rect.height) > 0.5
          ? { w: rect.width, h: rect.height }
          : prev,
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode, width, height]);

  const { input, fallback } = resolveRadii(radius);
  const w = width ?? measured.w;
  const h = height ?? measured.h;
  const sizeKnown = w > 0 && h > 0;
  const d = React.useMemo(
    () => (sizeKnown ? cornerPath(w, h, input, CORNER_EXPONENT) : ''),
    [sizeKnown, w, h, input],
  );

  const tierAttr = typeof radius === 'string' ? radius : undefined;

  return (
    <div
      ref={hostRef}
      className={className}
      data-testid={testID}
      data-g2-radius={tierAttr}
      data-g2-mode={mode}
      style={{ position: 'relative', borderRadius: fallback, ...style }}
    >
      {fill && mode === 'stretch' && sizeKnown ? (
        <div
          aria-hidden
          data-g2-layer="stretch"
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `url("${cornerSvgDataUri(w, h, input, fill)}")`,
            backgroundSize: '100% 100%',
            backgroundRepeat: 'no-repeat',
            filter: dropShadow ? `drop-shadow(${dropShadow})` : undefined,
            pointerEvents: 'none',
          }}
        />
      ) : null}
      {fill && mode === 'measured' && sizeKnown ? (
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
          <path d={d} fill={fill} />
        </svg>
      ) : null}
      {clip && sizeKnown ? (
        <div style={{ position: 'relative', clipPath: `path('${d}')` }}>{children}</div>
      ) : (
        children
      )}
    </div>
  );
};
