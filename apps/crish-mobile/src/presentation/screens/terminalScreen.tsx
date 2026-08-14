// 终端只读页（R2-05 部分 3：app/terminal/[runId] 深链目标，F3 §4 / M4 §4.2 规则 3）
// - 数据源（R2-14 部分 3 接线消费）：terminalStore 有该 run 实时镜像（接线层 ingestLines
//   活动 run 流式输出）→ 优先渲染；无镜像（历史 run / run-terminal 收口释放 / 未接线的
//   重连间隙）→ 回落跨 eventStore 窗口重建（entriesOfRun 过滤 + collectRunTerminalChunks，
//   完整历史 R2-05c 现状保持）；
// - run 状态条（F1 §4.3 状态条数据面）：agent-start → 运行中 / run-terminal → 收口
//   （已完成·已取消·失败，失败附 error 摘要，F3 §3.3.3）；无事件 → 未知态（诚实化）；
// - 自动滚底跟随（R2UX-05-03）+ 「回到底部」悬浮条（F3 §4.3）；
// - 空态（M4 §5.9）：无终端行 → 主文案 + 副文案；
// - onBack 由路由注入（页面不依赖 expo-router）。
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, type ThemeTokens } from '@/adapters/platform/theme';
import { useEventStore } from '@/adapters/hooks/useAppStore';
import { TerminalView } from '@/presentation/components/terminal/TerminalView';
import {
  createTerminalLineBuffer,
  appendTerminalChunk,
  terminalLinesOf,
} from '@/presentation/components/terminal/terminalLineBuffer';
import { terminalStore } from '@/domain/store/terminalStore';
import { terminalViewOf } from '@/domain/store/terminalReducers';
import {
  collectRunTerminalChunks,
  deriveRunStatus,
  entriesOfRun,
  type RunStatusView,
} from '@/presentation/components/terminal/terminalEvents';

/** run 状态文案（状态点双通道：色点 + 文字，M4 §6.5） */
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
      return '未知';
  }
}

export interface TerminalScreenProps {
  runId: string;
  /** 返回动作（路由注入 router.back；测试可注入 spy） */
  onBack?: () => void;
}

export default function TerminalScreen({ runId, onBack }: TerminalScreenProps) {
  const theme = useTheme();
  const windows = useEventStore((s) => s.windows);
  const [follow, setFollow] = useState(true);
  const listRef = useRef<FlatList<string> | null>(null);

  // 实时镜像数据面（R2-14 部分 3）：terminalStore 订阅（zustand vanilla subscribe +
  // useSyncExternalStore 直绑，不依赖 useAppStore 扩展）；有 run 缓冲 → 优先渲染，
  // 无缓冲 → 回落事件流重建（下方 buffer/fallback 路径）。
  const runs = useSyncExternalStore(
    terminalStore.subscribe,
    () => terminalStore.getState().runs
  );
  const liveView = terminalViewOf(runs, runId);

  // 回落数据面：跨窗口按 runId 过滤 → 终端文本块 → 行缓冲（环形裁剪/ANSI 白名单在缓冲层）
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
        <View style={styles.statusBody}>
          <View style={styles.statusLine}>
            <View
              testID="terminal-status-dot"
              style={[
                styles.statusDot,
                { backgroundColor: statusDotColor(status, theme) },
              ]}
            />
            <Text
              testID="terminal-status"
              style={[styles.statusText, { color: theme.textPrimary }]}
            >
              {runStatusLabel(status)}
            </Text>
            <Text
              testID="terminal-run-id"
              numberOfLines={1}
              style={[styles.runIdText, { color: theme.textSecondary }]}
            >
              run {runId}
            </Text>
          </View>
          {status.reason ? (
            <Text
              testID="terminal-status-reason"
              numberOfLines={2}
              style={[styles.reasonText, { color: theme.colorError }]}
            >
              {status.reason}
            </Text>
          ) : null}
        </View>
      </View>

      <TerminalView
        lines={lines}
        startIndex={startIndex}
        truncatedCount={truncatedCount}
        follow={follow}
        onFollowChange={setFollow}
        listRef={listRef}
      />

      {!follow ? (
        <Pressable
          testID="terminal-back-to-bottom"
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

/** 状态点颜色（状态双通道：色点 + 文字；token 语义色，M4 §3.8 禁硬编码；未知灰） */
export function statusDotColor(
  status: RunStatusView,
  theme: Pick<
    ThemeTokens,
    'colorSuccess' | 'colorWarning' | 'colorError' | 'textTertiary'
  >
): string {
  switch (status.state) {
    case 'running':
    case 'completed':
      return theme.colorSuccess;
    case 'cancelled':
      return theme.textTertiary;
    case 'failed':
      return theme.colorError;
    default:
      return theme.textTertiary;
  }
}

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
  statusBody: {
    flex: 1,
    gap: 2,
  },
  statusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusText: {
    fontSize: 15,
    fontWeight: '600',
  },
  runIdText: {
    flex: 1,
    fontSize: 13,
  },
  reasonText: {
    fontSize: 12,
    lineHeight: 17,
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
