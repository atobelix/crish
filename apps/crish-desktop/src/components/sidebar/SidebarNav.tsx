import React from 'react';
import { Button, Input } from '@/components/ui';
import styles from './SidebarNav.module.css';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';

import { openSettings } from '../../api/storeAccess';

export interface SidebarNavProps {
  activeNav: string;
  onNewSession: () => void;
  onOpenScheduled: () => void;
  onOpenExtensions?: () => void;
  searchInput?: string | undefined;
  onSearchChange?: ((val: string) => void) | undefined;
}

/** 顶部「新对话 / 定时任务 / 扩展」：与会话行同一套 --state-hover，不走 Button 罩 */
export const SidebarNav: React.FC<SidebarNavProps> = ({
  activeNav,
  onNewSession,
  onOpenScheduled,
  onOpenExtensions,
  searchInput = '',
  onSearchChange,
}) => {
  const { t } = useI18n();
  const scheduledActive = activeNav === 'scheduled';
  const extensionsActive =
    activeNav === 'extensions' || activeNav === 'plugins';

  const handleOpenExtensions = () => {
    if (onOpenExtensions) {
      onOpenExtensions();
    } else {
      openSettings('plugins');
    }
  };

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
        <span>{t('sidebar.newChat', '新对话')}</span>
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
        <span>{t('sidebar.scheduledTasks', '定时任务')}</span>
      </Button>
      <Button
        variant="ghost"
        type="button"
        className={`${styles.navItem}${extensionsActive ? ` ${styles.isActive}` : ''}`}
        data-testid="sidebar-nav-extensions"
        aria-pressed={extensionsActive}
        onClick={handleOpenExtensions}
      >
        <AppIcon name="puzzle" size={16} aria-hidden />
        <span>{t('nav.extensions', '扩展')}</span>
      </Button>
      {onSearchChange && (
        <div
          className={`${styles.navItem} no-drag`}
          role="search"
          aria-label={t('sidebar.searchSessions', '会话搜索')}
        >
          <AppIcon name="search" size={16} aria-hidden="true" />
          <Input
            bare
            type="search"
            placeholder={t('sidebar.searchPlaceholderFull', '搜索会话与消息…')}
            aria-label={t('sidebar.searchPlaceholderFull', '搜索会话与消息')}
            value={searchInput}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
};
