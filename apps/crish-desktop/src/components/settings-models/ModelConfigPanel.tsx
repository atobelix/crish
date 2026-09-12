import React, { useMemo } from 'react';
import { Button, Input } from '../ui';
import { ModelModalitiesEditor } from './ModelModalitiesEditor';
import {
  ModelThinkingEditor,
  STANDARD_THINKING_PRESET,
} from './ModelThinkingEditor';
import type { CfgDraft } from './useModelProfilesState';
import styles from './ModelsSettingsTab.module.css';

/**
 * 模型行展开配置子面板（人体工学瘦身与多模态重构）：
 * - 物理剔除协议选择器（跟随服务商总协议）
 * - modalities 多模态配置一等公民（input: text/image/audio/video/file; output: text/image/audio）
 * - 拍平的纯英文 TitleCase -> Wire 值思考映射表与开关
 * - 四维选填价格（CNY/USD 双币切换，留空优雅静默）
 */
export const ModelConfigPanel: React.FC<{
  modelId: string;
  cfgDraft: CfgDraft;
  setCfgDraft: React.Dispatch<React.SetStateAction<CfgDraft | null>>;
  closeConfig: () => void;
  saveConfig: () => void;
}> = ({
  modelId: m,
  cfgDraft,
  setCfgDraft,
  closeConfig,
  saveConfig,
}) => {
  // 多模态列表安全保底
  const modalities = useMemo(() => {
    return (
      cfgDraft.modalities || {
        input: ['text', 'image'],
        output: ['text'],
      }
    );
  }, [cfgDraft.modalities]);

  return (
    <div
      className={`${styles.modelConfigPanel} mrd-model-cfg`}
      onClick={(e) => e.stopPropagation()}
    >
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
            value={cfgDraft.contextLength}
            placeholder="如 128000"
            onChange={(e) =>
              setCfgDraft((d) =>
                d ? { ...d, contextLength: e.target.value } : null
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

      {/* ── 2. 多模态矩阵 (Modalities - 一等公民) ── */}
      <ModelModalitiesEditor
        modalities={modalities}
        onChange={(next) =>
          setCfgDraft((d) => (d ? { ...d, modalities: next } : null))
        }
        onSyncCaps={(capsPatch) =>
          setCfgDraft((d) =>
            d ? { ...d, caps: { ...d.caps, ...capsPatch } } : null
          )
        }
      />

      {/* ── 3. 拍平思考强度配置 (TitleCase -> Wire 参数映射表，非思考模型彻底隐藏) ── */}
      {cfgDraft.thinkingEnabled && (
        <ModelThinkingEditor
          enabled={cfgDraft.thinkingEnabled}
          onEnabledChange={(en) =>
            setCfgDraft((d) =>
              d
                ? {
                    ...d,
                    thinkingEnabled: en,
                    caps: { ...d.caps, reasoning: en },
                  }
                : null
            )
          }
          thinkingMap={cfgDraft.thinkingMap || STANDARD_THINKING_PRESET}
          onChange={(map) =>
            setCfgDraft((d) => (d ? { ...d, thinkingMap: map } : null))
          }
        />
      )}

      {/* ── 4. 四维计费：用户裁决 #3 移出抽屉（在用量配置单价里配置）。
           草稿仍保留既有定价（openConfigFor 从 spec 灌入），保存不改写；改价走 YAML 编辑器/用量页。 ── */}

      {/* ── 5. 底部操作栏：保存 (能力矩阵由模态编辑器统一管理，用户裁决 #2) ── */}
      <div className={`${styles.mrdCfgFooter} mrd-cfg-footer`}>
<div className={`${styles.mrdCfgActions} mrd-cfg-actions`}>
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
            variant="primary"
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
