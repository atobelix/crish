/**
 * NotePaperStrict 装配纯函数（SD-15 · 贴线再外置）
 *
 * 从 `NotePaperStrictPanel` 装配壳抽出：
 * - paperList 配置 / presentationMode 互斥解析
 * - 根 section 诚实 data-* 字典
 *
 * **不**改 presentationMode 默认互斥语义；**≠ EL-01**。
 */

import type { BlockSelectionSnapshot } from '@crish/block-paper';
import { blockSelectionSnapshotToDataAttrs } from './blockSelectionProduct';
import { EDITOR_SURFACE_NOTE_PAPER } from './editorSurface';
import type { DocHydrateProjection } from './hydrateProjection';
import type {
  NotePaperStrictPaperListConfig,
  NotePaperStrictPanelProps,
} from './notePaperStrictProps';
import {
  resolvePresentationMode,
  showPaperListContent,
  showReactContentRows,
  type PresentationMode,
} from './presentationMode';
import type {
  ProductMdPrefixSinkSource,
  ProductMdPrefixWriteMode,
} from './noteMdPrefixBridge';
import type { ProductSlashSinkSource } from './productSlashSink';
import type { SlashOverlayWriteMode } from './SlashMenuOverlay';
import type { HydrateUiStatus } from './useNoteHydrate';
import {
  W5B_STRICT_PACKAGE_ID,
  W5B_STRICT_TRACK,
  W5B_STRICT_BOUNDARY,
} from './notePaperStrictTrack';

// ---------------------------------------------------------------------------
// paperList + 内容宿主互斥
// ---------------------------------------------------------------------------

export type StrictContentPresentation = {
  paperListEnabled: boolean;
  paperListConfig: NotePaperStrictPaperListConfig;
  presentationMode: PresentationMode;
  renderReactRows: boolean;
  renderPaperList: boolean;
};

/**
 * 解析 Strict 内容宿主策略（产品默认互斥；debug-dual 仅显式）。
 * 语义对齐原装配壳；禁止默认双内容同屏。
 */
export function resolveStrictContentPresentation(input: {
  paperListProp: NotePaperStrictPanelProps['paperList'];
  presentationMode?: PresentationMode;
}): StrictContentPresentation {
  const paperListEnabled =
    input.paperListProp === true || typeof input.paperListProp === 'object';
  const paperListConfig: NotePaperStrictPaperListConfig =
    typeof input.paperListProp === 'object' && input.paperListProp !== null
      ? input.paperListProp
      : {};

  const presentationMode = resolvePresentationMode({
    paperListEnabled,
    presentationMode:
      input.presentationMode ?? paperListConfig.presentationMode,
    keepReactRows: paperListConfig.keepReactRows,
  });

  return {
    paperListEnabled,
    paperListConfig,
    presentationMode,
    renderReactRows: showReactContentRows(presentationMode),
    renderPaperList: showPaperListContent(presentationMode),
  };
}

// ---------------------------------------------------------------------------
// 根 section data-*
// ---------------------------------------------------------------------------

export type BuildStrictPanelSectionDataAttrsInput = {
  docId: string;
  resolvedRev: number | string;
  silentLevel: string;
  blockCount: number;
  slashOpen: boolean;
  slashWriteMode: SlashOverlayWriteMode;
  slashSinkSource: ProductSlashSinkSource;
  hasSlashSink: boolean;
  mdPrefixWriteMode: ProductMdPrefixWriteMode;
  mdPrefixSinkSource: ProductMdPrefixSinkSource;
  hasMdPrefixSink: boolean;
  hydrateSource: string;
  status: HydrateUiStatus;
  projection: DocHydrateProjection | null;
  renderPaperList: boolean;
  presentationMode: PresentationMode;
  paperListConfigFocusId?: string | null;
  focusedBlockId: string | null;
  selSnapshot: BlockSelectionSnapshot;
};

/**
 * Strict 面板根节点诚实标注字典（data-* + surface/package）。
 * 测锚：hydrate / slash / mdPrefix / selection / presentation；**≠ EL-01**。
 * `data-leaf-view-root=1` 钉在 section 上（05-A）；不要另包一层。
 */
export function buildStrictPanelSectionDataAttrs(
  input: BuildStrictPanelSectionDataAttrsInput
): Record<string, string | undefined> {
  const paperListFocusAttr = input.renderPaperList
    ? (input.paperListConfigFocusId ?? input.focusedBlockId ?? undefined) ||
      undefined
    : undefined;

  const selAttrs = blockSelectionSnapshotToDataAttrs(input.selSnapshot);

  return {
    'data-surface': EDITOR_SURFACE_NOTE_PAPER,
    'data-testid': 'note-paper-strict-panel',
    'data-leaf-view-root': '1',
    'data-package-id': W5B_STRICT_PACKAGE_ID,
    'data-track': W5B_STRICT_TRACK,
    'data-boundary': W5B_STRICT_BOUNDARY,
    'data-doc-id': input.docId,
    'data-rev': String(input.resolvedRev),
    'data-silent-level': input.silentLevel,
    'data-block-count': String(input.blockCount),
    'data-slash-open': input.slashOpen ? 'true' : 'false',
    'data-slash-ui': 'react',
    'data-slash-write-mode': input.slashWriteMode,
    'data-slash-sink-source': input.slashSinkSource,
    'data-slash-sink': input.hasSlashSink ? '1' : '0',
    'data-slash-open-path': 'product',
    'data-md-prefix-write-mode': input.mdPrefixWriteMode,
    'data-md-prefix-sink-source': input.mdPrefixSinkSource,
    'data-md-prefix-sink': input.hasMdPrefixSink ? '1' : '0',
    'data-md-prefix-leaf-path': 'product',
    'data-source': 'hydrate',
    'data-hydrate-source': input.hydrateSource,
    'data-hydrate-status': input.status,
    'data-hydrate-path': input.projection?.hydratePath,
    'data-transport-loading': input.status === 'loading' ? 'true' : 'false',
    'data-paper-list': input.renderPaperList ? '1' : '0',
    'data-presentation-mode': input.presentationMode,
    'data-paper-list-focus-id': paperListFocusAttr,
    ...selAttrs,
  };
}
