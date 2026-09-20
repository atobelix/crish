import React from 'react';
import { Button, Input } from '../ui';
import styles from './SidebarNav.module.css';
import { AppIcon } from '../ui/icons/index';

export interface SidebarNavProps {
  activeNav: string;
  onNewSession: () => void;
  onOpenScheduled: () => void;
  searchInput?: string | undefined;
  onSearchChange?: ((val: string) => void) | undefined;
}

/** 顶部「新对话 / 定时任务」：与会话行同一套 --sidebar-hover，不走 Button 罩 */
export const SidebarNav: React.FC<SidebarNavProps> = ({
  activeNav,
  onNewSession,
  onOpenScheduled,
  searchInput = '',
  onSearchChange,
}) => {
  const scheduledActive = activeNav === 'scheduled';
  return (
    <div className={styles.topActions}>
      <Button
        variant="ghost"
        type="button"
        className={styles.navItem}
        data-testid="new-session-button"
        onClick={onNewSession}
      >
        <AppIcon name="new-chat" size={16} aria-hidden="true" />
        <span>新对话</span>
      </Button>
      <Button
        variant="ghost"
        type="button"
        className={`${styles.navItem}${scheduledActive ? ` ${styles.isActive}` : ''}`}
        data-testid="sidebar-nav-scheduled"
        aria-pressed={scheduledActive}
        onClick={onOpenScheduled}
      >
        <AppIcon name="clock" size={16} aria-hidden />
        <span>定时任务</span>
      </Button>
      {onSearchChange && (
        <div
          className={`${styles.navItem} no-drag`}
          role="search"
          aria-label="会话搜索"
        >
          <AppIcon name="search" size={16} aria-hidden="true" />
          <Input
            bare
            type="search"
            placeholder="搜索会话与消息…"
            aria-label="搜索会话与消息"
            value={searchInput}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
};
