/**
 * BlockChromeDomMount — 桌面 React 层挂载 `BlockChromeDomHost`（W3-F DOM 子集）
 *
 * ## 角色
 * - 把 block-paper chrome（把手 / 多选框 / 落点线 / slash 宿主 / 拖拽预览子集）
 *   接到 note-paper React 树（Skeleton / Strict 共用）
 * - 呈现投影：`BlockChromeModel` + 可选 `SlashMenuModel` → 真实 DOM `data-bp-*`
 * - **W3-E-desk**：可注入或默认 `BlockSelectionBridge` 统一 multi/focus 写入口
 *   （根节点 `data-sel-*` 可观测；**≠ EL-01**；**≠** Notion 框选 e2e）
 *
 * ## 槽契约（SD-04 · chrome 槽 vs content 槽）
 * | 槽 | 锚 | 宿主 |
 * |----|----|------|
 * | **chrome（本组件）** | `[data-bp-chrome-mount="1"]` | `BlockChromeDomHost` |
 * | **content · paper-list** | `[data-bp-paper-list-mount="1"]` | `PaperList`（见 PaperListDomMount） |
 * | **content · react-rows** | `[data-content-row="1"]` | Panel React 块行 |
 *
 * - 本槽是 **chrome 皮**，**不**计入 SD-04 内容宿主互斥
 * - 与 content 槽 **分槽共存、同屏不互删**；destroy 本槽不删 paper-list / content-row
 * - DomHost 自建 `data-bp-block-row` 属 chrome 行皮，**不是** 第二内容权威
 *
 * ## 诚实边界（钉死）
 * - **DOM 挂载 ≠ EL-01**；**≠** A-BLK-02/04/05 产品 e2e 全关
 * - **真 Pointer 拖拽全链后置**（`applyDragPointerShape` mock 形状可测，非产品 Pointer 监听）
 * - 本宿主 **不** 旁路写盘 / 不持有文档权威；内容投影仍由 Panel 内容宿主负责
 * - 契约锚 `data-bp-*`（本根 `data-bp-chrome-mount="1"`）+ `data-sel-*`（选区桥）
 *
 * 测：`BlockChromeDomMount.test.tsx` · `blockSelectionProduct.test.tsx`
 */

import React, { useEffect, useRef } from 'react';
import {
  BlockChromeDomHost,
  type BlockChromeModel,
  type BlockSelectionBridge,
  type ChromeDomBlockSpec,
  type SlashMenuModel,
} from '@crish/block-paper';
/** DomHost chrome 皮（落点线/slash/把手热区） */
import '@crish/block-paper/chrome.css';
/** PaperList 块行/滚动皮（与 chrome 同温；挂载后列表可点） */
import '@crish/block-paper/paper-list.css';
import {
  createProductBlockSelection,
  syncAndApplyBlockSelectionDataAttrs,
} from './blockSelectionProduct';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type BlockChromeDomMountProps = {
  /** 逻辑块列表（顺序 = DomHost DOM 顺序；仅 id/flavour 呈现） */
  blocks: readonly ChromeDomBlockSpec[];
  /** 把手 / 多选呈现源 */
  chrome: BlockChromeModel;
  /** 可选 slash 模型：open 时露出 slash 宿主 */
  slash?: SlashMenuModel;
  /**
   * W3-E-desk：跨块 multi / focus 统一写入口。
   * - **注入**：产品 / Strict 持有同一 bridge（与 panel focus 策略一致）
   * - **省略**：本组件默认 `createProductBlockSelection(chrome, { blockOrder })`
   * **≠ EL-01**；**≠** Notion 框选 e2e。
   */
  selection?: BlockSelectionBridge;
  /**
   * DomHost 是否投影 slash catalog 子节点。
   * **默认 false（SD-03）**：产品挂 React `SlashMenuOverlay` 时安全，防双浮层；
   * 宿主标记 `data-slash-catalog=react`，无 `data-bp-slash-item`。
   * 仅 jsdom DomHost catalog 契约测 / 无 Overlay 场景显式 `true`。
   */
  projectSlashCatalog?: boolean;
  /**
   * 变更时触发 host.sync()（如 hover/focus 后 chromeTick）。
   * 块列表变化会 destroy + 重建宿主。
   */
  syncToken?: number | string;
  /**
   * 宿主就绪 / 销毁回调（测试可拿 `setDropTarget` / `getHandleVisibilityAttr`）。
   * 每次重建先 `null` 再新 host。
   */
  onHostReady?: (host: BlockChromeDomHost | null) => void;
  /**
   * 选区桥就绪 / 销毁（测可拿 setMultiSelected / clear / setFocused）。
   * 注入路径：挂载时回调注入实例；默认路径：内部工厂实例。
   * 0 块 / 卸载时 `null`。
   */
  onSelectionReady?: (selection: BlockSelectionBridge | null) => void;
  /** 额外 className */
  className?: string;
  /** 挂载根 data-testid；默认 note-paper-chrome-dom */
  testId?: string;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * 命令式挂载 BlockChromeDomHost：挂在 ref 容器内，生命周期与 React 对齐。
 * 0 块时不创建 host（仅空壳锚点，便于面板恒有 chrome 槽）。
 * 默认 / 注入 `BlockSelectionBridge` 投影 `data-sel-*`。
 */
export const BlockChromeDomMount: React.FC<BlockChromeDomMountProps> = ({
  blocks,
  chrome,
  slash,
  selection: selectionProp,
  // SD-03：产品默认 React catalog，DomHost 不投影 item（防双浮层）
  projectSlashCatalog = false,
  syncToken = 0,
  onHostReady,
  onSelectionReady,
  className,
  testId = 'note-paper-chrome-dom',
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<BlockChromeDomHost | null>(null);
  const onHostReadyRef = useRef(onHostReady);
  onHostReadyRef.current = onHostReady;
  const onSelectionReadyRef = useRef(onSelectionReady);
  onSelectionReadyRef.current = onSelectionReady;

  // 块 id 序列签名：仅 id+flavour 变化才重建（避免每 render 新数组引用）
  const blockKey = blocks
    .map((b) => `${b.blockId}:${b.flavour ?? ''}`)
    .join('|');
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  // 默认 bridge：未注入时按 chrome 惰性创建；chrome 变则重建
  const defaultSelectionRef = useRef<BlockSelectionBridge | null>(null);
  const defaultChromeRef = useRef<BlockChromeModel | null>(null);
  if (selectionProp == null) {
    if (
      defaultSelectionRef.current == null ||
      defaultChromeRef.current !== chrome
    ) {
      defaultSelectionRef.current = createProductBlockSelection(chrome, {
        blockOrder: blocks.map((b) => b.blockId),
      });
      defaultChromeRef.current = chrome;
    }
  }
  const selection = selectionProp ?? defaultSelectionRef.current!;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // 文档序随块列表更新（结构 op / hydrate 后）
  useEffect(() => {
    selection.setBlockOrder(blocks.map((b) => b.blockId));
  }, [selection, blockKey, blocks]);

  // 对外暴露 bridge 句柄（注入或默认）
  useEffect(() => {
    if (blocks.length === 0) {
      onSelectionReadyRef.current?.(null);
      return;
    }
    onSelectionReadyRef.current?.(selection);
    return () => {
      onSelectionReadyRef.current?.(null);
    };
  }, [selection, blockKey, blocks.length]);

  useEffect(() => {
    const parent = mountRef.current;
    if (!parent) return;

    const specs = blocksRef.current;
    if (specs.length === 0) {
      if (hostRef.current) {
        hostRef.current.destroy();
        hostRef.current = null;
        onHostReadyRef.current?.(null);
      }
      return;
    }

    const host = new BlockChromeDomHost(parent, {
      blocks: specs.map((b) => ({
        blockId: b.blockId,
        flavour: b.flavour,
      })),
      chrome,
      slash,
      projectSlashCatalog,
    });
    hostRef.current = host;
    onHostReadyRef.current?.(host);
    // 初挂：对齐 chrome + 投影 data-sel-*
    syncAndApplyBlockSelectionDataAttrs(parent, selectionRef.current);

    return () => {
      host.destroy();
      if (hostRef.current === host) {
        hostRef.current = null;
      }
      onHostReadyRef.current?.(null);
    };
  }, [blockKey, chrome, slash, projectSlashCatalog]);

  // model 态变化 → 重投影（把手 / slash / 落点 / 选区 data）
  useEffect(() => {
    void syncToken;
    hostRef.current?.sync();
    const parent = mountRef.current;
    if (parent && blocksRef.current.length > 0) {
      // DomHost checkbox 等外写 chrome 后对齐 bridge 端点
      syncAndApplyBlockSelectionDataAttrs(parent, selectionRef.current);
    }
  }, [syncToken, blockKey]);

  const rootClass = ['np-chrome-dom-mount', className]
    .filter(Boolean)
    .join(' ');

  // 渲染期投影：首帧 / 无 syncToken 变更时也能读到 data-sel-*
  const selSnap = selection.getSnapshot();

  return (
    <div
      ref={mountRef}
      className={rootClass}
      data-testid={testId}
      data-bp-chrome-mount="1"
      data-chrome-block-count={String(blocks.length)}
      // 真 Pointer 拖拽全链未接：仅声明契约层已挂
      data-chrome-pointer-chain="deferred"
      data-sel-bridge="1"
      data-sel-mode={selSnap.mode}
      data-sel-multi={selSnap.multiSelectedIds.join(',')}
      data-sel-focus={selSnap.focusedBlockId ?? ''}
      data-sel-anchor={selSnap.anchorBlockId ?? ''}
      data-sel-head={selSnap.headBlockId ?? ''}
      aria-hidden={blocks.length === 0 ? true : undefined}
    />
  );
};

export default BlockChromeDomMount;
