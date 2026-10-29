// 运行详情：状态、控制、时间线、终端入口。
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useEventStore, useSessionStore } from '@/adapters/hooks/useAppStore';
import { ensureRunHistory } from '@/adapters/runtime/appRuntime';
import { useRunControlVm } from '@/adapters/viewmodels/useRunControlVm';
import {
  deriveRunStatus,
  entriesOfRun,
} from '@/presentation/components/terminal/terminalEvents';
import {
  deriveRunBadge,
  formatDuration,
  runBadgeLabel,
  runBadgeTone,
  runControlActionsOf,
  sessionIdOfRun,
} from '@/presentation/components/runDetail/runDetailMeta';
import { RunControlBar } from '@/presentation/components/runDetail/RunControlBar';
import {
  buildSessionTimeline,
  formatClock,
} from '@/presentation/timeline/buildTimeline';
import type { DisplayBlock } from '@/presentation/timeline/groupToolRuns';
import { TimelineView } from '@/presentation/timeline/TimelineView';
import {
  AppHeader,
  AppText,
  Button,
  EmptyState,
  IconButton,
  Screen,
  ScrollToBottomButton,
} from '@/presentation/ui';

export interface RunDetailScreenProps {
  runId: string;
  onBack: () => void;
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
  const listRef = useRef<FlatList<DisplayBlock> | null>(null);

  const entries = useMemo(() => entriesOfRun(windows, runId), [windows, runId]);
  const status = useMemo(
    () => deriveRunStatus(entries, runId),
    [entries, runId]
  );
  const sessionId = useMemo(() => sessionIdOfRun(entries), [entries]);
  const sessionTitle = useSessionStore(
    (s) => s.sessions.find((session) => session.id === sessionId)?.title ?? null
  );
  const vm = useRunControlVm(runId, sessionId ?? '');
  const badge = deriveRunBadge(status, { paused: vm.paused });
  const actions = runControlActionsOf(status, vm.paused);
  const blocks = useMemo(() => buildSessionTimeline(entries), [entries]);

  useEffect(() => {
    ensureRunHistory(runId);
  }, [runId]);

  const tone =
    runBadgeTone(badge, status.state) === 'success'
      ? theme.colors.success
      : runBadgeTone(badge, status.state) === 'error'
        ? theme.colors.danger
        : runBadgeTone(badge, status.state) === 'warning'
          ? theme.colors.warning
          : runBadgeTone(badge, status.state) === 'info'
            ? theme.colors.info
            : theme.colors.textTertiary;

  const metaParts: string[] = [];
  if (status.startedAtMs !== undefined) {
    metaParts.push(`开始 ${formatClock(status.startedAtMs)}`);
  }
  if (status.startedAtMs !== undefined) {
    metaParts.push(
      `用时 ${formatDuration(status.startedAtMs, status.endedAtMs)}`
    );
  }
  const hasStatus =
    entries.length > 0 || metaParts.length > 0 || Boolean(status.reason);

  return (
    <Screen>
      <AppHeader
        title="运行"
        onBack={onBack}
        actions={
          onOpenTerminal ? (
            <IconButton
              name="terminal"
              accessibilityLabel="查看终端输出"
              onPress={onOpenTerminal}
              testID="run-open-terminal"
            />
          ) : undefined
        }
      />
      {hasStatus ? (
        <View
          style={[
            styles.statusBar,
            { borderBottomColor: theme.colors.hairline },
          ]}
        >
          {entries.length > 0 ? (
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.dot,
                  { borderRadius: theme.radius.pill, backgroundColor: tone },
                ]}
              />
              <AppText variant="bodyStrong" style={{ color: tone }}>
                {runBadgeLabel(badge, status.state)}
              </AppText>
              <AppText
                variant="footnote"
                color="textTertiary"
                numberOfLines={1}
                style={styles.session}
              >
                {sessionTitle ?? (sessionId ? '会话' : '未知会话')}
              </AppText>
            </View>
          ) : null}
          {metaParts.length > 0 ? (
            <AppText variant="caption" color="textTertiary">
              {metaParts.join(' · ')}
            </AppText>
          ) : null}
          {status.reason ? (
            <AppText variant="footnote" color="danger" numberOfLines={2}>
              {status.reason}
            </AppText>
          ) : null}
        </View>
      ) : null}
      {entries.length > 0 && actions.length > 0 ? (
        <RunControlBar actions={actions} vm={vm} />
      ) : null}
      {blocks.length === 0 ? (
        <EmptyState
          icon="activity"
          title="暂无运行记录"
          action={<Button label="返回" variant="secondary" onPress={onBack} />}
        />
      ) : (
        <TimelineView
          blocks={blocks}
          follow={follow}
          onFollowChange={setFollow}
          listRef={listRef}
        />
      )}
      {!follow && blocks.length > 0 ? (
        <ScrollToBottomButton
          onPress={() => {
            listRef.current?.scrollToEnd({ animated: true });
            setFollow(true);
          }}
          testID="run-back-to-bottom"
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
  },
  session: {
    flex: 1,
    textAlign: 'right',
  },
});
