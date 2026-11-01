// 会话行（抽屉）：纯标题 + 状态徽标；选中行浅灰底。
// 待审批 = 橙点 + 「待审批」弱文字（原型 session-item-badge）；运行中 = 品牌色点。
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
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
  const pending = session.pendingApprovalCount > 0;
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
      {pending ? (
        <View
          testID="session-approval-badge"
          style={[styles.badge, { gap: theme.space.xs + 1 }]}
        >
          <Badge dot tone="warning" />
          <AppText variant="caption" color="textTertiary">
            待审批
          </AppText>
        </View>
      ) : null}
      {!pending && session.activeRunIds.length > 0 ? (
        <Badge dot tone="accent" testID="session-running" />
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  badge: { flexDirection: 'row', alignItems: 'center' },
});

export default SessionListItem;
