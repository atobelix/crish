import { useToast } from '../../services/toast/ToastContext';
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './Sidebar.module.css';
import { Button, Tooltip } from '../ui';
import {
  canUseDemoMode,
  getAppMode,
  isDemoMode,
  switchAppMode,
} from '../../api/appMode';
import { openSettings } from '../../store/settingsUiStore';
import { UserProfileCard } from './UserProfileCard';

export interface SettingsIconButtonProps {
  updateAvailable?: boolean | undefined;
  setUpdateAvailableState?:
    React.Dispatch<React.SetStateAction<boolean>> | undefined;
}

export const SettingsIconButton: React.FC<SettingsIconButtonProps> = React.memo(
  ({ updateAvailable }) => {
    const tooltipText = updateAvailable
      ? '打开设置中心 (Cmd/Ctrl + ,) · 有新版本可用'
      : '打开设置中心 (Cmd/Ctrl + ,)';

    return (
      <Tooltip content={tooltipText}>
        <button
          type="button"
          className={styles.settingsGearBtn}
          data-testid="sidebar-settings-gear-btn"
          aria-label="打开设置中心 (Cmd/Ctrl + ,)"
          onClick={() => openSettings()}
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
    const { showToast: _showToast } = useToast();
    return (
      <div
        className={styles.sidebarFooter}
        role="contentinfo"
        aria-label="侧栏底栏"
        aria-hidden={chromeHidden || undefined}
        inert={chromeHidden ? true : undefined}
      >
        {canUseDemoMode() && (
          <Tooltip content="开发切换：正式 / 演示 (正式包不会出现)">
            <button
              type="button"
              className={`${styles.modeChip} ${isDemoMode() ? styles.isDemo : ''}`}
              aria-label={
                isDemoMode()
                  ? '当前演示模式，点击切换为正式'
                  : '当前正式模式，点击切换为演示'
              }
              aria-pressed={isDemoMode()}
              onClick={() => {
                const next = getAppMode() === 'demo' ? 'normal' : 'demo';
                switchAppMode(next);
              }}
            >
              {isDemoMode() ? '演示' : '正式'}
            </button>
          </Tooltip>
        )}

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
