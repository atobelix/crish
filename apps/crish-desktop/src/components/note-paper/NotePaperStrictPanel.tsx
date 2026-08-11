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
 * ## 诚实边界（钉死 · 08 §0.2 / 20 L3–L4）
 * - **可演示 ≠ EL-01 / EL-08 关闭**
 * - **≠ W5-C 隔离全关**（A-SURF 真扫主责）
 * - **挂载冒充交付 = S5**
 * - 真产品默认「打开完成」依赖 **W1-H**；本组件默认 **要求** 注入 `hydrateTransport`
 *   —— 产品 IPC 默认真路径未挂时仍算 Strict **方向**子集，不得去掉本注释
 * - **禁止** import 行级 EditorStore；投影 ≠ 文档权威
 *
 * surface = note-paper
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BlockChromeModel,
  SlashMenuModel,
  type BlockChromeDomHost,
  type HandleVisibility,
} from '@crish/block-paper';
/** DomHost chrome 皮（与 Skeleton 同源）；≠ EL-01 */
import '@crish/block-paper/chrome.css';
import { BlockChromeDomMount } from './BlockChromeDomMount';
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
import styles from './NotePaperPanel.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type NotePaperStrictPanelProps = {
  /** 文档 id（hydrate 入参） */
  docId: string;
  /**
   * **必填**：hydrate 通路（fixture / adapt(NoteTransport) / 未来真 IPC）。
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
   * 可选：外部 slash 模型（测试打开 slash 宿主）。
   * 未传时内部 new SlashMenuModel()。
   */
  slashMenu?: SlashMenuModel;
  /**
   * DomHost 就绪回调（W3-F DOM 桌面挂载子集）。
   * **≠ EL-01**；真 Pointer 拖拽全链后置。
   */
  onChromeDomHost?: (host: BlockChromeDomHost | null) => void;
  /** 可选：关闭回调 */
  onClose?: () => void;
  /** 额外 className */
  className?: string;
  /** 面板标题 */
  title?: string;
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
  onChromeDomHost,
  onClose,
  className,
  title = '笔记纸面（W5-B Strict · hydrate 投影）',
}) => {
  const chrome = useMemo(
    () => chromeProp ?? new BlockChromeModel(),
    [chromeProp]
  );
  const slashMenu = useMemo(
    () => slashMenuProp ?? new SlashMenuModel(),
    [slashMenuProp]
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
      data-slash-open={slashMenu.isOpen() ? 'true' : 'false'}
      data-source="hydrate"
      data-hydrate-source={hydrateSource}
      data-hydrate-status={status}
      data-transport-loading={status === 'loading' ? 'true' : 'false'}
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
          <button
            type="button"
            className={styles.badge}
            onClick={() => {
              void load();
            }}
            aria-label="重新 hydrate 投影"
            data-testid="note-paper-strict-refresh"
          >
            刷新
          </button>
          {onClose ? (
            <button
              type="button"
              className={styles.badge}
              onClick={onClose}
              aria-label="关闭 Strict 笔记纸面"
              data-testid="note-paper-strict-close"
            >
              关闭
            </button>
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

          {status === 'ready'
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
            W3-F DOM 桌面挂载：BlockChromeDomHost → data-bp-* 契约
            （把手/落点线/slash 宿主）；ready 时按 hydrate 块挂载。≠ EL-01。
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
            syncToken={chromeTick}
            onHostReady={onChromeDomHost}
            testId="note-paper-strict-chrome-dom"
          />
        </div>
      </div>

      <footer className={styles.footer} data-testid="note-paper-strict-footer">
        surface={EDITOR_SURFACE_NOTE_PAPER} · {W5B_STRICT_BOUNDARY}
        {projection ? ` · source=${projection.source}` : ''}
      </footer>
    </section>
  );
};

export default NotePaperStrictPanel;
