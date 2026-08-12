/**
 * NotePaperPanelChrome — W5-B-S Skeleton chrome 装配（SD-25）
 *
 * Header / 静默行 / slash 浮层 / DomHost / footer。
 * 包锚 `data-package-id` 仍由 `NotePaperPanel` 钉 `W5-B-S`。
 *
 * **≠ W5-B Strict**（无 hydrate 三态 / 无 PaperList 内容槽）
 * **≠ 任何 EL**；DomHost 关 catalog 投影防双层。
 */

import React from 'react';
import type {
  BlockChromeDomHost,
  BlockChromeModel,
  HandleVisibility,
  IntentSink,
  SlashInsertIntent,
  SlashMenuModel,
} from '@crish/block-paper';
import { BlockChromeDomMount } from './BlockChromeDomMount';
import { SlashMenuOverlay } from './SlashMenuOverlay';
import { Button } from '../ui';
import { EDITOR_SURFACE_NOTE_PAPER } from './editorSurface';
import { W5B_SKELETON_BOUNDARY } from './w5bSkeleton';
import {
  resolveSkeletonHeadingLevel,
  type DisplayBlock,
} from './notePaperSilentFixture';
import styles from './NotePaperPanel.module.css';

export type NotePaperPanelChromeProps = {
  title: string;
  silentLevel: string;
  resolvedRev: number;
  displayBlocks: readonly DisplayBlock[];
  useTransport: boolean;
  transportError: string | null;
  chrome: BlockChromeModel;
  slashMenu: SlashMenuModel;
  slashIntentSink?: IntentSink;
  onSlashIntent?: (intent: SlashInsertIntent) => void;
  onChromeDomHost?: (host: BlockChromeDomHost | null) => void;
  onRefresh?: () => void;
  onClose?: () => void;
  chromeTick: number;
  slashOpen: string;
  onHover: (blockId: string | null) => void;
  onFocus: (blockId: string | null) => void;
};

/**
 * Skeleton 预览壳内层：元信息 + 只读行 + chrome 槽。
 */
export const NotePaperPanelChrome: React.FC<NotePaperPanelChromeProps> = ({
  title,
  silentLevel,
  resolvedRev,
  displayBlocks,
  useTransport,
  transportError,
  chrome,
  slashMenu,
  slashIntentSink,
  onSlashIntent,
  onChromeDomHost,
  onRefresh,
  onClose,
  chromeTick,
  slashOpen,
  onHover,
  onFocus,
}) => {
  return (
    <>
      <header className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        <div className={styles.meta}>
          <span className={styles.badgeSilent} data-testid="note-paper-silent">
            silent={silentLevel}
          </span>
          <span className={styles.badge} data-testid="note-paper-rev">
            rev={resolvedRev}
          </span>
          <span className={styles.badge} data-testid="note-paper-count">
            {displayBlocks.length} 块
          </span>
          {useTransport ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.badge}
              onClick={() => {
                onRefresh?.();
              }}
              aria-label="从 transport 刷新块列表"
              data-testid="note-paper-refresh"
            >
              刷新
            </Button>
          ) : null}
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.badge}
              onClick={onClose}
              aria-label="关闭笔记纸面预览"
              data-testid="note-paper-close"
            >
              关闭
            </Button>
          ) : null}
        </div>
      </header>

      <div className={styles.body} data-testid="note-paper-body">
        <div className={styles.readingColumn}>
          {transportError ? (
            <div
              className={`${styles.state} ${styles.stateError}`}
              role="alert"
              data-testid="note-paper-transport-error"
            >
              {transportError}
            </div>
          ) : null}
          {displayBlocks.length === 0 && !transportError ? (
            <div
              className={`${styles.state} ${styles.stateEmpty}`}
              data-testid="note-paper-empty"
            >
              {useTransport
                ? '空文档投影（transport 无块）'
                : '空文档投影（静默假数据 n=0）'}
            </div>
          ) : (
            displayBlocks.map((block) => {
              const visibility: HandleVisibility = chrome.getHandleVisibility(
                block.id
              );
              const headingLevel = resolveSkeletonHeadingLevel(block);
              return (
                <div
                  key={block.id}
                  className={styles.blockRow}
                  data-block-id={block.id}
                  data-content-row="1"
                  data-handle={visibility}
                  data-flavour={block.flavour}
                  data-heading-level={
                    headingLevel !== undefined
                      ? String(headingLevel)
                      : undefined
                  }
                  data-testid={`note-block-${block.id}`}
                  tabIndex={0}
                  onMouseEnter={() => onHover(block.id)}
                  onMouseLeave={() => onHover(null)}
                  onFocus={() => onFocus(block.id)}
                  onBlur={() => onFocus(null)}
                >
                  <span
                    className={styles.handle}
                    data-testid={`note-handle-${block.id}`}
                    aria-hidden
                  />
                  <div className={styles.blockContent}>
                    <span className={styles.flavour}>
                      {block.flavour}
                      {block.level !== undefined ? ` h${block.level}` : ''}
                    </span>
                    <div className={styles.text}>{block.text}</div>
                  </div>
                </div>
              );
            })
          )}
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
            testId="note-paper-slash-overlay"
          />
          {/*
            W3-F DOM 桌面挂载：BlockChromeDomHost → data-bp-* 契约
            （把手/落点线；slash catalog 由 React 浮层接管）。≠ EL-01。
          */}
          <BlockChromeDomMount
            blocks={displayBlocks.map((b) => ({
              blockId: b.id,
              flavour: b.flavour,
            }))}
            chrome={chrome}
            slash={slashMenu}
            projectSlashCatalog={false}
            syncToken={`${chromeTick}:${slashOpen}`}
            onHostReady={onChromeDomHost}
            testId="note-paper-chrome-dom"
          />
        </div>
      </div>

      <footer className={styles.footer} data-testid="note-paper-footer">
        surface={EDITOR_SURFACE_NOTE_PAPER} · {W5B_SKELETON_BOUNDARY}
        {useTransport ? ' · 半 transport 投影' : ' · 静默假数据'}
      </footer>
    </>
  );
};
