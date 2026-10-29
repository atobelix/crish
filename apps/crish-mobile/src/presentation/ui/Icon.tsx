// 图标唯一入口：与桌面端同源（Hugeicons core-free-icons + React Native 渲染）。
// 业务只写语义 IconName，不直接 import 图标库；图标数据按需逐文件加载。
import { HugeiconsIcon } from '@hugeicons/react-native';
import { useTheme } from '@/adapters/platform/theme';
import { ICON_DATA, type IconName } from './iconData';

export type { IconName };

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export function Icon({ name, size, color, strokeWidth = 2 }: IconProps) {
  const theme = useTheme();
  return (
    <HugeiconsIcon
      icon={ICON_DATA[name]}
      size={size ?? theme.size.icon}
      color={color ?? theme.colors.textSecondary}
      strokeWidth={strokeWidth}
    />
  );
}

export default Icon;
