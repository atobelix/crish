/**
 * TableIslandRanges —— 表格区间索引（战役 table-systemic-remediation · T4）
 *
 * 权威文档：docs/table-systemic-remediation/04-分维-单容器渲染与测量时序.md §3.3
 *          docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-2 / ADR-5）
 *
 * 本模块解决两件事：
 *   ① **区间查询**：给定行号，返回其所属表格的区间（宿主行 / 内部行 / 表头 / 列数），
 *      身份一律经 `tableIdentity` 的 SSOT（`resolveTableId` + `getTableIdentity`），
 *      不在渲染层重新推导（I5 / I10）。
 *   ② **虚拟项折叠**：把外层虚拟化算出的候选索引折叠为「非表格行 + 每张表的宿主行」，
 *      使**整表成为单一虚拟项**（ADR-2）。窗口落在表内部时，宿主行即使不在候选窗口内
 *      也**注入**返回——否则表在视口内将没有任何虚拟项，整表消失。
 *
 * 缓存策略（内容 epoch）：区间探测走 `resolveTableId`，其「同签名序位」扫描
 * （`tableIdentity.countPrecedingSameSignature`）是 O(前序行数) 的；故本模块按
 * **内容 epoch**（`mainLines` / `streamTail` 引用 + 行数）缓存已发现的区间，
 * 同一 epoch 内每张表只探测一次，之后为 O(区间数) 命中查询。
 * 无内容变更的滚动/光标帧**零探测**。
 *
 * 纯逻辑：零 DOM、零 React；`getLine` 与 epoch 令牌由调用方注入。
 */
import { getTableIdentity, isTableRowText, resolveTableId } from './tableIdentity';

/** 表格区间（宿主行 = 表首行；`endLine` 为闭区间末行）。 */
export interface TableRangeInfo {
  id: string;
  startLine: number;
  endLine: number;
  /** 分隔行行号；无分隔行时 `null`。 */
  separatorLine: number | null;
  /** 是否存在表头（分隔行紧随表首行）。 */
  hasHeader: boolean;
  cols: number;
}

/**
 * 内容 epoch 令牌：任一字段引用变化即视为新 epoch（缓存失效）。
 * 由调用方从 store 读取（`mainLines` / `streamTail` / `lineCount`）。
 */
export interface ContentEpoch {
  main: unknown;
  tail: unknown;
  count: number;
}

export interface TableRangeIndexStats {
  /** 当前 epoch 内已发现的区间数 */
  ranges: number;
  /** 累计探测次数（`resolveTableId` 实际调用次数） */
  probes: number;
  /** 累计 epoch 切换次数 */
  epochs: number;
}

export class TableRangeIndex {
  private epoch: ContentEpoch | null = null;
  private ranges: TableRangeInfo[] = [];
  private misses = new Set<number>();
  private probes = 0;
  private epochs = 0;
  private readonly getLine: (i: number) => string;
  private readonly getEpoch: () => ContentEpoch;

  constructor(getLine: (i: number) => string, getEpoch: () => ContentEpoch) {
    this.getLine = getLine;
    this.getEpoch = getEpoch;
  }

  /** 该行所属表格区间；非表格行返回 `null`。 */
  rangeAt(lineIndex: number): TableRangeInfo | null {
    if (lineIndex < 0) return null;
    this.syncEpoch();
    const hit = this.find(lineIndex);
    if (hit) return hit;
    if (this.misses.has(lineIndex)) return null;
    if (!isTableRowText(this.safeLine(lineIndex))) {
      this.misses.add(lineIndex);
      return null;
    }
    this.probes++;
    const id = resolveTableId(this.getLine, lineIndex);
    if (!id) {
      this.misses.add(lineIndex);
      return null;
    }
    const e = getTableIdentity(id);
    if (!e) {
      this.misses.add(lineIndex);
      return null;
    }
    const info: TableRangeInfo = {
      id,
      startLine: e.startLine,
      endLine: e.endLine,
      separatorLine: e.separatorLine,
      hasHeader: e.hasHeader,
      cols: e.cols,
    };
    // 同一区间可能由多行分别探测（首行命中后不再探测）——去重后入表
    const dup = this.find(info.startLine);
    if (dup) return dup;
    this.ranges.push(info);
    return info;
  }

  /** 该行是否为某表格的**宿主行**（= 岛宿主行 / 单一虚拟项）。 */
  isHost(lineIndex: number): boolean {
    const r = this.rangeAt(lineIndex);
    return r !== null && r.startLine === lineIndex;
  }

  /**
   * 折叠候选虚拟索引（ADR-2「整表一个虚拟项」）：
   *   - 非表格行 → 原样保留；
   *   - 表格行（宿主或内部）→ **只保留宿主行**；宿主行不在候选内时注入。
   * 返回升序去重数组（DOM 顺序与 tab 顺序稳定）。
   */
  collapse(indices: readonly number[]): number[] {
    const out = new Set<number>();
    for (const i of indices) {
      const r = this.rangeAt(i);
      if (!r) {
        out.add(i);
        continue;
      }
      out.add(r.startLine);
    }
    return [...out].sort((a, b) => a - b);
  }

  /** 遍历区间内部行（不含宿主行）；避免为大表物化中间数组。 */
  forEachInternalRow(range: TableRangeInfo, fn: (line: number) => void): void {
    for (let i = range.startLine + 1; i <= range.endLine; i++) fn(i);
  }

  stats(): TableRangeIndexStats {
    return { ranges: this.ranges.length, probes: this.probes, epochs: this.epochs };
  }

  /** 清空缓存（整文替换 / 测试隔离用）。 */
  reset(): void {
    this.epoch = null;
    this.ranges = [];
    this.misses.clear();
  }

  private safeLine(i: number): string {
    return this.getLine(i) ?? '';
  }

  private find(lineIndex: number): TableRangeInfo | null {
    for (const r of this.ranges) {
      if (lineIndex >= r.startLine && lineIndex <= r.endLine) return r;
    }
    return null;
  }

  private syncEpoch(): void {
    const next = this.getEpoch();
    const cur = this.epoch;
    if (
      cur &&
      cur.main === next.main &&
      cur.tail === next.tail &&
      cur.count === next.count
    ) {
      return;
    }
    this.epoch = { main: next.main, tail: next.tail, count: next.count };
    this.ranges = [];
    this.misses.clear();
    this.epochs++;
  }
}
