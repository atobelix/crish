// 会话列表行（R2-05 部分 4：完整行形态；F5 §4.1 / F1 §4.4 / R2UX §2 密度·触达·状态行）
// - 结构：标题（1 行截断）+ 预览（最后消息 1 行灰字，纯函数派生注入）+ 元信息行
//   （相对时间 + 运行中指示）+ 右侧角标区（未读数字角标 + 审批角标复用 ApprovalBadge）；
// - 流式预览（R2UX-05-02 最小接入）：previewStreaming=true 时预览文本经 StreamingText
//   节流渐进渲染 + 行尾静态「▍」光标（尾部条目为 message-delta 等增量类型时，
//   会话列表实时反映助手正在生成的内容，光标不逐字动画——裁决 A3）；
// - 状态指示（F1 §5.2 会话状态派生）：运行中 = activeRunIds 非空（agent-start 后）；
//   待审批 = pendingApprovalCount > 0（ApprovalBadge，F2 口径）；未读 = unreadCount > 0
//   （F5 §6.3 lastReadSequence 差值派生，本地游标）；
// - 交互：行点击 → 会话详情（onOpen）；角标点击 → 审批列表（onOpenApprovals）；
// - 纯展示组件：数据经 props 注入（session/preview/nowMs），可交互区经回调注入，
//   组件测试可直接挂载（不感知路由 / store）。
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { formatRelativeTime } from '@/domain/pure/time';
import ApprovalBadge from '@/presentation/components/blocks/ApprovalBadge';
import { StreamingText } from '@/presentation/components/blocks/StreamingText';

/** 未读角标上限（F1 §5.3 角标上限 99+） */
export const UNREAD_BADGE_CAP = 99;

/** 未读角标文案（上限收敛，F1 §5.3） */
export function unreadLabel(count: number): string {
  return count > UNREAD_BADGE_CAP ? '99+' : String(count);
}

export interface SessionRowProps {
  session: SessionSummary;
  /** 最后消息预览（纯函数派生：lastPreviewOfWindow）；空串 = 不渲染预览行 */
  preview?: string;
  /** 预览是否处于流式期（尾部条目为增量类型；true = 节流渐进渲染 + 行尾 ▍ 光标，
   * R2UX-05-02 最小接入；缺省 false 保持原行为） */
  previewStreaming?: boolean;
  /** 相对时间基准（缺省 Date.now；测试注入固定值） */
  nowMs?: number;
  /** 行点击 → 会话详情（F5 §4.1 会话项点击 → 会话详情） */
  onOpen: (sessionId: string) => void;
  /** 角标点击 → 审批列表（F2 任务书 R2-04-02）；缺省为非交互角标 */
  onOpenApprovals?: () => void;
}

/** 会话列表行（memo：列表行级重渲染纪律，R2UX-05-01 行 memo 同款） */
export const SessionRow = memo(function SessionRow({
  session,
  preview = '',
  previewStreaming = false,
  nowMs = Date.now(),
  onOpen,
  onOpenApprovals,
}: SessionRowProps) {
  const theme = useTheme();
  const title = session.title ?? session.id;
  const running = session.activeRunIds.length > 0;
  const unread = session.unreadCount > 0;
  const relativeTime = formatRelativeTime(session.updatedAt ?? 0, nowMs);

  // 读屏聚合文案（R2UX §4.1-4：卡片内多信息合并为单一可读文本）
  const a11yParts = [
    `会话：${title}`,
    preview !== '' ? preview : '无消息预览',
    relativeTime,
    running ? '运行中' : null,
    session.pendingApprovalCount > 0
      ? `${session.pendingApprovalCount} 项待审批`
      : null,
    unread ? `${session.unreadCount} 条未读` : null,
  ].filter((x): x is string => x !== null && x !== undefined && x !== '');

  return (
    <Pressable
      testID={`session-row-${session.id}`}
      accessibilityRole="button"
      accessibilityLabel={a11yParts.join('，')}
      onPress={() => onOpen(session.id)}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: theme.hairline },
        pressed && { backgroundColor: theme.bgTertiary },
      ]}
    >
      <View style={styles.body}>
        <Text
          testID="session-row-title"
          style={[styles.title, { color: theme.textPrimary }]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {preview !== '' ? (
          previewStreaming ? (
            // 流式预览（R2UX-05-02）：节流渐进渲染 + 行尾静态 ▍ 光标；
            // identity 用会话级常量键（跨增量帧稳定，帧更新只合并渲染）
            <StreamingText
              testID="session-row-preview"
              identity={`session:${session.id}`}
              text={preview}
              streaming
              cursorTestID="session-row-preview-streaming"
              cursorStyle={{ color: theme.textTertiary }}
              style={[styles.preview, { color: theme.textSecondary }]}
              numberOfLines={1}
            />
          ) : (
            <Text
              testID="session-row-preview"
              style={[styles.preview, { color: theme.textSecondary }]}
              numberOfLines={1}
            >
              {preview}
            </Text>
          )
        ) : null}
        <View style={styles.metaLine}>
          <Text
            testID="session-row-time"
            style={[styles.time, { color: theme.textTertiary }]}
          >
            {relativeTime}
          </Text>
          {running ? (
            <View testID="session-row-running" style={styles.runningChip}>
              <View
                style={[
                  styles.runningDot,
                  { backgroundColor: theme.colorSuccess },
                ]}
              />
              <Text style={[styles.runningText, { color: theme.colorSuccess }]}>
                运行中
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      <View style={styles.badges}>
        {unread ? (
          <View
            testID="session-unread-badge"
            style={[styles.unreadBadge, { backgroundColor: theme.colorError }]}
            accessible
            accessibilityLabel={`${session.unreadCount} 条未读`}
          >
            <Text style={[styles.unreadText, { color: theme.textOnDanger }]}>
              {unreadLabel(session.unreadCount)}
            </Text>
          </View>
        ) : null}
        <ApprovalBadge
          count={session.pendingApprovalCount}
          onPress={onOpenApprovals}
        />
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 72,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  body: {
    flex: 1,
    gap: 3,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
  },
  preview: {
    fontSize: 13,
    lineHeight: 18,
  },
  metaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 1,
  },
  time: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  runningChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 20,
    paddingHorizontal: 6,
    borderRadius: 9999,
  },
  runningDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  runningText: {
    fontSize: 11,
    fontWeight: '500',
  },
  badges: {
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 6,
  },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadText: {
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
