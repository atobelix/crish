// 会话行（抽屉）：纯标题；选中行浅灰底，运行中品牌色点，待审批警示色点。
import { memo } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { AppText, Badge } from '@/presentation/ui';

export interface SessionListItemProps {
  session: SessionSummary;
  onPress: (sessionId: string) => void;
  /** 当前打开的会话 */
  selected?: boolean;
}

function sessionTitle(session: SessionSummary): string {
  return session.title?.trim() || '未命名会话';
}

function sessionA11yLabel(session: SessionSummary): string {
  const running = session.activeRunIds.length > 0 ? '，运行中' : '';
  const approvals =
    session.pendingApprovalCount > 0
      ? `，${session.pendingApprovalCount} 项待审批`
      : '';
  const unread =
    session.unreadCount > 0 ? `，${session.unreadCount} 条未读` : '';
  return `会话：${sessionTitle(session)}${running}${approvals}${unread}`;
}

export const SessionListItem = memo(function SessionListItem({
  session,
  onPress,
  selected = false,
}: SessionListItemProps) {
  const theme = useTheme();
  return (
    <Pressable
      testID={`session-row-${session.id}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={sessionA11yLabel(session)}
      onPress={() => onPress(session.id)}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: theme.size.touch,
          paddingHorizontal: theme.space.md,
          gap: theme.space.sm,
          borderRadius: theme.radius.control,
        },
        selected && { backgroundColor: theme.colors.fillSubtle },
        pressed && { backgroundColor: theme.colors.fillPressed },
      ]}
    >
      <AppText variant="body" numberOfLines={1} style={styles.flex}>
        {sessionTitle(session)}
      </AppText>
      {session.pendingApprovalCount > 0 ? (
        <Badge dot tone="warning" testID="session-approval-badge" />
      ) : null}
      {session.activeRunIds.length > 0 ? (
        <Badge dot tone="accent" testID="session-running" />
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});

export default SessionListItem;
