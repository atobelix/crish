/**
 * W3-G · PaperList：仅窗口（+ pin）块挂 DOM 的列表宿主。
 *
 * ## 角色
 * - 消费 `buildMountPlan*` / MountSpec 形状，把投影序 reconcile 到真实 DOM
 * - **仅** `mountIds` 进入 DOM；窗外块用 spacer 撑滚动高度
 * - **禁止** CSS `hidden`/`display:none` 挂全量 DOM 冒充虚拟化
 * - **禁止** DOM / 假数据当文档权威；写仍走 Intent → apply
 *
 * ## 完成定义（W3-G Strict）
 * 1. 窗口外块 **不** 进 DOM（或 mountedCount 有上界 ≤ MAX_MOUNTED_DOM_BLOCKS）
 * 2. 假数据 / 投影输入可测（silentFixture / 自定义 order）
 * 3. **≠** EL-01 e2e 满关；**≠** A-PERF 数值门
 *
 * 测：`paperList.w3g.test.ts`
 */

import type { BlockId, MountSpec } from '@crish/block-paper-contract';
import {
  DEFAULT_ESTIMATE_PX,
  DEFAULT_OVERSCAN_BLOCKS,
  HeightMap,
  isWithinDomMountBound,
  MAX_MOUNTED_DOM_BLOCKS,
} from '@crish/editor-kit';
import {
  buildMountPlanByScroll,
  buildMountPlanByWindow,
  type MountPlan,
  type PaperBlockProjection,
} from './buildMountPlan';

// ---------------------------------------------------------------------------
// data-* 契约（结构门 / e2e 可锚定）
// ---------------------------------------------------------------------------

/** 列表根 */
export const BP_PAPER_LIST = 'data-bp-paper-list';
/** 单块行（仅 mountIds） */
export const BP_PAPER_BLOCK = 'data-bp-paper-block';
/** block id */
export const BP_PAPER_BLOCK_ID = 'data-block-id';
/** 顶部 spacer */
export const BP_PAPER_SPACER_BEFORE = 'data-bp-spacer-before';
/** 底部 spacer */
export const BP_PAPER_SPACER_AFTER = 'data-bp-spacer-after';
/** 挂载块数（结构门可读） */
export const BP_PAPER_MOUNTED_COUNT = 'data-mounted-count';
/** 投影总块数（≠ DOM 数） */
export const BP_PAPER_TOTAL_COUNT = 'data-total-count';

// ---------------------------------------------------------------------------
// 选项
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

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
    blockHost.setAttribute('data-bp-block-host', '1');
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
    this.defaultVisibleCount = options.defaultVisibleCount ?? 20;

    this.sync();
  }

  // -----------------------------------------------------------------------
  // 公共 API
  // -----------------------------------------------------------------------

  /** 替换投影序（假数据或 Diff 后的 order；**非**权威提交） */
  setOrder(order: readonly BlockId[]): void {
    this.assertAlive();
    this.order = [...order];
    this.sync();
  }

  /** 更新呈现投影 map（仅 DOM 文本/flavour） */
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

  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------

  private computePlan(): MountPlan {
    const order = this.order;
    const n = order.length;

    // 确保 HeightMap 与 order 对齐（滚动路径或调用方注入）
    let hm = this.heightMap;
    if (this.scrollState) {
      if (!hm) {
        hm = new HeightMap(n, this.defaultEstimatePx);
        for (let i = 0; i < n; i++) {
          hm.bindId(i, order[i]!);
        }
        this.heightMap = hm;
      } else if (hm.count !== n) {
        hm.resize(n, this.defaultEstimatePx);
        for (let i = 0; i < n; i++) {
          hm.bindId(i, order[i]!);
        }
      }
    } else if (hm && hm.count !== n) {
      hm.resize(n, this.defaultEstimatePx);
      for (let i = 0; i < n; i++) {
        hm.bindId(i, order[i]!);
      }
    } else if (hm) {
      for (let i = 0; i < n; i++) {
        hm.bindId(i, order[i]!);
      }
    }

    if (this.scrollState && hm) {
      const scrollInput: Parameters<typeof buildMountPlanByScroll>[0] = {
        order,
        scrollTop: this.scrollState.scrollTop,
        viewportHeight: this.scrollState.viewportHeight,
        overscan: this.overscan,
        heightMap: hm,
        defaultEstimatePx: this.defaultEstimatePx,
        focusId: this.focusId,
        composingIds: this.composingIds,
        extraPinned: this.extraPinned,
      };
      return buildMountPlanByScroll(scrollInput);
    }

    const window =
      this.windowState ?? defaultWindow(n, this.defaultVisibleCount);

    const windowInput: Parameters<typeof buildMountPlanByWindow>[0] = {
      order,
      window,
      overscan: this.overscan,
      defaultEstimatePx: this.defaultEstimatePx,
      focusId: this.focusId,
      composingIds: this.composingIds,
      extraPinned: this.extraPinned,
    };
    if (hm) {
      windowInput.heightMap = hm;
    }
    return buildMountPlanByWindow(windowInput);
  }

  private applyPlan(plan: MountPlan): void {
    const doc = this.root.ownerDocument;
    const want = new Set(plan.mountIds);

    // 1) 卸载窗外（真 remove，禁止 hidden 假虚拟化）
    for (const [id, el] of this.nodes) {
      if (!want.has(id)) {
        el.remove();
        this.nodes.delete(id);
      }
    }

    // 2) 按 mountIds 序挂载 / 重排
    let anchor: Node | null = this.blockHost.firstChild;
    for (const id of plan.mountIds) {
      let el = this.nodes.get(id);
      if (!el) {
        el = this.createBlockElement(doc, id);
        this.nodes.set(id, el);
      } else {
        this.paintBlock(el, id);
      }
      // 保持 order：若当前 anchor 不是 el，则 insertBefore
      if (anchor !== el) {
        this.blockHost.insertBefore(el, anchor);
      } else {
        anchor = el.nextSibling;
        continue;
      }
      // insertBefore 后，下一个应对齐到刚插入节点之后
      anchor = el.nextSibling;
    }

    // 3) spacer + 根属性
    this.spacerBefore.style.height = `${plan.spacerBeforePx}px`;
    this.spacerAfter.style.height = `${plan.spacerAfterPx}px`;
    this.root.setAttribute(BP_PAPER_MOUNTED_COUNT, String(plan.mountedCount));
    this.root.setAttribute(BP_PAPER_TOTAL_COUNT, String(plan.totalCount));
    this.root.setAttribute(
      'data-within-dom-bound',
      plan.withinDomBound ? '1' : '0'
    );
  }

  private createBlockElement(doc: Document, id: BlockId): HTMLElement {
    const el = doc.createElement('div');
    el.className = 'bp-paper-block';
    el.setAttribute(BP_PAPER_BLOCK, '1');
    el.setAttribute(BP_PAPER_BLOCK_ID, id);
    this.paintBlock(el, id);
    return el;
  }

  private paintBlock(el: HTMLElement, id: BlockId): void {
    el.setAttribute(BP_PAPER_BLOCK_ID, id);
    const proj = this.projections.get(id);
    if (proj?.flavour) {
      el.setAttribute('data-flavour', proj.flavour);
    } else {
      el.removeAttribute('data-flavour');
    }
    // 正文仅呈现；**非**权威
    const text = proj?.text ?? '';
    if (el.textContent !== text) {
      el.textContent = text;
    }
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('PaperList 已 destroy');
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normalizeProjections(
  projections:
    | ReadonlyMap<BlockId, PaperBlockProjection>
    | readonly PaperBlockProjection[]
    | undefined
): Map<BlockId, PaperBlockProjection> {
  const map = new Map<BlockId, PaperBlockProjection>();
  if (!projections) return map;
  // Map 与数组分流（exactOptional + for-of 联合类型需显式分支）
  if (isProjectionMap(projections)) {
    projections.forEach((p, id) => {
      map.set(id, p);
    });
    return map;
  }
  for (const p of projections) {
    map.set(p.id, p);
  }
  return map;
}

function isProjectionMap(
  v:
    ReadonlyMap<BlockId, PaperBlockProjection> | readonly PaperBlockProjection[]
): v is ReadonlyMap<BlockId, PaperBlockProjection> {
  return (
    typeof (v as ReadonlyMap<BlockId, PaperBlockProjection>).forEach ===
      'function' && !Array.isArray(v)
  );
}

function defaultWindow(
  totalCount: number,
  defaultVisibleCount: number
): PaperListWindowState {
  if (totalCount <= 0) return { startIndex: 0, endIndex: 0 };
  const end = Math.min(totalCount, Math.max(0, defaultVisibleCount));
  return { startIndex: 0, endIndex: end };
}

/** 类型守卫 */
export function isPaperList(value: unknown): value is PaperList {
  return value instanceof PaperList;
}
