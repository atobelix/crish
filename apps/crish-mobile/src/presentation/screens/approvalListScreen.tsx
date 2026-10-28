// 审批中心列表页（F2 §4 待办列表：审批 Tab 落地，R2-04 部分 3）
// - 结构（F2 §4.3 线框）：标题栏（「已处理」入口 + outbox「N 待发送」角标，R2UX §3.5）→
//   概览条（N 项待处理 · M 项等待 Agent 裁决）→ 待办卡列表（复用 ApprovalCard，点击进详情）→
//   已处理区（最近 N 条 decision 徽标，F2 §7.2）；
// - 排序：store 已按剩余时间升序 + A2 裁决次键排好（approvalReducers.sortApprovals），页面不重排；
// - 四态（M4 §5.9）：loading（首帧）/ 错误态（横幅 + 重试，通道预留）/ 空态 / 数据态；
// - 路由注入 onOpenItem / onOpenHistory（页面不依赖 expo-router，组件测试可直接挂载）。
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import {
  APPROVAL_HISTORY_RECENT_SHOWN,
  useApprovalListVm,
} from '@/adapters/viewmodels/useApprovalListVm';
import ApprovalCard from '@/presentation/components/blocks/ApprovalCard';
import { ApprovalHistoryRow } from '@/presentation/components/approval/ApprovalHistoryRow';

export interface ApprovalListScreenProps {
  /** 点击待办卡 → 审批详情（路由注入，F2 §5.1） */
  onOpenItem: (toolCallId: string) => void;
  /** 已处理入口 → 历史页（F2 §7，路由注入） */
  onOpenHistory: () => void;
}

export default function ApprovalListScreen({
  onOpenItem,
  onOpenHistory,
}: ApprovalListScreenProps) {
  const theme = useTheme();
  const {
    phase,
    error,
    rows,
    mainAgentCount,
    outboxCount,
    historyRecent,
    retry,
  } = useApprovalListVm();

  // 四态之一：加载（首帧，M4 §5.9）
  if (phase === 'loading') {
    return (
      <View style={[styles.container, styles.center]} testID="approval-loading">
        <ActivityIndicator size="large" color={theme.colorInfo} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bgPrimary }]}>
      {/* 标题栏（F2 §4.3）：审批中心 + 已处理入口 + outbox 角标 */}
      <View style={[styles.header, { borderBottomColor: theme.hairline }]}>
        <Text style={[styles.headerTitle, { color: theme.textPrimary }]}>
          审批中心
        </Text>
        <Pressable
          testID="history-entry"
          accessibilityRole="button"
          accessibilityLabel="已处理记录"
          onPress={onOpenHistory}
          style={styles.headerAction}
        >
          <Text style={[styles.headerActionText, { color: theme.colorInfo }]}>
            已处理
          </Text>
          {outboxCount > 0 ? (
            <View
              testID="outbox-badge"
              style={[
                styles.outboxBadge,
                { backgroundColor: theme.colorWarning },
              ]}
            >
              <Text style={[styles.outboxText, { color: theme.textOnAccent }]}>
                {outboxCount} 待发送
              </Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      {/* 四态之一：错误态（横幅 + 重试，通道预留，F2 §13.3 异常态文案） */}
      {error !== null ? (
        <View
          testID="approval-error"
          style={[styles.errorBanner, { backgroundColor: theme.colorErrorBg }]}
        >
          <Text style={[styles.errorText, { color: theme.colorError }]}>
            {error}
          </Text>
          <Pressable
            testID="approval-retry"
            accessibilityRole="button"
            accessibilityLabel="重试"
            onPress={retry}
            style={[styles.retryBtn, { borderColor: theme.hairlineStrong }]}
          >
            <Text style={[styles.retryText, { color: theme.textPrimary }]}>
              重试
            </Text>
          </Pressable>
        </View>
      ) : null}

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentInner}
      >
        {/* 四态之一：空态（F2 §4.3 文案） */}
        {rows.length === 0 ? (
          <View
            style={[styles.center, styles.emptyWrap]}
            testID="approval-empty"
          >
            <Text style={[styles.emptyTitle, { color: theme.textPrimary }]}>
              暂无待审批
            </Text>
            <Text style={[styles.emptySub, { color: theme.textSecondary }]}>
              当桌面端 Agent 需要确认时，会第一时间推送到这里
            </Text>
          </View>
        ) : (
          <>
            {/* 概览条（F2 §4.3：含 main-agent 只读项计数） */}
            <Text
              testID="approval-overview"
              style={[styles.overview, { color: theme.textSecondary }]}
            >
              {rows.length} 项待处理
              {mainAgentCount > 0
                ? ` · ${mainAgentCount} 项等待 Agent 裁决`
                : ''}
            </Text>

            {/* 待办卡列表：复用 ApprovalCard（F2 §4.2 字段齐全），点击进详情 */}
            {rows.map(({ item, remainingMs }) => (
              <Pressable
                key={item.request.toolCallId}
                testID={`approval-row-${item.request.toolCallId}`}
                accessibilityRole="button"
                accessibilityLabel={`查看审批：${item.request.toolName}`}
                onPress={() => onOpenItem(item.request.toolCallId)}
              >
                <ApprovalCard item={item} remainingMs={remainingMs} />
              </Pressable>
            ))}
          </>
        )}

        {/* 已处理区（F2 §7.2：最近 N 条，decision 徽标 + 时间 + 渠道；空待办时同样可见；
            行渲染复用 ApprovalHistoryRow，与审批历史全量页共用同一行组件） */}
        {historyRecent.length > 0 ? (
          <View testID="approval-history" style={styles.historySection}>
            <Text style={[styles.sectionTitle, { color: theme.textPrimary }]}>
              已处理（最近{' '}
              {Math.min(historyRecent.length, APPROVAL_HISTORY_RECENT_SHOWN)}）
            </Text>
            {historyRecent.map((r) => (
              <ApprovalHistoryRow
                key={r.toolCallId}
                record={r}
                testID={`history-row-${r.toolCallId}`}
              />
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
  },
  headerAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    minWidth: 44,
  },
  headerActionText: {
    fontSize: 14,
    fontWeight: '500',
  },
  outboxBadge: {
    borderRadius: 9999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  outboxText: {
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  retryBtn: {
    minHeight: 44,
    minWidth: 64,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  retryText: {
    fontSize: 14,
    fontWeight: '500',
  },
  content: {
    flex: 1,
  },
  contentInner: {
    padding: 16,
    gap: 12,
  },
  emptyWrap: {
    paddingVertical: 64,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  emptySub: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  overview: {
    fontSize: 13,
    lineHeight: 18,
  },
  historySection: {
    marginTop: 8,
    gap: 4,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
});
