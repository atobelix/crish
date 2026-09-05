import {
  Pressable,
  Text,
  StyleSheet,
  Platform,
  StyleProp,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { dualHitSlop } from './hitTargets';

export interface HeaderBackButtonProps {
  onPress: () => void;
  label?: string;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
}

export function HeaderBackButton({
  onPress,
  label = '‹',
  testID = 'header-back',
  accessibilityLabel = '返回上一页',
  style,
  labelStyle,
}: HeaderBackButtonProps) {
  const theme = useTheme();

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={dualHitSlop(44, 44)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { opacity: pressed ? 0.7 : 1 },
        style,
      ]}
    >
      <Text style={[styles.glyph, { color: theme.textPrimary }, labelStyle]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    ...Platform.select({
      android: {
        minHeight: 48,
        minWidth: 48,
      },
    }),
  },
  glyph: {
    fontSize: 28,
    lineHeight: 30,
    fontWeight: '300',
  },
});

export default HeaderBackButton;
