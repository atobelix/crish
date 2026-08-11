/**
 * NotePaperPanel — Workbench 笔记纸面挂载壳（**W5-B-S Skeleton 轨**）
 *
 * ## 包轨（强制）
 * - **包 ID：W5-B-S**（Skeleton，必须带 `-S`）
 * - **合法交付**：预览壳 + 静默假数据 / Memory 半 transport 投影
 * - **≠ W5-B Strict**（真数据 / hydrate 投影见 `NotePaperStrictPanel` + `w5bStrict`；
 *   真产品默认路径依赖 W1-H；本组件默认不走真 hydrate）
 * - **双轨并存**：Strict 用 `data-package-id=W5-B` / `data-track=strict`；
 *   **禁止** 把本文件 Skeleton 常量改成 W5-B 冒充 Strict
 * - **≠ 任何 EL 关闭**（挂载冒充交付 = S5 事故 · 08 §0.2）
 * - **禁止** 假数据 chrome 关 EL-01；**禁止** 无 W1-H 写「打开完成」
 *
 * surface = note-paper
 *
 * - 使用 `@crish/block-paper` 的 createSilentFixture / BlockChromeModel / SlashMenuModel
 * - **可测** 预览壳：列表块 id、静默把手状态、data-surface="note-paper"
 * - 可选 `transport`：半 transport（Memory/IPC 形状）加载块列表（写后 refresh 可测）
 *   - Skeleton 默认可 inject `createMemoryNoteTransport()`
 *   - 未传 `transport` 时保持静默假数据投影（不隐式拉真后端 / 不宣称打开完成）
 * - **禁止** import 行级 EditorStore / markdown-editor store
 * - 假数据投影 ≠ 文档权威；DOM 锚 `data-package-id="W5-B-S"` / `data-track="skeleton"`
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BlockChromeModel,
  createSilentFixture,
  listSilentBlocks,
  SlashMenuModel,
  type HandleVisibility,
  type SilentFixture,
} from '@crish/block-paper';
/** DomHost chrome 皮（落点线/slash/把手热区）；与 module 块行皮并存；≠ EL-01 */
import '@crish/block-paper/chrome.css';
import type { NoteQueryBlockHit, NoteTransport } from '../../api/noteApi';
import { EDITOR_SURFACE_NOTE_PAPER } from './editorSurface';
import {
  W5B_SKELETON_BOUNDARY,
  W5B_SKELETON_PACKAGE_ID,
  W5B_SKELETON_TRACK,
} from './w5bSkeleton';
import styles from './NotePaperPanel.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type NotePaperPanelProps = {
  /** 文档 id（投影 / 假数据）；默认 silent-doc */
  docId?: string;
  /** 静默假数据块数；默认 8（transport 模式忽略） */
  blockCount?: number;
  /** 可选：外部注入 fixture（测试用） */
  fixture?: SilentFixture;
  /** 可选：外部 chrome（测试用） */
  chrome?: BlockChromeModel;
  /**
   * 笔记通路。提供时从 transport.queryBlocks 加载只读投影
   * （写后可调用 refresh / 外部改 refreshToken 触发重载）。
   * 产品：`createDefaultNoteTransport()` 或 `createTauriNoteTransport()`；
   * 单测：`createMemoryNoteTransport()`。省略则静默 fixture。
   */
  transport?: NoteTransport;
  /**
   * 变更时触发从 transport 重新 query（演示 apply → 刷新）。
   * 仅 transport 模式有效。
   */
  refreshToken?: number | string;
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

type DisplayBlock = {
  id: string;
  flavour: string;
  text: string;
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
  transport,
  refreshToken = 0,
  onClose,
  className,
  title = '笔记纸面（W5-B-S 预览壳）',
}) => {
  const useTransport = transport !== undefined;

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

  const silentBlocks = useMemo(() => listSilentBlocks(fixture), [fixture]);

  const [transportBlocks, setTransportBlocks] = useState<DisplayBlock[]>([]);
  const [transportLoading, setTransportLoading] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [transportRev, setTransportRev] = useState(0);

  const loadFromTransport = useCallback(async () => {
    if (!transport) return;
    setTransportLoading(true);
    setTransportError(null);
    try {
      const res = await transport.queryBlocks({ docId, limit: 200 });
      if (!res.ok) {
        setTransportBlocks([]);
        setTransportError(res.reason);
        return;
      }
      const mapped: DisplayBlock[] = res.blocks.map((b: NoteQueryBlockHit) => ({
        id: b.id,
        flavour: b.kind,
        text: b.snippet,
      }));
      setTransportBlocks(mapped);
      setTransportRev((n) => n + 1);
    } finally {
      setTransportLoading(false);
    }
  }, [transport, docId]);

  useEffect(() => {
    if (!useTransport) return;
    void loadFromTransport();
  }, [useTransport, loadFromTransport, refreshToken]);

  const displayBlocks: DisplayBlock[] = useMemo(() => {
    if (useTransport) return transportBlocks;
    return silentBlocks.map((block) => {
      const props = (block.props ?? {}) as BlockPropsView;
      return {
        id: block.id,
        flavour: props.flavour ?? 'block',
        text: props.text ?? '',
        level: props.level,
      };
    });
  }, [useTransport, transportBlocks, silentBlocks]);

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
  const resolvedDocId = useTransport ? docId : fixture.docId;
  const resolvedRev = useTransport ? transportRev : fixture.rev;

  return (
    <section
      className={rootClass}
      data-surface={EDITOR_SURFACE_NOTE_PAPER}
      data-testid="note-paper-panel"
      data-package-id={W5B_SKELETON_PACKAGE_ID}
      data-track={W5B_SKELETON_TRACK}
      data-doc-id={resolvedDocId}
      data-rev={String(resolvedRev)}
      data-silent-level={snapshot.silentLevel}
      data-block-count={String(displayBlocks.length)}
      data-slash-open={slashMenu.isOpen() ? 'true' : 'false'}
      data-source={useTransport ? 'transport' : 'silent'}
      data-transport-loading={
        useTransport && transportLoading ? 'true' : 'false'
      }
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
            rev={resolvedRev}
          </span>
          <span className={styles.badge} data-testid="note-paper-count">
            {displayBlocks.length} 块
          </span>
          {useTransport ? (
            <button
              type="button"
              className={styles.badge}
              onClick={() => {
                void loadFromTransport();
              }}
              aria-label="从 transport 刷新块列表"
              data-testid="note-paper-refresh"
            >
              刷新
            </button>
          ) : null}
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
              const headingLevel =
                block.level !== undefined
                  ? block.level
                  : block.flavour?.toLowerCase().startsWith('h') &&
                      /^h[1-6]$/i.test(block.flavour)
                    ? Number(block.flavour.slice(1))
                    : block.flavour === 'heading' || block.flavour === 'Heading'
                      ? 2
                      : undefined;
              return (
                <div
                  key={block.id}
                  className={styles.blockRow}
                  data-block-id={block.id}
                  data-handle={visibility}
                  data-flavour={block.flavour}
                  data-heading-level={
                    headingLevel !== undefined
                      ? String(headingLevel)
                      : undefined
                  }
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
                      {block.flavour}
                      {block.level !== undefined ? ` h${block.level}` : ''}
                    </span>
                    <div className={styles.text}>{block.text}</div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <footer className={styles.footer} data-testid="note-paper-footer">
        surface={EDITOR_SURFACE_NOTE_PAPER} · {W5B_SKELETON_BOUNDARY}
        {useTransport ? ' · 半 transport 投影' : ' · 静默假数据'}
      </footer>
    </section>
  );
};

export default NotePaperPanel;
