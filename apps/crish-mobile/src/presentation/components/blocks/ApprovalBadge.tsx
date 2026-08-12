// 审批角标区块（会话行 / 列表行通用，R2-04 任务书第 2 点）：
// pendingApprovalCount > 0 → 「N 待审批」红色胶囊（风险色，F2 §2.2 展示层口径）
// - count ≤ 0 不渲染（诚实化：无数据不显示 0，M4 §4.1）；
// - 可交互（onPress 缺省为非交互视图）：会话行点击跳转审批列表（F2 任务书 R2-04-02）；
// - 热区 ≥44（M4 §3.4 / R2UX-01-04：视觉胶囊 + hitSlop 扩展）。
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';

export interface ApprovalBadgeProps {
  /** 待审批计数（sessionStore.pendingApprovalCount 等） */
  count: number;
  /** 点击跳转（会话行角标 → 审批列表）；缺省渲染为非交互视图 */
  onPress?: () => void;
}

export default function ApprovalBadge({ count, onPress }: ApprovalBadgeProps) {
  const theme = useTheme();
  if (count <= 0) return null;

  const label = `${count} 待审批`;
  const badgeStyle = [styles.badge, { backgroundColor: theme.colorError }];
  const badgeText = (
    <Text style={[styles.badgeText, { color: theme.textOnDanger }]}>
      {label}
    </Text>
  );

  if (onPress === undefined) {
    return (
      <View testID="approval-badge" style={badgeStyle}>
        {badgeText}
      </View>
    );
  }

  return (
    <Pressable
      testID="approval-badge"
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={badgeStyle}
    >
      {badgeText}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: 9999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
