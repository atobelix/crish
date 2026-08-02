/**
 * 向导第 1 步：启用模型。
 * 列表选择（SettingsSelect）+ 手填输入（可拆分模型），空 catalog 走纯输入。
 * 提示文案由 firstRunWizardLib 计算（页内 hint，不 toast）。
 */
import React from 'react';
import styles from './overlay/FirstRunWizard.module.css';
import { SettingsSelect } from './settings/SettingsSelect';
import { wizardEmptyModelCatalogHint } from './firstRunWizardLib';

/** 本步用到的可访问 id（useId 生成，壳层透传） */
export type WizardModelStepIds = {
  modelIdField: string;
  modelCustomId: string;
};

export type WizardModelStepProps = {
  ids: WizardModelStepIds;
  modelId: string;
  listedModels: string[];
  /** 空 catalog 时 hint 的 hasProfile 入参 */
  hasProfile: boolean;
  busy: boolean;
  /** 壳层 role=alert 文案（仅用于 aria-invalid / aria-describedby） */
  error: string;
  describedBy?: string;
  onChange: (v: string) => void;
  onEnter: () => void;
};

export const WizardModelStep: React.FC<WizardModelStepProps> = ({
  ids,
  modelId,
  listedModels,
  hasProfile,
  busy,
  error,
  describedBy,
  onChange,
  onEnter,
}) => {
  const hasListedModels = listedModels.length > 0;
  const modelInList = hasListedModels && listedModels.includes(modelId);
  const inputProps = {
    disabled: busy,
    spellCheck: false,
    autoComplete: 'off',
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
  } as const;

  return (
    <>
      <label className={styles.firstRunLabel} htmlFor={ids.modelIdField}>
        模型 id
      </label>
      {hasListedModels ? (
        <>
          <SettingsSelect
            {...(styles.firstRunSelect !== undefined && { className: styles.firstRunSelect })}
            value={modelInList ? modelId : ''}
            disabled={busy}
            placeholder="从本机列表选择…"
            options={[
              { value: '', label: '从本机列表选择…' },
              ...listedModels.map((m) => ({ value: m, label: m })),
            ]}
            onChange={(v) => {
              onChange(v);
            }}
          />
          <label className={styles.firstRunLabel} htmlFor={ids.modelCustomId}>
            或手填模型 id
          </label>
          <input
            id={ids.modelCustomId}
            className={styles.firstRunInput}
            placeholder="例如 deepseek-chat、gpt-4o"
            value={modelInList ? '' : modelId}
            {...inputProps}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) {
                e.preventDefault();
                onEnter();
              }
            }}
          />
        </>
      ) : (
        <input
          id={ids.modelIdField}
          className={styles.firstRunInput}
          placeholder="输入模型 id（如 deepseek-chat）"
          value={modelId}
          {...inputProps}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) {
              e.preventDefault();
              onEnter();
            }
          }}
        />
      )}
      <p className={styles.firstRunHint} role="status">
        {hasListedModels
          ? '选用本机已有 id，或手填供应商文档中的 model id；也可跳过，在主界面底栏手填。'
          : wizardEmptyModelCatalogHint(hasProfile)}
      </p>
    </>
  );
};
