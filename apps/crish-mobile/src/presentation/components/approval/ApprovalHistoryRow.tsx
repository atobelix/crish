// 审批已处理行（F2 §7.2 · R4 批次3 自 approvalListScreen 抽出共用）：
// 审批中心「最近已处理」区与审批历史全量页共用同一行渲染——decision 徽标 +
// 工具名 + 时间/渠道 meta；配色经 useTheme token，无硬编码色值（M4 §3.8）。
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { ApprovalRecord } from '@/domain/types/domain';

/** 已处理行时间格式化（F2 §7.2 线框口径：HH:MM:SS） */
export function formatHistoryTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 决策徽标文案（F2 §7.2 线框：已允许 / 已拒绝 / 已过期） */
export const HISTORY_DECISION_TEXT: Record<ApprovalRecord['decision'], string> =
  {
    approved: '已允许',
    denied: '已拒绝',
    expired: '已过期',
  };

/** 决策渠道文案（F2 §7.1-3：本机 / 桌面端 / 自动过期） */
export const HISTORY_CHANNEL_TEXT: Record<ApprovalRecord['channel'], string> = {
  mobile: '本机',
  desktop: '桌面端',
  auto: '自动过期',
};

export interface ApprovalHistoryRowProps {
  record: ApprovalRecord;
  testID?: string;
}

/** 单条已处理记录行（memo：历史列表静态，追加新行不重渲染旧行） */
export const ApprovalHistoryRow = memo(function ApprovalHistoryRow({
  record,
  testID,
}: ApprovalHistoryRowProps) {
  const theme = useTheme();
  const badgeBg =
    record.decision === 'approved'
      ? theme.colorSuccessBg
      : record.decision === 'denied'
        ? theme.colorErrorBg
        : theme.bgTertiary;
  const badgeColor =
    record.decision === 'approved'
      ? theme.colorSuccess
      : record.decision === 'denied'
        ? theme.colorError
        : theme.textSecondary;
  return (
    <View
      testID={testID}
      style={[styles.row, { borderBottomColor: theme.hairline }]}
    >
      <View style={[styles.decisionBadge, { backgroundColor: badgeBg }]}>
        <Text style={[styles.decisionBadgeText, { color: badgeColor }]}>
          {HISTORY_DECISION_TEXT[record.decision]}
        </Text>
      </View>
      <Text
        style={[styles.tool, { color: theme.textPrimary }]}
        numberOfLines={1}
      >
        {record.toolName}
      </Text>
      <Text style={[styles.meta, { color: theme.textTertiary }]}>
        {formatHistoryTime(record.resolvedAtMs)} ·{' '}
        <Text style={{ color: theme.textTertiary }}>
          {HISTORY_CHANNEL_TEXT[record.channel]}
        </Text>
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  decisionBadge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  decisionBadgeText: {
    fontSize: 11,
    fontWeight: '500',
  },
  tool: {
    flex: 1,
    fontSize: 14,
  },
  meta: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
});
