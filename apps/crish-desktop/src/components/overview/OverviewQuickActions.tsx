import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './OverviewCard.module.css';
import { emitUiEvent } from '../../api/uiEvents';
import { Tooltip } from '../Tooltip';

export interface QuickPromptItem {
  id: string;
  title: string;
  description: string;
  icon: keyof typeof Lucide;
  action: () => void;
}

export interface OverviewQuickActionsProps {
  onOpenPanel?: ((id: string) => void) | undefined;
}

/**
 * 快捷入口与推荐模板组件
 */
export const OverviewQuickActions: React.FC<OverviewQuickActionsProps> = ({
  onOpenPanel,
}) => {
  const prompts: QuickPromptItem[] = [
    {
      id: 'quick-summary',
      title: '总结项目状态',
      description: '分析当前项目进度与分支改动',
      icon: 'Sparkles',
      action: () => emitUiEvent('focus-composer'),
    },
    {
      id: 'quick-diff',
      title: '查看文件变更',
      description: '对比和审核最新的 Git 改动',
      icon: 'GitCompare',
      action: () => onOpenPanel?.('diff'),
    },
    {
      id: 'quick-terminal',
      title: '打开终端工具',
      description: '在当前工作区运行命令行任务',
      icon: 'Terminal',
      action: () => onOpenPanel?.('terminal'),
    },
  ];

  return (
    <div className={styles.quickPromptsList} aria-label="快捷提示卡片列表">
      {prompts.map((item) => {
        const IconComp = (Lucide[item.icon] as React.ComponentType<Lucide.LucideProps>) || Lucide.Zap;
        return (
          <Tooltip key={item.id} content={item.description}>
            <button
              type="button"
              className={styles.quickPromptCard}
              onClick={item.action}
              aria-label={`${item.title}：${item.description}`}
            >
              <IconComp size={14} className={styles.ico} aria-hidden />
              <span className={styles.quickPromptTitle}>{item.title}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
};

export const OverviewQuickPrompts = OverviewQuickActions;
export type { OverviewQuickActionsProps as OverviewQuickPromptsProps };
