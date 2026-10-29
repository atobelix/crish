// 审批悬浮卡的收起态：「● N 个待审批 · m:ss」，点按展开。
import { Pressable, StyleSheet } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Badge } from '@/presentation/ui';
import { formatRemainingMs } from '@/presentation/components/blocks/ApprovalCard';

export interface ApprovalFloatPillProps {
  count: number;
  remainingMs: number;
  onExpand: () => void;
}

export function ApprovalFloatPill({
  count,
  remainingMs,
  onExpand,
}: ApprovalFloatPillProps) {
  const theme = useTheme();
  const label = `${count} 个待审批 · ${formatRemainingMs(remainingMs)}`;
  return (
    <Pressable
      testID="approval-float-pill"
      accessibilityRole="button"
      accessibilityLabel={`${label}，展开审批`}
      onPress={onExpand}
      style={({ pressed }) => [
        styles.pill,
        {
          minHeight: theme.size.touch,
          paddingHorizontal: theme.space.lg,
          gap: theme.space.sm,
          borderRadius: theme.radius.pill,
          backgroundColor: pressed
            ? theme.colors.fillPressed
            : theme.colors.surfaceRaised,
          borderColor: theme.colors.hairline,
        },
        theme.shadow.md,
      ]}
    >
      <Badge dot tone="warning" />
      <AppText variant="footnote" style={styles.tabular}>
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  tabular: { fontVariant: ['tabular-nums'] },
});

export default ApprovalFloatPill;
