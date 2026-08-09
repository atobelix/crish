import React from 'react';
import { Button } from '../ui';
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
        <input
          className={`${styles.mrdFieldInput} mrd-field-input`}
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
          <input
            className={`${styles.mrdFieldInput} mrd-field-input`}
            type="password"
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
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!keyDraft.trim()}
            onClick={() => void saveKey()}
            style={{
              borderRadius: '7px',
              height: '34px',
              padding: '0 14px',
              flexShrink: 0,
            }}
          >
            保存
          </Button>
        </div>
      </div>
    </div>
  );
};
