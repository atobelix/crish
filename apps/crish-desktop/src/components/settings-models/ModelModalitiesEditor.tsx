import React, { useCallback } from 'react';
import * as Lucide from 'lucide-react';
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
  text: 'text (文本)',
  image: 'image (图像)',
  audio: 'audio (音频)',
  video: 'video (视频)',
  file: 'file (文件/PDF)',
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
    <div className={styles.mrdSubSection}>
      <div className={styles.mrdSubSectionHeader}>
        <span className={styles.mrdSubSectionTitle}>
          <Lucide.Layers size={13} style={{ color: 'var(--brand, #10b981)' }} />
          多模态支持 (Modalities)
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
          input: [{modalities.input.join(', ')}], output: [
          {modalities.output.join(', ')}]
        </span>
      </div>
      <div className={styles.mrdModalityRows}>
        <div className={styles.mrdModalityRow}>
          <span className={styles.mrdModalityLabel}>输入模态:</span>
          <div className={styles.mrdModalityChips}>
            {ALL_INPUT_MODALITIES.map((mod) => {
              const active = modalities.input.includes(mod);
              return (
                <button
                  key={mod}
                  type="button"
                  className={`${styles.mrdModalityChip} ${
                    active ? styles.mrdModalityChipActive : ''
                  }`}
                  onClick={() => toggleInput(mod)}
                >
                  {active ? <Lucide.Check size={10} /> : null}
                  <span>{MODALITY_LABELS[mod] || mod}</span>
                </button>
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
                <button
                  key={mod}
                  type="button"
                  className={`${styles.mrdModalityChip} ${
                    active ? styles.mrdModalityChipActive : ''
                  }`}
                  onClick={() => toggleOutput(mod)}
                >
                  {active ? <Lucide.Check size={10} /> : null}
                  <span>{MODALITY_LABELS[mod] || mod}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
