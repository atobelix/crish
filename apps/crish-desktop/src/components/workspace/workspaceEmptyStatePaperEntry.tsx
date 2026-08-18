/**
 * WorkspaceEmptyState · paper 夹具宿主 UI（SD-30 / 04 §12.4）
 *
 * 写锥 hook / `buildPaperWriteConeDataAttrs` 实现已迁
 * `extensions/note-paper/paperWriteCone`；本文件 **只** re-export hook，
 * 不是第二份写锥实现。剩下的是 EmptyState 夹具打开后的宿主 UI。
 *
 * `WorkspaceEmptyStateStrictHost` / `WorkspaceEmptyStateSkeletonHost`
 * = 夹具打开后的 UI（点 CTA 后的壳），**不是**产品入口。
 * 产品叶走 `NoteLeafHost`，不经本宿主。
 *
 * Skeleton 入口 **保留**（禁止去 `-S`）。
 * `enableProductPaperList` **默认仍由装配壳钉 false**。
 * 夹具壳从扩展家消费同一份实现；本壳不是产品入口。
 *
 * ≠ 打开完成；≠ 关 EL；≠ 去 `-S`
 * ≠ EL-01；≠ EL-04；≠ EL-08；≠ W3-P 满窗
 */

import React, { useMemo } from 'react';
import { NotePaperStrictPanel } from '../note-paper/NotePaperStrictPanel';
import { createProductStrictHydrateTransport } from '../note-paper/hydrateProjection';
import {
  W5B_STRICT_PACKAGE_ID,
  W5B_STRICT_TRACK,
} from '../note-paper/notePaperStrictTrack';
import {
  buildPaperWriteConeDataAttrs,
  type WorkspaceEmptyStatePaperBindings,
} from '../../extensions/note-paper/paperWriteCone';
import type { WorkspaceEmptyStateMirrorSlot } from '../../extensions/note-paper/mirrorSlot';
import styles from './WorkspaceEmptyState.module.css';

export {
  buildPaperWriteConeDataAttrs,
  useWorkspaceEmptyStatePaperBindings,
  type UseWorkspaceEmptyStatePaperBindingsInput,
  type WorkspaceEmptyStatePaperBindings,
} from '../../extensions/note-paper/paperWriteCone';

/** CONN-C2 / EL / 打开完成诚实锚（禁止假关 / 宣称 W3-P 满窗） */
export const EMPTY_STATE_PAPER_HONESTY_ATTRS = {
  'data-el01': 'not-claimed',
  'data-el04': 'not-claimed',
  'data-el08': 'not-claimed',
  'data-open-complete': 'not-claimed',
  'data-w3p-full': 'not-claimed',
} as const;

const OPENED_PAPER_HOST_STYLE: React.CSSProperties = {
  alignItems: 'stretch',
  justifyContent: 'flex-start',
  padding: 'var(--space-3, 12px)',
  textAlign: 'left',
};

export type WorkspaceEmptyStateStrictHostProps = {
  wsId: string;
  strictDocId: string;
  /** LR-H1 绑定钉（装配壳解析后传入） */
  strictDocBindingAttrs?: Record<string, string>;
  paper: WorkspaceEmptyStatePaperBindings;
  mirror: WorkspaceEmptyStateMirrorSlot;
  mirrorUnpushedOpCount: number;
  onClose: () => void;
};

/** 夹具打开后的 Strict 纸面宿主 UI（W5-B）。≠ 产品入口；产品叶走 NoteLeafHost。≠ 打开完成；≠ 关 EL */
export function WorkspaceEmptyStateStrictHost({
  wsId,
  strictDocId,
  strictDocBindingAttrs,
  paper,
  mirror,
  mirrorUnpushedOpCount,
  onClose,
}: WorkspaceEmptyStateStrictHostProps) {
  return (
    <div
      className={styles.workspaceEmptyState}
      data-ws-id={wsId}
      data-empty="false"
      data-note-paper-strict="true"
      data-package-id={W5B_STRICT_PACKAGE_ID}
      data-track={W5B_STRICT_TRACK}
      {...buildPaperWriteConeDataAttrs(
        paper.slashBinding,
        paper.mdPrefixBinding,
        true
      )}
      {...mirror.dataAttrs}
      data-product-paper-list={paper.productPaperListAttr}
      {...EMPTY_STATE_PAPER_HONESTY_ATTRS}
      {...(strictDocBindingAttrs ?? {})}
      data-testid="note-paper-strict-host"
      style={OPENED_PAPER_HOST_STYLE}
    >
      <NotePaperStrictPanel
        docId={strictDocId}
        hydrateTransport={paper.resolvedStrictTransport}
        slashIntentSink={paper.slashBinding.sink}
        slashWriteMode={paper.slashBinding.mode}
        slashSinkSource={paper.slashBinding.source}
        turnIntoSink={paper.mdPrefixBinding.sink}
        mdPrefixWriteMode={paper.mdPrefixBinding.mode}
        mdPrefixSinkSource={paper.mdPrefixBinding.source}
        paperList={paper.paperListProp}
        title="笔记纸面（W5-B Strict · 空态演示）"
        onClose={onClose}
        mirrorDriftReport={mirror.effectiveMirrorReport}
        mirrorWatchSource={mirror.resolvedWatchSource}
        mirrorUnpushedOpCount={mirrorUnpushedOpCount}
        showMirrorDriftBar={mirror.panelShowMirrorDriftBar}
        onMirrorThreeWay={mirror.resolvedOnMirrorThreeWay}
      />
    </div>
  );
}

export type WorkspaceEmptyStateSkeletonHostProps = {
  wsId: string;
  skeletonDocId: string;
  onClose: () => void;
};

/** 夹具打开后的 Skeleton 预览壳宿主 UI（W5-B-S）。≠ 产品入口；禁止去 `-S`。≠ 打开完成；≠ 关 EL */
export function WorkspaceEmptyStateSkeletonHost({
  wsId,
  skeletonDocId,
  onClose,
}: WorkspaceEmptyStateSkeletonHostProps) {
  const transport = useMemo(
    () => createProductStrictHydrateTransport(skeletonDocId),
    [skeletonDocId]
  );
  return (
    <div
      className={styles.workspaceEmptyState}
      data-ws-id={wsId}
      data-empty="false"
      data-note-paper-preview="true"
      data-package-id={W5B_STRICT_PACKAGE_ID}
      data-track={W5B_STRICT_TRACK}
      data-testid="note-paper-preview-host"
      style={OPENED_PAPER_HOST_STYLE}
    >
      <NotePaperStrictPanel
        docId={skeletonDocId}
        hydrateTransport={transport}
        title="笔记纸面"
        onClose={onClose}
      />
    </div>
  );
}
