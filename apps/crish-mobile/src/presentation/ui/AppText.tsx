// 文本原子：统一字阶与语义色。页面禁止直接写 fontSize / fontWeight / color。
// 系统字体缩放上限 1.35：应用内字号设置（fontScale，最高 ×1.25）与系统缩放是
// 两条独立乘算链，叠乘会把字阶推入布局溢出区；此处只封系统链上限（指南 XL 档
// 口径），应用内设置不受影响，单组件可显式传 maxFontSizeMultiplier 覆盖。
import {
  Text,
  type StyleProp,
  type TextProps,
  type TextStyle,
} from 'react-native';
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
  style?: StyleProp<TextStyle>;
}

export function AppText({
  variant = 'body',
  color = 'textPrimary',
  style,
  children,
  maxFontSizeMultiplier = 1.35,
  ...rest
}: AppTextProps) {
  const theme = useTheme();
  return (
    <Text
      {...rest}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[theme.type[variant], { color: theme.colors[color] }, style]}
    >
      {children}
    </Text>
  );
}

export default AppText;
