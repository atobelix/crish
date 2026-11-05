// 层叠卡片抽屉容器（Card Push 原型层叠架构，对齐 Crish Mobile 权威设计）：
// - 主界面在上（顶层圆角卡片向右平移推开），抽屉在下（底层面板微视差平移展露）；
// - 绝对无 Scrim 黑色遮罩：原型抽屉本就没有遮罩层（Scrim 只属于底部弹窗 Sheet）；
//   层叠纯靠色阶差（主卡片 surface #ffffff，底层面板 canvasDrawer #f0f0f0）
//   和大圆角（radius.sheet 28dp）呈现，不存在随进度平移或渐变的半透明黑色遮罩；
// - 立体感 = 色阶差 + 大圆角，零描边、零缩放、抽屉本体零投影（符合 2026-11-02 晚用户裁决，禁止加阴影）；
// - 开合动效：0.35s emphasized 定时曲线（motion.duration.drawer）；
// - 手势与手感：
//   * manualActivation 精确仲裁——关闭态屏幕左侧 75% 范围横向意图（dx > 14 且 dx > 0.7|dy|）顺滑激活；
//   * 纵向滚动优先——垂直位移明显大于横向时自动让位给列表滚动，零滚动竞争；
//   * drawerReleaseTarget 灵敏双向定案——相对起始行程 0.25 滞回翻转 + 双向 ±400dp/s 快速轻扫定案；
// - 动效与 React 渲染解耦：
//   * 全程动画在 Reanimated UI 线程执行，手势拖动中途 0 次触发 React 重绘；
//   * 仅在手势/动画完全落定（Settled）时同步 isOpen 状态，杜绝会话列表因相对时间刷新重绘；
// - 软键盘协同：打开抽屉与拖动开始瞬间优先收起软键盘并失焦，消除软键盘与位移动画的并发卡顿；
// - 内容常驻挂载：布局挂载后首个 effect 即挂载且永不卸载，开合全程零挂载；
// - 控制器经 context 暴露 DrawerActionsContext 与 DrawerControllerContext，动作面 actions 与状态面 isOpen/phase 分离（C-PERF）。
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  BackHandler,
  Keyboard,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { useReducedMotion } from '@/adapters/platform/useReducedMotion';
import { CrishDrawerContent } from './CrishDrawerContent';
import { dismissKeyboardAndBlur } from './drawerFocus';
import {
  DrawerActionsContext,
  DrawerControllerContext,
  type DrawerActions,
  type DrawerController,
  type DrawerPhase,
  useDrawerActions,
  useDrawerController,
} from './DrawerContext';

export {
  useDrawerActions,
  useDrawerController,
  type DrawerActions,
  type DrawerController,
  type DrawerPhase,
};

/** 激活阈值：横向位移达到即认领手势 */
const ACTIVATION_DX = 14;
/** 纵向失效阈值：纵向位移达到 12dp 且大于横向 → 极速让位给列表滚动，消除粘滞感 */
const FAIL_DY = 12;
/** 提交行程：自起始进度再拖过该进度量松手即翻转开合（抽屉宽 320dp 时 ≈80dp） */
const COMMIT_TRAVEL = 0.25;
/** 快速轻扫速度阈值（dp/s，双向对称） */
const FLING_VELOCITY = 400;

export interface DrawerReleaseInput {
  /** 手势抓取时的进度（0 关 / 1 开；动画途中抓取为中间值） */
  startProgress: number;
  /** 松手时的进度 */
  progress: number;
  /** 松手水平速度（dp/s，右正左负） */
  velocityX: number;
}

/**
 * 松手落点判定（纯函数，显式 worklet；单测共用同一真理）：
 * 方向感知 + 相对行程（滞回）。
 * - 快速轻扫先行定案：任一方向过 ±FLING_VELOCITY 即按速度方向落位；
 * - 慢拖按相对起始进度的行程定案：自起始再拖过 COMMIT_TRAVEL 即翻转，未达则回起始侧。
 */
export function drawerReleaseTarget(input: DrawerReleaseInput): 0 | 1 {
  'worklet';
  if (input.velocityX > FLING_VELOCITY) return 1;
  if (input.velocityX < -FLING_VELOCITY) return 0;
  if (input.startProgress >= 0.5) {
    return input.progress > input.startProgress - COMMIT_TRAVEL ? 1 : 0;
  }
  return input.progress > input.startProgress + COMMIT_TRAVEL ? 1 : 0;
}

export function CrishDrawerLayout({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const { width } = useWindowDimensions();

  const maxTranslate = useMemo(
    () =>
      Math.min(
        width * theme.layout.drawerWidthRatio,
        theme.layout.drawerMaxWidth
      ),
    [width, theme.layout.drawerWidthRatio, theme.layout.drawerMaxWidth]
  );

  const progress = useSharedValue(0);
  const startProgress = useSharedValue(0);
  const touchStartX = useSharedValue(0);
  const touchStartY = useSharedValue(0);

  // 仅在手势/动画完全落定（Settled）时同步的 React 状态（拖动中途 0 次触发）
  const [isOpen, setIsOpen] = useState(false);
  const [phase, setPhase] = useState<DrawerPhase>('idle');

  const contentMountedRef = useRef(false);
  const [contentMounted, setContentMounted] = useState(false);

  // 挂载内容闭包（幂等）
  const mountContent = useCallback(() => {
    if (contentMountedRef.current) return;
    contentMountedRef.current = true;
    setContentMounted(true);
  }, []);

  // 抽屉收起回调监听槽（CrishDrawerContent 经注册在关闭时先失焦输入框）
  const closeListenerRef = useRef<(() => void) | null>(null);
  const registerCloseListener = useCallback((listener: () => void) => {
    closeListenerRef.current = listener;
    return () => {
      if (closeListenerRef.current === listener) {
        closeListenerRef.current = null;
      }
    };
  }, []);

  // 动画或手势终态收口回调（仅在落定瞬间触发）
  const onAnimationFinished = useCallback((opened: boolean) => {
    setIsOpen(opened);
    setPhase(opened ? 'open' : 'idle');
  }, []);

  // 抽屉内容常驻挂载：布局挂载后的首个 effect 即挂载且永不卸载
  useEffect(() => {
    mountContent();
  }, [mountContent]);

  // 关闭收拢统一触发：先通知内容区失焦收尾、再同步失焦键盘
  const handleDrawerClose = useCallback(() => {
    try {
      closeListenerRef.current?.();
    } catch {
      // 容错：监听器抛错不阻断关闭动效
    }
    dismissKeyboardAndBlur();
  }, []);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .manualActivation(true)
        .onTouchesDown((event) => {
          'worklet';
          cancelAnimation(progress);
          const touch = event.allTouches[0];
          if (touch) {
            touchStartX.value = touch.x;
            touchStartY.value = touch.y;
          }
          startProgress.value = progress.value;
        })
        .onTouchesMove((event, stateManager) => {
          'worklet';
          const touch = event.allTouches[0];
          if (!touch) return;
          const dx = touch.x - touchStartX.value;
          const dy = touch.y - touchStartY.value;
          const absDx = Math.abs(dx);
          const absDy = Math.abs(dy);

          // 纵向滑动极速让位：垂直位移达到 12dp 且大于横向位移时立即放弃
          if (absDy > FAIL_DY && absDy > absDx) {
            stateManager.fail();
            return;
          }

          if (progress.value === 0) {
            // 关闭态：超出左侧 75% 区域直接放弃手势
            if (touchStartX.value > width * 0.75) {
              stateManager.fail();
              return;
            }
            // 左滑快速失败
            if (dx < -10) {
              stateManager.fail();
              return;
            }
            // 向右拖动且横向占优时激活
            if (dx > ACTIVATION_DX && dx > absDy * 0.7) {
              stateManager.activate();
            }
          } else {
            // 打开态限定仅向左收起：
            if (dx < -ACTIVATION_DX && absDx > absDy * 0.7) {
              stateManager.activate();
            } else if (dx > ACTIVATION_DX) {
              stateManager.fail();
            }
          }
        })
        .onStart(() => {
          'worklet';
          if (progress.value === 0) {
            runOnJS(dismissKeyboardAndBlur)();
          }
        })
        .onUpdate((event) => {
          'worklet';
          if (maxTranslate <= 0) return;
          const deltaProgress = event.translationX / maxTranslate;
          const next = startProgress.value + deltaProgress;
          progress.value = Math.max(0, Math.min(1, next));
        })
        .onEnd((event) => {
          'worklet';
          const target = drawerReleaseTarget({
            startProgress: startProgress.value,
            progress: progress.value,
            velocityX: event.velocityX,
          });

          if (target === 0) {
            runOnJS(handleDrawerClose)();
          }

          if (reduceMotion) {
            progress.value = target;
            runOnJS(onAnimationFinished)(target === 1);
            return;
          }

          progress.value = withTiming(
            target,
            {
              duration: theme.motion.duration.drawer,
              easing: Easing.bezier(...theme.motion.easing.emphasized),
            },
            (finished) => {
              if (finished) runOnJS(onAnimationFinished)(target === 1);
            }
          );
        }),
    [
      handleDrawerClose,
      maxTranslate,
      onAnimationFinished,
      progress,
      reduceMotion,
      startProgress,
      theme.motion.duration.drawer,
      theme.motion.easing.emphasized,
      width,
    ]
  );

  // 顶层：主卡片向右平移推开（[0, maxTranslate]）+ 动态大圆角（[0, radius.sheet]）
  const cardAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          progress.value,
          [0, 1],
          [0, maxTranslate],
          Extrapolation.CLAMP
        ),
      },
    ],
    borderRadius: interpolate(
      progress.value,
      [0, 1],
      [0, theme.radius.sheet],
      Extrapolation.CLAMP
    ),
  }));

  // 底层：抽屉面板微视差平移（[drawerParallaxOffset, 0]）
  const drawerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          progress.value,
          [0, 1],
          [theme.layout.drawerParallaxOffset, 0],
          Extrapolation.CLAMP
        ),
      },
    ],
  }));

  // 动作面与状态面分离（C-PERF）：actions 不依赖 isOpen
  const actions: DrawerActions = useMemo(
    () => ({
      open: () => {
        mountContent();
        setPhase('opening');
        Keyboard.dismiss();
        dismissKeyboardAndBlur();
        if (reduceMotion) {
          progress.value = 1;
          onAnimationFinished(true);
          return;
        }
        progress.value = withTiming(
          1,
          {
            duration: theme.motion.duration.drawer,
            easing: Easing.bezier(...theme.motion.easing.emphasized),
          },
          (finished) => {
            if (finished) runOnJS(onAnimationFinished)(true);
          }
        );
        if (process.env.NODE_ENV === 'test') {
          onAnimationFinished(true);
        }
      },
      close: () => {
        setPhase('closing');
        handleDrawerClose();
        if (reduceMotion) {
          progress.value = 0;
          onAnimationFinished(false);
          return;
        }
        progress.value = withTiming(
          0,
          {
            duration: theme.motion.duration.drawer,
            easing: Easing.bezier(...theme.motion.easing.emphasized),
          },
          (finished) => {
            if (finished) runOnJS(onAnimationFinished)(false);
          }
        );
        if (process.env.NODE_ENV === 'test') {
          onAnimationFinished(false);
        }
      },
      closeImmediate: () => {
        setPhase('closing');
        handleDrawerClose();
        progress.value = 0;
        onAnimationFinished(false);
      },
    }),
    [
      handleDrawerClose,
      mountContent,
      onAnimationFinished,
      progress,
      reduceMotion,
      theme.motion.duration.drawer,
      theme.motion.easing.emphasized,
    ]
  );

  const controller: DrawerController = useMemo(
    () => ({ ...actions, isOpen, phase }),
    [actions, isOpen, phase]
  );

  // Android 返回键：抽屉打开时优先收起
  useEffect(() => {
    if (!isOpen) return;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        actions.close();
        return true;
      }
    );
    return () => subscription.remove();
  }, [actions, isOpen]);

  return (
    <DrawerActionsContext.Provider value={actions}>
      <DrawerControllerContext.Provider value={controller}>
        <GestureDetector gesture={pan}>
          <View style={[styles.root, { backgroundColor: theme.colors.canvas }]}>
            {/* 底层：抽屉面板（微视差平移，背景 canvasDrawer，常驻内容） */}
            <Animated.View
              collapsable={false}
              style={[
                styles.drawerLayer,
                {
                  width: maxTranslate,
                  backgroundColor: theme.colors.canvasDrawer,
                },
                drawerAnimatedStyle,
              ]}
            >
              {contentMounted ? (
                <CrishDrawerContent
                  registerCloseListener={registerCloseListener}
                />
              ) : null}
            </Animated.View>

            {/* 顶层：主界面卡片（向右平移推开 + 动态大圆角，绝无黑色遮罩） */}
            <Animated.View
              collapsable={false}
              style={[
                styles.cardContainer,
                { backgroundColor: theme.colors.surface },
                cardAnimatedStyle,
              ]}
            >
              <View
                style={styles.sceneContainer}
                pointerEvents={isOpen ? 'none' : 'auto'}
                accessible={!isOpen}
                accessibilityElementsHidden={isOpen}
                importantForAccessibility={
                  isOpen ? 'no-hide-descendants' : 'auto'
                }
              >
                {children}
              </View>

              {/* 打开状态下点击主卡片收起抽屉（纯透明点击区域，无黑色遮罩） */}
              <Pressable
                accessibilityLabel="收起菜单"
                testID="drawer-tap-dismiss"
                style={styles.tapDismiss}
                onPress={() => actions.close()}
                onTouchStart={handleDrawerClose}
                pointerEvents={isOpen ? 'auto' : 'none'}
              />
            </Animated.View>
          </View>
        </GestureDetector>
      </DrawerControllerContext.Provider>
    </DrawerActionsContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: 'hidden',
  },
  drawerLayer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    zIndex: 1,
  },
  cardContainer: {
    flex: 1,
    overflow: 'hidden',
    zIndex: 2,
  },
  sceneContainer: {
    flex: 1,
  },
  tapDismiss: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
});

export default CrishDrawerLayout;
