import React from 'react';
import * as Lucide from 'lucide-react';

export interface SidebarNavProps {
  activeNav: string;
  onNewSession: () => void;
  onOpenScheduled: () => void;
}

/** 顶部「新对话 / 定时任务」：默认安静，hover 或选中时才抬升 */
export const SidebarNav: React.FC<SidebarNavProps> = ({
  activeNav,
  onNewSession,
  onOpenScheduled,
}) => {
  return (
    <div className="sidebar-top-actions">
      <button
        type="button"
        className={`sb-nav-item ${activeNav === 'chat' ? 'is-active' : ''}`}
        onClick={onNewSession}
      >
        <Lucide.Plus size={16} strokeWidth={2} />
        <span>新对话</span>
      </button>
      <button
        type="button"
        className={`sb-nav-item ${activeNav === 'scheduled' ? 'is-active' : ''}`}
        onClick={onOpenScheduled}
      >
        <Lucide.Clock size={16} strokeWidth={1.75} />
        <span>定时任务</span>
      </button>
    </div>
  );
};
