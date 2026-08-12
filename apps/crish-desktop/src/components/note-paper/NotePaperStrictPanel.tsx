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
 * ## 诚实边界（钉死 · 08 §0.2 / 20 L3–L4 · R10）
 * - **可演示 ≠ EL-01 / EL-08 关闭**
 * - **≠ W5-C 隔离全关**（A-SURF 真扫主责）
 * - **挂载冒充交付 = S5**
 * - 本组件 **要求** 注入 `hydrateTransport`（禁止静默假段落）
 * - 产品空态默认由 `createProductStrictHydrateTransport` 选型：
 *   可检测 Tauri → `tauri-ipc`；无 Tauri → fixture（**fixture ≠ 生产权威**）
 * - **≠ 打开完成**（G-HYD 全条件）；**≠ EL-04/01**
 * - 后端默认 `hydrate_path=doc-session`；产品关账仍依赖 G-HYD 全条件
 * - **禁止** import 行级 EditorStore；投影 ≠ 文档权威
 * - **W3-G PaperList**（`paperList` 可点名挂载）：仅窗口 DOM；**≠ EL-01**；
 *   **≠ W3-P WindowManager 全闭环**；与 chrome DomMount **分槽共存不互删**
 * - **A-INV-02 UI 方向**：可选 `mirrorDriftReport` → 状态条 + 三路入口；
 *   底层可能仍是 poll/OS 事件；**≠ inotify 满关**；**≠ EL-03**；**≠ A-INV-02 全关**
 *
 * surface = note-paper
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  BlockChromeModel,
  SlashMenuModel,
  type BlockChromeDomHost,
  type HandleVisibility,
  type IntentSink,
  type PaperList,
  type PaperListScrollState,
  type PaperListWindowState,
  type SlashInsertIntent,
} from '@crish/block-paper';
/** DomHost chrome 皮（与 Skeleton 同源）；≠ EL-01 */
import '@crish/block-paper/chrome.css';
/** W3-G PaperList 挂载皮（与 Skeleton 同源）；≠ EL-01 */
import '@crish/block-paper/paper-list.css';
import { BlockChromeDomMount } from './BlockChromeDomMount';
import { PaperListDomMount } from './PaperListDomMount';
import { SlashMenuOverlay } from './SlashMenuOverlay';
import { Button } from '../ui';
import { EDITOR_SURFACE_NOTE_PAPER } from './editorSurface';
import type {
  DocHydrateProjection,
  HydratedBlockProjection,
  NoteHydrateTransport,
} from './hydrateProjection';
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
import styles from './NotePaperPanel.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Strict 上可点名挂载的 PaperList 配置（W3-G 产品挂载子集）。
 * hydrate 成功后的 blocks 驱动 order/projections。
 *
 * **≠ EL-01**；**≠ W3-P WindowManager 全闭环**。
 */
export type NotePaperStrictPaperListConfig = {
  /** 索引窗口（与 scroll 二选一） */
  window?: PaperListWindowState;
  /** 滚动态（优先于 window） */
  scroll?: PaperListScrollState;
  overscan?: number;
  focusId?: string | null;
  composingIds?: readonly string[];
  defaultVisibleCount?: number;
  defaultEstimatePx?: number;
  /**
   * 启用 PaperList 时是否仍渲染 React 全量块行。
   * - `true`（默认）：小投影双轨呈现（内容行 + 列表槽）
   * - `false`：仅 PaperList 窗口 DOM 承载内容（大文档 / 结构门测）
   */
  keepReactRows?: boolean;
};

export type NotePaperStrictPanelProps = {
  /** 文档 id（hydrate 入参） */
  docId: string;
  /**
   * **必填**：hydrate 通路（fixture / note-transport / tauri-ipc）。
   * 产品空态默认由外层 `createProductStrictHydrateTransport` 注入；
   * 不提供则无法挂载 Strict 轨——禁止静默回落假数据。
   */
  hydrateTransport: NoteHydrateTransport;
  /**
   * 变更时重新 hydrate（演示写后刷新 / 外部触发）。
   */
  refreshToken?: number | string;
  /** 可选：外部 chrome（测试用） */
  chrome?: BlockChromeModel;
  /**
   * 可选：外部 slash 模型（测试打开 slash 宿主 / React 浮层）。
   * 未传时内部 new SlashMenuModel()。
   */
  slashMenu?: SlashMenuModel;
  /**
   * slash 选中后的 Intent sink（可选）。
   * 注入时 React 浮层点击 → selectSlashItemAndSubmit → sink。
   */
  slashIntentSink?: IntentSink;
  /** slash 产出 Intent 后回调 */
  onSlashIntent?: (intent: SlashInsertIntent) => void;
  /**
   * DomHost 就绪回调（W3-F DOM 桌面挂载子集）。
   * **≠ EL-01**；真 Pointer 拖拽全链后置。
   */
  onChromeDomHost?: (host: BlockChromeDomHost | null) => void;
  /**
   * **W3-G PaperList 可点名挂载**（产品路径）。
   * - `false` / 省略：不挂列表槽（默认，现有 React 块行）
   * - `true`：默认窗口可见块挂载
   * - 对象：window / scroll / overscan 等可测参数
   *
   * 与 `BlockChromeDomMount` **分槽共存**（`data-bp-paper-list-mount` ∥
   * `data-bp-chrome-mount`），同屏不互删。
   * **≠ EL-01**；**≠ W3-P**。
   */
  paperList?: boolean | NotePaperStrictPaperListConfig;
  /**
   * PaperList 宿主就绪回调（测试拿 countDomBlocks / setScroll）。
   */
  onPaperListReady?: (list: PaperList | null) => void;
  /** 可选：关闭回调 */
  onClose?: () => void;
  /** 额外 className */
  className?: string;
  /** 面板标题 */
  title?: string;
  /**
   * A-INV-02 方向：注入镜像漂移报告（可选）。
   * 有值时在 footer 上挂 `MirrorDriftStatusBar`；
   * **不**在本面板实现 poll/OS watcher；底层来源见 `mirrorWatchSource`。
   * **≠ EL-03**；**≠ inotify 产品满关**；**≠ A-INV-02 全关**。
   */
  mirrorDriftReport?: MirrorDriftReportView | null;
  /**
   * 镜像检测来源诚实标注（poll / os_event / injected）。
   * 仅当展示镜像状态条时生效。
   */
  mirrorWatchSource?: MirrorWatchSource;
  /** unpushed op 数（X-05 门禁；默认 0） */
  mirrorUnpushedOpCount?: number;
  /**
   * 是否强制展示镜像状态条（即使无 report，展示 idle）。
   * 默认：仅当 `mirrorDriftReport != null` 时展示。
   */
  showMirrorDriftBar?: boolean;
  /** 三路决策回调（骨架；不直接 apply） */
  onMirrorThreeWay?: (decision: ThreeWayDecision) => void;
};

type HydrateUiStatus = 'loading' | 'ready' | 'empty' | 'error';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Strict 轨笔记纸面：只读 hydrate 投影列表 + L0 静默 chrome。
 * 写路径须经 Intent 桥；本组件 **不** 接行级 store / EditorStore。
 */
export const NotePaperStrictPanel: React.FC<NotePaperStrictPanelProps> = ({
  docId,
  hydrateTransport,
  refreshToken = 0,
  chrome: chromeProp,
  slashMenu: slashMenuProp,
  slashIntentSink,
  onSlashIntent,
  onChromeDomHost,
  paperList: paperListProp,
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
  const keepReactRows = paperListConfig.keepReactRows !== false;
  const chrome = useMemo(
    () => chromeProp ?? new BlockChromeModel(),
    [chromeProp]
  );
  const slashMenu = useMemo(
    () => slashMenuProp ?? new SlashMenuModel(),
    [slashMenuProp]
  );
  /** React slash 浮层：订阅 model 变更以同步 data-slash-open */
  const slashOpen = useSyncExternalStore(
    (onStoreChange) => slashMenu.subscribe(onStoreChange),
    () => (slashMenu.isOpen() ? '1' : '0'),
    () => '0'
  );

  const [status, setStatus] = useState<HydrateUiStatus>('loading');
  const [projection, setProjection] = useState<DocHydrateProjection | null>(
    null
  );
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setErrorReason(null);
    setErrorCode(null);
    try {
      const outcome = await hydrateTransport.hydrate(docId);
      if (!outcome.ok) {
        setProjection(null);
        setErrorReason(outcome.reason);
        setErrorCode(outcome.code);
        setStatus('error');
        return;
      }
      setProjection(outcome.projection);
      setStatus(outcome.projection.blocks.length === 0 ? 'empty' : 'ready');
    } catch (e) {
      // transport 契约应返回 ok:false；若仍抛，收成错误态（零半写 UI）
      setProjection(null);
      setErrorReason(e instanceof Error ? e.message : String(e));
      setErrorCode('note.hydrate_throw');
      setStatus('error');
    }
  }, [hydrateTransport, docId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const blocks: HydratedBlockProjection[] = projection?.blocks ?? [];
  const resolvedRev = projection?.rev ?? 0;
  const hydrateSource = projection?.source ?? 'none';

  const [chromeTick, setChromeTick] = useState(0);
  const bump = useCallback(() => setChromeTick((n) => n + 1), []);
  const snapshot = useMemo(() => {
    void chromeTick;
    return chrome.getSnapshot();
  }, [chrome, chromeTick]);

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
      data-source="hydrate"
      data-hydrate-source={hydrateSource}
      data-hydrate-status={status}
      data-transport-loading={status === 'loading' ? 'true' : 'false'}
      data-paper-list={paperListEnabled ? '1' : '0'}
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.badge}
            onClick={() => {
              void load();
            }}
            aria-label="重新 hydrate 投影"
            data-testid="note-paper-strict-refresh"
          >
            刷新
          </Button>
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

      <div className={styles.body} data-testid="note-paper-strict-body">
        <div className={styles.readingColumn}>
          {status === 'loading' ? (
            <div
              className={`${styles.state} ${styles.stateLoading}`}
              data-testid="note-paper-strict-loading"
              role="status"
              aria-live="polite"
            >
              正在 hydrate 投影…
            </div>
          ) : null}

          {status === 'error' ? (
            <div
              className={`${styles.state} ${styles.stateError}`}
              role="alert"
              data-testid="note-paper-strict-error"
              data-error-code={errorCode ?? ''}
            >
              {errorReason ?? 'hydrate 失败'}
            </div>
          ) : null}

          {status === 'empty' ? (
            <div
              className={`${styles.state} ${styles.stateEmpty}`}
              data-testid="note-paper-strict-empty"
            >
              空文档投影（hydrate 成功 · 0 块）
            </div>
          ) : null}

          {status === 'ready' && keepReactRows
            ? blocks.map((block) => {
                const visibility: HandleVisibility = chrome.getHandleVisibility(
                  block.id
                );
                const level =
                  typeof block.props?.level === 'number'
                    ? block.props.level
                    : undefined;
                return (
                  <div
                    key={block.id}
                    className={styles.blockRow}
                    data-block-id={block.id}
                    data-content-row="1"
                    data-block-index={String(block.index)}
                    data-handle={visibility}
                    data-flavour={block.flavour}
                    data-heading-level={
                      level !== undefined ? String(level) : undefined
                    }
                    data-testid={`note-strict-block-${block.id}`}
                    tabIndex={0}
                    onMouseEnter={() => handleHover(block.id)}
                    onMouseLeave={() => handleHover(null)}
                    onFocus={() => handleFocus(block.id)}
                    onBlur={() => handleFocus(null)}
                  >
                    <span
                      className={styles.handle}
                      data-testid={`note-strict-handle-${block.id}`}
                      aria-hidden
                    />
                    <div className={styles.blockContent}>
                      <span className={styles.flavour}>
                        {block.flavour}
                        {level !== undefined ? ` h${level}` : ''}
                      </span>
                      <div className={styles.text}>{block.text ?? ''}</div>
                    </div>
                  </div>
                );
              })
            : null}
          {/*
            W3-G PaperList 产品挂载（可点名）：hydrate 投影 → 仅窗口 DOM。
            分槽：data-bp-paper-list-mount；与 chrome 槽同屏不互删。
            ≠ EL-01；≠ W3-P WindowManager 全闭环。
          */}
          {paperListEnabled && status === 'ready' ? (
            <PaperListDomMount
              blocks={blocks.map((b) => ({
                id: b.id,
                flavour: b.flavour,
                text: b.text,
              }))}
              window={paperListConfig.window}
              scroll={paperListConfig.scroll}
              overscan={paperListConfig.overscan}
              focusId={paperListConfig.focusId}
              composingIds={paperListConfig.composingIds}
              defaultVisibleCount={paperListConfig.defaultVisibleCount}
              defaultEstimatePx={paperListConfig.defaultEstimatePx}
              onListReady={onPaperListReady}
              testId="note-paper-strict-paper-list"
            />
          ) : null}
          {/*
            真 React slash 浮层（catalog 可点 → Intent → sink）。
            DomHost 关 catalog 投影防双层。≠ EL-01；≠ A-BLK-02 e2e 满关。
          */}
          <SlashMenuOverlay
            menu={slashMenu}
            sink={slashIntentSink}
            syncToken={chromeTick}
            className={styles.slashOverlay}
            onSelectIntent={onSlashIntent}
            testId="note-paper-strict-slash-overlay"
          />
          {/*
            W3-F DOM 桌面挂载：BlockChromeDomHost → data-bp-* 契约
            （把手/落点线；slash catalog 由 React 浮层接管）。≠ EL-01。
            与 PaperList **分槽共存**（data-bp-chrome-mount ∥ data-bp-paper-list-mount）。
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
        </div>
      </div>

      {/*
        A-INV-02 方向子集：镜像漂移状态 + 三路入口骨架。
        默认仅当注入 mirrorDriftReport 时展示；不实现 poll/OS watcher。
        ≠ EL-03；≠ inotify 产品满关；X-05 由 MirrorDriftStatusBar 门禁。
      */}
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
