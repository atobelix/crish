// run 详情时间线（R2-05 部分 6 / R2UX-05-08：游标分页 200/页 + 状态条隔离）
// - 数据面：页面注入该 run 的窗口条目（seq 升序）+ 窗口环形淘汰计数；
// - 分页（R2UX-05-08 游标分页 200/页）：paginateRunEntries 展示「最新
//   pageSize×pages 条」窗口尾部（新事件到达窗口滑动、最新事件恒在底部，
//   配合 EventFeed 自动滚底）；「加载更早」按钮置于顶部（F3 §3.4.2 顶部
//   「已收起 N 条早期事件 / 点击展开历史」语义），同步无网络往返；
// - 渲染：复用 EventFeed（过滤条 + EventRow + FlatList 虚拟化）；
//   runOnly 恒开（页面即 run 域，chip 为指示器）；errorsOnly/toolOnly 本地
//   过滤不重拉数据（F3 §5.1）；
// - 滚动帧率预算（R2UX-05-08 60fps）：固定行高 getItemLayout + 行 memo
//   （EventFeed/EventRow 既有实现），本组件不持有滚动状态（滚动不触发页面级
//   状态变更 → 状态条 memo 隔离生效）；
// - 环形淘汰提示（F3 §3.4.2 / R2UX-05-09）：truncatedCount > 0 时顶部提示
//   「已收起 N 条早期事件」（内存有界，最旧历史不可恢复属设计内）。
import { memo, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { FeedEntry } from '@/domain/store/eventReducers';
import { EventFeed } from '@/presentation/components/blocks/EventFeed';
import { paginateRunEntries } from './runDetailMeta';

/** 游标分页页大小（R2UX-05-08：200/页；对齐 F1 §3.1 Q4 游标分页 200/页） */
export const RUN_EVENTS_PAGE_SIZE = 200;

export interface RunDetailTimelineProps {
  runId: string;
  /** 该 run 条目（seq 升序；entriesOfRun 语义由页面保证） */
  entriesAsc: readonly FeedEntry[];
  /** 窗口环形淘汰计数（F3 §3.4.2 顶部提示数据面） */
  truncatedCount: number;
  /** 自动滚底跟随（R2UX-05-03；缺省 false） */
  follow?: boolean;
  /** 跟随状态变化回调（页面「回到底部」悬浮条用） */
  onFollowChange?: (following: boolean) => void;
  /** FlatList 转发 ref（页面「回到底部」点击 scrollToEnd 用） */
  listRef?: RefObject<FlatList<FeedEntry> | null>;
}

export const RunDetailTimeline = memo(function RunDetailTimeline({
  runId,
  entriesAsc,
  truncatedCount,
  follow = false,
  onFollowChange,
  listRef,
}: RunDetailTimelineProps) {
  const theme = useTheme();
  const [pagesLoaded, setPagesLoaded] = useState(1);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [toolOnly, setToolOnly] = useState(false);

  const page = useMemo(
    () => paginateRunEntries(entriesAsc, RUN_EVENTS_PAGE_SIZE, pagesLoaded),
    [entriesAsc, pagesLoaded]
  );

  return (
    <View style={styles.container}>
      {truncatedCount > 0 ? (
        <View
          style={[
            styles.truncatedBar,
            { backgroundColor: theme.colorWarningBg },
          ]}
        >
          <Text
            testID="run-timeline-truncated"
            style={[styles.truncatedText, { color: theme.colorWarning }]}
          >
            已收起 {truncatedCount} 条早期事件（内存环形上限，R2UX-05-09）
          </Text>
        </View>
      ) : null}
      {page.hasMore ? (
        <Pressable
          testID="run-timeline-load-more"
          accessibilityRole="button"
          accessibilityLabel="加载更早事件"
          onPress={() => setPagesLoaded((p) => p + 1)}
          style={({ pressed }) => [
            styles.loadMoreBar,
            { borderColor: theme.hairline },
            pressed && styles.loadMorePressed,
          ]}
        >
          <ActivityIndicator size="small" color={theme.textTertiary} />
          <Text style={[styles.loadMoreText, { color: theme.textSecondary }]}>
            加载更早（已显示 {page.loadedCount}/{page.totalCount}）
          </Text>
        </Pressable>
      ) : null}
      <EventFeed
        entries={page.visible}
        errorsOnly={errorsOnly}
        runOnly={true}
        toolOnly={toolOnly}
        currentRunId={runId}
        onToggleErrors={() => setErrorsOnly((v) => !v)}
        onToggleRun={() => {
          // 页面即 run 域：只看当前 run 恒开（chip 为指示器，F3 §5.1 无操作）
        }}
        onToggleTool={() => setToolOnly((v) => !v)}
        follow={follow}
        onFollowChange={onFollowChange}
        listRef={listRef}
        emptyTitle="该 run 暂无事件"
        emptyHint="run 可能不存在或事件尚未同步（F1 §4.7）"
      />
      {!page.hasMore && page.totalCount > 0 ? (
        <Text
          testID="run-timeline-all-loaded"
          style={[styles.allLoadedText, { color: theme.textTertiary }]}
        >
          已全部加载（共 {page.totalCount} 条）
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  truncatedBar: {
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  truncatedText: {
    fontSize: 12,
  },
  loadMoreBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 40,
    marginHorizontal: 16,
    marginVertical: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  loadMorePressed: {
    opacity: 0.7,
  },
  loadMoreText: {
    fontSize: 13,
  },
  allLoadedText: {
    textAlign: 'center',
    fontSize: 12,
    paddingVertical: 8,
  },
});
