import React from 'react';
import styles from './Sidebar.module.css';
import { Button, Tooltip } from '../ui';
import {
  canUseDemoMode,
  getAppMode,
  isDemoMode,
  switchAppMode,
} from '../../api/appMode';
import { SettingsQuickMenu } from '../settings/SettingsQuickMenu';
import { RefreshCw } from 'lucide-react';
import type { ShowToastFn } from '../../hooks/useToastQueue';

export interface SidebarFooterProps {
  chromeHidden?: boolean | undefined;
  updateAvailable?: boolean | undefined;
  onShowToast: ShowToastFn;
  setUpdateAvailableState?:
    React.Dispatch<React.SetStateAction<boolean>> | undefined;
}

export const SidebarFooter: React.FC<SidebarFooterProps> = React.memo(
  ({ chromeHidden, updateAvailable, onShowToast, setUpdateAvailableState }) => {
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
        <div className={styles.footerActions}>
          <SettingsQuickMenu onShowToast={onShowToast} />
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
                    onShowToast?.(r.message);
                    if (r.ok) setUpdateAvailableState?.(false);
                  })();
                }}
                icon={<RefreshCw size={14} strokeWidth={1.75} aria-hidden />}
              >
                <span className={styles.footerUpdateLabel}>更新</span>
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </div>
    );
  }
);

SidebarFooter.displayName = 'SidebarFooter';
