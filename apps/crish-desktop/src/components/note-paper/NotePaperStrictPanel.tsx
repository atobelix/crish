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
 * - **CONN-D2**：`turnIntoSink` 经 `noteMdPrefixBridge`；provisional ≠ kind UI
 * - 要求注入 `hydrateTransport`；**≠** PaperList/W3-P/A-BLK e2e 满关
 *
 * ## SD-04-R 装配拆分
 * Props → `notePaperStrictProps`；Header / Body / ChromeSlot / slash·mdPrefix binding。
 * 本文件仅装配壳（目标 &lt;400）。
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  BlockChromeModel,
  SlashMenuModel,
  type SlashOpenResult,
} from '@crish/block-paper';
/** DomHost chrome 皮；≠ EL-01 */
import '@crish/block-paper/chrome.css';
/** W3-G PaperList 挂载皮；≠ EL-01 */
import '@crish/block-paper/paper-list.css';
import { NotePaperStrictBody } from './NotePaperStrictBody';
import { NotePaperStrictChromeSlot } from './NotePaperStrictChromeSlot';
import { NotePaperStrictHeader } from './NotePaperStrictHeader';
import { EDITOR_SURFACE_NOTE_PAPER } from './editorSurface';
import { resolveStrictMdPrefixBinding } from './noteMdPrefixBridge';
import {
  resolvePresentationMode,
  showPaperListContent,
  showReactContentRows,
} from './presentationMode';
import {
  openProductSlash,
  resolveProductSlashAnchor,
  tryOpenProductSlashFromKey,
} from './productSlashOpen';
import { useNoteHydrate } from './useNoteHydrate';
import {
  W5B_STRICT_BOUNDARY,
  W5B_STRICT_PACKAGE_ID,
  W5B_STRICT_TRACK,
} from './w5bStrict';
import { MirrorDriftStatusBar } from './MirrorDriftStatusBar';
import { resolveStrictSlashBinding } from './strictSlashBinding';
import type {
  NotePaperStrictPaperListConfig,
  NotePaperStrictPanelProps,
} from './notePaperStrictProps';
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
  slashMenu: slashMenuProp,
  slashIntentSink,
  slashWriteMode: slashWriteModeProp,
  slashSinkSource: slashSinkSourceProp,
  turnIntoSink,
  mdPrefixWriteMode: mdPrefixWriteModeProp,
  mdPrefixSinkSource: mdPrefixSinkSourceProp,
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
  const paperListEnabled =
    paperListProp === true || typeof paperListProp === 'object';
  const paperListConfig: NotePaperStrictPaperListConfig =
    typeof paperListProp === 'object' && paperListProp !== null
      ? paperListProp
      : {};

  // SD-04：内容宿主互斥（产品默认不双内容同屏）
  const presentationMode = resolvePresentationMode({
    paperListEnabled,
    presentationMode: presentationModeProp ?? paperListConfig.presentationMode,
    keepReactRows: paperListConfig.keepReactRows,
  });
  const renderReactRows = showReactContentRows(presentationMode);
  const renderPaperList = showPaperListContent(presentationMode);

  const chrome = useMemo(
    () => chromeProp ?? new BlockChromeModel(),
    [chromeProp]
  );
  const slashMenu = useMemo(
    () => slashMenuProp ?? new SlashMenuModel(),
    [slashMenuProp]
  );
  /** CONN-B：无 sink 默认只读；有 sink 默认可写 */
  const { writeMode: slashWriteMode, sinkSource: slashSinkSource } =
    resolveStrictSlashBinding({
      slashIntentSink,
      slashWriteMode: slashWriteModeProp,
      slashSinkSource: slashSinkSourceProp,
    });
  /** CONN-D2：无 turnIntoSink 默认 disabled；有则 writable */
  const { writeMode: mdPrefixWriteMode, sinkSource: mdPrefixSinkSource } =
    resolveStrictMdPrefixBinding({
      turnIntoSink,
      mdPrefixWriteMode: mdPrefixWriteModeProp,
      mdPrefixSinkSource: mdPrefixSinkSourceProp,
    });
  const slashOpen = useSyncExternalStore(
    (onStoreChange) => slashMenu.subscribe(onStoreChange),
    () => (slashMenu.isOpen() ? '1' : '0'),
    () => '0'
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

  const [chromeTick, setChromeTick] = useState(0);
  const bump = useCallback(() => setChromeTick((n) => n + 1), []);
  // chromeTick 触发内部重绘；快照每帧从 model 读，
  // 使外部 chrome.setFocused + rerender（CONN-C 测）也能驱动 PaperList pin
  void chromeTick;
  const snapshot = chrome.getSnapshot();

  const handleHover = useCallback(
    (blockId: string | null) => {
      chrome.setHovered(blockId);
      bump();
    },
    [chrome, bump]
  );
  const handleFocus = useCallback(
    (blockId: string | null) => {
      chrome.setFocused(blockId);
      bump();
    },
    [chrome, bump]
  );

  /** CONN-C：chrome focus → PaperList pin；≠ W3-P / ≠ EL-01 */
  const paperListFocusId =
    snapshot.focusedBlockId ?? paperListConfig.focusId ?? null;

  const panelRef = useRef<HTMLElement | null>(null);

  /** CONN-B2：产品 openSlash；composing 拒开；≠ EL-01 */
  const openSlash = useCallback(
    (blockId?: string, offset = 0): SlashOpenResult => {
      const anchorId =
        blockId ??
        resolveProductSlashAnchor({
          focusedBlockId: chrome.getSnapshot().focusedBlockId,
          blocks,
          docId,
        });
      const opened = openProductSlash({
        menu: slashMenu,
        blockId: anchorId,
        offset,
      });
      if (opened.ok) {
        bump();
      }
      onSlashOpenResult?.(opened);
      return opened;
    },
    [blocks, docId, slashMenu, chrome, bump, onSlashOpenResult]
  );

  const openSlashMenu = useCallback(() => {
    void openSlash();
  }, [openSlash]);

  /** CONN-B2：面板内裸 `/` → 同 open 路径 */
  useEffect(() => {
    const root = panelRef.current;
    if (!root) return;

    const onKeyDown = (ev: KeyboardEvent) => {
      const r = tryOpenProductSlashFromKey(ev, {
        menu: slashMenu,
        anchor: {
          focusedBlockId: chrome.getSnapshot().focusedBlockId,
          blocks,
          docId,
        },
        surfaceRoot: root,
      });
      if (r.ok) {
        bump();
        onSlashOpenResult?.(r);
      } else if (r.code === 'composing') {
        onSlashOpenResult?.(r);
      }
    };

    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, [slashMenu, chrome, blocks, docId, bump, onSlashOpenResult]);

  const rootClass = [styles.panel, className].filter(Boolean).join(' ');

  return (
    <section
      ref={panelRef}
      className={rootClass}
      data-surface={EDITOR_SURFACE_NOTE_PAPER}
      data-testid="note-paper-strict-panel"
      data-package-id={W5B_STRICT_PACKAGE_ID}
      data-track={W5B_STRICT_TRACK}
      data-doc-id={docId}
      data-rev={String(resolvedRev)}
      data-silent-level={snapshot.silentLevel}
      data-block-count={String(blocks.length)}
      data-slash-open={slashOpen === '1' ? 'true' : 'false'}
      data-slash-ui="react"
      data-slash-write-mode={slashWriteMode}
      data-slash-sink-source={slashSinkSource}
      data-slash-sink={slashIntentSink ? '1' : '0'}
      data-slash-open-path="product"
      data-md-prefix-write-mode={mdPrefixWriteMode}
      data-md-prefix-sink-source={mdPrefixSinkSource}
      data-md-prefix-sink={turnIntoSink ? '1' : '0'}
      data-source="hydrate"
      data-hydrate-source={hydrateSource}
      data-hydrate-status={status}
      data-hydrate-path={projection?.hydratePath}
      data-transport-loading={status === 'loading' ? 'true' : 'false'}
      data-paper-list={renderPaperList ? '1' : '0'}
      data-presentation-mode={presentationMode}
      data-paper-list-focus-id={
        renderPaperList
          ? (paperListConfig.focusId ?? snapshot.focusedBlockId ?? undefined) ||
            undefined
          : undefined
      }
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
        status={status}
        errorReason={errorReason}
        errorCode={errorCode}
        blocks={blocks}
        renderReactRows={renderReactRows}
        chrome={chrome}
        onHover={handleHover}
        onFocus={handleFocus}
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
          slashMenu={slashMenu}
          slashIntentSink={slashIntentSink}
          slashWriteMode={slashWriteMode}
          chromeTick={chromeTick}
          slashOpen={slashOpen === '1' ? '1' : '0'}
          onSlashIntent={onSlashIntent}
          onChromeDomHost={onChromeDomHost}
        />
      </NotePaperStrictBody>

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
