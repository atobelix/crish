/**
 * ui/Menu 公共类型（PE-05 T05.1.4）
 *
 * SelectOptionItem 从 `components/common/UnifiedSelectPopover.tsx` 上移，
 * 作为菜单体系公共类型；后续 12 套菜单收敛（T05.3）统一从这里取类型。
 */
import type React from 'react';

/** 标准菜单项描述 */
export interface SelectOptionItem {
  id: string;
  label: string;
  /** 图标位 */
  icon?: React.ReactNode;
  /** 右侧次要信息 */
  hint?: string;
  /** 描述信息（支持富文本多行排版） */
  description?: React.ReactNode;
  disabled?: boolean;
  /** 危险操作项（错误红语义） */
  danger?: boolean;
  /** 独立点击行为（选中前触发） */
  onClick?: () => void;
  [key: string]: unknown;
}
