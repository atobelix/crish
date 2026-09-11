/**
 * 设置 · 多端互通 · 网络环境卡片（从 SettingsDevicesTab 提取）。
 * 展示网络配置文件类别、可直连 IP 列表与 AP 隔离提示（R1-09 G-4）。
 */
import React from 'react';
import styles from './SettingsDevicesTab.module.css';
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import type { NetworkEnvInfo } from '../../api/multiDevice';
import { useToast } from '../../services/toast/ToastContext';
import { AppIcon } from '../ui/icons/index';
import { Tooltip } from '../ui';

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
  const { showToast } = useToast();
  const ips = (netEnv.usableIps ?? netEnv.usable_ips ?? []).filter(
    (ip) => ip !== '0.0.0.0'
  );

  const isPublic = netEnv.profile === 'public';
  const isPrivate = netEnv.profile === 'private';

  const badgeClass = isPublic
    ? styles.profileBadgeWarn
    : isPrivate
    ? styles.profileBadgeSuccess
    : styles.profileBadge;

  const handleCopyIp = async (ip: string) => {
    try {
      await navigator.clipboard.writeText(ip);
      showToast(`已复制 IP 地址：${ip}`);
    } catch {
      // ignore
    }
  };

  return (
    <SettingsSection title="网络环境">
      <SettingsCard>
        <div className={styles.networkCardContent} data-testid="network-env">
          <SettingsRow
            icon={<AppIcon name="wifi" size={18} aria-hidden />}
            title="网络类型"
            desc={
              isPublic
                ? '当前处于公用网络，Windows 防火墙可能阻断手机访问'
                : isPrivate
                ? '专用网络环境，局域网直连通畅'
                : '网络配置文件状态'
            }
            control={
              <span className={badgeClass}>
                {PROFILE_LABELS[netEnv.profile] ?? netEnv.profile}
              </span>
            }
          />

          {isPublic && (
            <div
              className={styles.networkWarnBanner}
              data-testid="network-public-hint"
            >
              <AppIcon name="shield-alert" size={14} aria-hidden />
              <span>
                请切换到专用网络，否则 Windows 防火墙会阻止手机访问本机服务。
              </span>
            </div>
          )}

          <SettingsRow
            icon={<AppIcon name="network" size={18} aria-hidden />}
            title="手机直连地址"
            desc="扫码失败或跨网段时手动输入"
            control={
              ips.length > 0 ? (
                <div className={styles.ipBadgeGroup}>
                  {ips.map((ip) => (
                    <Tooltip key={ip} content="点击复制 IP 地址">
                      <button
                        type="button"
                        className={styles.ipBadge}
                        onClick={() => void handleCopyIp(ip)}
                        aria-label="点击复制 IP 地址"
                      >
                        <code>{ip}</code>
                        <AppIcon name="copy" size={11} aria-hidden />
                      </button>
                    </Tooltip>
                  ))}
                </div>
              ) : (
                <span className={styles.ipListEmpty}>
                  未检测到可直连地址，请检查网络连接。
                </span>
              )
            }
          />

          {netEnv.hint && (
            <div
              className={styles.networkFooterHint}
              data-testid="network-hint"
            >
              <AppIcon name="info" size={13} aria-hidden />
              <span>{netEnv.hint}</span>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
};
