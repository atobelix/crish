/**
 * 向导第 0 步：配置连接（模型服务商）。
 * 提供 DeepSeek、智谱 GLM、OpenAI、Anthropic、Kimi 等常见 API 服务商快捷填入连接地址与协议，
 * 不预填任何旧模型 ID。
 */
import React from 'react';
import styles from './overlay/FirstRunWizard.module.css';
import { Button, Select, Input } from './ui';
import { YAML_PROTOCOL_SELECT_OPTIONS } from './settings-models/catalogWriteGate';
import { DEFAULT_WIZARD_PROTOCOL } from './firstRunWizardLib';

export type ProviderPreset = {
  id: string;
  name: string;
  baseUrl: string;
  protocol: string;
};

export const POPULAR_PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai/chat',
  },
  {
    id: 'z-ai',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai/chat',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai/responses',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    protocol: 'anthropic/messages',
  },
  {
    id: 'moonshotai',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai/chat',
  },
];

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
  onPresetSelect?: (preset: ProviderPreset) => void;
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
  onPresetSelect,
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
      <div
        className={styles.firstRunChips}
        role="group"
        aria-label="快捷选择常用服务商"
      >
        {POPULAR_PROVIDER_PRESETS.map((preset) => {
          const isSelected =
            name.trim().toLowerCase() === preset.name.toLowerCase() ||
            baseUrl.trim().toLowerCase() === preset.baseUrl.toLowerCase();
          return (
            <Button
              bare
              key={preset.id}
              type="button"
              className={`${styles.firstRunChip} ${isSelected ? styles.isActive : ''}`}
              disabled={busy}
              onClick={() => {
                onNameChange(preset.name);
                onBaseUrlChange(preset.baseUrl);
                onProtocolChange(preset.protocol);
                onPresetSelect?.(preset);
              }}
            >
              {preset.name}
            </Button>
          );
        })}
      </div>

      <label className={styles.firstRunLabel} htmlFor={ids.nameId}>
        服务商名称
      </label>
      <Input
        bare
        id={ids.nameId}
        className={styles.firstRunInput}
        placeholder="例如 DeepSeek、智谱 GLM、OpenAI、Kimi"
        value={name}
        {...inputProps}
        onChange={(e) => onNameChange(e.target.value)}
        onEnter={() => {
          if (!busy) {
            onEnter();
          }
        }}
      />

      <label className={styles.firstRunLabel} htmlFor={ids.baseUrlId}>
        Base URL (API 地址)
      </label>
      <Input
        bare
        id={ids.baseUrlId}
        className={styles.firstRunInput}
        placeholder="https://api.deepseek.com/v1"
        value={baseUrl}
        {...inputProps}
        onChange={(e) => onBaseUrlChange(e.target.value)}
        onEnter={() => {
          if (!busy) {
            onEnter();
          }
        }}
      />

      <label className={styles.firstRunLabel} htmlFor={ids.protocolId}>
        通信协议
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
        placeholder="粘贴 API 密钥"
        value={apiKey}
        {...inputProps}
        onChange={(e) => onKeyChange(e.target.value)}
        onEnter={() => {
          if (!busy) {
            onEnter();
          }
        }}
      />
    </>
  );
};
