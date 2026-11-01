// 确认弹窗：真实 Modal；标题 + 可选正文 + 横向动作（原型 modal-dialog 口径）。
// 遮罩（J10）：静止全屏层、只做 opacity 过渡（强档 scrimStrong，iOS 叠 BlurView
// 复现原型 blur(2px)）；卡片单独入场——translateY(12) + 淡入、0.26s emphasized，
// 遮罩不随卡片移动。面板（J7）：iOS 半透明强档，Android 实色兜底。
import { useEffect, type ReactNode } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Button, { type ButtonVariant } from './Button';

export interface DialogAction {
  label: string;
  variant: ButtonVariant;
  onPress: () => void;
  testID?: string;
}

export interface DialogProps {
  visible: boolean;
  title: string;
  description?: string;
  /** 标题/正文与动作行之间的内容槽（G3：输入型弹窗放表单控件） */
  children?: ReactNode;
  actions: readonly DialogAction[];
  onDismiss: () => void;
  testID?: string;
}

/** 原型遮罩 blur(2px) 在 expo-blur 强度标尺上的近似档（与 Sheet 同值） */
const BACKDROP_BLUR_INTENSITY = 16;

export function Dialog({
  visible,
  title,
  description,
  children,
  actions,
  onDismiss,
  testID,
}: DialogProps) {
  const theme = useTheme();
  const entry = useSharedValue(0);
  // 曲线同 Sheet 口径：withTiming 默认曲线（Easing 在本仓 jest mock 不可用），时长按原型 0.26s 档。

  useEffect(() => {
    if (visible) {
      entry.value = 0;
      entry.value = withTiming(1, {
        duration: theme.motion.duration.settle,
      });
    }
  }, [visible]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: entry.value,
    transform: [{ translateY: (1 - entry.value) * 12 }],
  }));

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <View style={[styles.overlay, { padding: theme.space.xxl }]}>
        {/* 静止遮罩层：全屏固定，只动 opacity */}
        <Animated.View
          entering={FadeIn.duration(theme.motion.duration.normal)}
          style={StyleSheet.absoluteFill}
        >
          {Platform.OS === 'ios' ? (
            <BlurView
              intensity={BACKDROP_BLUR_INTENSITY}
              tint={theme.dark ? 'dark' : 'light'}
              style={StyleSheet.absoluteFill}
            />
          ) : null}
          <Pressable
            testID="dialog-backdrop"
            accessibilityRole="button"
            accessibilityLabel="关闭"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: theme.colors.scrimStrong },
            ]}
            onPress={onDismiss}
          />
        </Animated.View>
        <Animated.View
          testID={testID ?? 'dialog'}
          accessibilityViewIsModal
          style={[
            styles.card,
            {
              maxWidth: theme.layout.dialogMaxWidth,
              borderRadius: theme.radius.dialog,
              paddingTop: theme.space.xxl,
              paddingHorizontal: theme.space.xl + theme.space.xxs,
              paddingBottom: theme.space.xl,
              gap: theme.space.lg,
              backgroundColor:
                Platform.OS === 'ios'
                  ? theme.colors.surfaceTranslucentStrong
                  : theme.colors.surfaceRaised,
              overflow: 'hidden',
            },
            theme.shadow.lg,
            cardStyle,
          ]}
        >
          <AppText variant="title2">{title}</AppText>
          {description ? (
            <AppText variant="footnote" color="textSecondary">
              {description}
            </AppText>
          ) : null}
          {children}
          <View
            style={[styles.actions, { gap: theme.space.sm + theme.space.xxs }]}
          >
            {actions.map((action) => (
              <Button
                key={action.label}
                label={action.label}
                variant={action.variant}
                size="compact"
                onPress={action.onPress}
                testID={action.testID}
                style={styles.action}
              />
            ))}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '100%',
  },
  actions: {
    flexDirection: 'row',
  },
  action: {
    flex: 1,
  },
});

export default Dialog;
