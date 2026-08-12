// 会话列表页（R2-04 部分 3：最小会话列表 + 审批角标；完整列表形态（预览/相对时间/未读等）归 R2-05）
// - 行 = 会话标题 + ApprovalBadge（pendingApprovalCount > 0 显示「N 待审批」风险色胶囊，
//   F2 任务书 R2-04-02）；点击行或角标 → onOpenApprovals（任务书允许「跳转审批列表或对应 run 的审批」）；
// - 数据面：sessionStore.sessions（store 已按 F1 §4.4 排序：置顶 → 活动 → updatedAt 降序）；
// - 路由注入 onOpenApprovals（页面不依赖 expo-router，组件测试可直接挂载）。
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useSessionStore } from '@/adapters/hooks/useAppStore';
import ApprovalBadge from '@/presentation/components/blocks/ApprovalBadge';

export interface SessionsScreenProps {
  /** 跳转审批列表（会话行 / 角标点击，路由注入） */
  onOpenApprovals: () => void;
}

export default function SessionsScreen({
  onOpenApprovals,
}: SessionsScreenProps) {
  const theme = useTheme();
  const sessions = useSessionStore((s) => s.sessions);

  // 空态（M4 §5.9 文案模板）
  if (sessions.length === 0) {
    return (
      <View style={[styles.container, styles.center]} testID="sessions-empty">
        <Text style={[styles.emptyTitle, { color: theme.textPrimary }]}>
          暂无会话
        </Text>
        <Text style={[styles.emptySub, { color: theme.textSecondary }]}>
          当桌面端 Agent 开始任务后，会话会出现在这里
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      testID="sessions-list"
      style={[styles.container, { backgroundColor: theme.bgPrimary }]}
      data={sessions}
      keyExtractor={(s) => s.id}
      renderItem={({ item }) => (
        <Pressable
          testID={`session-row-${item.id}`}
          accessibilityRole="button"
          accessibilityLabel={`会话：${item.title ?? item.id}，${item.pendingApprovalCount > 0 ? `${item.pendingApprovalCount} 项待审批` : '无待审批'}`}
          onPress={onOpenApprovals}
          style={({ pressed }) => [
            styles.row,
            { borderBottomColor: theme.hairline },
            pressed && { backgroundColor: theme.bgTertiary },
          ]}
        >
          <Text
            style={[styles.rowTitle, { color: theme.textPrimary }]}
            numberOfLines={1}
          >
            {item.title ?? item.id}
          </Text>
          <ApprovalBadge
            count={item.pendingApprovalCount}
            onPress={onOpenApprovals}
          />
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  emptySub: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  rowTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
  },
});
