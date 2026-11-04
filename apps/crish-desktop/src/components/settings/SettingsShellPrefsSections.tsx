/**
 * apps/crish-desktop/src/components/settings/SettingsShellPrefsSections.tsx
 *
 * 设置 · 个性化页的「窗口与启动」+「桌面通知」两分区（托盘/通知批 2026-11-03，
 * 自 SettingsPersonalizeTab 抽出以满足行数门禁）：走 preferencesClient 的
 * prefs SSOT（不经 clientApi Settings），开关变更经 onToggle 回宿主统一
 * 落盘与失败回滚；本组件只负责呈现。
 */
import React from 'react';
import { SettingsCard, SettingsRow, SettingsSection } from './SettingsUI';
import { Switch } from '@/components/ui';
import { useI18n } from '../../i18n';

/** 托盘/通知批的壳层偏好键（prefs SSOT，布尔七项） */
export type ShellPrefKey =
  | 'tray_enabled'
  | 'close_to_tray'
  | 'keep_awake_during_tasks'
  | 'desktop_notifications_enabled'
  | 'notify_on_task_done'
  | 'autostart_enabled'
  | 'start_minimized';

export interface SettingsShellPrefsSectionsProps {
  shellPrefs: Record<ShellPrefKey, boolean>;
  onToggle: (key: ShellPrefKey, next: boolean) => void;
}

export const SettingsShellPrefsSections: React.FC<
  SettingsShellPrefsSectionsProps
> = ({ shellPrefs, onToggle }) => {
  const { t } = useI18n();
  return (
    <>
      <SettingsSection title={t('settings.windowStartup.title')}>
        <SettingsCard>
          <SettingsRow
            title={t('settings.windowStartup.trayEnabled')}
            desc={t('settings.windowStartup.trayEnabledDesc')}
            control={
              <Switch
                aria-label={t('settings.windowStartup.trayEnabled')}
                checked={shellPrefs.tray_enabled}
                onCheckedChange={(next) => void onToggle('tray_enabled', next)}
              />
            }
          />
          <SettingsRow
            title={t('settings.windowStartup.closeToTray')}
            desc={t('settings.windowStartup.closeToTrayDesc')}
            control={
              <Switch
                aria-label={t('settings.windowStartup.closeToTray')}
                checked={shellPrefs.close_to_tray}
                disabled={!shellPrefs.tray_enabled}
                onCheckedChange={(next) => void onToggle('close_to_tray', next)}
              />
            }
          />
          <SettingsRow
            title={t('settings.windowStartup.autostart')}
            desc={t('settings.windowStartup.autostartDesc')}
            control={
              <Switch
                aria-label={t('settings.windowStartup.autostart')}
                checked={shellPrefs.autostart_enabled}
                onCheckedChange={(next) =>
                  void onToggle('autostart_enabled', next)
                }
              />
            }
          />
          <SettingsRow
            title={t('settings.windowStartup.startMinimized')}
            desc={t('settings.windowStartup.startMinimizedDesc')}
            control={
              <Switch
                aria-label={t('settings.windowStartup.startMinimized')}
                checked={shellPrefs.start_minimized}
                disabled={!shellPrefs.tray_enabled}
                onCheckedChange={(next) =>
                  void onToggle('start_minimized', next)
                }
              />
            }
          />
          <SettingsRow
            title={t('settings.windowStartup.keepAwake')}
            desc={t('settings.windowStartup.keepAwakeDesc')}
            control={
              <Switch
                aria-label={t('settings.windowStartup.keepAwake')}
                checked={shellPrefs.keep_awake_during_tasks}
                onCheckedChange={(next) =>
                  void onToggle('keep_awake_during_tasks', next)
                }
              />
            }
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t('settings.notification.desktopGroup')}>
        <SettingsCard>
          <SettingsRow
            title={t('settings.notification.enableDesktop')}
            desc={t('settings.notification.enableDesktopDesc')}
            control={
              <Switch
                aria-label={t('settings.notification.enableDesktop')}
                checked={shellPrefs.desktop_notifications_enabled}
                onCheckedChange={(next) =>
                  void onToggle('desktop_notifications_enabled', next)
                }
              />
            }
          />
          <SettingsRow
            title={t('settings.notification.notifyOnTaskDone')}
            desc={t('settings.notification.notifyOnTaskDoneDesc')}
            control={
              <Switch
                aria-label={t('settings.notification.notifyOnTaskDone')}
                checked={shellPrefs.notify_on_task_done}
                disabled={!shellPrefs.desktop_notifications_enabled}
                onCheckedChange={(next) =>
                  void onToggle('notify_on_task_done', next)
                }
              />
            }
          />
          <SettingsRow
            title={t('settings.notification.alwaysOnFailure')}
            desc={t('settings.notification.alwaysOnFailureDesc')}
          />
          <SettingsRow
            title={t('settings.notification.notifyOnApproval')}
            desc={t('settings.notification.alwaysOnApprovalDesc')}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
};
