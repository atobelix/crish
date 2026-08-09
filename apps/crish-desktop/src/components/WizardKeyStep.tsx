/**
 * 向导第 0 步：配置密钥。
 * 服务商选择（SettingsSelect）+ 密钥输入（页内 error 共享壳层 role=alert）。
 */
import React from 'react';
import styles from './overlay/FirstRunWizard.module.css';
import { Select } from './ui';
import { profileDisplayLabel, type ProviderProfile } from '../api/providerProfiles';

/** 本步用到的可访问 id（useId 生成，壳层透传防重复渲染串 id） */
export type WizardKeyStepIds = {
  providerId: string;
  keyId: string;
};

export type WizardKeyStepProps = {
  ids: WizardKeyStepIds;
  profiles: ProviderProfile[];
  profileId: string;
  apiKey: string;
  busy: boolean;
  /** 壳层 role=alert 文案（仅用于 aria-invalid / aria-describedby） */
  error: string;
  describedBy?: string;
  onProfileChange: (id: string) => void;
  onKeyChange: (v: string) => void;
  onEnter: () => void;
};

export const WizardKeyStep: React.FC<WizardKeyStepProps> = ({
  ids,
  profiles,
  profileId,
  apiKey,
  busy,
  error,
  describedBy,
  onProfileChange,
  onKeyChange,
  onEnter,
}) => {
  const hasProfiles = profiles.length > 0;
  return (
    <>
      <label className={styles.firstRunLabel} htmlFor={ids.providerId}>
        服务商
      </label>
      {hasProfiles ? (
        <Select
          {...(styles.firstRunSelect !== undefined && { className: styles.firstRunSelect })}
          value={profileId}
          disabled={busy}
          options={profiles.map((p) => ({
            id: p.id,
            label: profileDisplayLabel(p),
          }))}
          onChange={(id) => {
            onProfileChange(id);
          }}
        />
      ) : (
        <p className={styles.firstRunHint} role="status">
          暂无服务商配置。可跳过向导，稍后在设置中添加。
        </p>
      )}
      <label className={styles.firstRunLabel} htmlFor={ids.keyId}>
        API 密钥
      </label>
      <input
        id={ids.keyId}
        type="password"
        className={styles.firstRunInput}
        placeholder="粘贴密钥"
        value={apiKey}
        autoComplete="off"
        spellCheck={false}
        disabled={busy || !hasProfiles}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => onKeyChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !busy) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      <p className={styles.firstRunHint}>
        密钥仅保存在本机。不会预置模型 id，也不会采用远程演示默认。
      </p>
    </>
  );
};
