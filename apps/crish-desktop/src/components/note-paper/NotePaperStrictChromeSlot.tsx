/**
 * NotePaperStrictChromeSlot — Strict 分槽挂载（SD-04-R 拆分）
 *
 * 承载：
 * - 内容宿主 B：PaperList（仅 paper-list / debug-dual；status=ready）
 * - React slash 浮层（CONN-B 写模式诚实）
 * - chrome 槽 DomHost（与内容槽分槽共存；不计入 SD-04 互斥）
 *
 * **≠ EL-01**；**≠ W3-P**；projectSlashCatalog 钉死 false（防双层 catalog）。
 */

import React from 'react';
import type {
  BlockChromeDomHost,
  BlockChromeModel,
  BlockSelectionBridge,
  IntentSink,
  PaperList,
  PaperListScrollState,
  PaperListWindowState,
  SlashInsertIntent,
  SlashMenuModel,
} from '@crish/block-paper';
import { BlockChromeDomMount } from './BlockChromeDomMount';
import {
  PaperListDomMount,
  type PaperListMountBlock,
} from './PaperListDomMount';
import {
  SlashMenuOverlay,
  type SlashOverlayWriteMode,
} from './SlashMenuOverlay';
import type { HydratedBlockProjection } from './hydrateProjection';
import type { HydrateUiStatus } from './useNoteHydrate';
import styles from './NotePaperPanel.module.css';

/** hydrate 块 → PaperList 投影；透传 `props.level` 写 data-heading-level */
function toPaperListMountBlock(
  block: HydratedBlockProjection
): PaperListMountBlock {
  const row: PaperListMountBlock = {
    id: block.id,
    flavour: block.flavour,
  };
  if (block.text !== undefined) row.text = block.text;
  if (typeof block.props?.level === 'number') {
    row.level = block.props.level;
  }
  return row;
}

/** 内容宿主 B 域（PaperList 挂载：投影/窗口/滚动/聚焦/虚拟化/就绪回调）。 */
export interface NotePaperSlotNoteProps {
  status: HydrateUiStatus;
  blocks: readonly HydratedBlockProjection[];
  /** 是否挂载 PaperList 内容槽（paper-list | debug-dual） */
  renderPaperList: boolean;
  paperListWindow?: PaperListWindowState;
  paperListScroll?: PaperListScrollState;
  paperListOverscan?: number;
  paperListFocusId?: string | null;
  paperListComposingIds?: readonly string[];
  paperListDefaultVisibleCount?: number;
  paperListDefaultEstimatePx?: number;
  onPaperListReady?: (list: PaperList | null) => void;
  onBlockChange?: (blockId: string, newText: string) => void;
  onTextCommit?: (blockId: string, newText: string) => void;
}

/** slash 浮层域（catalog → Intent → sink；CONN-B 写模式诚实）。 */
export interface NotePaperSlotSlashProps {
  slashMenu: SlashMenuModel;
  slashIntentSink?: IntentSink;
  slashWriteMode: SlashOverlayWriteMode;
  /** chromeTick 驱动 slash 同步 / DomHost syncToken */
  chromeTick: number;
  slashOpen: '0' | '1';
  onSlashIntent?: (intent: SlashInsertIntent) => void;
}

/** chrome 槽域（把手/落点；与内容槽分槽共存，不计 SD-04 互斥）。 */
export interface NotePaperSlotChromeProps {
  chrome: BlockChromeModel;
  /** W3-E-desk：与面板同一 bridge（注入 DomMount，避免双实例） */
  blockSelection?: BlockSelectionBridge;
  onBlockSelectionReady?: (selection: BlockSelectionBridge | null) => void;
  onChromeDomHost?: (host: BlockChromeDomHost | null) => void;
}

/** Props 分组：note（PaperList 内容宿主）+ slash（浮层）+ chrome（chrome 槽）。 */
export type NotePaperStrictChromeSlotProps = {
  note: NotePaperSlotNoteProps;
  slash: NotePaperSlotSlashProps;
  chrome: NotePaperSlotChromeProps;
};

/**
 * Body 内分槽兄弟：PaperList ∥ SlashOverlay ∥ BlockChromeDomMount。
 */
export const NotePaperStrictChromeSlot: React.FC<
  NotePaperStrictChromeSlotProps
> = ({
  note,
  slash,
  chrome: chromeProps,
}) => {
  const {
    status,
    blocks,
    renderPaperList,
    paperListWindow,
    paperListScroll,
    paperListOverscan,
    paperListFocusId,
    paperListComposingIds,
    paperListDefaultVisibleCount,
    paperListDefaultEstimatePx,
    onPaperListReady,
    onBlockChange,
    onTextCommit,
  } = note;
  const {
    slashMenu,
    slashIntentSink,
    slashWriteMode,
    chromeTick,
    slashOpen,
    onSlashIntent,
  } = slash;
  const { chrome, blockSelection, onBlockSelectionReady, onChromeDomHost } =
    chromeProps;
  return (
    <>
      {/*
        内容宿主 B：W3-G PaperList。
        槽锚 data-bp-paper-list-mount；仅 paper-list / debug-dual。
        与 chrome 分槽同屏不互删；≠ EL-01；≠ W3-P。
      */}
      {renderPaperList && status === 'ready' ? (
        <PaperListDomMount
          blocks={blocks.map(toPaperListMountBlock)}
          window={paperListWindow}
          scroll={paperListScroll}
          overscan={paperListOverscan}
          focusId={paperListFocusId}
          composingIds={paperListComposingIds}
          defaultVisibleCount={paperListDefaultVisibleCount}
          defaultEstimatePx={paperListDefaultEstimatePx}
          onListReady={onPaperListReady}
          onBlockChange={onBlockChange}
          onTextCommit={onTextCommit}
          testId="note-paper-strict-paper-list"
        />
      ) : null}
      {/*
        React slash 浮层（catalog → Intent → sink）。
        CONN-B：无 sink 时 writeMode=readonly，禁提交。≠ EL-01；≠ A-BLK-02 e2e。
        DomHost 关 catalog 防双层。
      */}
      <SlashMenuOverlay
        menu={slashMenu}
        sink={slashIntentSink}
        writeMode={slashWriteMode}
        syncToken={chromeTick}
        className={styles.slashOverlay}
        onSelectIntent={onSlashIntent}
        testId="note-paper-strict-slash-overlay"
      />
      {/*
        chrome 槽：data-bp-chrome-mount（把手/落点）。
        与内容槽分槽共存；不计入 SD-04 内容互斥。≠ EL-01。
      */}
      <BlockChromeDomMount
        blocks={
          status === 'ready'
            ? blocks.map((b) => ({
                blockId: b.id,
                flavour: b.flavour,
              }))
            : []
        }
        chrome={chrome}
        selection={blockSelection}
        slash={slashMenu}
        projectSlashCatalog={false}
        syncToken={`${chromeTick}:${slashOpen}`}
        onHostReady={onChromeDomHost}
        onSelectionReady={onBlockSelectionReady}
        testId="note-paper-strict-chrome-dom"
      />
    </>
  );
};

export default NotePaperStrictChromeSlot;
