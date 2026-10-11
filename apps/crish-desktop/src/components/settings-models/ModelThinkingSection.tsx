import React from 'react';
import { Button } from '../ui';
import { AppIcon } from '../ui/icons/index';
import {
  ModelThinkingEditor,
  STANDARD_THINKING_PRESET,
} from './ModelThinkingEditor';
import styles from './ModelsSettingsTab.module.css';

export interface ModelThinkingSectionProps {
  enabled: boolean;
  thinkingMap?: Record<string, string>;
  /** 当前没有档位表时，开启思考用这份预填；缺省用标准档 */
  seedMap?: Record<string, string>;
  onChange: (next: {
    enabled: boolean;
    thinkingMap?: Record<string, string>;
  }) => void;
}

function nonempty(
  map: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!map || Object.keys(map).length === 0) return undefined;
  return map;
}

/**
 * 思考档位的唯一开关。
 * 已有模型和手动添加共用：没声明思考时给出入口，声明之后编辑档位表，也可以关掉。
 */
export const ModelThinkingSection: React.FC<ModelThinkingSectionProps> = ({
  enabled,
  thinkingMap,
  seedMap,
  onChange,
}) => {
  const activeMap =
    nonempty(thinkingMap) ?? nonempty(seedMap) ?? STANDARD_THINKING_PRESET;

  if (!enabled) {
    return (
      <div className={styles.modelThinkingOffRow}>
        <span className={styles.mrdFieldLabel}>思考推理</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() =>
            onChange({
              enabled: true,
              thinkingMap: { ...activeMap },
            })
          }
          icon={<AppIcon name="plus" size={11} />}
        >
          配置思考档位
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.modelThinkingBlock}>
      <div className={styles.modelThinkingHead}>
        <span className={styles.mrdFieldLabel}>思考推理</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => onChange({ enabled: false, thinkingMap })}
        >
          关闭思考
        </Button>
      </div>
      <ModelThinkingEditor
        enabled
        showLabel={false}
        thinkingMap={activeMap}
        onChange={(map) => onChange({ enabled: true, thinkingMap: map })}
      />
    </div>
  );
};
