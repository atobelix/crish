import React from 'react';
import styles from './SidebarNav.module.css';
import * as Lucide from 'lucide-react';

export interface SidebarNavProps {
  activeNav: string;
  onNewSession: () => void;
  onOpenScheduled: () => void;
  searchInput?: string;
  onSearchChange?: (val: string) => void;
}

/** 顶部「新对话 / 定时任务」：默认安静，hover 或选中时才抬升 */
export const SidebarNav: React.FC<SidebarNavProps> = ({
  activeNav,
  onNewSession,
  onOpenScheduled,
  searchInput = '',
  onSearchChange,
}) => {
  return (
    <div className={styles.topActions}>
      <button
        type="button"
        className={`${styles.navItem} ${activeNav === 'chat' ? styles.isActive : ''}`}
        onClick={onNewSession}
      >
        {/* 自定义新建对话图标：匹配顶部侧边栏按钮的软圆角 (rx=4.5)，且右上角留出缺口避免与画笔重合 */}
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
          {/* 具有软圆角的打开框（rx=4.5） */}
          <path d="M11 3H7.5A4.5 4.5 0 0 0 3 7.5v9A4.5 4.5 0 0 0 7.5 21h9a4.5 4.5 0 0 0 4.5-4.5v-6" />
          {/* 钢笔笔身，完美斜穿出开口区域 */}
          <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
        </svg>
        <span>新对话</span>
      </button>
      <button
        type="button"
        className={`${styles.navItem} ${activeNav === 'scheduled' ? styles.isActive : ''}`}
        onClick={onOpenScheduled}
      >
        <Lucide.Clock size={16} strokeWidth={1.75} />
        <span>定时任务</span>
      </button>
      {onSearchChange && (
        <div
          className={`${styles.navItem} no-drag`}
          role="search"
          aria-label="会话搜索"
          style={{
            cursor: 'text',
          }}
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
