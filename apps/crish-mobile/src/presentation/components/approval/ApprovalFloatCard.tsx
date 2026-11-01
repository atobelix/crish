// 审批悬浮卡展开态（原型 conv-approval-floating-popup）：
// 白卡 30 圆角 + 柔和深度投影；标题行（橙点 + 权限审批请求 + 收起）；
// 元信息行（工具标签 + 倒计时 + 队列入口）；等宽代码摘要块；决策按钮对。
// 低风险卡内直接「拒绝 / 允许」；高风险只给「查看并滑动确认」；点空白处回到所属会话。
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { ApprovalItem } from '@/domain/types/domain';
import { AppText, Button, IconButton } from '@/presentation/ui';
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
          borderRadius: theme.radius.overlay,
          backgroundColor: theme.colors.surfaceRaised,
        },
        theme.shadow.lg,
      ]}
    >
      <View style={[styles.row, { gap: theme.space.sm }]}>
        {/* 状态点 + 固定标题（工具语义见元信息行标签） */}
        <View
          style={[
            styles.dot,
            {
              borderRadius: theme.radius.pill,
              backgroundColor:
                mode === 'review' ? theme.colors.danger : theme.colors.warning,
            },
          ]}
        />
        <AppText variant="bodyStrong" numberOfLines={1} style={styles.flex}>
          权限审批请求
        </AppText>
        <IconButton
          name="chevron-down"
          accessibilityLabel="收起审批"
          onPress={onCollapse}
          size={theme.size.iconSmall}
          testID="approval-float-collapse"
        />
      </View>
      <View style={[styles.row, { gap: theme.space.sm }]}>
        <AppText
          variant="caption"
          color="textTertiary"
          numberOfLines={1}
          style={styles.toolTag}
        >
          {item.request.toolName.toUpperCase()}
        </AppText>
        <View style={styles.flex} />
        {others > 0 ? (
          <Pressable
            testID="approval-float-more"
            accessibilityRole="button"
            accessibilityLabel={`还有 ${others} 个待审批，打开队列`}
            onPress={onOpenQueue}
            hitSlop={theme.space.sm}
          >
            <AppText variant="caption" color="brand">
              还有 {others} 个
            </AppText>
          </Pressable>
        ) : null}
        <AppText
          variant="caption"
          color={urgent ? 'danger' : 'textTertiary'}
          style={styles.tabular}
        >
          {formatRemainingMs(remainingMs)}
        </AppText>
      </View>
      {summary ? (
        <View
          style={[
            {
              borderRadius: theme.radius.control,
              backgroundColor: theme.colors.fillSubtle,
              padding: theme.space.md,
            },
          ]}
        >
          <AppText variant="mono" color="textPrimary" numberOfLines={3}>
            {summary}
          </AppText>
        </View>
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
  // 状态点（原型 6.5px）：尺寸定值，圆角走 pill（RN 钳制为正圆）
  dot: {
    width: 6.5,
    height: 6.5,
  },
  toolTag: {
    letterSpacing: 1,
  },
});

export default ApprovalFloatCard;
