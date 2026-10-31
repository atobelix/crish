// 审批已处理行：决策 / 工具 / 渠道 / 时间。
// N05 裁定：决策文字自带色彩层级（绿/红/灰），左侧图标圆盘属重复装饰，不显示。
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { ApprovalRecord } from '@/domain/types/domain';
import { AppText, ListRow } from '@/presentation/ui';

export function formatHistoryTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const HISTORY_DECISION_TEXT: Record<ApprovalRecord['decision'], string> =
  {
    approved: '已允许',
    denied: '已拒绝',
    expired: '已过期',
  };

export const HISTORY_CHANNEL_TEXT: Record<ApprovalRecord['channel'], string> = {
  mobile: '本机',
  desktop: '桌面端',
  auto: '自动',
};

export interface ApprovalHistoryRowProps {
  record: ApprovalRecord;
  testID?: string;
  divider?: boolean;
}

export const ApprovalHistoryRow = memo(function ApprovalHistoryRow({
  record,
  testID,
  divider = true,
}: ApprovalHistoryRowProps) {
  const theme = useTheme();
  const color =
    record.decision === 'approved'
      ? theme.colors.success
      : record.decision === 'denied'
        ? theme.colors.danger
        : theme.colors.textTertiary;
  const subtitle = [HISTORY_CHANNEL_TEXT[record.channel], record.reason]
    .filter(Boolean)
    .join(' · ');

  return (
    <ListRow
      testID={testID}
      title={record.toolName}
      subtitle={subtitle || undefined}
      divider={divider}
      trailing={
        <View style={styles.trailing}>
          <AppText variant="caption" style={{ color }}>
            {HISTORY_DECISION_TEXT[record.decision]}
          </AppText>
          <AppText variant="caption" color="textTertiary">
            {formatHistoryTime(record.resolvedAtMs)}
          </AppText>
        </View>
      }
    />
  );
});

const styles = StyleSheet.create({
  trailing: {
    alignItems: 'flex-end',
    gap: 2,
  },
});

export default ApprovalHistoryRow;
