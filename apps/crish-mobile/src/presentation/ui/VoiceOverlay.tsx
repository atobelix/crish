// 语音浮层与模型下载门（01 文档 W-D）：
// - 浮层（原型 voice-recording-card）：170 宽悬浮小卡、无遮罩（透明层不压暗内容）、
//   5 柱波形（电平驱动，尺寸按原型 3.5 宽 / 6→26px）+ partial 实时文本（W-D 功能件，
//   原型年代早于流式识别，按 J3 保留并置于小卡内）+ 手势提示；
//   cancelling 态波形与提示变红「松开取消」，finishing 态显示「正在识别…」。
// - 下载门：模型未就绪时以 Dialog 诚实说明体积与进度，可收起后台续传，
//   失败可重试；绝不假装已就绪。
import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
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

/** 波形各柱权重（中间高、两侧低的对称包络） */
const BAR_WEIGHTS = [0.55, 0.85, 1, 0.85, 0.55] as const;
/** 原型 voice-wave-anim：柱宽 3.5、高 6→26px、容器高 28 */
const BAR_WIDTH = 3.5;
const BAR_MIN_HEIGHT = 6;
const BAR_MAX_HEIGHT = 26;
const BAR_AREA_HEIGHT = 28;

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
  const hint = starting
    ? '正在准备…'
    : phase === 'finishing'
      ? '正在识别…'
      : cancelling
        ? '松开取消'
        : '松开发送，上滑取消';

  // 进场（原型：opacity 0.2s + 卡片 translateY 6→0 0.22s emphasized）
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(6)).current;
  useEffect(() => {
    if (!visible) return;
    opacity.setValue(0);
    translateY.setValue(6);
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: theme.motion.duration.normal,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: theme.motion.duration.sheet,
        easing: Easing.bezier(...theme.motion.easing.emphasized),
        useNativeDriver: true,
      }),
    ]).start();
  }, [visible, opacity, translateY, theme.motion.easing.emphasized]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
    >
      <View style={styles.backdrop} pointerEvents="none">
        <Animated.View
          style={[styles.panel, { opacity, transform: [{ translateY }] }]}
        >
          {/* 录音卡软阴影（2026-11-02 用户裁定：所有阴影都是软阴影，原
              「原型阴影不采」豁免作废）：voiceCard 档（几何沿原型
              composer.css .voice-recording-card，α 恒按钮档两层——阴影
              上限裁决 2026-11-02 晚），仅 Android 浅色渲染 */}
          <SoftShadowSurface
            preset="voiceCard"
            borderRadius={theme.radius.lg}
            fill={theme.colors.surface}
            fillStyle={{
              // 原型 voice-recording-card：宽 170、radius 20、padding 20/16、gap 14
              width: 170,
              borderRadius: theme.radius.lg,
              paddingVertical: theme.space.xl,
              paddingHorizontal: theme.space.lg,
              gap: 14,
            }}
          >
            <View style={styles.bars}>
              {BAR_WEIGHTS.map((weight, index) => (
                <View
                  key={index}
                  style={{
                    width: BAR_WIDTH,
                    borderRadius: theme.radius.pill,
                    height:
                      BAR_MIN_HEIGHT +
                      Math.min(1, level * weight + 0.08) *
                        (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT),
                    backgroundColor: cancelling
                      ? theme.colors.danger
                      : // 波形柱为墨色元素，不随主操作绿走（M1 改指墨档）
                        theme.colors.textPrimary,
                  }}
                />
              ))}
            </View>
            <AppText
              variant="footnote"
              color={displayText ? 'textPrimary' : 'textTertiary'}
              numberOfLines={3}
              style={styles.text}
            >
              {displayText || (starting ? '正在准备…' : '正在聆听…')}
            </AppText>
            <AppText
              variant="caption"
              color={cancelling ? 'danger' : 'textSecondary'}
              style={styles.hint}
            >
              {hint}
            </AppText>
          </SoftShadowSurface>
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
 * 恢复动作（重新初始化引擎/去系统设置/重试采集）+ 关闭。替代旧版
 * 「一条 Toast 报错了事」——用户投诉报错后没有任何能重试的地方。
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
  // 无遮罩：透明全屏层只承载居中小卡，不压暗内容（原型 overlay 无 scrim）
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    alignItems: 'center',
  },
  bars: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: BAR_AREA_HEIGHT,
  },
  text: {
    minHeight: 18,
    textAlign: 'center',
  },
  hint: {
    textAlign: 'center',
  },
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
