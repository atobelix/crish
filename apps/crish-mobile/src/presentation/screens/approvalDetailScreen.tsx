// 审批详情页（L2 页面组件，M4 §2.2.1：只组合 view-model 与区块组件，不触碰领域层）
// - 深链目标页（F2 §5.1 / M4 §4.2）：首屏即见决策区（固定底部不滚动，R2UX-04-01 3 秒决策路径）；
// - 三态：待办数据态（卡 + 决策区）/ 结果态（决策后审计回执）/ 空态（不存在或已过期，M4 §5.9）；
// - main-agent 裁决请求只读展示（F2 §4.4：无决策按钮）；
// - onBack 由路由注入（页面不依赖 expo-router，组件测试可直接挂载）。
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useApprovalDetailVm } from '@/adapters/viewmodels/useApprovalDetailVm';
import ApprovalCard from '@/presentation/components/blocks/ApprovalCard';
import ApprovalActionBar from '@/presentation/components/blocks/ApprovalActionBar';

export interface ApprovalDetailScreenProps {
  toolCallId: string;
  /** 返回动作（路由注入 router.back；测试可注入 spy） */
  onBack?: () => void;
}

const RESULT_TEXT: Record<string, string> = {
  approved: '已允许',
  denied: '已拒绝',
  expired: '已过期',
};

const RESULT_CHANNEL: Record<string, string> = {
  mobile: '本机处理',
  desktop: '其他设备处理',
  auto: '自动过期',
};

export default function ApprovalDetailScreen({
  toolCallId,
  onBack,
}: ApprovalDetailScreenProps) {
  const theme = useTheme();
  const { item, historyResult, remainingMs, busy, onAllow, onDeny } =
    useApprovalDetailVm(toolCallId);

  const isMainAgent = item?.arbiter === 'main-agent';
  // 决策入口仅对可决策条目开放（F2 §6.2：过期/冲突展示状态页，不产生决策入口；§4.4 只读）
  const showActionBar =
    !isMainAgent &&
    item !== null &&
    (item.status === 'pending' ||
      item.status === 'deciding' ||
      item.status === 'queued');

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
        <Text style={[styles.headerTitle, { color: theme.textPrimary }]}>
          审批详情
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      {item ? (
        <>
          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.contentInner}
          >
            <ApprovalCard item={item} remainingMs={remainingMs} />
            {isMainAgent ? (
              <Text
                testID="main-agent-note"
                style={[styles.readonlyNote, { color: theme.textSecondary }]}
              >
                该请求由桌面端主 Agent 自动裁决，无需你操作（F2 §4.4 只读卡片）
              </Text>
            ) : null}
          </ScrollView>
          {showActionBar ? (
            <ApprovalActionBar
              busy={busy}
              onAllow={onAllow}
              onDeny={onDeny}
              toolName={item.request.toolName}
            />
          ) : null}
        </>
      ) : historyResult ? (
        <View testID="approval-result" style={styles.stateWrap}>
          <View
            style={[
              styles.stateCard,
              { backgroundColor: theme.bgCard, borderColor: theme.hairline },
            ]}
          >
            <Text
              style={[
                styles.stateTitle,
                {
                  color:
                    historyResult.decision === 'approved'
                      ? theme.colorSuccess
                      : historyResult.decision === 'denied'
                        ? theme.colorError
                        : theme.textSecondary,
                },
              ]}
            >
              {RESULT_TEXT[historyResult.decision] ?? historyResult.decision}
            </Text>
            <Text style={[styles.stateSub, { color: theme.textSecondary }]}>
              该请求已由
              {RESULT_CHANNEL[historyResult.channel] ?? '其他设备处理'}
              ，无需再操作
            </Text>
            <Pressable
              testID="result-back"
              accessibilityRole="button"
              accessibilityLabel="返回"
              onPress={onBack}
              style={[styles.stateBack, { borderColor: theme.hairlineStrong }]}
            >
              <Text
                style={[styles.stateBackText, { color: theme.textPrimary }]}
              >
                返回
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View testID="approval-empty" style={styles.stateWrap}>
          <View
            style={[
              styles.stateCard,
              { backgroundColor: theme.bgCard, borderColor: theme.hairline },
            ]}
          >
            <Text style={[styles.stateTitle, { color: theme.textPrimary }]}>
              该请求不存在或已过期
            </Text>
            <Text style={[styles.stateSub, { color: theme.textSecondary }]}>
              返回审批中心可查看最新状态（M4 §5.9 深链目标不存在空态）
            </Text>
            <Pressable
              testID="empty-back"
              accessibilityRole="button"
              accessibilityLabel="返回"
              onPress={onBack}
              style={[styles.stateBack, { borderColor: theme.hairlineStrong }]}
            >
              <Text
                style={[styles.stateBackText, { color: theme.textPrimary }]}
              >
                返回
              </Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
  },
  backButton: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  backText: {
    fontSize: 14,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
  },
  headerSpacer: {
    width: 60,
  },
  content: {
    flex: 1,
  },
  contentInner: {
    padding: 16,
    gap: 12,
  },
  readonlyNote: {
    fontSize: 13,
    lineHeight: 20,
  },
  stateWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  stateCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 24,
    alignItems: 'center',
    gap: 8,
    maxWidth: 320,
  },
  stateTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  stateSub: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  stateBack: {
    marginTop: 8,
    minHeight: 44,
    minWidth: 120,
    borderRadius: 9999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  stateBackText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
