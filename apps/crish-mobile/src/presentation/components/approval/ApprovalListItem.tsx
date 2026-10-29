// 审批列表项：工具 / 风险 / 摘要 / 倒计时 / 会话。
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { ApprovalItem } from '@/domain/types/domain';
import { formatRelativeTime } from '@/domain/pure/time';
import { AppText, Badge, Icon } from '@/presentation/ui';
import {
  COUNTDOWN_WARNING_MS,
  formatRemainingMs,
  maskCommandSecrets,
  summarizeParameters,
} from '@/presentation/components/blocks/ApprovalCard';

export interface ApprovalListItemProps {
  item: ApprovalItem;
  remainingMs: number;
  sessionTitle: string | null;
  onPress: (toolCallId: string) => void;
}

export function ApprovalListItem({
  item,
  remainingMs,
  sessionTitle,
  onPress,
}: ApprovalListItemProps) {
  const theme = useTheme();
  const urgent = remainingMs <= COUNTDOWN_WARNING_MS;
  const highRisk = item.dangerLevel === 2;
  const summary = item.riskMeta?.command
    ? `$ ${maskCommandSecrets(item.riskMeta.command)}`
    : summarizeParameters(item.request.parameters, 120);
  const time = formatRelativeTime(item.receivedAtMs);

  return (
    <Pressable
      testID={`approval-row-${item.request.toolCallId}`}
      accessibilityRole="button"
      accessibilityLabel={`审批：${item.request.toolName}，剩余 ${formatRemainingMs(remainingMs)}`}
      onPress={() => onPress(item.request.toolCallId)}
      style={({ pressed }) => [
        {
          marginHorizontal: theme.space.lg,
          padding: theme.space.lg,
          gap: theme.space.sm,
          borderRadius: theme.radius.card,
          backgroundColor: pressed
            ? theme.colors.fillPressed
            : theme.colors.fillSubtle,
        },
      ]}
    >
      <View style={[styles.row, { gap: theme.space.sm }]}>
        <Badge dot tone={highRisk ? 'danger' : 'warning'} />
        <AppText variant="bodyStrong" numberOfLines={1} style={styles.toolName}>
          {item.request.toolName}
        </AppText>
        <View style={[styles.row, { gap: theme.space.xs }]}>
          <Icon
            name="clock"
            size={theme.size.iconSmall}
            color={urgent ? theme.colors.danger : theme.colors.textTertiary}
          />
          <AppText
            variant="footnote"
            style={{
              color: urgent ? theme.colors.danger : theme.colors.textSecondary,
              fontVariant: ['tabular-nums'],
            }}
          >
            {formatRemainingMs(remainingMs)}
          </AppText>
        </View>
      </View>
      {summary ? (
        <AppText variant="footnote" color="textSecondary" numberOfLines={2}>
          {summary}
        </AppText>
      ) : null}
      <View style={[styles.row, styles.between, { gap: theme.space.sm }]}>
        <AppText variant="caption" color="textTertiary" numberOfLines={1}>
          {sessionTitle ?? '会话'}
        </AppText>
        <AppText variant="caption" color="textTertiary">
          {time}
        </AppText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  between: {
    justifyContent: 'space-between',
  },
  toolName: {
    flex: 1,
  },
});

export default ApprovalListItem;
