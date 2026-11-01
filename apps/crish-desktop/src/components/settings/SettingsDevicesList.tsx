/**
 * 设置 · 多端互通 · 已配对设备列表（从 SettingsDevicesTab 提取）。
 * 展示设备标签/哈希截断/签发时间/已撤销徽标，行内改名与撤销操作。
 * 行形态走 SettingsUI 的 SettingsRow，空态走共享 SettingsEmpty，文案全量 i18n。
 */
import React from 'react';
import styles from './SettingsDevicesTab.module.css';
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsEmpty,
} from './SettingsUI';
import { Button, Input, Tooltip } from '@/components/ui';
import type { DeviceInfo } from '../../api/multiDevice';
import type { RenameState } from './useDeviceRename';
import type { RenameAction } from './useDeviceRename';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';

export interface SettingsDevicesListProps {
  devices: DeviceInfo[];
  rename: RenameState;
  dispatchRename: React.Dispatch<RenameAction>;
  startRename: (device: DeviceInfo) => void;
  onRevoke: (deviceId: string) => void;
  onRenameSubmit: (deviceId: string) => void;
}

export const SettingsDevicesList: React.FC<SettingsDevicesListProps> = ({
  devices,
  rename,
  dispatchRename,
  startRename,
  onRevoke,
  onRenameSubmit,
}) => {
  const { t } = useI18n();
  return (
    <SettingsSection title={t('settings.devices.pairedSection', '已配对设备')}>
      <SettingsCard>
        {devices.length === 0 ? (
          <div data-testid="devices-empty">
            <SettingsEmpty
              icon={<AppIcon name="smartphone" size={24} aria-hidden />}
              title={t('settings.devices.emptyTitle', '暂无已配对设备')}
              description={t(
                'settings.devices.emptyDesc',
                '开启配对模式后，手机端扫码即可加入'
              )}
            />
          </div>
        ) : (
          <div data-testid="device-list">
            {devices.map((device) => {
              const isRenaming = rename.renamingHash === device.id;
              return (
                <SettingsRow
                  key={device.id}
                  icon={<AppIcon name="smartphone" size={16} aria-hidden />}
                  title={
                    isRenaming ? (
                      <span className={styles.renameRow}>
                        <Input
                          value={rename.renameDraft}
                          onChange={(e) =>
                            dispatchRename({
                              type: 'setRenameDraft',
                              value: e.target.value,
                            })
                          }
                          aria-label={t(
                            'settings.devices.renameInputAria',
                            '设备新名称'
                          )}
                          autoFocus
                        />
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => onRenameSubmit(device.id)}
                        >
                          {t('common.save', '保存')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            dispatchRename({ type: 'cancelRename' })
                          }
                        >
                          {t('common.cancel', '取消')}
                        </Button>
                      </span>
                    ) : (
                      <span className={styles.deviceTitle}>
                        <Tooltip content={device.label}>
                          <span className={styles.deviceLabel}>
                            {device.label}
                          </span>
                        </Tooltip>
                        {device.revoked && (
                          <span className={styles.revokedBadge}>
                            {t('settings.devices.revokedBadge', '已撤销')}
                          </span>
                        )}
                      </span>
                    )
                  }
                  desc={
                    isRenaming ? undefined : (
                      <span className={styles.deviceDesc}>
                        <Tooltip content={device.id}>
                          <span>{device.id.slice(0, 12)}…</span>
                        </Tooltip>
                        <span>
                          {new Date(device.issued_at_ms).toLocaleString()}
                        </span>
                      </span>
                    )
                  }
                  control={
                    isRenaming ? undefined : (
                      <span className={styles.deviceActions}>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => startRename(device)}
                        >
                          {t('settings.devices.rename', '改名')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => onRevoke(device.id)}
                        >
                          {t('settings.devices.revoke', '撤销')}
                        </Button>
                      </span>
                    )
                  }
                />
              );
            })}
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  );
};
