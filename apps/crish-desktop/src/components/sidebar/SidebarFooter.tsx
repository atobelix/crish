import { useToast } from '../../services/toast/ToastContext';
import React from 'react';

import styles from './Sidebar.module.css';
import { Button, IconButton, Tooltip } from '../ui';
import {
  selectShowSettingsOverlay,
  toggleSettingsOverlay,
  useSettingsUiStore,
} from '../../store/storeAccess';
import { UserProfileCard } from './UserProfileCard';
import { AppIcon } from '../ui/icons/index';
import { useI18n } from '../../i18n';

export interface SettingsIconButtonProps {
  updateAvailable?: boolean | undefined;
  setUpdateAvailableState?:
    React.Dispatch<React.SetStateAction<boolean>> | undefined;
}

export const SettingsIconButton: React.FC<SettingsIconButtonProps> = React.memo(
  ({ updateAvailable }) => {
    const { t } = useI18n();
    const showSettings = useSettingsUiStore(selectShowSettingsOverlay);
    const closeOrOpen = showSettings
      ? t('common.close', '关闭')
      : t('sidebar.open', '打开');
    const settingsCenter = t('sidebar.settingsCenter', '设置中心');
    const updateAvailableText = updateAvailable
      ? ` · ${t('sidebar.updateAvailable', '有新版本可用')}`
      : '';
    const tooltipText = `${closeOrOpen}${settingsCenter} (Cmd/Ctrl + ,)${updateAvailableText}`;

    return (
      <IconButton
        size="md"
        variant="ghost"
        tooltip={tooltipText}
        aria-label={tooltipText}
        aria-pressed={showSettings}
        active={showSettings}
        data-testid="sidebar-settings-gear-btn"
        onClick={() => toggleSettingsOverlay()}
        icon={
          <>
            <AppIcon name="settings" size={16} stroke="fine" aria-hidden />
            {updateAvailable && (
              <span
                className={styles.gearUpdatePulseDot}
                aria-label={t('sidebar.newVersionHint', '新版本可用提示')}
              />
            )}
          </>
        }
      />
    );
  }
);

SettingsIconButton.displayName = 'SettingsIconButton';

export interface SidebarFooterProps {
  chromeHidden?: boolean | undefined;
  updateAvailable?: boolean | undefined;
  setUpdateAvailableState?:
    React.Dispatch<React.SetStateAction<boolean>> | undefined;
}

export const SidebarFooter: React.FC<SidebarFooterProps> = React.memo(
  ({ chromeHidden, updateAvailable, setUpdateAvailableState }) => {
    const { t } = useI18n();
    const { showToast } = useToast();
    return (
      <div
        className={styles.sidebarFooter}
        role="contentinfo"
        aria-label={t('sidebar.footerAriaLabel', '侧栏底栏')}
        aria-hidden={chromeHidden || undefined}
        inert={chromeHidden ? true : undefined}
      >
        {/* 底部左列：用户个人卡片与快捷设置菜单 */}
        <div className={styles.footerUserCol}>
          <UserProfileCard />
        </div>

        {/* 底部右列：更新按钮（若有）+ 独立设置齿轮按钮 */}
        <div className={styles.footerGearCol}>
          {updateAvailable ? (
            <Tooltip
              content={t('sidebar.updateTooltip', '有新版本，点击安装更新')}
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('sidebar.installUpdate', '安装更新')}
                onClick={() => {
                  void (async () => {
                    const { applyUpdateWhenIdle } =
                      await import('../../api/updateStore');
                    const r = await applyUpdateWhenIdle();
                    showToast(r.message);
                    if (r.ok) setUpdateAvailableState?.(false);
                  })();
                }}
                icon={<AppIcon name="refresh" size={16} aria-hidden />}
              >
                {t('sidebar.updateButton', '更新')}
              </Button>
            </Tooltip>
          ) : null}

          <SettingsIconButton
            updateAvailable={updateAvailable}
            setUpdateAvailableState={setUpdateAvailableState}
          />
        </div>
      </div>
    );
  }
);

SidebarFooter.displayName = 'SidebarFooter';
