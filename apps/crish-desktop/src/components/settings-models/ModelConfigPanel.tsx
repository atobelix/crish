import React from 'react';
import * as Lucide from 'lucide-react';
import type { ModelMeta } from '../../api/modelCatalog';
import {
  thinkingLevelOptionsFor,
  resolveCatalogEfforts,
} from '../../api/thinkingGear';
import { Button, Select, Tooltip, Input } from '../ui';
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
  const thinkingOptions = React.useMemo(() => {
    const catalogOpts = thinkingLevelOptionsFor(resolveCatalogEfforts(m));
    const standards = [
      { value: 'default', label: '默认 (系统自适应)' },
      { value: 'high', label: '高 (深度思考)' },
      { value: 'medium', label: '中等思考' },
      { value: 'low', label: '轻量思考' },
      { value: 'minimal', label: '微弱思考' },
      { value: 'xhigh', label: '超高思考' },
      { value: 'max', label: '极限思考' },
    ];
    // 合并标准选项与目录推导选项，去重
    const merged = [...standards];
    for (const opt of catalogOpts) {
      if (!merged.some((x) => x.value === opt.value)) {
        merged.push({ value: opt.value, label: opt.label });
      }
    }
    if (
      cfgDraft.thinkingLevel &&
      !merged.some((x) => x.value === cfgDraft.thinkingLevel)
    ) {
      merged.push({
        value: cfgDraft.thinkingLevel,
        label: cfgDraft.thinkingLevel,
      });
    }
    return merged;
  }, [m, cfgDraft.thinkingLevel]);

  const protocolOptions = React.useMemo(() => [
    { id: 'inherit', value: '', label: '跟随服务商默认协议' },
    { id: 'openai/chat', value: 'openai/chat', label: 'OpenAI Chat (/v1/chat/completions)' },
    { id: 'openai/responses', value: 'openai/responses', label: 'OpenAI Responses (/responses)' },
    { id: 'anthropic/messages', value: 'anthropic/messages', label: 'Anthropic Messages (/v1/messages)' },
  ], []);

  return (
    <div
      className={`${styles.modelConfigPanel} mrd-model-cfg`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={`${styles.mrdCfgFields} mrd-cfg-fields`}>
        <label className={`${styles.mrdCfgLabel} mrd-cfg-label`}>
          <span>展示名称</span>
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
        <div className={`${styles.mrdCfgLabel} mrd-cfg-label`}>
          <span>思考强度</span>
          <Select
            size="sm"
            value={cfgDraft.thinkingLevel || 'default'}
            onChange={(val) =>
              setCfgDraft((d) => (d ? { ...d, thinkingLevel: val } : null))
            }
            options={thinkingOptions.map((opt) => ({
              id: opt.value,
              value: opt.value,
              label: opt.label,
            }))}
          />
        </div>
        <div className={`${styles.mrdCfgLabel} mrd-cfg-label`}>
          <span>调用协议</span>
          <Select
            size="sm"
            value={cfgDraft.protocol || ''}
            onChange={(val) =>
              setCfgDraft((d) =>
                d
                  ? {
                      ...d,
                      protocol:
                        (val as 'openai/chat' | 'openai/responses' | 'anthropic/messages') ||
                        undefined,
                    }
                  : null
              )
            }
            options={protocolOptions}
          />
        </div>
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
            variant="secondary"
            size="sm"
            onClick={saveConfig}
            style={{
              background: 'var(--brand, #10b981)',
              color: '#fff',
              border: 'none',
            }}
          >
            保存
          </Button>
        </div>
      </div>
    </div>
  );
};
