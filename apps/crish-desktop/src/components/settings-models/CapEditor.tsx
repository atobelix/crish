import React from 'react';
import {
  MODEL_CAPABILITY_OPTIONS,
  type ModelCapabilityKey,
} from '../../api/modelCatalog';
import { Switch } from '../ui';

/**
 * cap 开关组（能力矩阵开关）。
 * 两处消费：手动添加表单（CapEditor 语义）与展开配置面板（CapabilityEditor 语义）——
 * 结构同构，合一组件复用（03-detail T9 拆分登记：CapabilityEditor 由 CapEditor 承担）。
 * T11 ui/Switch 基座合入后已重写为 <Switch>（私有 pill 结构随替换消亡）。
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
          <Switch
            key={opt.key}
            size="sm"
            checked={on}
            disabled={disabled}
            label={opt.label}
            onCheckedChange={(checked) => onCapChange(opt.key, checked)}
          />
        );
      })}
    </>
  );
};
