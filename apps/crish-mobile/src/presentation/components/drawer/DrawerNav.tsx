// 抽屉导航：只有「待审批」（有数量才显示计数）和「审批记录」两项。
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useApprovalStore } from '@/adapters/hooks/useAppStore';
import { useTheme } from '@/adapters/platform/theme';
import { countUserDecisions } from '@/domain/pure/approvalAttention';
import { AppText, Icon, type IconName } from '@/presentation/ui';

export interface DrawerNavProps {
  onOpenApprovals: () => void;
  onOpenHistory: () => void;
}

interface NavRowProps {
  icon: IconName;
  label: string;
  onPress: () => void;
  testID: string;
  count?: number;
}

function CountPill({ count }: { count: number }) {
  const theme = useTheme();
  return (
    <View
      testID="drawer-approvals-count"
      style={{
        minWidth: theme.size.badge,
        paddingHorizontal: theme.space.sm,
        paddingVertical: theme.space.xxs,
        borderRadius: theme.radius.pill,
        backgroundColor: theme.colors.warningSoft,
        alignItems: 'center',
      }}
    >
      <AppText variant="caption" color="warning">
        {count > 99 ? '99+' : String(count)}
      </AppText>
    </View>
  );
}

function NavRow({ icon, label, onPress, testID, count = 0 }: NavRowProps) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `${label}，${count} 项` : label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: theme.size.touch,
          paddingHorizontal: theme.space.md,
          gap: theme.space.md,
          borderRadius: theme.radius.control,
        },
        pressed && { backgroundColor: theme.colors.fillPressed },
      ]}
    >
      <Icon
        name={icon}
        size={theme.size.icon}
        color={theme.colors.textSecondary}
      />
      <AppText variant="body" style={styles.flex}>
        {label}
      </AppText>
      {count > 0 ? <CountPill count={count} /> : null}
    </Pressable>
  );
}

export function DrawerNav({ onOpenApprovals, onOpenHistory }: DrawerNavProps) {
  const pending = useApprovalStore((s) => s.pending);
  const count = useMemo(() => countUserDecisions(pending), [pending]);
  return (
    <View>
      <NavRow
        icon="shield"
        label="待审批"
        count={count}
        testID="drawer-approvals"
        onPress={onOpenApprovals}
      />
      <NavRow
        icon="history"
        label="审批记录"
        testID="drawer-approval-history"
        onPress={onOpenHistory}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
