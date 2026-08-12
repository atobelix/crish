/**
 * WorkspaceEmptyState · 空态 actions（SD-30）
 *
 * 双轨 CTA：Strict 主入口 + W5-B-S Skeleton 预览壳入口。
 * **两轨均保留**；禁止去 `-S` 冒充 Strict。
 *
 * ≠ EL；≠ 打开完成；fixture ≠ 生产权威
 */

import React from 'react';
import * as Lucide from 'lucide-react';
import {
  W5B_SKELETON_PACKAGE_ID,
  W5B_SKELETON_TRACK,
} from '../note-paper/w5bSkeleton';
import {
  W5B_STRICT_PACKAGE_ID,
  W5B_STRICT_TRACK,
} from '../note-paper/w5bStrict';
import { Button } from '../ui';
import styles from './WorkspaceEmptyState.module.css';

export type WorkspaceEmptyStateActionsProps = {
  preferredNotePaperTrack: 'strict' | 'skeleton';
  onOpenStrict: () => void;
  onOpenSkeleton: () => void;
};

/** 空态双轨打开按钮（主次随 preferredNotePaperTrack） */
export function WorkspaceEmptyStateActions({
  preferredNotePaperTrack,
  onOpenStrict,
  onOpenSkeleton,
}: WorkspaceEmptyStateActionsProps) {
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
        onOpenStrict();
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
        onOpenSkeleton();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      icon={<Lucide.NotebookPen size={14} aria-hidden />}
    >
      打开笔记纸面（预览壳）
    </Button>
  );

  return (
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
  );
}

export type WorkspaceEmptyStateLandingProps = WorkspaceEmptyStateActionsProps;

/**
 * 空态落地内层：图标 / 文案 / 双轨 actions。
 * 根节点 data-* 仍由装配壳钉（含默认关会计）。
 */
export function WorkspaceEmptyStateLanding(
  props: WorkspaceEmptyStateLandingProps
) {
  return (
    <>
      <div className={styles.emptyStateIconWrapper}>
        <Lucide.LayoutPanelLeft size={32} strokeWidth={1.5} aria-hidden />
      </div>
      <div className={styles.emptyStateTitle}>工作区暂无面板</div>
      <div className={styles.emptyStateDesc}>
        从侧栏打开对话，或用标签栏「+」添加文件、终端、预览等面板。
      </div>
      {/*
        产品默认 Strict（W5-B）+ Skeleton 预览壳（W5-B-S）双入口。
        可演示 ≠ EL；≠ 打开完成；fixture ≠ 生产权威；
        后端默认 hydrate_path=doc-session 仍 ≠ EL-01/04/08（CONN-A1）。
        CONN-B/B3：无 apply/IPC 默认 slash 只读；Tauri note_apply_ops 或注入后可写。
        CONN-D2：无 apply 默认 mdPrefix disabled；注入后 provisional turn_into 可写。
        CONN-E2：mirror 条默认关；showMirrorDriftBar / mirrorDriftReport opt-in；
          无 report 不造假；≠ EL-03 / ≠ inotify 满关 / X-05 不回退。
        CONN-E3：detect 调度默认关；enableMirrorDetectSchedule + mirrorIpc
          → detectMirrorDrift → report → StatusBar；关时无 timer。
        CONN-C2：PaperList 默认关（data-product-paper-list=0 / data-paper-list=0）；
          enableProductPaperList opt-in → paper-list 互斥 content-row；
          ≠ EL-01；≠ W3-P 满窗；禁默认真双内容。
        禁止 mock 生产默认；桌面接线 ≠ 打开完成 / ≠ A-BLK-08/09 e2e / ≠ EL-01。
      */}
      <WorkspaceEmptyStateActions {...props} />
    </>
  );
}
