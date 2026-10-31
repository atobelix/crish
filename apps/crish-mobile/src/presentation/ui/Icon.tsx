// 图标唯一入口（实现波总方案 G4 / N05 落地）：内联 SVG Path 渲染。
// 24 网格 / theme.layout.iconStroke 线宽 / 语义 token 染色；
// 业务只写语义 IconName（iconPaths.ts 单一真源），禁止直接 import 图标库。
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/adapters/platform/theme';
import { ICON_PATHS, type IconName } from './iconPaths';

export type { IconName };

export interface IconProps {
  name: IconName;
  /** 只允许 theme.size.icon* 阶梯（16/20/24），禁止裸数字 */
  size?: number;
  /** 语义 token 色值（缺省 textSecondary） */
  color?: string;
  /** 线宽覆盖（缺省 theme.layout.iconStroke = 2） */
  strokeWidth?: number;
}

export function Icon({ name, size, color, strokeWidth }: IconProps) {
  const theme = useTheme();
  const iconSize = size ?? theme.size.icon;
  return (
    <Svg
      width={iconSize}
      height={iconSize}
      viewBox="0 0 24 24"
      fill="none"
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Path
        d={ICON_PATHS[name]}
        stroke={color ?? theme.colors.textSecondary}
        strokeWidth={strokeWidth ?? theme.layout.iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export default Icon;
