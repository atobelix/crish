import React from 'react';
import * as Lucide from 'lucide-react';
import type { ModelMeta } from '../../api/modelCatalog';
import { Button, Tooltip } from '../ui';
import { CapEditor } from './CapEditor';
import type { CfgDraft } from './useModelProfilesState';
import styles from './ModelsSettingsTab.module.css';

/** 模型行展开配置子面板：展示名称 / 上下文长度 / 能力矩阵 / 测试与保存 */
export const ModelConfigPanel: React.FC<{
  modelId: string;
  cfgDraft: CfgDraft;
  setCfgDraft: React.Dispatch<React.SetStateAction<CfgDraft | null>>;
  meta: ModelMeta;
  tKey: string;
  testBusy: string | null;
  runTest: (model: string) => Promise<void>;
  closeConfig: () => void;
  saveConfig: () => void;
}> = ({
  modelId: m,
  cfgDraft,
  setCfgDraft,
  meta,
  tKey,
  testBusy,
  runTest,
  closeConfig,
  saveConfig,
}) => {
  return (
    <div
      className={`${styles.modelConfigPanel} mrd-model-cfg`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={`${styles.mrdCfgFields} mrd-cfg-fields`}>
        <label
          className={`${styles.mrdCfgLabel} mrd-cfg-label`}
        >
          <span>展示名称</span>
          <input
            className={`${styles.mrdFieldInput} mrd-field-input`}
            value={cfgDraft.displayName}
            placeholder={m}
            onChange={(e) =>
              setCfgDraft((d) =>
                d ? { ...d, displayName: e.target.value } : null
              )
            }
          />
        </label>
        <label
          className={`${styles.mrdCfgLabel} mrd-cfg-label`}
        >
          <span>上下文长度</span>
          <input
            className={`${styles.mrdFieldInput} mrd-field-input`}
            value={cfgDraft.contextLength}
            placeholder="如 1000000"
            onChange={(e) =>
              setCfgDraft((d) =>
                d
                  ? { ...d, contextLength: e.target.value }
                  : null
              )
            }
          />
        </label>
      </div>
      <div className={`${styles.mrdCfgFooter} mrd-cfg-footer`}>
        <div className={`${styles.mrdCapGroup} mrd-cap-group`}>
          <CapEditor
            caps={cfgDraft.caps}
            onCapChange={(key, checked) =>
              setCfgDraft((d) =>
                d
                  ? {
                      ...d,
                      caps: {
                        ...d.caps,
                        [key]: checked,
                      },
                    }
                  : null
              )
            }
          />
        </div>
        <div
          className={`${styles.mrdCfgActions} mrd-cfg-actions`}
        >
          {meta.lastTest && (
            <span
              style={{
                fontSize: '11px',
                fontWeight: 500,
                marginRight: '6px',
                userSelect: 'none',
                color: !meta.lastTest.ok
                  ? 'var(--accent-red)'
                  : (meta.lastTest.latencyMs || 0) < 400
                    ? 'var(--accent-green)'
                    : (meta.lastTest.latencyMs || 0) < 1200
                      ? 'var(--accent-orange)'
                      : 'var(--accent-red)',
              }}
              title={
                meta.lastTest.error ||
                (meta.lastTest.ok ? '测试成功' : '测试失败')
              }
            >
              {meta.lastTest.ok
                ? `${meta.lastTest.latencyMs}ms`
                : meta.lastTest.error?.includes('超时') ||
                    meta.lastTest.error?.includes('timeout')
                  ? '超时'
                  : '失败'}
            </span>
          )}
          <Tooltip content="测试连通性">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={testBusy === tKey}
              onClick={() => void runTest(m)}
              icon={
                testBusy === tKey ? (
                  <Lucide.Loader2
                    size={13}
                    className={styles.loadingSpinner}
                  />
                ) : (
                  <Lucide.Wifi size={13} />
                )
              }
            />
          </Tooltip>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={closeConfig}
          >
            收起
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={saveConfig}
          >
            保存
          </Button>
        </div>
      </div>
    </div>
  );
};
