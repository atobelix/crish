// 底部 Sheet：真实 Modal + 安全区 + 遮罩 / Android 返回关闭。
// 遮罩（J10，用户点名）：静止全屏层、只做 opacity 过渡（iOS 叠 BlurView 复现原型
// backdrop blur(2px)）；面板单独 translateY 滑入/滑出——动画全程看不到遮罩边缘移动。
// 面板（J7）：iOS 半透明强档覆于已模糊的遮罩之上成通透感；Android 无真模糊，
// 走实色兜底（同 account GlassBackdrop 先例）。阴影为上向 sheetUp（原型口径）。
// 关闭钮（J10）：30 圆盘、极淡底、× 用弱色细线（Icon 默认 1.8 线宽），不抢眼。
import { useEffect, useState, type ReactNode } from 'react';
import {
  Dimensions,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Icon from './Icon';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** 固定在底部的内容（如主按钮） */
  footer?: ReactNode;
  /** 内容最大高度比例（默认 0.85） */
  maxHeightRatio?: number;
  testID?: string;
}

/** 原型遮罩 blur(2px) 在 expo-blur 强度标尺上的近似档 */
const BACKDROP_BLUR_INTENSITY = 16;

export function Sheet({
  visible,
  onClose,
  title,
  children,
  footer,
  maxHeightRatio = 0.85,
  testID,
}: SheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // 关闭时先播出场动画再卸载 Modal（进场则立即挂载）
  const [mounted, setMounted] = useState(visible);
  const [panelHeight, setPanelHeight] = useState(0);
  const backdropProgress = useSharedValue(0);
  const panelProgress = useSharedValue(0);
  // 曲线说明：原型为 emphasized 定时曲线；reanimated 的 Easing 在本仓 jest mock
  // 中不可用且全仓无消费先例，故 withTiming 用默认曲线，时长按原型档落值。

  useEffect(() => {
    if (visible) {
      setMounted(true);
      backdropProgress.value = withTiming(1, {
        duration: theme.motion.duration.settle,
      });
      panelProgress.value = withTiming(1, {
        duration: theme.motion.duration.expand,
      });
      return;
    }
    if (!mounted) return;
    backdropProgress.value = withTiming(0, {
      duration: theme.motion.duration.normal,
    });
    panelProgress.value = withTiming(
      0,
      { duration: theme.motion.duration.sheet },
      (finished) => {
        if (finished) runOnJS(setMounted)(false);
      }
    );
    // 兜底卸载：动画被打断/测试环境回调不达时不留挂载
    const timer = setTimeout(() => setMounted(false), 300);
    return () => clearTimeout(timer);
  }, [visible]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropProgress.value,
  }));
  const panelStyle = useAnimatedStyle(
    () => ({
      transform: [
        {
          translateY:
            (1 - panelProgress.value) *
            (panelHeight > 0 ? panelHeight : Dimensions.get('window').height),
        },
      ],
    }),
    [panelHeight]
  );

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.overlay}>
          {/* 静止遮罩层：全屏固定，只动 opacity */}
          <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
            {Platform.OS === 'ios' ? (
              <BlurView
                intensity={BACKDROP_BLUR_INTENSITY}
                tint={theme.dark ? 'dark' : 'light'}
                style={StyleSheet.absoluteFill}
              />
            ) : null}
            <Pressable
              testID="sheet-backdrop"
              accessibilityRole="button"
              accessibilityLabel="关闭"
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: theme.colors.scrim },
              ]}
              onPress={onClose}
            />
          </Animated.View>
          <Animated.View
            testID={testID}
            onLayout={(event) =>
              setPanelHeight(event.nativeEvent.layout.height)
            }
            style={[
              {
                borderTopLeftRadius: theme.radius.sheet,
                borderTopRightRadius: theme.radius.sheet,
                backgroundColor:
                  Platform.OS === 'ios'
                    ? theme.colors.surfaceTranslucentStrong
                    : theme.colors.surfaceRaised,
                maxHeight: `${Math.round(maxHeightRatio * 100)}%`,
                paddingTop: theme.space.sm,
                paddingHorizontal: theme.space.lg + theme.space.xxs,
                paddingBottom: Math.max(insets.bottom, theme.space.xxl),
                overflow: 'hidden',
              },
              theme.shadow.sheetUp,
              panelStyle,
            ]}
          >
            <View
              style={[
                styles.handle,
                {
                  width: theme.size.sheetHandleWidth,
                  height: theme.size.sheetHandleHeight,
                  borderRadius: theme.radius.pill,
                  marginTop: theme.space.xs,
                  marginBottom: theme.space.md + theme.space.xxs,
                  // 原型 rgba(0,0,0,0.14)；深色等值反转为白 alpha（无对应 token，经 M4 裁决直给）
                  backgroundColor: theme.dark
                    ? 'rgba(255,255,255,0.14)'
                    : 'rgba(0,0,0,0.14)',
                },
              ]}
            />
            {title ? (
              <View
                style={[
                  styles.header,
                  {
                    paddingHorizontal: theme.space.xxs,
                    marginBottom: theme.space.lg,
                  },
                ]}
              >
                <AppText
                  variant="headline"
                  style={styles.title}
                  numberOfLines={1}
                >
                  {title}
                </AppText>
                <Pressable
                  testID="sheet-close"
                  accessibilityRole="button"
                  accessibilityLabel="关闭"
                  onPress={onClose}
                  hitSlop={theme.space.sm}
                  style={({ pressed }) => [
                    styles.close,
                    {
                      width: 30,
                      height: 30,
                      borderRadius: theme.radius.pill,
                      backgroundColor: pressed
                        ? theme.colors.fillPressed
                        : theme.colors.fillSubtle,
                    },
                  ]}
                >
                  <Icon
                    name="x"
                    size={theme.size.iconSmall}
                    color={theme.colors.textTertiary}
                  />
                </Pressable>
              </View>
            ) : null}
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={{ paddingBottom: theme.space.xs }}
              keyboardShouldPersistTaps="handled"
            >
              {children}
            </ScrollView>
            {footer ? (
              <View style={{ paddingTop: theme.space.md }}>{footer}</View>
            ) : null}
          </Animated.View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  handle: {
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    flex: 1,
  },
  close: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    flexGrow: 0,
  },
});

export default Sheet;
