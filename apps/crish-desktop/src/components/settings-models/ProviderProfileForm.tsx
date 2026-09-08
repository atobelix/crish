import React from 'react';
import { Button, Input, Select } from '../ui';
import {
  saveProfileBaseUrl,
  upsertProfile,
  type ProviderProfile,
} from '../../api/providerProfiles';
import styles from './ModelsSettingsTab.module.css';

/** 凭据区：Base URL 与 API Key（provider profile 表单） */
export const ProviderProfileForm: React.FC<{
  selected: ProviderProfile;
  hasKeySelected: boolean;
  keyDraft: string;
  setKeyDraft: (val: string) => void;
  saveKey: () => Promise<void>;
  notify: (ok: boolean, text: string) => void;
  refresh: () => void;
}> = ({
  selected,
  hasKeySelected,
  keyDraft,
  setKeyDraft,
  saveKey,
  notify,
  refresh,
}) => {
  return (
    <div className={`${styles.mrdFields} mrd-fields`}>
      <div className={`${styles.mrdField} mrd-field`}>
        <label className={`${styles.mrdFieldLabel} mrd-field-label`}>
          Base URL
        </label>
        <Input
          size="sm"
          value={selected.baseUrl}
          placeholder="https://api.example.com/v1"
          spellCheck={false}
          onChange={(e) => {
            upsertProfile({ ...selected, baseUrl: e.target.value });
            refresh();
          }}
          onBlur={() => {
            if (!selected) return;
            void saveProfileBaseUrl(selected.id, selected.baseUrl).then(
              (r) => {
                if (!r.ok)
                  notify(
                    false,
                    `地址保存失败：${r.error || '未知错误'}`
                  );
                refresh();
              }
            );
          }}
        />
      </div>
      <div className={`${styles.mrdField} mrd-field`}>
        <label className={`${styles.mrdFieldLabel} mrd-field-label`}>
          API Key
        </label>
        <div className={`${styles.mrdKeyRow} mrd-key-row`}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Input
              variant="password"
              size="sm"
              placeholder={
                hasKeySelected ? '••••••••••••••••••••' : '粘贴 API Key'
              }
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && keyDraft.trim()) {
                  e.preventDefault();
                  void saveKey();
                }
              }}
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!keyDraft.trim()}
            onClick={() => void saveKey()}
            style={{ flexShrink: 0 }}
          >
            保存
          </Button>
        </div>
      </div>
      <div className={`${styles.mrdField} mrd-field`}>
        <label className={`${styles.mrdFieldLabel} mrd-field-label`}>
          <span>首要通信协议 (Default Protocol)</span>
          <span
            style={{
              fontSize: '11px',
              color: 'var(--text-tertiary)',
              marginLeft: '8px',
              fontWeight: 'normal',
            }}
          >
            (该服务商下属模型默认继承此协议)
          </span>
        </label>
        <Select
          size="sm"
          value={selected.protocol || 'openai/chat'}
          onChange={(val) => {
            upsertProfile({
              ...selected,
              protocol:
                (val as 'openai/chat' | 'openai/responses' | 'anthropic/messages') ||
                undefined,
            });
            refresh();
          }}
          options={[
            {
              id: 'openai/chat',
              value: 'openai/chat',
              label: 'OpenAI Chat (/v1/chat/completions)',
            },
            {
              id: 'openai/responses',
              value: 'openai/responses',
              label: 'OpenAI Responses (/responses)',
            },
            {
              id: 'anthropic/messages',
              value: 'anthropic/messages',
              label: 'Anthropic Messages (/v1/messages)',
            },
          ]}
        />
      </div>
    </div>
  );
};
