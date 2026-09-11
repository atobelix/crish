import React from 'react';

import styles from './OverviewCard.module.css';
import { emitUiEvent } from '../../api/uiEvents';
import { Button, Tooltip } from '../ui';
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
 */
export const OverviewQuickActions: React.FC<OverviewQuickActionsProps> = () => {
  return null;
};