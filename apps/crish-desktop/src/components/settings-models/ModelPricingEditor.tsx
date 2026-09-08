import React from 'react';
import * as Lucide from 'lucide-react';
import { Input } from '../ui';
import styles from './ModelsSettingsTab.module.css';

export interface ModelPricingDraft {
  currency: 'USD' | 'CNY';
  input?: string;
  output?: string;
  cacheRead?: string;
  cacheWrite?: string;
}

export interface ModelPricingEditorProps {
  pricing: ModelPricingDraft;
  onChange: (next: ModelPricingDraft) => void;
}

/**
 * 四维选填价格编辑器（优雅静默与双币支持）：
 * - CNY (¥) 与 USD ($) 双币切换
 * - input, output, cacheRead (独立绝对单价，绝非固定一折), cacheWrite 四项
 * - 100% 选填，留空保存为 undefined，界面零视觉污染
 */
export const ModelPricingEditor: React.FC<ModelPricingEditorProps> = ({
  pricing,
  onChange,
}) => {
  const current = pricing || {
    currency: 'USD',
    input: '',
    output: '',
    cacheRead: '',
    cacheWrite: '',
  };

  const setField = (field: keyof ModelPricingDraft, val: string) => {
    onChange({
      ...current,
      [field]: val,
    });
  };

  const setCurrency = (curr: 'USD' | 'CNY') => {
    onChange({
      ...current,
      currency: curr,
    });
  };

  return (
    <div className={styles.mrdSubSection}>
      <div className={styles.mrdSubSectionHeader}>
        <span className={styles.mrdSubSectionTitle}>
          <Lucide.CircleDollarSign
            size={13}
            style={{ color: 'var(--brand, #10b981)' }}
          />
          四维计费 (选填 · 留空优雅静默)
        </span>
        <div className={styles.mrdCurrencyToggle}>
          <button
            type="button"
            className={`${styles.mrdCurrencyBtn} ${
              current.currency === 'CNY' ? styles.mrdCurrencyBtnActive : ''
            }`}
            onClick={() => setCurrency('CNY')}
          >
            ¥ CNY
          </button>
          <button
            type="button"
            className={`${styles.mrdCurrencyBtn} ${
              current.currency === 'USD' ? styles.mrdCurrencyBtnActive : ''
            }`}
            onClick={() => setCurrency('USD')}
          >
            $ USD
          </button>
        </div>
      </div>
      <div className={styles.mrdPricingGrid}>
        <label className={`${styles.mrdCfgLabel} mrd-cfg-label`}>
          <span>普通输入 / 1M</span>
          <Input
            size="sm"
            value={current.input || ''}
            placeholder="选填"
            onChange={(e) => setField('input', e.target.value)}
          />
        </label>
        <label className={`${styles.mrdCfgLabel} mrd-cfg-label`}>
          <span>生成输出 / 1M</span>
          <Input
            size="sm"
            value={current.output || ''}
            placeholder="选填"
            onChange={(e) => setField('output', e.target.value)}
          />
        </label>
        <label className={`${styles.mrdCfgLabel} mrd-cfg-label`}>
          <span>缓存读取 / 1M (绝对单价)</span>
          <Input
            size="sm"
            value={current.cacheRead || ''}
            placeholder="选填"
            onChange={(e) => setField('cacheRead', e.target.value)}
          />
        </label>
        <label className={`${styles.mrdCfgLabel} mrd-cfg-label`}>
          <span>缓存写入 / 1M</span>
          <Input
            size="sm"
            value={current.cacheWrite || ''}
            placeholder="选填"
            onChange={(e) => setField('cacheWrite', e.target.value)}
          />
        </label>
      </div>
    </div>
  );
};
