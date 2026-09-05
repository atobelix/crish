import { useToast } from '../../services/toast/ToastContext';
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './Sidebar.module.css';
import { Button, Tooltip } from '../ui';
import {
  toggleSettingsOverlay,
  useShowSettingsOverlay,
} from '../../store/settingsUiStore';
import { UserProfileCard } from './UserProfileCard';

export interface SettingsIconButtonProps {
  updateAvailable?: boolean | undefined;
  setUpdateAvailableState?:
    React.Dispatch<React.SetStateAction<boolean>> | undefined;
}

export const SettingsIconButton: React.FC<SettingsIconButtonProps> = React.memo(
  ({ updateAvailable }) => {
    const showSettings = useShowSettingsOverlay();
    const tooltipText = `${showSettings ? '关闭' : '打开'}设置中心 (Cmd/Ctrl + ,)${
      updateAvailable ? ' · 有新版本可用' : ''
    }`;

    return (
      <Tooltip content={tooltipText}>
        <button
          type="button"
          className={`${styles.settingsGearBtn}${showSettings ? ` ${styles.isOpen}` : ''}`}
          data-testid="sidebar-settings-gear-btn"
          aria-label={tooltipText}
          aria-pressed={showSettings}
          onClick={() => toggleSettingsOverlay()}
        >
          <Lucide.Settings size={16} strokeWidth={1.75} aria-hidden />
          {updateAvailable && (
            <span
              className={styles.gearUpdatePulseDot}
              aria-label="新版本可用提示"
            />
          )}
        </button>
      </Tooltip>
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
    const { showToast } = useToast();
    return (
      <div
        className={styles.sidebarFooter}
        role="contentinfo"
        aria-label="侧栏底栏"
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
            <Tooltip content="有新版本，点击安装更新">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={`${styles.footerUpdate} ${styles.isVisible}`}
                aria-label="安装更新"
                onClick={() => {
                  void (async () => {
                    const { applyUpdateWhenIdle } =
                      await import('../../api/updateStore');
                    const r = await applyUpdateWhenIdle();
                    showToast(r.message);
                    if (r.ok) setUpdateAvailableState?.(false);
                  })();
                }}
                icon={
                  <Lucide.RefreshCw size={14} strokeWidth={1.75} aria-hidden />
                }
              >
                <span className={styles.footerUpdateLabel}>更新</span>
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
