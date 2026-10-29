// 抽屉历史会话：「今天 / 更早」两组纯标题行，空态区分无会话、同步中与搜索无结果。
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { AppText } from '@/presentation/ui';
import { SessionListItem } from '@/presentation/components/sessions/SessionListItem';

export interface DrawerSessionGroupsProps {
  today: readonly SessionSummary[];
  earlier: readonly SessionSummary[];
  hasSessions: boolean;
  connected: boolean;
  selectedSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
}

interface GroupProps {
  label: string;
  sessions: readonly SessionSummary[];
  selectedSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
}

function SessionGroup({
  label,
  sessions,
  selectedSessionId,
  onOpenSession,
}: GroupProps) {
  const theme = useTheme();
  if (sessions.length === 0) return null;
  return (
    <View style={{ marginTop: theme.space.lg }}>
      <AppText
        variant="sectionLabel"
        color="textTertiary"
        style={{
          paddingHorizontal: theme.space.md,
          paddingBottom: theme.space.xs,
        }}
      >
        {label}
      </AppText>
      {sessions.map((session) => (
        <SessionListItem
          key={session.id}
          session={session}
          selected={session.id === selectedSessionId}
          onPress={onOpenSession}
        />
      ))}
    </View>
  );
}

function emptyText(hasSessions: boolean, connected: boolean): string {
  if (hasSessions) return '没有匹配的会话';
  return connected ? '还没有会话' : '正在同步会话…';
}

export function DrawerSessionGroups({
  today,
  earlier,
  hasSessions,
  connected,
  selectedSessionId,
  onOpenSession,
}: DrawerSessionGroupsProps) {
  const theme = useTheme();
  if (today.length === 0 && earlier.length === 0) {
    return (
      <AppText
        variant="footnote"
        color="textTertiary"
        testID="drawer-sessions-empty"
        style={[styles.empty, { padding: theme.space.xl }]}
      >
        {emptyText(hasSessions, connected)}
      </AppText>
    );
  }
  return (
    <View>
      <SessionGroup
        label="今天"
        sessions={today}
        selectedSessionId={selectedSessionId}
        onOpenSession={onOpenSession}
      />
      <SessionGroup
        label="更早"
        sessions={earlier}
        selectedSessionId={selectedSessionId}
        onOpenSession={onOpenSession}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { textAlign: 'center' },
});
