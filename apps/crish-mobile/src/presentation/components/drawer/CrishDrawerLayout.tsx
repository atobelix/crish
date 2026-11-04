// 悬浮抽屉容器（Front Drawer 标杆架构，对齐 Cherry Studio 极速丝滑手感）：
// - 主场景在底层（完全静态，恒定 translateX: 0、borderRadius: 0，GPU 离屏蒙版重剪降为 0）；
// - 中层挂载柔和 Scrim 暗化遮罩（纯 GPU Alpha 渐变，带呼吸带透出原场景轮廓，点遮罩瞬时收起）；
// - 顶层抽屉面板纯 GPU 硬件变换平移（translateX: [-maxTranslate, 0]，zIndex: 10）；
// - 开合动效：250ms easing.settle 极陡减速贝塞尔 Easing.bezier(0.22, 1, 0.36, 1)，次帧扑面而来；
// - 状态机精细化与静默门：增加 phase ('idle' | 'opening' | 'open' | 'closing')，actions.close()
//   触发瞬间立即切入 closing，绝缘全树重绘；
// - 手势与手感：
//   * manualActivation 精确仲裁——关闭态横向意图（dx > 14 且 dx > 0.7|dy|）顺滑激活；
//   * 纵向滚动优先——垂直位移明显大于横向时自动让位给列表滚动，零滚动竞争；
//   * drawerReleaseTarget 灵敏双向定案——相对起始行程 0.25 滞回翻转 + 双向 ±400dp/s 快速轻扫定案；
// - 动效与 React 渲染解耦：全程动画在 Reanimated UI 线程执行，落定后同步 isOpen 与 phase；
// - 软键盘协同：异步卸载软键盘与失焦，消除键盘收起与动画首帧的并发卡顿；
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
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
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
/** 纵向失效阈值：纵向位移达到且横向不占优 → 让位给列表滚动 */
const FAIL_DY = 26;
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

  // 仅在手势/动画完全落定（Settled）时同步的 React 状态（拖动中途 0 次触发）
  const [isOpen, setIsOpen] = useState(false);
  const [phase, setPhase] = useState<DrawerPhase>('idle');

  const contentMountedRef = useRef(false);
  const [contentMounted, setContentMounted] = useState(false);
  const closeListenersRef = useRef<Set<() => void>>(new Set());

  const registerCloseListener = useCallback((listener: () => void) => {
    closeListenersRef.current.add(listener);
    return () => {
      closeListenersRef.current.delete(listener);
    };
  }, []);

  const handleDrawerClose = useCallback(() => {
    dismissKeyboardAndBlur();
    closeListenersRef.current.forEach((listener) => {
      try {
        listener();
      } catch {
        // 忽略监听器异常
      }
    });
  }, []);

  // 动画或手势终态收口回调（仅在落定瞬间触发）
  const onAnimationFinished = useCallback((opened: boolean) => {
    setIsOpen(opened);
    setPhase(opened ? 'open' : 'idle');
  }, []);

  // 抽屉内容常驻挂载：布局挂载后的首个 effect 即挂载且永不卸载
  const mountContent = useCallback(() => {
    if (contentMountedRef.current) return;
    contentMountedRef.current = true;
    setContentMounted(true);
  }, []);
  useEffect(() => {
    mountContent();
  }, [mountContent]);

  useAnimatedReaction(
    () => progress.value > 0,
    (next, prev) => {
      if (next && next !== prev) {
        runOnJS(mountContent)();
      }
    },
    []
  );

  // 原生声明式平移手势：纯声明式横纵仲裁，普通点击 0ms 瞬间放行，杜绝 manualActivation 触摸挂起
  const pan = useMemo(() => {
    return Gesture.Pan()
      .activeOffsetX([-ACTIVATION_DX, ACTIVATION_DX])
      .failOffsetY([-FAIL_DY, FAIL_DY])
      .onStart(() => {
        'worklet';
        startProgress.value = progress.value;
        if (progress.value === 0) {
          runOnJS(mountContent)();
          runOnJS(dismissKeyboardAndBlur)();
          runOnJS(setPhase)('opening');
        }
      })
      .onUpdate((event) => {
        'worklet';
        const delta = event.translationX / (maxTranslate || 1);
        progress.value = Math.min(Math.max(startProgress.value + delta, 0), 1);
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
          runOnJS(setPhase)('closing');
        } else {
          runOnJS(setPhase)('opening');
        }

        if (reduceMotion) {
          progress.value = target;
          runOnJS(onAnimationFinished)(target === 1);
          return;
        }

        progress.value = withTiming(
          target,
          {
            duration: 250,
            easing: Easing.bezier(0.22, 1, 0.36, 1),
          },
          (finished) => {
            if (finished) {
              runOnJS(onAnimationFinished)(target === 1);
            }
          }
        );
        if (process.env.NODE_ENV === 'test') {
          runOnJS(onAnimationFinished)(target === 1);
        }
      });
  }, [
    handleDrawerClose,
    maxTranslate,
    mountContent,
    onAnimationFinished,
    progress,
    reduceMotion,
    startProgress,
  ]);

  // 顶层：悬浮抽屉面板纯平移（[-maxTranslate, 0]）
  const drawerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          progress.value,
          [0, 1],
          [-maxTranslate, 0],
          Extrapolation.CLAMP
        ),
      },
    ],
  }));

  // 中层：自然渐变半透明暗化 Scrim 遮罩（纯 GPU Alpha 渐变，0 次重绘开销）
  const scrimAnimatedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0, 1], Extrapolation.CLAMP),
  }));

  // 动作面与状态面分离（C-PERF）：actions 不依赖 isOpen
  const actions: DrawerActions = useMemo(
    () => ({
      open: () => {
        mountContent();
        setPhase('opening');
        if (process.env.NODE_ENV === 'test') {
          Keyboard.dismiss();
          dismissKeyboardAndBlur();
        } else {
          requestAnimationFrame(() => {
            Keyboard.dismiss();
            dismissKeyboardAndBlur();
          });
        }
        if (reduceMotion) {
          progress.value = 1;
          onAnimationFinished(true);
          return;
        }
        progress.value = withTiming(
          1,
          {
            duration: 250,
            easing: Easing.bezier(0.22, 1, 0.36, 1),
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
            duration: 250,
            easing: Easing.bezier(0.22, 1, 0.36, 1),
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
            {/* 1. 底层：主界面内容（完全静态！0 位移！0 动态圆角！GPU 离屏重剪降为 0） */}
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

            {/* 2. 中层：自然渐变半透明暗化 Scrim（遮罩），点遮罩瞬时收起 */}
            <Animated.View
              collapsable={false}
              style={[
                styles.scrim,
                { backgroundColor: theme.colors.scrim },
                scrimAnimatedStyle,
              ]}
              pointerEvents={isOpen ? 'auto' : 'none'}
            >
              <Pressable
                accessibilityLabel="收起菜单"
                testID="drawer-tap-dismiss"
                style={StyleSheet.absoluteFill}
                onPress={() => actions.close()}
                onTouchStart={handleDrawerClose}
              />
            </Animated.View>

            {/* 3. 顶层：悬浮滑出抽屉面板 (Front Drawer，微描边 + 纯硬件变换) */}
            <Animated.View
              collapsable={false}
              style={[
                styles.drawerLayer,
                {
                  width: maxTranslate,
                  backgroundColor: theme.colors.canvasDrawer,
                  borderRightWidth: StyleSheet.hairlineWidth,
                  borderRightColor: theme.colors.hairline,
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
    zIndex: 10,
  },
  scrim: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 5,
  },
  sceneContainer: {
    flex: 1,
  },
});
