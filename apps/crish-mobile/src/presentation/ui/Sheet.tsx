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
// 键盘语义（第三期 R1）：调用方必须显式传入 keyboard。
// none：选择面板不包避让、不订阅键盘高度，打开时只发一次收起。
// input：输入面板包库版避让（behavior=padding）并订阅键盘高度。
// 行程只来自实测或同身份缓存。位移、拖拽进度、速度归一共用该值。
// 无缓存时先挂载内容以便测量，测到高度再进场，不用档位比例冒充面板高。
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
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
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
import { useReducedMotion } from '@/adapters/platform/useReducedMotion';
import { haptics } from '@/adapters/platform/haptics';
import AppText from './AppText';
import Icon from './Icon';
import { SoftShadowSurface } from './SoftShadowSurface';
import { usePressFade } from './pressFeedback';
import { handleOverlayBackFor, useOverlayRegistration } from './overlayStack';
import {
  openingPlan,
  readSheetHeight,
  resolveTravelOnMeasure,
  sheetHeightCacheKey,
  travelAfterEnterFinished,
  writeSheetHeight,
  type SheetMeasurePhase,
} from './sheetHeightCache';
import { SheetChrome } from './sheetKeyboardChrome';

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
  /** 退场动画完成（物理卸载）回调 */
  onCloseComplete?: () => void;
  testID?: string;
  /**
   * 键盘语义，调用方必须显式给出。
   * input：包避让并订阅键盘高度。
   * none：选择型，不包避让、不订阅键盘。
   */
  keyboard: 'input' | 'none';
  /** 实测缓存身份。缺省用 testID，再缺省用实例 id（实例 id 不跨卸载）。 */
  measureKey?: string;
  /** 内容几何。变化后不得复用上一份实测高度。 */
  contentKey?: string;
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
 * 行程高度与拖拽进度、速度归一是同一个数。没有实测或缓存时行程为 0，
 * 调用方不得用窗口比例冒充面板高。
 *
 * ⚠️ worklet 内禁止调用 JS 线程模块对象的方法（如 Dimensions.get）：这类对象
 * 被克隆进 worklet 运行时后方法即丢失，调用抛 TypeError: undefined is not a
 * function 并以 CppException 杀死进程（2026-11-01 真机崩溃根因，logcat 签名
 * SheetTsx → useAnimatedStyle → mapperRun）。本函数只收数字。
 * 防再发守卫：src/__tests__/workletSafety.guard.test.ts。
 */
export function sheetPanelTranslateY(
  progress: number,
  travelHeight: number
): number {
  'worklet';
  const height = travelHeight > 0 ? travelHeight : 0;
  return (1 - progress) * height;
}

/** 拖拽进度：下滑 translationY 为正，进度下降。分母必须是行程高度。 */
export function sheetGestureProgress(
  startProgress: number,
  translationY: number,
  travelHeight: number
): number {
  'worklet';
  if (!(travelHeight > 0)) return startProgress;
  const next = startProgress - translationY / travelHeight;
  return Math.min(Math.max(next, 0), 1);
}

/** 下滑速度换成进度/秒（下滑为正 → 进度速度为负）。分母与位移相同。 */
export function sheetGestureVelocity(
  velocityY: number,
  travelHeight: number
): number {
  'worklet';
  if (!(travelHeight > 0)) return 0;
  return -velocityY / travelHeight;
}

/**
 * 手指位移对应的视觉位移。同一行程高度下 10dp 手指 = 10dp 视觉。
 * 若位移用 680、手势用 240，视觉会变成 10 * 680 / 240。
 */
export function sheetFingerVisualDelta(
  startProgress: number,
  translationY: number,
  travelHeight: number
): number {
  'worklet';
  const next = sheetGestureProgress(startProgress, translationY, travelHeight);
  return (
    sheetPanelTranslateY(next, travelHeight) -
    sheetPanelTranslateY(startProgress, travelHeight)
  );
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
  onCloseComplete,
  testID,
  keyboard,
  measureKey,
  contentKey = '',
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
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const effectiveVisible = visible;
  // 关闭时先播出场动画再卸载 Modal（进场则立即挂载）
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) {
    setMounted(true);
  }
  const exitCalledRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onCloseCompleteRef = useRef(onCloseComplete);
  onCloseCompleteRef.current = onCloseComplete;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const phaseRef = useRef<SheetMeasurePhase>('idle');
  const draggingRef = useRef(false);
  const overlayIdentity = measureKey ?? testID ?? generatedOverlayId;
  const cacheKey = sheetHeightCacheKey({
    overlayId: overlayIdentity,
    windowWidth,
    windowHeight,
    size: effectiveSize,
    contentKey,
  });
  const keyRef = useRef(cacheKey);
  keyRef.current = cacheKey;
  const [shadowVisible, setShadowVisible] = useState(false);
  const runtimeRef = useRef({
    reduceMotion,
    expandDuration: theme.motion.duration.expand,
    fastDuration: theme.motion.duration.fast,
    sheetDuration: theme.motion.duration.sheet,
    normalDuration: theme.motion.duration.normal,
    emphasized: theme.motion.easing.emphasized,
    spring: theme.motion.spring.sheet,
  });
  runtimeRef.current = {
    reduceMotion,
    expandDuration: theme.motion.duration.expand,
    fastDuration: theme.motion.duration.fast,
    sheetDuration: theme.motion.duration.sheet,
    normalDuration: theme.motion.duration.normal,
    emphasized: theme.motion.easing.emphasized,
    spring: theme.motion.spring.sheet,
  };

  const handleExitFinished = useCallback(() => {
    if (exitCalledRef.current) return;
    exitCalledRef.current = true;
    phaseRef.current = 'idle';
    setMounted(false);
    onCloseCompleteRef.current?.();
  }, []);
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
  const backdropProgress = useSharedValue(0);
  const panelProgress = useSharedValue(0);
  const travelHeight = useSharedValue(0);
  const latestMeasured = useSharedValue(0);
  const reveal = useSharedValue(0);
  const motionGen = useSharedValue(0);

  const markSettled = useCallback(() => {
    if (phaseRef.current === 'closing' || draggingRef.current) return;
    phaseRef.current = 'settled';
    const travel = travelAfterEnterFinished({
      latestMeasured: latestMeasured.value,
      inFlightTravel: travelHeight.value,
      staleClosureHeight: 0,
    });
    if (travel > 0) {
      travelHeight.value = travel;
      writeSheetHeight(keyRef.current, travel);
    }
    setShadowVisible(true);
  }, [latestMeasured, travelHeight]);

  const beginEnter = useCallback(
    (travel: number) => {
      const rt = runtimeRef.current;
      phaseRef.current = 'animating';
      cancelAnimation(panelProgress);
      cancelAnimation(backdropProgress);
      travelHeight.value = travel;
      panelProgress.value = 0;
      reveal.value = 1;
      setShadowVisible(false);
      const gen = motionGen.value + 1;
      motionGen.value = gen;
      const duration = rt.reduceMotion ? rt.fastDuration : rt.expandDuration;
      backdropProgress.value = withTiming(1, {
        duration,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
      panelProgress.value = withTiming(
        1,
        {
          duration,
          easing: Easing.bezier(...rt.emphasized),
        },
        (finished) => {
          'worklet';
          if (!finished) return;
          if (motionGen.value !== gen) return;
          const measured = latestMeasured.value;
          if (measured > 0) travelHeight.value = measured;
          runOnJS(markSettled)();
        }
      );
    },
    [backdropProgress, latestMeasured, markSettled, motionGen, panelProgress, reveal, travelHeight]
  );

  const beginExit = useCallback(() => {
    if (phaseRef.current === 'closing') return;
    phaseRef.current = 'closing';
    setShadowVisible(false);
    const rt = runtimeRef.current;
    cancelAnimation(panelProgress);
    cancelAnimation(backdropProgress);
    const gen = motionGen.value + 1;
    motionGen.value = gen;
    backdropProgress.value = withTiming(0, {
      duration: rt.reduceMotion ? rt.fastDuration : rt.normalDuration,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
    });
    panelProgress.value = withTiming(
      0,
      {
        duration: rt.reduceMotion ? rt.fastDuration : rt.sheetDuration,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      },
      (finished) => {
        'worklet';
        if (!finished) return;
        if (motionGen.value !== gen) return;
        runOnJS(handleExitFinished)();
      }
    );
  }, [backdropProgress, handleExitFinished, motionGen, panelProgress]);

  const handlePanelLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const h = event.nativeEvent.layout.height;
      if (!(h > 0)) return;
      latestMeasured.value = h;
      const phase = draggingRef.current ? 'animating' : phaseRef.current;
      if (phase === 'waiting') {
        writeSheetHeight(keyRef.current, h);
        beginEnter(h);
        return;
      }
      const next = resolveTravelOnMeasure({
        phase,
        travelHeight: travelHeight.value,
        latestMeasured: h,
      });
      if (next.changed) {
        travelHeight.value = next.travelHeight;
        writeSheetHeight(keyRef.current, next.travelHeight);
      }
    },
    [beginEnter, latestMeasured, travelHeight]
  );

  const handleDismiss = useCallback(() => {
    if (!dismissibleRef.current) return;
    beginExit();
    onCloseRef.current();
  }, [beginExit]);

  const beginDrag = useCallback(() => {
    draggingRef.current = true;
    motionGen.value = motionGen.value + 1;
    setShadowVisible(false);
  }, [motionGen]);

  const endDragSettled = useCallback(() => {
    draggingRef.current = false;
    if (phaseRef.current === 'closing' || phaseRef.current === 'waiting') return;
    phaseRef.current = 'settled';
    setShadowVisible(true);
  }, []);

  const markGestureClosing = useCallback(() => {
    draggingRef.current = false;
    phaseRef.current = 'closing';
    setShadowVisible(false);
  }, []);

  const notifyGestureClose = useCallback(() => {
    haptics.snap();
    draggingRef.current = false;
    phaseRef.current = 'closing';
    setShadowVisible(false);
    onCloseRef.current();
  }, []);

  // 拖拽状态（UI 线程）：内容滚动偏移（>0 时纵向拖动归滚动）、抓手起始进度、
  // 起始触点纵坐标、释放判定是否已由 onEnd 处理（onFinalize 兜底回位用）
  const scrollOffset = useSharedValue(0);
  const dragStartProgress = useSharedValue(1);
  const dragStartY = useSharedValue(0);
  const dragEndHandled = useSharedValue(false);
  const dragActive = useSharedValue(false);
  // 弹簧参数在渲染期取成普通对象（数字字段），供手势 worklet 捕获
  const sheetSpring = theme.motion.spring.sheet;

  useEffect(() => {
    if (visible) {
      exitCalledRef.current = false;
      setMounted(true);
      const plan = openingPlan({
        cached: readSheetHeight(keyRef.current),
        alreadyMeasured: latestMeasured.value,
      });
      if (plan.reveal) {
        beginEnter(plan.travelHeight);
      } else {
        phaseRef.current = 'waiting';
        cancelAnimation(panelProgress);
        cancelAnimation(backdropProgress);
        panelProgress.value = 0;
        backdropProgress.value = 0;
        reveal.value = 0;
        travelHeight.value = 0;
        setShadowVisible(false);
      }
      return;
    }
    if (!mountedRef.current) return;
    beginExit();
    // 兜底卸载：动画回调在测试桩里不会到达，超时后仍只卸载一次。
    const timer = setTimeout(() => handleExitFinished(), 300);
    return () => clearTimeout(timer);
  }, [
    visible,
    beginEnter,
    beginExit,
    handleExitFinished,
    backdropProgress,
    latestMeasured,
    panelProgress,
    reveal,
    travelHeight,
  ]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropProgress.value,
  }));
  const panelStyle = useAnimatedStyle(() => {
    const shown = reveal.value > 0;
    if (reduceMotion) {
      return {
        opacity: shown ? panelProgress.value : 0,
        transform: [{ translateY: 0 }],
      };
    }
    const travel = shown ? travelHeight.value : 0;
    return {
      opacity: shown ? 1 : 0,
      transform: [
        {
          translateY: sheetPanelTranslateY(panelProgress.value, travel),
        },
      ],
    };
  }, [reduceMotion]);

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
      dragActive.value = true;
      dragStartProgress.value = panelProgress.value;
      runOnJS(beginDrag)();
    })
    .onUpdate((event) => {
      const next = sheetGestureProgress(
        dragStartProgress.value,
        event.translationY,
        travelHeight.value
      );
      panelProgress.value = next;
      backdropProgress.value = next;
    })
    .onEnd((event) => {
      dragEndHandled.value = true;
      dragActive.value = false;
      const velocity = sheetGestureVelocity(event.velocityY, travelHeight.value);
      const draggedFraction = dragStartProgress.value - panelProgress.value;
      if (sheetDragCloseDecision(draggedFraction, event.velocityY)) {
        runOnJS(markGestureClosing)();
        panelProgress.value = withSpring(
          0,
          { ...sheetSpring, velocity },
          (finished) => {
            'worklet';
            if (finished) runOnJS(notifyGestureClose)();
          }
        );
        backdropProgress.value = withSpring(0, { ...sheetSpring, velocity });
      } else {
        panelProgress.value = withSpring(
          1,
          { ...sheetSpring, velocity },
          (finished) => {
            'worklet';
            if (finished) runOnJS(endDragSettled)();
          }
        );
        backdropProgress.value = withSpring(1, { ...sheetSpring, velocity });
      }
    })
    .onFinalize(() => {
      // 未真正认领的手势（滚动失败）不得打断进场。
      if (!dragActive.value) return;
      dragActive.value = false;
      if (dragEndHandled.value) return;
      if (panelProgress.value > 0 && panelProgress.value < 1) {
        panelProgress.value = withSpring(
          1,
          { ...sheetSpring },
          (finished) => {
            'worklet';
            if (finished) runOnJS(endDragSettled)();
          }
        );
        backdropProgress.value = withSpring(1, { ...sheetSpring });
      } else {
        runOnJS(endDragSettled)();
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
          <SheetChrome keyboard={keyboard} visible={visible}>
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
                    shadowVisible={shadowVisible}
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
          </SheetChrome>
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
