// 边缘羽化（原型 conv-message-list mask-image 四段曲线的 RN 等价实现）：
// 原型以 mask 直接淡化内容本体（0 / .18@25px / .38@55px / 1@95px，上下对称）；
// RN 无 mask-image 等价物（masked-view 未装），以「底色渐变覆膜」等效：
// 覆膜不透明度 = 1 − mask alpha，停点按 95px 羽化带以 userSpaceOnUse 锚定像素位，
// 不随条带总高拉伸；覆膜色须与列表所贴底色同档（默认 canvas，可注入其他档）。
// pointerEvents 关闭，不拦截滚动。
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useTheme } from '@/adapters/platform/theme';

/** 原型羽化带长度（px）：0 → 95px 内完成四段过渡 */
const FADE_SPAN = 95;
/** mask alpha 四段落点（距边缘 px / alpha），覆膜取其补数 */
const MASK_STOPS = [
  { at: 0, alpha: 0 },
  { at: 25, alpha: 0.18 },
  { at: 55, alpha: 0.38 },
  { at: FADE_SPAN, alpha: 1 },
] as const;

export interface EdgeFadeProps {
  /** top：上缘淡入（顶部透明→实色）；bottom：下缘淡出（实色→底部透明） */
  side: 'top' | 'bottom';
  height: number;
  /** 覆膜底色（须与列表所贴底色同档）；缺省 = theme.colors.canvas */
  color?: string;
}

export function EdgeFade({ side, height, color }: EdgeFadeProps) {
  const theme = useTheme();
  const gradientId = `edge-fade-${side}`;
  const fadeColor = color ?? theme.colors.canvas;
  // 羽化带锚定在条带靠边缘一侧的 95px：top 侧自上缘起、bottom 侧自下缘起
  const span = Math.min(FADE_SPAN, height);
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
          {MASK_STOPS.map(({ at, alpha }) => {
            // 停点按「距边缘 at px」落位：top 侧自上缘向内、bottom 侧自下缘向内镜像；
            // 覆膜不透明度恒 = 1 − mask alpha（边缘最实、带内渐隐为 0）
            const offset =
              span === 0
                ? 0
                : side === 'top'
                  ? at / FADE_SPAN
                  : 1 - at / FADE_SPAN;
            return (
              <Stop
                key={at}
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
