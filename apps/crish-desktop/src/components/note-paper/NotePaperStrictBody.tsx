/**
 * NotePaperStrictBody — Strict 轨 readingColumn 内容区（SD-04 拆分）
 *
 * 承载 hydrate 三态 UI + 内容宿主 A（react-rows）。
 * PaperList / chrome / slash 仍由面板编排（分槽契约）。
 *
 * ≠ EL-01；投影 ≠ 权威。
 */

import React from 'react';
import type { BlockChromeModel, HandleVisibility } from '@crish/block-paper';
import type { HydratedBlockProjection } from './hydrateProjection';
import type { HydrateUiStatus } from './useNoteHydrate';
import styles from './NotePaperPanel.module.css';

export type NotePaperStrictBodyProps = {
  status: HydrateUiStatus;
  errorReason: string | null;
  errorCode: string | null;
  blocks: readonly HydratedBlockProjection[];
  /** 是否渲染 React 全量 content-row（react-rows | debug-dual） */
  renderReactRows: boolean;
  chrome: BlockChromeModel;
  onHover: (blockId: string | null) => void;
  onFocus: (blockId: string | null) => void;
  /** 内容宿主 B / chrome / slash 等兄弟槽（由面板传入） */
  children?: React.ReactNode;
};

/**
 * loading / error / empty / ready(content-row) + children 槽。
 */
export const NotePaperStrictBody: React.FC<NotePaperStrictBodyProps> = ({
  status,
  errorReason,
  errorCode,
  blocks,
  renderReactRows,
  chrome,
  onHover,
  onFocus,
  children,
}) => {
  return (
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

        {/*
          内容宿主 A：React 全量 content-row。
          仅 react-rows / debug-dual；与 paper-list 产品路径互斥（SD-04）。
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
                  onMouseEnter={() => onHover(block.id)}
                  onMouseLeave={() => onHover(null)}
                  onFocus={() => onFocus(block.id)}
                  onBlur={() => onFocus(null)}
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

        {children}
      </div>
    </div>
  );
};

export default NotePaperStrictBody;
