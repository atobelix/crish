// 确认弹窗：真实 Modal；标题 + 可选正文 + 横向动作（原型 modal-dialog 口径）。
// 遮罩（J10）：静止全屏层、只做 opacity 过渡（强档 scrimStrong，iOS 叠 BlurView
// 复现原型 blur(2px)）；卡片单独入场——translateY(12) + 淡入、0.26s emphasized，
// 遮罩不随卡片移动。面板（J7）：iOS 半透明强档，Android 实色兜底。
// 减动效（手感基建批）：系统 Reduce Motion 开启时卡片位移塌缩为纯 opacity
// 交叉淡化（共享信号 useReducedMotion）。
// 浮层阴影（容器外阴影批，2026-11-02；上限裁决同日晚修订）：卡片走
// SoftShadowSurface dialog 档（几何沿原型 .modal-dialog-card，α 收到按钮
// 档两层 0.008/0.012——阴影上限硬裁决），仅 Android 浅色渲染。
// 浮层纪律（批 D，2026-11-03）：打开期间登记覆盖层注册表，返回经
// onRequestClose 汇入栈顶裁决；dismissible=false（必须表态）时遮罩
// 点按与系统返回均失效，只能由 actions 落定。
import { useEffect, useId, type ReactNode } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { useTheme } from '@/adapters/platform/theme';
import { useReducedMotion } from '@/adapters/platform/useReducedMotion';
import AppText from './AppText';
import Button, { type ButtonVariant } from './Button';
import { SoftShadowSurface } from './SoftShadowSurface';
import { handleOverlayBackFor, useOverlayRegistration } from './overlayStack';

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
  /**
   * 可关闭性（默认 true）。false = 必须表态：遮罩点按与系统返回
   * 失效，只能点 actions 落定（批 D 浮层纪律）。
   */
  dismissible?: boolean;
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
  dismissible = true,
  testID,
}: DialogProps) {
  const theme = useTheme();
  const entry = useSharedValue(0);
  // 覆盖层登记（批 D）：visible 期间在栈，返回汇入栈顶裁决
  const generatedOverlayId = useId();
  const overlayId = testID ?? generatedOverlayId;
  useOverlayRegistration(overlayId, visible, {
    dismissible,
    onRequestClose: onDismiss,
  });
  // 曲线口径（浮层曲线统一批）：与 Sheet/抽屉同走 token emphasized 曲线
  // （Easing.bezier(...motion.easing.emphasized)；jest 环境由 jest.setup 的
  // reanimated 桩提供 Easing.bezier，M8 收口补桩），时长按原型 0.26s 档
  // （motion.duration.settle）。

  useEffect(() => {
    if (visible) {
      entry.value = 0;
      entry.value = withTiming(1, {
        duration: theme.motion.duration.settle,
        easing: Easing.bezier(...theme.motion.easing.emphasized),
      });
    }
  }, [visible]);

  const reduceMotion = useReducedMotion();
  const cardStyle = useAnimatedStyle(
    () => ({
      opacity: entry.value,
      // 减动效：只保留 opacity 交叉淡化，不位移
      transform: [{ translateY: reduceMotion ? 0 : (1 - entry.value) * 12 }],
    }),
    [reduceMotion]
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={() => {
        if (!handleOverlayBackFor(overlayId) && dismissible) onDismiss();
      }}
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
            accessibilityRole={dismissible ? 'button' : undefined}
            accessibilityLabel={dismissible ? '关闭' : undefined}
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: theme.colors.scrimStrong },
            ]}
            onPress={dismissible ? onDismiss : undefined}
          />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.card,
            {
              maxWidth: theme.layout.dialogMaxWidth,
            },
            cardStyle,
          ]}
        >
          {/* 浮层阴影（容器外阴影批，2026-11-02；上限裁决同日晚修订）：
              dialog 档（几何沿原型 .modal-dialog-card，α 恒按钮档），
              仅 Android 浅色渲染 */}
          <SoftShadowSurface
            testID={testID ?? 'dialog'}
            preset="dialog"
            borderRadius={theme.radius.dialog}
            fill={
              Platform.OS === 'ios'
                ? theme.colors.surfaceTranslucentStrong
                : theme.colors.surfaceRaised
            }
            fillStyle={{
              paddingTop: theme.space.xxl,
              paddingHorizontal: theme.space.xl + theme.space.xxs,
              paddingBottom: theme.space.xl,
              gap: theme.space.lg,
            }}
          >
            <AppText variant="title2">{title}</AppText>
            {description ? (
              <AppText variant="footnote" color="textSecondary">
                {description}
              </AppText>
            ) : null}
            {children}
            <View
              style={[
                styles.actions,
                { gap: theme.space.sm + theme.space.xxs },
              ]}
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
          </SoftShadowSurface>
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
