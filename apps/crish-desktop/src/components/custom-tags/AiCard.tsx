/**
 * AiCard.tsx
 *
 * <ai-card> AI 步骤决策卡片
 *
 * 核心能力：
 * 1. 状态脉冲：运行态（running）呈现 Emerald 翡翠绿脉冲呼吸光效；
 * 2. 状态映射：支持 running / success / warning / error / idle 五种状态，完成态遵循克制中性墨阶；
 * 3. 自适应折叠：通过 data 属性与 CSS 驱动平滑展开 / 折叠与箭头旋转；
 * 4. 故障重试：错误态提供直接触发重试的动作入口。
 */

import React, { useState, type ReactNode } from 'react';
import styles from './custom-tags.module.css';
import { CustomTagErrorBoundary } from './CustomTagErrorBoundary';
import type { ExtraComponentProps } from './CustomTagRegistry';
import { Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';

export interface AiCardProps extends ExtraComponentProps {
  title?: string;
  status?: 'running' | 'success' | 'warning' | 'error' | 'idle';
  badge?: string;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  children?: ReactNode;
  onRetry?: () => void;
}

export const AiCardInner: React.FC<AiCardProps> = ({
  title = 'AI 决策步骤',
  status: initialStatus,
  badge,
  collapsible = true,
  defaultExpanded = true,
  isStreaming = false,
  children,
  onAgentAction,
  onRetry,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // 若未显式传入 status，在流式生成中默认为 running，否则为 success
  const effectiveStatus = initialStatus || (isStreaming ? 'running' : 'success');

  const toggleExpand = () => {
    if (collapsible) {
      setExpanded((prev) => !prev);
    }
  };

  const handleRetry = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRetry?.();
    onAgentAction?.('retry_step', { title });
  };

  const getStatusIcon = () => {
    switch (effectiveStatus) {
      case 'running':
        return (
          <Tooltip content="执行中...">
            <div className={styles.statusRunning} aria-label="执行中" />
          </Tooltip>
        );
      case 'success':
        return (
          <Tooltip content="完成">
            <div className={styles.statusSuccess} aria-label="完成" />
          </Tooltip>
        );
      case 'warning':
        return (
          <Tooltip content="警告">
            <div className={styles.statusWarning} aria-label="警告" />
          </Tooltip>
        );
      case 'error':
        return (
          <Tooltip content="出错">
            <div className={styles.statusError} aria-label="出错" />
          </Tooltip>
        );
      default:
        return <AppIcon name="bot" size={14} aria-hidden="true" />;
    }
  };

  return (
    <div
      className={styles.aiCard}
      data-status={effectiveStatus}
      data-streaming={isStreaming ? 'true' : 'false'}
      data-collapsible={collapsible ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div className={styles.cardHeader} onClick={toggleExpand}>
        <div className={styles.cardTitleGroup}>
          {getStatusIcon()}
          <span className={styles.cardTitle}>{title}</span>
          {badge && <span className={styles.aiCardBadge}>{badge}</span>}
        </div>

        <div className={styles.cardActions}>
          {effectiveStatus === 'error' && (onRetry || onAgentAction) && (
            <button
              type="button"
              className={styles.actionBtn}
              onClick={handleRetry}
              aria-label="重试"
            >
              重试
            </button>
          )}

          {collapsible && (
            <span className={styles.chevronIcon} aria-hidden="true">
              <AppIcon name="chevron-right" size={12} aria-hidden="true" />
            </span>
          )}
        </div>
      </div>

      <div
        className={
          expanded ? styles.aiCardContent : styles.aiCardContentCollapsed
        }
      >
        {children}
      </div>
    </div>
  );
};

export const AiCard: React.FC<AiCardProps> = (props) => (
  <CustomTagErrorBoundary tagName="ai-card">
    <AiCardInner {...props} />
  </CustomTagErrorBoundary>
);
