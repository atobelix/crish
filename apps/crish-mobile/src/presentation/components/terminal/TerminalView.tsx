// 终端只读视图（R2UX-05-07：5000 行环形 + ANSI 白名单 + 固定行高；F3 §4.3 自动滚动/回到底部）
// - 输入为纯文本行（ANSI 已在缓冲层按白名单剥离，本组件只渲染）；渲染面统一脱敏
//   （R4 批次5：sk-/Bearer/凭据键值打码，与桌面 redact 同规范，T-09 移动端侧）；
// - 固定行高（TERMINAL_LINE_HEIGHT）getItemLayout 虚拟化（R2UX-05-07 滚动帧率预算数据面）；
// - 自动滚底跟随（R2UX-05-03：吸底跟随阈值 40dp，上翻暂停，跟随恢复由「回到底部」触发）；
// - 「已截断 N 行」顶部标记（F3 §4.3，ListHeader 不参与行键）；
// - 空态（M4 §5.9：主文案 + 副文案，禁「0 误导」）。
import { memo, useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { redactSecrets } from '@crish/shared-utils';
import {
  FlatList,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText } from '@/presentation/ui';

/** 固定行高（R2UX-05-07 固定行高数据面；getItemLayout 虚拟化依赖） */
export const TERMINAL_LINE_HEIGHT = 24;
/** 吸底跟随阈值（R2UX-05-03 / M4 §5.5：40dp） */
export const AUTO_FOLLOW_THRESHOLD_DP = 40;

export interface TerminalViewProps {
  /** 纯文本行（ANSI 已剥离，环形窗口原序） */
  lines: readonly string[];
  /** 首行绝对下标（环形淘汰后行键稳定：key = startIndex + idx） */
  startIndex: number;
  /** 被环形淘汰行数（顶部「已截断 N 行」标记，F3 §4.3） */
  truncatedCount: number;
  /** 自动滚底跟随（缺省 false：历史浏览态不抢滚；页面与「回到底部」联动） */
  follow?: boolean;
  /** 跟随状态变化回调（页面据此显示/隐藏「回到底部」悬浮条） */
  onFollowChange?: (following: boolean) => void;
  /** FlatList 转发 ref（页面「回到底部」点击触发 scrollToEnd） */
  listRef?: RefObject<FlatList<string> | null>;
  /** 空态文案（缺省 F1 §4.7 口径） */
  emptyTitle?: string;
  emptyHint?: string;
}

export function TerminalView({
  lines,
  startIndex,
  truncatedCount,
  follow = false,
  onFollowChange,
  listRef,
  emptyTitle = '暂无终端输出',
  emptyHint = '任务运行时的工具输出会显示在这里',
}: TerminalViewProps) {
  const theme = useTheme();
  const internalRef = useRef<FlatList<string> | null>(null);
  const targetRef = listRef ?? internalRef;

  // 计算全局绝对行号（单调递增游标：淘汰行数 + 当前视口行数，彻底攻克 5000 行吸底死锁）
  const totalLineCursor = startIndex + lines.length;

  // 自动滚底（R2UX-05-03）：跟随态下新行到达滚到底；通过 totalLineCursor 保证淘汰旧行时持续触发
  useEffect(() => {
    if (follow && totalLineCursor > 0) {
      targetRef.current?.scrollToEnd({ animated: false });
    }
  }, [follow, totalLineCursor, targetRef]);

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromEnd =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const following = distanceFromEnd <= AUTO_FOLLOW_THRESHOLD_DP;
    // 仅在状态翻转时通知（避免滚动事件风暴触发父级重渲染）
    if (following !== follow) onFollowChange?.(following);
  };

  const getItemLayout = useCallback(
    (_data: unknown, index: number) => {
      const headerOffset = truncatedCount > 0 ? TERMINAL_LINE_HEIGHT : 0;
      return {
        length: TERMINAL_LINE_HEIGHT,
        offset: headerOffset + TERMINAL_LINE_HEIGHT * index,
        index,
      };
    },
    [truncatedCount]
  );

  return (
    <FlatList
      testID="terminal-list"
      style={[styles.list, { backgroundColor: theme.colors.fillSubtle }]}
      data={lines as string[]}
      keyExtractor={(_line, index) => String(startIndex + index)}
      renderItem={({ item, index }) => (
        <TerminalRow
          text={item}
          testID={`terminal-row-${startIndex + index}`}
        />
      )}
      getItemLayout={getItemLayout}
      initialNumToRender={40}
      maxToRenderPerBatch={40}
      windowSize={11}
      onScroll={handleScroll}
      scrollEventThrottle={16}
      ListHeaderComponent={
        truncatedCount > 0 ? (
          <View
            testID="terminal-truncated"
            style={{
              paddingHorizontal: theme.space.md,
              paddingVertical: theme.space.xs,
            }}
          >
            <AppText variant="caption" color="textSecondary">
              已省略 {truncatedCount} 行较早输出
            </AppText>
          </View>
        ) : null
      }
      ListEmptyComponent={
        <View
          testID="terminal-empty"
          style={[
            styles.emptyWrap,
            {
              paddingVertical: theme.space.xxxl,
              paddingHorizontal: theme.space.xxl,
              gap: theme.space.sm,
            },
          ]}
        >
          <AppText variant="headline">{emptyTitle}</AppText>
          <AppText
            variant="footnote"
            color="textSecondary"
            style={styles.center}
          >
            {emptyHint}
          </AppText>
        </View>
      }
      ref={targetRef}
    />
  );
}

/** 终端行（memo：流式追加时历史行零重渲染，R2UX-05-01 行 memo 纪律） */
const TerminalRow = memo(function TerminalRow({
  text,
  testID,
}: {
  text: string;
  testID: string;
}) {
  const theme = useTheme();
  // 脱敏渲染（R4 批次5，T-09 移动端侧）：sk-/Bearer/凭据键值在渲染面统一打码，
  // 与桌面 redact 同规范（shared-utils 单实现）；按行打码避免跨 chunk 拆分漏匹配
  const safeText = redactSecrets(text);
  return (
    <View
      style={[styles.row, { paddingHorizontal: theme.space.md }]}
      testID={testID}
    >
      <AppText variant="mono" numberOfLines={1} selectable>
        {safeText}
      </AppText>
    </View>
  );
});

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  row: {
    height: TERMINAL_LINE_HEIGHT,
    justifyContent: 'center',
  },
  emptyWrap: {
    alignItems: 'center',
  },
  center: {
    textAlign: 'center',
  },
});
