// 品牌标记：与桌面应用图标同构（墨色圆角方块 + 反色六向符号 + 品牌绿原点）。
// 颜色全部取主题：深色模式下方块随 actionPrimary 反转为浅色。
import Svg, { Circle, Line, Rect } from 'react-native-svg';
import { useTheme } from '@/adapters/platform/theme';

export interface BrandMarkProps {
  size?: number;
}

export function BrandMark({ size = 64 }: BrandMarkProps) {
  const theme = useTheme();
  const cx = size / 2;
  const cy = size * 0.58;
  const arm = size * 0.2;
  const stroke = size * 0.095;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Rect
        width={size}
        height={size}
        rx={size * theme.layout.brandMarkCorner}
        fill={theme.colors.actionPrimary}
      />
      {[0, 60, 120].map((angle) => {
        const rad = (angle * Math.PI) / 180;
        const dx = Math.cos(rad) * arm;
        const dy = Math.sin(rad) * arm;
        return (
          <Line
            key={angle}
            x1={cx - dx}
            y1={cy - dy}
            x2={cx + dx}
            y2={cy + dy}
            stroke={theme.colors.actionPrimaryText}
            strokeWidth={stroke}
            strokeLinecap="round"
          />
        );
      })}
      <Circle
        cx={cx}
        cy={size * 0.19}
        r={size * 0.065}
        fill={theme.colors.brand}
      />
    </Svg>
  );
}

export default BrandMark;
