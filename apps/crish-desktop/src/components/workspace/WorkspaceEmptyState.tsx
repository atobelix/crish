import React, { useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './WorkspaceEmptyState.module.css';
import { NotePaperPanel } from '../note-paper/NotePaperPanel';
import { NotePaperStrictPanel } from '../note-paper/NotePaperStrictPanel';
import {
  createProductStrictHydrateTransport,
  type NoteHydrateTransport,
} from '../note-paper/hydrateProjection';
import {
  W5B_SKELETON_PACKAGE_ID,
  W5B_SKELETON_TRACK,
} from '../note-paper/w5bSkeleton';
import {
  W5B_PRODUCT_DEFAULT_EMPTY_TRACK,
  W5B_STRICT_PACKAGE_ID,
  W5B_STRICT_TRACK,
} from '../note-paper/w5bStrict';
import { Button } from '../ui';

/** 空态可打开的笔记纸面轨（双轨并存） */
export type NotePaperEmptyOpenMode = 'strict' | 'skeleton';

export type WorkspaceEmptyStateProps = {
  wsId: string;
  onActivate?: () => void;
  /**
   * 空态默认倾向轨（主 CTA）。
   * - 默认 `strict`（`W5B_PRODUCT_DEFAULT_EMPTY_TRACK`）：产品演示路径
   * - `skeleton`：主 CTA 突出预览壳（旧主路径；测/回退）
   * **两轨入口均保留**；本 prop 只影响主次与默认高亮，不删 Skeleton。
   *
   * 诚实：Strict 默认 hydrate 见 `createProductStrictHydrateTransport`
   * （可检测 Tauri → tauri-ipc；无 Tauri → fixture）；**可演示 ≠ EL**；
   * **≠ 打开完成**；**DocSession 全链若未满须诚实**。
   */
  preferredNotePaperTrack?: NotePaperEmptyOpenMode;
  /**
   * 可选注入 Strict hydrate 通路（测 / mock / 自定义）。
   * 未注入时使用 `createProductStrictHydrateTransport`：
   * 可检测 Tauri → `tauri-ipc`；无 Tauri → fixture 演示（**≠ 生产权威**）。
   */
  strictHydrateTransport?: NoteHydrateTransport;
};

/**
 * 工作区空态。
 *
 * ## 产品默认（W5-B 产品入口）
 * - 默认倾向 **Strict**：可点打开 `NotePaperStrictPanel` +
 *   `createProductStrictHydrateTransport`（Tauri→tauri-ipc / 无 Tauri→fixture）
 * - **W5-B-S Skeleton** 预览壳入口 **保留**（`open-note-paper-preview`）
 *
 * ## 诚实边界（08 §0.2 / 20 L3–L4 · R10）
 * - **可演示 ≠ EL-01 / EL-08 关闭**
 * - **≠ 打开完成**；后端 hydrate 现为 query 投影派生，**DocSession 全链未满**
 * - **fixture ≠ 生产权威**；无 Tauri 回退 fixture **不是** 伪装 tauri-ipc
 * - 有 Tauri 时失败/空/成功走真 IPC 三态，**不**静默回退 fixture
 * - 挂载冒充交付 = S5；禁止去 `-S` 冒充 Strict
 */
export function WorkspaceEmptyState({
  wsId,
  onActivate,
  preferredNotePaperTrack = W5B_PRODUCT_DEFAULT_EMPTY_TRACK,
  strictHydrateTransport,
}: WorkspaceEmptyStateProps) {
  const [openMode, setOpenMode] = useState<NotePaperEmptyOpenMode | null>(null);

  const strictDocId = `strict-${wsId}`;
  const skeletonDocId = `preview-${wsId}`;

  const resolvedStrictTransport = useMemo(
    () =>
      strictHydrateTransport ??
      createProductStrictHydrateTransport(strictDocId),
    [strictHydrateTransport, strictDocId]
  );

  if (openMode === 'strict') {
    return (
      <div
        className={styles.workspaceEmptyState}
        data-ws-id={wsId}
        data-empty="false"
        data-note-paper-strict="true"
        data-package-id={W5B_STRICT_PACKAGE_ID}
        data-track={W5B_STRICT_TRACK}
        data-testid="note-paper-strict-host"
        style={{
          alignItems: 'stretch',
          justifyContent: 'flex-start',
          padding: 'var(--space-3, 12px)',
          textAlign: 'left',
        }}
      >
        <NotePaperStrictPanel
          docId={strictDocId}
          hydrateTransport={resolvedStrictTransport}
          title="笔记纸面（W5-B Strict · 空态演示）"
          onClose={() => setOpenMode(null)}
        />
      </div>
    );
  }

  if (openMode === 'skeleton') {
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
          docId={skeletonDocId}
          blockCount={6}
          title="笔记纸面（W5-B-S 预览壳）"
          onClose={() => setOpenMode(null)}
        />
      </div>
    );
  }

  const strictIsPrimary = preferredNotePaperTrack === 'strict';

  const strictOpenButton = (
    <Button
      type="button"
      variant={strictIsPrimary ? 'primary' : 'secondary'}
      size="sm"
      data-testid="open-note-paper-strict"
      data-package-id={W5B_STRICT_PACKAGE_ID}
      data-track={W5B_STRICT_TRACK}
      aria-label="打开笔记纸面 Strict（W5-B · hydrate 演示；可演示≠EL；≠打开完成）"
      onClick={(e) => {
        e.stopPropagation();
        setOpenMode('strict');
      }}
      onPointerDown={(e) => e.stopPropagation()}
      icon={<Lucide.FileText size={14} aria-hidden />}
    >
      打开笔记纸面（Strict）
    </Button>
  );

  const skeletonOpenButton = (
    <Button
      type="button"
      variant={strictIsPrimary ? 'secondary' : 'primary'}
      size="sm"
      data-testid="open-note-paper-preview"
      data-package-id={W5B_SKELETON_PACKAGE_ID}
      data-track={W5B_SKELETON_TRACK}
      aria-label="打开笔记纸面预览壳（W5-B-S Skeleton）"
      onClick={(e) => {
        e.stopPropagation();
        setOpenMode('skeleton');
      }}
      onPointerDown={(e) => e.stopPropagation()}
      icon={<Lucide.NotebookPen size={14} aria-hidden />}
    >
      打开笔记纸面（预览壳）
    </Button>
  );

  return (
    <div
      className={styles.workspaceEmptyState}
      role="status"
      aria-live="polite"
      data-ws-id={wsId}
      data-empty="true"
      data-preferred-note-paper-track={preferredNotePaperTrack}
      data-product-default-track={W5B_PRODUCT_DEFAULT_EMPTY_TRACK}
      onPointerDown={onActivate}
    >
      <div className={styles.emptyStateIconWrapper}>
        <Lucide.LayoutPanelLeft size={32} strokeWidth={1.5} aria-hidden />
      </div>
      <div className={styles.emptyStateTitle}>工作区暂无面板</div>
      <div className={styles.emptyStateDesc}>
        从侧栏打开对话，或用标签栏「+」添加文件、终端、预览等面板。
      </div>
      {/*
        产品默认 Strict（W5-B）+ Skeleton 预览壳（W5-B-S）双入口。
        可演示 ≠ EL；≠ 打开完成；fixture ≠ 生产权威；DocSession 全链未满。
      */}
      <div
        className={styles.emptyStateActions}
        data-testid="note-paper-empty-actions"
      >
        {strictIsPrimary ? (
          <>
            {strictOpenButton}
            {skeletonOpenButton}
          </>
        ) : (
          <>
            {skeletonOpenButton}
            {strictOpenButton}
          </>
        )}
      </div>
    </div>
  );
}
