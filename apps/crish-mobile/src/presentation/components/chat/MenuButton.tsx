// 汉堡按钮（原型 hamburger-white-btn）：纯白圆钮 + 微柔阴影，打开抽屉。
// 原型无角标点（彩色克制 J8）：待审批计数只进无障碍标签，不做视觉角标。
import { useMemo } from 'react';
import { useApprovalStore } from '@/adapters/hooks/useAppStore';
import { countUserDecisions } from '@/domain/pure/approvalAttention';
import { IconButton } from '@/presentation/ui';

export interface MenuButtonProps {
  onPress: () => void;
}

export function MenuButton({ onPress }: MenuButtonProps) {
  const pending = useApprovalStore((s) => s.pending);
  const count = useMemo(() => countUserDecisions(pending), [pending]);
  return (
    <IconButton
      name="menu"
      variant="floating"
      accessibilityLabel={
        count > 0 ? `打开菜单，${count} 项待审批` : '打开菜单'
      }
      testID="header-menu"
      onPress={onPress}
    />
  );
}
