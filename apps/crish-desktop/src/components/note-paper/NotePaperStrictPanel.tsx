/** 目标 <400 行；SD-04-R 装配拆分；≠ EL-01 */
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
 * ## 32px 紧凑顶栏与全高视口重构（DETAIL-PLAN-05）
 * - 彻底物理切除底部 MirrorDriftStatusBar 与 <footer> 调试废弃块；
 * - 顶栏全面升级为 32px 紧凑生产力架构，集成行内标题重命名、等宽字数统计、20x20px Chevron 下拉触点与全量 Tooltip；
 * - 编辑区 100% 全高弹性视口直达底边缘，纸面背景纯净连贯；
 * - 顶栏测试桩点严格保全：note-paper-strict-open-slash、refresh、close。
 *
 * ## SD-04-R / SD-15 装配拆分
 * Props → `notePaperStrictProps`；Header / Body / ChromeSlot；
 * 交互 → `useNotePaperStrictShell`；presentation·data-* → `notePaperStrictAssembly`。
 */

import React, { useState, useCallback, useRef, useMemo } from 'react';
import type { CollabTextEditOpWire } from '@crish/block-paper-contract';
import { resolveProductStrictApplyOps } from '../../api/noteApplyOpsIpc';
import { notifyNoteDocWritten } from '../../bridges/note-doc-written';
/** DomHost chrome 皮；≠ EL-01 */
import '@crish/block-paper/chrome.css';
/** W3-G PaperList 挂载皮；≠ EL-01 */
import '@crish/block-paper/paper-list.css';
import { NotePaperStrictBody } from './NotePaperStrictBody';
import { NotePaperStrictChromeSlot } from './NotePaperStrictChromeSlot';
import { NotePaperStrictHeader } from './NotePaperStrictHeader';
import {
  buildStrictPanelSectionDataAttrs,
  resolveStrictContentPresentation,
} from './notePaperStrictAssembly';
import { useNoteHydrate } from './useNoteHydrate';
import { useNotePaperStrictShell } from './useNotePaperStrictShell';
import type { NotePaperStrictPanelProps } from './notePaperStrictProps';
import styles from './NotePaperPanel.module.css';

export type {
  NotePaperStrictPaperListConfig,
  NotePaperStrictPanelProps,
} from './notePaperStrictProps';

/**
 * Strict 轨笔记纸面：hydrate 投影 + 内容宿主策略 + 32px 紧凑顶栏 + 100% 全高编辑视口。
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
  title = '无标题笔记',
  onRenameTitle,
  saveStatus: saveStatusProp = 'saved',
  applyOps: applyOpsProp,
  onBlockChange: onBlockChangeProp,
  onTextCommit: onTextCommitProp,
  isSidebarOpen,
  onToggleSidebar,
  documents,
  onSelectDoc,
  onCreateDoc,
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


  const [localSaveStatus, setLocalSaveStatus] = useState<
    'saved' | 'syncing' | 'unsaved' | 'saving' | null
  >(null);
  const effectiveSaveStatus = localSaveStatus ?? saveStatusProp;

  const resolvedApplyOps = useMemo(() => {
    if (applyOpsProp) return applyOpsProp;
    return resolveProductStrictApplyOps({ docId }).applyOps;
  }, [applyOpsProp, docId]);

  const lastPersistedTextRef = useRef<Map<string, string>>(new Map());

  const persistBlockText = useCallback(
    async (blockId: string, newText: string) => {
      const oldBlock = blocks.find((b) => b.id === blockId);
      const prevRecorded = lastPersistedTextRef.current.get(blockId);
      const oldText = prevRecorded ?? oldBlock?.text ?? '';

      if (prevRecorded !== undefined && prevRecorded === newText) {
        return;
      }

      setLocalSaveStatus('saving');
      lastPersistedTextRef.current.set(blockId, newText);

      try {
        if (resolvedApplyOps) {
          const op: CollabTextEditOpWire = {
            op: 'text_edit',
            id: blockId,
            start: 0,
            end: [...oldText].length,
            insert: newText,
          };
          const opsJson = JSON.stringify([op]);
          const intentId = `text-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const outcome = await resolvedApplyOps(opsJson, { intentId });
          if (outcome.ok) {
            setLocalSaveStatus('saved');
            notifyNoteDocWritten({
              docId,
              intentId,
              source: 'product_apply',
            });
          } else {
            setLocalSaveStatus('unsaved');
          }
        } else {
          setLocalSaveStatus('saved');
          notifyNoteDocWritten({
            docId,
            source: 'product_apply',
          });
        }
      } catch {
        setLocalSaveStatus('unsaved');
      }
    },
    [blocks, docId, resolvedApplyOps]
  );

  const handleBlockChange = useCallback(
    (blockId: string, newText: string) => {
      onBlockChangeProp?.(blockId, newText);
      void persistBlockText(blockId, newText);
    },
    [onBlockChangeProp, persistBlockText]
  );

  const handleTextCommit = useCallback(
    (blockId: string, newText: string) => {
      onTextCommitProp?.(blockId, newText);
      void persistBlockText(blockId, newText);
    },
    [onTextCommitProp, persistBlockText]
  );

  const handleRenameTitle = useCallback(
    async (newTitle: string) => {
      if (!onRenameTitle) return;
      setLocalSaveStatus('saving');
      try {
        await onRenameTitle(newTitle);
        setLocalSaveStatus('saved');
      } catch {
        setLocalSaveStatus('unsaved');
      }
    },
    [onRenameTitle]
  );

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

  const rootClass = [styles.panel, className].filter(Boolean).join(' ');

  return (
    <section
      ref={panelRef}
      className={rootClass}
      {...sectionDataAttrs}
      data-save-status={effectiveSaveStatus}
      role="region"
      aria-label={title}
      aria-busy={status === 'loading' ? true : undefined}
      tabIndex={-1}
    >
      <NotePaperStrictHeader
        docId={docId}
        title={title}
        blocks={blocks}
        saveStatus={effectiveSaveStatus}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={onToggleSidebar}
        documents={documents}
        onSelectDoc={onSelectDoc}
        onCreateDoc={onCreateDoc}
        onRenameTitle={onRenameTitle ? handleRenameTitle : undefined}
        onReload={reload}
        onClose={onClose}
        isLoading={status === 'loading'}
        slashWriteMode={slashWriteMode}
        showOpenSlashButton={showOpenSlashButton}
        onOpenSlash={openSlashMenu}
        resolvedRev={resolvedRev}
      />

      <NotePaperStrictBody
        status={status}
        errorReason={errorReason}
        errorCode={errorCode}
        blocks={blocks}
        baseRev={resolvedRev > 0 ? resolvedRev : undefined}
        renderReactRows={renderReactRows}
        chrome={chrome}
        onHover={handleHover}
        onFocus={handleFocus}
        mdPrefix={{
          turnIntoSink: effectiveTurnIntoSink,
          mdPrefixWriteMode,
          mdPrefixSinkSource,
          mdPrefixBinding,
          onMdPrefixCommit,
          onMdPrefixCommittedIntent,
        }}
      >
        <NotePaperStrictChromeSlot
          note={{
            status,
            blocks,
            renderPaperList,
            paperListWindow: paperListConfig.window,
            paperListScroll: paperListConfig.scroll,
            paperListOverscan: paperListConfig.overscan,
            paperListFocusId,
            paperListComposingIds: paperListConfig.composingIds,
            paperListDefaultVisibleCount: paperListConfig.defaultVisibleCount,
            paperListDefaultEstimatePx: paperListConfig.defaultEstimatePx,
            onPaperListReady,
            onBlockChange: handleBlockChange,
            onTextCommit: handleTextCommit,
          }}
          slash={{
            slashMenu,
            slashIntentSink,
            slashWriteMode,
            chromeTick,
            slashOpen: slashOpen === '1' ? '1' : '0',
            onSlashIntent,
          }}
          chrome={{
            chrome,
            blockSelection,
            onBlockSelectionReady,
            onChromeDomHost,
          }}
        />
      </NotePaperStrictBody>
    </section>
  );
};

export default NotePaperStrictPanel;
