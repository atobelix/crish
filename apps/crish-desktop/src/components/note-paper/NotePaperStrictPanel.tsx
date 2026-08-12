/**
 * NotePaperStrictPanel — Workbench 笔记纸面 **Strict 轨**（W5-B）
 *
 * ## 包轨（强制）
 * - **包 ID：W5-B**（`W5B_STRICT_PACKAGE_ID`，**无** `-S`）
 * - **轨**：`data-track="strict"`
 * - **合法交付**：可注入 hydrate 投影通路 + 加载/空/错误/成功三态 UI
 * - **与 W5-B-S 并存**：Skeleton 壳见 `NotePaperPanel`（`data-package-id=W5-B-S`）；
 *   **禁止** 把 Skeleton 常量改成 W5-B 冒充本轨
 *
 * ## 呈现策略（SD-04 · 反三宿主）
 * 内容宿主 **产品默认互斥**（见 `presentationMode.ts`）：
 * | PresentationMode | content-row 全量 | PaperList | 产品默认 |
 * |------------------|------------------|-----------|----------|
 * | `react-rows`     | ✓                | ✗         | 未开 paperList |
 * | `paper-list`     | ✗                | ✓         | 点名 paperList |
 * | `debug-dual`     | ✓                | ✓         | **否**（调试） |
 *
 * chrome 槽 `[data-bp-chrome-mount]` 与 content 槽 **分槽共存**，不计入互斥。
 *
 * ## 诚实边界（钉死）
 * - **可演示 ≠ EL-01 / EL-08 关闭**；挂载冒充交付 = S5
 * - 本组件 **要求** 注入 `hydrateTransport`（禁止静默假段落）
 * - **≠ 打开完成**（G-HYD）；**禁止** import 行级 EditorStore
 * - **W3-G PaperList**：仅窗口 DOM；**≠ EL-01**；**≠ W3-P**
 * - chrome DomMount 分槽共存不互删
 * - **CONN-B slash 写锥**：`slashIntentSink` 注入 → 可写；未注 → **只读 catalog**
 *   （`data-slash-write-mode`）；禁止「可点无写」静默。**≠ EL-01**；**≠ A-BLK-02 e2e**
 *
 * surface = note-paper
 */

import React, {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  BlockChromeModel,
  SlashMenuModel,
  type BlockChromeDomHost,
  type IntentSink,
  type PaperList,
  type PaperListScrollState,
  type PaperListWindowState,
  type SlashInsertIntent,
} from '@crish/block-paper';
/** DomHost chrome 皮；≠ EL-01 */
import '@crish/block-paper/chrome.css';
/** W3-G PaperList 挂载皮；≠ EL-01 */
import '@crish/block-paper/paper-list.css';
import { BlockChromeDomMount } from './BlockChromeDomMount';
import { NotePaperStrictBody } from './NotePaperStrictBody';
import { PaperListDomMount } from './PaperListDomMount';
import {
  SlashMenuOverlay,
  type SlashOverlayWriteMode,
} from './SlashMenuOverlay';
import { Button } from '../ui';
import { EDITOR_SURFACE_NOTE_PAPER } from './editorSurface';
import type { NoteHydrateTransport } from './hydrateProjection';
import {
  resolvePresentationMode,
  showPaperListContent,
  showReactContentRows,
  type PresentationMode,
} from './presentationMode';
import { useNoteHydrate } from './useNoteHydrate';
import {
  W5B_STRICT_BOUNDARY,
  W5B_STRICT_PACKAGE_ID,
  W5B_STRICT_TRACK,
} from './w5bStrict';
import { MirrorDriftStatusBar } from './MirrorDriftStatusBar';
import type {
  MirrorDriftReportView,
  MirrorWatchSource,
  ThreeWayDecision,
} from './mirrorDriftUi';
import type { ProductSlashSinkSource } from './productSlashSink';
import styles from './NotePaperPanel.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Strict 上可点名挂载的 PaperList 配置（W3-G 产品挂载子集）。
 * **≠ EL-01**；**≠ W3-P**。
 * 产品默认：开启 paperList 时走 `paper-list`（**不**再默认同屏 content-row）。
 */
export type NotePaperStrictPaperListConfig = {
  window?: PaperListWindowState;
  scroll?: PaperListScrollState;
  overscan?: number;
  focusId?: string | null;
  composingIds?: readonly string[];
  defaultVisibleCount?: number;
  defaultEstimatePx?: number;
  /**
   * 内容呈现模式（SD-04）。优先于 `keepReactRows`。
   * 省略：产品默认 `paper-list`（与 content-row 互斥）。
   */
  presentationMode?: PresentationMode;
  /**
   * @deprecated 请用 `presentationMode`。
   * `true` → `debug-dual`；`false` → `paper-list`。
   * @see PresentationMode / `presentationMode`
   * @removeWhen 调用方全部迁到 `presentationMode` 后删除
   */
  keepReactRows?: boolean;
};

export type NotePaperStrictPanelProps = {
  docId: string;
  /**
   * **必填**：hydrate 通路。产品空态由外层注入；禁止静默回落假数据。
   */
  hydrateTransport: NoteHydrateTransport;
  refreshToken?: number | string;
  chrome?: BlockChromeModel;
  slashMenu?: SlashMenuModel;
  /**
   * slash 选中后的 Intent sink。
   * 注入 → 可写；未注 → 默认只读 catalog（CONN-B；禁止可点无写）。
   */
  slashIntentSink?: IntentSink;
  /**
   * slash 写模式覆盖。默认：有 sink → writable；无 → readonly。
   */
  slashWriteMode?: SlashOverlayWriteMode;
  /**
   * 写锥能力来源诚实标注（`data-slash-sink-source`）。
   * 默认：有 sink → injected-sink；无 → none。
   */
  slashSinkSource?: ProductSlashSinkSource;
  /**
   * 是否展示「打开斜杠菜单」产品入口（默认 true）。
   * 锚定首块 / 占位锚点 → menu.open；**≠** 完整 `/` 键 IME 路径。
   */
  showOpenSlashButton?: boolean;
  onSlashIntent?: (intent: SlashInsertIntent) => void;
  /** DomHost 就绪；**≠ EL-01** */
  onChromeDomHost?: (host: BlockChromeDomHost | null) => void;
  /**
   * W3-G PaperList 可点名挂载。
   * - 省略：内容模式 `react-rows`
   * - true / 对象：产品默认内容模式 `paper-list`（互斥 content-row）
   * 与 chrome **分槽共存**（data-bp-paper-list-mount ∥ data-bp-chrome-mount）。
   */
  paperList?: boolean | NotePaperStrictPaperListConfig;
  /**
   * 面板级内容呈现模式覆盖（SD-04）。
   * 优先于 paperList 配置内 mode / keepReactRows。
   */
  presentationMode?: PresentationMode;
  onPaperListReady?: (list: PaperList | null) => void;
  onClose?: () => void;
  className?: string;
  title?: string;
  /** A-INV-02 方向；**≠ EL-03**；**≠ A-INV-02 全关** */
  mirrorDriftReport?: MirrorDriftReportView | null;
  mirrorWatchSource?: MirrorWatchSource;
  mirrorUnpushedOpCount?: number;
  showMirrorDriftBar?: boolean;
  onMirrorThreeWay?: (decision: ThreeWayDecision) => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
  showOpenSlashButton = true,
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
  const slashWriteMode: SlashOverlayWriteMode =
    slashWriteModeProp ?? (slashIntentSink ? 'writable' : 'readonly');
  const slashSinkSource: ProductSlashSinkSource =
    slashSinkSourceProp ?? (slashIntentSink ? 'injected-sink' : 'none');
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

  /**
   * CONN-C · C-X1：chrome focus → PaperList pin（至少一方向）。
   * - chrome.focusedBlockId 优先驱动 list pin（窗外 pin 保留 DOM）
   * - 无 chrome 焦点时回落 paperListConfig.focusId（props 手工注入仍可用）
   * **≠ W3-P WindowManager**；**≠ EL-01**
   */
  const paperListFocusId =
    snapshot.focusedBlockId ?? paperListConfig.focusId ?? null;

  /** 产品路径：打开 slash 菜单（锚定首块或占位 id） */
  const openSlashMenu = useCallback(() => {
    const anchorId = blocks[0]?.id ?? `slash-anchor-${docId}`;
    const opened = slashMenu.open(anchorId, 0);
    if (opened.ok) {
      bump();
    }
  }, [blocks, docId, slashMenu, bump]);

  const rootClass = [styles.panel, className].filter(Boolean).join(' ');

  return (
    <section
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
      data-source="hydrate"
      data-hydrate-source={hydrateSource}
      data-hydrate-status={status}
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
      <header className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        <div className={styles.meta}>
          <span
            className={styles.badgeSilent}
            data-testid="note-paper-strict-track"
          >
            {W5B_STRICT_PACKAGE_ID}/{W5B_STRICT_TRACK}
          </span>
          <span className={styles.badge} data-testid="note-paper-strict-rev">
            rev={resolvedRev}
          </span>
          <span className={styles.badge} data-testid="note-paper-strict-count">
            {blocks.length} 块
          </span>
          <span
            className={styles.badge}
            data-testid="note-paper-strict-slash-mode"
            data-slash-write-mode={slashWriteMode}
            title={
              slashWriteMode === 'readonly'
                ? 'slash 只读（未接 apply；≠假写）'
                : 'slash 可写（Intent → sink）'
            }
          >
            slash={slashWriteMode}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.badge}
            onClick={() => {
              void reload();
            }}
            aria-label="重新 hydrate 投影"
            data-testid="note-paper-strict-refresh"
          >
            刷新
          </Button>
          {showOpenSlashButton ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.badge}
              onClick={openSlashMenu}
              aria-label={
                slashWriteMode === 'readonly'
                  ? '打开斜杠菜单（只读 catalog；未接 apply）'
                  : '打开斜杠菜单'
              }
              data-testid="note-paper-strict-open-slash"
              data-slash-write-mode={slashWriteMode}
            >
              /
            </Button>
          ) : null}
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.badge}
              onClick={onClose}
              aria-label="关闭 Strict 笔记纸面"
              data-testid="note-paper-strict-close"
            >
              关闭
            </Button>
          ) : null}
        </div>
      </header>

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
        {/*
          内容宿主 B：W3-G PaperList。
          槽锚 data-bp-paper-list-mount；仅 paper-list / debug-dual。
          与 chrome 分槽同屏不互删；≠ EL-01；≠ W3-P。
        */}
        {renderPaperList && status === 'ready' ? (
          <PaperListDomMount
            blocks={blocks.map((b) => ({
              id: b.id,
              flavour: b.flavour,
              text: b.text,
            }))}
            window={paperListConfig.window}
            scroll={paperListConfig.scroll}
            overscan={paperListConfig.overscan}
            focusId={paperListFocusId}
            composingIds={paperListConfig.composingIds}
            defaultVisibleCount={paperListConfig.defaultVisibleCount}
            defaultEstimatePx={paperListConfig.defaultEstimatePx}
            onListReady={onPaperListReady}
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
          slash={slashMenu}
          projectSlashCatalog={false}
          syncToken={`${chromeTick}:${slashOpen}`}
          onHostReady={onChromeDomHost}
          testId="note-paper-strict-chrome-dom"
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
