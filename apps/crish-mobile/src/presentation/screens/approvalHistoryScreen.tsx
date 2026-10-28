// 审批历史全量页（F2 §7 · R4 批次3 新建——修复审批中心「已处理」入口路由缺失）：
// - 数据面：approvalStore.history（appendHistory 追加序，全量页倒序展示 = 最新在前；
//   保留上限 APPROVAL_HISTORY_MAX = 500 条由 store 保证）；
// - 行渲染复用 ApprovalHistoryRow（与审批中心「最近已处理」区同一组件，单一真理源）；
// - 副行：拒绝理由（deny 时有）——审计留痕的关键信息；
// - 空态（M4 §5.9：主文案 + 副文案，禁「0 误导」）；
// - onBack 由路由注入（页面不依赖 expo-router，组件测试可直接挂载）。
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useApprovalStore } from '@/adapters/hooks/useAppStore';
import { APPROVAL_HISTORY_MAX } from '@/domain/store/approvalReducers';
import type { ApprovalRecord } from '@/domain/types/domain';
import { ApprovalHistoryRow } from '@/presentation/components/approval/ApprovalHistoryRow';
import { dualHitSlop } from '@/presentation/components/ui/hitTargets';

/** 历史记录倒序投影（最新在前；纯函数供单测） */
export function historyDesc(
  history: readonly ApprovalRecord[]
): ApprovalRecord[] {
  return [...history].reverse();
}

export interface ApprovalHistoryScreenProps {
  /** 返回动作（路由注入 router.back；测试可注入 spy） */
  onBack?: () => void;
}

export default function ApprovalHistoryScreen({
  onBack,
}: ApprovalHistoryScreenProps) {
  const theme = useTheme();
  const history = useApprovalStore((s) => s.history);
  const rows = historyDesc(history);

  return (
    <View style={[styles.container, { backgroundColor: theme.bgPrimary }]}>
      <View style={[styles.header, { borderBottomColor: theme.hairline }]}>
        <Pressable
          testID="header-back"
          accessibilityRole="button"
          accessibilityLabel="返回"
          onPress={onBack}
          style={styles.backButton}
          hitSlop={dualHitSlop(36)}
        >
          <Text style={[styles.backText, { color: theme.textPrimary }]}>
            返回
          </Text>
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.textPrimary }]}>
          已处理记录
        </Text>
      </View>

      {rows.length === 0 ? (
        <View testID="approval-history-empty" style={styles.emptyWrap}>
          <Text style={[styles.emptyTitle, { color: theme.textPrimary }]}>
            暂无已处理记录
          </Text>
          <Text style={[styles.emptySub, { color: theme.textSecondary }]}>
            审批决策后在此留痕（允许 / 拒绝 / 过期，保留最近{' '}
            {APPROVAL_HISTORY_MAX} 条）
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.toolCallId}
          renderItem={({ item }) => (
            <View style={styles.rowWrap}>
              <ApprovalHistoryRow
                record={item}
                testID={`history-row-${item.toolCallId}`}
              />
              {item.reason ? (
                <Text
                  style={[styles.reasonHint, { color: theme.textTertiary }]}
                  numberOfLines={2}
                >
                  {item.reason}
                </Text>
              ) : null}
            </View>
          )}
          contentContainerStyle={styles.listContent}
        />
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
  headerTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  rowWrap: {
    gap: 2,
  },
  reasonHint: {
    fontSize: 12,
    lineHeight: 16,
    paddingBottom: 6,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 24,
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
});
