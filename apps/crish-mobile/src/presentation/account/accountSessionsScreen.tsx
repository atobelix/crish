// 账号 v3 登录设备：本机置顶并带「本机」标签；其它设备点「退出」后需再点「确认」；下拉刷新。
import { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import {
  listAccountSessions,
  revokeAccountSessionById,
} from '@/adapters/account/accountService';
import { formatRelativeTime } from '@/domain/pure/time';
import type { AccountSessionInfo } from '@/domain/types/account';
import { AppText } from '@/presentation/ui';
import { AuthBar, AuthPage, BigTitle } from './ui';

/** 只保留有效会话，本机在前，其余按登录时间倒序 */
export function orderSessions(
  sessions: readonly AccountSessionInfo[]
): AccountSessionInfo[] {
  return sessions
    .filter((s) => !s.revoked)
    .sort((a, b) =>
      a.current === b.current ? b.createdAt - a.createdAt : a.current ? -1 : 1
    );
}

/** 服务端暂无设备名字段，先用 UA 兜底（见交付报告「后端缺口」） */
export function deviceLabelOf(session: AccountSessionInfo): string {
  return session.userAgent.trim() || '未知设备';
}

export interface AccountSessionsScreenProps {
  onBack: () => void;
}

export function AccountSessionsScreen({ onBack }: AccountSessionsScreenProps) {
  const theme = useTheme();
  const [sessions, setSessions] = useState<AccountSessionInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setSessions(orderSessions(await listAccountSessions()));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录设备加载失败');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRevoke = async (id: string) => {
    if (confirmingId !== id) {
      setConfirmingId(id);
      return;
    }
    setConfirmingId(null);
    try {
      await revokeAccountSessionById(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '退出失败');
    }
  };

  const renderItem = ({ item }: { item: AccountSessionInfo }) => {
    const confirming = confirmingId === item.id;
    return (
      <View
        testID={`account-session-${item.id}`}
        style={[
          styles.row,
          {
            height: theme.size.sessionRow,
            marginHorizontal: theme.layout.accountPageX,
            gap: theme.space.md,
            borderBottomColor: theme.colors.hairline,
          },
        ]}
      >
        <View style={styles.text}>
          <AppText variant="body" color="textPrimary" numberOfLines={1}>
            {deviceLabelOf(item)}
          </AppText>
          <AppText variant="footnote" color="textTertiary" numberOfLines={1}>
            {[item.ip, formatRelativeTime(item.createdAt)]
              .filter(Boolean)
              .join(' · ')}
          </AppText>
        </View>
        {item.current ? (
          <View
            style={{
              backgroundColor: theme.colors.fillPressed,
              borderRadius: theme.radius.pill,
              paddingHorizontal: theme.space.sm,
              paddingVertical: theme.space.xxs,
            }}
          >
            <AppText variant="caption" color="textSecondary">
              本机
            </AppText>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            testID={`account-session-revoke-${item.id}`}
            hitSlop={theme.space.sm}
            onPress={() => void onRevoke(item.id)}
          >
            <AppText
              variant="bodyStrong"
              color={confirming ? 'danger' : 'textSecondary'}
            >
              {confirming ? '确认' : '退出'}
            </AppText>
          </Pressable>
        )}
      </View>
    );
  };

  return (
    <AuthPage testID="account-sessions-screen">
      <AuthBar onBack={onBack} />
      <FlatList
        data={sessions}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ListHeaderComponent={
          <View style={{ paddingBottom: theme.space.lg }}>
            <BigTitle title="登录设备" />
            {error ? (
              <AppText
                variant="footnote"
                color="danger"
                testID="account-sessions-error"
                style={{
                  paddingHorizontal: theme.layout.accountPageX,
                  paddingTop: theme.space.sm,
                }}
              >
                {error}
              </AppText>
            ) : null}
          </View>
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load()}
            tintColor={theme.colors.textTertiary}
          />
        }
      />
    </AuthPage>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { flex: 1 },
});

export default AccountSessionsScreen;
