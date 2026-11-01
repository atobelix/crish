// 图标唯一入口（实现波总方案 G4 / N05 落地）：内联 SVG Path 渲染。
// 24 网格 / theme.layout.iconStroke 线宽 / 语义 token 染色；
// 业务只写语义 IconName（iconPaths.ts 单一真源），禁止直接 import 图标库。
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/adapters/platform/theme';
import { ICON_PATHS, SHARP_ICONS, type IconName } from './iconPaths';

export type { IconName };

/**
 * 按名线宽覆盖（原型口径：主档 1.8 之外，对号 2.2、加号/汉堡 2.0)。
 * 解析顺序：显式 strokeWidth prop > 本表 > theme.layout.iconStroke。
 */
const STROKE_WIDTH_BY_NAME: Partial<Record<IconName, number>> = {
  check: 2.2,
  add: 2,
  menu: 2,
};

export interface IconProps {
  name: IconName;
  /** 只允许 theme.size.icon* 阶梯（16/20/24），禁止裸数字 */
  size?: number;
  /** 语义 token 色值（缺省 textSecondary） */
  color?: string;
  /** 线宽覆盖（缺省按 STROKE_WIDTH_BY_NAME，再缺省 theme.layout.iconStroke = 1.8) */
  strokeWidth?: number;
}

export function Icon({ name, size, color, strokeWidth }: IconProps) {
  const theme = useTheme();
  const iconSize = size ?? theme.size.icon;
  // 几何直线折角图标（chevron/check）：miter 锐角 + butt 平端点，杜绝圆弧感
  const sharp = SHARP_ICONS.has(name);
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
        strokeWidth={
          strokeWidth ?? STROKE_WIDTH_BY_NAME[name] ?? theme.layout.iconStroke
        }
        strokeLinecap={sharp ? 'butt' : 'round'}
        strokeLinejoin={sharp ? 'miter' : 'round'}
      />
    </Svg>
  );
}

export default Icon;
