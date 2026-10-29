// 运行控制：暂停 / 恢复 / 取消（危险操作二次确认）。
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { RunControlVm } from '@/adapters/viewmodels/useRunControlVm';
import {
  RUN_CONTROL_ACTION_LABEL,
  runControlSendingText,
  runControlSuccessText,
  type RunControlAction,
} from '@/adapters/viewmodels/useRunControlVm';
import { AppText, Button, Dialog } from '@/presentation/ui';

export interface RunControlBarProps {
  actions: readonly RunControlAction[];
  vm: RunControlVm;
}

export function RunControlBar({ actions, vm }: RunControlBarProps) {
  const theme = useTheme();
  const activeAction =
    vm.feedback.kind === 'sending' ? vm.feedback.action : null;
  const feedbackText =
    vm.feedback.kind === 'sending'
      ? runControlSendingText(vm.feedback.action)
      : vm.feedback.kind === 'success'
        ? runControlSuccessText(vm.feedback.action)
        : vm.feedback.kind === 'error'
          ? vm.feedback.message
          : null;
  const feedbackColor =
    vm.feedback.kind === 'error'
      ? theme.colors.danger
      : vm.feedback.kind === 'success'
        ? theme.colors.success
        : theme.colors.textTertiary;

  return (
    <View
      style={[styles.container, { borderBottomColor: theme.colors.hairline }]}
    >
      <View style={styles.row}>
        {actions.map((action) =>
          action === 'cancel' ? (
            <Button
              key={action}
              testID="run-control-cancel"
              label={RUN_CONTROL_ACTION_LABEL[action]}
              variant="secondary"
              disabled={!vm.canCancel || vm.busy}
              loading={activeAction === 'cancel'}
              onPress={vm.requestCancel}
              style={styles.action}
            />
          ) : (
            <Button
              key={action}
              testID={`run-control-${action}`}
              label={RUN_CONTROL_ACTION_LABEL[action]}
              variant={action === 'resume' ? 'primary' : 'secondary'}
              disabled={
                action === 'pause'
                  ? !vm.canPause || vm.busy
                  : !vm.canResume || vm.busy
              }
              loading={activeAction === action}
              onPress={action === 'pause' ? vm.pause : vm.resume}
              style={styles.action}
            />
          )
        )}
      </View>
      {feedbackText ? (
        <AppText
          testID="run-control-feedback"
          variant="caption"
          style={{ color: feedbackColor }}
        >
          {feedbackText}
        </AppText>
      ) : null}
      <Dialog
        testID="run-control-confirm-dialog"
        visible={vm.confirmVisible}
        title="终止当前任务？"
        description="未完成的进度可能丢失。"
        onDismiss={vm.dismissCancel}
        actions={[
          {
            label: '取消',
            variant: 'secondary',
            onPress: vm.dismissCancel,
            testID: 'run-control-confirm-cancel',
          },
          {
            label: '终止任务',
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
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  action: {
    flex: 1,
  },
});

export default RunControlBar;
