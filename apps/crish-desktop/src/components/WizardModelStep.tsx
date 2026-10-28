/**
 * 向导第 1 步：启用模型。
 * 直接复用设置页 `ManualAddForm`（无硬编码旧模型标签，支持在线获取模型列表、
 * 自动预填展示名/上下文长度/最大输出/多模态支持/思考档位），避免另起门户。
 */
import React from 'react';
import styles from './overlay/FirstRunWizard.module.css';
import { Switch } from '@/components/ui';
import { ManualAddForm } from './settings-models/ManualAddForm';
import type { AddDraft } from './settings-models/useModelProfilesState';

export type WizardModelStepProps = {
  addDraft: AddDraft;
  setAddDraft: React.Dispatch<React.SetStateAction<AddDraft>>;
  isDefaultModel?: boolean;
  onDefaultChange?: (v: boolean) => void;
  runScan?: () => Promise<void>;
  scanBusy?: boolean;
  providerVendor?: string;
  scannedModels?: string[];
  existingModels?: string[];
  busy: boolean;
  onEnter: () => void;
};

export const WizardModelStep: React.FC<WizardModelStepProps> = ({
  addDraft,
  setAddDraft,
  isDefaultModel = true,
  onDefaultChange,
  runScan,
  scanBusy = false,
  providerVendor,
  scannedModels = [],
  existingModels = [],
  busy,
  onEnter,
}) => {
  return (
    <>
      <ManualAddForm
        plain
        showActions={false}
        addDraft={addDraft}
        setAddDraft={setAddDraft}
        handleManualAdd={() => {
          if (!busy) {
            onEnter();
          }
        }}
        setManualOpen={() => {}}
        {...(runScan !== undefined ? { runScan } : {})}
        scanBusy={scanBusy}
        {...(providerVendor !== undefined ? { providerVendor } : {})}
        scannedModels={scannedModels}
        existingModels={existingModels}
      />

      <div className={styles.firstRunToggleRow}>
        <label
          className={styles.firstRunToggleLabel}
          htmlFor="wizard-default-model-switch"
        >
          设为默认模型
        </label>
        <Switch
          id="wizard-default-model-switch"
          checked={isDefaultModel}
          disabled={busy}
          onCheckedChange={(next) => onDefaultChange?.(next)}
        />
      </div>
    </>
  );
};
