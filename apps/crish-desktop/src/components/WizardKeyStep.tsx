/**
 * 向导第 0 步：配置连接（中立表单）。
 * 厂商名称 + Base URL + API 密钥 + 协议 —— 与设置 · 连接与凭据同构。
 * 不预置任何第三方服务商下拉。
 */
import React from 'react';
import styles from './overlay/FirstRunWizard.module.css';
import { Select, Input } from './ui';
import { YAML_PROTOCOL_SELECT_OPTIONS } from './settings-models/catalogWriteGate';
import { DEFAULT_WIZARD_PROTOCOL } from './firstRunWizardLib';

/** 本步用到的可访问 id（useId 生成，壳层透传防重复渲染串 id） */
export type WizardKeyStepIds = {
  nameId: string;
  baseUrlId: string;
  keyId: string;
  protocolId: string;
};

export type WizardKeyStepProps = {
  ids: WizardKeyStepIds;
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol: string;
  busy: boolean;
  /** 壳层 role=alert 文案（仅用于 aria-invalid / aria-describedby） */
  error: string;
  describedBy?: string;
  onNameChange: (v: string) => void;
  onBaseUrlChange: (v: string) => void;
  onKeyChange: (v: string) => void;
  onProtocolChange: (v: string) => void;
  onEnter: () => void;
};

export const WizardKeyStep: React.FC<WizardKeyStepProps> = ({
  ids,
  name,
  baseUrl,
  apiKey,
  protocol,
  busy,
  error,
  describedBy,
  onNameChange,
  onBaseUrlChange,
  onKeyChange,
  onProtocolChange,
  onEnter,
}) => {
  const inputProps = {
    disabled: busy,
    spellCheck: false,
    autoComplete: 'off',
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
  } as const;

  return (
    <>
      <label className={styles.firstRunLabel} htmlFor={ids.nameId}>
        服务商名称
      </label>
      <Input
        bare
        id={ids.nameId}
        className={styles.firstRunInput}
        placeholder="例如: 自建网关、公司代理"
        value={name}
        {...inputProps}
        onChange={(e) => onNameChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !busy) {
            e.preventDefault();
            onEnter();
          }
        }}
      />

      <label className={styles.firstRunLabel} htmlFor={ids.baseUrlId}>
        Base URL
      </label>
      <Input
        bare
        id={ids.baseUrlId}
        className={styles.firstRunInput}
        placeholder="https://api.example.com/v1"
        value={baseUrl}
        {...inputProps}
        onChange={(e) => onBaseUrlChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !busy) {
            e.preventDefault();
            onEnter();
          }
        }}
      />

      <label className={styles.firstRunLabel} htmlFor={ids.protocolId}>
        首要通信协议
      </label>
      <Select
        {...(styles.firstRunSelect !== undefined && {
          className: styles.firstRunSelect,
        })}
        value={protocol || DEFAULT_WIZARD_PROTOCOL}
        disabled={busy}
        options={YAML_PROTOCOL_SELECT_OPTIONS.map((o) => ({
          id: o.id,
          label: o.label,
        }))}
        onChange={(id) => {
          onProtocolChange(id);
        }}
      />

      <label className={styles.firstRunLabel} htmlFor={ids.keyId}>
        API 密钥
      </label>
      <Input
        bare
        id={ids.keyId}
        type="password"
        className={styles.firstRunInput}
        placeholder="粘贴密钥"
        value={apiKey}
        {...inputProps}
        onChange={(e) => onKeyChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !busy) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      <p className={styles.firstRunHint}>
        密钥仅保存在本机。不绑定任何第三方服务商；协议层仅做接口兼容。
      </p>
    </>
  );
};
