import React from 'react';
import styles from './SidebarNav.module.css';
import * as Lucide from 'lucide-react';

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
      <button
        type="button"
        className={styles.navItem}
        data-testid="new-session-button"
        onClick={onNewSession}
      >
        {/* 自定义新建对话图标：软圆角开口方 + 钢笔，右上留缺口避免与笔身重合 */}
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M11 3H7.5A4.5 4.5 0 0 0 3 7.5v9A4.5 4.5 0 0 0 7.5 21h9a4.5 4.5 0 0 0 4.5-4.5v-6" />
          <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
        </svg>
        <span>新对话</span>
      </button>
      <button
        type="button"
        className={`${styles.navItem}${scheduledActive ? ` ${styles.isActive}` : ''}`}
        data-testid="sidebar-nav-scheduled"
        aria-pressed={scheduledActive}
        onClick={onOpenScheduled}
      >
        <Lucide.Clock size={16} strokeWidth={1.75} aria-hidden />
        <span>定时任务</span>
      </button>
      {onSearchChange && (
        <div
          className={`${styles.navItem} no-drag`}
          role="search"
          aria-label="会话搜索"
        >
          <Lucide.Search size={16} strokeWidth={1.75} aria-hidden="true" />
          <input
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
