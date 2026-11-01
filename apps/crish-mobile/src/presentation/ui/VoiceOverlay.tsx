// 语音浮层与模型下载门（01 文档 W-D）：
// - 浮层（原型 voice-recording-card）：170 宽悬浮小卡、无遮罩（透明层不压暗内容）、
//   5 柱波形（电平驱动，尺寸按原型 3.5 宽 / 6→26px）+ partial 实时文本（W-D 功能件，
//   原型年代早于流式识别，按 J3 保留并置于小卡内）+ 手势提示；
//   cancelling 态波形与提示变红「松开取消」，finishing 态显示「正在识别…」。
// - 下载门：模型未就绪时以 Dialog 诚实说明体积与进度，可收起后台续传，
//   失败可重试；绝不假装已就绪。
import { useEffect, useRef } from 'react';
import { Animated, Easing, Modal, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { AsrModelState } from '@/adapters/asr/modelManager';
import type { VoicePhase } from '@/domain/asr/voiceInputMachine';
import AppText from './AppText';
import Dialog from './Dialog';

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
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 220,
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
          style={[
            styles.panel,
            {
              // 原型 voice-recording-card：宽 170、radius 20、padding 20/16、gap 14
              width: 170,
              borderRadius: theme.radius.lg,
              backgroundColor: theme.colors.surface,
              paddingVertical: theme.space.xl,
              paddingHorizontal: theme.space.lg,
              gap: 14,
              opacity,
              transform: [{ translateY }],
            },
            // 原型阴影 0 12px 32px rgba(0,0,0,0.08) = shadow.lg 同值
            theme.shadow.lg,
          ]}
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
        </Animated.View>
      </View>
    </Modal>
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
  const totalMb = Math.round(modelTotalBytes / (1024 * 1024));
  let description: string;
  let primaryLabel: string | null = '下载模型';
  if (state?.kind === 'downloading') {
    description = `正在下载 ${state.fileName}…总进度 ${Math.round(
      state.overallFraction * 100
    )}%。可收起此弹窗，下载会在后台继续。`;
    primaryLabel = null;
  } else if (state?.kind === 'verifying') {
    description = `正在校验 ${state.fileName} 的完整性…`;
    primaryLabel = null;
  } else if (state?.kind === 'error') {
    description = `下载失败：${state.message}。请检查网络后重试。`;
    primaryLabel = '重试';
  } else {
    description = `按住说话使用本机离线识别，需要先下载语音模型（约 ${totalMb}MB，建议 Wi-Fi 环境）。下载完成后即可离线使用。`;
  }

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
    />
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
});

export default VoiceOverlay;
