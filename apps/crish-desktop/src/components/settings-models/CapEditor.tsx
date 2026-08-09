import React from 'react';
import {
  MODEL_CAPABILITY_OPTIONS,
  type ModelCapabilityKey,
} from '../../api/modelCatalog';
import styles from './ModelsSettingsTab.module.css';

/**
 * cap 开关组（能力矩阵 pills）。
 * 两处消费：手动添加表单（CapEditor 语义）与展开配置面板（CapabilityEditor 语义）——
 * 结构同构，合一组件复用（03-detail T9 拆分登记：CapabilityEditor 由 CapEditor 承担）。
 * 注：T11 ui/Switch 基座合入后，此处结构重写为 <Switch>（当前保持 checkbox-pill 原状）。
 */
export const CapEditor: React.FC<{
  caps: Record<ModelCapabilityKey, boolean>;
  onCapChange: (key: ModelCapabilityKey, checked: boolean) => void;
  disabled?: boolean;
}> = ({ caps, onCapChange, disabled }) => {
  return (
    <>
      {MODEL_CAPABILITY_OPTIONS.map((opt) => {
        const on = !!caps[opt.key];
        return (
          <label
            key={opt.key}
            className={`${styles.mrdCapPill} mrd-cap-pill ${on ? styles.isOn + ' is-on' : ''}`}
          >
            <input
              type="checkbox"
              style={{ display: 'none' }}
              checked={on}
              disabled={disabled}
              onChange={(e) => onCapChange(opt.key, e.target.checked)}
            />
            {opt.label}
          </label>
        );
      })}
    </>
  );
};
