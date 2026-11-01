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
  /** 长按打开会话操作（G3：与 Composer 语音长按同为 App 既有手势面） */
  onLongPress?: (sessionId: string) => void;
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
  onLongPress,
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
      onLongPress={onLongPress ? () => onLongPress(session.id) : undefined}
      style={({ pressed }) => [
        styles.row,
        {
          // 原型 session-item：padding 11/12、行高约 40、字 14/500
          minHeight: theme.size.touch - 4,
          paddingVertical: theme.space.md - 1,
          paddingHorizontal: theme.space.md,
          gap: theme.space.sm,
          borderRadius: theme.radius.control,
        },
        selected && { backgroundColor: theme.colors.fillSelected },
        pressed && { backgroundColor: theme.colors.fillPressed },
      ]}
    >
      <AppText
        variant="body"
        numberOfLines={1}
        style={[styles.flex, styles.title]}
      >
        {sessionTitle(session)}
      </AppText>
      {pending ? (
        <View
          testID="session-approval-badge"
          style={[styles.badge, { gap: theme.space.xs + 1 }]}
        >
          <Badge dot tone="warning" dotSize={6.5} />
          <AppText
            variant="caption"
            color="textTertiary"
            style={{
              // 原型徽标文字 10.5/400（字号守卫口径：自 caption 派生，同 ApprovalFloatCard 先例）
              fontSize: theme.type.caption.fontSize - 2,
              lineHeight: theme.type.caption.lineHeight - 2,
            }}
          >
            待审批
          </AppText>
        </View>
      ) : null}
      {!pending && session.activeRunIds.length > 0 ? (
        <Badge dot tone="accent" dotSize={7} testID="session-running" />
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // 原型会话行字 14/500（body 为 14/400，仅提一档字重）
  title: { fontWeight: '500' },
  row: { flexDirection: 'row', alignItems: 'center' },
  badge: { flexDirection: 'row', alignItems: 'center' },
});

export default SessionListItem;
