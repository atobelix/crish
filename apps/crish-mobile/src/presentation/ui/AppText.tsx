// 文本原子：统一字阶与语义色。页面禁止直接写 fontSize / fontWeight / color。
import { Text, type TextProps, type TextStyle } from 'react-native';
import {
  useTheme,
  type ThemeColors,
  type ThemeType,
} from '@/adapters/platform/theme';

export type TextVariant = keyof ThemeType;
export type TextColor = keyof ThemeColors;

export interface AppTextProps extends TextProps {
  variant?: TextVariant;
  color?: TextColor;
  /** 覆盖单次样式（仅限极端场景，如终端等宽行） */
  style?: TextStyle | TextStyle[];
}

export function AppText({
  variant = 'body',
  color = 'textPrimary',
  style,
  children,
  ...rest
}: AppTextProps) {
  const theme = useTheme();
  return (
    <Text
      {...rest}
      style={[theme.type[variant], { color: theme.colors[color] }, style]}
    >
      {children}
    </Text>
  );
}

export default AppText;
