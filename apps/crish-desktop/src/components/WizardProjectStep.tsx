/**
 * 向导第 3 步：选择项目（可选）。
 * 已有项目展示状态；否则「选择文件夹」+ 手填路径。
 * 目录选择副作用（Rust 原生 picker 授权 + addProjectFromPath）由 useFirstRunWizard 提供。
 */
import React from 'react';

import styles from './overlay/FirstRunWizard.module.css';
import { Button, Input } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';

/** 本步用到的可访问 id（useId 生成，壳层透传） */
export type WizardProjectStepIds = {
  pathId: string;
};

export type WizardProjectStepProps = {
  ids: WizardProjectStepIds;
  hasProject: boolean;
  /** 已激活项目名或工作区路径（展示用） */
  currentProjectLabel: string;
  pathDraft: string;
  busy: boolean;
  /** 壳层 role=alert 文案（仅用于 aria-invalid / aria-describedby） */
  error: string;
  describedBy?: string;
  onPathChange: (v: string) => void;
  onPickFolder: () => void;
  onEnter: () => void;
};

export const WizardProjectStep: React.FC<WizardProjectStepProps> = ({
  ids,
  hasProject,
  currentProjectLabel,
  pathDraft,
  busy,
  error,
  describedBy,
  onPathChange,
  onPickFolder,
  onEnter,
}) => {
  return (
    <>
      {hasProject ? (
        <div className={styles.firstRunProjectOk} role="status">
          <AppIcon name="folder-check" size={16} aria-hidden="true" />
          <span>当前工作目录：{currentProjectLabel}</span>
        </div>
      ) : (
        <>
          <Button
            type="button"
            variant="secondary"
            size="md"
            block
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => {
              void onPickFolder();
            }}
            icon={<AppIcon name="folder-input" size={16} aria-hidden="true" />}
          >
            选择文件夹
          </Button>
          <label className={styles.firstRunLabel} htmlFor={ids.pathId}>
            或输入路径
          </label>
          <Input
            bare
            id={ids.pathId}
            className={styles.firstRunInput}
            placeholder="例如 C:/workspace/crish"
            value={pathDraft}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(e) => onPathChange(e.target.value)}
            onEnter={() => {
              if (!busy) {
                onEnter();
              }
            }}
          />
        </>
      )}
    </>
  );
};
