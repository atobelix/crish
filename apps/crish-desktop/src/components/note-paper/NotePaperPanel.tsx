/**
 * NotePaperPanel — Workbench 笔记纸面挂载壳（W5-B · B-01/B-02）
 *
 * surface = note-paper
 *
 * - 使用 `@crish/block-paper` 的 createSilentFixture / BlockChromeModel / SlashMenuModel
 * - **可测** 预览壳：列表块 id、静默把手状态、data-surface="note-paper"
 * - **禁止** import 行级 EditorStore / markdown-editor store
 * - 挂载 ≠ EL-01/EL-08 关闭；假数据投影 ≠ 文档权威
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  BlockChromeModel,
  createSilentFixture,
  listSilentBlocks,
  SlashMenuModel,
  type HandleVisibility,
  type SilentFixture,
} from '@crish/block-paper';
import { EDITOR_SURFACE_NOTE_PAPER } from './editorSurface';
import styles from './NotePaperPanel.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type NotePaperPanelProps = {
  /** 文档 id（投影 / 假数据）；默认 silent-doc */
  docId?: string;
  /** 静默假数据块数；默认 8 */
  blockCount?: number;
  /** 可选：外部注入 fixture（测试用） */
  fixture?: SilentFixture;
  /** 可选：外部 chrome（测试用） */
  chrome?: BlockChromeModel;
  /** 可选：关闭 / 收起回调 */
  onClose?: () => void;
  /** 额外 className */
  className?: string;
  /** 面板标题 */
  title?: string;
};

type BlockPropsView = {
  flavour?: string;
  text?: string;
  level?: number;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * 笔记纸面预览壳：只读投影列表 + L0 静默 chrome。
 * 写路径须经 Intent 桥；本组件 **不** 接行级 store。
 */
export const NotePaperPanel: React.FC<NotePaperPanelProps> = ({
  docId = 'silent-doc',
  blockCount = 8,
  fixture: fixtureProp,
  chrome: chromeProp,
  onClose,
  className,
  title = '笔记纸面（预览壳）',
}) => {
  // 假数据投影：不创建 lines[] 权威 store（A-SURF-08）
  const fixture = useMemo(
    () =>
      fixtureProp ??
      createSilentFixture(blockCount, { docId, rev: 1, idPrefix: 'b' }),
    [fixtureProp, blockCount, docId]
  );

  const chrome = useMemo(
    () => chromeProp ?? new BlockChromeModel(),
    [chromeProp]
  );

  // slash 模型挂载可测（预览壳默认关闭；composing 守卫在包内单测）
  const slashMenu = useMemo(() => new SlashMenuModel(), []);

  const blocks = useMemo(() => listSilentBlocks(fixture), [fixture]);

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
      data-testid="note-paper-panel"
      data-doc-id={fixture.docId}
      data-rev={String(fixture.rev)}
      data-silent-level={snapshot.silentLevel}
      data-block-count={String(blocks.length)}
      data-slash-open={slashMenu.isOpen() ? 'true' : 'false'}
      role="region"
      aria-label={title}
      tabIndex={-1}
    >
      <header className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        <div className={styles.meta}>
          <span className={styles.badgeSilent} data-testid="note-paper-silent">
            silent={snapshot.silentLevel}
          </span>
          <span className={styles.badge} data-testid="note-paper-rev">
            rev={fixture.rev}
          </span>
          <span className={styles.badge} data-testid="note-paper-count">
            {blocks.length} 块
          </span>
          {onClose ? (
            <button
              type="button"
              className={styles.badge}
              onClick={onClose}
              aria-label="关闭笔记纸面预览"
              data-testid="note-paper-close"
            >
              关闭
            </button>
          ) : null}
        </div>
      </header>

      <div className={styles.body} data-testid="note-paper-body">
        {blocks.length === 0 ? (
          <div className={styles.empty} data-testid="note-paper-empty">
            空文档投影（静默假数据 n=0）
          </div>
        ) : (
          blocks.map((block) => {
            const props = (block.props ?? {}) as BlockPropsView;
            const visibility: HandleVisibility = chrome.getHandleVisibility(
              block.id
            );
            return (
              <div
                key={block.id}
                className={styles.blockRow}
                data-block-id={block.id}
                data-handle={visibility}
                data-testid={`note-block-${block.id}`}
                tabIndex={0}
                onMouseEnter={() => handleHover(block.id)}
                onMouseLeave={() => handleHover(null)}
                onFocus={() => handleFocus(block.id)}
                onBlur={() => handleFocus(null)}
              >
                <span
                  className={styles.handle}
                  data-testid={`note-handle-${block.id}`}
                  aria-hidden
                />
                <div className={styles.blockContent}>
                  <span className={styles.flavour}>
                    {props.flavour ?? 'block'}
                    {props.level !== undefined ? ` h${props.level}` : ''}
                  </span>
                  <div className={styles.text}>{props.text ?? ''}</div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <footer className={styles.footer} data-testid="note-paper-footer">
        surface={EDITOR_SURFACE_NOTE_PAPER} · 预览壳 · 非行级引擎 ·
        挂载≠EL-01/EL-08 关闭
      </footer>
    </section>
  );
};

export default NotePaperPanel;
