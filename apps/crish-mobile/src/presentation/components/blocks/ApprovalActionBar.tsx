// 审批决策区区块（F2 §5.2 / §9.3-1 + M4 §6.2-1：允许主按钮恒右、拒绝恒左、间距 ≥48dp）
// - 双阶段确认：拒绝需二次确认（ConfirmDialog 危险操作确认，任务书 R2-04；拒绝永远比允许容易，
//   F2 §5.3 安全模式——拒绝是安全方向却会中断 Agent 任务，二次确认防误触）；
//   允许按 F2 §5.2 L1 语义单击即决策（L2 滑动确认依赖滑动手势，不在本任务范围，见汇报未覆盖项）；
// - busy 防双点（R2UX-04-03）：decisionBusy 状态位由 store 驱动，组件不自行计时；
//   busy 期间按钮置忙（loading + 禁用 + 半透明）且拒绝弹窗强制关闭（防双点）。
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import Button from '@/presentation/components/ui/Button';
import Dialog from '@/presentation/components/ui/Dialog';

export interface ApprovalActionBarProps {
  /** decisionBusy 状态位（store 驱动；true = 决策发送中，双按钮禁用） */
  busy: boolean;
  onAllow: () => void;
  onDeny: () => void;
  /** 工具名（无障碍 label「类型 + 摘要」，M4 §6.5 / R2UX-04-10） */
  toolName?: string;
}

export default function ApprovalActionBar({
  busy,
  onAllow,
  onDeny,
  toolName,
}: ApprovalActionBarProps) {
  const theme = useTheme();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // busy 期间弹窗强制关闭（防双点：决策已发送/处理中不允许再弹出确认）
  useEffect(() => {
    if (busy) setConfirmOpen(false);
  }, [busy]);

  const handleAllow = () => {
    if (busy) return;
    onAllow();
  };

  const handleDeny = () => {
    if (busy) return;
    setConfirmOpen(true);
  };

  const handleConfirmDeny = () => {
    if (busy) return;
    setConfirmOpen(false);
    onDeny();
  };

  const closeDialog = () => setConfirmOpen(false);

  const allowLabel = toolName ? `允许此请求（${toolName}）` : '允许此请求';
  const denyLabel = toolName ? `拒绝此请求（${toolName}）` : '拒绝此请求';

  return (
    <>
      <View
        testID="approval-action-bar"
        style={[
          styles.bar,
          { backgroundColor: theme.bgPrimary, borderTopColor: theme.hairline },
        ]}
      >
        <Button
          label="拒绝"
          variant="secondary"
          onPress={handleDeny}
          disabled={busy}
          testID="approval-deny"
          accessibilityLabel={denyLabel}
          style={styles.actionButton}
        />
        <Button
          label="允许"
          variant="primary"
          onPress={handleAllow}
          disabled={busy}
          loading={busy}
          testID="approval-allow"
          accessibilityLabel={allowLabel}
          style={styles.actionButton}
        />
      </View>
      <Dialog
        visible={confirmOpen}
        title="拒绝此请求？"
        description="拒绝后 Agent 将收到拒绝结果，正在进行的任务可能中断。若为误触，请点「取消」。"
        testID="approval-deny-dialog"
        actions={[
          {
            label: '取消',
            variant: 'secondary',
            onPress: closeDialog,
            testID: 'deny-cancel',
          },
          {
            label: '确认拒绝',
            variant: 'danger',
            onPress: handleConfirmDeny,
            testID: 'deny-confirm',
          },
        ]}
        onDismiss={closeDialog}
      />
    </>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    // 允许/拒绝间距 ≥48dp（F2 §9.3-1 / M4 §6.2-1 / R2UX-04-07 布局常量）
    gap: 48,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
  },
  actionButton: {
    flex: 1,
  },
});
