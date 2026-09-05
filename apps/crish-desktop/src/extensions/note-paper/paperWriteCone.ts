/**
 * 产品纸面写锥绑定（slash / mdPrefix / PaperList 入口解析）
 *
 * 从空态装配壳抽出；EmptyState 夹具经旧路径 re-export 消费。
 * `enableProductPaperList` **默认仍由装配壳钉 false**；产品叶喂策略常量。
 *
 * LR-H1：宿主传入已解析 persist docId；本文件不合成死 id。
 *
 * ≠ EL-01；≠ EL-04；≠ EL-08；≠ W3-P 满窗；≠ 打开完成；≠ 去 `-S`
 */

import { useMemo } from 'react';
import type {
  ApplyOpsAdapter,
  IntentSink,
  TurnIntoSink,
} from '@crish/block-paper';
import type { NoteApplyOpsIpc } from '../../api/noteApplyOpsIpc';
import { resolveProductStrictApplyOps } from '../../api/noteApplyOpsIpc';
import {
  createProductStrictHydrateTransport,
  type NoteHydrateTransport,
} from '../../components/note-paper/hydrateProjection';
import {
  createProductMdPrefixBinding,
  type ProductMdPrefixBinding,
} from '../../components/note-paper/noteMdPrefixBridge';
import {
  createProductStrictSlashBinding,
  type CreateProductStrictSlashBindingOptions,
  type ProductStrictSlashBinding,
} from '../../components/note-paper/productSlashSink';

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
  applyOps?: ApplyOpsAdapter;
};

/**
 * 空态 / 产品叶 paper 写锥 + C2 入口解析。
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
    applyOps: applyResolution.applyOps,
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
