import React, { useCallback } from 'react';
import { Button } from '@/components/ui';
import styles from './ModelsSettingsTab.module.css';

export const ALL_INPUT_MODALITIES = [
  'text',
  'image',
  'audio',
  'video',
  'file',
] as const;

export const ALL_OUTPUT_MODALITIES = ['text', 'image', 'audio'] as const;

export const MODALITY_LABELS: Record<string, string> = {
  text: '文本',
  image: '图片',
  audio: '音频',
  video: '视频',
  file: '文档/文件',
};

export interface ModelModalitiesEditorProps {
  modalities: {
    input: string[];
    output: string[];
  };
  onChange: (next: { input: string[]; output: string[] }) => void;
  onSyncCaps?: (capsPatch: { image?: boolean; video?: boolean }) => void;
}

/**
 * 多模态矩阵编辑器（一等公民）：
 * 紧凑直观地勾选/反选输入与输出模态标签，支持 text/image/audio/video/file 等。
 * 保底每项至少选中 1 个模态（禁止置空）。
 */
export const ModelModalitiesEditor: React.FC<ModelModalitiesEditorProps> = ({
  modalities,
  onChange,
  onSyncCaps,
}) => {
  const toggleInput = useCallback(
    (mod: string) => {
      const current = modalities.input || ['text', 'image'];
      const exists = current.includes(mod);
      // 保底每项至少选一个（禁止全部取消）
      if (exists && current.length <= 1) {
        return;
      }
      const nextInputs = exists
        ? current.filter((x) => x !== mod)
        : [...current, mod];

      onChange({
        input: nextInputs,
        output: modalities.output || ['text'],
      });

      if (mod === 'image' || mod === 'video') {
        onSyncCaps?.({
          ...(mod === 'image' ? { image: !exists } : {}),
          ...(mod === 'video' ? { video: !exists } : {}),
        });
      }
    },
    [modalities, onChange, onSyncCaps]
  );

  const toggleOutput = useCallback(
    (mod: string) => {
      const current = modalities.output || ['text'];
      const exists = current.includes(mod);
      // 保底每项至少选一个（禁止全部取消）
      if (exists && current.length <= 1) {
        return;
      }
      const nextOutputs = exists
        ? current.filter((x) => x !== mod)
        : [...current, mod];

      onChange({
        input: modalities.input || ['text', 'image'],
        output: nextOutputs,
      });
    },
    [modalities, onChange]
  );

  return (
    <div className={styles.mrdModalitySection}>
      <label className={styles.mrdFieldLabel}>多模态支持</label>
      <div className={styles.mrdModalityRows}>
        <div className={styles.mrdModalityRow}>
          <span className={styles.mrdModalityLabel}>输入模态:</span>
          <div className={styles.mrdModalityChips}>
            {ALL_INPUT_MODALITIES.map((mod) => {
              const active = modalities.input.includes(mod);
              return (
                <Button
                  bare
                  key={mod}
                  type="button"
                  aria-pressed={active}
                  className={`${styles.mrdModalityChip} ${
                    active ? styles.mrdModalityChipActive : ''
                  }`}
                  onClick={() => toggleInput(mod)}
                >
                  {MODALITY_LABELS[mod] || mod}
                </Button>
              );
            })}
          </div>
        </div>
        <div className={styles.mrdModalityRow}>
          <span className={styles.mrdModalityLabel}>输出模态:</span>
          <div className={styles.mrdModalityChips}>
            {ALL_OUTPUT_MODALITIES.map((mod) => {
              const active = modalities.output.includes(mod);
              return (
                <Button
                  bare
                  key={mod}
                  type="button"
                  aria-pressed={active}
                  className={`${styles.mrdModalityChip} ${
                    active ? styles.mrdModalityChipActive : ''
                  }`}
                  onClick={() => toggleOutput(mod)}
                >
                  {MODALITY_LABELS[mod] || mod}
                </Button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
