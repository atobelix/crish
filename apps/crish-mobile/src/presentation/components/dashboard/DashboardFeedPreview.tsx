// 首页最近动态预览（F1 §4.3 时间线摘要 · R4 批次3 补全）：
// - 数据面：feed 所属会话（排序不变量 sessions[0]）窗口尾部 N 条（feedPreviewOf 倒序切片），
//   行渲染复用 EventRow（与事件流同一行组件，单一真理源；流式摘要经 StreamingText 节流）；
// - 「查看全部」→ 会话详情（页面注入导航；无会话时不渲染本区）；
// - 组件契约（M4 §2.2.2）：数据由页面注入（entries/sessionId/sessionTitle），组件不订阅 store。
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { FeedEntry } from '@/domain/store/eventReducers';
import { EventRow } from '@/presentation/components/blocks/EventRow';
import { useTheme } from '@/adapters/platform/theme';

export interface DashboardFeedPreviewProps {
  /** feed 所属会话 id（null = 无会话，本区不渲染） */
  sessionId: string | null;
  /** 会话标题（缺省回退 id 展示） */
  sessionTitle: string | null;
  /** 预览条目（最新在前，feedPreviewOf 切片产物） */
  entries: readonly FeedEntry[];
  /** 查看全部（页面注入导航；测试 spy） */
  onOpenSession: (sessionId: string) => void;
}

export function DashboardFeedPreview({
  sessionId,
  sessionTitle,
  entries,
  onOpenSession,
}: DashboardFeedPreviewProps) {
  const theme = useTheme();
  if (sessionId === null) return null;

  return (
    <View style={[styles.card, { backgroundColor: theme.bgCard }]}>
      <View style={styles.header}>
        <Text
          style={[styles.title, { color: theme.textPrimary }]}
          numberOfLines={1}
        >
          {sessionTitle && sessionTitle.trim().length > 0
            ? sessionTitle
            : sessionId}
        </Text>
        <Pressable
          testID="dashboard-feed-open"
          accessibilityRole="button"
          accessibilityLabel="查看会话全部动态"
          onPress={() => onOpenSession(sessionId)}
          hitSlop={8}
          style={({ pressed }) => [styles.openBtn, pressed && styles.pressed]}
        >
          <Text style={[styles.openText, { color: theme.colorInfo }]}>
            查看全部
          </Text>
        </Pressable>
      </View>
      {entries.length === 0 ? (
        <Text style={[styles.empty, { color: theme.textTertiary }]}>
          暂无动态；连接后事件将在此滚动
        </Text>
      ) : (
        <View>
          {entries.map((entry) => (
            <EventRow
              key={`${entry.sessionId}:${entry.sequence}`}
              entry={entry}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    gap: 6,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 36,
    gap: 8,
  },
  title: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
  },
  openBtn: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  openText: {
    fontSize: 13,
    fontWeight: '500',
  },
  pressed: {
    opacity: 0.7,
  },
  empty: {
    fontSize: 12,
    paddingVertical: 8,
  },
});
