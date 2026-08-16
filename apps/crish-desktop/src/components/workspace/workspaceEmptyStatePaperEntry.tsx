/**
 * WorkspaceEmptyState · paper 入口（SD-30）
 *
 * 从空态装配壳抽出：
 * - CONN-B / B3 / D2 写锥绑定（apply / slash / mdPrefix）
 * - CONN-C2 PaperList 产品入口解析（默认关）
 * - 已开 Strict / Skeleton 宿主
 *
 * Skeleton 入口 **保留**（禁止去 `-S`）。
 * `enableProductPaperList` **默认仍由装配壳钉 false**。
 *
 * LR-H1：宿主可传入已解析 persist docId；本文件不合成死 id。
 *
 * ≠ EL-01；≠ EL-04；≠ EL-08；≠ W3-P 满窗；≠ 打开完成；≠ 去 `-S`
 */

import React, { useMemo } from 'react';
import type {
  ApplyOpsAdapter,
  IntentSink,
  TurnIntoSink,
} from '@crish/block-paper';
import type { NoteApplyOpsIpc } from '../../api/noteApplyOpsIpc';
import { resolveProductStrictApplyOps } from '../../api/noteApplyOpsIpc';
import { NotePaperPanel } from '../note-paper/NotePaperPanel';
import { NotePaperStrictPanel } from '../note-paper/NotePaperStrictPanel';
import {
  createProductStrictHydrateTransport,
  type NoteHydrateTransport,
} from '../note-paper/hydrateProjection';
import {
  createProductMdPrefixBinding,
  type ProductMdPrefixBinding,
} from '../note-paper/noteMdPrefixBridge';
import {
  createProductStrictSlashBinding,
  type CreateProductStrictSlashBindingOptions,
  type ProductStrictSlashBinding,
} from '../note-paper/productSlashSink';
import {
  W5B_SKELETON_PACKAGE_ID,
  W5B_SKELETON_TRACK,
} from '../note-paper/notePaperSkeletonTrack';
import {
  W5B_STRICT_PACKAGE_ID,
  W5B_STRICT_TRACK,
} from '../note-paper/notePaperStrictTrack';
import type { WorkspaceEmptyStateMirrorSlot } from './workspaceEmptyStateMirrorSlot';
import styles from './WorkspaceEmptyState.module.css';

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

export type UseWorkspaceEmptyStatePaperBindingsInput = {
  strictDocId: string;
  strictHydrateTransport?: NoteHydrateTransport;
  strictApplyOps?: ApplyOpsAdapter;
  strictApplyOpsIpc?: NoteApplyOpsIpc;
  slashIntentSink?: IntentSink;
  turnIntoSink?: TurnIntoSink;
  strictSlashWireOptions?: Omit<
    CreateProductStrictSlashBindingOptions,
    'applyOps' | 'slashIntentSink' | 'sourceLabel'
  >;
  /** 须由装配壳默认 false 后再传入 */
  enableProductPaperList: boolean;
};

export type WorkspaceEmptyStatePaperBindings = {
  resolvedStrictTransport: NoteHydrateTransport;
  slashBinding: ProductStrictSlashBinding;
  mdPrefixBinding: ProductMdPrefixBinding;
  productPaperListAttr: '0' | '1';
  paperListProp: true | undefined;
};

/**
 * 空态 paper 写锥 + C2 入口解析。
 * PaperList 仅 `enableProductPaperList === true` 才传 `paperList`。
 */
export function useWorkspaceEmptyStatePaperBindings(
  input: UseWorkspaceEmptyStatePaperBindingsInput
): WorkspaceEmptyStatePaperBindings {
  const {
    strictDocId,
    strictHydrateTransport,
    strictApplyOps,
    strictApplyOpsIpc,
    slashIntentSink,
    turnIntoSink: turnIntoSinkProp,
    strictSlashWireOptions,
    enableProductPaperList,
  } = input;

  const resolvedStrictTransport = useMemo(
    () =>
      strictHydrateTransport ??
      createProductStrictHydrateTransport(strictDocId),
    [strictHydrateTransport, strictDocId]
  );

  /**
   * CONN-B3：产品默认 apply 写锥解析。
   * - 显式 applyOps → injected
   * - 显式 applyOpsIpc / Tauri → product-ipc
   * - 无 → none（只读；禁止静默 mock）
   */
  const applyResolution = useMemo(
    () =>
      resolveProductStrictApplyOps({
        docId: strictDocId,
        ...(strictApplyOps !== undefined ? { applyOps: strictApplyOps } : {}),
        ...(strictApplyOpsIpc !== undefined
          ? { applyOpsIpc: strictApplyOpsIpc }
          : {}),
      }),
    [strictDocId, strictApplyOps, strictApplyOpsIpc]
  );

  /**
   * CONN-B：产品默认 slash 写锥绑定。
   * - 有 applyOps/sink → writable + createCollabApplySink
   * - 无 → readonly（UI 可测；不假装已 apply）
   */
  const slashBinding = useMemo(
    () =>
      createProductStrictSlashBinding({
        ...(applyResolution.applyOps !== undefined
          ? {
              applyOps: applyResolution.applyOps,
              ...(applyResolution.source === 'product-ipc'
                ? { sourceLabel: 'product-ipc' as const }
                : applyResolution.source === 'injected-applyOps'
                  ? { sourceLabel: 'injected-applyOps' as const }
                  : {}),
            }
          : {}),
        ...(slashIntentSink !== undefined ? { slashIntentSink } : {}),
        ...(strictSlashWireOptions ?? {}),
      }),
    [applyResolution, slashIntentSink, strictSlashWireOptions]
  );

  /**
   * CONN-D2：产品默认 MD 前缀 / turn_into 写锥。
   * - 有 applyOps/sink → writable + provisional collab（pending 形状）
   * - 无 → disabled（UI 可测；不假装已转块）
   * 与 slash **分通道**；同 applyResolution 可并行驱动。
   */
  const mdPrefixBinding = useMemo(
    () =>
      createProductMdPrefixBinding({
        ...(applyResolution.applyOps !== undefined
          ? {
              applyOps: applyResolution.applyOps,
              ...(applyResolution.source === 'product-ipc'
                ? { sourceLabel: 'product-ipc' as const }
                : applyResolution.source === 'injected-applyOps'
                  ? { sourceLabel: 'injected-applyOps' as const }
                  : {}),
            }
          : {}),
        ...(turnIntoSinkProp !== undefined
          ? { turnIntoSink: turnIntoSinkProp }
          : {}),
      }),
    [applyResolution, turnIntoSinkProp]
  );

  /** CONN-C2：产品空态 PaperList 会计钉（默认 0；opt-in 1） */
  const productPaperListAttr: '0' | '1' =
    enableProductPaperList === true ? '1' : '0';

  return {
    resolvedStrictTransport,
    slashBinding,
    mdPrefixBinding,
    productPaperListAttr,
    paperListProp: enableProductPaperList === true ? true : undefined,
  };
}

export function buildPaperWriteConeDataAttrs(
  slash: ProductStrictSlashBinding,
  mdPrefix: ProductMdPrefixBinding,
  includeSinkFlags: boolean
): Record<string, string> {
  return {
    'data-slash-write-mode': slash.mode,
    'data-slash-sink-source': slash.source,
    ...(includeSinkFlags ? { 'data-slash-sink': slash.sink ? '1' : '0' } : {}),
    'data-md-prefix-write-mode': mdPrefix.mode,
    'data-md-prefix-sink-source': mdPrefix.source,
    ...(includeSinkFlags
      ? { 'data-md-prefix-sink': mdPrefix.sink ? '1' : '0' }
      : {}),
  };
}

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

/** 已开 Strict 纸面宿主（W5-B；可演示 ≠ EL；≠ 打开完成） */
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

/** 已开 Skeleton 预览壳宿主（W5-B-S；禁止去 `-S`） */
export function WorkspaceEmptyStateSkeletonHost({
  wsId,
  skeletonDocId,
  onClose,
}: WorkspaceEmptyStateSkeletonHostProps) {
  return (
    <div
      className={styles.workspaceEmptyState}
      data-ws-id={wsId}
      data-empty="false"
      data-note-paper-preview="true"
      data-package-id={W5B_SKELETON_PACKAGE_ID}
      data-track={W5B_SKELETON_TRACK}
      data-testid="note-paper-preview-host"
      style={OPENED_PAPER_HOST_STYLE}
    >
      <NotePaperPanel
        docId={skeletonDocId}
        blockCount={6}
        title="笔记纸面（W5-B-S 预览壳）"
        onClose={onClose}
      />
    </div>
  );
}
