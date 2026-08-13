// run 详情元信息头 / 状态条（R2-05 部分 6 / R2UX-05-08：状态条不参与重渲染）
// - memo 隔离：props 全为原始值（string/number/boolean），时间线滚动等
//   页面级内部状态变化不触发本组件重渲染（React.memo 浅比较）；
// - 状态徽标（F1 §5.1 五色分组 × 事件流派生）：色点 + 文案双通道（M4 §6.5）；
//   状态/文案/色调由 runDetailMeta 纯函数派生，组件只做 token 映射；
// - 元信息：会话名（页面已兜底 title ?? id）+ runId + 开始/结束时钟时间 +
//   用时（页面注入，保证事件到达时新鲜、滚动时不重算）；
// - 失败/收口原因行（run-terminal error 优先，F3 §3.3.3 红色高亮）。
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme, type ThemeTokens } from '@/adapters/platform/theme';
import type { RunBadgeTone } from './runDetailMeta';

export interface RunDetailHeaderProps {
  runId: string;
  /** 会话名（页面已兜底 title ?? id） */
  sessionTitle: string;
  /** 徽标文案（runBadgeLabel 产物；terminal 细分已收敛） */
  badgeLabel: string;
  /** 徽标色调（runBadgeTone 产物） */
  tone: RunBadgeTone;
  /** 失败/收口原因（run-terminal error/reason，无则隐藏） */
  reason?: string;
  /** 开始时钟（agent-start 收达时刻） */
  startedAtMs?: number;
  /** 结束时钟（run-terminal 收达时刻） */
  endedAtMs?: number;
  /** 用时文案（页面注入：formatDuration 快照；滚动不重算、事件到达时新鲜） */
  durationLabel: string;
  /** 开始时间格式化（HH:mm:ss，EventRow.formatFeedTime 语义） */
  formatClock: (ms: number) => string;
}

/** 色调 → 主题 token 映射（M4 §3.8 禁硬编码；双通道色点 + 文字） */
export function toneColorOf(
  tone: RunBadgeTone,
  theme: Pick<
    ThemeTokens,
    | 'colorInfo'
    | 'colorWarning'
    | 'colorError'
    | 'colorSuccess'
    | 'textTertiary'
  >
): string {
  switch (tone) {
    case 'info':
      return theme.colorInfo;
    case 'warning':
      return theme.colorWarning;
    case 'error':
      return theme.colorError;
    case 'success':
      return theme.colorSuccess;
    default:
      return theme.textTertiary;
  }
}

export function RunDetailHeaderView({
  runId,
  sessionTitle,
  badgeLabel,
  tone,
  reason,
  startedAtMs,
  endedAtMs,
  durationLabel,
  formatClock,
}: RunDetailHeaderProps) {
  const theme = useTheme();
  const toneColor = toneColorOf(tone, theme);

  const timeParts: string[] = [];
  if (startedAtMs !== undefined)
    timeParts.push(`开始 ${formatClock(startedAtMs)}`);
  if (endedAtMs !== undefined) timeParts.push(`结束 ${formatClock(endedAtMs)}`);
  if (durationLabel.length > 0) timeParts.push(`用时 ${durationLabel}`);

  return (
    <View testID="run-detail-header" style={styles.container}>
      <View style={styles.badgeLine}>
        <View
          testID="run-badge-dot"
          style={[styles.dot, { backgroundColor: toneColor }]}
        />
        <Text
          testID="run-badge"
          style={[styles.badgeText, { color: toneColor }]}
        >
          {badgeLabel}
        </Text>
        <Text
          testID="run-badge-run-id"
          numberOfLines={1}
          style={[styles.runIdText, { color: theme.textSecondary }]}
        >
          run {runId}
        </Text>
      </View>
      <Text
        testID="run-detail-session"
        numberOfLines={1}
        style={[styles.sessionText, { color: theme.textPrimary }]}
      >
        {sessionTitle}
      </Text>
      {timeParts.length > 0 ? (
        <Text
          testID="run-detail-times"
          style={[styles.timeText, { color: theme.textTertiary }]}
        >
          {timeParts.join(' · ')}
        </Text>
      ) : null}
      {reason ? (
        <Text
          testID="run-detail-reason"
          numberOfLines={2}
          style={[styles.reasonText, { color: theme.colorError }]}
        >
          {reason}
        </Text>
      ) : null}
    </View>
  );
}

/** 状态条 memo 包裹（R2UX-05-08：时间线滚动/过滤等页面内部状态不触发重渲染） */
export const RunDetailHeader = memo(RunDetailHeaderView);

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 4,
  },
  badgeLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  badgeText: {
    fontSize: 15,
    fontWeight: '600',
  },
  runIdText: {
    flex: 1,
    fontSize: 13,
  },
  sessionText: {
    fontSize: 14,
    fontWeight: '500',
  },
  timeText: {
    fontSize: 12,
  },
  reasonText: {
    fontSize: 12,
    lineHeight: 17,
  },
});
