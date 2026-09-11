import React from 'react';

import { Button, Tooltip, Input } from '../ui';
import type { AddDraft } from './useModelProfilesState';
import styles from './ModelsSettingsTab.module.css';
import { AppIcon } from '../ui/icons/index';

/** 模型列表头部：连通性检查 / 自动获取 / 搜索 / 手动添加 */
export const ModelListHeader: React.FC<{
  checkBusy: boolean;
  scanBusy: boolean;
  runCheck: () => Promise<void>;
  runScan: () => Promise<void>;
  modelFilter: string;
  setModelFilter: (val: string) => void;
  manualOpen: boolean;
  setManualOpen: (val: boolean) => void;
  setAddDraft: React.Dispatch<React.SetStateAction<AddDraft>>;
  emptyAddDraft: () => AddDraft;
}> = ({
  checkBusy,
  scanBusy,
  runCheck,
  runScan,
  modelFilter,
  setModelFilter,
  manualOpen,
  setManualOpen,
  setAddDraft,
  emptyAddDraft,
}) => {
  return (
    <div className={`${styles.mrdModelsHead} mrd-models-head`}>
      <span className={`${styles.mrdModelsLabel} mrd-models-label`}>
        模型列表
      </span>
      <div className={`${styles.mrdModelsActions} mrd-models-actions`}>
        <Tooltip content="检查服务商连通性">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={checkBusy}
            onClick={() => void runCheck()}
            style={{
              height: '28px',
              width: '28px',
              padding: '0',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            aria-label="检查连通性"
            icon={
              checkBusy ? (
                <AppIcon name="loader" size={13}
                  className={styles.loadingSpinner} />
              ) : (
                <AppIcon name="wifi" size={13} />
              )
            }
          />
        </Tooltip>
        <Tooltip content="自动获取服务商模型列表">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={scanBusy}
            onClick={() => void runScan()}
            style={{
              height: '28px',
              width: '28px',
              padding: '0',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            aria-label="自动获取"
            icon={
              scanBusy ? (
                <AppIcon name="loader" size={13}
                  className={styles.loadingSpinner} />
              ) : (
                <AppIcon name="refresh" size={13} />
              )
            }
          />
        </Tooltip>
        <Input
          variant="search"
          size="xs"
          placeholder="搜索模型…"
          value={modelFilter}
          onChange={(e) => setModelFilter(e.target.value)}
          clearable
          onClear={() => setModelFilter('')}
          style={{ width: '150px' }}
        />
        <Tooltip content="手动添加模型">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setManualOpen(!manualOpen);
              setAddDraft(emptyAddDraft());
            }}
            style={{
              height: '28px',
              width: '28px',
              padding: '0',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            aria-label="添加模型"
            icon={<AppIcon name="plus" size={13} />}
          />
        </Tooltip>
      </div>
    </div>
  );
};
