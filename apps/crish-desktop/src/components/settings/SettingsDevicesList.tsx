/**
 * 设置 · 多端互通 · 已配对设备列表（从 SettingsDevicesTab 提取）。
 * 展示设备标签/哈希截断/签发时间/已撤销徽标，行内改名与撤销操作。
 */
import React from 'react';
import styles from './SettingsDevicesTab.module.css';
import {
  SettingsSection,
  SettingsCard,
} from './SettingsUI';
import { Button, Input, Tooltip } from '../ui';
import type { DeviceInfo } from '../../api/multiDevice';
import type { RenameState } from './useDeviceRename';
import type { RenameAction } from './useDeviceRename';
import { AppIcon } from '../ui/icons/index';

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
  return (
    <SettingsSection title="已配对设备">
      <SettingsCard>
        {devices.length === 0 ? (
          <div className={styles.emptyState} data-testid="devices-empty">
            <AppIcon name="smartphone" size={24} aria-hidden />
            <p className={styles.emptyTitle}>暂无已配对设备</p>
            <p className={styles.emptySub}>开启配对模式后，手机端扫码即可加入</p>
          </div>
        ) : (
          <ul className={styles.deviceList} data-testid="device-list">
            {devices.map((device) => (
              <li key={device.id} className={styles.deviceRow}>
                <div className={styles.deviceIcon}>
                  <AppIcon name="smartphone" size={18} aria-hidden />
                </div>
                <div className={styles.deviceBody}>
                  {rename.renamingHash === device.id ? (
                    <div className={styles.renameRow}>
                      <Input
                        value={rename.renameDraft}
                        onChange={(e) =>
                          dispatchRename({
                            type: 'setRenameDraft',
                            value: e.target.value,
                          })
                        }
                        aria-label="设备新名称"
                        autoFocus
                      />
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => onRenameSubmit(device.id)}
                      >
                        保存
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => dispatchRename({ type: 'cancelRename' })}
                      >
                        取消
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className={styles.deviceTitle}>
                        <Tooltip content={device.label}>
                          <span className={styles.deviceLabel}>
                            {device.label}
                          </span>
                        </Tooltip>
                        {device.revoked && (
                          <span className={styles.revokedBadge}>已撤销</span>
                        )}
                      </div>
                      <div className={styles.deviceDesc}>
                        <Tooltip content={device.id}>
                          <span>{device.id.slice(0, 12)}…</span>
                        </Tooltip>
                        <span>
                          {new Date(device.issued_at_ms).toLocaleString()}
                        </span>
                      </div>
                    </>
                  )}
                </div>
                <div className={styles.deviceActions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => startRename(device)}
                  >
                    改名
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => onRevoke(device.id)}
                  >
                    撤销
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </SettingsSection>
  );
};
