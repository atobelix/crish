// 终端只读页（R2-05 部分 3：app/terminal/[runId] 深链目标，F3 §4 / M4 §4.2 规则 3）
// - 接线：跨 eventStore 全部会话窗口按 runId 过滤（entriesOfRun），tool-update
//   tool-progress 文本 + task-output 行 → 行缓冲（5000 行环形 + ANSI 白名单，R2UX-05-07）；
// - run 状态条（F1 §4.3 状态条数据面）：agent-start → 运行中 / run-terminal → 收口
//   （已完成·已取消·失败，失败附 error 摘要，F3 §3.3.3）；无事件 → 未知态（诚实化）；
// - 自动滚底跟随（R2UX-05-03）+ 「回到底部」悬浮条（F3 §4.3）；
// - 空态（M4 §5.9）：无终端行 → 主文案 + 副文案；
// - onBack 由路由注入（页面不依赖 expo-router）。
import { useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, type ThemeTokens } from '@/adapters/platform/theme';
import { useEventStore } from '@/adapters/hooks/useAppStore';
import { TerminalView } from '@/presentation/components/terminal/TerminalView';
import {
  createTerminalLineBuffer,
  appendTerminalChunk,
  terminalLinesOf,
} from '@/presentation/components/terminal/terminalLineBuffer';
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

  // 数据面：跨窗口按 runId 过滤 → 终端文本块 → 行缓冲（环形裁剪/ANSI 白名单在缓冲层）
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
  const { lines, startIndex } = terminalLinesOf(buffer);

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
        truncatedCount={buffer.truncatedCount}
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
