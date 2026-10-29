// 终端只读回放：实时镜像优先，事件流重建兜底。
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useEventStore } from '@/adapters/hooks/useAppStore';
import { ensureRunHistory } from '@/adapters/runtime/appRuntime';
import { TerminalView } from '@/presentation/components/terminal/TerminalView';
import {
  appendTerminalChunk,
  createTerminalLineBuffer,
  terminalLinesOf,
} from '@/domain/pure/terminalLineBuffer';
import { terminalStore } from '@/domain/store/terminalStore';
import { terminalViewOf } from '@/domain/store/terminalReducers';
import {
  collectRunTerminalChunks,
  deriveRunStatus,
  entriesOfRun,
  type RunStatusView,
} from '@/presentation/components/terminal/terminalEvents';
import {
  AppHeader,
  AppText,
  Screen,
  ScrollToBottomButton,
} from '@/presentation/ui';

export function runStatusLabel(status: RunStatusView): string {
  switch (status.state) {
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'cancelled':
      return '已取消';
    case 'failed':
      return '失败';
    default:
      return '状态未知';
  }
}

export interface TerminalScreenProps {
  runId: string;
  onBack: () => void;
}

export default function TerminalScreen({ runId, onBack }: TerminalScreenProps) {
  const theme = useTheme();
  const windows = useEventStore((s) => s.windows);
  const [follow, setFollow] = useState(true);
  const listRef = useRef<FlatList<string> | null>(null);

  useEffect(() => {
    ensureRunHistory(runId);
  }, [runId]);

  const runs = useSyncExternalStore(
    terminalStore.subscribe,
    () => terminalStore.getState().runs
  );
  const liveView = terminalViewOf(runs, runId);

  const entries = useMemo(() => entriesOfRun(windows, runId), [windows, runId]);
  const status = useMemo(
    () => deriveRunStatus(entries, runId),
    [entries, runId]
  );
  const buffer = useMemo(() => {
    const state = createTerminalLineBuffer();
    for (const chunk of collectRunTerminalChunks(entries)) {
      appendTerminalChunk(state, chunk);
    }
    return state;
  }, [entries]);
  const { lines: fallbackLines, startIndex: fallbackStartIndex } =
    terminalLinesOf(buffer);
  const lines = liveView ? liveView.lines : fallbackLines;
  const startIndex = liveView ? liveView.startIndex : fallbackStartIndex;
  const truncatedCount = liveView
    ? liveView.truncatedCount
    : buffer.truncatedCount;

  const color =
    status.state === 'failed'
      ? theme.colors.danger
      : status.state === 'running' || status.state === 'completed'
        ? theme.colors.success
        : theme.colors.textTertiary;

  return (
    <Screen>
      <AppHeader
        title="终端"
        onBack={onBack}
        status={
          status.state === 'unknown' ? undefined : (
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.dot,
                  { borderRadius: theme.radius.pill, backgroundColor: color },
                ]}
              />
              <AppText variant="caption" color="textTertiary">
                {runStatusLabel(status)}
              </AppText>
            </View>
          )
        }
      />
      <TerminalView
        lines={lines}
        startIndex={startIndex}
        truncatedCount={truncatedCount}
        follow={follow}
        onFollowChange={setFollow}
        listRef={listRef}
      />
      {!follow ? (
        <ScrollToBottomButton
          onPress={() => {
            listRef.current?.scrollToEnd({ animated: true });
            setFollow(true);
          }}
          testID="terminal-back-to-bottom"
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 7,
    height: 7,
  },
});
