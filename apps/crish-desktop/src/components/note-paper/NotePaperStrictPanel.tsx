/**
 * NotePaperStrictPanel — Workbench 笔记纸面 **Strict 轨**（W5-B）
 *
 * ## 包轨（强制）
 * - **包 ID：W5-B**（`W5B_STRICT_PACKAGE_ID`，**无** `-S`）
 * - **轨**：`data-track="strict"`
 * - **合法交付**：可注入 hydrate 投影通路 + 加载/空/错误/成功三态 UI
 * - **与 W5-B-S 并存**：Skeleton 壳见 `NotePaperPanel`（`data-package-id=W5-B-S`）
 *
 * ## 呈现策略（SD-04 · 反三宿主）
 * `react-rows` | `paper-list` | `debug-dual`（仅调试）；产品默认互斥，见 `presentationMode.ts`。
 * chrome 槽与 content 槽 **分槽共存**，不计入互斥。
 *
 * ## 诚实边界（钉死）
 * - **可演示 ≠ EL-01 / EL-08**；**≠ 打开完成（G-HYD）**；禁止 import 行级 EditorStore
 * - **CONN-A1**：可选 `data-hydrate-path`；path ≠ 打开完成 / ≠ EL-01/04/08
 * - **CONN-B**：无 sink → 只读 catalog；**CONN-B2** `/` / openSlash 打开
 * - **CONN-D2/D3**：`turnIntoSink` 经 `noteMdPrefixBridge`；content-row 叶 → 产品路径；
 *   provisional ≠ kind UI；**≠ A-BLK-08/09 全 e2e / ≠ EL-01**
 * - 要求注入 `hydrateTransport`；**≠** PaperList/W3-P/A-BLK e2e 满关
 *
 * ## SD-04-R / SD-15 装配拆分
 * Props → `notePaperStrictProps`；Header / Body / ChromeSlot；
 * 交互 → `useNotePaperStrictShell`；presentation·data-* → `notePaperStrictAssembly`。
 * 本文件仅装配壳（目标 &lt;400；SD-04-R-G 测钉防回涨）。**≠ EL-01**。
 */

import React, { useMemo, useRef } from 'react';
/** DomHost chrome 皮；≠ EL-01 */
import '@crish/block-paper/chrome.css';
/** W3-G PaperList 挂载皮；≠ EL-01 */
import '@crish/block-paper/paper-list.css';
import { NotePaperStrictBody } from './NotePaperStrictBody';
import { NotePaperStrictChromeSlot } from './NotePaperStrictChromeSlot';
import { NotePaperStrictHeader } from './NotePaperStrictHeader';
import { EDITOR_SURFACE_NOTE_PAPER } from './editorSurface';
import {
  buildStrictPanelSectionDataAttrs,
  resolveStrictContentPresentation,
} from './notePaperStrictAssembly';
import { useNoteHydrate } from './useNoteHydrate';
import { useNotePaperStrictShell } from './useNotePaperStrictShell';
import { W5B_STRICT_BOUNDARY } from './notePaperStrictTrack';
import { MirrorDriftStatusBar } from './MirrorDriftStatusBar';
import { ConexFloatHandle } from './ConexFloatHandle';
import type { NotePaperStrictPanelProps } from './notePaperStrictProps';
import styles from './NotePaperPanel.module.css';

export type {
  NotePaperStrictPaperListConfig,
  NotePaperStrictPanelProps,
} from './notePaperStrictProps';

/**
 * Strict 轨笔记纸面：hydrate 投影 + 内容宿主策略 + L0 chrome。
 * 写路径须经 Intent 桥；**不** 接行级 store / EditorStore。
 */
export const NotePaperStrictPanel: React.FC<NotePaperStrictPanelProps> = ({
  docId,
  hydrateTransport,
  refreshToken = 0,
  chrome: chromeProp,
  blockSelection: blockSelectionProp,
  onBlockSelectionReady,
  slashMenu: slashMenuProp,
  slashIntentSink,
  slashWriteMode: slashWriteModeProp,
  slashSinkSource: slashSinkSourceProp,
  turnIntoSink,
  mdPrefixWriteMode: mdPrefixWriteModeProp,
  mdPrefixSinkSource: mdPrefixSinkSourceProp,
  mdPrefixBinding,
  onMdPrefixCommit,
  onMdPrefixCommittedIntent,
  showOpenSlashButton = true,
  onSlashOpenResult,
  onSlashIntent,
  onChromeDomHost,
  paperList: paperListProp,
  presentationMode: presentationModeProp,
  onPaperListReady,
  onClose,
  className,
  title = '笔记纸面（W5-B Strict · hydrate 投影）',
  mirrorDriftReport = null,
  mirrorWatchSource = 'unknown',
  mirrorUnpushedOpCount = 0,
  showMirrorDriftBar,
  onMirrorThreeWay,
}) => {
  const {
    paperListConfig,
    presentationMode,
    renderReactRows,
    renderPaperList,
  } = useMemo(
    () =>
      resolveStrictContentPresentation({
        paperListProp,
        presentationMode: presentationModeProp,
      }),
    [paperListProp, presentationModeProp]
  );

  const {
    status,
    projection,
    errorReason,
    errorCode,
    blocks,
    resolvedRev,
    hydrateSource,
    reload,
  } = useNoteHydrate({
    hydrateTransport,
    docId,
    refreshToken,
  });

  const {
    chrome,
    blockSelection,
    slashMenu,
    slashWriteMode,
    slashSinkSource,
    effectiveTurnIntoSink,
    mdPrefixWriteMode,
    mdPrefixSinkSource,
    slashOpen,
    chromeTick,
    snapshot,
    selSnapshot,
    handleHover,
    handleFocus,
    openSlashMenu,
    panelRef,
  } = useNotePaperStrictShell({
    docId,
    blocks,
    chrome: chromeProp,
    blockSelection: blockSelectionProp,
    slashMenu: slashMenuProp,
    slashIntentSink,
    slashWriteMode: slashWriteModeProp,
    slashSinkSource: slashSinkSourceProp,
    turnIntoSink,
    mdPrefixWriteMode: mdPrefixWriteModeProp,
    mdPrefixSinkSource: mdPrefixSinkSourceProp,
    mdPrefixBinding,
    onSlashOpenResult,
  });

  /** CONN-C：chrome focus → PaperList pin；≠ W3-P / ≠ EL-01 */
  const paperListFocusId =
    snapshot.focusedBlockId ?? paperListConfig.focusId ?? null;

  const sectionDataAttrs = buildStrictPanelSectionDataAttrs({
    docId,
    resolvedRev,
    silentLevel: snapshot.silentLevel,
    blockCount: blocks.length,
    slashOpen: slashOpen === '1',
    slashWriteMode,
    slashSinkSource,
    hasSlashSink: Boolean(slashIntentSink),
    mdPrefixWriteMode,
    mdPrefixSinkSource,
    hasMdPrefixSink: Boolean(effectiveTurnIntoSink),
    hydrateSource,
    status,
    projection,
    renderPaperList,
    presentationMode,
    paperListConfigFocusId: paperListConfig.focusId,
    focusedBlockId: snapshot.focusedBlockId,
    selSnapshot,
  });

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rootClass = [styles.panel, className].filter(Boolean).join(' ');

  return (
    <section
      ref={panelRef}
      className={rootClass}
      {...sectionDataAttrs}
      role="region"
      aria-label={title}
      aria-busy={status === 'loading' ? true : undefined}
      tabIndex={-1}
    >
      <NotePaperStrictHeader
        title={title}
        resolvedRev={resolvedRev}
        blockCount={blocks.length}
        slashWriteMode={slashWriteMode}
        showOpenSlashButton={showOpenSlashButton}
        onReload={reload}
        onOpenSlash={openSlashMenu}
        onClose={onClose}
      />

      <NotePaperStrictBody
        ref={bodyRef}
        status={status}
        errorReason={errorReason}
        errorCode={errorCode}
        blocks={blocks}
        // CT-01 对象级 rev（R7 收口，主控裁决③）：hydrate 投影文档 rev 透传；
        // 无真实 rev（未 hydrate / rev=0 占位）时保持 undefined
        baseRev={resolvedRev > 0 ? resolvedRev : undefined}
        renderReactRows={renderReactRows}
        chrome={chrome}
        onHover={handleHover}
        onFocus={handleFocus}
        turnIntoSink={effectiveTurnIntoSink}
        mdPrefixWriteMode={mdPrefixWriteMode}
        mdPrefixSinkSource={mdPrefixSinkSource}
        mdPrefixBinding={mdPrefixBinding}
        onMdPrefixCommit={onMdPrefixCommit}
        onMdPrefixCommittedIntent={onMdPrefixCommittedIntent}
      >
        <NotePaperStrictChromeSlot
          status={status}
          blocks={blocks}
          renderPaperList={renderPaperList}
          paperListWindow={paperListConfig.window}
          paperListScroll={paperListConfig.scroll}
          paperListOverscan={paperListConfig.overscan}
          paperListFocusId={paperListFocusId}
          paperListComposingIds={paperListConfig.composingIds}
          paperListDefaultVisibleCount={paperListConfig.defaultVisibleCount}
          paperListDefaultEstimatePx={paperListConfig.defaultEstimatePx}
          onPaperListReady={onPaperListReady}
          chrome={chrome}
          blockSelection={blockSelection}
          onBlockSelectionReady={onBlockSelectionReady}
          slashMenu={slashMenu}
          slashIntentSink={slashIntentSink}
          slashWriteMode={slashWriteMode}
          chromeTick={chromeTick}
          slashOpen={slashOpen === '1' ? '1' : '0'}
          onSlashIntent={onSlashIntent}
          onChromeDomHost={onChromeDomHost}
        />
      </NotePaperStrictBody>

      <ConexFloatHandle scrollContainerRef={bodyRef} />

      {/* A-INV-02 方向子集；≠ EL-03；≠ inotify 满关 */}
      {showMirrorDriftBar === true || mirrorDriftReport != null ? (
        <MirrorDriftStatusBar
          report={mirrorDriftReport}
          watchSource={mirrorWatchSource}
          unpushedOpCount={mirrorUnpushedOpCount}
          onAction={onMirrorThreeWay}
        />
      ) : null}

      <footer className={styles.footer} data-testid="note-paper-strict-footer">
        surface={EDITOR_SURFACE_NOTE_PAPER} · {W5B_STRICT_BOUNDARY}
        {projection ? ` · source=${projection.source}` : ''}
      </footer>
    </section>
  );
};

export default NotePaperStrictPanel;
