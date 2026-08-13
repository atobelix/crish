// run 控制区（R2-05 部分 6：L2 暂停 / L0 恢复 / L3 取消 + 反馈 + 二次确认）
// - 按钮编排：页面注入 actions（runControlActionsOf 产物：终态隐藏、paused 换
//   恢复）；L2 暂停单点确认、L3 取消二次确认（D4 §5.6 / M4 §5.6 分级语义）；
// - 二次确认（M4 §6.3 Dialog 规范）：标题 + 后果说明 + 危险主按钮 + 取消；
//   确认后才发送 L3 force_cancel（防误触）；
// - 反馈：sending（菊花 + 动作文案）/ success（绿色动作文案）/ error（错误码
//   映射人话文案，M6 §11.3）；busy 期间全部按钮禁用（R2UX-04-03 防双点）；
// - 未连接：按钮禁用 + 「未连接」提示（对齐 QuickRunPanel 口径）。
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import Button from '@/presentation/components/ui/Button';
import Dialog from '@/presentation/components/ui/Dialog';
import type { RunControlVm } from '@/adapters/viewmodels/useRunControlVm';
import {
  RUN_CONTROL_ACTION_LABEL,
  runControlSendingText,
  runControlSuccessText,
  type RunControlAction,
} from '@/adapters/viewmodels/useRunControlVm';

export interface RunControlBarProps {
  /** 按钮编排（runControlActionsOf 产物；空数组 = 页面不渲染本组件） */
  actions: readonly RunControlAction[];
  /** run 控制视图模型（busy/反馈/发送/确认状态） */
  vm: RunControlVm;
}

/** 反馈文案（sending/success；error 直接用 vm.feedback.message） */
export function runControlFeedbackText(
  feedback: RunControlVm['feedback']
): string | null {
  switch (feedback.kind) {
    case 'sending':
      return runControlSendingText(feedback.action);
    case 'success':
      return runControlSuccessText(feedback.action);
    default:
      return null;
  }
}

export function RunControlBar({ actions, vm }: RunControlBarProps) {
  const theme = useTheme();
  const activeAction =
    vm.feedback.kind === 'sending' ? vm.feedback.action : null;
  const busy = vm.busy;

  const renderButton = (action: RunControlAction) => {
    const label = RUN_CONTROL_ACTION_LABEL[action];
    if (action === 'pause') {
      return (
        <Button
          key={action}
          testID="run-control-pause"
          label={label}
          variant="secondary"
          disabled={!vm.canPause || busy}
          loading={activeAction === 'pause'}
          onPress={vm.pause}
          style={styles.actionButton}
        />
      );
    }
    if (action === 'resume') {
      return (
        <Button
          key={action}
          testID="run-control-resume"
          label={label}
          variant="primary"
          disabled={!vm.canResume || busy}
          loading={activeAction === 'resume'}
          onPress={vm.resume}
          style={styles.actionButton}
        />
      );
    }
    return (
      <Button
        key={action}
        testID="run-control-cancel"
        label={label}
        variant="danger"
        disabled={!vm.canCancel || busy}
        loading={activeAction === 'cancel'}
        onPress={vm.requestCancel}
        style={styles.actionButton}
      />
    );
  };

  const feedbackText =
    vm.feedback.kind === 'error'
      ? vm.feedback.message
      : runControlFeedbackText(vm.feedback);
  const feedbackColor =
    vm.feedback.kind === 'error'
      ? theme.colorError
      : vm.feedback.kind === 'success'
        ? theme.colorSuccess
        : theme.textSecondary;

  return (
    <View style={[styles.container, { borderTopColor: theme.hairline }]}>
      {!vm.connected ? (
        <Text
          testID="run-control-disconnected"
          style={[styles.disconnectedText, { color: theme.colorError }]}
        >
          未连接，无法控制 run
        </Text>
      ) : null}
      <View style={styles.actionsRow}>{actions.map(renderButton)}</View>
      {feedbackText !== null ? (
        <View style={styles.feedbackRow} testID="run-control-feedback">
          {vm.feedback.kind === 'sending' ? (
            <ActivityIndicator size="small" color={theme.textSecondary} />
          ) : null}
          <Text style={[styles.feedbackText, { color: feedbackColor }]}>
            {feedbackText}
          </Text>
        </View>
      ) : null}
      <Dialog
        testID="run-control-confirm-dialog"
        visible={vm.confirmVisible}
        title="取消 run？"
        description="将强制终止当前任务，未完成的进度可能丢失（L3 force_cancel，D4 §5.6）。"
        onDismiss={vm.dismissCancel}
        actions={[
          {
            label: '再想想',
            variant: 'secondary',
            onPress: vm.dismissCancel,
            testID: 'run-control-confirm-cancel',
          },
          {
            label: '取消 run',
            variant: 'danger',
            onPress: vm.confirmCancel,
            testID: 'run-control-confirm-ok',
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  disconnectedText: {
    fontSize: 12,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  actionButton: {
    flex: 1,
  },
  feedbackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 18,
  },
  feedbackText: {
    fontSize: 13,
    flexShrink: 1,
  },
});
