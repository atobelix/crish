import React from 'react';
import { Button } from '../ui';
import { CapEditor } from './CapEditor';
import type { AddDraft } from './useModelProfilesState';
import styles from './ModelsSettingsTab.module.css';

/** 手动添加模型表单（模型 ID / 展示名称 / 上下文长度 + cap 开关组） */
export const ManualAddForm: React.FC<{
  addDraft: AddDraft;
  setAddDraft: React.Dispatch<React.SetStateAction<AddDraft>>;
  handleManualAdd: () => void;
  setManualOpen: (val: boolean) => void;
}> = ({ addDraft, setAddDraft, handleManualAdd, setManualOpen }) => {
  return (
    <div className={`${styles.mrdAddForm} mrd-add-form`}>
      <div className={`${styles.mrdAddFormFields} mrd-add-form-fields`}>
        <label className={`${styles.mrdAddLabel} mrd-add-label`}>
          <span>模型 ID *</span>
          <input
            className={`${styles.mrdFieldInput} mrd-field-input`}
            placeholder="如 deepseek-v4-flash"
            value={addDraft.modelId}
            onChange={(e) =>
              setAddDraft((d) => ({ ...d, modelId: e.target.value }))
            }
            spellCheck={false}
          />
        </label>
        <label className={`${styles.mrdAddLabel} mrd-add-label`}>
          <span>展示名称</span>
          <input
            className={`${styles.mrdFieldInput} mrd-field-input`}
            placeholder="可选"
            value={addDraft.displayName}
            onChange={(e) =>
              setAddDraft((d) => ({
                ...d,
                displayName: e.target.value,
              }))
            }
          />
        </label>
        <label className={`${styles.mrdAddLabel} mrd-add-label`}>
          <span>上下文长度</span>
          <input
            className={`${styles.mrdFieldInput} mrd-field-input`}
            placeholder="128000"
            value={addDraft.contextLength}
            onChange={(e) =>
              setAddDraft((d) => ({
                ...d,
                contextLength: e.target.value,
              }))
            }
          />
        </label>
      </div>
      <div className={`${styles.mrdAddFormFooter} mrd-add-form-footer`}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <CapEditor
            caps={addDraft.caps}
            onCapChange={(key, checked) =>
              setAddDraft((d) => ({
                ...d,
                caps: { ...d.caps, [key]: checked },
              }))
            }
          />
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setManualOpen(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!addDraft.modelId.trim()}
            onClick={handleManualAdd}
          >
            添加
          </Button>
        </div>
      </div>
    </div>
  );
};
