// 语音交互浮层（新一代全宽沉浸式流光大球 + 左右双翼弧形胶囊）与模型下载门：
// 1. 浮层形态重构（严格遵循 2026-11-04 用户裁决与参考图顶级质感）：
//    - 告别旧 170 悬浮小卡片，升级为全宽底部沉浸式温润大球穹顶；
//    - 左右双翼弧形毛玻璃胶囊（贝塞尔曲线 94px 黄金留白，左滑撤销、右滑编辑）；
//    - 严格遵循用户红线：严禁使用安卓默认原生生硬阴影，纯粹融于背景光芒与软阴影；
//    - 撤销红态平滑自然漫散，中心红度克制（0.60），向外以平滑余弦衰减，两翼充分托底，绝非中间红两边白；
//    - 居中提示语大幅上移至高空独立 HUD 位（bottom: 206px），上下错开永不碰撞；
//    - 状态切换联动 haptics.snap() 触感。
// 2. 错误条与下载门：VoiceErrorBar 与 VoiceModelGate 原生保留，诚实保障离线模型交付。
import { useEffect, useRef, type ReactNode } from 'react';
import { Dimensions, Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolate,
  Easing as ReanimatedEasing,
} from 'react-native-reanimated';
import Svg, {
  Defs,
  Path,
  RadialGradient,
  Rect,
  Stop,
  Text as SvgText,
  TextPath,
} from 'react-native-svg';
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

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const VIEWPORT_WIDTH = Math.min(390, SCREEN_WIDTH);

export interface VoiceOverlayProps {
  phase: VoicePhase;
  starting: boolean;
  displayText: string;
  /** 波形电平 0..1 */
  level: number;
}

export function VoiceOverlay({
  phase,
  starting,
  displayText,
  level,
}: VoiceOverlayProps) {
  const theme = useTheme();
  const visible = starting || phase !== 'idle';
  const cancelling = phase === 'cancelling';
  const editing = phase === 'editing';

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
        <Animated.View style={[styles.mainContainer, layerAnimatedStyle]}>
          {/* 1. 顶部转写文本气泡卡片 (经 SoftShadowSurface 软阴影，Android 浅色柔和漫散，无生硬系统阴影) */}
          <SoftShadowSurface
            preset="voiceCard"
            borderRadius={theme.radius.xl}
            fill={theme.colors.surface}
            fillStyle={[
              styles.previewCard,
              {
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
            {/* 底部全宽 Svg 呈现温润大球发光体与双翼胶囊 */}
            <Svg
              width={VIEWPORT_WIDTH}
              height={380}
              viewBox="0 0 390 380"
              style={styles.svgCanvas}
            >
              <Defs>
                {/* 正常说话态：清透翡翠绿大球 (高阶平滑余弦衰减) */}
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
                    stopOpacity={0.88}
                  />
                  <Stop
                    offset="28%"
                    stopColor={theme.colors.actionPrimary}
                    stopOpacity={0.76}
                  />
                  <Stop
                    offset="52%"
                    stopColor={theme.colors.brandSoft}
                    stopOpacity={0.55}
                  />
                  <Stop
                    offset="74%"
                    stopColor={theme.colors.fillSubtle}
                    stopOpacity={0.32}
                  />
                  <Stop
                    offset="90%"
                    stopColor={theme.colors.fillSubtle}
                    stopOpacity={0.12}
                  />
                  <Stop
                    offset="100%"
                    stopColor={theme.colors.fillSubtle}
                    stopOpacity={0}
                  />
                </RadialGradient>

                {/* 撤销态：低浓度柔绯大球 (严格遵循用户叮嘱：中心不浓红、两边柔和漫射托底、绝非中间红两边白) */}
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
                    stopOpacity={0.6}
                  />
                  <Stop
                    offset="30%"
                    stopColor={theme.colors.danger}
                    stopOpacity={0.52}
                  />
                  <Stop
                    offset="56%"
                    stopColor={theme.colors.dangerSoft}
                    stopOpacity={0.38}
                  />
                  <Stop
                    offset="78%"
                    stopColor={theme.colors.dangerSoft}
                    stopOpacity={0.24}
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
                    stopOpacity={0.85}
                  />
                  <Stop
                    offset="28%"
                    stopColor={theme.colors.info}
                    stopOpacity={0.72}
                  />
                  <Stop
                    offset="52%"
                    stopColor={theme.colors.infoSoft}
                    stopOpacity={0.5}
                  />
                  <Stop
                    offset="74%"
                    stopColor={theme.colors.fillSubtle}
                    stopOpacity={0.3}
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

                {/* 黄金留白 94px 弧形轨迹 (左：40→148，右：242→350，舒展且无拥挤感) */}
                <Path
                  id="left-arc-track"
                  d="M 40,242 C 66,218 104,204 148,202"
                />
                <Path
                  id="right-arc-track"
                  d="M 242,202 C 286,204 324,218 350,242"
                />
              </Defs>

              {/* 大球发光体矩形背景 */}
              <Rect
                x="0"
                y="0"
                width="390"
                height="380"
                fill={`url(#dome-${cancelling ? 'cancel' : editing ? 'edit' : 'send'})`}
              />

              {/* 1 区：左侧弧形撤销胶囊 (纯净半透明底板，无安卓生硬黑阴影) */}
              <Path
                d="M 40,242 C 66,218 104,204 148,202"
                fill="none"
                stroke={
                  cancelling
                    ? 'rgba(255, 255, 255, 0.72)'
                    : 'rgba(255, 255, 255, 0.42)'
                }
                strokeWidth={38}
                strokeLinecap="round"
              />
              <SvgText
                fill={theme.colors.onMedia}
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

              {/* 2 区：右侧弧形编辑胶囊 (纯净半透明底板，无安卓生硬黑阴影) */}
              <Path
                d="M 242,202 C 286,204 324,218 350,242"
                fill="none"
                stroke={
                  editing
                    ? 'rgba(255, 255, 255, 0.72)'
                    : 'rgba(255, 255, 255, 0.42)'
                }
                strokeWidth={38}
                strokeLinecap="round"
              />
              <SvgText
                fill={theme.colors.onMedia}
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

            {/* 3. 高空独立 HUD 居中提示语 (定位于胶囊上方高空，绝无水平重叠) */}
            <View style={styles.centerTipContainer}>
              <AppText
                variant="callout"
                style={[styles.centerTipText, { color: theme.colors.onMedia }]}
              >
                {hintText}
              </AppText>
            </View>

            {/* 4. 底部微声波跳动条 (随音频电平 level 跳跃) */}
            <View style={styles.waveBarContainer}>
              {Array.from({ length: 31 }).map((_, i) => {
                const norm = i / 30;
                const bell = Math.sin(norm * Math.PI);
                const h = 4 + bell * Math.min(18, level * 22 + 4);
                return (
                  <View
                    key={i}
                    style={[
                      styles.waveTick,
                      {
                        height: h,
                        opacity: 0.4 + bell * 0.55,
                        backgroundColor: theme.colors.onMedia,
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
    paddingBottom: 24,
  },
  // 预览文字卡片：经 SoftShadowSurface 软阴影，纯粹边线与半透明
  previewCard: {
    width: VIEWPORT_WIDTH - 48,
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
  // 交互大球工作区
  archWorkspace: {
    width: VIEWPORT_WIDTH,
    height: 380,
    position: 'relative',
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
  centerTipText: {
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  // 底部微音浪波形
  waveBarContainer: {
    position: 'absolute',
    bottom: 42,
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
