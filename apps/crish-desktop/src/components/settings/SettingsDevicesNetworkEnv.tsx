/**
 * 设置 · 多端互通 · 网络环境卡片（从 SettingsDevicesTab 提取）。
 * 展示网络配置文件类别与 AP 隔离 / 防火墙提示（R1-09 G-4）。
 * 文案全量 i18n；后端 hint 原样展示，渲染层不再做正则改写。
 */
import React from 'react';
import styles from './SettingsDevicesTab.module.css';
import { SettingsSection, SettingsCard, SettingsRow } from './SettingsUI';
import type { NetworkEnvInfo } from '../../api/multiDevice';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';

export interface SettingsDevicesNetworkEnvProps {
  netEnv: NetworkEnvInfo;
}

export const SettingsDevicesNetworkEnv: React.FC<
  SettingsDevicesNetworkEnvProps
> = ({ netEnv }) => {
  const { t } = useI18n();

  /** 网络配置文件类别 → 展示名（Rust multi_device_network_info 四态） */
  const profileLabels: Record<NetworkEnvInfo['profile'], string> = {
    public: t('settings.devices.profilePublic', '公用网络'),
    private: t('settings.devices.profilePrivate', '专用网络'),
    domain: t('settings.devices.profileDomain', '域网络'),
    unknown: t('settings.devices.profileUnknown', '未知'),
  };

  const isPublic = netEnv.profile === 'public';
  const isPrivate = netEnv.profile === 'private';
  const isDomain = netEnv.profile === 'domain';

  const badgeClass = isPublic
    ? styles.profileBadgeWarn
    : isPrivate
      ? styles.profileBadgeSuccess
      : styles.profileBadge;

  const profileIcon = isPrivate
    ? 'check'
    : isPublic
      ? 'alert-triangle'
      : isDomain
        ? 'shield'
        : 'help-circle';

  return (
    <SettingsSection title={t('settings.devices.networkSection', '网络环境')}>
      <SettingsCard>
        <div className={styles.networkCardContent} data-testid="network-env">
          <SettingsRow
            icon={<AppIcon name="wifi" size={16} aria-hidden />}
            title={t('settings.devices.networkType', '网络类型')}
            desc={
              isPublic
                ? t(
                    'settings.devices.networkPublicDesc',
                    '当前处于公用网络，Windows 防火墙可能阻断手机访问'
                  )
                : isPrivate
                  ? t(
                      'settings.devices.networkPrivateDesc',
                      '专用网络环境，局域网直连通畅'
                    )
                  : t(
                      'settings.devices.networkUnknownDesc',
                      '未识别到当前网络类型（请检查 Windows 防火墙设置）'
                    )
            }
            control={
              <span className={badgeClass}>
                <AppIcon name={profileIcon} size={12} aria-hidden />
                {profileLabels[netEnv.profile] ?? netEnv.profile}
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
                {t(
                  'settings.devices.networkPublicBanner',
                  '请切换到专用网络，否则 Windows 防火墙会阻止手机访问本机服务。'
                )}
              </span>
            </div>
          )}

          {netEnv.hint && (
            <div
              className={styles.networkFooterHint}
              data-testid="network-hint"
            >
              <AppIcon
                name="info"
                size={13}
                aria-hidden
                className={styles.networkFooterHintIcon}
              />
              <span>{netEnv.hint}</span>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
};
