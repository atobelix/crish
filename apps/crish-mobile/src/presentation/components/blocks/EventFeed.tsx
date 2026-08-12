// 事件流 feed（R2UX-05-01/05-06：虚拟化 + 过滤条）：
// - 虚拟化：FlashList 未引入（D4 依赖清单无），用 RN 内置 FlatList 现有基建——
//   固定行高（EVENT_ROW_HEIGHT）getItemLayout + initialNumToRender/maxToRenderPerBatch/
//   windowSize 窗口参数；feed 环形 500 条上限由 eventStore（FEED_RING_MAX）保证
//   （R2UX-05-09），本组件只负责窗口化渲染；
// - 过滤条（F3 §5.1 / R2UX-05-06）：只看错误（含错误计数徽标「错误 (N)」，
//   F3 §3.3.3）/ 只看当前 run（runId 归属，F3 分组规则 4）/ 只看工具（TOOL_KIND_WHITELIST
//   kind 白名单）——三维度可组合，本地筛选不重拉数据（F3 §5.1 切换不丢已缓冲条目）；
// - 只看当前 run 但无 run（currentRunId = null）→ 空态「当前无 run」；
// - 空态（M4 §5.9 / F1 §4.7）：无事件条目 → 主文案 + 副文案（禁「0 误导」）。
// - 自动滚底（R2UX-05-03 会话详情复用参数）：follow=true 时新条目到达滚到底；
//   上翻超吸底阈值（40dp）暂停跟随（onFollowChange(false)），页面显示「回到底部」；
//   listRef 转发给页面触发 scrollToEnd（缺省组件内部 ref，行为不变）。
import { memo, useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { FeedEntry } from '@/domain/store/eventReducers';
import { deriveErrorLevel, filterFeed } from '@/domain/store/eventReducers';
import { useTheme } from '@/adapters/platform/theme';
import { EventRow, EVENT_ROW_HEIGHT, TOOL_KIND_WHITELIST } from './EventRow';

/** 吸底跟随阈值（R2UX-05-03 / M4 §5.5：40dp，上翻超阈值暂停跟随） */
export const AUTO_FOLLOW_THRESHOLD_DP = 40;

export interface EventFeedProps {
  /** feed 条目（环形窗口原序；过滤在渲染层执行，数据不重拉） */
  entries: readonly FeedEntry[];
  /** 只看错误（R2UX-05-06-2） */
  errorsOnly: boolean;
  /** 只看当前 run（runId 归属过滤） */
  runOnly: boolean;
  /** 只看工具（kind 白名单过滤，F3 §5.1） */
  toolOnly: boolean;
  /** 当前 run id（null = 无 run；此时「只看当前 run」显示空态） */
  currentRunId: string | null;
  onToggleErrors: () => void;
  onToggleRun: () => void;
  onToggleTool: () => void;
  /** 空态文案（缺省 F1 §4.7 口径） */
  emptyTitle?: string;
  emptyHint?: string;
  /** 自动滚底跟随（R2UX-05-03；缺省 false 保持原行为） */
  follow?: boolean;
  /** 跟随状态变化回调（页面据此显示「回到底部」悬浮条） */
  onFollowChange?: (following: boolean) => void;
  /** FlatList 转发 ref（页面「回到底部」点击 scrollToEnd 用） */
  listRef?: RefObject<FlatList<FeedEntry> | null>;
}

/** 过滤后条目 + 错误计数（纯派生，渲染层 memo；错误徽标数据面 F3 §3.3.3） */
export function deriveFilteredFeed(
  entries: readonly FeedEntry[],
  filters: {
    errorsOnly: boolean;
    runOnly: boolean;
    toolOnly: boolean;
    currentRunId: string | null;
  }
): { filtered: FeedEntry[]; errorCount: number } {
  const errorCount = entries.filter((e) => deriveErrorLevel(e)).length;
  // 只看当前 run 但无 run 对象 → 空结果（F3 §5.1：无 runId 归属可筛）
  if (filters.runOnly && filters.currentRunId === null) {
    return { filtered: [], errorCount };
  }
  const filtered = filterFeed(entries, {
    errorsOnly: filters.errorsOnly || undefined,
    ...(filters.runOnly && filters.currentRunId !== null
      ? { runId: filters.currentRunId }
      : {}),
    ...(filters.toolOnly ? { typeWhitelist: TOOL_KIND_WHITELIST } : {}),
  });
  return { filtered, errorCount };
}

export function EventFeed({
  entries,
  errorsOnly,
  runOnly,
  toolOnly,
  currentRunId,
  onToggleErrors,
  onToggleRun,
  onToggleTool,
  emptyTitle = '暂无事件',
  emptyHint = '桌面端 run 执行时，这里会实时更新事件流（F1 §4.7）',
  follow = false,
  onFollowChange,
  listRef,
}: EventFeedProps) {
  const theme = useTheme();
  const internalRef = useRef<FlatList<FeedEntry> | null>(null);
  const targetRef = listRef ?? internalRef;
  const { filtered, errorCount } = useMemo(
    () =>
      deriveFilteredFeed(entries, {
        errorsOnly,
        runOnly,
        toolOnly,
        currentRunId,
      }),
    [entries, errorsOnly, runOnly, toolOnly, currentRunId]
  );

  // 自动滚底（R2UX-05-03）：跟随态下新条目到达滚到底（getItemLayout 定位不抖动）
  useEffect(() => {
    if (follow && filtered.length > 0) {
      targetRef.current?.scrollToEnd({ animated: false });
    }
  }, [follow, filtered.length, targetRef]);

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromEnd =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const following = distanceFromEnd <= AUTO_FOLLOW_THRESHOLD_DP;
    // 仅在状态翻转时通知（避免滚动事件风暴触发父级重渲染）
    if (following !== follow) onFollowChange?.(following);
  };

  return (
    <View style={styles.container}>
      <View style={[styles.filterBar, { borderBottomColor: theme.hairline }]}>
        <FilterChip
          testID="feed-filter-errors"
          active={errorsOnly}
          label={`只看错误${errorCount > 0 ? ` (${errorCount})` : ''}`}
          onPress={onToggleErrors}
        />
        <FilterChip
          testID="feed-filter-run"
          active={runOnly}
          label="只看当前 run"
          onPress={onToggleRun}
        />
        <FilterChip
          testID="feed-filter-tools"
          active={toolOnly}
          label="只看工具"
          onPress={onToggleTool}
        />
      </View>
      <FlatList
        testID="event-feed-list"
        ref={targetRef}
        data={filtered}
        keyExtractor={feedEntryKey}
        renderItem={({ item }) => <EventRow entry={item} />}
        getItemLayout={(_data, index) => ({
          length: EVENT_ROW_HEIGHT,
          offset: EVENT_ROW_HEIGHT * index,
          index,
        })}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        ListEmptyComponent={
          <View testID="feed-empty" style={styles.emptyWrap}>
            <Text style={[styles.emptyTitle, { color: theme.textPrimary }]}>
              {runOnly && currentRunId === null ? '当前无 run' : emptyTitle}
            </Text>
            <Text style={[styles.emptyHint, { color: theme.textSecondary }]}>
              {runOnly && currentRunId === null
                ? '该会话还没有 run 事件可筛选（F3 §5.1）'
                : emptyHint}
            </Text>
          </View>
        }
      />
    </View>
  );
}

/** 条目稳定键（type + sequence 幂等键 + receivedAtMs 兜底，F3 §3.1.1 防重放语义） */
function feedEntryKey(entry: FeedEntry): string {
  return `${entry.sessionId}:${entry.type}:${entry.sequence ?? 'seq-null'}:${entry.receivedAtMs}`;
}

/** 过滤 chip（R2UX-05-06 过滤条；44pt 触控热区，M4 §3.4） */
const FilterChip = memo(function FilterChip({
  testID,
  active,
  label,
  onPress,
}: {
  testID: string;
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        styles.chip,
        { borderColor: active ? theme.colorSuccess : theme.hairlineStrong },
        active && { backgroundColor: theme.colorSuccessBg },
      ]}
    >
      <Text
        style={[
          styles.chipText,
          { color: active ? theme.colorSuccess : theme.textSecondary },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chip: {
    minHeight: 32,
    borderRadius: 9999,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: {
    fontSize: 12,
    fontWeight: '500',
  },
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: 48,
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
});
