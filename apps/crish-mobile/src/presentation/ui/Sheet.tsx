// 底部 Sheet：真实 Modal + 安全区 + 遮罩 / Android 返回关闭。
// 遮罩（J10，用户点名）：静止全屏层、只做 opacity 过渡（iOS 叠 BlurView 复现原型
// backdrop blur(2px)）；面板单独 translateY 滑入/滑出——动画全程看不到遮罩边缘移动。
// 面板（J7）：iOS 半透明强档覆于已模糊的遮罩之上成通透感；Android 无真模糊，
// 走实色兜底（同 account GlassBackdrop 先例）。浮层阴影（容器外阴影批，
// 2026-11-02；上限裁决同日晚修订）：面板走 SoftShadowSurface sheetUp 上向
// 档（几何沿原型 bottom-sheet.css，α 收到按钮档两层 0.008/0.012——阴影
// 上限硬裁决），仅 Android 浅色渲染；拖拽位移挂外层，阴影随面板同动。
// 关闭钮（J10）：30 圆盘、极淡底、× 用弱色细线（Icon 默认 1.8 线宽），不抢眼；
// 按压叠层 120ms 过渡（按压过渡统一批）。
// 拖拽关闭（手感基建批，交互审计 D1）：把手名实归一——面板 Pan 手势跟手位移、
// 释放按距离（≥30% 面板高）或速度（≥800dp/s）判定，速度播种弹簧收尾；拖拽中
// 遮罩 opacity 随面板进度联动（遮罩层本身不位移，守 J10）。内容已滚动时纵向
// 拖动归 ScrollView，滚回顶部后的下滑才接管面板（manualActivation 仲裁）。
// 减动效（手感基建批）：系统 Reduce Motion 开启时手势禁用，面板位移塌缩为
// opacity 交叉淡化（共享信号 useReducedMotion）。
// 键盘瞬发交接（2026-11-04 动效重构，深治方案 01-1）：
// Sheet 呈现请求到达时若软键盘升起，立即非阻塞发起 KeyboardController.dismiss()，
// 绝不阻塞面板挂载与进场动画（彻底废除 1000ms 阻塞门与串行等待）；
// effectiveVisible 直接与 visible 同步，面板与键盘下沉并发进行，体验瞬发无延迟。
// 关闭后不自动重弹键盘（本组件从不代宿主聚焦输入框）。
// 语义档位 + 浮层纪律（批 D，2026-11-03；深比 02-2/02-3）：
// - 高度改语义档位（size：compact/medium/large/full → SHEET_SIZE_
//   RATIOS 的比例上限，内容仍实测高、档位只是上限），调用点按内容
//   语义选档，不再散落裸比例数；旧 maxHeightRatio 裸数 prop 已删。
// - 含搜索框的 Sheet 经 useSheetSearchRaise 在搜索获焦时升一档
//   （blur 回落），机制与键盘交接的 KAV 同为「为 Sheet 内输入铺垫」
//   的设施面——当前无生产搜索消费方，钩子行为由单测钉住。
// - 本层打开期间登记进覆盖层注册表（overlayStack）：Android 返回
//   经 Modal 的 onRequestClose 汇入栈顶裁决；dismissible=false 时
//   遮罩点按/拖拽/返回/关闭钮全部失效，且把手不着色（把手即承诺：
//   不可拖关的面板不作可拖暗示），只能由内容里的动作表态关闭。
// - backAction（面板内钻取）：标题槽左侧出返回钮，系统返回先退
//   钻取不关 Sheet；钻取状态归宿主，本组件只出槽位与返回分发。
//   当前树内无面板内钻取消费方（各选择面均为平铺列表、文件下钻在
//   filesScreen 走页面导航），槽位契约由单测钉住。
// - 关闭动画期间呈现冻结在最后一帧（frozen frame）：visible 落下
//   后宿主改 title/children 不影响出场画面，出场播完才卸载。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import {
  KeyboardAvoidingView,
  KeyboardController,
} from 'react-native-keyboard-controller';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { useKeyboardHeight } from '@/adapters/platform/useKeyboardHeight';
import { useReducedMotion } from '@/adapters/platform/useReducedMotion';
import { haptics } from '@/adapters/platform/haptics';
import AppText from './AppText';
import Icon from './Icon';
import { SoftShadowSurface } from './SoftShadowSurface';
import { usePressFade } from './pressFeedback';
import { handleOverlayBackFor, useOverlayRegistration } from './overlayStack';

/** Sheet 语义档位（按内容语义选：短确认 compact / 选项列 medium /
 * 长列表 large / 搜索升档或全量内容 full） */
export type SheetSize = 'compact' | 'medium' | 'large' | 'full';

/** 档位 → 面板高度上限比例（占窗口高；内容实测高、档位只是上限） */
export const SHEET_SIZE_RATIOS: Readonly<Record<SheetSize, number>> = {
  compact: 0.4,
  medium: 0.6,
  large: 0.8,
  full: 1,
};

const SHEET_SIZE_ORDER: readonly SheetSize[] = [
  'compact',
  'medium',
  'large',
  'full',
];

/** 升一档（搜索获焦升档用；full 已封顶） */
export function nextSheetSize(size: SheetSize): SheetSize {
  const index = SHEET_SIZE_ORDER.indexOf(size);
  return SHEET_SIZE_ORDER[Math.min(index + 1, SHEET_SIZE_ORDER.length - 1)]!;
}

const SheetRaiseContext = createContext<{
  setRaised: (raised: boolean) => void;
}>({ setRaised: () => undefined });

/**
 * Sheet 内搜索升档钩子：搜索输入把返回的 onFocus/onBlur 挂上即可——
 * 获焦时所在 Sheet 升一档、失焦回落。不在 Sheet 内时为空操作
 * （默认 context），可安全挂在可复用搜索组件上。
 */
export function useSheetSearchRaise(): {
  onFocus: () => void;
  onBlur: () => void;
} {
  const { setRaised } = useContext(SheetRaiseContext);
  return useMemo(
    () => ({
      onFocus: () => setRaised(true),
      onBlur: () => setRaised(false),
    }),
    [setRaised]
  );
}

export interface SheetBackAction {
  /** 只退钻取层，不关 Sheet（钻取状态归宿主） */
  onPress: () => void;
  /** 缺省「返回」 */
  accessibilityLabel?: string;
}

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** 固定在底部的内容（如主按钮） */
  footer?: ReactNode;
  /** 语义档位（默认 large=0.8 上限；取代旧裸比例 maxHeightRatio） */
  size?: SheetSize;
  /**
   * 可关闭性（默认 true）。false = 必须表态层：遮罩点按、拖拽、
   * 系统返回、关闭钮全部失效，把手不着色，只能由内容动作关闭。
   */
  dismissible?: boolean;
  /** 面板内钻取返回（标题槽左侧；系统返回先退钻取） */
  backAction?: SheetBackAction;
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
 * 面板纵向位移（纯函数，显式 worklet；单测与 UI 线程共用同一真理）：
 * 展开进度 0 → 整块藏于屏外，1 → 归位。
 * 面板高度未测得（首帧 onLayout 未回）时，以基于语义档位推导的 fallbackHeight 兜底，
 * 绝不使用全屏 windowHeight，彻底消除沉底 570dp 虚空与单帧突变瞬移。
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
  fallbackHeightOrWindowHeight: number,
  explicitFallbackHeight?: number
): number {
  'worklet';
  const effectiveFallback =
    explicitFallbackHeight !== undefined
      ? explicitFallbackHeight
      : fallbackHeightOrWindowHeight;
  const effectiveHeight = panelHeight > 0 ? panelHeight : effectiveFallback;
  return (1 - progress) * effectiveHeight;
}

export function Sheet({
  visible,
  onClose,
  title,
  children,
  footer,
  size = 'large',
  dismissible = true,
  backAction,
  testID,
}: SheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  // 覆盖层注册表 id：优先 testID（宿主可预期），否则组件实例 id
  const generatedOverlayId = useId();
  const overlayId = testID ?? generatedOverlayId;
  // 搜索升档（批 D）：Sheet 内搜索获焦经 context 置位，面板升一档；
  // 关闭/卸载即复位。升档只动高度上限（内容实测高不变），与面板
  // 位移动画分开——上限变化即时生效（同内容增高既有口径，不补间）。
  const [raised, setRaised] = useState(false);
  const setRaisedStable = useCallback((next: boolean) => {
    setRaised(next);
  }, []);
  const raiseContextValue = useMemo(
    () => ({ setRaised: setRaisedStable }),
    [setRaisedStable]
  );
  useEffect(() => {
    if (!visible) setRaised(false);
  }, [visible]);
  const effectiveSize = raised ? nextSheetSize(size) : size;
  const maxHeightRatio = SHEET_SIZE_RATIOS[effectiveSize];
  // 窗口高度在 JS 线程取得（纯数字），供 panelStyle worklet 捕获——见 sheetPanelTranslateY 注释
  const { height: windowHeight } = useWindowDimensions();
  const fallbackHeight = Math.round(windowHeight * maxHeightRatio);
  // 键盘处理：若软键盘处于开启状态，非阻塞发起收起，抽屉直接并行展开，不再等待键盘 settle，彻底杜绝 1000ms 冻结
  const keyboardHeight = useKeyboardHeight();
  const handoffDismissed = useRef(false);
  useEffect(() => {
    if (!visible) {
      handoffDismissed.current = false;
      return;
    }
    if (keyboardHeight > 0 && !handoffDismissed.current) {
      handoffDismissed.current = true;
      void KeyboardController.dismiss();
    }
  }, [visible, keyboardHeight]);
  const effectiveVisible = visible;
  // 关闭时先播出场动画再卸载 Modal（进场则立即挂载）
  const [mounted, setMounted] = useState(false);
  // 覆盖层登记（批 D）：挂载期间（含出场动画）在栈，Android 返回
  // 由 Modal onRequestClose 汇入栈顶裁决；钻取在场时先退钻取。
  useOverlayRegistration(overlayId, mounted, {
    dismissible,
    onRequestClose: onClose,
    onBack: backAction ? () => backAction.onPress() : undefined,
  });
  // 末帧冻结（批 D）：呈现期间逐渲染捕获呈现帧，关闭动画期间只渲染
  // 冻结帧——宿主在 visible 落下同帧改 title/children（如操作目标
  // 切换）不污染出场画面。
  const frameRef = useRef<{
    title?: string;
    children: ReactNode;
    footer?: ReactNode;
    backAction?: SheetBackAction;
  } | null>(null);
  if (effectiveVisible) {
    frameRef.current = { title, children, footer, backAction };
  }
  const frame = frameRef.current;
  const [panelHeight, setPanelHeight] = useState(0);
  const lastMeasuredHeightRef = useRef<number>(0);
  const backdropProgress = useSharedValue(0);
  const panelProgress = useSharedValue(0);
  // 动效基线高度共享值（UI 线程）：飞行过程中锁定基线，杜绝 onLayout 回包突变瞬移
  const baselineHeight = useSharedValue(fallbackHeight);

  // 当布局测量真实高度送达时：记录历史实测高度供后续立即复用；
  // 稳态（panelProgress >= 0.99）才更新当前 UI 线程基线，动效飞行中途保持基线锁定，杜绝空中突变瞬移
  const handlePanelLayout = useCallback((event: LayoutChangeEvent) => {
    const h = event.nativeEvent.layout.height;
    setPanelHeight(h);
    lastMeasuredHeightRef.current = h;
    if (panelProgress.value >= 0.99) {
      baselineHeight.value = h;
    }
  }, []);

  // 即时响应关闭（空白区域与关闭按钮）：立刻在 UI 线程与 JS 同步启动退场动效，无需等待宿主 React 重新渲染
  const handleDismiss = useCallback(() => {
    if (!dismissible) return;
    backdropProgress.value = withTiming(0, {
      duration: reduceMotion
        ? theme.motion.duration.fast
        : theme.motion.duration.normal,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
    });
    panelProgress.value = withTiming(
      0,
      {
        duration: reduceMotion
          ? theme.motion.duration.fast
          : theme.motion.duration.sheet,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      },
      (finished) => {
        if (finished) runOnJS(setMounted)(false);
      }
    );
    onClose();
  }, [dismissible, onClose, reduceMotion, theme]);

  // 拖拽状态（UI 线程）：内容滚动偏移（>0 时纵向拖动归滚动）、抓手起始进度、
  // 起始触点纵坐标、释放判定是否已由 onEnd 处理（onFinalize 兜底回位用）
  const scrollOffset = useSharedValue(0);
  const dragStartProgress = useSharedValue(1);
  const dragStartY = useSharedValue(0);
  const dragEndHandled = useSharedValue(false);
  // 弹簧参数在渲染期取成普通对象（数字字段），供手势 worklet 捕获
  const sheetSpring = theme.motion.spring.sheet;

  useEffect(() => {
    if (effectiveVisible) {
      setMounted(true);
      // 进场前锁定基线高度（优先使用历史已知高度，消除深渊盲飞与几何断层）
      const initialBaseline =
        lastMeasuredHeightRef.current > 0
          ? lastMeasuredHeightRef.current
          : panelHeight > 0
            ? panelHeight
            : fallbackHeight;
      baselineHeight.value = initialBaseline;
      // 遮罩柔和呼吸渐入：时长与面板进场同步 (expand: 280ms)，曲线采用平滑缓出贝塞尔 (0.25, 0.1, 0.25, 1)，
      // 消除陡峭火箭式瞬间压暗，与抽屉上升同步呼应
      backdropProgress.value = withTiming(1, {
        duration: reduceMotion
          ? theme.motion.duration.fast
          : theme.motion.duration.expand,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
      panelProgress.value = withTiming(
        1,
        {
          duration: reduceMotion
            ? theme.motion.duration.fast
            : theme.motion.duration.expand,
          easing: Easing.bezier(...theme.motion.easing.emphasized),
        },
        (finished) => {
          if (finished) {
            baselineHeight.value =
              panelHeight > 0 ? panelHeight : initialBaseline;
          }
        }
      );
      return;
    }
    if (!mounted) return;
    backdropProgress.value = withTiming(0, {
      duration: reduceMotion
        ? theme.motion.duration.fast
        : theme.motion.duration.normal,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
    });
    panelProgress.value = withTiming(
      0,
      {
        duration: reduceMotion
          ? theme.motion.duration.fast
          : theme.motion.duration.sheet,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      },
      (finished) => {
        if (finished) runOnJS(setMounted)(false);
      }
    );
    // 兜底卸载：动画被打断/测试环境回调不达时不留挂载
    const timer = setTimeout(() => setMounted(false), 300);
    return () => clearTimeout(timer);
  }, [effectiveVisible]);

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
    // 全程位移基线保持连续锁定，杜绝在 progress >= 0.99 处突变高度导致的段落感跳跃
    return {
      transform: [
        {
          translateY: sheetPanelTranslateY(
            panelProgress.value,
            baselineHeight.value,
            windowHeight,
            fallbackHeight
          ),
        },
      ],
    };
  }, [windowHeight, fallbackHeight, reduceMotion]);

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
    // dismissible=false：拖拽关闭整体失效（把手诚实口径的动作面）
    .enabled(visible && !reduceMotion && dismissible)
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
      const height = panelHeight > 0 ? panelHeight : fallbackHeight;
      const next = dragStartProgress.value - event.translationY / (height || 1);
      const clamped = Math.min(Math.max(next, 0), 1);
      panelProgress.value = clamped;
      backdropProgress.value = clamped;
    })
    .onEnd((event) => {
      dragEndHandled.value = true;
      const height = panelHeight > 0 ? panelHeight : fallbackHeight;
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
      onRequestClose={() => {
        // 返回汇入覆盖层注册表裁决（栈顶优先/钻取优先/不可关挡下）；
        // 栈空竞态（尚未登记）回落本层口径
        if (!handleOverlayBackFor(overlayId) && dismissible) handleDismiss();
      }}
      statusBarTranslucent
    >
      <SheetRaiseContext.Provider value={raiseContextValue}>
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
                  accessibilityRole={dismissible ? 'button' : undefined}
                  accessibilityLabel={dismissible ? '关闭' : undefined}
                  unstable_pressDelay={0}
                  style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: theme.colors.scrim },
                  ]}
                  onPress={dismissible ? handleDismiss : undefined}
                />
              </Animated.View>
              <GestureDetector gesture={panGesture}>
                <Animated.View
                  testID={testID}
                  onLayout={handlePanelLayout}
                  style={[
                    styles.panelHost,
                    {
                      maxHeight: `${Math.round(maxHeightRatio * 100)}%`,
                    },
                    panelStyle,
                  ]}
                >
                  {/* 面板软阴影面（sheetUp 上向档）：填充/圆角/裁剪/内衬归内层，
                    拖拽位移挂外层随面板同动；外层不裁剪保阴影出血 */}
                  <SoftShadowSurface
                    preset="sheetUp"
                    borderRadius={theme.radius.sheet}
                    fill={
                      Platform.OS === 'ios'
                        ? theme.colors.surfaceTranslucentStrong
                        : theme.colors.surfaceRaised
                    }
                    fillStyle={{
                      borderTopLeftRadius: theme.radius.sheet,
                      borderTopRightRadius: theme.radius.sheet,
                      maxHeight: '100%',
                      paddingTop: theme.space.sm,
                      paddingHorizontal: theme.space.lg + theme.space.xxs,
                      paddingBottom: Math.max(insets.bottom, theme.space.xxl),
                    }}
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
                          // 把手即承诺（批 D）：不可拖关的面板把手不着色，
                          // 不作可拖暗示；可关时沿原型 rgba(0,0,0,0.14)，
                          // 深色等值反转为白 alpha（无对应 token，经 M4 裁决直给）
                          backgroundColor: !dismissible
                            ? 'transparent'
                            : theme.dark
                              ? 'rgba(255,255,255,0.14)'
                              : 'rgba(0,0,0,0.14)',
                        },
                      ]}
                    />
                    {frame?.title || frame?.backAction ? (
                      <View
                        style={[
                          styles.header,
                          {
                            paddingHorizontal: theme.space.xxs,
                            marginBottom: theme.space.lg,
                            gap: theme.space.sm,
                          },
                        ]}
                      >
                        {frame?.backAction ? (
                          <SheetBackButton backAction={frame.backAction} />
                        ) : null}
                        {frame?.title ? (
                          <AppText
                            variant="headline"
                            style={styles.title}
                            numberOfLines={1}
                          >
                            {frame.title}
                          </AppText>
                        ) : (
                          <View style={styles.title} />
                        )}
                        {dismissible ? (
                          <SheetCloseButton onClose={handleDismiss} />
                        ) : null}
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
                      {frame?.children}
                    </ScrollView>
                    {frame?.footer ? (
                      <View style={{ paddingTop: theme.space.md }}>
                        {frame.footer}
                      </View>
                    ) : null}
                  </SoftShadowSurface>
                </Animated.View>
              </GestureDetector>
            </View>
          </KeyboardAvoidingView>
        </GestureHandlerRootView>
      </SheetRaiseContext.Provider>
    </Modal>
  );
}

/** Sheet 钻取返回钮（批 D）：标题槽左侧、与关闭钮同制极淡圆盘 */
function SheetBackButton({ backAction }: { backAction: SheetBackAction }) {
  const theme = useTheme();
  const press = usePressFade();
  return (
    <Pressable
      testID="sheet-back"
      accessibilityRole="button"
      accessibilityLabel={backAction.accessibilityLabel ?? '返回'}
      onPress={backAction.onPress}
      hitSlop={theme.space.sm}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.close,
        {
          width: theme.size.sheetClose,
          height: theme.size.sheetClose,
          borderRadius: theme.size.sheetClose / 2,
          backgroundColor: theme.colors.fillSubtle,
        },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: theme.size.sheetClose / 2,
            backgroundColor: theme.colors.fillPressed,
          },
          press.overlayStyle,
        ]}
      />
      <Icon
        name="chevron-left"
        size={theme.size.iconSmall}
        color={theme.colors.textTertiary}
      />
    </Pressable>
  );
}

/** Sheet 关闭圆钮：常驻极淡底 + 按压叠层 120ms 过渡（按压过渡统一批） */
function SheetCloseButton({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const press = usePressFade();
  return (
    <Pressable
      testID="sheet-close"
      accessibilityRole="button"
      accessibilityLabel="关闭"
      onPress={onClose}
      hitSlop={theme.space.sm}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.close,
        {
          width: theme.size.sheetClose,
          height: theme.size.sheetClose,
          // 圆盘圆角 = 直径/2 实值（圆形按钮定案，禁用 pill 9999）
          borderRadius: theme.size.sheetClose / 2,
          backgroundColor: theme.colors.fillSubtle,
        },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: theme.size.sheetClose / 2,
            backgroundColor: theme.colors.fillPressed,
          },
          press.overlayStyle,
        ]}
      />
      <Icon
        name="x"
        size={theme.size.iconSmall}
        color={theme.colors.textTertiary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  // 面板外层：只承载位移与高度上限（填充/圆角/裁剪归 SoftShadowSurface 内层，
  // 外层裁剪会剪掉 sheetUp 阴影的上向出血）
  panelHost: {},
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
