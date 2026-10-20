import React from 'react';

import type { IconName } from '../ui/icons';

export interface QuickPromptItem {
  id: string;
  title: string;
  description: string;
  icon: IconName;
  action: () => void;
}

export interface OverviewQuickActionsProps {
  onOpenPanel?: ((id: string) => void) | undefined;
}

/**
 * 快捷入口与推荐模板组件
 *
 * 现状：占位实现（`return null`），尚无渲染内容，因此不引入样式/事件/UI 依赖。
 * 接入真实入口时再补齐 imports（styles / emitUiEvent / Button / Tooltip）。
 */
export const OverviewQuickActions: React.FC<OverviewQuickActionsProps> = () => {
  return null;
};
