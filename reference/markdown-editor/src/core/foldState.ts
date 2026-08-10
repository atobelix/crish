// src/core/foldState.ts
// B3 折叠区间（N3 折叠区间 API）：fold ranges 状态——fold/unfold API。
//
// 架构选型（review-P2 方案评审 §3.1 裁决，方案 B）：保留行 + 渲染跳过。
// - 折叠区间内行保留在文档行号坐标系（HeightMap 槽位 / token 映射 / 行号
//   索引零漂移），渲染层跳过隐藏行（isHidden）、区间首行渲染为折叠占位行
//   （isPlaceholder）；
// - 折叠/展开不触发 HeightMap 结构变更（insert/delete 不动），只做行高批量
//   更新（隐藏行 → 0、占位行 → FOLD_PLACEHOLDER_HEIGHT 1 行高）——批量路径：
//   单次 setHeight 循环 + 单次 flush（HeightMap.setHeight 内部 dirtyMin
//   批量记账 + flush() 一次重算块累计，与滚动管线批的回填协议同构）；
// - 行高备份：折叠时按行号备份原高，展开时原值恢复（展开无损）；编辑平移
//   时备份与区间同规则平移（插入/删除平移 + 局部重建，fenceLines 同款范式）。
// - 引擎只消费不持久化：折叠状态由宿主注入（消息边界折叠存宿主 session
//   store），经 MarkdownEngine handle 的 foldRange/unfold 驱动。
//
// 区间不变量：按 startLine 升序、互不重叠（foldRange 重叠拒绝）。
// 编辑语义（applyLineChange）：编辑点完全在区间后 → 不动；完全在区间前 →
// 平移；落在区间内 → 区域吸收（新行并入区间保持隐藏、删除使区间收缩）；
// 区间首行被删除 → 占位行重锚定；退化（坍缩 ≤1 行）/越界区间丢弃（残留
// 行高恢复）。
//
// 性能口径：无折叠态时全部路径零开销（applyLineChange 快速跳过）；折叠态
// 下每次编辑 O(折叠总行数) 的批量行高核对（多数为稳定点跳过 O(1) 无写，
// 实际写入 O(编辑量)）——折叠是浏览/只读态功能，编辑与折叠同开属罕见路径。

import type { HeightMap } from './HeightMap';

/** 折叠区间（闭区间行号，文档坐标） */
export interface FoldRange {
  startLine: number;
  endLine: number;
}

/** 折叠占位行高度（px）：1 行高，与 index.css --grid-size: 28px 对齐 */
export const FOLD_PLACEHOLDER_HEIGHT = 28;

/** 折叠状态构造选项 */
export interface FoldStateOptions {
  /** 行高重预测（备份缺失/编辑后新行回退；引擎注入 oracle 预测闭包） */
  predictHeight: (line: number) => number;
}

/**
 * 折叠状态：fold ranges 数据 + 行高备份 + HeightMap 批量联动（一体设计，
 * 使「折叠/展开/行高联动」在 node 环境可直接单元测试——组件层只负责
 * virtualizer 缓存同步与渲染跳过）。
 */
export class FoldState {
  /** 折叠区间（startLine 升序、互不重叠） */
  private ranges: FoldRange[] = [];
  /** 行高备份：行号 → 折叠时的行高（展开/丢弃时原值恢复；编辑时与区间同规则平移） */
  private backups = new Map<number, number>();
  private readonly predictHeight: (line: number) => number;

  constructor(opts: FoldStateOptions) {
    this.predictHeight = opts.predictHeight;
  }

  // ── 折叠/展开（批量行高路径）──

  /**
   * 折叠 [startLine, endLine]（闭区间）：至少两行、与既有区间重叠时拒绝。
   * 行高批量更新：区间首行置占位高、其余置 0（原值先行备份），单次 flush。
   * 返回实际变更行号（引擎据此逐行 resizeItem 刷新 virtualizer 缓存）；
   * 拒绝（越界/重叠）返回 null。
   */
  foldRange(
    hm: HeightMap,
    startLine: number,
    endLine: number
  ): number[] | null {
    if (startLine < 0 || endLine <= startLine) return null;
    const ranges = this.ranges;
    // 重叠检查：二分定位候选插入点（第一个 startLine > startLine 的区间）
    let lo = 0;
    let hi = ranges.length - 1;
    let idx = ranges.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ranges[mid].startLine <= startLine) {
        idx = mid + 1;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx > 0 && ranges[idx - 1].endLine >= startLine) return null;
    if (idx < ranges.length && ranges[idx].startLine <= endLine) return null;
    const range: FoldRange = { startLine, endLine };
    ranges.splice(idx, 0, range);
    // 行高备份（展开无损的前提）
    for (let i = startLine; i <= endLine; i++) {
      const h = hm.getHeight(i);
      if (h !== undefined) this.backups.set(i, h);
    }
    return this.applyRangeHeights(hm, range);
  }

  /**
   * 展开包含 line 的区间（line 可为区间内任意行，含隐藏行——宿主消息
   * 折叠场景的「点击占位行展开」与「隐藏行展开」语义统一）。
   * 行高按备份原值恢复（缺失行回退 predictHeight 重预测），批量单次 flush。
   * 返回变更行号；无命中返回 null。
   */
  unfold(hm: HeightMap, line: number): number[] | null {
    const r = this.getRangeAt(line);
    if (!r) return null;
    const idx = this.ranges.indexOf(r);
    this.ranges.splice(idx, 1);
    const changed: number[] = [];
    for (let i = r.startLine; i <= r.endLine; i++) {
      this.restoreHeight(hm, i, changed);
    }
    hm.flush();
    return changed;
  }

  /** 全部展开（宿主切换文档/清空折叠态）：恢复全部区间行高并清空状态 */
  unfoldAll(hm: HeightMap): number[] {
    const changed: number[] = [];
    for (const r of this.ranges) {
      for (let i = r.startLine; i <= r.endLine; i++) {
        this.restoreHeight(hm, i, changed);
      }
    }
    hm.flush();
    this.ranges = [];
    this.backups.clear();
    return changed;
  }

  // ── 查询（渲染跳过契约：isHidden 跳过渲染、isPlaceholder 渲染占位行）──

  /** 是否处于折叠状态（区间内任意行，含占位行） */
  isFolded(line: number): boolean {
    return this.getRangeAt(line) !== undefined;
  }

  /** 折叠区间内且非首行 → 渲染跳过（0 高行不物化 DOM） */
  isHidden(line: number): boolean {
    const r = this.getRangeAt(line);
    return r !== undefined && line !== r.startLine;
  }

  /** 区间首行 → 折叠占位行（折叠条 + 展开按钮） */
  isPlaceholder(line: number): boolean {
    const r = this.getRangeAt(line);
    return r !== undefined && line === r.startLine;
  }

  /** 包含 line 的区间（二分；无命中 undefined） */
  getRangeAt(line: number): FoldRange | undefined {
    const ranges = this.ranges;
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = ranges[mid];
      if (r.startLine <= line && line <= r.endLine) return r;
      if (r.startLine > line) hi = mid - 1;
      else lo = mid + 1;
    }
    return undefined;
  }

  getRanges(): readonly FoldRange[] {
    return this.ranges;
  }

  get rangeCount(): number {
    return this.ranges.length;
  }

  // ── 编辑平移（fenceLines 同款：插入/删除平移 + 局部重建）──

  /**
   * 行数变化平移（编辑定位信息由调用方经双段 diff 提供）：
   * 区间平移 + 备份平移 + 受影响行高批量修正，一次完成。
   * - 平移规则：编辑点完全在区间前 → 平移；完全在区间后 → 不动；
   *   落在区间内 → 区域吸收（删除收缩、插入并入隐藏）；
   *   区间首行被删除 → 占位行重锚定；退化/越界区间丢弃（残留行高恢复）；
   * - 行高修正：新区间逐行重应用 0/占位高（批量核对，稳定点跳过无写）；
   *   旧折叠值泄漏区（区间外残留的 0/占位高）恢复真实行高；
   * - 备份平移与区间同规则（键平移 + 删除段键剔除）——展开时按平移后
   *   行号精确恢复原值（编辑后新行无备份 → 回退重预测）。
   * 返回实际变更行号（引擎据此逐行 resizeItem）。
   */
  applyLineChange(
    hm: HeightMap,
    startLineIdx: number,
    deleteCount: number,
    newCount: number,
    lineCount: number
  ): number[] {
    const changed: number[] = [];
    const delta = newCount - deleteCount;
    const ranges = this.ranges;
    // —— 无折叠态快速路径：全部路径零开销 ——
    if (ranges.length === 0) return changed;
    // —— 区间平移（保留 old 坐标供泄漏区恢复）——
    const pairs: Array<{ old: FoldRange; cur: FoldRange }> = [];
    const dropped: FoldRange[] = [];
    const next: FoldRange[] = [];
    for (const r of ranges) {
      let ns: number;
      let ne: number;
      if (r.endLine < startLineIdx) {
        // 编辑点完全在区间后：不动（高度已正确，无泄漏）
        next.push(r);
        pairs.push({ old: r, cur: r });
        continue;
      }
      if (r.startLine >= startLineIdx + deleteCount) {
        // 编辑点完全在区间前：整体平移
        ns = r.startLine + delta;
        ne = r.endLine + delta;
      } else if (r.startLine < startLineIdx) {
        // 编辑点落在区间内部（首行保留）：区域吸收增量
        ns = r.startLine;
        ne = Math.max(r.startLine, r.endLine + delta);
      } else {
        // 区间首行在删除段内：占位行重锚定到删除段终点
        ns = startLineIdx + Math.max(0, delta);
        ne = r.endLine + delta;
      }
      if (ns >= lineCount) continue; // 完全越界：无残留行，直接丢弃
      if (ne > lineCount - 1) ne = lineCount - 1;
      if (ne <= ns) {
        // 退化（坍缩 ≤1 行）：旧折叠值残留在整个旧区间跨度 → 全部恢复真实
        // 行高（备份缺失行走重预测 + 引擎测量回环自愈）
        dropped.push(r);
        const restoreLo = Math.max(r.startLine, 0);
        const restoreHi = Math.min(r.endLine, lineCount - 1);
        for (let i = restoreLo; i <= restoreHi; i++) {
          this.restorePredict(hm, i, changed);
        }
        continue;
      }
      const cur: FoldRange = { startLine: ns, endLine: ne };
      next.push(cur);
      pairs.push({ old: r, cur });
    }
    this.ranges = next;
    // —— 备份平移（与区间同规则：键平移 + 删除段键剔除）——
    if (this.backups.size > 0) {
      const translated = new Map<number, number>();
      for (const [line, h] of this.backups) {
        if (line < startLineIdx) {
          translated.set(line, h);
        } else if (line >= startLineIdx + deleteCount) {
          translated.set(line + delta, h);
        }
        // 删除段内的键：行已不存在，备份丢弃
      }
      this.backups = translated;
    }
    // —— 泄漏区恢复：旧折叠值（0/占位高）残留在新区间之外 → 恢复真实行高 ——
    // 数学上泄漏区（[old.start, cur.start) ∪ (cur.end, old.end]）的线在新旧
    // 坐标下均不可能是旧折叠行（其原像恒在旧区间之外），备份必然缺失，
    // 统一走重预测；预测偏差由引擎测量回环自愈。
    for (const { old, cur } of pairs) {
      for (let i = old.startLine; i < cur.startLine; i++) {
        if (i < lineCount) this.restorePredict(hm, i, changed);
      }
      for (let i = cur.endLine + 1; i <= old.endLine; i++) {
        if (i < lineCount) this.restorePredict(hm, i, changed);
      }
    }
    // —— 区间行高重应用（批量核对：占位 1 行高 / 其余 0；稳定点跳过）——
    for (const cur of next) {
      this.applyRangeHeights(hm, cur, changed);
    }
    hm.flush();
    return changed;
  }

  /**
   * 全量重建兜底（setText 等整文档替换路径）：越界区间丢弃（残留行高
   * 恢复）、存活区间重应用折叠行高、备份越界键清理。返回变更行号。
   */
  clamp(hm: HeightMap, lineCount: number): number[] {
    const changed: number[] = [];
    const next: FoldRange[] = [];
    for (const r of this.ranges) {
      if (r.startLine >= lineCount) continue; // 完全越界：无残留行，直接丢弃
      const ne = Math.min(r.endLine, lineCount - 1);
      if (ne <= r.startLine) {
        this.restorePredict(hm, r.startLine, changed);
        continue;
      }
      next.push({ startLine: r.startLine, endLine: ne });
    }
    // 备份越界键清理（整文档替换路径低频，全量过滤可接受）
    if (this.backups.size > 0) {
      for (const key of [...this.backups.keys()]) {
        if (key >= lineCount) this.backups.delete(key);
      }
    }
    this.ranges = next;
    for (const cur of next) {
      this.applyRangeHeights(hm, cur, changed);
    }
    hm.flush();
    return changed;
  }

  // ── 内部工具 ──

  /** 区间行高批量应用：首行占位高、其余 0（setHeight 稳定点判定内置，实际
   *  写入才计入 changed——引擎据此逐行 resizeItem，无写即零 notify） */
  private applyRangeHeights(
    hm: HeightMap,
    range: FoldRange,
    changed?: number[]
  ): number[] {
    const out = changed ?? [];
    for (let i = range.startLine; i <= range.endLine; i++) {
      const target =
        i === range.startLine ? FOLD_PLACEHOLDER_HEIGHT : 0;
      if (hm.setHeight(i, target)) out.push(i);
    }
    return out;
  }

  /** 行高恢复（备份优先，缺失回退重预测）；备份随恢复删除（一次性语义） */
  private restoreHeight(hm: HeightMap, line: number, changed: number[]): void {
    const b = this.backups.get(line);
    if (b !== undefined) {
      this.backups.delete(line);
      if (hm.setHeight(line, b)) changed.push(line);
    } else if (hm.setHeight(line, this.predictHeight(line))) {
      changed.push(line);
    }
  }

  /** 泄漏区/退化区恢复：无备份语义（该区线从未折叠），直接重预测 */
  private restorePredict(hm: HeightMap, line: number, changed: number[]): void {
    if (hm.setHeight(line, this.predictHeight(line))) changed.push(line);
  }
}
