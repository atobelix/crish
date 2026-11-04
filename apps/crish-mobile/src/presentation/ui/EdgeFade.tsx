// 边缘羽化（原型 conv-message-list mask-image 四段曲线的 RN 等价实现）：
// 原型以 mask 直接淡化内容本体（0 / .18@25px / .38@55px / 1@95px，上下对称）；
// RN 无 mask-image 等价物（masked-view 未装），以「底色渐变覆膜」等效：
// 覆膜不透明度 = 1 − mask alpha，停点按羽化带以 userSpaceOnUse 锚定像素位，
// 不随条带总高拉伸；覆膜色须与列表所贴底色同档（默认 canvas，可注入其他档）。
// 方案 16 优化：底部羽化跨度收窄至 36dp（FADE_SPAN_BOTTOM），消除最后一行文字发虚泛白。
// 方案 19 升级：支持 Reanimated 共享值驱动（keyboardHeightSV / animatedAdditionalHeight），
// 随输入框升降微秒级同步拉伸与回缩，彻底根除白块滞后闪现。
// pointerEvents 关闭，不拦截滚动。
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import Animated, {
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
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
  /** 静态高度（支持无动画场景及顶部羽化；若传入 animatedAdditionalHeight / keyboardHeightSV，此作为 baseHeight） */
  height?: number;
  /** 基础物理高度 (不含动态键盘增加高度，同 height) */
  baseHeight?: number;
  /** 动态键盘高度 SharedValue (UI 线程 120fps 驱动，方案 19 核心) */
  keyboardHeightSV?: SharedValue<number>;
  /** 动态附加高度 SharedValue (同 keyboardHeightSV) */
  animatedAdditionalHeight?: SharedValue<number>;
  /** 覆膜底色（须与列表所贴底色同档）；缺省 = theme.colors.canvas */
  color?: string;
  /** 自定义羽化跨度；缺省 top 为 95dp，bottom 为 36dp */
  fadeSpan?: number;
}

export function EdgeFade({
  side,
  height,
  baseHeight,
  keyboardHeightSV,
  animatedAdditionalHeight,
  color,
  fadeSpan,
}: EdgeFadeProps) {
  const theme = useTheme();
  const gradientId = `edge-fade-${side}`;
  const fadeColor = color ?? theme.colors.canvas;
  const nominalSpan =
    fadeSpan ?? (side === 'top' ? FADE_SPAN_TOP : FADE_SPAN_BOTTOM);

  const kbSV = keyboardHeightSV ?? animatedAdditionalHeight;
  const effectiveBaseHeight = baseHeight ?? height ?? 0;

  // 方案 19：Reanimated 共享值驱动 120fps 动态贴合
  const isAnimated = kbSV !== undefined;

  const animatedStyle = useAnimatedStyle(() => {
    'worklet';
    if (!kbSV) {
      return { height: Math.max(0, effectiveBaseHeight) };
    }
    const dynamicKb = Math.abs(kbSV.value);
    const totalHeight = effectiveBaseHeight + dynamicKb;
    return {
      height: Math.max(0, totalHeight),
    };
  });

  if (isAnimated && side === 'bottom') {
    const span = Math.min(nominalSpan, effectiveBaseHeight);
    return (
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[
          {
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: fadeColor,
            overflow: 'hidden',
          },
          animatedStyle,
        ]}
      >
        <Svg
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: span,
          }}
          width="100%"
          height={span}
        >
          <Defs>
            <LinearGradient
              id={gradientId}
              gradientUnits="userSpaceOnUse"
              x1="0"
              y1={0}
              x2="0"
              y2={span}
            >
              {MASK_STOP_RATIOS.map(({ ratio, alpha }) => (
                <Stop
                  key={ratio}
                  offset={1 - ratio}
                  stopColor={fadeColor}
                  stopOpacity={1 - alpha}
                />
              ))}
            </LinearGradient>
          </Defs>
          <Rect width="100%" height={span} fill={`url(#${gradientId})`} />
        </Svg>
      </Animated.View>
    );
  }

  // 纯静态 SVG 渲染路径（向后兼容及顶部固定羽化）
  const staticHeight = effectiveBaseHeight;
  const span = Math.min(nominalSpan, staticHeight);
  const y1 = side === 'top' ? 0 : staticHeight - span;
  const y2 = side === 'top' ? span : staticHeight;

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
        height: staticHeight,
      }}
      width="100%"
      height={staticHeight}
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
      <Rect width="100%" height={staticHeight} fill={`url(#${gradientId})`} />
    </Svg>
  );
}

export const AnimatedEdgeFade = EdgeFade;
export default EdgeFade;
