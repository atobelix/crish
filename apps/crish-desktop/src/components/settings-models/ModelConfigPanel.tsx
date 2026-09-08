import React, { useCallback, useMemo } from 'react';
import * as Lucide from 'lucide-react';
import type { ModelMeta } from '../../api/modelCatalog';
import { Button, Input } from '../ui';
import { CapEditor } from './CapEditor';
import { ModelModalitiesEditor } from './ModelModalitiesEditor';
import {
  ModelThinkingEditor,
  STANDARD_THINKING_PRESET,
} from './ModelThinkingEditor';
import { ModelPricingEditor } from './ModelPricingEditor';
import type { CfgDraft } from './useModelProfilesState';
import { findAutofillModel } from '../../services/modelsAutofillBaseline';
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
  meta: _meta,
  tKey: _tKey,
  testBusy: _testBusy,
  runTest: _runTest,
  closeConfig,
  saveConfig,
}) => {
  // 智能预填基准参数动作
  const handleAutofill = useCallback(() => {
    const baseline = findAutofillModel(m);
    if (!baseline) return;

    setCfgDraft((prev) => {
      if (!prev) return null;
      const nextModalities = baseline.modalities || {
        input: ['text', 'image'],
        output: ['text'],
      };
      const thinkingEnabled = Boolean(
        baseline.thinking && Object.keys(baseline.thinking).length > 0
      );
      const thinkingMap = baseline.thinking || STANDARD_THINKING_PRESET;

      const pricing = baseline.pricing
        ? {
            currency: baseline.pricing.currency || 'USD',
            input:
              baseline.pricing.input !== undefined
                ? String(baseline.pricing.input)
                : '',
            output:
              baseline.pricing.output !== undefined
                ? String(baseline.pricing.output)
                : '',
            cacheRead:
              baseline.pricing.cacheRead !== undefined
                ? String(baseline.pricing.cacheRead)
                : '',
            cacheWrite:
              baseline.pricing.cacheWrite !== undefined
                ? String(baseline.pricing.cacheWrite)
                : '',
          }
        : prev.pricing;

      return {
        ...prev,
        displayName: baseline.displayName || prev.displayName || m,
        contextLength: baseline.contextWindow
          ? String(baseline.contextWindow)
          : prev.contextLength,
        maxOutputTokens: baseline.maxOutputTokens
          ? String(baseline.maxOutputTokens)
          : prev.maxOutputTokens,
        modalities: nextModalities,
        thinkingEnabled,
        thinkingMap,
        pricing,
        caps: {
          ...prev.caps,
          image: nextModalities.input.includes('image'),
          video: nextModalities.input.includes('video'),
          reasoning: thinkingEnabled,
        },
      };
    });
  }, [m, setCfgDraft]);

  // 多模态列表安全保底
  const modalities = useMemo(() => {
    return (
      cfgDraft.modalities || {
        input: ['text', 'image'],
        output: ['text'],
      }
    );
  }, [cfgDraft.modalities]);

  const pricing = useMemo(() => {
    return (
      cfgDraft.pricing || {
        currency: 'USD' as const,
        input: '',
        output: '',
        cacheRead: '',
        cacheWrite: '',
      }
    );
  }, [cfgDraft.pricing]);

  return (
    <div
      className={`${styles.modelConfigPanel} mrd-model-cfg`}
      onClick={(e) => e.stopPropagation()}
    >
      {/* ── 1. 基础配置：展示别名 + 智能预填 / 上下文长度 / 最大输出 Token ── */}
      <div className={`${styles.mrdCfgFields} mrd-cfg-fields`}>
        <label className={`${styles.mrdCfgLabel} mrd-cfg-label`}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>展示名称</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleAutofill}
              style={{
                height: '20px',
                padding: '0 6px',
                fontSize: '11px',
                color: 'var(--brand, hsl(160 84% 39%))',
              }}
              icon={<Lucide.Sparkles size={11} />}
            >
              智能预填
            </Button>
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
          <span>上下文长度 (Tokens)</span>
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
          <span>最大输出 Token</span>
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

      {/* ── 4. 四维选填价格 (双币切换与优雅静默) ── */}
      <ModelPricingEditor
        pricing={pricing}
        onChange={(p) =>
          setCfgDraft((d) => (d ? { ...d, pricing: p } : null))
        }
      />

      {/* ── 5. 底部操作栏：能力开关与保存 (绝对首屏可见，无需滚动) ── */}
      <div className={`${styles.mrdCfgFooter} mrd-cfg-footer`}>
        <div className={`${styles.mrdCapGroup} mrd-cap-group`}>
          <CapEditor
            caps={cfgDraft.caps}
            onCapChange={(key, checked) =>
              setCfgDraft((d) => {
                if (!d) return null;
                const nextCaps = { ...d.caps, [key]: checked };
                const currentInputs = d.modalities?.input || ['text'];
                let nextInputs = [...currentInputs];
                if (key === 'image') {
                  const has = nextInputs.includes('image');
                  if (checked && !has) nextInputs.push('image');
                  else if (!checked && has) nextInputs = nextInputs.filter((x) => x !== 'image');
                } else if (key === 'video') {
                  const has = nextInputs.includes('video');
                  if (checked && !has) nextInputs.push('video');
                  else if (!checked && has) nextInputs = nextInputs.filter((x) => x !== 'video');
                }
                return {
                  ...d,
                  caps: nextCaps,
                  modalities: {
                    input: nextInputs,
                    output: d.modalities?.output || ['text'],
                  },
                  ...(key === 'reasoning'
                    ? {
                        thinkingEnabled: checked,
                        thinkingMap: checked
                          ? d.thinkingMap && Object.keys(d.thinkingMap).length > 0
                            ? d.thinkingMap
                            : STANDARD_THINKING_PRESET
                          : d.thinkingMap,
                      }
                    : {}),
                };
              })
            }
          />
        </div>
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
