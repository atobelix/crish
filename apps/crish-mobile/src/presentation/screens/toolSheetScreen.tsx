// 工具抽屉（/tools/[sessionId] formSheet 内容）：与对话共用 buildSessionTimeline 投影，只取工具块。
// ?focus= 定位到对应组；有工具在运行时自动跟随最新，用户上滑后停止跟随并显示「回到最新」。
import { useMemo, useRef, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useSessionStore } from '@/adapters/hooks/useAppStore';
import {
  buildSessionTimeline,
  type ToolBlock,
} from '@/presentation/timeline/buildTimeline';
import {
  latestRunIdOf,
  useSessionWindow,
} from '@/presentation/timeline/useSessionWindow';
import { ToolRow } from '@/presentation/components/tools/ToolRow';
import {
  AppText,
  EmptyState,
  IconButton,
  ScrollToBottomButton,
} from '@/presentation/ui';

const FOLLOW_THRESHOLD = 40;

export interface ToolSheetScreenProps {
  sessionId: string;
  /** 定位锚点：某组首个工具 id */
  focusId?: string;
  onOpenTerminal?: (runId: string) => void;
}

export default function ToolSheetScreen({
  sessionId,
  focusId,
  onOpenTerminal,
}: ToolSheetScreenProps) {
  const theme = useTheme();
  const window = useSessionWindow(sessionId);
  const fallbackRunId = useSessionStore(
    (s) => s.sessions.find((item) => item.id === sessionId)?.engineLastRunId
  );
  const tools = useMemo(
    () =>
      buildSessionTimeline(window.entries).filter(
        (block): block is ToolBlock => block.kind === 'tool'
      ),
    [window.entries]
  );
  const runId = latestRunIdOf(window.entries, fallbackRunId ?? null);
  const running = tools.some((tool) => tool.status === 'running');
  const focusIndex = focusId
    ? tools.findIndex((tool) => tool.id === focusId)
    : -1;

  const listRef = useRef<FlatList<ToolBlock> | null>(null);
  const focusedRef = useRef(false);
  const [following, setFollowing] = useState(focusIndex < 0);

  const handleContentSize = () => {
    if (!focusedRef.current && focusIndex >= 0) {
      focusedRef.current = true;
      listRef.current?.scrollToIndex({ index: focusIndex, animated: false });
      return;
    }
    if (following && running) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distance =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const atEnd = distance <= FOLLOW_THRESHOLD;
    if (atEnd !== following) setFollowing(atEnd);
  };

  return (
    <View style={styles.flex}>
      <View
        style={[
          styles.header,
          {
            minHeight: theme.size.header,
            paddingHorizontal: theme.space.screenX,
            gap: theme.space.sm,
          },
        ]}
      >
        <AppText variant="headline" accessibilityRole="header">
          工具调用
        </AppText>
        <AppText
          variant="footnote"
          color="textTertiary"
          style={styles.flex}
          testID="tool-sheet-count"
        >
          {tools.length}
        </AppText>
        {runId && onOpenTerminal ? (
          <IconButton
            name="terminal"
            variant="floating"
            accessibilityLabel="终端输出"
            onPress={() => onOpenTerminal(runId)}
            testID="tool-sheet-terminal"
          />
        ) : null}
      </View>
      <FlatList
        ref={listRef}
        testID="tool-sheet-list"
        data={tools}
        keyExtractor={(tool) => tool.id}
        renderItem={({ item }) => <ToolRow tool={item} />}
        onContentSizeChange={handleContentSize}
        onScrollToIndexFailed={({ index, averageItemLength }) =>
          listRef.current?.scrollToOffset({
            offset: index * averageItemLength,
            animated: false,
          })
        }
        onScroll={handleScroll}
        scrollEventThrottle={16}
        contentContainerStyle={[
          { paddingBottom: theme.space.section },
          tools.length === 0 && styles.emptyContent,
        ]}
        ListEmptyComponent={
          <EmptyState icon="wrench" title="这个会话还没有工具调用" />
        }
      />
      {!following && running ? (
        <ScrollToBottomButton
          onPress={() => {
            listRef.current?.scrollToEnd({ animated: true });
            setFollowing(true);
          }}
          testID="tool-sheet-latest"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center' },
  emptyContent: { flexGrow: 1, justifyContent: 'center' },
});
