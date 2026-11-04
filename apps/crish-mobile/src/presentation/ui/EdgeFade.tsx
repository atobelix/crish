// 边缘羽化（原型 conv-message-list mask-image 四段曲线的 RN 等价实现）：
// 原型以 mask 直接淡化内容本体（0 / .18@25px / .38@55px / 1@95px，上下对称）；
// RN 无 mask-image 等价物（masked-view 未装），以「底色渐变覆膜」等效：
// 覆膜不透明度 = 1 − mask alpha，停点按羽化带以 userSpaceOnUse 锚定像素位，
// 不随条带总高拉伸；覆膜色须与列表所贴底色同档（默认 canvas，可注入其他档）。
// 方案 16 优化：底部羽化跨度收窄至 36dp（FADE_SPAN_BOTTOM），消除最后一行文字发虚泛白。
// pointerEvents 关闭，不拦截滚动。
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useTheme } from '@/adapters/platform/theme';

/** 原型顶部羽化带长度（px）：0 → 95px 内完成四段过渡 */
const FADE_SPAN_TOP = 95;
/** 底部紧凑羽化带跨度（px）：收窄至 36dp，消除末尾文字泛白模糊（方案 16 钉案） */
const FADE_SPAN_BOTTOM = 36;

/** mask alpha 四段落点归一化比例（0~1 / alpha），覆膜取其补数（1 - alpha） */
const MASK_STOP_RATIOS = [
  { ratio: 0, alpha: 0 },
  { ratio: 25 / 95, alpha: 0.18 },
  { ratio: 55 / 95, alpha: 0.38 },
  { ratio: 1, alpha: 1 },
] as const;

export interface EdgeFadeProps {
  /** top：上缘淡入（顶部透明→实色）；bottom：下缘淡出（实色→底部透明） */
  side: 'top' | 'bottom';
  height: number;
  /** 覆膜底色（须与列表所贴底色同档）；缺省 = theme.colors.canvas */
  color?: string;
  /** 自定义羽化跨度；缺省 top 为 95dp，bottom 为 36dp */
  fadeSpan?: number;
}

export function EdgeFade({ side, height, color, fadeSpan }: EdgeFadeProps) {
  const theme = useTheme();
  const gradientId = `edge-fade-${side}`;
  const fadeColor = color ?? theme.colors.canvas;
  const nominalSpan =
    fadeSpan ?? (side === 'top' ? FADE_SPAN_TOP : FADE_SPAN_BOTTOM);
  const span = Math.min(nominalSpan, height);
  const y1 = side === 'top' ? 0 : height - span;
  const y2 = side === 'top' ? span : height;
  return (
    <Svg
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        ...(side === 'top' ? { top: 0 } : { bottom: 0 }),
        height,
      }}
      width="100%"
      height={height}
    >
      <Defs>
        <LinearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1={y1}
          x2="0"
          y2={y2}
        >
          {MASK_STOP_RATIOS.map(({ ratio, alpha }) => {
            // 停点按比例落位：top 侧自上缘向内、bottom 侧自下缘向内镜像；
            // 覆膜不透明度恒 = 1 − mask alpha（边缘最实、带内渐隐为 0）
            const offset = span === 0 ? 0 : side === 'top' ? ratio : 1 - ratio;
            return (
              <Stop
                key={ratio}
                offset={offset}
                stopColor={fadeColor}
                stopOpacity={1 - alpha}
              />
            );
          })}
        </LinearGradient>
      </Defs>
      <Rect width="100%" height={height} fill={`url(#${gradientId})`} />
    </Svg>
  );
}

export default EdgeFade;
