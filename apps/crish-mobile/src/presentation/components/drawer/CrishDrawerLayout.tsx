// 层叠卡片抽屉容器（实现波总方案 D8 / N03 落地）：
// - 主界面在上（顶层圆角卡片），抽屉在下（底层面板），无 scrim 遮罩；
//   立体感 = 色阶差（canvas vs surface）+ 大圆角 + 微缩放 + 轻投影，零描边；
// - 手势：manualActivation 精确仲裁——关闭态仅屏幕左缘 64dp 内、横向意图
//   （|dx| > 14 且 |dx| > 0.7|dy|，容纳拇指自然弧线）才激活；纵向滚动永不误触；
// - 全部动效运行在 Reanimated UI 线程（拖动 0 次 React 渲染）；
// - Android 返回键：抽屉打开时优先收起；点击主卡片任意处收起；
// - 控制器经 context 暴露 open/close/closeImmediate（N04 单入口编排：
//   跳根栈页面 = 先 push 后无动画静默重置，杜绝双动画竞争）。
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BackHandler,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { CrishDrawerContent } from './CrishDrawerContent';
import {
  DrawerControllerContext,
  type DrawerController,
  useDrawerController,
} from './DrawerContext';

export { useDrawerController, type DrawerController };

/** 激活阈值：横向位移达到即认领手势 */
const ACTIVATION_DX = 14;
/** 纵向失效阈值：纵向位移达到且横向不占优 → 让位给列表滚动 */
const FAIL_DY = 26;
/** 半开判定：越过该进度松手 → 弹簧收全开，否则弹回 */
const OPEN_THRESHOLD = 0.45;
/** 快速轻扫速度阈值（dp/s） */
const FLING_VELOCITY = 400;

export function CrishDrawerLayout({ children }: { children: ReactNode }) {
  const theme = useTheme();
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
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const [isOpen, setIsOpen] = useState(false);
  const contentMountedRef = useRef(false);
  const [contentMounted, setContentMounted] = useState(false);

  useAnimatedReaction(
    () => progress.value > 0.5,
    (next, prev) => {
      if (next !== prev) {
        runOnJS(setIsOpen)(next);
        if (next && !contentMountedRef.current) {
          contentMountedRef.current = true;
          runOnJS(setContentMounted)(true);
        }
      }
    },
    []
  );

  const pan = Gesture.Pan()
    .manualActivation(true)
    .onTouchesDown((event, _stateManager) => {
      const touch = event.allTouches[0];
      if (touch) {
        startX.value = touch.absoluteX;
        startY.value = touch.absoluteY;
      }
    })
    .onTouchesMove((event, stateManager) => {
      const touch = event.allTouches[0];
      if (!touch) return;
      const dx = touch.absoluteX - startX.value;
      const dy = touch.absoluteY - startY.value;
      // 关闭态：屏幕绝大部分区域（左侧 75% 范围）起滑，只要明确向右滑动即顺滑激活抽屉
      if (progress.value <= 0) {
        if (startX.value > width * 0.75) {
          stateManager.fail();
          return;
        }
        if (dx > ACTIVATION_DX && dx > Math.abs(dy) * 0.7) {
          stateManager.activate();
          return;
        }
      } else {
        // 打开态：水平拖拽超过激活阈值即接管拖动
        if (Math.abs(dx) > ACTIVATION_DX && Math.abs(dx) > Math.abs(dy) * 0.7) {
          stateManager.activate();
          return;
        }
      }
      // 垂直滚动优先：纵向滚动距离明显大于横向时，手势失败让位于内部滚动视图
      if (Math.abs(dy) > FAIL_DY && Math.abs(dy) > Math.abs(dx)) {
        stateManager.fail();
      }
    })
    .onStart(() => {
      startProgress.value = progress.value;
    })
    .onUpdate((event) => {
      const next =
        startProgress.value + event.translationX / (maxTranslate || 1);
      progress.value = Math.min(Math.max(next, 0), 1);
    })
    .onEnd((event) => {
      const shouldOpen =
        event.velocityX > FLING_VELOCITY || progress.value > OPEN_THRESHOLD;
      progress.value = withSpring(
        shouldOpen ? 1 : 0,
        theme.motion.spring.drawer
      );
    });

  const cardStyle = useAnimatedStyle(() => {
    const p = progress.value;
    const r = interpolate(
      p,
      [0, 1],
      [0, theme.radius.sheet],
      Extrapolation.CLAMP
    );
    return {
      transform: [
        {
          translateX: interpolate(
            p,
            [0, 1],
            [0, maxTranslate],
            Extrapolation.CLAMP
          ),
        },
        {
          scale: interpolate(
            p,
            [0, 1],
            [1, theme.layout.drawerCardScale],
            Extrapolation.CLAMP
          ),
        },
      ],
      borderRadius: r,
    };
  });

  const cardInnerStyle = useAnimatedStyle(() => {
    const p = progress.value;
    const r = interpolate(
      p,
      [0, 1],
      [0, theme.radius.sheet],
      Extrapolation.CLAMP
    );
    return {
      borderRadius: r,
    };
  });

  const drawerStyle = useAnimatedStyle(() => ({
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

  const controller: DrawerController = useMemo(
    () => ({
      open: () => {
        progress.value = withSpring(1, theme.motion.spring.drawer);
      },
      close: () => {
        progress.value = withSpring(0, theme.motion.spring.drawer);
      },
      closeImmediate: () => {
        progress.value = 0;
      },
      isOpen,
    }),
    [progress, isOpen, theme.motion.spring.drawer]
  );

  // Android 返回键：抽屉打开时优先收起
  useEffect(() => {
    if (!isOpen) return;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        progress.value = withSpring(0, theme.motion.spring.drawer);
        return true;
      }
    );
    return () => subscription.remove();
  }, [isOpen, progress, theme.motion.spring.drawer]);

  return (
    <DrawerControllerContext.Provider value={controller}>
      <GestureDetector gesture={pan}>
        <View style={[styles.root, { backgroundColor: theme.colors.canvas }]}>
          {/* 底层：抽屉面板（微视差） */}
          <Animated.View
            style={[styles.drawerLayer, { width: maxTranslate }, drawerStyle]}
          >
            {contentMounted ? <CrishDrawerContent /> : null}
          </Animated.View>
          {/* 顶层：主界面卡片（位移 + 缩放 + 圆角渐变 + 强立体投影容器） */}
          <Animated.View
            style={[
              styles.cardContainer,
              { backgroundColor: theme.colors.surface },
              theme.shadow.sheet,
              cardStyle,
            ]}
          >
            <Animated.View
              style={[
                styles.cardInner,
                { backgroundColor: theme.colors.surface },
                cardInnerStyle,
              ]}
            >
              {children}
              {/* 打开期点击主卡片任意处收起（关闭期不拦截任何交互） */}
              <Pressable
                accessibilityLabel="收起菜单"
                onPress={() => controller.close()}
                style={styles.tapDismiss}
                pointerEvents={isOpen ? 'auto' : 'none'}
              />
            </Animated.View>
          </Animated.View>
        </View>
      </GestureDetector>
    </DrawerControllerContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: 'hidden' },
  drawerLayer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
  },
  cardContainer: {
    flex: 1,
  },
  cardInner: {
    flex: 1,
    overflow: 'hidden',
  },
  tapDismiss: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
});
