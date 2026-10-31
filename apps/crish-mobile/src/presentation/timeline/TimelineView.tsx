// 会话时间线渲染：用户气泡 / 助手无框正文 / 工具摘要行 / 审批一行状态 / 系统提示。
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
  ApprovalBlock,
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
}

export function TimelineView({
  blocks,
  follow,
  onFollowChange,
  listRef,
  onOpenTools,
  emptyTitle = '暂无消息',
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
          paddingHorizontal: theme.space.screenX,
          paddingTop: theme.space.lg,
          paddingBottom: theme.space.xxl,
          gap: theme.space.messageGap,
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
      return <ApprovalView block={block} />;
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
              backgroundColor: theme.colors.bubbleUser,
              borderRadius: theme.radius.bubble,
              paddingHorizontal: theme.space.lg,
              paddingVertical: theme.space.md,
            },
          ]}
        >
          <AppText variant="chat">{block.text}</AppText>
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

/** 审批在对话里只留一行状态；决策统一交给全局 ApprovalFloat */
function ApprovalView({ block }: { block: ApprovalBlock }) {
  const theme = useTheme();
  const { label, color } = approvalLine(block.status);
  return (
    <View
      testID={`timeline-approval-${block.id}`}
      accessibilityLabel={`审批：${block.toolName}，${label}`}
      style={[styles.inlineRow, { gap: theme.space.xs }]}
    >
      {/* N05 裁定：文字已含语义与色彩层级，前置盾牌属装饰，不显示 */}
      <AppText variant="footnote" color={color} numberOfLines={1}>
        {label} · {block.toolName}
      </AppText>
    </View>
  );
}

function approvalLine(status: ApprovalBlock['status']): {
  label: string;
  color: TextColor;
} {
  switch (status) {
    case 'pending':
      return { label: '等待你审批', color: 'warning' };
    case 'approved':
      return { label: '已允许', color: 'success' };
    case 'denied':
      return { label: '已拒绝', color: 'danger' };
    case 'expired':
      return { label: '已过期', color: 'textTertiary' };
  }
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
