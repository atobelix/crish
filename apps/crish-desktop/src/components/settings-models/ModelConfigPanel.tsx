import React, { useMemo } from 'react';
import { Input } from '../ui';
import { findAutofillModel } from '../../services/modelsAutofillBaseline';
import { ModelModalitiesEditor } from './ModelModalitiesEditor';
import { ModelThinkingSection } from './ModelThinkingSection';
import type { CfgDraft } from './useModelProfilesState';
import styles from './ModelsSettingsTab.module.css';

function officialThinkingSeed(
  modelId: string,
  providerId: string | undefined
): Record<string, string> | undefined {
  const vendor = providerId?.startsWith('custom-') ? undefined : providerId;
  const spec = findAutofillModel(modelId, vendor);
  const thinking = spec?.thinking;
  if (!thinking) return undefined;
  const seed: Record<string, string> = {};
  for (const [key, wire] of Object.entries(thinking)) {
    if (typeof wire === 'string' && wire.trim()) seed[key] = wire;
  }
  return Object.keys(seed).length > 0 ? seed : undefined;
}

/**
 * 模型配置表单本体，由弹窗承载。
 * 协议跟随服务商，不在这里再选。
 * 思考档位与手动添加共用同一开关：没声明过也能补上。
 */
export const ModelConfigPanel: React.FC<{
  modelId: string;
  providerId?: string;
  cfgDraft: CfgDraft;
  setCfgDraft: React.Dispatch<React.SetStateAction<CfgDraft | null>>;
}> = ({ modelId: m, providerId, cfgDraft, setCfgDraft }) => {
  const modalities = useMemo(() => {
    return (
      cfgDraft.modalities || {
        input: ['text'],
        output: ['text'],
      }
    );
  }, [cfgDraft.modalities]);

  const seedMap = useMemo(
    () => officialThinkingSeed(m, providerId),
    [m, providerId]
  );

  return (
    <div className={styles.modelDialogFields}>
      {/* ── 1. 基础配置：展示名称 / 上下文长度 / 最大输出 Token ── */}
      <div className={`${styles.mrdCfgFields} mrd-cfg-fields`}>
        <label className={`${styles.mrdCfgLabel} mrd-cfg-label`}>
          <div className={styles.mrdCfgLabelHeader}>
            <span>展示名称</span>
          </div>
          <Input
            size="sm"
            value={cfgDraft.displayName}
            placeholder={m}
            onChange={(e) =>
              setCfgDraft((d) =>
                d ? { ...d, displayName: e.target.value } : null
              )
            }
          />
        </label>
        <label className={`${styles.mrdCfgLabel} mrd-cfg-label`}>
          <span>上下文长度</span>
          <Input
            size="sm"
            value={cfgDraft.contextWindow}
            placeholder="如 128000"
            onChange={(e) =>
              setCfgDraft((d) =>
                d ? { ...d, contextWindow: e.target.value } : null
              )
            }
          />
        </label>
        <label className={`${styles.mrdCfgLabel} mrd-cfg-label`}>
          <span>最大输出</span>
          <Input
            size="sm"
            value={cfgDraft.maxOutputTokens || ''}
            placeholder="如 4096 / 8192"
            onChange={(e) =>
              setCfgDraft((d) =>
                d ? { ...d, maxOutputTokens: e.target.value } : null
              )
            }
          />
        </label>
      </div>

      {/* ── 2. 多模态矩阵 (Modalities - 一等公民，能力唯一真源) ── */}
      <ModelModalitiesEditor
        modalities={modalities}
        onChange={(next) =>
          setCfgDraft((d) => (d ? { ...d, modalities: next } : null))
        }
      />

      <ModelThinkingSection
        enabled={cfgDraft.thinkingEnabled === true}
        thinkingMap={cfgDraft.thinkingMap}
        seedMap={seedMap}
        onChange={({ enabled, thinkingMap }) =>
          setCfgDraft((d) =>
            d ? { ...d, thinkingEnabled: enabled, thinkingMap } : null
          )
        }
      />
    </div>
  );
};
