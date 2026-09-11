import React from 'react';
import { Tooltip } from '../ui';
import styles from './ChatScrollFloorSlot.module.css';
import { AppIcon } from '../ui/icons/index';

export interface ChatScrollFloorSlotProps {
  /** 显式控制回底按钮是否可见 */
  visible?: boolean;
  /** 当前视口是否贴底（处于底部时完全隐藏回底按钮） */
  isAtBottom?: boolean;
  /** 距离底部的物理像素距离 */
  distanceToBottom?: number;
  /** 离底显现阈值，默认 120px */
  threshold?: number;
  /** 点击回底事件回调 */
  onScrollToBottom?: () => void;
  /** 点击事件回调（兼容别名） */
  onClick?: () => void;
  /** 未读新消息数量 */
  unreadCount?: number;
  /** 自定义槽位根容器类名 */
  className?: string;
  /** 自定义回底按钮类名 */
  buttonClassName?: string;
  /** 测试标识 */
  'data-testid'?: string;
}

/**
 * 零高度 Sticky 到底卡槽组件 (DIM-02 §1.3 / §1.4)
 *
 * 核心不变量：
 * 1. 容器样式 `position: sticky; bottom: 0; height: 0; width: 100%; pointer-events: none;`
 * 2. 物理高度为 0px，绝对不侵占视口空间，对 scrollHeight 的贡献严格为 0；
 * 3. 内部回底浮钮通过 `pointer-events: auto` 与负 margin 向上反向抽离可视；
 * 4. 离底超过阈值 (> 120px) 显现，贴底 (isAtBottom = true) 时完全隐藏。
 */
export const ChatScrollFloorSlot: React.FC<ChatScrollFloorSlotProps> = ({
  visible,
  isAtBottom,
  distanceToBottom,
  threshold = 120,
  onScrollToBottom,
  onClick,
  unreadCount = 0,
  className,
  buttonClassName,
  'data-testid': testId = 'chat-scroll-floor-slot',
}) => {
  let showButton = false;
  if (isAtBottom === true) {
    showButton = false;
  } else if (visible !== undefined) {
    showButton = visible;
  } else if (distanceToBottom !== undefined) {
    showButton = distanceToBottom > threshold;
  } else if (isAtBottom === false) {
    showButton = true;
  }

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onScrollToBottom?.();
    onClick?.();
  };

  const tooltipLabel =
    unreadCount > 0 ? `回到底部 (${unreadCount} 条新消息)` : '回到底部';

  return (
    <div
      className={`${styles.floorSlot}${className ? ` ${className}` : ''}`}
      style={{
        position: 'sticky',
        bottom: 0,
        height: 0,
        width: '100%',
        pointerEvents: 'none',
      }}
      aria-hidden={!showButton}
      data-testid={testId}
      data-at-bottom={isAtBottom ? 'true' : 'false'}
    >
      {showButton ? (
        <div className={styles.buttonAnchor}>
          <Tooltip content={tooltipLabel}>
            <button
              type="button"
              className={`${styles.chatScrollFab}${buttonClassName ? ` ${buttonClassName}` : ''}`}
              onClick={handleClick}
              aria-label="回到底部最新消息"
              data-testid="chat-scroll-floor-btn"
            >
              <AppIcon name="chevron-down" size={16} aria-hidden="true" />
              {unreadCount > 0 ? (
                <span
                  className={styles.unreadBadge}
                  data-testid="chat-floor-unread-badge"
                >
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              ) : null}
            </button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
};

ChatScrollFloorSlot.displayName = 'ChatScrollFloorSlot';
