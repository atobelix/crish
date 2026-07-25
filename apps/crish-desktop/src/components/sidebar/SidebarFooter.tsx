import React, { memo } from 'react';
import { RefreshCw } from 'lucide-react';
import styles from '../Sidebar.module.css';
import { Tooltip } from '../settings/SettingsUI';
import { canUseDemoMode, getAppMode, isDemoMode, switchAppMode } from '../../api/appMode';
import { SettingsQuickMenu } from '../SettingsQuickMenu';
import { isUpdateAvailable } from '../../api/updateStore';
import type { ShowToastFn } from '../../hooks/useToastQueue';

interface SidebarFooterProps {
  onShowToast: ShowToastFn;
}

const SidebarFooterInner: React.FC<SidebarFooterProps> = ({ onShowToast }) => {
  const [updateAvailable, setUpdateAvailableState] = React.useState(() => isUpdateAvailable());

  React.useEffect(() => {
    return import('../../api/uiEvents').then(({ onUiEvent }) =>
      onUiEvent('update-changed', () => {
        setUpdateAvailableState(isUpdateAvailable());
      })
    ).catch(() => {});
  }, []);

  return (
    <>
      {canUseDemoMode() && (
        <Tooltip content="开发切换：正式 / 演示 (正式包不会出现)">
          <button
            type="button"
            className={`${styles.modeChip} ${isDemoMode() ? styles.isDemo : ''}`}
            aria-label={isDemoMode() ? '当前演示模式，点击切换为正式' : '当前正式模式，点击切换为演示'}
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
            <button
              type="button"
              className={`${styles.footerUpdate} ${styles.isVisible}`}
              aria-label="安装更新"
              onClick={() => {
                void (async () => {
                  const { applyUpdateWhenIdle } = await import('../../api/updateStore');
                  const r = await applyUpdateWhenIdle();
                  onShowToast?.(r.message);
                  if (r.ok) setUpdateAvailableState(false);
                })();
              }}
            >
              <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
              <span className={styles.footerUpdateLabel}>更新</span>
            </button>
          </Tooltip>
        ) : null}
      </div>
    </>
  );
};

export const SidebarFooter = memo(SidebarFooterInner);
SidebarFooter.displayName = 'SidebarFooter';
