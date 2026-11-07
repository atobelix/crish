/**
 * apps/crish-desktop/src/components/ui/G2Surface/SepPanelShell.tsx
 *
 * SEP 族浮层面 · 单挂接点（G² 第一波丙 · 槽 B 收敛）：
 * SEP 主面板 / 级联子菜单 / ui/Menu 弹窗 / ui/Popover 弹窗四处外壳，
 * 此前各备一份同值油漆（18px 外圆角 + surface-overlay + border-panel
 * 边框 + shadow-popover 阴影），现收敛到这一个组件——正典油漆只在此处
 * 声明一处，各宿主只留布局类（min-width/max-width/max-height 等）。
 * 档位 menuOuter（18）/ 填充 / 描边 / 阴影均为固定正典，不接受逐面
 * 覆写；确需不同规格的面（如斜杠菜单的半透底 + backdrop blur）直接
 * 用 G2Surface，不走本壳。
 *
 * 阴影：--sep-g2-shadow 取 --shadow-popover（= --shadow-lg）主导层，
 * 次层在 drop-shadow 单层口径下舍去（裁定 #6(a) 近似）；浅/暗两主题
 * 值见同目录 SepPanelShell.module.css（W1A 槽 A 同款写法）。
 *
 * ref 转发：根节点 ref 向外转发，可直接充当 Radix asChild / Base UI
 * render 的弹层元素（G2Surface.forwardRef，第一波丙）。
 */
import React from 'react';
import { G2Surface } from './G2Surface';
import { cn } from '../internal/cn';
import styles from './SepPanelShell.module.css';

export interface SepPanelShellProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof G2Surface>,
    'radius' | 'fill' | 'stroke' | 'strokeWidth' | 'mode' | 'dropShadow'
  > {
  // 正典油漆固定，不开放覆写；其余 G2Surface props（className/style/
  // clip/contentStyle/children/testID/data-*/事件）原样透传。
}

export const SepPanelShell = React.forwardRef<
  HTMLDivElement,
  SepPanelShellProps
>(function SepPanelShell({ children, className, ...rest }, ref) {
  return (
    <G2Surface
      ref={ref}
      radius="menuOuter"
      fill="var(--surface-overlay)"
      stroke="var(--border-panel)"
      dropShadow="var(--sep-g2-shadow)"
      className={cn(styles.shell, className)}
      {...rest}
    >
      {children}
    </G2Surface>
  );
});

SepPanelShell.displayName = 'SepPanelShell';
