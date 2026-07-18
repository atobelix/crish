import * as Lucide from 'lucide-react';
import styles from './WorkspaceEmptyState.module.css';

export function WorkspaceEmptyState({
  wsId,
  onActivate,
}: {
  wsId: string;
  onActivate?: () => void;
}) {
  return (
    <div
      className={styles.workspaceEmptyState}
      role="status"
      aria-live="polite"
      data-ws-id={wsId}
      data-empty="true"
      onPointerDown={onActivate}
    >
      <div className={styles.emptyStateIconWrapper}>
        <Lucide.LayoutPanelLeft
          size={32}
          strokeWidth={1.5}
          aria-hidden
        />
      </div>
      <div className={styles.emptyStateTitle}>
        工作区暂无面板
      </div>
      <div className={styles.emptyStateDesc}>
        从侧栏打开对话，或用标签栏「+」添加文件、终端、预览等面板。
      </div>
    </div>
  );
}
