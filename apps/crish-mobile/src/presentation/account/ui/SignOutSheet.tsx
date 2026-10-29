// 退出登录确认 sheet：遮罩 200ms 淡入，面板弹簧上滑（damping 28 / stiffness 300），顶部圆角 28。
// 面板为 glassSheet + BlurView 磨砂玻璃；不支持模糊或降低透明度时实色兜底。
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { AppText } from '@/presentation/ui';
import { AuthButton } from './AuthButton';
import { GlassBackdrop } from './GlassBackdrop';

export interface SignOutSheetProps {
  visible: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function SignOutSheet({
  visible,
  busy = false,
  onConfirm,
  onCancel,
}: SignOutSheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const scrim = useRef(new Animated.Value(0)).current;
  const panel = useRef(new Animated.Value(0)).current;
  const motion = theme.motion.account;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(scrim, {
          toValue: 1,
          duration: motion.scrim,
          useNativeDriver: true,
        }),
        Animated.spring(panel, {
          toValue: 1,
          ...motion.sheetSpring,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }
    Animated.parallel([
      Animated.timing(scrim, {
        toValue: 0,
        duration: motion.scrim,
        useNativeDriver: true,
      }),
      Animated.timing(panel, {
        toValue: 0,
        duration: motion.scrim,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [visible, scrim, panel, motion]);

  const translateY = panel.interpolate({
    inputRange: [0, 1],
    outputRange: [height, 0],
  });

  return (
    <Modal
      transparent
      visible={mounted}
      animationType="none"
      statusBarTranslucent
      onRequestClose={onCancel}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: theme.colors.scrim, opacity: scrim },
        ]}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="取消"
          testID="sign-out-scrim"
          onPress={onCancel}
        />
      </Animated.View>
      <Animated.View
        testID="sign-out-sheet"
        style={[
          styles.panel,
          {
            borderTopLeftRadius: theme.radius.sheet,
            borderTopRightRadius: theme.radius.sheet,
            paddingHorizontal: theme.layout.accountPageX,
            paddingTop: theme.space.sm,
            paddingBottom: insets.bottom + theme.space.lg,
            gap: theme.space.sm,
            transform: [{ translateY }],
          },
        ]}
      >
        <GlassBackdrop tone="glassSheet" />
        <View
          style={[
            styles.handle,
            {
              width: theme.size.sheetHandleWidth,
              height: theme.size.sheetHandleHeight,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.borderStrong,
              marginBottom: theme.space.lg,
            },
          ]}
        />
        <AppText variant="headline" color="textPrimary" style={styles.center}>
          退出登录？
        </AppText>
        <AppText
          variant="footnote"
          color="textSecondary"
          style={{ ...styles.center, marginBottom: theme.space.lg }}
        >
          退出后，这台设备需要重新登录才能使用账号。
        </AppText>
        <AuthButton
          label="退出登录"
          variant="secondary"
          danger
          loading={busy}
          testID="sign-out-confirm"
          onPress={onConfirm}
        />
        <AuthButton
          label="取消"
          variant="ghost"
          testID="sign-out-cancel"
          onPress={onCancel}
        />
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
  },
  handle: { alignSelf: 'center' },
  center: { textAlign: 'center' },
});

export default SignOutSheet;
