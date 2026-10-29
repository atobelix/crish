// 浮动返回圆钮（40）：v3 磨砂玻璃（glass + BlurView），不支持模糊时实色兜底。
import { Pressable, StyleSheet } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { Icon } from '@/presentation/ui';
import { GlassBackdrop } from './GlassBackdrop';

export interface GlassBackButtonProps {
  onPress: () => void;
  testID?: string;
}

export function GlassBackButton({
  onPress,
  testID = 'auth-back',
}: GlassBackButtonProps) {
  const theme = useTheme();
  const diameter = theme.size.iconButton;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="返回"
      testID={testID}
      onPress={onPress}
      hitSlop={theme.space.xs}
      style={({ pressed }) => [
        styles.circle,
        {
          width: diameter,
          height: diameter,
          borderRadius: diameter / 2,
          opacity: pressed ? theme.motion.pressOpacity : 1,
        },
      ]}
    >
      <GlassBackdrop tone="glass" />
      <Icon name="chevron-left" color={theme.colors.textPrimary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});

export default GlassBackButton;
