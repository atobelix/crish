// 会话详情页（R2-05 部分 3：该会话事件流；F3 §3.1 主形态 feed / F5 §6.3 未读清零）
// - 元信息头：会话名称 / 状态（运行中·待审批·空闲）/ 游标（lastSeq）/ 网络相位；
// - 事件流：复用 EventFeed（过滤条 + 事件行），follow 参数化自动滚底（R2UX-05-03：
//   上翻超 40dp 暂停跟随，页面浮出「回到底部」悬浮条，点击恢复吸底）；
// - 未读清零（F5 §6.3）：详情打开且跟随底部 → sessionStore.markRead(sessionId, lastSeq)；
// - 空态由 EventFeed 承接（M4 §5.9 文案）；「只看当前 run」以最近 agent-start 的 runId 为准；
// - onBack 由路由注入（页面不依赖 expo-router，组件测试可直接挂载）；
// - 热区（R2-16 §3.2 第 8 项修复）：「回到底部」悬浮条视觉 minHeight 36 → HitSlop 补足
//   （iOS 44 / Android 48 双轨）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useEventStore, useSessionStore } from '@/adapters/hooks/useAppStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { readString, type FeedEntry } from '@/domain/store/eventReducers';
import { EventFeed } from '@/presentation/components/blocks/EventFeed';
import { dualHitSlop } from '@/presentation/components/ui/hitTargets';

/** 会话状态文案（F1 §4.4 活动判定：活动 run / 待审批 → 活动态） */
export function sessionStatusLabel(summary: {
  activeRunIds: readonly string[];
  pendingApprovalCount: number;
}): string {
  if (summary.activeRunIds.length > 0) return '运行中';
  if (summary.pendingApprovalCount > 0) return '待审批';
  return '空闲';
}

/** 网络相位文案（F3 §3.2.1 三态） */
export function networkLabel(
  network: 'live' | 'reconnecting' | 'offline'
): string {
  if (network === 'live') return '实时';
  if (network === 'reconnecting') return '重连中';
  return '离线';
}

/** 当前 run 派生（F3 §5.1「只看当前 run」数据面：最近 agent-start 的 runId，缺省兜底最近带 runId 条目） */
export function latestRunIdOf(entries: readonly FeedEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type === 'agent-start') {
      const runId = readString(entry, 'runId');
      if (runId) return runId;
    }
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const runId = readString(entries[i]!, 'runId');
    if (runId) return runId;
  }
  return null;
}

export interface SessionDetailScreenProps {
  sessionId: string;
  /** 返回动作（路由注入 router.back；测试可注入 spy） */
  onBack?: () => void;
}

export default function SessionDetailScreen({
  sessionId,
  onBack,
}: SessionDetailScreenProps) {
  const theme = useTheme();
  const window = useEventStore((s) => s.windows[sessionId] ?? EMPTY_WINDOW);
  const network = useEventStore((s) => s.network);
  const summary = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId) ?? null
  );
  const [follow, setFollow] = useState(true);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [runOnly, setRunOnly] = useState(false);
  const [toolOnly, setToolOnly] = useState(false);
  const listRef = useRef<FlatList<FeedEntry> | null>(null);
  const currentRunId = useMemo(
    () => latestRunIdOf(window.entries),
    [window.entries]
  );

  // 未读清零（F5 §6.3：详情打开且滚动到底 → lastReadSequence 前移 + 未读清零；只升不降）
  useEffect(() => {
    if (follow && window.lastSeq > 0) {
      sessionStore.getState().markRead(sessionId, window.lastSeq);
    }
  }, [sessionId, follow, window.lastSeq]);

  return (
    <View style={[styles.container, { backgroundColor: theme.bgPrimary }]}>
      <View style={[styles.header, { borderBottomColor: theme.hairline }]}>
        <Pressable
          testID="header-back"
          accessibilityRole="button"
          accessibilityLabel="返回"
          onPress={onBack}
          style={styles.backButton}
        >
          <Text style={[styles.backText, { color: theme.textPrimary }]}>
            ← 返回
          </Text>
        </Pressable>
        <View style={styles.headerBody}>
          <Text
            testID="session-detail-name"
            numberOfLines={1}
            style={[styles.headerTitle, { color: theme.textPrimary }]}
          >
            {summary?.title ?? sessionId}
          </Text>
          <Text
            testID="session-detail-meta"
            style={[styles.headerMeta, { color: theme.textSecondary }]}
          >
            {summary
              ? `${sessionStatusLabel(summary)} · 已同步 #${window.lastSeq} · ${networkLabel(network)}`
              : `已同步 #${window.lastSeq} · ${networkLabel(network)}`}
          </Text>
        </View>
      </View>

      <EventFeed
        entries={window.entries}
        errorsOnly={errorsOnly}
        runOnly={runOnly}
        toolOnly={toolOnly}
        currentRunId={currentRunId}
        onToggleErrors={() => setErrorsOnly((v) => !v)}
        onToggleRun={() => setRunOnly((v) => !v)}
        onToggleTool={() => setToolOnly((v) => !v)}
        follow={follow}
        onFollowChange={setFollow}
        listRef={listRef}
      />

      {!follow ? (
        <Pressable
          testID="session-back-to-bottom"
          accessibilityRole="button"
          accessibilityLabel="回到底部"
          onPress={() => {
            listRef.current?.scrollToEnd({ animated: true });
            setFollow(true);
          }}
          hitSlop={dualHitSlop(36)}
          style={[styles.followBar, { backgroundColor: theme.bgElevated }]}
        >
          <Text style={[styles.followText, { color: theme.textPrimary }]}>
            ▼ 回到底部
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** 空窗口兜底常量（useShallow 引用稳定：未建窗不触发重渲染） */
const EMPTY_WINDOW = { entries: [], lastSeq: 0, truncatedCount: 0 } as const;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingRight: 8,
  },
  backText: {
    fontSize: 15,
  },
  headerBody: {
    flex: 1,
    gap: 2,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  headerMeta: {
    fontSize: 12,
  },
  followBar: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    minHeight: 36,
    borderRadius: 9999,
    paddingHorizontal: 16,
    justifyContent: 'center',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  followText: {
    fontSize: 13,
    fontWeight: '500',
  },
});
