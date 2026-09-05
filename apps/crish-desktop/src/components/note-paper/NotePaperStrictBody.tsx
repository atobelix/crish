/**
 * NotePaperStrictBody — Strict 轨 readingColumn 内容区（SD-04 拆分）
 *
 * 承载 hydrate 三态 UI + 内容宿主 A（react-rows）。
 * PaperList / chrome / slash 仍由面板编排（分槽契约）。
 *
 * CONN-D3：content-row 正文经 `StrictContentRowLeaf` → mdPrefix 产品路径
 *（有 sink 可写；无 → disabled 静态；≠ EL-01；UI 不读 pending 当 kind）。
 *
 * ≠ EL-01；投影 ≠ 权威。
 */

import React from 'react';
import type {
  BlockChromeModel,
  HandleVisibility,
  TurnIntoIntent,
  TurnIntoSink,
} from '@crish/block-paper';
import type { HydratedBlockProjection } from './hydrateProjection';
import type {
  ProductMdPrefixBinding,
  ProductMdPrefixCommitResult,
  ProductMdPrefixSinkSource,
  ProductMdPrefixWriteMode,
} from './noteMdPrefixBridge';
import { StrictContentRowLeaf } from './StrictContentRowLeaf';
import type { HydrateUiStatus } from './useNoteHydrate';
import styles from './NotePaperPanel.module.css';

/**
 * MD 前缀写锥域（T4-9c Props 收敛：6 字段 → 1 对象）。
 * 无 sink → 叶 disabled 静态（CONN-D3）。
 */
export type NotePaperStrictBodyMdPrefix = {
  turnIntoSink?: TurnIntoSink;
  mdPrefixWriteMode?: ProductMdPrefixWriteMode;
  mdPrefixSinkSource?: ProductMdPrefixSinkSource;
  mdPrefixBinding?: ProductMdPrefixBinding;
  onMdPrefixCommit?: (result: ProductMdPrefixCommitResult) => void;
  onMdPrefixCommittedIntent?: (intent: TurnIntoIntent) => void;
};

export type NotePaperStrictBodyProps = {
  status: HydrateUiStatus;
  errorReason: string | null;
  errorCode: string | null;
  blocks: readonly HydratedBlockProjection[];
  /** 是否渲染 React 全量 content-row（react-rows | debug-dual） */
  renderReactRows: boolean;
  chrome: BlockChromeModel;
  onHover?: (blockId: string | null) => void;
  onFocus?: (blockId: string | null) => void;
  /** CONN-D3：MD 前缀写锥域 */
  mdPrefix?: NotePaperStrictBodyMdPrefix;
  /**
   * CT-01 对象级 rev（R7 收口接线，主控裁决③）：hydrate 投影的文档 rev，
   * 透传给块域编辑会话 open 记账（无真实 rev 时保持 undefined 占位）。
   */
  baseRev?: number;
  /** 内容宿主 B / chrome / slash 等兄弟槽（由面板传入） */
  children?: React.ReactNode;
  /** 空笔记态点击空白区域初始化首行回调 */
  onInitFirstBlock?: () => void;
  /** 块文本变更回调 */
  onBlockChange?: (blockId: string, newText: string) => void;
  /** 块文本失焦提交回调 */
  onTextCommit?: (blockId: string, newText: string) => void;
};

/**
 * loading / error / empty / ready(content-row) + children 槽。
 */
export const NotePaperStrictBody = React.forwardRef<
  HTMLDivElement,
  NotePaperStrictBodyProps
>(function NotePaperStrictBody(
  {
    status,
    errorReason,
    errorCode,
    blocks,
    renderReactRows,
    chrome,
    onHover: _onHover,
    onFocus: _onFocus,
    mdPrefix,
    baseRev,
    children,
    onInitFirstBlock,
    onBlockChange,
    onTextCommit,
  },
  ref
) {
  const [emptyInitRow, setEmptyInitRow] = React.useState(false);
  const firstBlockRef = React.useRef<HTMLDivElement | null>(null);

  // 状态变更时若离开 empty 则复位
  React.useEffect(() => {
    if (status !== 'empty') {
      setEmptyInitRow(false);
    }
  }, [status]);

  const handleEmptyAreaClick = React.useCallback(
    (e: React.MouseEvent) => {
      if (status !== 'empty') return;
      if (
        emptyInitRow &&
        e.target instanceof HTMLElement &&
        e.target.closest('[contenteditable="true"]')
      ) {
        return;
      }
      onInitFirstBlock?.();
      setEmptyInitRow(true);
    },
    [status, emptyInitRow, onInitFirstBlock]
  );

  React.useEffect(() => {
    if (!emptyInitRow || status !== 'empty') {
      return;
    }
    const timer = setTimeout(() => {
      const leaf =
        firstBlockRef.current?.querySelector<HTMLElement>(
          '[contenteditable="true"]'
        ) ?? firstBlockRef.current;
      if (leaf) {
        leaf.focus();
        try {
          const sel = window.getSelection?.();
          if (sel) {
            const range = document.createRange();
            range.selectNodeContents(leaf);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          }
        } catch {
          // ignore in jsdom
        }
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [emptyInitRow, status]);

  return (
    <div ref={ref} className={styles.body} data-testid="note-paper-strict-body">
      <div
        className={styles.readingColumn}
        onClick={status === 'empty' ? handleEmptyAreaClick : undefined}
      >
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
          emptyInitRow ? (
            <div
              ref={firstBlockRef}
              className={styles.blockRow}
              data-block-id="init-first-block"
              data-content-row="1"
              data-block-index="0"
              data-flavour="paragraph"
              data-testid="note-strict-block-init-first-block"
              tabIndex={0}
            >
              <span
                className={styles.handle}
                data-testid="note-strict-handle-init-first-block"
                aria-hidden
              />
              <div className={styles.blockContent}>
                <span className={styles.flavour}>paragraph</span>
                <StrictContentRowLeaf
                  blockId="init-first-block"
                  flavour="paragraph"
                  text=""
                  baseRev={baseRev}
                  turnIntoSink={mdPrefix?.turnIntoSink}
                  mdPrefixWriteMode={mdPrefix?.mdPrefixWriteMode ?? 'writable'}
                  mdPrefixSinkSource={mdPrefix?.mdPrefixSinkSource}
                  mdPrefixBinding={
                    mdPrefix?.mdPrefixBinding ?? {
                      mode:
                        (mdPrefix?.mdPrefixWriteMode ?? 'writable') ===
                        'disabled'
                          ? 'disabled'
                          : 'writable',
                      sink: mdPrefix?.turnIntoSink,
                      collab: null,
                      source: 'injected-sink',
                    }
                  }
                  onMdPrefixCommit={mdPrefix?.onMdPrefixCommit}
                  onCommittedIntent={mdPrefix?.onMdPrefixCommittedIntent}
                  onTextChange={onBlockChange}
                  onTextCommit={onTextCommit}
                />
              </div>
            </div>
          ) : (
            <div
              className={`${styles.state} ${styles.stateEmpty}`}
              data-testid="note-paper-strict-empty"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  handleEmptyAreaClick(e as unknown as React.MouseEvent);
                }
              }}
            >
              空文档投影（hydrate 成功 · 0 块）
            </div>
          )
        ) : null}

        {/*
          内容宿主 A：React 全量 content-row。
          仅 react-rows / debug-dual；与 paper-list 产品路径互斥（SD-04）。
          CONN-D3：正文叶 → mdPrefix 桥（非静态 text）。
        */}
        {status === 'ready' && renderReactRows
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
                    <StrictContentRowLeaf
                      blockId={block.id}
                      flavour={block.flavour}
                      text={block.text ?? ''}
                      baseRev={baseRev}
                      turnIntoSink={mdPrefix?.turnIntoSink}
                      mdPrefixWriteMode={mdPrefix?.mdPrefixWriteMode}
                      mdPrefixSinkSource={mdPrefix?.mdPrefixSinkSource}
                      mdPrefixBinding={mdPrefix?.mdPrefixBinding}
                      onMdPrefixCommit={mdPrefix?.onMdPrefixCommit}
                      onCommittedIntent={mdPrefix?.onMdPrefixCommittedIntent}
                      onTextChange={onBlockChange}
                      onTextCommit={onTextCommit}
                    />
                  </div>
                </div>
              );
            })
          : null}

        {children}
      </div>
    </div>
  );
});

export default NotePaperStrictBody;
