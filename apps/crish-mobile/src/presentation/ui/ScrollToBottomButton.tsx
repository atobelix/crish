// 回到底部悬浮按钮：仅在离开底部时出现。
import { Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Icon from './Icon';

export interface ScrollToBottomButtonProps {
  onPress: () => void;
  /** 底部偏移（Tab 页传 tabBar 高度 + 安全区；详情页默认 24） */
  bottomOffset?: number;
  testID?: string;
}

export function ScrollToBottomButton({
  onPress,
  bottomOffset,
  testID,
}: ScrollToBottomButtonProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel="回到底部"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { borderRadius: theme.radius.pill },
        {
          bottom: bottomOffset ?? insets.bottom + 24,
          backgroundColor: theme.colors.surfaceRaised,
          borderColor: theme.colors.hairline,
        },
        theme.shadow.sm,
        pressed && { opacity: 0.8 },
      ]}
    >
      <Icon
        name="chevron-down"
        size={theme.size.iconSmall}
        color={theme.colors.textPrimary}
      />
      <AppText variant="footnote" color="textPrimary">
        回到底部
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    position: 'absolute',
    alignSelf: 'center',
    minHeight: 36,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
});

export default ScrollToBottomButton;
