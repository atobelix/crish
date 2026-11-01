// 边缘羽化（原型 conv-message-list mask-image 渐变的 RN 等价实现）：
// 纯色画布上的线性渐变遮罩条——内容滚动到边缘时渐隐，触感与 CSS mask 一致。
// pointerEvents 关闭，不拦截滚动。
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useTheme } from '@/adapters/platform/theme';

export interface EdgeFadeProps {
  /** top：上缘淡入（顶部透明→实色）；bottom：下缘淡出（实色→底部透明） */
  side: 'top' | 'bottom';
  height: number;
}

export function EdgeFade({ side, height }: EdgeFadeProps) {
  const theme = useTheme();
  const gradientId = `edge-fade-${side}`;
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
        <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <Stop
            offset="0"
            stopColor={theme.colors.canvas}
            stopOpacity={side === 'top' ? 1 : 0}
          />
          <Stop
            offset="1"
            stopColor={theme.colors.canvas}
            stopOpacity={side === 'top' ? 0 : 1}
          />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height={height} fill={`url(#${gradientId})`} />
    </Svg>
  );
}

export default EdgeFade;
