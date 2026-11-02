// 底部 Sheet：真实 Modal + 安全区 + 遮罩 / Android 返回关闭。
// 遮罩（J10，用户点名）：静止全屏层、只做 opacity 过渡（iOS 叠 BlurView 复现原型
// backdrop blur(2px)）；面板单独 translateY 滑入/滑出——动画全程看不到遮罩边缘移动。
// 面板（J7）：iOS 半透明强档覆于已模糊的遮罩之上成通透感；Android 无真模糊，
// 走实色兜底（同 account GlassBackdrop 先例）。阴影为上向 sheetUp（原型口径）。
// 关闭钮（J10）：30 圆盘、极淡底、× 用弱色细线（Icon 默认 1.8 线宽），不抢眼。
// 拖拽关闭（手感基建批，交互审计 D1）：把手名实归一——面板 Pan 手势跟手位移、
// 释放按距离（≥30% 面板高）或速度（≥800dp/s）判定，速度播种弹簧收尾；拖拽中
// 遮罩 opacity 随面板进度联动（遮罩层本身不位移，守 J10）。内容已滚动时纵向
// 拖动归 ScrollView，滚回顶部后的下滑才接管面板（manualActivation 仲裁）。
// 减动效（手感基建批）：系统 Reduce Motion 开启时手势禁用，面板位移塌缩为
// opacity 交叉淡化（共享信号 useReducedMotion）。
import { useEffect, useState, type ReactNode } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { useReducedMotion } from '@/adapters/platform/useReducedMotion';
import { haptics } from '@/adapters/platform/haptics';
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

/** 手势关闭速度阈值（dp/s：下滑快甩即关，不论距离） */
export const SHEET_CLOSE_VELOCITY_Y = 800;
/** 手势关闭距离阈值（拖动距离占面板高比例） */
export const SHEET_CLOSE_FRACTION = 0.3;
/** 手势认领的纵向意图阈值（dp：小于此值不与点击/滚动抢手势） */
const SHEET_DRAG_ACTIVATION_DY = 10;

/**
 * 手势释放判定（纯函数，显式 worklet；单测共用同一真理）：
 * 下滑距离过阈（draggedFraction = 已拖距离 / 面板高）或下滑速度过阈 → 关闭。
 */
export function sheetDragCloseDecision(
  draggedFraction: number,
  velocityY: number
): boolean {
  'worklet';
  return (
    draggedFraction >= SHEET_CLOSE_FRACTION ||
    velocityY >= SHEET_CLOSE_VELOCITY_Y
  );
}

/**
 * 面板纵向位移（纯函数，显式 worklet）：展开进度 0 → 整块藏于屏外，1 → 归位。
 * 面板高度未测得（首帧 onLayout 未回）时以窗口高度兜底。
 *
 * ⚠️ worklet 内禁止调用 JS 线程模块对象的方法（如 Dimensions.get）：这类对象
 * 被克隆进 worklet 运行时后方法即丢失，调用抛 TypeError: undefined is not a
 * function 并以 CppException 杀死进程（2026-11-01 真机崩溃根因，logcat 签名
 * SheetTsx → useAnimatedStyle → mapperRun）。窗口高度必须在 JS 线程经
 * useWindowDimensions 取得、以纯数字形态捕获进 worklet——本函数只收数字。
 * 防再发守卫：src/__tests__/workletSafety.guard.test.ts。
 */
export function sheetPanelTranslateY(
  progress: number,
  panelHeight: number,
  windowHeight: number
): number {
  'worklet';
  return (1 - progress) * (panelHeight > 0 ? panelHeight : windowHeight);
}

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
  const reduceMotion = useReducedMotion();
  // 窗口高度在 JS 线程取得（纯数字），供 panelStyle worklet 捕获——见 sheetPanelTranslateY 注释
  const { height: windowHeight } = useWindowDimensions();
  // 关闭时先播出场动画再卸载 Modal（进场则立即挂载）
  const [mounted, setMounted] = useState(visible);
  const [panelHeight, setPanelHeight] = useState(0);
  const backdropProgress = useSharedValue(0);
  const panelProgress = useSharedValue(0);
  // 拖拽状态（UI 线程）：内容滚动偏移（>0 时纵向拖动归滚动）、抓手起始进度、
  // 起始触点纵坐标、释放判定是否已由 onEnd 处理（onFinalize 兜底回位用）
  const scrollOffset = useSharedValue(0);
  const dragStartProgress = useSharedValue(1);
  const dragStartY = useSharedValue(0);
  const dragEndHandled = useSharedValue(false);
  // 弹簧参数在渲染期取成普通对象（数字字段），供手势 worklet 捕获
  const sheetSpring = theme.motion.spring.sheet;
  // 曲线说明：原型为 emphasized 定时曲线；reanimated 的 Easing 在本仓 jest mock
  // 中不可用且全仓无消费先例，故 withTiming 用默认曲线，时长按原型档落值。
  // 减动效时程式化开合改走 fast 档交叉淡化（150ms），与 panelStyle 的塌缩配套。

  useEffect(() => {
    if (visible) {
      setMounted(true);
      backdropProgress.value = withTiming(1, {
        duration: reduceMotion
          ? theme.motion.duration.fast
          : theme.motion.duration.settle,
      });
      panelProgress.value = withTiming(1, {
        duration: reduceMotion
          ? theme.motion.duration.fast
          : theme.motion.duration.expand,
      });
      return;
    }
    if (!mounted) return;
    backdropProgress.value = withTiming(0, {
      duration: reduceMotion
        ? theme.motion.duration.fast
        : theme.motion.duration.normal,
    });
    panelProgress.value = withTiming(
      0,
      {
        duration: reduceMotion
          ? theme.motion.duration.fast
          : theme.motion.duration.sheet,
      },
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
  const panelStyle = useAnimatedStyle(() => {
    // 减动效：位移塌缩为交叉淡化（进度只驱动 opacity，面板不位移）
    if (reduceMotion) {
      return {
        opacity: panelProgress.value,
        transform: [{ translateY: 0 }],
      };
    }
    return {
      transform: [
        {
          translateY: sheetPanelTranslateY(
            panelProgress.value,
            panelHeight,
            windowHeight
          ),
        },
      ],
    };
  }, [panelHeight, windowHeight, reduceMotion]);

  // 手势吸附关闭的 JS 侧收尾：触感与关闭回调同帧（门面纪律）
  const notifyGestureClose = () => {
    haptics.snap();
    onClose();
  };

  // 面板拖拽（manualActivation 仲裁，同抽屉先例）：内容已滚动时下滑归滚动、
  // 上滑恒归滚动；仅「内容在顶 + 明确下滑」时认领。跟手直接写 panelProgress
  // （复用既有进度体系，遮罩 opacity 同值联动、遮罩层不位移）。
  const panGesture = Gesture.Pan()
    .manualActivation(true)
    .enabled(visible && !reduceMotion)
    .onTouchesDown((event) => {
      const touch = event.allTouches[0];
      if (touch) dragStartY.value = touch.absoluteY;
      dragEndHandled.value = false;
    })
    .onTouchesMove((event, stateManager) => {
      const touch = event.allTouches[0];
      if (!touch) return;
      const dy = touch.absoluteY - dragStartY.value;
      if (dy > SHEET_DRAG_ACTIVATION_DY && scrollOffset.value <= 0) {
        stateManager.activate();
      } else if (dy < -SHEET_DRAG_ACTIVATION_DY || scrollOffset.value > 0) {
        stateManager.fail();
      }
    })
    .onStart(() => {
      dragStartProgress.value = panelProgress.value;
    })
    .onUpdate((event) => {
      const height = panelHeight > 0 ? panelHeight : windowHeight;
      const next = dragStartProgress.value - event.translationY / (height || 1);
      const clamped = Math.min(Math.max(next, 0), 1);
      panelProgress.value = clamped;
      backdropProgress.value = clamped;
    })
    .onEnd((event) => {
      dragEndHandled.value = true;
      const height = panelHeight > 0 ? panelHeight : windowHeight;
      // 速度换算为进度/秒（下滑为正 → 进度速度为负），播种进弹簧
      const velocity = -event.velocityY / (height || 1);
      const draggedFraction = dragStartProgress.value - panelProgress.value;
      if (sheetDragCloseDecision(draggedFraction, event.velocityY)) {
        panelProgress.value = withSpring(
          0,
          { ...sheetSpring, velocity },
          (finished) => {
            if (finished) runOnJS(notifyGestureClose)();
          }
        );
        backdropProgress.value = withSpring(0, { ...sheetSpring, velocity });
      } else {
        panelProgress.value = withSpring(1, { ...sheetSpring, velocity });
        backdropProgress.value = withSpring(1, { ...sheetSpring, velocity });
      }
    })
    .onFinalize(() => {
      // 手势被系统取消且 onEnd 未达：回位到展开态，不留半开面板
      if (dragEndHandled.value) return;
      if (panelProgress.value > 0 && panelProgress.value < 1) {
        panelProgress.value = withSpring(1, { ...sheetSpring });
        backdropProgress.value = withSpring(1, { ...sheetSpring });
      }
    });

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* 手势根须在 Modal 内再挂一层：Android 的 Modal 是独立窗口，不在应用
          根 GestureHandlerRootView 的命中域内（RNGH 口径） */}
      <GestureHandlerRootView style={styles.flex}>
        {/* 库版 KAV：edge-to-edge 下 Android 亦真避让（RN 内置版恒 no-op，
            键盘审计 §一）；当前 Sheet 无内嵌输入，此为未来 Sheet 内输入的机制铺垫 */}
        <KeyboardAvoidingView style={styles.flex} behavior="padding">
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
            <GestureDetector gesture={panGesture}>
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
                          width: theme.size.sheetClose,
                          height: theme.size.sheetClose,
                          // 圆盘圆角 = 直径/2 实值（圆形按钮定案，禁用 pill 9999）
                          borderRadius: theme.size.sheetClose / 2,
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
                  scrollEventThrottle={16}
                  onScroll={(event) => {
                    scrollOffset.value = event.nativeEvent.contentOffset.y;
                  }}
                >
                  {children}
                </ScrollView>
                {footer ? (
                  <View style={{ paddingTop: theme.space.md }}>{footer}</View>
                ) : null}
              </Animated.View>
            </GestureDetector>
          </View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
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
