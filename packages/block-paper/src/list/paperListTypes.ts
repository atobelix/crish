/**
 * W3-G · PaperList 选项与窗口类型（SD-20 切开 · types）
 *
 * 宿主类仍在 `PaperList.ts`；本模块只声明输入形状。
 *
 * - **≠ EL-01**；**≠ W3-P**；**≠ C2 默开**
 * - 假数据 `order` **≠** 权威树
 */

import type { BlockId } from '@crish/block-paper-contract';
import type { HeightMap } from '@crish/editor-kit';
import type { PaperBlockProjection } from './buildMountPlan';

export type PaperListScrollState = {
  scrollTop: number;
  viewportHeight: number;
};

export type PaperListWindowState = {
  startIndex: number;
  endIndex: number;
};

export type PaperListOptions = {
  /**
   * 展开序列有序 blockId（投影；可来自 silentFixture.order）。
   * **假数据列表 ≠ 权威树**。
   */
  order: readonly BlockId[];
  /**
   * 可选呈现投影（id → flavour/text）。
   * 缺省时行仅带 id，无正文节点。
   */
  projections?:
    | ReadonlyMap<BlockId, PaperBlockProjection>
    | readonly PaperBlockProjection[];
  /** 索引窗口（与 scroll 二选一；都缺省时窗口 = 空或 [0, min(n, 默认可见)]） */
  window?: PaperListWindowState;
  /** 滚动态（优先于 window；需 heightMap 或自动建预估图） */
  scroll?: PaperListScrollState;
  /** 前后 overscan 块数 */
  overscan?: number;
  focusId?: BlockId | null;
  composingIds?: Iterable<BlockId>;
  extraPinned?: Iterable<BlockId>;
  /** 可选 HeightMap；滚动路径会自动 resize 对齐 order */
  heightMap?: HeightMap;
  defaultEstimatePx?: number;
  /**
   * 未给 window/scroll 时的默认可见块数（结构门测友好）。
   * 默认 20；仍受 overscan + MAX 约束。
   */
  defaultVisibleCount?: number;
};
