import React, { useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './WorkspaceEmptyState.module.css';
import { NotePaperPanel } from '../note-paper/NotePaperPanel';
import {
  W5B_SKELETON_PACKAGE_ID,
  W5B_SKELETON_TRACK,
} from '../note-paper/w5bSkeleton';
import { Button } from '../ui';

/**
 * 工作区空态。
 *
 * **W5-B-S Skeleton**：可选打开笔记纸面预览壳（局部 state，不持久化）。
 * - 入口可点 → 静默假数据壳；**≠** W5-B Strict 真挂载
 * - **挂载 ≠ EL-01/EL-08 关闭**（S5 事故禁令）
 * - **禁止** 无 W1-H 叙事写「打开文档完成」
 */
export function WorkspaceEmptyState({
  wsId,
  onActivate,
}: {
  wsId: string;
  onActivate?: () => void;
}) {
  const [showNotePaper, setShowNotePaper] = useState(false);

  if (showNotePaper) {
    return (
      <div
        className={styles.workspaceEmptyState}
        data-ws-id={wsId}
        data-empty="false"
        data-note-paper-preview="true"
        data-package-id={W5B_SKELETON_PACKAGE_ID}
        data-track={W5B_SKELETON_TRACK}
        data-testid="note-paper-preview-host"
        style={{
          alignItems: 'stretch',
          justifyContent: 'flex-start',
          padding: 'var(--space-3, 12px)',
          textAlign: 'left',
        }}
      >
        <NotePaperPanel
          docId={`preview-${wsId}`}
          blockCount={6}
          title="笔记纸面（W5-B-S 预览壳）"
          onClose={() => setShowNotePaper(false)}
        />
      </div>
    );
  }

  return (
    <div
      className={styles.workspaceEmptyState}
      role="status"
      aria-live="polite"
      data-ws-id={wsId}
      data-empty="true"
      data-package-id={W5B_SKELETON_PACKAGE_ID}
      data-track={W5B_SKELETON_TRACK}
      onPointerDown={onActivate}
    >
      <div className={styles.emptyStateIconWrapper}>
        <Lucide.LayoutPanelLeft size={32} strokeWidth={1.5} aria-hidden />
      </div>
      <div className={styles.emptyStateTitle}>工作区暂无面板</div>
      <div className={styles.emptyStateDesc}>
        从侧栏打开对话，或用标签栏「+」添加文件、终端、预览等面板。
      </div>
      {/* W5-B-S Skeleton：打开 note-paper 预览壳（假数据；非块工作区交付） */}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="open-note-paper-preview"
        data-package-id={W5B_SKELETON_PACKAGE_ID}
        aria-label="打开笔记纸面预览壳（W5-B-S Skeleton）"
        onClick={(e) => {
          e.stopPropagation();
          setShowNotePaper(true);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        icon={<Lucide.NotebookPen size={14} aria-hidden />}
      >
        打开笔记纸面（预览壳）
      </Button>
    </div>
  );
}
