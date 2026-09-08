import React, { useCallback, useMemo } from 'react';
import * as Lucide from 'lucide-react';
import { Button, Input, Switch, Tooltip } from '../ui';
import styles from './ModelsSettingsTab.module.css';

export const STANDARD_THINKING_PRESET: Record<string, string> = {
  Off: 'off',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  Max: 'max',
};

export interface ModelThinkingEditorProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  thinkingMap: Record<string, string>;
  onChange: (nextMap: Record<string, string>) => void;
}

/**
 * 拍平的思考强度配置编辑器：
 * - 简单开关控制思考能力开启/关闭
 * - 纯英文 TitleCase 显示名与底层 Wire 值映射表（如 Low -> low, Medium -> medium, High -> high）
 * - 支持动态增删行与一键恢复预填推荐
 */
export const ModelThinkingEditor: React.FC<ModelThinkingEditorProps> = ({
  enabled,
  onEnabledChange,
  thinkingMap,
  onChange,
}) => {
  const currentMap = useMemo(() => {
    return thinkingMap && Object.keys(thinkingMap).length > 0
      ? thinkingMap
      : STANDARD_THINKING_PRESET;
  }, [thinkingMap]);

  const rows = useMemo(() => {
    return Object.entries(currentMap);
  }, [currentMap]);

  const handleUpdateKey = useCallback(
    (oldKey: string, newKey: string) => {
      const cur = { ...currentMap };
      const val = cur[oldKey] ?? '';
      delete cur[oldKey];
      cur[newKey] = val;
      onChange(cur);
    },
    [currentMap, onChange]
  );

  const handleUpdateValue = useCallback(
    (key: string, newVal: string) => {
      const cur = { ...currentMap };
      cur[key] = newVal;
      onChange(cur);
    },
    [currentMap, onChange]
  );

  const handleDeleteRow = useCallback(
    (key: string) => {
      const cur = { ...currentMap };
      delete cur[key];
      onChange(cur);
    },
    [currentMap, onChange]
  );

  const handleAddRow = useCallback(() => {
    const cur = { ...currentMap };
    let newKey = 'Custom';
    let idx = 1;
    while (newKey in cur) {
      newKey = `Custom${idx++}`;
    }
    cur[newKey] = newKey.toLowerCase();
    onChange(cur);
  }, [currentMap, onChange]);

  const handleResetPresets = useCallback(() => {
    onChange({ ...STANDARD_THINKING_PRESET });
  }, [onChange]);

  return (
    <div className={styles.mrdSubSection}>
      <div className={styles.mrdSubSectionHeader}>
        <span className={styles.mrdSubSectionTitle}>
          <Lucide.BrainCircuit
            size={13}
            style={{ color: 'var(--brand, #10b981)' }}
          />
          思考推理 (Thinking / Reasoning)
        </span>
        <Switch
          size="sm"
          checked={enabled}
          label={enabled ? '已开启' : '已关闭'}
          onCheckedChange={onEnabledChange}
        />
      </div>

      {enabled && (
        <div className={styles.mrdThinkingTable}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 28px',
              gap: '6px',
              fontSize: '11px',
              color: 'var(--text-tertiary)',
              paddingBottom: '2px',
            }}
          >
            <span>UI 显示名 (TitleCase)</span>
            <span>Wire 参数值</span>
            <span />
          </div>
          {rows.map(([lbl, val]) => (
            <div key={lbl} className={styles.mrdThinkingRow}>
              <Input
                size="sm"
                value={lbl}
                placeholder="如 Low / High"
                onChange={(e) => handleUpdateKey(lbl, e.target.value)}
              />
              <Input
                size="sm"
                value={val}
                placeholder="如 low / high"
                onChange={(e) => handleUpdateValue(lbl, e.target.value)}
              />
              <Tooltip content="删除档位">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDeleteRow(lbl)}
                  style={{
                    padding: '0',
                    height: '26px',
                    color: 'var(--text-tertiary)',
                  }}
                  icon={<Lucide.Trash2 size={12} />}
                />
              </Tooltip>
            </div>
          ))}
          <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleAddRow}
              style={{ fontSize: '11px', height: '22px' }}
              icon={<Lucide.Plus size={11} />}
            >
              添加档位
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleResetPresets}
              style={{
                fontSize: '11px',
                height: '22px',
                color: 'var(--text-secondary)',
              }}
            >
              重置推荐档位
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
