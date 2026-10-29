// 审批决策区：允许 / 拒绝；L2 高风险允许改为滑动确认。
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Button, Dialog } from '@/presentation/ui';
import SlideToConfirm from './SlideToConfirm';

export interface ApprovalActionBarProps {
  busy: boolean;
  onAllow: () => void;
  onDeny: () => void;
  toolName?: string;
  dangerLevel?: 1 | 2;
  /** 嵌入弹窗时去掉外层安全区与顶部边框 */
  embedded?: boolean;
}

export default function ApprovalActionBar({
  busy,
  onAllow,
  onDeny,
  toolName,
  dangerLevel = 1,
  embedded = false,
}: ApprovalActionBarProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isL2 = dangerLevel === 2;

  useEffect(() => {
    if (busy) setConfirmOpen(false);
  }, [busy]);

  const allowLabel = toolName ? `允许 ${toolName}` : '允许';
  const denyLabel = toolName ? `拒绝 ${toolName}` : '拒绝';

  return (
    <>
      <View
        testID="approval-action-bar"
        style={[
          styles.bar,
          {
            borderTopColor: theme.colors.hairline,
            backgroundColor: embedded
              ? theme.colors.surfaceRaised
              : theme.colors.canvas,
            paddingBottom: embedded
              ? 0
              : Math.max(insets.bottom, theme.space.md),
          },
          isL2 && styles.barL2,
          embedded && styles.embedded,
        ]}
      >
        {isL2 ? (
          <View style={styles.l2Allow}>
            <AppText variant="caption" color="warning">
              允许后将立即执行，不可撤销
            </AppText>
            <SlideToConfirm
              testID="approval-allow"
              onConfirm={onAllow}
              disabled={busy}
              accessibilityLabel={allowLabel}
            />
          </View>
        ) : null}
        <View style={styles.actions}>
          <Button
            label="拒绝"
            variant="secondary"
            onPress={() => setConfirmOpen(true)}
            disabled={busy}
            testID="approval-deny"
            accessibilityLabel={denyLabel}
            style={styles.action}
          />
          {!isL2 ? (
            <Button
              label="允许"
              variant="primary"
              onPress={onAllow}
              disabled={busy}
              loading={busy}
              testID="approval-allow"
              accessibilityLabel={allowLabel}
              style={styles.action}
            />
          ) : null}
        </View>
      </View>
      <Dialog
        visible={confirmOpen}
        title="拒绝此请求？"
        description="Agent 将收到拒绝结果，当前任务可能中断。"
        testID="approval-deny-dialog"
        actions={[
          {
            label: '取消',
            variant: 'secondary',
            onPress: () => setConfirmOpen(false),
            testID: 'deny-cancel',
          },
          {
            label: '确认拒绝',
            variant: 'danger',
            onPress: () => {
              setConfirmOpen(false);
              onDeny();
            },
            testID: 'deny-confirm',
          },
        ]}
        onDismiss={() => setConfirmOpen(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 12,
  },
  barL2: {
    flexDirection: 'column',
  },
  embedded: {
    borderTopWidth: 0,
    paddingHorizontal: 20,
    paddingTop: 4,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
  },
  action: {
    flex: 1,
  },
  l2Allow: {
    gap: 8,
  },
});
