// 会话列表页（R2-05 部分 4：会话列表完整形态——预览 / 相对时间 / 未读角标 / 交互）
// - 行 = SessionRow（标题 + 预览（eventStore 窗口尾部条目文本，lastPreviewOfWindow 纯函数派生）
//   + 相对时间（time.ts formatRelativeTime）+ 运行状态（activeRunIds，F1 §5.2）
//   + 未读角标（unreadCount，F5 §6.3）+ 审批角标（pendingApprovalCount，F2 口径））；
// - 交互：行点击 → 会话详情（onOpenSession）；角标点击 → 审批列表（onOpenApprovals）；
// - 数据面：sessionStore.sessions（store 已按 F1 §4.4 排序：置顶 → 活动 → updatedAt 降序）
//   + eventStore.windows（预览来源，无窗口行不渲染预览行）；
// - 路由注入 onOpenApprovals / onOpenSession（页面不依赖 expo-router，组件测试可直接挂载）。
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useEventStore, useSessionStore } from '@/adapters/hooks/useAppStore';
import { lastPreviewOfWindow } from '@/domain/pure/sessionPreview';
import { SessionRow } from '@/presentation/components/sessions';

export interface SessionsScreenProps {
  /** 跳转审批列表（角标点击，路由注入） */
  onOpenApprovals: () => void;
  /** 进入会话详情（行点击，路由注入） */
  onOpenSession: (sessionId: string) => void;
}

export default function SessionsScreen({
  onOpenApprovals,
  onOpenSession,
}: SessionsScreenProps) {
  const theme = useTheme();
  const sessions = useSessionStore((s) => s.sessions);
  const windows = useEventStore((s) => s.windows);

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
        <SessionRow
          session={item}
          preview={lastPreviewOfWindow(windows[item.id])}
          onOpen={onOpenSession}
          onOpenApprovals={onOpenApprovals}
        />
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
});
