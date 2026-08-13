/**
 * PaperListDomMount — 桌面 React 层挂载 `PaperList`（W3-G 窗口 DOM · 产品挂载）
 *
 * ## 角色
 * - 把 `@crish/block-paper` 的 `PaperList` 接到 note-paper React 树
 * - 输入：hydrate / 投影块（id + flavour/text/level 呈现），**非**权威树
 * - 仅窗口∪pin 进 DOM；窗外真 remove + spacer（**禁止** CSS hidden 假虚拟化）
 *
 * ## 槽契约（SD-04 · chrome ∥ content 钉死）
 * | 槽 | 锚 | 宿主 | 计入内容互斥？ |
 * |----|----|------|----------------|
 * | **chrome** | `[data-bp-chrome-mount="1"]` | `BlockChromeDomHost` | 否（chrome 皮） |
 * | **content · paper-list** | `[data-bp-paper-list-mount="1"]` | 本组件 → `PaperList` | **是** |
 * | **content · react-rows** | `[data-content-row="1"]` | Strict/Skeleton React 行 | **是** |
 *
 * - chrome 与 content **同屏兄弟**，生命周期独立；destroy 一方 **不** 删另一方
 * - 不共享 DOM 子树；不共用 `hostRef`
 * - **产品默认**：`presentationMode='paper-list'` 时 **不** 再挂全量 content-row
 *   （互斥由 `resolvePresentationMode` / StrictPanel 保证；本组件只负责列表槽）
 * - `debug-dual` 才允许 content-row + 本槽同屏（非产品默认）
 *
 * ## 诚实边界（钉死）
 * - **≠ EL-01** e2e 满关；**≠** A-PERF 数值门（仅结构 DOM 上界）
 * - **≠ W3-P WindowManager 全闭环** / 真 ProjectionDiff / awareness
 * - 假数据 / hydrate 投影列表 **≠** 权威树；写仍走 Intent
 * - 窗口/scroll 参数可测；挂载后 DOM 块数 ≤ `MAX_MOUNTED_DOM_BLOCKS`
 *
 * 测：`PaperListDomMount.test.tsx` · `presentationMode.test.ts`
 */

import React, { useEffect, useRef } from 'react';
import {
  PaperList,
  type PaperBlockProjection,
  type PaperListScrollState,
  type PaperListWindowState,
} from '@crish/block-paper';
/** W3-G PaperList 产品挂载皮（visual-align 08/09 列表间距）；≠ EL-01 */
import '@crish/block-paper/paper-list.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** 驱动 PaperList 的投影块（hydrate / silent 均可；≠ 权威） */
export type PaperListMountBlock = {
  id: string;
  flavour?: string;
  text?: string;
  /** 标题级 1–6；写入 list 行 `data-heading-level`（LR-V4） */
  level?: number;
};

function toPaperBlockProjection(
  block: PaperListMountBlock
): PaperBlockProjection {
  const proj: PaperBlockProjection = { id: block.id };
  if (block.flavour !== undefined) proj.flavour = block.flavour;
  if (block.text !== undefined) proj.text = block.text;
  if (block.level !== undefined) proj.level = block.level;
  return proj;
}

export type PaperListDomMountProps = {
  /**
   * 投影块序列（order = 数组序）。
   * 0 块时不创建 list（仅空槽锚点，与 chrome 槽对称）。
   */
  blocks: readonly PaperListMountBlock[];
  /**
   * 索引窗口 [start, end)（未含 overscan）。
   * 与 `scroll` 二选一；都缺省时走 PaperList 默认可见块数。
   */
  window?: PaperListWindowState;
  /**
   * 滚动态（优先于 window；内部自动 HeightMap 预估）。
   * jsdom 可测：改 scrollTop → 窗外真 remove。
   */
  scroll?: PaperListScrollState;
  /** 前后 overscan 块数 */
  overscan?: number;
  focusId?: string | null;
  composingIds?: readonly string[];
  extraPinned?: readonly string[];
  /**
   * 未给 window/scroll 时的默认可见块数（结构门测友好）。
   * 默认交由 PaperList（20）。
   */
  defaultVisibleCount?: number;
  defaultEstimatePx?: number;
  /**
   * 宿主就绪 / 销毁回调（测试可拿 getMountedCount / setScroll / setWindow）。
   * 每次重建先 `null` 再新 list。
   */
  onListReady?: (list: PaperList | null) => void;
  /** 额外 className */
  className?: string;
  /** 挂载根 data-testid；默认 note-paper-paper-list */
  testId?: string;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * 命令式挂载 PaperList：挂在 ref 容器内，生命周期与 React 对齐。
 *
 * 块 id 序列 / 窗口 / scroll 变化会 rebuild 或 set* 同步；
 * 呈现投影（flavour/text/level）变化走 setProjections。
 */
export const PaperListDomMount: React.FC<PaperListDomMountProps> = ({
  blocks,
  window: windowState,
  scroll,
  overscan,
  focusId,
  composingIds,
  extraPinned,
  defaultVisibleCount,
  defaultEstimatePx,
  onListReady,
  className,
  testId = 'note-paper-paper-list',
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<PaperList | null>(null);
  const onListReadyRef = useRef(onListReady);
  onListReadyRef.current = onListReady;

  // 块 id 序签名：仅 id 序列变化才重建（避免每 render 新数组引用）
  const orderKey = blocks.map((b) => b.id).join('|');
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  // 窗口 / 滚动态序列化（供 effect 依赖）
  const windowKey = windowState
    ? `${windowState.startIndex}:${windowState.endIndex}`
    : '';
  const scrollKey = scroll
    ? `${scroll.scrollTop}:${scroll.viewportHeight}`
    : '';
  const pinKey = [
    focusId ?? '',
    composingIds?.join(',') ?? '',
    extraPinned?.join(',') ?? '',
  ].join('|');

  // 呈现投影签名（不重建 list，只 setProjections）
  const projKey = blocks
    .map((b) => `${b.id}:${b.flavour ?? ''}:${b.text ?? ''}:${b.level ?? ''}`)
    .join('|');

  // 1) 创建 / 销毁 PaperList（order 变化 → 重建，确保 HeightMap 对齐）
  useEffect(() => {
    const parent = mountRef.current;
    if (!parent) return;

    const specs = blocksRef.current;
    if (specs.length === 0) {
      if (listRef.current) {
        listRef.current.destroy();
        listRef.current = null;
        onListReadyRef.current?.(null);
      }
      return;
    }

    const projections: PaperBlockProjection[] = specs.map(
      toPaperBlockProjection
    );

    const opts: ConstructorParameters<typeof PaperList>[1] = {
      order: specs.map((b) => b.id),
      projections,
    };
    if (windowState) opts.window = { ...windowState };
    if (scroll) opts.scroll = { ...scroll };
    if (overscan !== undefined) opts.overscan = overscan;
    if (focusId !== undefined) opts.focusId = focusId;
    if (composingIds) opts.composingIds = composingIds;
    if (extraPinned) opts.extraPinned = extraPinned;
    if (defaultVisibleCount !== undefined) {
      opts.defaultVisibleCount = defaultVisibleCount;
    }
    if (defaultEstimatePx !== undefined) {
      opts.defaultEstimatePx = defaultEstimatePx;
    }

    const list = new PaperList(parent, opts);
    listRef.current = list;
    onListReadyRef.current?.(list);

    return () => {
      list.destroy();
      if (listRef.current === list) {
        listRef.current = null;
      }
      onListReadyRef.current?.(null);
    };
    // orderKey 驱动重建；window/scroll/pin 初值随创建写入
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 后续由 sync effect 更新
  }, [orderKey]);

  // 2) 窗口 / scroll / pin / overscan 变更 → set* 而非全量重建
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    if (scroll) {
      list.setScroll({ ...scroll });
    } else if (windowState) {
      list.setWindow({ ...windowState });
    }

    if (overscan !== undefined) {
      list.setOverscan(overscan);
    }

    list.setPin({
      focusId: focusId ?? null,
      composingIds: composingIds ?? [],
      extraPinned: extraPinned ?? [],
    });
  }, [
    windowKey,
    scrollKey,
    pinKey,
    overscan,
    windowState,
    scroll,
    focusId,
    composingIds,
    extraPinned,
  ]);

  // 3) 呈现投影文本/flavour/level 变化
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    void projKey;
    const projections: PaperBlockProjection[] = blocksRef.current.map(
      toPaperBlockProjection
    );
    list.setProjections(projections);
  }, [projKey]);

  const rootClass = ['np-paper-list-mount', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={mountRef}
      className={rootClass}
      data-testid={testId}
      data-bp-paper-list-mount="1"
      data-paper-list-block-count={String(blocks.length)}
      data-paper-list-window={windowKey || undefined}
      data-paper-list-scroll={scrollKey || undefined}
      // 诚实：≠ EL-01；≠ W3-P WindowManager 全闭环
      data-paper-list-track="w3-g"
      data-paper-list-el="open"
      aria-hidden={blocks.length === 0 ? true : undefined}
    />
  );
};

export default PaperListDomMount;
