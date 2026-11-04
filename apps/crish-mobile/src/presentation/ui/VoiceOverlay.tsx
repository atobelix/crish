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

function useSafeInsets() {
  const insets = useContext(SafeAreaInsetsContext);
  return insets ?? DEFAULT_INSETS;
}

export interface VoiceOverlayProps {
  phase: VoicePhase;
  starting: boolean;
  displayText: string;
  /** 波形电平 0..1 */
  level: number;
  /**
   * 宿主输入框卡体实际高度（dp）：单行 52、两行 98 或多行实测高。
   * 用于底部大球光晕中心与微音浪的垂直位置呼吸锚定，与输入框卡体形成紧密贴合。
   */
  composerHeight?: number;
  /**
   * 可选底部安全边距覆盖（dp）；未提供时自动消费 SafeAreaInsetsContext。
   */
  bottomInset?: number;
}

export function VoiceOverlay({
  phase,
  starting,
  displayText,
  level,
  composerHeight,
  bottomInset,
}: VoiceOverlayProps) {
  const theme = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeInsets();
  const visible = starting || phase !== 'idle';
  const cancelling = phase === 'cancelling';
  const editing = phase === 'editing';

  // 垂直几何锚定：与输入框底缘 Math.max(insets.bottom, theme.space.sm) 保持严密一致
  const effectiveBottomInset = bottomInset ?? insets.bottom;
  const bottomPadding = Math.max(effectiveBottomInset, theme.space.sm);

  // 宿主输入框高度与微音浪呼吸对齐（单行 52 居中于 26、两行 98 首行居中于 70）
  const hostCardHeight = composerHeight ?? theme.size.composerMin;
  const inputCenterFromBottom =
    hostCardHeight > 64 ? hostCardHeight - 28 : Math.round(hostCardHeight / 2);
  const waveBottom = Math.max(14, inputCenterFromBottom - 12);

  // 总工作区高度与 SVG 贴地高度（彻底覆盖底部安全区与输入框底盘，杜绝漏底与串戏）
  const workspaceHeight = 380;
  const totalSvgHeight = workspaceHeight + bottomPadding;

  // 动态屏幕宽度居中适配：
  // 左右弧形胶囊各长 108dp，中间留白 94dp（离中心各 47dp），两翼向外延伸 155dp
  // 在任何屏幕宽度（360dp、390dp、412dp、430dp 等）下均严格绝对对称居中，绝无写死 390dp 造成的偏心
  const centerX = Math.round(screenWidth / 2);
  const leftArcD = `M ${centerX - 155},242 C ${centerX - 129},218 ${centerX - 91},204 ${centerX - 47},202`;
  const rightArcD = `M ${centerX + 47},202 C ${centerX + 91},204 ${centerX + 129},218 ${centerX + 155},242`;

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
    const totalScale = breatheAnim.value + level * 0.08;
    return {
      transform: [{ scale: totalScale }],
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
          {/* 1. 顶部转写文本气泡卡片 (经 SoftShadowSurface 软阴影，Android 浅色柔和漫散，无生硬系统阴影) */}
          <SoftShadowSurface
            preset="voiceCard"
            borderRadius={theme.radius.xl}
            fill={theme.colors.surface}
            fillStyle={[
              styles.previewCard,
              {
                width: Math.min(screenWidth - 32, 520),
                borderColor: cancelling
                  ? theme.colors.dangerSoft
                  : theme.colors.hairline,
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

          {/* 2. 交互大球与双翼弧形胶囊工作区 */}
          <View style={styles.archWorkspace}>
            {/* 底部全宽 Svg 呈现：双层架构（底层对话界面实色遮罩防串戏 + 上层流光大球发光体）与双翼胶囊 */}
            <Animated.View
              style={[
                styles.svgCanvasWrapper,
                {
                  bottom: -bottomPadding,
                  height: totalSvgHeight,
                },
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
                  {/* 第一层遮罩渐变（用户架构裁决）：
                      底部实色（theme.colors.canvas）100% 遮死输入框与安全区，彻底杜绝输入框串戏；
                      在球形偏上部分下方平滑渐变到透明，仅上部有透明度渐变融于主对话流 */}
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
                      stopOpacity={0.62}
                    />
                    <Stop
                      offset="28%"
                      stopColor={theme.colors.danger}
                      stopOpacity={0.52}
                    />
                    <Stop
                      offset="54%"
                      stopColor={theme.colors.dangerSoft}
                      stopOpacity={0.38}
                    />
                    <Stop
                      offset="76%"
                      stopColor={theme.colors.dangerSoft}
                      stopOpacity={0.22}
                    />
                    <Stop
                      offset="92%"
                      stopColor={theme.colors.dangerSoft}
                      stopOpacity={0.08}
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

                  {/* 黄金留白 94px 弧形轨迹 (左：centerX-155→centerX-47，右：centerX+47→centerX+155，舒展且完全对称) */}
                  <Path id="left-arc-track" d={leftArcD} />
                  <Path id="right-arc-track" d={rightArcD} />
                </Defs>

                {/* 第一层：对话界面实色背景遮罩（完全阻断输入框内容透视） */}
                <Rect
                  x="0"
                  y="0"
                  width={screenWidth}
                  height={totalSvgHeight}
                  fill="url(#bg-canvas-shield)"
                />

                {/* 第二层：流光大球发光体矩形背景 */}
                <Rect
                  x="0"
                  y="0"
                  width={screenWidth}
                  height={totalSvgHeight}
                  fill={`url(#dome-${cancelling ? 'cancel' : editing ? 'edit' : 'send'})`}
                />

                {/* 1 区：左侧弧形撤销胶囊 (高对比清晰底板与文字，彻底根除浅底看不清问题) */}
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
                  fontSize={theme.type.callout.fontSize}
                  fontWeight={cancelling ? '700' : '600'}
                  letterSpacing={0.8}
                >
                  <TextPath
                    href="#left-arc-track"
                    startOffset="50%"
                    textAnchor="middle"
                  >
                    {cancelling ? '✕  松开撤销' : '✕  左滑撤销'}
                  </TextPath>
                </SvgText>

                {/* 2 区：右侧弧形编辑胶囊 (高对比清晰底板与文字，彻底根除浅底看不清问题) */}
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
                  fontSize={theme.type.callout.fontSize}
                  fontWeight={editing ? '700' : '600'}
                  letterSpacing={0.8}
                >
                  <TextPath
                    href="#right-arc-track"
                    startOffset="50%"
                    textAnchor="middle"
                  >
                    {editing ? '松开编辑  ✎' : '右滑编辑  ✎'}
                  </TextPath>
                </SvgText>
              </Svg>
            </Animated.View>

            {/* 3. 高空独立 HUD 居中提示语 (带柔和半透微胶囊底衬，极高对比度，全天候清晰可见) */}
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
                    borderColor: cancelling
                      ? theme.colors.danger
                      : editing
                        ? theme.colors.info
                        : theme.colors.hairline,
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

            {/* 4. 底部微声波跳动条 (随音频电平 level 跳跃与谐波共振，与输入框卡体内中线精准贴合) */}
            <View
              testID="voice-overlay-wave-bar"
              style={[styles.waveBarContainer, { bottom: waveBottom }]}
            >
              {Array.from({ length: 31 }).map((_, i) => {
                const norm = i / 30;
                const bell = Math.sin(norm * Math.PI);
                const harmonic =
                  (i % 2 === 0 ? 1 : 0.82) * (i % 3 === 0 ? 1.15 : 0.9);
                const dynamicJump =
                  bell * Math.min(22, level * 28 * harmonic + 2);
                const h = Math.max(4, 4 + dynamicJump);
                return (
                  <View
                    key={i}
                    style={[
                      styles.waveTick,
                      {
                        height: h,
                        opacity: 0.5 + bell * 0.45,
                        backgroundColor: cancelling
                          ? theme.colors.danger
                          : editing
                            ? theme.colors.info
                            : theme.colors.actionPrimary,
                        borderRadius: theme.radius.pill,
                      },
                    ]}
                  />
                );
              })}
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
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
  // 预览文字卡片：经 SoftShadowSurface 软阴影，纯粹边线与半透明
  previewCard: {
    minHeight: 88,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingVertical: 16,
    justifyContent: 'center',
    marginBottom: 12,
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
  svgCanvasWrapper: {
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
    borderWidth: 1,
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
    width: 2,
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
