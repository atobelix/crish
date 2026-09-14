/**
 * TableIsland —— 表格岛（战役 table-systemic-remediation · T3）
 *
 * 权威文档：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md
 *          docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-2 / ADR-4）
 *
 * 本模块只放**纯逻辑**（可独立单测、零 DOM / 零 React 依赖）：
 *   - 特性开关（默认关闭；`00-总方案` §9.2「B 期新渲染路径必须可一键关闭」）
 *   - 岛内**行窗口化**：行数超阈值时只渲染视口附近的行
 *   - **列宽栅格**：由列宽数组生成 CSS `grid-template-columns`
 *
 * 岛式布局的核心契约（ADR-2 / ADR-4）：
 *   ① 整表**一个**横向滚动所有者（岛容器），不再每行一个 `overflow-x`；
 *   ② 列宽由**岛的栅格模板**统一驱动（每个行容器共用同一模板），
 *      故不再需要 per-cell 的 `flex: 0 0 Npx` 写回（旧路径的写回在 T8 随旧路径清退）；
 *   ③ 行窗口化在岛内完成——外层虚拟化把整表视为**一个**虚拟项（T4 接线）。
 */

/** 行数超过该阈值才启用岛内窗口化（小表全量渲染，避免无谓的窗口计算）。 */
export const ISLAND_WINDOW_THRESHOLD = 60;

/** 窗口外预渲染的行数（上下各留，减少快速滚动时的白屏）。 */
export const ISLAND_OVERSCAN_ROWS = 8;

/** 单列最小宽度（与既有 `InlineRenderer` 的 100px 兜底口径对齐）。 */
export const MIN_COL_WIDTH = 100;

/** 单列最大宽度（避免单列吞掉整个内容列；ADR-4 分配器上界）。 */
export const MAX_COL_WIDTH = 480;

/**
 * 岛式渲染开关（ADR-2 的特性开关）。
 *
 * **默认关闭**——旧逐行路径保持为默认行为，直到 B 期验收矩阵全绿
 * （`00-总方案` §9.2 规则 2：开关默认值变更须为独立提交且以验收全绿为前置）。
 *
 * 开发期可用 `window.__CONEX_TABLE_ISLAND__ = true` 临时开启以做视觉/交互验收；
 * 生产路径不读 localStorage（避免宿主状态漂移）。
 */
export function isTableIslandEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as unknown as { __CONEX_TABLE_ISLAND__?: boolean })
    .__CONEX_TABLE_ISLAND__ === true;
}

/** 仅供测试/宿主显式设置开关（等价于写 `window.__CONEX_TABLE_ISLAND__`）。 */
export function setTableIslandEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { __CONEX_TABLE_ISLAND__?: boolean }).__CONEX_TABLE_ISLAND__ =
    enabled;
}

export interface IslandWindow {
  /** 需要渲染的行下标区间（闭区间，作用于传入的 rowTops 数组下标）。 */
  startRow: number;
  endRow: number;
  /** 是否启用了窗口化（false = 全量渲染）。 */
  windowed: boolean;
}

/**
 * 计算岛内需要渲染的行窗口。
 *
 * @param rowCount 表内行数（不含分隔行）
 * @param rowTops 各行相对岛顶部的像素偏移（升序；长度应为 rowCount + 1，末项为总高）
 * @param scrollTop 岛相对外层滚动容器的可见顶部偏移
 * @param viewportHeight 外层可视高度
 */
export function computeIslandWindow(
  rowCount: number,
  rowTops: readonly number[],
  scrollTop: number,
  viewportHeight: number
): IslandWindow {
  if (rowCount <= ISLAND_WINDOW_THRESHOLD) {
    return { startRow: 0, endRow: Math.max(0, rowCount - 1), windowed: false };
  }
  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewportHeight);

  // rowTops[i] = 第 i 行顶部；rowTops[i+1] = 第 i 行底部
  let first = 0;
  while (first < rowCount && (rowTops[first + 1] ?? 0) <= top) first++;
  let last = first;
  while (last < rowCount - 1 && (rowTops[last] ?? 0) < bottom) last++;

  const startRow = Math.max(0, first - ISLAND_OVERSCAN_ROWS);
  const endRow = Math.min(rowCount - 1, last + ISLAND_OVERSCAN_ROWS);
  return { startRow, endRow, windowed: true };
}

/**
 * 由列宽数组生成 CSS `grid-template-columns` 值（岛的列宽真源，ADR-4）。
 * 宽度非法（非有限数 / 小于最小宽）时回退为 `MIN_COL_WIDTH`。
 *
 * @param lastFlexible 末列是否吸收余量（ADR-4 §3.4 / U-T3-2 裁决：**是**）——
 *   岛轨 `min-width:100%` 而列宽之和不足时，余量必须由末列吸收，
 *   否则轨道右侧留下空白条（症状 S2 的「多出空列」根因）。
 *   缺省 `false` 保持既有纯 px 输出（既有单测口径不变）。
 */
export function buildGridTemplate(
  colWidths: readonly number[] | undefined,
  lastFlexible = false
): string {
  if (!colWidths || colWidths.length === 0) return '';
  const tracks = colWidths.map(
    (w) => `${Math.max(MIN_COL_WIDTH, Number.isFinite(w) ? Math.round(w) : MIN_COL_WIDTH)}px`
  );
  if (lastFlexible && tracks.length > 0) {
    const last = tracks.length - 1;
    tracks[last] = `minmax(${tracks[last]}, 1fr)`;
  }
  return tracks.join(' ');
}

/**
 * 校验列宽数组是否与该表当前列数一致（自愈：不一致即视为脏状态 → 回退为均分）。
 * 与 `TableStore.getWidthsFor` 的自愈口径一致（裁决 R4 的边界投影）。
 */
export function normalizeColWidths(
  colWidths: readonly number[] | undefined,
  cols: number
): number[] | undefined {
  if (!colWidths || colWidths.length !== cols) return undefined;
  return colWidths.map((w) => Math.max(MIN_COL_WIDTH, Number.isFinite(w) ? w : MIN_COL_WIDTH));
}

// ── 列宽分配器（ADR-4 §3.5「怎么算」）──────────────────────────────────────

/**
 * 由**固有宽**（离屏探针 rect，与当前列宽无关）与可用宽求解确定性列宽。
 *
 * 为什么必须确定性（I2 列宽无震荡）：分配器是 `(intrinsic, available)` 的
 * 纯函数，不含任何「上一帧结果」或测量时序依赖；同输入恒同输出，
 * 故重复测量恒等，不存在自增强收缩回路（ADR-4 否决 `scrollWidth` 的
 * 根本理由：换行后的 `scrollWidth` 随列宽变小而变小 → 越测越窄）。
 *
 * 规则：
 *   ① 逐列 `clamp(ceil(intrinsic), MIN_COL_WIDTH, MAX_COL_WIDTH)`；
 *   ② 若 `Σ > available`：按**固有宽从大到小**（同宽按下标升序稳定）单趟
 *      削减到 `MIN_COL_WIDTH` 为止，**不再往下减**（不足则允许岛横向滚动，
 *      不牺牲最小可读宽，F-Lay-1 合法）；
 *   ③ 若 `Σ ≤ available`：原样返回（余量由末列的 `1fr` 吸收，见
 *      `buildGridTemplate(w, true)`）。
 */
export function allocateColWidths(
  intrinsic: readonly number[],
  available: number
): number[] {
  const n = intrinsic.length;
  if (n === 0) return [];
  const out = intrinsic.map((w) => {
    const v = Number.isFinite(w) ? Math.ceil(w) : MIN_COL_WIDTH;
    return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, v));
  });
  if (!Number.isFinite(available) || available <= 0) return out;
  let over = out.reduce((a, b) => a + b, 0) - available;
  if (over <= 0) return out;
  const order = out
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w - a.w || a.i - b.i);
  for (const { i } of order) {
    if (over <= 0) break;
    const reducible = out[i] - MIN_COL_WIDTH;
    if (reducible <= 0) continue;
    const cut = Math.min(reducible, over);
    out[i] -= cut;
    over -= cut;
  }
  return out;
}

// ── 岛内行高前缀（窗口化的行号↔像素换算）───────────────────────────────────

/**
 * 岛内行高前缀表：行号 → 岛内像素偏移（`tops[i]` = 第 i 行顶部，
 * `tops[count]` = 总高）。
 *
 * 与 04-分维 §3.3 的偏差（**已登记**）：原文要求岛内 Fenwick（O(log n) 点更新）。
 * 实测口径下不需要——点更新（行高实测回填）只来自岛内**已挂载行**的
 * ResizeObserver，量级 ≤ 窗口行数；而重建一次前缀是 `count` 次浮点加法
 * （1 万行 ≈ 10µs），远低于一帧预算。故采用「脏标记 + 一次 O(n) 重算」，
 * 少一层数据结构与一处失效路径（反过度设计）。
 */
export class RowTopIndex {
  private heights: Float64Array;
  private topsCache: Float64Array;
  private dirty = true;
  private count: number;

  constructor(count: number, estimate: (i: number) => number) {
    this.count = Math.max(0, count);
    this.heights = new Float64Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const h = estimate(i);
      this.heights[i] = Math.max(0, Number.isFinite(h) ? h : 0);
    }
    this.topsCache = new Float64Array(this.count + 1);
  }

  get rowCount(): number {
    return this.count;
  }

  /** 行数变更（内容 epoch）：保留已测行的行高，新增行用 estimate 求值。 */
  setCount(count: number, estimate: (i: number) => number): void {
    if (count === this.count) return;
    const next = new Float64Array(Math.max(0, count));
    for (let i = 0; i < count; i++) {
      next[i] =
        i < this.count
          ? this.heights[i]
          : Math.max(0, Number.isFinite(estimate(i)) ? estimate(i) : 0);
    }
    this.heights = next;
    this.count = count;
    this.topsCache = new Float64Array(Math.max(0, count) + 1);
    this.dirty = true;
  }

  /** 写一行实测高（|Δ| < 0.5px 视为稳定点，不写——与 HeightMap 同款护栏）。 */
  setHeight(i: number, h: number): boolean {
    if (i < 0 || i >= this.count) return false;
    const v = Math.max(0, Number.isFinite(h) ? h : 0);
    if (Math.abs(this.heights[i] - v) < 0.5) return false;
    this.heights[i] = v;
    this.dirty = true;
    return true;
  }

  getHeight(i: number): number {
    return i >= 0 && i < this.count ? this.heights[i] : 0;
  }

  /** 行顶部偏移数组（长度 = rowCount + 1）；脏时一次 O(n) 重算。 */
  tops(): Float64Array {
    if (this.dirty) {
      let acc = 0;
      const t = this.topsCache;
      t[0] = 0;
      for (let i = 0; i < this.count; i++) {
        acc += this.heights[i];
        t[i + 1] = acc;
      }
      this.dirty = false;
    }
    return this.topsCache;
  }

  top(i: number): number {
    const t = this.tops();
    return t[Math.max(0, Math.min(i, this.count))];
  }

  total(): number {
    return this.top(this.count);
  }
}

// ── 岛登记点（I2 / I3 的可断言面）───────────────────────────────────────────

export interface IslandCounterStats {
  /** tableId → 计数 */
  perTable: Readonly<Record<string, number>>;
  totalCalls: number;
}

/** 极简 per-table 计数器（与 `tableSettle.ts` 的登记点同构） */
function createCounter() {
  const counts = new Map<string, number>();
  return {
    record(id: string): void {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    },
    snapshot(): IslandCounterStats {
      const perTable: Record<string, number> = {};
      let totalCalls = 0;
      for (const [k, v] of counts) {
        perTable[k] = v;
        totalCalls += v;
      }
      return { perTable, totalCalls };
    },
    reset(): void {
      counts.clear();
    },
  };
}

const heightReporter = createCounter();
const gridWriter = createCounter();

/**
 * 登记一次**岛高上报**（I3「表格高度有且只有一个上报源」）。
 *
 * 唯一合法调用方 = 岛根 ResizeObserver 回调（`TableBlock`）。行级测量、
 * 外层批量测量循环**一律不得**调用本函数——I3 的运行时断言即
 * 「稳定后本计数不再增长」+「上报调用方唯一」。
 */
export function recordIslandHeightReport(tableId: string): void {
  heightReporter.record(tableId);
}

/** 岛高上报计数快照（per-table + 总数） */
export function getIslandHeightStats(): IslandCounterStats {
  return heightReporter.snapshot();
}

/** 清零岛高上报计数（测试隔离；生产不调用） */
export function resetIslandHeightStats(): void {
  heightReporter.reset();
}

/**
 * 登记一次 **岛栅格写入**（I2「列宽无震荡」的可断言面）。
 *
 * 只在 `--table-cols` / `gridTemplateColumns` **实际发生变化**时调用；
 * 相同输入重复测量必须零写入（否则即为震荡）。
 */
export function recordIslandGridWrite(tableId: string): void {
  gridWriter.record(tableId);
}

/** 岛栅格写入计数快照 */
export function getIslandGridWriteStats(): IslandCounterStats {
  return gridWriter.snapshot();
}

/** 清零岛栅格写入计数（测试隔离；生产不调用） */
export function resetIslandGridWriteStats(): void {
  gridWriter.reset();
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__CRISH_TABLE_ISLAND__STATS__', {
    configurable: true,
    enumerable: true,
    get: () => ({
      heightReports: getIslandHeightStats(),
      gridWrites: getIslandGridWriteStats(),
    }),
  });
}

declare global {
  interface Window {
    /** 岛登记点只读钩子（tableIsland.ts 安装）：岛高上报 / 栅格写入计数 */
    __CRISH_TABLE_ISLAND__STATS__?: {
      heightReports: IslandCounterStats;
      gridWrites: IslandCounterStats;
    };
  }
}
