// 汉堡按钮：打开抽屉；有需要用户处理的审批时右上角带警示点。
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApprovalStore } from '@/adapters/hooks/useAppStore';
import { useTheme } from '@/adapters/platform/theme';
import { countUserDecisions } from '@/domain/pure/approvalAttention';
import { Badge, IconButton } from '@/presentation/ui';

export interface MenuButtonProps {
  onPress: () => void;
}

export function MenuButton({ onPress }: MenuButtonProps) {
  const theme = useTheme();
  const pending = useApprovalStore((s) => s.pending);
  const count = useMemo(() => countUserDecisions(pending), [pending]);
  return (
    <View>
      <IconButton
        name="menu"
        accessibilityLabel={
          count > 0 ? `打开菜单，${count} 项待审批` : '打开菜单'
        }
        testID="header-menu"
        onPress={onPress}
      />
      {count > 0 ? (
        <View
          pointerEvents="none"
          style={[styles.dot, { top: theme.space.sm, right: theme.space.sm }]}
        >
          <Badge dot tone="warning" testID="header-menu-dot" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: { position: 'absolute' },
});
