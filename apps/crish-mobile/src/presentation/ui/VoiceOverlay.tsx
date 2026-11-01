// 语音浮层与模型下载门（01 文档 W-D）：
// - 浮层：5 柱波形（电平驱动）+ partial 实时文本 + 手势提示；
//   cancelling 态提示变红「松开取消」，finishing 态显示「正在识别…」。
// - 下载门：模型未就绪时以 Dialog 诚实说明体积与进度，可收起后台续传，
//   失败可重试；绝不假装已就绪。
import { Modal, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { AsrModelState } from '@/adapters/asr/modelManager';
import type { VoicePhase } from '@/domain/asr/voiceInputMachine';
import AppText from './AppText';
import Dialog from './Dialog';

/** 波形各柱权重（中间高、两侧低的对称包络） */
const BAR_WEIGHTS = [0.55, 0.85, 1, 0.85, 0.55] as const;
const BAR_MIN_HEIGHT = 6;
const BAR_MAX_HEIGHT = 34;

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

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <View
        style={[styles.backdrop, { backgroundColor: theme.colors.scrim }]}
        pointerEvents="none"
      >
        <View
          style={[
            styles.panel,
            {
              borderRadius: theme.radius.dialog,
              backgroundColor: theme.colors.surface,
              paddingHorizontal: theme.space.xl,
              paddingVertical: theme.space.lg,
              gap: theme.space.md,
              marginHorizontal: theme.space.xl,
            },
            theme.shadow.md,
          ]}
        >
          <View style={styles.bars}>
            {BAR_WEIGHTS.map((weight, index) => (
              <View
                key={index}
                style={{
                  width: 4,
                  borderRadius: theme.radius.pill,
                  height:
                    BAR_MIN_HEIGHT +
                    Math.min(1, level * weight + 0.08) *
                      (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT),
                  backgroundColor: cancelling
                    ? theme.colors.danger
                    : theme.colors.actionPrimary,
                }}
              />
            ))}
          </View>
          <AppText
            variant="body"
            color={displayText ? 'textPrimary' : 'textTertiary'}
            style={styles.text}
          >
            {displayText || (starting ? '正在准备…' : '正在聆听…')}
          </AppText>
          <AppText
            variant="footnote"
            color={cancelling ? 'danger' : 'textSecondary'}
            style={styles.hint}
          >
            {hint}
          </AppText>
        </View>
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
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  bars: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: BAR_MAX_HEIGHT,
  },
  text: {
    minHeight: 24,
    textAlign: 'center',
  },
  hint: {
    textAlign: 'center',
  },
});

export default VoiceOverlay;
