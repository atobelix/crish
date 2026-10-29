// 待审批队列：作为 /approvals 底部 sheet 的内容（无自有导航头；历史入口在抽屉「审批记录」）。
import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useApprovalListVm } from '@/adapters/viewmodels/useApprovalListVm';
import { useSessionStore } from '@/adapters/hooks/useAppStore';
import { AppText, EmptyState, Icon } from '@/presentation/ui';
import { ApprovalListItem } from '@/presentation/components/approval/ApprovalListItem';

export interface ApprovalListScreenProps {
  onOpenItem: (toolCallId: string) => void;
}

export default function ApprovalListScreen({
  onOpenItem,
}: ApprovalListScreenProps) {
  const theme = useTheme();
  const vm = useApprovalListVm();
  const sessions = useSessionStore((s) => s.sessions);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void vm.refresh().finally(() => setRefreshing(false));
  }, [vm]);

  return (
    <View style={styles.flex}>
      <View
        style={[
          styles.titleRow,
          {
            minHeight: theme.size.header,
            paddingHorizontal: theme.space.screenX,
            gap: theme.space.sm,
          },
        ]}
      >
        <AppText variant="headline" accessibilityRole="header">
          待审批
        </AppText>
        {vm.rows.length > 0 ? (
          <AppText variant="footnote" color="textTertiary">
            {vm.rows.length} 项
          </AppText>
        ) : null}
      </View>
      {vm.outboxCount > 0 ? (
        <View
          style={[
            styles.banner,
            {
              marginHorizontal: theme.space.lg,
              marginBottom: theme.space.sm,
              minHeight: theme.size.summaryRow,
              paddingHorizontal: theme.space.md,
              gap: theme.space.sm,
              borderRadius: theme.radius.control,
              backgroundColor: theme.colors.warningSoft,
            },
          ]}
        >
          <Icon
            name="wifi-off"
            size={theme.size.iconSmall}
            color={theme.colors.warning}
          />
          <AppText variant="footnote" color="warning">
            {vm.outboxCount} 条决策等待网络恢复后发送
          </AppText>
        </View>
      ) : null}
      <FlatList
        testID="approval-list"
        data={vm.rows}
        keyExtractor={({ item }) => item.request.toolCallId}
        renderItem={({ item }) => (
          <ApprovalListItem
            item={item.item}
            remainingMs={item.remainingMs}
            sessionTitle={
              sessions.find((s) => s.id === item.item.request.sessionId)
                ?.title ?? null
            }
            onPress={onOpenItem}
          />
        )}
        contentContainerStyle={[
          { paddingBottom: theme.space.section, gap: theme.space.md },
          vm.rows.length === 0 && styles.emptyContent,
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={theme.colors.textTertiary}
          />
        }
        ListEmptyComponent={<EmptyState icon="shield" title="暂无待审批" />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center' },
  emptyContent: { flexGrow: 1, justifyContent: 'center' },
  banner: { flexDirection: 'row', alignItems: 'center' },
});
