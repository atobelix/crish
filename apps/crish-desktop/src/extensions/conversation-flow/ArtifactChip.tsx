/**
 * 已生成文档胶囊。代码路径不走本组件（仍 onOpenPath）。
 * 不做 S7 Notebook 编辑核。
 */
import type { ReactElement } from 'react';
import styles from './narrative.module.css';

export interface ArtifactChipProps {
  label: string;
  path?: string;
  onOpenPath?: (filePath: string) => void;
}

export function ArtifactChip({
  label,
  path,
  onOpenPath,
}: ArtifactChipProps): ReactElement {
  const text = label.trim() || '文档';
  return (
    <button
      type="button"
      className={styles.chip}
      data-flow-artifact="document"
      data-artifact-path={path || undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (path && onOpenPath) onOpenPath(path);
      }}
    >
      已生成 · {text}
    </button>
  );
}
