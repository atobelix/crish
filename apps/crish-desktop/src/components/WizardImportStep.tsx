/**
 * 向导第 2 步：导入外部对话（可选）。
 * 纯编排：提示 + ExternalSessionImport（wizard 变体）。
 * 不持有状态，跳过由壳层「继续」按钮完成。
 */
import React from 'react';
import styles from './overlay/FirstRunWizard.module.css';
import { ExternalSessionImport } from './settings/ExternalSessionImport';

export const WizardImportStep: React.FC = () => {
  return (
    <>
      <p className={styles.firstRunHint} style={{ marginTop: 0 }}>
        可从本机 Claude Code 或 Codex 导入历史对话。也可跳过，稍后在设置 · 账户中导入。
      </p>
      <ExternalSessionImport variant="wizard" />
    </>
  );
};
