// run 详情页（R2-05 部分 6：app/run/[runId] 目标，F1 §4.3 / R2UX-05-08）
// - 元信息头：状态徽标（F1 §5.1 五色分组 × 事件流派生，deriveRunBadge）+
//   会话（sessionStore 标题兜底）+ 开始/结束时间 + 用时（事件到达时新鲜、
//   滚动不重算——durationLabel 由页面注入，R2UX-05-08 状态条 memo 隔离）；
// - run 控制（L2/L3 分级，D4 §5.6）：runControlActionsOf 编排按钮（终态隐藏 /
//   paused 换恢复），RunControlBar 承载发送/反馈/取消二次确认；
// - 时间线：复用 EventFeed/EventRow（RunDetailTimeline，游标分页 200/页）；
//   跨窗口按 runId 过滤（entriesOfRun 语义，不依赖会话归属）；
// - 终端入口：跳转 terminal/[runId]（onOpenTerminal 由路由注入）；
// - 空态（F1 §4.7 / M4 §5.9）：run 无任何事件 → 占位「该 run 暂无事件」
//   （run 不存在或事件尚未同步，诚实化不伪造数据）；
// - onBack / onOpenTerminal 由路由注入（页面不依赖 expo-router，组件测试直挂）。
import { useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useEventStore, useSessionStore } from '@/adapters/hooks/useAppStore';
import type { FeedEntry } from '@/domain/store/eventReducers';
import { formatFeedTime } from '@/presentation/components/blocks/EventRow';
import {
  deriveRunStatus,
  entriesOfRun,
} from '@/presentation/components/terminal/terminalEvents';
import { useRunControlVm } from '@/adapters/viewmodels/useRunControlVm';
import { RunDetailHeader } from '@/presentation/components/runDetail/RunDetailHeader';
import { RunControlBar } from '@/presentation/components/runDetail/RunControlBar';
import { RunDetailTimeline } from '@/presentation/components/runDetail/RunDetailTimeline';
import {
  deriveRunBadge,
  formatDuration,
  runBadgeLabel,
  runBadgeTone,
  runControlActionsOf,
  sessionIdOfRun,
  truncatedCountOfRun,
} from '@/presentation/components/runDetail/runDetailMeta';

export interface RunDetailScreenProps {
  runId: string;
  /** 返回动作（路由注入 router.back；测试可注入 spy） */
  onBack?: () => void;
  /** 打开终端回放（路由注入 router.push(`/terminal/${runId}`)；测试可注入 spy） */
  onOpenTerminal?: () => void;
}

export default function RunDetailScreen({
  runId,
  onBack,
  onOpenTerminal,
}: RunDetailScreenProps) {
  const theme = useTheme();
  const windows = useEventStore((s) => s.windows);
  const [follow, setFollow] = useState(true);
  const listRef = useRef<FlatList<FeedEntry> | null>(null);

  // 数据面：跨窗口按 runId 过滤（seq 升序）→ 状态/会话/淘汰计数派生
  const entriesAsc = useMemo(
    () => entriesOfRun(windows, runId),
    [windows, runId]
  );
  const status = useMemo(
    () => deriveRunStatus(entriesAsc, runId),
    [entriesAsc, runId]
  );
  const sessionId = useMemo(() => sessionIdOfRun(entriesAsc), [entriesAsc]);
  const summary = useSessionStore((s) =>
    sessionId ? (s.sessions.find((x) => x.id === sessionId) ?? null) : null
  );
  const truncatedCount = useMemo(
    () => truncatedCountOfRun(windows, runId),
    [windows, runId]
  );

  // 控制面（连接相位 + 发送/反馈/二次确认；sessionId 未知时页面不渲染控制区）
  const vm = useRunControlVm(runId, sessionId ?? '');

  const badge = deriveRunBadge(status, { paused: vm.paused });
  const actions = runControlActionsOf(status, vm.paused);
  const sessionTitle =
    summary?.title && summary.title.trim().length > 0
      ? summary.title
      : (sessionId ?? '未知会话');
  const durationLabel =
    status.startedAtMs !== undefined
      ? formatDuration(status.startedAtMs, status.endedAtMs)
      : ''; // 无 agent-start（事件缺失）→ 零时长展示，诚实化不伪造

  const hasEntries = entriesAsc.length > 0;

  return (
    <View style={[styles.container, { backgroundColor: theme.bgPrimary }]}>
      <View style={[styles.topBar, { borderBottomColor: theme.hairline }]}>
        <Pressable
          testID="run-detail-back"
          accessibilityRole="button"
          accessibilityLabel="返回"
          onPress={onBack}
          style={styles.backButton}
        >
          <Text style={[styles.backText, { color: theme.textPrimary }]}>
            ← 返回
          </Text>
        </Pressable>
        <Text
          testID="run-detail-title"
          style={[styles.titleText, { color: theme.textPrimary }]}
        >
          run 详情
        </Text>
      </View>

      <RunDetailHeader
        runId={runId}
        sessionTitle={sessionTitle}
        badgeLabel={runBadgeLabel(badge, status.state)}
        tone={runBadgeTone(badge, status.state)}
        reason={status.reason}
        startedAtMs={status.startedAtMs}
        endedAtMs={status.endedAtMs}
        durationLabel={durationLabel}
        formatClock={formatFeedTime}
      />

      {hasEntries ? (
        <>
          {actions.length > 0 ? (
            <RunControlBar actions={actions} vm={vm} />
          ) : null}
          {onOpenTerminal ? (
            <Pressable
              testID="run-detail-open-terminal"
              accessibilityRole="button"
              accessibilityLabel="查看终端输出"
              onPress={onOpenTerminal}
              style={({ pressed }) => [
                styles.terminalRow,
                { borderColor: theme.hairline },
                pressed && styles.terminalPressed,
              ]}
            >
              <Text style={[styles.terminalText, { color: theme.colorInfo }]}>
                查看终端输出 →
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : null}

      {hasEntries ? (
        <RunDetailTimeline
          runId={runId}
          entriesAsc={entriesAsc}
          truncatedCount={truncatedCount}
          follow={follow}
          onFollowChange={setFollow}
          listRef={listRef}
        />
      ) : (
        <View style={styles.emptyWrap} testID="run-detail-empty">
          <Text style={[styles.emptyTitle, { color: theme.textPrimary }]}>
            该 run 暂无事件
          </Text>
          <Text style={[styles.emptyHint, { color: theme.textSecondary }]}>
            run 可能不存在或事件尚未同步（F1 §4.7）
          </Text>
        </View>
      )}

      {!follow && hasEntries ? (
        <Pressable
          testID="run-detail-back-to-bottom"
          accessibilityRole="button"
          accessibilityLabel="回到底部"
          onPress={() => {
            listRef.current?.scrollToEnd({ animated: true });
            setFollow(true);
          }}
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topBar: {
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
  titleText: {
    fontSize: 16,
    fontWeight: '600',
  },
  terminalRow: {
    marginHorizontal: 16,
    marginTop: 8,
    minHeight: 40,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  terminalPressed: {
    opacity: 0.7,
  },
  terminalText: {
    fontSize: 13,
    fontWeight: '500',
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  emptyHint: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
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
