// 层叠卡片抽屉容器（Card Push 原型层叠架构，对齐 Crish Mobile 权威设计）：
// - 主界面在上（顶层圆角卡片向右平移推开），抽屉在下（底层面板微视差平移展露）；
// - 绝对无 Scrim 黑色遮罩：原型抽屉本就没有遮罩层（Scrim 只属于底部弹窗 Sheet）；
//   层叠纯靠色阶差（主卡片 surface #ffffff，底层面板 canvasDrawer #f0f0f0）
//   和大圆角（radius.sheet 28dp）呈现，不存在随进度平移或渐变的半透明黑色遮罩；
// - 立体感 = 色阶差 + 大圆角，零描边、零缩放、抽屉本体零投影（符合 2026-11-02 晚用户裁决，禁止加阴影）；
// - 开合动效：物理弹簧曲线（theme.motion.spring.drawer，overshootClamping: true）；
// - 手势与手感（2026-11-05 卡手修复 + 返工收口后口径）：
//   * manualActivation 精确仲裁——关闭态屏幕左侧 75% 范围横向意图（dx > 14 且 dx > 0.7|dy|）顺滑激活；
//   * 纵向滚动优先——垂直位移明显大于横向时让位给列表滚动；判 fail 须纵向
//     占优连续 3 个采样点成立（去噪定案），单帧抖动/斜擦不误杀手势；
//   * 生命周期收口——手势未激活结束、被判 fail 或被系统取消时，onFinalize
//     按 drawerReleaseTarget 就近落位（onEnd 已收口则跳过）：落定动画在飞时
//     落指已把 progress 停在中间值，无收口则抽屉冻在半开位、状态与视觉脱节
//     （题 8 冻结链根因，2026-11-05 返工补齐）；
//   * 激活帧零跳变——onUpdate 首帧捕获激活点位移为换算偏移，激活瞬间
//     progress 不再跳约 14dp；
//   * 打开态仅左移激活、右摇不判死（不激活即不消费触摸，方向回摆可再激活）；
//   * 多指钉死首触指针——第二指落下不重置拖拽基准（按 pointer id 取触点）；
//   * 点按主卡才关抽屉（Pressable onPress），按下不再抢跑关闭弹簧；
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
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
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
/** 纵向失效阈值：纵向位移达到 12dp 且大于横向视为纵向占优（判 fail 还须连续多采样确认，见 FAIL_DY_CONFIRM_SAMPLES） */
const FAIL_DY = 12;
/** FAIL_DY 去噪：纵向占优须连续命中的采样点数才定案判 fail，单帧抖动不定案 */
const FAIL_DY_CONFIRM_SAMPLES = 3;
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
  /** 被钉死的首触指针 id（-1 = 无）；多指先后落地时拖拽基准不重置（S-D 修复） */
  const gesturePointerId = useSharedValue(-1);
  /** FAIL_DY 去噪计数：纵向占优连续命中的采样点数（落指/抬手/条件消散即清零） */
  const failDyStreak = useSharedValue(0);
  /** 激活点位移偏移（onUpdate 首帧捕获）：progress 换算扣除它，激活瞬间零跳变 */
  const activationOffsetX = useSharedValue(0);
  const activationOffsetCaptured = useSharedValue(false);
  /** onEnd 已收口标记：onFinalize 在 onEnd 之后也会触发，靠它防双重收口 */
  const endHandled = useSharedValue(false);

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
    () => {
      // 落定收口（worklet）：onEnd 与 onFinalize 共用同一落位机器——关侧
      // 先走关闭收尾（内容失焦 + 收键盘），减动效直落，否则物理弹簧落位
      // 并仅在落定瞬间同步 isOpen/phase（拖动中途零 React 同步，不变）
      const settleProgress = (target: 0 | 1, velocityX: number) => {
        'worklet';
        if (target === 0) {
          runOnJS(handleDrawerClose)();
        }
        if (reduceMotion) {
          progress.value = target;
          runOnJS(onAnimationFinished)(target === 1);
          return;
        }
        const normalizedVelocity =
          maxTranslate > 0 ? velocityX / maxTranslate : 0;
        progress.value = withSpring(
          target,
          {
            ...theme.motion.spring.drawer,
            velocity: normalizedVelocity,
            overshootClamping: true,
          },
          (finished) => {
            if (finished) runOnJS(onAnimationFinished)(target === 1);
          }
        );
      };

      return Gesture.Pan()
        .manualActivation(true)
        .onTouchesDown((event) => {
          'worklet';
          // 多指纪律（2026-11-05 卡手修复 S-D）：仅"单指按下"视为新手势
          // 起点——第二根手指落下不重置拖拽基准，杜绝双指先后落地时
          // progress 基准突变造成的跳变；全部手指抬起后自然回到单指态
          if (event.allTouches.length !== 1) return;
          const touch = event.allTouches[0];
          if (!touch) return;
          gesturePointerId.value = touch.id;
          cancelAnimation(progress);
          touchStartX.value = touch.x;
          touchStartY.value = touch.y;
          startProgress.value = progress.value;
          failDyStreak.value = 0;
          activationOffsetCaptured.value = false;
          activationOffsetX.value = 0;
          endHandled.value = false;
        })
        .onTouchesMove((event, stateManager) => {
          'worklet';
          // 只跟随被钉死的首触指针（按 pointer id 取，取 allTouches[0] 会随
          // 第二指落下换人）；首触抬起后本次手势宁可暂停也不换基准跳变
          const touch =
            event.allTouches.find((t) => t.id === gesturePointerId.value) ??
            null;
          if (!touch) return;
          const dx = touch.x - touchStartX.value;
          const dy = touch.y - touchStartY.value;
          const absDx = Math.abs(dx);
          const absDy = Math.abs(dy);

          // 纵向让位（去噪定案）：纵向占优须连续 FAIL_DY_CONFIRM_SAMPLES
          // 个采样点成立才判 fail——单帧抖动/斜擦不误杀；条件成立期间先
          // 按兵不动（不激活也不判 fail），等确认满额或条件消散后清零
          if (absDy > FAIL_DY && absDy > absDx) {
            failDyStreak.value += 1;
            if (failDyStreak.value >= FAIL_DY_CONFIRM_SAMPLES) {
              stateManager.fail();
            }
            return;
          }
          failDyStreak.value = 0;

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
            // 打开态限定仅向左收起（2026-11-05 卡手修复 S-C）：右摇不再
            // 判死——manualActivation 下不激活即不消费触摸，方向回摆后
            // 仍可激活左移；旧 `dx > ACTIVATION_DX → fail()` 把一次右晃
            // 永久放弃整条手势，用户只能干等关闭弹簧跑完（"滑多了时不时
            // 卡手"的静态推演首因之一）
            if (dx < -ACTIVATION_DX && absDx > absDy * 0.7) {
              stateManager.activate();
            }
          }
        })
        .onTouchesUp((event) => {
          'worklet';
          // 全部手指离开屏幕后释放首触钉死（下次单指按下重新取基准）
          if (event.allTouches.length <= 1) {
            gesturePointerId.value = -1;
          }
          failDyStreak.value = 0;
        })
        .onTouchesCancelled(() => {
          'worklet';
          gesturePointerId.value = -1;
          failDyStreak.value = 0;
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
          // 激活帧零跳变：首个 onUpdate 的 translationX 即激活点位移，
          // 捕获为换算偏移——扣除后激活瞬间 progress 与抓取时严格一致，
          // 不再跳 ACTIVATION_DX / maxTranslate（≈14dp）
          if (!activationOffsetCaptured.value) {
            activationOffsetCaptured.value = true;
            activationOffsetX.value = event.translationX;
          }
          const deltaProgress =
            (event.translationX - activationOffsetX.value) / maxTranslate;
          const next = startProgress.value + deltaProgress;
          progress.value = Math.max(0, Math.min(1, next));
        })
        .onEnd((event) => {
          'worklet';
          endHandled.value = true;
          const target = drawerReleaseTarget({
            startProgress: startProgress.value,
            progress: progress.value,
            velocityX: event.velocityX,
          });
          settleProgress(target, event.velocityX);
        })
        .onFinalize(() => {
          'worklet';
          // 生命周期收口（题 8 冻结链根治）：手势未激活结束、被判 fail
          // 或被系统取消时 onEnd 永不触发——而落指已在 onTouchesDown 里
          // cancelAnimation 把在飞的落定动画停在中间值，若无人落位，
          // 抽屉就冻在半开位且 isOpen/phase 与视觉脱节（N-1 主页露边
          // 同源：静止残值只能来自这种未收口的中间 progress）。此处按
          // drawerReleaseTarget 就近落位（速度不计入：非主动甩动，只求
          // 回到最近的落定侧）；onEnd 已收口（endHandled）或已在落定
          // 位（恰为 0/1）时跳过，防双重收口与无谓弹簧
          if (endHandled.value) {
            endHandled.value = false;
            return;
          }
          const current = progress.value;
          if (current === 0 || current === 1) return;
          const target = drawerReleaseTarget({
            startProgress: startProgress.value,
            progress: current,
            velocityX: 0,
          });
          settleProgress(target, 0);
        });
    },
    [
      activationOffsetCaptured,
      activationOffsetX,
      endHandled,
      failDyStreak,
      handleDrawerClose,
      maxTranslate,
      onAnimationFinished,
      progress,
      reduceMotion,
      startProgress,
      theme.motion.spring.drawer,
      width,
    ]
  );

  // 顶层：主卡片向右平移推开（[0, maxTranslate]）+ 阶跃常量大圆角（消除 Skia 动态重绘 38% 掉帧）
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
    borderRadius:
      progress.value <= 0.005 ? 0 : theme.radius.sheet,
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
        progress.value = withSpring(
          1,
          {
            ...theme.motion.spring.drawer,
            overshootClamping: true,
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
        progress.value = withSpring(
          0,
          {
            ...theme.motion.spring.drawer,
            overshootClamping: true,
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
      theme.motion.spring.drawer,
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

              {/* 打开状态下点击主卡片收起抽屉（纯透明点击区域，无黑色遮罩）。
                  2026-11-05 卡手修复 S-A/S-B：删除 onTouchStart 关闭触发——
                  按下帧即启动关闭弹簧会抢在手势激活之前（14dp 激活窗口内
                  progress 已被弹簧推走，Pan 激活后从弹簧位置跳回手指位置），
                  且"按住不动想拖"会变成"没拖它自己关"。现在只有真正点按
                  （onPress）才关闭，拖拽关闭完全交还 Pan 手势。 */}
              <Pressable
                accessibilityLabel="收起菜单"
                testID="drawer-tap-dismiss"
                style={styles.tapDismiss}
                onPress={() => actions.close()}
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
