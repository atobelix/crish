/**
 * 设置 · 多端互通 · 网络环境卡片（从 SettingsDevicesTab 提取）。
 * 展示网络配置文件类别、可直连 IP 列表与 AP 隔离提示（R1-09 G-4）。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './SettingsDevicesTab.module.css';
import {
  SettingsSection,
  SettingsCard,
} from './SettingsUI';
import type { NetworkEnvInfo } from '../../api/multiDevice';

/** 网络配置文件类别 → 展示名（Rust multi_device_network_info 四态） */
const PROFILE_LABELS: Record<NetworkEnvInfo['profile'], string> = {
  public: '公用网络',
  private: '专用网络',
  domain: '域网络',
  unknown: '未知',
};

export interface SettingsDevicesNetworkEnvProps {
  netEnv: NetworkEnvInfo;
}

export const SettingsDevicesNetworkEnv: React.FC<SettingsDevicesNetworkEnvProps> = ({
  netEnv,
}) => {
  return (
    <SettingsSection title="网络环境">
      <SettingsCard>
        <div className={styles.networkEnv} data-testid="network-env">
          <div className={styles.networkProfile}>
            <Lucide.Wifi size={16} aria-hidden />
            <span>
              当前网络：{PROFILE_LABELS[netEnv.profile] ?? netEnv.profile}
            </span>
            {netEnv.profile === 'public' && (
              <span className={styles.networkPublicBadge}>公用网络</span>
            )}
          </div>
          {netEnv.profile === 'public' && (
            <div
              className={styles.firewallHint}
              data-testid="network-public-hint"
            >
              <Lucide.ShieldAlert size={14} aria-hidden />
              请切换到专用网络，否则 Windows 防火墙会阻止手机访问本机服务。
            </div>
          )}
          <div className={styles.ipList}>
            <span className={styles.ipListTitle}>
              手机可直连地址（AP 隔离时手动输入）：
            </span>
            {(() => {
              const ips = netEnv.usable_ips.filter(
                (ip) => ip !== '0.0.0.0'
              );
              return ips.length > 0 ? (
                <ul>
                  {ips.map((ip) => (
                    <li key={ip}>
                      <code>{ip}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className={styles.ipListEmpty}>
                  未检测到可直连地址，请检查网络连接。
                </span>
              );
            })()}
          </div>
          {netEnv.hint && (
            <div
              className={styles.apIsolationHint}
              data-testid="network-hint"
            >
              <Lucide.Router size={14} aria-hidden />
              {netEnv.hint}
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
};
