/**
 * NotePaperPanel — Workbench 笔记纸面挂载壳（**W5-B-S Skeleton 轨**）
 *
 * ## 包轨（强制）
 * - **包 ID：W5-B-S**（Skeleton，必须带 `-S`）
 * - **合法交付**：预览壳 + 静默假数据 / Memory 半 transport 投影
 * - **≠ W5-B Strict**（真数据 / hydrate 投影见 `NotePaperStrictPanel` + `notePaperStrictTrack`；
 *   真产品默认路径依赖 W1-H；本组件默认不走真 hydrate）
 * - **双轨并存**：Strict 用 `data-package-id=W5-B` / `data-track=strict`；
 *   **禁止** 把本文件 Skeleton 常量改成 W5-B 冒充 Strict
 * - **≠ 任何 EL 关闭**（挂载冒充交付 = S5 事故 · 08 §0.2）
 * - **禁止** 假数据 chrome 关 EL-01；**禁止** 无 W1-H 写「打开完成」
 *
 * ## SD-25 切开（目标 <400）
 * - hooks → `useNotePaperSkeleton`
 * - 静默假数据接线 → `notePaperSilentFixture`
 * - chrome 装配 → `NotePaperPanelChrome`
 * 本文件仅装配壳：包锚 / section data-* / 编排。**≠ EL**。
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

import React from 'react';
import {
  type BlockChromeDomHost,
  type BlockChromeModel,
  type IntentSink,
  type SilentFixture,
  type SlashInsertIntent,
  type SlashMenuModel,
} from '@crish/block-paper';
/** DomHost chrome 皮（落点线/slash/把手热区）；与 module 块行皮并存；≠ EL-01 */
import '@crish/block-paper/chrome.css';
/** W3-G PaperList 挂载皮（gap/pad/gutter/滚动）；逻辑挂载归 ②；≠ EL-01 */
import '@crish/block-paper/paper-list.css';
import type { NoteTransport } from '../../api/noteApi';
import { EDITOR_SURFACE_NOTE_PAPER } from './editorSurface';
import { NotePaperPanelChrome } from './NotePaperPanelChrome';
import { useNotePaperSkeleton } from './useNotePaperSkeleton';
import {
  W5B_SKELETON_PACKAGE_ID,
  W5B_SKELETON_TRACK,
} from './notePaperSkeletonTrack';
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
   * 可选：外部 slash 模型（测试打开 slash 宿主 / 契约同步）。
   * 未传时内部 new SlashMenuModel()，预览壳默认关闭。
   */
  slashMenu?: SlashMenuModel;
  /**
   * slash 选中后的 Intent sink（可选）。
   * 注入时 React 浮层点击走 `selectSlashItemAndSubmit` → sink。
   * 未注入仍产出 Intent 回调 `onSlashIntent`（测形状）；**≠** 生产写盘完成。
   */
  slashIntentSink?: IntentSink;
  /** slash 产出 Intent 后回调（无论是否已 submit） */
  onSlashIntent?: (intent: SlashInsertIntent) => void;
  /**
   * DomHost 就绪回调（W3-F DOM 桌面挂载子集；测试拿 setDropTarget 等）。
   * **≠ EL-01**；真 Pointer 拖拽全链后置。
   */
  onChromeDomHost?: (host: BlockChromeDomHost | null) => void;
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
  slashMenu: slashMenuProp,
  slashIntentSink,
  onSlashIntent,
  onChromeDomHost,
  transport,
  refreshToken = 0,
  onClose,
  className,
  title = '笔记纸面（W5-B-S 预览壳）',
}) => {
  const {
    chrome,
    slashMenu,
    slashOpen,
    useTransport,
    displayBlocks,
    transportLoading,
    transportError,
    loadFromTransport,
    chromeTick,
    snapshot,
    handleHover,
    handleFocus,
    resolvedDocId,
    resolvedRev,
  } = useNotePaperSkeleton({
    docId,
    blockCount,
    fixture: fixtureProp,
    chrome: chromeProp,
    slashMenu: slashMenuProp,
    transport,
    refreshToken,
  });

  const rootClass = [styles.panel, className].filter(Boolean).join(' ');

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
      data-slash-open={slashOpen === '1' ? 'true' : 'false'}
      data-slash-ui="react"
      data-source={useTransport ? 'transport' : 'silent'}
      data-transport-loading={
        useTransport && transportLoading ? 'true' : 'false'
      }
      role="region"
      aria-label={title}
      tabIndex={-1}
    >
      <NotePaperPanelChrome
        title={title}
        silentLevel={snapshot.silentLevel}
        resolvedRev={resolvedRev}
        displayBlocks={displayBlocks}
        useTransport={useTransport}
        transportError={transportError}
        chrome={chrome}
        slashMenu={slashMenu}
        slashIntentSink={slashIntentSink}
        onSlashIntent={onSlashIntent}
        onChromeDomHost={onChromeDomHost}
        onRefresh={() => {
          void loadFromTransport();
        }}
        onClose={onClose}
        chromeTick={chromeTick}
        slashOpen={slashOpen}
        onHover={handleHover}
        onFocus={handleFocus}
      />
    </section>
  );
};

export default NotePaperPanel;
