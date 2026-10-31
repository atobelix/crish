// 审批悬浮卡展开态：工具 · 倒计时 · 摘要 · 决策区。
// 低风险卡内直接「拒绝 / 允许」；高风险只给「查看并滑动确认」；点空白处回到所属会话。
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { ApprovalItem } from '@/domain/types/domain';
import { AppText, Badge, Button, IconButton } from '@/presentation/ui';
import {
  COUNTDOWN_WARNING_MS,
  formatRemainingMs,
  maskCommandSecrets,
  summarizeParameters,
} from '@/presentation/components/blocks/ApprovalCard';
import type { ApprovalFloatMode } from './approvalFloatModel';

export interface ApprovalFloatCardProps {
  item: ApprovalItem;
  mode: ApprovalFloatMode;
  others: number;
  remainingMs: number;
  busy: boolean;
  onAllow: () => void;
  onDeny: () => void;
  onReview: () => void;
  onOpenQueue: () => void;
  onOpenSession: () => void;
  onCollapse: () => void;
}

function summaryOf(item: ApprovalItem): string {
  return item.riskMeta?.command
    ? `$ ${maskCommandSecrets(item.riskMeta.command)}`
    : summarizeParameters(item.request.parameters, 120);
}

export function ApprovalFloatCard({
  item,
  mode,
  others,
  remainingMs,
  busy,
  onAllow,
  onDeny,
  onReview,
  onOpenQueue,
  onOpenSession,
  onCollapse,
}: ApprovalFloatCardProps) {
  const theme = useTheme();
  const urgent = remainingMs <= COUNTDOWN_WARNING_MS;
  const summary = summaryOf(item);
  return (
    <Pressable
      testID="approval-float-card"
      accessibilityRole="button"
      accessibilityLabel={`待审批：${item.request.toolName}，打开所属会话`}
      onPress={onOpenSession}
      style={[
        {
          padding: theme.space.lg,
          gap: theme.space.md,
          borderRadius: theme.radius.card,
          backgroundColor: theme.colors.surfaceRaised,
        },
      ]}
    >
      <View style={[styles.row, { gap: theme.space.sm }]}>
        <Badge dot tone={mode === 'review' ? 'danger' : 'warning'} />
        <AppText variant="headline" numberOfLines={1} style={styles.flex}>
          {item.request.toolName}
        </AppText>
        <AppText
          variant="footnote"
          color={urgent ? 'danger' : 'textSecondary'}
          style={styles.tabular}
        >
          {formatRemainingMs(remainingMs)}
        </AppText>
        {others > 0 ? (
          <Pressable
            testID="approval-float-more"
            accessibilityRole="button"
            accessibilityLabel={`还有 ${others} 个待审批，打开队列`}
            onPress={onOpenQueue}
            hitSlop={theme.space.sm}
          >
            <AppText variant="footnote" color="brand">
              还有 {others} 个
            </AppText>
          </Pressable>
        ) : null}
        <IconButton
          name="chevron-down"
          accessibilityLabel="收起审批"
          onPress={onCollapse}
          size={theme.size.iconSmall}
          testID="approval-float-collapse"
        />
      </View>
      {summary ? (
        <AppText variant="footnote" color="textSecondary" numberOfLines={2}>
          {summary}
        </AppText>
      ) : null}
      {mode === 'quick' ? (
        <View style={[styles.row, { gap: theme.space.sm }]}>
          <Button
            label="拒绝"
            variant="secondary"
            onPress={onDeny}
            disabled={busy}
            testID="approval-float-deny"
            style={styles.flex}
          />
          <Button
            label="允许"
            variant="primary"
            onPress={onAllow}
            disabled={busy}
            loading={busy}
            testID="approval-float-allow"
            style={styles.flex}
          />
        </View>
      ) : (
        <Button
          label="查看并滑动确认"
          variant="primary"
          onPress={onReview}
          testID="approval-float-review"
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
});

export default ApprovalFloatCard;
