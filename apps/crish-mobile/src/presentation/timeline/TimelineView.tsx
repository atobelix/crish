// 会话时间线渲染：用户气泡 / 助手无框正文 / 工具摘要行 / 系统提示。
// 审批不在流内呈现（原型对话流无审批行）：待审批统一由全局 ApprovalFloat
// 悬浮卡承载（含收起胶囊与队列），已决状态在审批记录里可查。
// 渲染前先经 groupToolRuns 把相邻工具折叠成摘要，详情交给工具抽屉。
import { memo, useEffect, useMemo, useRef } from 'react';
import {
  FlatList,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { RefObject } from 'react';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, EmptyState, type TextColor } from '@/presentation/ui';
import { StreamingText } from '@/presentation/components/blocks/StreamingText';
import type {
  AssistantMessageBlock,
  NoticeBlock,
  TimelineBlock,
} from './buildTimeline';
import { groupToolRuns, type DisplayBlock } from './groupToolRuns';
import { ToolSummaryRow } from './ToolSummaryRow';

const FOLLOW_THRESHOLD = 40;

export interface TimelineViewProps {
  blocks: readonly TimelineBlock[];
  follow: boolean;
  onFollowChange: (following: boolean) => void;
  listRef?: RefObject<FlatList<DisplayBlock> | null>;
  /** 打开工具抽屉并定位到某组（focusId = 该组首个工具 id）；不传则摘要行只读 */
  onOpenTools?: (focusId: string) => void;
  emptyTitle?: string;
  /** 顶部避让高度（悬浮头栏时 = 安全区 + 头栏高度；缺省 = 常规内衬） */
  headerClearance?: number;
}

export function TimelineView({
  blocks,
  follow,
  onFollowChange,
  listRef,
  onOpenTools,
  emptyTitle = '暂无消息',
  headerClearance,
}: TimelineViewProps) {
  const theme = useTheme();
  const internalRef = useRef<FlatList<DisplayBlock> | null>(null);
  const targetRef = listRef ?? internalRef;
  const display = useMemo(() => groupToolRuns(blocks), [blocks]);
  const tail = blocks[blocks.length - 1];
  const tailSignal =
    tail?.kind === 'message' ? tail.text.length : blocks.length;

  useEffect(() => {
    if (!follow || blocks.length === 0) return;
    targetRef.current?.scrollToEnd({ animated: false });
  }, [follow, blocks.length, tailSignal, targetRef]);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distance =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const following = distance <= FOLLOW_THRESHOLD;
    if (following !== follow) onFollowChange(following);
  };

  return (
    <FlatList
      ref={targetRef}
      testID="session-timeline"
      data={display}
      keyExtractor={(block) => `${block.kind}:${block.id}`}
      // 滚动复用免动画（实现波总方案 F5/N04：删除每项 FadeIn 包裹——
      // 回收再挂载反复淡入是高刷滚动闪烁根因）；首击不吞噬 + 滑动收键盘
      renderItem={({ item }) => (
        <TimelineBlockView block={item} onOpenTools={onOpenTools} />
      )}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={[
        {
          // 原型 conv-message-list：左右 18、消息 gap 16（token 无 18 档，定值落位）
          paddingHorizontal: 18,
          paddingTop: headerClearance ?? theme.space.lg,
          paddingBottom: theme.space.xxl,
          gap: theme.space.lg,
        },
        blocks.length === 0 && styles.emptyContent,
      ]}
      onScroll={handleScroll}
      scrollEventThrottle={16}
      initialNumToRender={16}
      maxToRenderPerBatch={16}
      windowSize={9}
      ListEmptyComponent={<EmptyState title={emptyTitle} />}
    />
  );
}

const TimelineBlockView = memo(function TimelineBlockView({
  block,
  onOpenTools,
}: {
  block: DisplayBlock;
  onOpenTools?: (focusId: string) => void;
}) {
  switch (block.kind) {
    case 'message':
      return <MessageView block={block} />;
    case 'toolRun':
      return <ToolSummaryRow run={block} onOpen={onOpenTools} />;
    case 'approval':
      // 流内不渲染审批行：待审批由全局悬浮卡承载（见文件头注）
      return null;
    case 'notice':
      return <NoticeView block={block} />;
  }
});

function MessageView({ block }: { block: AssistantMessageBlock }) {
  const theme = useTheme();
  if (block.role === 'user') {
    return (
      <View style={styles.userRow}>
        <View
          style={[
            styles.userBubble,
            {
              // 用户气泡（原型 18/18/4/18）：尾角朝发言侧收窄
              backgroundColor: theme.colors.bubbleUser,
              borderTopLeftRadius: theme.radius.bubble,
              borderTopRightRadius: theme.radius.bubble,
              borderBottomRightRadius: theme.radius.bubbleTail,
              borderBottomLeftRadius: theme.radius.bubble,
              // 原型 msg-user-bubble：padding 10/14 + 0 2px 8px rgba(0,0,0,0.06) 微阴影（shadow.md）
              paddingHorizontal: 14,
              paddingVertical: 10,
            },
            theme.shadow.md,
          ]}
        >
          <AppText variant="chat" color="bubbleUserText">
            {block.text}
          </AppText>
        </View>
      </View>
    );
  }
  return (
    <StreamingText
      identity={`message:${block.id}`}
      text={block.text}
      streaming={block.streaming}
      cursorStyle={{ color: theme.colors.textTertiary }}
      style={[theme.type.chat, { color: theme.colors.textPrimary }]}
    />
  );
}

function noticeColor(tone: NoticeBlock['tone']): TextColor {
  switch (tone) {
    case 'danger':
      return 'danger';
    case 'success':
      return 'success';
    case 'warning':
      return 'warning';
    case 'info':
    case 'muted':
      return 'textTertiary';
  }
}

function NoticeView({ block }: { block: NoticeBlock }) {
  const theme = useTheme();
  const color = noticeColor(block.tone);
  return (
    <View style={[styles.inlineRow, styles.center, { gap: theme.space.xs }]}>
      {/* N05 裁定：danger 红字已表达警示，前置叹号属装饰，不显示 */}
      <AppText variant="caption" color={color} style={styles.centerText}>
        {block.text}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  emptyContent: { flexGrow: 1, justifyContent: 'center' },
  userRow: { alignItems: 'flex-end' },
  userBubble: { maxWidth: '82%' },
  inlineRow: { flexDirection: 'row', alignItems: 'center' },
  center: { justifyContent: 'center' },
  centerText: { textAlign: 'center' },
});

export default TimelineView;
