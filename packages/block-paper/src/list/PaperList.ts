/**
 * W3-G · PaperList：仅窗口（+ pin）块挂 DOM 的列表宿主（SD-20 切开）。
 *
 * 实现已拆：
 * - `paperListConstants`：data-* 契约
 * - `paperListTypes`：选项 / 窗口 / 滚动态
 * - `paperListPlan`：HeightMap 对齐 + MountPlan
 * - `paperListReconcile`：仅 mountIds 进 DOM；窗外真 remove
 * - `paperListSpacer`：spacer 高度 + 根属性
 *
 * 本文件保持既有 import 路径与包级 API（`list/index.ts` 仍从本模块 re-export）。
 *
 * ## 角色
 * - 消费 `buildMountPlan*` / MountSpec 形状，把投影序 reconcile 到真实 DOM
 * - **仅** `mountIds` 进入 DOM；窗外块用 spacer 撑滚动高度
 * - **禁止** CSS `hidden`/`display:none` 挂全量 DOM 冒充虚拟化
 * - **禁止** DOM / 假数据当文档权威；写仍走 Intent → apply
 *
 * ## 完成定义（W3-G Strict · SD-20）
 * 1. 窗口外块 **不** 进 DOM（或 mountedCount 有上界 ≤ MAX_MOUNTED_DOM_BLOCKS）
 * 2. 假数据 / 投影输入可测（silentFixture / 自定义 order）
 * 3. **≠** EL-01 e2e 满关；**≠** W3-P WindowManager；**≠** C2 默开
 * 4. 主文件 **<400**（相对切开前 488 黄边显著下降）
 *
 * 测：`paperList.test.ts` · `PaperList.line-budget.test.ts`
 */

import type { BlockId, MountSpec } from '@crish/block-paper-contract';
import {
  DEFAULT_ESTIMATE_PX,
  DEFAULT_OVERSCAN_BLOCKS,
  HeightMap,
  isWithinDomMountBound,
  MAX_MOUNTED_DOM_BLOCKS,
} from '@crish/editor-kit';
import type { MountPlan, PaperBlockProjection } from './buildMountPlan';
import {
  BP_PAPER_BLOCK,
  BP_PAPER_BLOCK_HOST,
  BP_PAPER_LIST,
  BP_PAPER_MOUNTED_COUNT,
  BP_PAPER_SPACER_AFTER,
  BP_PAPER_SPACER_BEFORE,
  BP_PAPER_TOTAL_COUNT,
  PAPER_LIST_DEFAULT_VISIBLE_COUNT,
} from './paperListConstants';
import { computePaperListPlan } from './paperListPlan';
import { applyPaperListPlan, normalizeProjections } from './paperListReconcile';
import type {
  PaperListOptions,
  PaperListScrollState,
  PaperListWindowState,
} from './paperListTypes';

export {
  BP_PAPER_BLOCK,
  BP_PAPER_BLOCK_ID,
  BP_PAPER_BLOCK_HOST,
  BP_PAPER_LIST,
  BP_PAPER_MOUNTED_COUNT,
  BP_PAPER_SPACER_AFTER,
  BP_PAPER_SPACER_BEFORE,
  BP_PAPER_TOTAL_COUNT,
  BP_PAPER_WITHIN_DOM_BOUND,
  PAPER_LIST_DEFAULT_VISIBLE_COUNT,
} from './paperListConstants';

export type {
  PaperListOptions,
  PaperListScrollState,
  PaperListWindowState,
} from './paperListTypes';

/**
 * 最小 PaperList DOM 宿主：窗口虚拟化挂载，不持文档权威。
 */
export class PaperList {
  private readonly root: HTMLElement;
  private readonly spacerBefore: HTMLElement;
  private readonly blockHost: HTMLElement;
  private readonly spacerAfter: HTMLElement;
  private readonly nodes = new Map<BlockId, HTMLElement>();
  private order: BlockId[];
  private projections: Map<BlockId, PaperBlockProjection>;
  private windowState: PaperListWindowState | null;
  private scrollState: PaperListScrollState | null;
  private overscan: number;
  private focusId: BlockId | null;
  private composingIds: BlockId[];
  private extraPinned: BlockId[];
  private heightMap: HeightMap | null;
  private defaultEstimatePx: number;
  private defaultVisibleCount: number;
  private lastPlan: MountPlan | null = null;
  private destroyed = false;

  constructor(parent: HTMLElement, options: PaperListOptions) {
    const doc = parent.ownerDocument;
    const root = doc.createElement('div');
    root.className = 'bp-paper-list';
    root.setAttribute(BP_PAPER_LIST, '1');
    root.setAttribute(BP_PAPER_MOUNTED_COUNT, '0');
    root.setAttribute(BP_PAPER_TOTAL_COUNT, '0');
    parent.appendChild(root);
    this.root = root;

    const spacerBefore = doc.createElement('div');
    spacerBefore.className = 'bp-paper-spacer-before';
    spacerBefore.setAttribute(BP_PAPER_SPACER_BEFORE, '1');
    spacerBefore.setAttribute('aria-hidden', 'true');
    root.appendChild(spacerBefore);
    this.spacerBefore = spacerBefore;

    const blockHost = doc.createElement('div');
    blockHost.className = 'bp-paper-block-host';
    blockHost.setAttribute(BP_PAPER_BLOCK_HOST, '1');
    root.appendChild(blockHost);
    this.blockHost = blockHost;

    const spacerAfter = doc.createElement('div');
    spacerAfter.className = 'bp-paper-spacer-after';
    spacerAfter.setAttribute(BP_PAPER_SPACER_AFTER, '1');
    spacerAfter.setAttribute('aria-hidden', 'true');
    root.appendChild(spacerAfter);
    this.spacerAfter = spacerAfter;

    this.order = [...options.order];
    this.projections = normalizeProjections(options.projections);
    this.windowState = options.window ? { ...options.window } : null;
    this.scrollState = options.scroll ? { ...options.scroll } : null;
    this.overscan = options.overscan ?? DEFAULT_OVERSCAN_BLOCKS;
    this.focusId = options.focusId ?? null;
    this.composingIds = options.composingIds ? [...options.composingIds] : [];
    this.extraPinned = options.extraPinned ? [...options.extraPinned] : [];
    this.heightMap = options.heightMap ?? null;
    this.defaultEstimatePx = options.defaultEstimatePx ?? DEFAULT_ESTIMATE_PX;
    this.defaultVisibleCount =
      options.defaultVisibleCount ?? PAPER_LIST_DEFAULT_VISIBLE_COUNT;

    this.sync();
  }

  /** 替换投影序（假数据或 Diff 后的 order；**非**权威提交） */
  setOrder(order: readonly BlockId[]): void {
    this.assertAlive();
    this.order = [...order];
    this.sync();
  }

  /** 更新呈现投影 map（仅 DOM 文本/flavour/level；焦点皮走 setPin） */
  setProjections(
    projections:
      | ReadonlyMap<BlockId, PaperBlockProjection>
      | readonly PaperBlockProjection[]
      | undefined
  ): void {
    this.assertAlive();
    this.projections = normalizeProjections(projections);
    this.sync();
  }

  /** 设置索引窗口（清除 scroll 优先） */
  setWindow(window: PaperListWindowState | null): void {
    this.assertAlive();
    this.windowState = window ? { ...window } : null;
    if (window) this.scrollState = null;
    this.sync();
  }

  /** 设置滚动态（优先于 window；自动确保 HeightMap） */
  setScroll(scroll: PaperListScrollState | null): void {
    this.assertAlive();
    this.scrollState = scroll ? { ...scroll } : null;
    this.sync();
  }

  setOverscan(overscan: number): void {
    this.assertAlive();
    this.overscan = Math.max(0, Math.floor(overscan));
    this.sync();
  }

  setPin(input: {
    focusId?: BlockId | null;
    composingIds?: Iterable<BlockId>;
    extraPinned?: Iterable<BlockId>;
  }): void {
    this.assertAlive();
    if (input.focusId !== undefined) this.focusId = input.focusId;
    if (input.composingIds !== undefined) {
      this.composingIds = [...input.composingIds];
    }
    if (input.extraPinned !== undefined) {
      this.extraPinned = [...input.extraPinned];
    }
    this.sync();
  }

  setHeightMap(heightMap: HeightMap | null): void {
    this.assertAlive();
    this.heightMap = heightMap;
    this.sync();
  }

  /**
   * 按当前 order / 窗口 / pin 重算计划并 reconcile DOM。
   * 窗外节点 **remove**（非 hidden）。
   */
  sync(): void {
    this.assertAlive();
    const plan = this.computePlan();
    this.lastPlan = plan;
    this.applyPlan(plan);
  }

  /** 最近一次 MountPlan（sync 后非 null） */
  getMountPlan(): MountPlan | null {
    return this.lastPlan;
  }

  /** 最近一次 MountSpec */
  getMountSpec(): MountSpec | null {
    return this.lastPlan?.mountSpec ?? null;
  }

  getMountedBlockIds(): BlockId[] {
    return this.lastPlan ? [...this.lastPlan.mountIds] : [];
  }

  getMountedCount(): number {
    return this.lastPlan?.mountedCount ?? 0;
  }

  getTotalCount(): number {
    return this.order.length;
  }

  /** 结构门：mounted ≤ MAX_MOUNTED_DOM_BLOCKS */
  isWithinDomBound(): boolean {
    return isWithinDomMountBound(this.getMountedCount());
  }

  getMaxMountedDomBlocks(): number {
    return MAX_MOUNTED_DOM_BLOCKS;
  }

  getBlockElement(blockId: BlockId): HTMLElement | null {
    return this.nodes.get(blockId) ?? null;
  }

  getRootElement(): HTMLElement {
    return this.root;
  }

  /** 当前 DOM 中 `[data-bp-paper-block]` 节点数（可证伪结构门） */
  countDomBlocks(): number {
    return this.blockHost.querySelectorAll(`[${BP_PAPER_BLOCK}]`).length;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.nodes.clear();
    this.lastPlan = null;
    this.root.remove();
  }

  private computePlan(): MountPlan {
    const result = computePaperListPlan({
      order: this.order,
      scrollState: this.scrollState,
      windowState: this.windowState,
      overscan: this.overscan,
      focusId: this.focusId,
      composingIds: this.composingIds,
      extraPinned: this.extraPinned,
      heightMap: this.heightMap,
      defaultEstimatePx: this.defaultEstimatePx,
      defaultVisibleCount: this.defaultVisibleCount,
    });
    this.heightMap = result.heightMap;
    return result.plan;
  }

  private applyPlan(plan: MountPlan): void {
    applyPaperListPlan(
      {
        root: this.root,
        blockHost: this.blockHost,
        spacerBefore: this.spacerBefore,
        spacerAfter: this.spacerAfter,
        nodes: this.nodes,
        projections: this.projections,
        focusId: this.focusId,
      },
      plan
    );
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('PaperList 已 destroy');
    }
  }
}

/** 类型守卫 */
export function isPaperList(value: unknown): value is PaperList {
  return value instanceof PaperList;
}
