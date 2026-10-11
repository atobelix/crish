import React, { useCallback, useMemo } from 'react';
import { Button, Input, Tooltip } from '../ui';
import styles from './ModelsSettingsTab.module.css';
import { AppIcon } from '../ui/icons/index';

export const STANDARD_THINKING_PRESET: Record<string, string> = {
  Off: 'off',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  Max: 'max',
};

export interface ModelThinkingEditorProps {
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  thinkingMap: Record<string, string>;
  onChange: (nextMap: Record<string, string>) => void;
  /** 外层已经画出「思考推理」标题时关掉，避免重复 */
  showLabel?: boolean;
}

/**
 * 拍平的思考强度配置编辑器：
 * - 纯英文 TitleCase 显示名与底层 Wire 值映射表（如 Low -> low, Medium -> medium, High -> high）
 * - 思考能力由外层能力矩阵单源控制，内部呈现纯粹档位映射表
 * - 支持动态增删行与一键恢复预填推荐
 */
export const ModelThinkingEditor: React.FC<ModelThinkingEditorProps> = ({
  enabled = true,
  onEnabledChange: _onEnabledChange,
  thinkingMap,
  onChange,
  showLabel = true,
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
      {showLabel ? (
        <label className={styles.mrdFieldLabel}>思考推理</label>
      ) : null}

      {enabled && (
        <div className={styles.mrdThinkingTable}>
          <div className={styles.mrdThinkingHeader}>
            <span>界面档位名称</span>
            <span>API参数值</span>
            <div className={styles.mrdThinkingHeaderActions}>
              <Tooltip content="添加档位">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={handleAddRow}
                  className={styles.mrdThinkingMiniBtn}
                  icon={<AppIcon name="plus" size={12} />}
                  aria-label="添加档位"
                />
              </Tooltip>
              <Tooltip content="重置推荐档位">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={handleResetPresets}
                  className={styles.mrdThinkingMiniBtn}
                  icon={<AppIcon name="rotate-ccw" size={12} />}
                  aria-label="重置推荐档位"
                />
              </Tooltip>
            </div>
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
              <div className={styles.mrdThinkingHeaderActions}>
                <Tooltip content="删除档位">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="删除档位"
                    onClick={() => handleDeleteRow(lbl)}
                    className={styles.mrdThinkingDeleteBtn}
                    icon={<AppIcon name="trash" size={12} />}
                  />
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
