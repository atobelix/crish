// 语音交互浮层（新一代全宽沉浸式流光大球 + 左右双翼弧形胶囊）与模型下载门：
// 1. 浮层形态重构与几何自适应（2026-11-04 视觉与交互适配：流光大球与输入框精细化呼吸搭配）：
//    - 宽度与居中自适应：告别硬编码 390dp 视口，根据真机视口宽度（useWindowDimensions）动态计算左右双翼弧形胶囊，
//      左右对称留白与黄金 94px 间隙动态定心，全屏真机零偏心；
//    - 垂直几何锚定与贴合：消费 SafeAreaInsetsContext（安全兼容无 Provider 环境），
//      使底部安全间距与输入框卡体的物理底缘（Math.max(insets.bottom, theme.space.sm)）严格一致；
//    - 双层遮罩架构（用户裁决）：
//      第一层（底层底衬遮罩）：以主对话界面背景色（theme.colors.canvas）实色完全封死输入框与安全区，
//      彻底杜绝下层文字、图标、模型选择器“串戏”；在球形偏上部分下方平滑线性过渡渐隐融于对话流；
//      第二层（流光大球层）：温润大球发光体（RadialGradient）在底衬之上纯净升起，高空余弦漫散；
//    - 胶囊与提示语高对比度可见性：弧形胶囊底衬与文字告别浅白盲区，以 surfaceTranslucentStrong / textPrimary
//      提供极佳可读对比度；状态切换时生动呈现 danger 红与 info 蓝强反差；
//    - 丝滑交互动效：环境脉搏呼吸（1.0 ~ 1.035）与语音电平（level）共鸣膨胀；音浪波形条随声波起伏跳动；
//    - 严格遵循用户红线：严禁使用安卓默认原生生硬阴影，纯粹融于背景光芒与软阴影（SoftShadowSurface）；
//    - 撤销红态平滑自然漫散，中心红度克制，向外平滑衰减；
//    - 居中提示语独立 HUD 胶囊位（bottom: 206px），上下错开永不碰撞；
//    - 状态切换联动 haptics.snap() 触感。
// 1.1 三层层模型（2026-11-05 用户实测卡手/露白/条纹不清事故根治）：
//    - shield（底衬遮罩）/ dome（流光大球）/ arcs（双翼胶囊）拆为三个兄弟
//      <Svg> 层——domeAnimatedStyle 只作用于 dome 层；shield 恒定贴底封死
//      输入区（旧实现三层共挂一个 wrapper，手指一动整块底衬跟着位移、
//      底部露出主界面白色区域）；
//    - 大球行程收敛（2026-11-05 返工，方案波 4b 口径）：drag 磁吸平移
//      ±20dp、上滑提拉 −10dp，变换原点钉底边中心（transformOrigin
//      '50% 100%'），缩放/张力绕底边中心展开——旧 ±65/-30 大行程未收敛
//      版本已废除（此前头注曾误把旧值写成定案，特此更正）；
//    - 波形电平改 SharedValue 在 UI 线程驱动（WaveTick 组件逐条
//      useAnimatedStyle 读 level.value）：ASR 电平回调只写 SharedValue，
//      31 根条退出 React render 路径（旧实现 number prop 逐回调整排重渲）；
//    - 弧形胶囊 SvgText 严禁 alignmentBaseline（react-native-svg 的
//      TextPathMethod 枚举无 central，Fabric 预分配视图即 IllegalArgumentException
//      杀进程——实机 5 次崩溃，见战役 findings/04 B3 链）；基线居中由轨迹
//      几何承担；
//    - 微音浪条重定位到弧带与实色区过渡带（WAVE_BAR_BOTTOM_DP=150）并改
//      反差配色（send=onMedia），旧锚定同色叠在光球最亮核心上不可辨。
// 2. 错误条与下载门：VoiceErrorBar 与 VoiceModelGate 原生保留，诚实保障离线模型交付。
import { useContext, useEffect, useRef, type ReactNode } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  interpolate,
  Easing as ReanimatedEasing,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, {
  Defs,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
  Text as SvgText,
  TextPath,
} from 'react-native-svg';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';
import { formatBytes, type AsrModelState } from '@/adapters/asr/modelManager';
import type {
  VoiceErrorState,
  VoiceRecovery,
} from '@/adapters/asr/useVoiceInput';
import type { VoicePhase } from '@/domain/asr/voiceInputMachine';
import AppText from './AppText';
import Dialog from './Dialog';
import Icon from './Icon';
import { SoftShadowSurface } from './SoftShadowSurface';
import Spinner from './Spinner';

const DEFAULT_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

/**
 * 微音浪条的垂直锚定（workspace 底部起算，dp）：
 * 弧形胶囊带占据 workspace 底部 ≈128~200（弧线 y 199~233 ± strokeWidth/2 19，
 * 换算 380 - y），HUD 提示语底缘在 206——旧锚定（输入中线-12 ≈ 14~46）压在
 * shield 实色区内部、且同色叠在光球最亮核心上，可读性趋近于零（2026-11-05
 * 用户实测）。新锚定 150 = 弧带下缘（128）与 shield 实色上缘（≈118+）之间
 * 的过渡带中点：低于弧线不会与笔画相交（弧线在该高度已外扩至 |x|>100），
 * 高于实色区不压输入卡，球体在该高度已渐弱、反差配色下清晰可辨。
 */
const WAVE_BAR_BOTTOM_DP = 150;

/** 波形条形状表（31 根：钟形包络 × 谐波系数——纯静态量，模块级预计算；
 *  高度动态部分由 WaveTick 在 UI 线程按 level SharedValue 逐帧推导） */
const WAVE_TICKS = Array.from({ length: 31 }, (_, i) => {
  const norm = i / 30;
  return {
    bell: Math.sin(norm * Math.PI),
    harmonic: (i % 2 === 0 ? 1 : 0.82) * (i % 3 === 0 ? 1.15 : 0.9),
  };
});

function useSafeInsets() {
  const insets = useContext(SafeAreaInsetsContext);
  return insets ?? DEFAULT_INSETS;
}

export interface VoiceOverlayProps {
  phase: VoicePhase;
  starting: boolean;
  displayText: string;
  /** 波形电平 0..1（SharedValue：UI 线程驱动大球共鸣与波形条，不进 render 路径） */
  level: SharedValue<number>;
  /** 手势拖拽位移驱动流光大球水滴磁吸形变 */
  dragX?: SharedValue<number>;
  dragY?: SharedValue<number>;
}

export function VoiceOverlay({
  phase,
  starting,
  displayText,
  level,
  dragX,
  dragY,
}: VoiceOverlayProps) {
  const theme = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeInsets();
  const visible = starting || phase !== 'idle';
  const cancelling = phase === 'cancelling';
  const editing = phase === 'editing';

  // 垂直几何锚定：与输入框底缘 Math.max(insets.bottom, theme.space.sm) 保持严密一致
  const bottomPadding = Math.max(insets.bottom, theme.space.sm);

  // 总工作区高度与 SVG 贴地高度（彻底覆盖底部安全区与输入框底盘，杜绝漏底与串戏）
  const workspaceHeight = 380;
  const totalSvgHeight = workspaceHeight + bottomPadding;

  // 动态屏幕宽度居中适配：
  // 左右弧形胶囊平缓微拱（倾角约 14°，两翼向外延伸 168dp，中央走廊留白 92dp）
  // 在任何屏幕宽度（360dp、390dp、412dp、430dp 等）下均严格绝对对称居中
  const centerX = Math.round(screenWidth / 2);
  const leftArcD = `M ${centerX - 168},230 C ${centerX - 128},214 ${centerX - 88},203 ${centerX - 46},200`;
  const rightArcD = `M ${centerX + 46},200 C ${centerX + 88},203 ${centerX + 128},214 ${centerX + 168},230`;

  // 文字排版安全轨道：借用两端 19px 圆角空间向外延伸，轨道物理弧长达 142dp；
  // 基线居中由轨迹几何本身承担（轨道走向直接对齐文字中线）——严禁给
  // SvgText/TextPath 设置 alignmentBaseline：react-native-svg 的
  // TextPathMethod 枚举无 central，设置即在 Fabric 预分配视图时崩溃（见 §1.1）
  const leftTrackD = `M ${centerX - 176},233 C ${centerX - 132},215 ${centerX - 84},202 ${centerX - 38},199`;
  const rightTrackD = `M ${centerX + 38},199 C ${centerX + 84},202 ${centerX + 132},215 ${centerX + 176},233`;

  // 触觉咬合联动 (进入左撤销或右编辑时触发轻脆吸附感)
  const prevPhaseRef = useRef<VoicePhase>('idle');
  useEffect(() => {
    if (visible && prevPhaseRef.current !== phase) {
      if (phase === 'cancelling' || phase === 'editing') {
        haptics.snap();
      } else if (phase === 'recording' && prevPhaseRef.current !== 'idle') {
        haptics.selection();
      }
      prevPhaseRef.current = phase;
    }
  }, [phase, visible]);

  // 浮层进出场动画驱动
  const enterProgress = useSharedValue(0);
  useEffect(() => {
    if (visible) {
      enterProgress.value = withTiming(1, {
        duration: theme.motion.duration.sheet,
        easing: ReanimatedEasing.bezier(0.16, 1, 0.3, 1),
      });
    } else {
      enterProgress.value = withTiming(0, {
        duration: theme.motion.duration.fast,
        easing: ReanimatedEasing.out(ReanimatedEasing.quad),
      });
    }
  }, [visible, enterProgress, theme.motion.duration]);

  // 大球发光体自然呼吸脉冲（生命力动效：待机微呼吸 + 说话声波共鸣膨胀）
  const breatheDuration = theme.motion.duration.settle * 4;
  const breatheAnim = useSharedValue(1);
  useEffect(() => {
    if (visible) {
      breatheAnim.value = withRepeat(
        withSequence(
          withTiming(1.035, {
            duration: breatheDuration,
            easing: ReanimatedEasing.inOut(ReanimatedEasing.ease),
          }),
          withTiming(1.0, {
            duration: breatheDuration,
            easing: ReanimatedEasing.inOut(ReanimatedEasing.ease),
          })
        ),
        -1,
        true
      );
    } else {
      breatheAnim.value = 1;
    }
  }, [visible, breatheAnim, breatheDuration]);

  // 手势位移响应（未传入时内部提供静止兜底值）
  const fallbackDragX = useSharedValue(0);
  const fallbackDragY = useSharedValue(0);
  const effectiveDragX = dragX ?? fallbackDragX;
  const effectiveDragY = dragY ?? fallbackDragY;

  // “正在聆听…”背衬声波雷达隔离波纹（错开双层扩散圆角矩形，与下层主对话文字动态隔离）
  const rippleProgress1 = useSharedValue(0);
  const rippleProgress2 = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      rippleProgress1.value = 0;
      rippleProgress2.value = 0;
      rippleProgress1.value = withRepeat(
        withTiming(1, {
          duration: 2000,
          easing: ReanimatedEasing.out(ReanimatedEasing.quad),
        }),
        -1,
        false
      );
      const timer = setTimeout(() => {
        rippleProgress2.value = withRepeat(
          withTiming(1, {
            duration: 2000,
            easing: ReanimatedEasing.out(ReanimatedEasing.quad),
          }),
          -1,
          false
        );
      }, 1000);
      return () => {
        clearTimeout(timer);
      };
    }
    rippleProgress1.value = 0;
    rippleProgress2.value = 0;
    return undefined;
  }, [visible, rippleProgress1, rippleProgress2]);

  const rippleStyle1 = useAnimatedStyle(() => {
    const scale = interpolate(rippleProgress1.value, [0, 1], [0.98, 1.12]);
    const opacity = interpolate(
      rippleProgress1.value,
      [0, 0.25, 1],
      [0.45, 0.2, 0]
    );
    return {
      transform: [{ scale }],
      opacity,
    };
  });

  const rippleStyle2 = useAnimatedStyle(() => {
    const scale = interpolate(rippleProgress2.value, [0, 1], [0.98, 1.12]);
    const opacity = interpolate(
      rippleProgress2.value,
      [0, 0.25, 1],
      [0.45, 0.2, 0]
    );
    return {
      transform: [{ scale }],
      opacity,
    };
  });

  const layerAnimatedStyle = useAnimatedStyle(() => {
    return {
      opacity: enterProgress.value,
      transform: [
        {
          translateY: interpolate(enterProgress.value, [0, 1], [30, 0]),
        },
      ],
    };
  });

  const domeAnimatedStyle = useAnimatedStyle(() => {
    // 基础呼吸脉冲 (1 ~ 1.035) + 语音电平强力膨胀共振 (level * 0.08)
    const totalScale = breatheAnim.value + level.value * 0.08;
    // 随手指滑动的磁吸牵引位移（行程收敛：最大平移 ±20dp，方案波 4b 口径）
    const offsetX = interpolate(
      effectiveDragX.value,
      [-200, 0, 200],
      [-20, 0, 20],
      'clamp'
    );
    // 纵向上滑提拉（手指往上滑动时，大球向上拉起，最大提拉 10dp）
    const offsetY = interpolate(
      effectiveDragY.value,
      [-200, 0, 100],
      [-10, 0, 0],
      'clamp'
    );
    // 触感张力：横向与纵向水滴微形变
    const stretchX = interpolate(
      Math.abs(effectiveDragX.value),
      [0, 160],
      [1, 1.05],
      'clamp'
    );
    const stretchY = interpolate(
      Math.abs(effectiveDragY.value),
      [0, 160],
      [1, 1.04],
      'clamp'
    );

    return {
      // 变换原点钉底边中心：缩放/张力绕大球底边中点展开，底缘不漂移
      transformOrigin: '50% 100%',
      transform: [
        { translateX: offsetX },
        { translateY: offsetY },
        { scale: totalScale },
        { scaleX: stretchX },
        { scaleY: stretchY },
      ],
    };
  });

  // 高空 HUD 提示语文本
  const hintText = starting
    ? '正在准备…'
    : phase === 'finishing'
      ? '正在识别…'
      : cancelling
        ? '松手撤销'
        : editing
          ? '松手编辑'
          : '松手发送，左右滑动';

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
    >
      <View style={styles.modalBackdrop} pointerEvents="none">
        <Animated.View
          testID="voice-overlay-container"
          style={[
            styles.mainContainer,
            { paddingBottom: bottomPadding },
            layerAnimatedStyle,
          ]}
        >
          {/* 1. 顶部转写文本气泡卡片：背衬动态雷达扩散隔离波纹 + SoftShadowSurface 软阴影，彻底去除生硬描边 */}
          <View style={styles.previewCardWrapper}>
            <Animated.View
              pointerEvents="none"
              style={[
                styles.rippleHalo,
                {
                  width: Math.min(screenWidth - 32, 520),
                  borderRadius: theme.radius.xl,
                  backgroundColor: cancelling
                    ? theme.colors.dangerSoft
                    : editing
                      ? theme.colors.infoSoft
                      : theme.colors.actionPrimary,
                },
                rippleStyle1,
              ]}
            />
            <Animated.View
              pointerEvents="none"
              style={[
                styles.rippleHalo,
                {
                  width: Math.min(screenWidth - 32, 520),
                  borderRadius: theme.radius.xl,
                  backgroundColor: cancelling
                    ? theme.colors.dangerSoft
                    : editing
                      ? theme.colors.infoSoft
                      : theme.colors.actionPrimary,
                },
                rippleStyle2,
              ]}
            />
            <SoftShadowSurface
              preset="voiceCard"
              borderRadius={theme.radius.xl}
              fill={theme.colors.surface}
              fillStyle={[
                styles.previewCard,
                {
                  width: Math.min(screenWidth - 32, 520),
                },
              ]}
            >
              <AppText
                variant="body"
                color={
                  cancelling
                    ? 'danger'
                    : displayText
                      ? 'textPrimary'
                      : 'textTertiary'
                }
                numberOfLines={3}
                style={[styles.previewText, cancelling && styles.strikeText]}
              >
                {displayText || (starting ? '正在准备…' : '正在聆听…')}
              </AppText>
            </SoftShadowSurface>
          </View>

          {/* 2. 交互大球与双翼弧形胶囊工作区（2026-11-05 三层层模型）：
              shield / dome / arcs 三个兄弟层各自持有独立 <Svg>——拖拽与呼吸
              变换（domeAnimatedStyle）只允许作用于 dome 层；shield 职责是
              恒定贴底封死输入区（旧实现三层共挂一个 wrapper，手指一动整块
              底衬跟着位移、底部露出主界面 = "下面整块都在动/露白"事故根因） */}
          <View style={styles.archWorkspace}>
            {/* 第一层：对话界面实色底衬遮罩（零 transform，恒定贴底） */}
            <Animated.View
              style={[
                styles.svgLayer,
                { bottom: -bottomPadding, height: totalSvgHeight },
              ]}
            >
              <Svg
                width={screenWidth}
                height={totalSvgHeight}
                viewBox={`0 0 ${screenWidth} ${totalSvgHeight}`}
                style={styles.svgCanvas}
              >
                <Defs>
                  {/* 遮罩渐变：底部实色（theme.colors.canvas）100% 遮死输入框
                      与安全区；向上平滑渐变到透明融于主对话流 */}
                  <LinearGradient
                    id="bg-canvas-shield"
                    x1="0"
                    y1={totalSvgHeight}
                    x2="0"
                    y2="0"
                    gradientUnits="userSpaceOnUse"
                  >
                    <Stop
                      offset="0%"
                      stopColor={theme.colors.canvas}
                      stopOpacity={1}
                    />
                    <Stop
                      offset={`${Math.min(88, Math.round(((bottomPadding + 118) / totalSvgHeight) * 100))}%`}
                      stopColor={theme.colors.canvas}
                      stopOpacity={1}
                    />
                    <Stop
                      offset={`${Math.min(94, Math.round(((bottomPadding + 210) / totalSvgHeight) * 100))}%`}
                      stopColor={theme.colors.canvas}
                      stopOpacity={0.65}
                    />
                    <Stop
                      offset="100%"
                      stopColor={theme.colors.canvas}
                      stopOpacity={0}
                    />
                  </LinearGradient>
                </Defs>

                <Rect
                  x="0"
                  y="0"
                  width={screenWidth}
                  height={totalSvgHeight}
                  fill="url(#bg-canvas-shield)"
                />
              </Svg>
            </Animated.View>

            {/* 第二层：流光大球发光体（唯一挂 domeAnimatedStyle 的层） */}
            <Animated.View
              style={[
                styles.svgLayer,
                { bottom: -bottomPadding, height: totalSvgHeight },
                domeAnimatedStyle,
              ]}
            >
              <Svg
                width={screenWidth}
                height={totalSvgHeight}
                viewBox={`0 0 ${screenWidth} ${totalSvgHeight}`}
                style={styles.svgCanvas}
              >
                <Defs>

                  {/* 第二层流光大球：正常说话态清透翡翠绿大球 (高阶平滑余弦衰减) */}
                  <RadialGradient
                    id="dome-send"
                    cx="50%"
                    cy="100%"
                    rx="85%"
                    ry="82%"
                    fx="50%"
                    fy="100%"
                  >
                    <Stop
                      offset="0%"
                      stopColor={theme.colors.actionPrimary}
                      stopOpacity={0.92}
                    />
                    <Stop
                      offset="26%"
                      stopColor={theme.colors.actionPrimary}
                      stopOpacity={0.82}
                    />
                    <Stop
                      offset="48%"
                      stopColor={theme.colors.brandSoft}
                      stopOpacity={0.62}
                    />
                    <Stop
                      offset="72%"
                      stopColor={theme.colors.fillSubtle}
                      stopOpacity={0.35}
                    />
                    <Stop
                      offset="88%"
                      stopColor={theme.colors.fillSubtle}
                      stopOpacity={0.12}
                    />
                    <Stop
                      offset="100%"
                      stopColor={theme.colors.fillSubtle}
                      stopOpacity={0}
                    />
                  </RadialGradient>

                  {/* 撤销态：低浓度柔绯大球 (中心不浓红、两边柔和漫射托底、绝非中间红两边白) */}
                  <RadialGradient
                    id="dome-cancel"
                    cx="50%"
                    cy="100%"
                    rx="85%"
                    ry="82%"
                    fx="50%"
                    fy="100%"
                  >
                    <Stop
                      offset="0%"
                      stopColor={theme.colors.danger}
                      stopOpacity={0.48}
                    />
                    <Stop
                      offset="28%"
                      stopColor={theme.colors.danger}
                      stopOpacity={0.38}
                    />
                    <Stop
                      offset="54%"
                      stopColor={theme.colors.dangerSoft}
                      stopOpacity={0.25}
                    />
                    <Stop
                      offset="76%"
                      stopColor={theme.colors.dangerSoft}
                      stopOpacity={0.12}
                    />
                    <Stop
                      offset="92%"
                      stopColor={theme.colors.dangerSoft}
                      stopOpacity={0.04}
                    />
                    <Stop
                      offset="100%"
                      stopColor={theme.colors.dangerSoft}
                      stopOpacity={0}
                    />
                  </RadialGradient>

                  {/* 编辑态：清爽天青蓝大球 */}
                  <RadialGradient
                    id="dome-edit"
                    cx="50%"
                    cy="100%"
                    rx="85%"
                    ry="82%"
                    fx="50%"
                    fy="100%"
                  >
                    <Stop
                      offset="0%"
                      stopColor={theme.colors.info}
                      stopOpacity={0.88}
                    />
                    <Stop
                      offset="26%"
                      stopColor={theme.colors.info}
                      stopOpacity={0.76}
                    />
                    <Stop
                      offset="50%"
                      stopColor={theme.colors.infoSoft}
                      stopOpacity={0.55}
                    />
                    <Stop
                      offset="72%"
                      stopColor={theme.colors.fillSubtle}
                      stopOpacity={0.32}
                    />
                    <Stop
                      offset="90%"
                      stopColor={theme.colors.fillSubtle}
                      stopOpacity={0.1}
                    />
                    <Stop
                      offset="100%"
                      stopColor={theme.colors.fillSubtle}
                      stopOpacity={0}
                    />
                  </RadialGradient>
                </Defs>

                {/* 流光大球发光体矩形背景（随 domeAnimatedStyle 平移/呼吸/张力） */}
                <Rect
                  x="0"
                  y="0"
                  width={screenWidth}
                  height={totalSvgHeight}
                  fill={`url(#dome-${cancelling ? 'cancel' : editing ? 'edit' : 'send'})`}
                />
              </Svg>
            </Animated.View>

            {/* 第三层：双翼弧形胶囊（零 transform——胶囊与轨迹文字钉死在
                workspace 几何上，不随球体磁吸位移；相位切换仅换色） */}
            <Animated.View
              style={[
                styles.svgLayer,
                { bottom: -bottomPadding, height: totalSvgHeight },
              ]}
            >
              <Svg
                width={screenWidth}
                height={totalSvgHeight}
                viewBox={`0 0 ${screenWidth} ${totalSvgHeight}`}
                style={styles.svgCanvas}
              >
                <Defs>
                  {/* 黄金留白 92px 文字排版安全轨迹 (物理弧长 142dp，配合居中对齐绝不截断) */}
                  <Path id="left-arc-track" d={leftTrackD} />
                  <Path id="right-arc-track" d={rightTrackD} />
                </Defs>

                {/* 1 区：左侧弧形撤销胶囊 (微拱 14°，居中对齐，彻底防止偏上与吃字) */}
                <Path
                  d={leftArcD}
                  fill="none"
                  stroke={
                    cancelling ? theme.colors.danger : theme.colors.surface
                  }
                  strokeWidth={38}
                  strokeLinecap="round"
                  strokeOpacity={cancelling ? 0.95 : 0.92}
                />
                <SvgText
                  fill={
                    cancelling
                      ? theme.colors.onMedia
                      : editing
                        ? theme.colors.textTertiary
                        : theme.colors.textPrimary
                  }
                  fontSize={theme.type.footnote.fontSize}
                  fontWeight={cancelling ? '700' : '600'}
                  letterSpacing={0.2}
                >
                  <TextPath
                    href="#left-arc-track"
                    startOffset="50%"
                    textAnchor="middle"
                  >
                    {cancelling ? '✕ 松开撤销' : '✕ 左滑撤销'}
                  </TextPath>
                </SvgText>

                {/* 2 区：右侧弧形编辑胶囊 (微拱 14°，居中对齐，彻底防止偏上与吃字) */}
                <Path
                  d={rightArcD}
                  fill="none"
                  stroke={editing ? theme.colors.info : theme.colors.surface}
                  strokeWidth={38}
                  strokeLinecap="round"
                  strokeOpacity={editing ? 0.95 : 0.92}
                />
                <SvgText
                  fill={
                    editing
                      ? theme.colors.onMedia
                      : cancelling
                        ? theme.colors.textTertiary
                        : theme.colors.textPrimary
                  }
                  fontSize={theme.type.footnote.fontSize}
                  fontWeight={editing ? '700' : '600'}
                  letterSpacing={0.2}
                >
                  <TextPath
                    href="#right-arc-track"
                    startOffset="50%"
                    textAnchor="middle"
                  >
                    {editing ? '松开编辑 ✎' : '右滑编辑 ✎'}
                  </TextPath>
                </SvgText>
              </Svg>
            </Animated.View>

            {/* 3. 高空独立 HUD 居中提示语 (纯净半透无描边微胶囊底衬，全天候清晰可见，彻底去除生硬描边) */}
            <View style={styles.centerTipContainer}>
              <View
                style={[
                  styles.centerTipBadge,
                  {
                    backgroundColor: cancelling
                      ? theme.colors.dangerSoft
                      : editing
                        ? theme.colors.infoSoft
                        : theme.colors.surfaceTranslucentStrong,
                    borderRadius: theme.radius.pill,
                  },
                ]}
              >
                <AppText
                  variant="callout"
                  style={[
                    styles.centerTipText,
                    {
                      color: cancelling
                        ? theme.colors.danger
                        : editing
                          ? theme.colors.info
                          : theme.colors.textPrimary,
                    },
                  ]}
                >
                  {hintText}
                </AppText>
              </View>
            </View>

            {/* 4. 微声波跳动条（随音频电平 level 跳跃与谐波共振）。
                2026-11-05 重定位：锚定弧带与 shield 实色区之间的过渡带
                （WAVE_BAR_BOTTOM_DP=150，几何推导见常量注释）——旧锚定
                （输入中线-12）压在输入卡区且同色叠在光球最亮核心上，
                对比度趋近于零（用户实测"条纹看不清楚"）。配色改为与球色
                反差系（send=onMedia / cancel=danger / edit=info），静止
                参考系不随球体磁吸位移，保证全程可辨。高度由 WaveTick 在
                UI 线程按 level SharedValue 推导，电平回调不触发重渲。 */}
            <View
              testID="voice-overlay-wave-bar"
              style={[styles.waveBarContainer, { bottom: WAVE_BAR_BOTTOM_DP }]}
            >
              {WAVE_TICKS.map((tick, i) => (
                <WaveTick
                  key={i}
                  level={level}
                  bell={tick.bell}
                  harmonic={tick.harmonic}
                  color={
                    cancelling
                      ? theme.colors.danger
                      : editing
                        ? theme.colors.info
                        : theme.colors.onMedia
                  }
                  radius={theme.radius.pill}
                />
              ))}
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

/**
 * 单根微声波条：高度由 level（SharedValue）在 UI 线程逐帧推导——ASR
 * 电平回调只写 SharedValue，本组件不进 React render 路径（旧实现 31 根
 * 条在 render 内以 number 电平逐条算高，电平每回调一次整排重渲，是输入
 * 延迟基线的一条来源）。bell/harmonic 为静态形状参数，color/radius 随
 * 阶段变化（阶段切换频率远低于电平 tick，重渲可忽略）。
 */
function WaveTick({
  level,
  bell,
  harmonic,
  color,
  radius,
}: {
  level: SharedValue<number>;
  bell: number;
  harmonic: number;
  color: string;
  radius: number;
}) {
  const tickStyle = useAnimatedStyle(() => {
    const dynamicJump =
      bell * Math.min(22, level.value * 28 * harmonic + 2);
    return { height: Math.max(6, 6 + dynamicJump) };
  });
  return (
    <Animated.View
      style={[
        styles.waveTick,
        {
          opacity: 0.7 + bell * 0.3,
          backgroundColor: color,
          borderRadius: radius,
        },
        tickStyle,
      ]}
    />
  );
}

/** 恢复通道 → 动作钮文案 */
const RECOVERY_LABELS: Record<VoiceRecovery, string> = {
  'retry-init': '重新初始化',
  'retry-capture': '重试',
  'open-settings': '去设置',
};

export interface VoiceErrorBarProps {
  error: VoiceErrorState | null;
  onRecover: () => void;
  onDismiss: () => void;
}

/**
 * 语音硬错误条（Composer 上方常驻）：错误文案 + 按根因接真实通道的
 * 恢复动作（重新初始化引擎/去系统设置/重试采集）+ 关闭。
 * 无阴影（错误条是贴面信息层，不浮起）。
 */
export function VoiceErrorBar({
  error,
  onRecover,
  onDismiss,
}: VoiceErrorBarProps) {
  const theme = useTheme();
  if (!error) return null;
  return (
    <View
      testID="voice-error-bar"
      style={[
        styles.errorBar,
        {
          backgroundColor: theme.colors.dangerSoft,
          borderRadius: theme.radius.control,
          marginBottom: theme.space.sm,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.sm,
          gap: theme.space.sm,
        },
      ]}
    >
      <AppText variant="footnote" color="danger" style={styles.errorText}>
        {error.message}
      </AppText>
      {error.recovery ? (
        <Pressable
          testID="voice-error-recover"
          onPress={onRecover}
          accessibilityRole="button"
          accessibilityLabel={RECOVERY_LABELS[error.recovery]}
          hitSlop={6}
        >
          <AppText variant="footnote" color="danger" style={styles.errorAction}>
            {RECOVERY_LABELS[error.recovery]}
          </AppText>
        </Pressable>
      ) : null}
      <Pressable
        testID="voice-error-dismiss"
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="关闭"
        hitSlop={6}
      >
        <Icon name="x" size={14} color={theme.colors.danger} />
      </Pressable>
    </View>
  );
}

export interface VoiceModelGateProps {
  visible: boolean;
  state: AsrModelState | null;
  /** 模型总字节数（文案用） */
  modelTotalBytes: number;
  onConfirmDownload: () => void;
  onDismiss: () => void;
}

export function VoiceModelGate({
  visible,
  state,
  modelTotalBytes,
  onConfirmDownload,
  onDismiss,
}: VoiceModelGateProps) {
  const theme = useTheme();
  const totalMb = Math.round(modelTotalBytes / (1024 * 1024));
  let description: string;
  let primaryLabel: string | null = '下载模型';
  let content: ReactNode = null;

  if (state?.kind === 'downloading') {
    const percent = Math.round(state.overallFraction * 100);
    const received = formatBytes(state.receivedBytes);
    const total = formatBytes(state.totalBytes);
    const fileIndex = 'fileIndex' in state ? state.fileIndex : 1;
    const totalFiles = 'totalFiles' in state ? state.totalFiles : 3;
    description = `正在下载 ${state.fileName} (${fileIndex}/${totalFiles})\n已完成 ${received} / ${total}（总进度 ${percent}%）。\n可收起此弹窗，下载会在后台继续。`;
    primaryLabel = null;
    const fraction = Math.max(0, Math.min(1, state.overallFraction));
    content = (
      <View style={styles.gateProgressContainer}>
        <View
          style={[
            styles.gateProgressBarTrack,
            {
              backgroundColor: theme.colors.fillSubtle,
              borderRadius: theme.radius.pill,
            },
          ]}
        >
          <View
            style={[
              styles.gateProgressBarFill,
              {
                width: `${Math.round(fraction * 100)}%`,
                backgroundColor: theme.colors.actionPrimary,
                borderRadius: theme.radius.pill,
              },
            ]}
          />
        </View>
      </View>
    );
  } else if (state?.kind === 'verifying') {
    const fileIndex = 'fileIndex' in state ? state.fileIndex : 1;
    const totalFiles = 'totalFiles' in state ? state.totalFiles : 3;
    description = `正在高速校验 ${state.fileName} (${fileIndex}/${totalFiles}) 的完整性…`;
    primaryLabel = null;
    content = (
      <View style={styles.gateVerifyingContainer}>
        <Spinner size="small" />
      </View>
    );
  } else if (state?.kind === 'error') {
    description = `下载失败：${state.message}。请检查网络后重试。`;
    primaryLabel = '重试';
  } else {
    description = `按住说话使用本机离线识别，需要先下载语音模型（约 ${totalMb}MB，建议 Wi-Fi 环境）。`;
  }

  // 校验完成后自动关闭弹窗无缝就绪
  useEffect(() => {
    if (state?.kind === 'ready') {
      onDismiss();
    }
  }, [state?.kind, onDismiss]);

  return (
    <Dialog
      visible={visible}
      title="离线语音模型"
      description={description}
      testID="voice-model-gate"
      onDismiss={onDismiss}
      actions={[
        {
          label: primaryLabel === null ? '收起' : '取消',
          variant: 'secondary',
          onPress: onDismiss,
          testID: 'voice-model-gate-dismiss',
        },
        ...(primaryLabel !== null
          ? [
              {
                label: primaryLabel,
                variant: 'primary' as const,
                onPress: onConfirmDownload,
                testID: 'voice-model-gate-confirm',
              },
            ]
          : []),
      ]}
    >
      {content}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  mainContainer: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  // 预览文字卡片背衬容器：承载雷达隔离波纹
  previewCardWrapper: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  // 动态雷达声波隔离环：柔和圆角矩形扩散波
  rippleHalo: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    alignSelf: 'center',
  },
  // 预览文字卡片：经 SoftShadowSurface 软阴影，彻底去除生硬描边
  previewCard: {
    minHeight: 88,
    borderWidth: 0,
    paddingHorizontal: 20,
    paddingVertical: 16,
    justifyContent: 'center',
  },
  previewText: {
    textAlign: 'center',
  },
  strikeText: {
    textDecorationLine: 'line-through',
  },
  // 交互大球工作区：宽度全屏弹性拉伸，高度 380dp
  archWorkspace: {
    width: '100%',
    height: 380,
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  // 三层兄弟层的公共定位（shield/dome/arcs 各自绝对贴底、全宽；transform
  // 仅经 domeAnimatedStyle 作用于 dome 层，见 JSX 三层模型注释）
  svgLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  svgCanvas: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  // 高空独立 HUD 位 (bottom: 206px，彻底上下错开)
  centerTipContainer: {
    position: 'absolute',
    bottom: 206,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  centerTipBadge: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerTipText: {
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  // 底部微音浪波形 (高度随音频电平跳动，底部锚定与输入框中线精细贴合)
  waveBarContainer: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3.5,
    height: 24,
  },
  waveTick: {
    width: 2.5,
  },
  // 错误条
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  errorText: {
    flex: 1,
  },
  errorAction: {
    fontWeight: '600',
  },
  gateProgressContainer: {
    width: '100%',
    marginTop: 12,
    marginBottom: 4,
  },
  gateProgressBarTrack: {
    width: '100%',
    height: 6,
    overflow: 'hidden',
  },
  gateProgressBarFill: {
    height: '100%',
  },
  gateVerifyingContainer: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
});

export default VoiceOverlay;
