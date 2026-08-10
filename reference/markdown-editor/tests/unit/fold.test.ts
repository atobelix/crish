// tests/unit/fold.test.ts
// B3 折叠区间（N3）：FoldState + HeightMap 行高联动单元测试
//
// 覆盖：
// 1. 折叠/展开基础 + 查询契约（isFolded/isHidden/isPlaceholder/getRangeAt
//    ——渲染跳过语义的纯数据侧）；
// 2. 行高批量联动：折叠置 0/占位 1 行高、展开按备份原值恢复（无损）、
//    HeightMap totalHeight 逐段一致；
// 3. 重叠拒绝 / 非法区间（单行/反序/负行号）；
// 4. 编辑平移（fenceLines 同款）：编辑点后区间平移（含泄漏区恢复）、
//    区域吸收（插入并入隐藏/删除收缩）、占位行删除重锚定、退化丢弃；
// 5. 备份平移完整性：折叠 → 编辑 → 展开后行高按平移后行号精确恢复；
// 6. clamp 全量重建兜底（裁剪/越界丢弃/行高重应用）。

import { describe, it, expect } from 'vitest';
import { FoldState, FOLD_PLACEHOLDER_HEIGHT } from '../../src/core/foldState';
import { HeightMap } from '../../src/core/HeightMap';

/** 常规行高（模拟非折叠行的预测/实测行高） */
const ROW_H = 36;

/** 构造 N 行等行高的 HeightMap */
function makeMap(n: number): HeightMap {
  const hm = new HeightMap();
  hm.syncTo(n, () => ROW_H);
  return hm;
}

/** 构造折叠状态（行高重预测恒返回 ROW_H——便于精确断言） */
function makeState(): FoldState {
  return new FoldState({ predictHeight: () => ROW_H });
}

/** 区间行高快照（断言辅助） */
function heights(hm: HeightMap, from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(hm.getHeight(i)!);
  return out;
}

describe('折叠/展开 + 查询契约（渲染跳过语义）', () => {
  it('foldRange：区间登记 + 行高批量联动（占位 1 行高/其余 0）+ total 一致', () => {
    const hm = makeMap(12);
    const fs = makeState();
    const changed = fs.foldRange(hm, 3, 8);
    expect(changed).not.toBeNull();
    // 批量行高：首行占位高、其余 0，区间外不变
    expect(hm.getHeight(3)).toBe(FOLD_PLACEHOLDER_HEIGHT);
    for (let i = 4; i <= 8; i++) expect(hm.getHeight(i)).toBe(0);
    expect(hm.getHeight(2)).toBe(ROW_H);
    expect(hm.getHeight(9)).toBe(ROW_H);
    // 总高 = 3×36 + 28 + 3×36（indexAt/getTotalSize 的一致性基础）
    expect(hm.totalHeight).toBeCloseTo(3 * ROW_H + FOLD_PLACEHOLDER_HEIGHT + 3 * ROW_H, 5);
    // 变更行列表 = 实际写入行（引擎据此逐行 resizeItem）
    expect(changed).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('查询契约：占位行（渲染占位条）/ 隐藏行（渲染跳过）/ 区间外正常', () => {
    const hm = makeMap(12);
    const fs = makeState();
    fs.foldRange(hm, 3, 8);
    for (let i = 0; i < 12; i++) {
      if (i === 3) {
        expect(fs.isFolded(i)).toBe(true);
        expect(fs.isPlaceholder(i)).toBe(true);
        expect(fs.isHidden(i)).toBe(false); // 首行不跳过（占位行本体）
      } else if (i > 3 && i <= 8) {
        expect(fs.isFolded(i)).toBe(true);
        expect(fs.isPlaceholder(i)).toBe(false);
        expect(fs.isHidden(i)).toBe(true); // 渲染跳过
      } else {
        expect(fs.isFolded(i)).toBe(false);
        expect(fs.isHidden(i)).toBe(false);
      }
    }
    expect(fs.getRangeAt(5)).toEqual({ startLine: 3, endLine: 8 });
    expect(fs.getRangeAt(3)).toEqual({ startLine: 3, endLine: 8 });
    expect(fs.getRangeAt(9)).toBeUndefined();
    expect(fs.rangeCount).toBe(1);
  });

  it('unfold：隐藏行/占位行均可展开；行高按备份原值恢复（无损）', () => {
    const hm = makeMap(12);
    const fs = makeState();
    fs.foldRange(hm, 3, 8);
    // 用隐藏行 5 展开（宿主「点击占位行/隐藏行展开」语义统一）
    const changed = fs.unfold(hm, 5);
    expect(changed).not.toBeNull();
    for (let i = 3; i <= 8; i++) expect(hm.getHeight(i)).toBe(ROW_H);
    expect(hm.totalHeight).toBeCloseTo(12 * ROW_H, 5);
    expect(fs.rangeCount).toBe(0);
    expect(fs.getRangeAt(3)).toBeUndefined();
    // 未命中返回 null
    expect(fs.unfold(hm, 3)).toBeNull();
  });

  it('unfoldAll：一次清空全部区间并恢复全部行高', () => {
    const hm = makeMap(12);
    const fs = makeState();
    fs.foldRange(hm, 2, 4);
    fs.foldRange(hm, 7, 9);
    const changed = fs.unfoldAll(hm);
    expect(changed.length).toBeGreaterThan(0);
    expect(fs.rangeCount).toBe(0);
    expect(hm.totalHeight).toBeCloseTo(12 * ROW_H, 5);
  });

  it('重叠拒绝 / 非法区间：至少两行、互不重叠（含端点接触）、行号合法', () => {
    const hm = makeMap(12);
    const fs = makeState();
    expect(fs.foldRange(hm, 3, 8)).not.toBeNull();
    expect(fs.foldRange(hm, 3, 8)).toBeNull(); // 同区间重复折叠
    expect(fs.foldRange(hm, 5, 9)).toBeNull(); // 内部重叠
    expect(fs.foldRange(hm, 1, 3)).toBeNull(); // 端点接触重叠
    expect(fs.foldRange(hm, 8, 10)).toBeNull();
    expect(fs.foldRange(hm, 9, 11)).not.toBeNull(); // 邻接合法（不重叠）
    expect(fs.foldRange(hm, 4, 4)).toBeNull(); // 单行
    expect(fs.foldRange(hm, 9, 4)).toBeNull(); // 反序
    expect(fs.foldRange(hm, -1, 4)).toBeNull(); // 负行号
  });
});

describe('编辑平移（fenceLines 同款：插入/删除平移 + 局部重建）', () => {
  it('编辑点完全在区间后（尾部追加/删除）：区间与行高均不动', () => {
    const hm = makeMap(12);
    const fs = makeState();
    fs.foldRange(hm, 3, 8);
    const before = heights(hm, 0, 11);
    expect(fs.applyLineChange(hm, 10, 0, 2, 14)).toEqual([]);
    expect(fs.getRangeAt(3)).toEqual({ startLine: 3, endLine: 8 });
    expect(heights(hm, 0, 11)).toEqual(before);
  });

  it('编辑点完全在区间前（前插）：区间平移 + 泄漏区恢复 + 备份平移', () => {
    const hm = makeMap(12);
    const fs = makeState();
    fs.foldRange(hm, 3, 8);
    // 镜像引擎契约：批量测量 effect 先 syncTo 补齐新增行预测高，
    // 折叠平移修正只作用在已落库的行高上
    hm.syncTo(14, () => ROW_H);
    const changed = fs.applyLineChange(hm, 0, 0, 2, 14);
    expect(changed.length).toBeGreaterThan(0);
    // 区间平移 [3,8] → [5,10]
    expect(fs.getRangeAt(5)).toEqual({ startLine: 5, endLine: 10 });
    expect(fs.getRangeAt(3)).toBeUndefined();
    // 行高：新占位 5 → 28；隐藏 6..10 → 0；泄漏区 [3,5) 恢复真实行高
    expect(hm.getHeight(5)).toBe(FOLD_PLACEHOLDER_HEIGHT);
    for (let i = 6; i <= 10; i++) expect(hm.getHeight(i)).toBe(0);
    expect(hm.getHeight(3)).toBe(ROW_H);
    expect(hm.getHeight(4)).toBe(ROW_H);
    expect(hm.getHeight(11)).toBe(ROW_H);
    expect(hm.getHeight(12)).toBe(ROW_H);
    // total 一致：14 行文档 = 8 常规行 + 占位 1 行高
    expect(hm.totalHeight).toBeCloseTo(8 * ROW_H + FOLD_PLACEHOLDER_HEIGHT, 5);
  });

  it('备份平移完整性：折叠 → 前插 → 展开后行高按平移后行号精确恢复', () => {
    const hm = makeMap(12);
    const fs = makeState();
    fs.foldRange(hm, 3, 8);
    hm.syncTo(14, () => ROW_H);
    fs.applyLineChange(hm, 0, 0, 2, 14); // 前插 2 行 → 区间 [5,10]
    fs.unfold(hm, 7); // 展开（隐藏行命中）
    for (let i = 0; i < 14; i++) expect(hm.getHeight(i)).toBe(ROW_H);
    expect(hm.totalHeight).toBeCloseTo(14 * ROW_H, 5);
    expect(fs.rangeCount).toBe(0);
  });

  it('区域吸收（插入落在区间内）：新区间并入隐藏，占位行不动', () => {
    const hm = makeMap(12);
    const fs = makeState();
    fs.foldRange(hm, 3, 8);
    hm.syncTo(14, () => ROW_H);
    fs.applyLineChange(hm, 5, 0, 2, 14);
    expect(fs.getRangeAt(3)).toEqual({ startLine: 3, endLine: 10 });
    expect(hm.getHeight(3)).toBe(FOLD_PLACEHOLDER_HEIGHT);
    for (let i = 4; i <= 10; i++) expect(hm.getHeight(i)).toBe(0);
    // 区间外新行不受影响
    expect(hm.getHeight(11)).toBe(ROW_H);
    expect(hm.getHeight(12)).toBe(ROW_H);
    expect(hm.getHeight(13)).toBe(ROW_H);
  });

  it('区域吸收（删除落在区间内）：区间收缩 + 泄漏区恢复', () => {
    const hm = makeMap(12);
    const fs = makeState();
    fs.foldRange(hm, 3, 8);
    hm.syncTo(10, () => ROW_H); // 删除后行数收缩（镜像引擎 truncate）
    fs.applyLineChange(hm, 5, 2, 0, 10);
    expect(fs.getRangeAt(3)).toEqual({ startLine: 3, endLine: 6 });
    expect(hm.getHeight(3)).toBe(FOLD_PLACEHOLDER_HEIGHT);
    for (let i = 4; i <= 6; i++) expect(hm.getHeight(i)).toBe(0);
    // 泄漏区 (6,8]：旧折叠值 → 真实行高
    expect(hm.getHeight(7)).toBe(ROW_H);
    expect(hm.getHeight(8)).toBe(ROW_H);
    expect(hm.totalHeight).toBeCloseTo(3 * ROW_H + FOLD_PLACEHOLDER_HEIGHT + 3 * ROW_H, 5);
  });

  it('占位行被删除：占位重锚定到删除段终点（新占位置 1 行高）', () => {
    const hm = makeMap(12);
    const fs = makeState();
    fs.foldRange(hm, 3, 8);
    fs.applyLineChange(hm, 3, 1, 0, 11); // 删第 3 行（占位行）
    expect(fs.getRangeAt(3)).toEqual({ startLine: 3, endLine: 7 });
    expect(hm.getHeight(3)).toBe(FOLD_PLACEHOLDER_HEIGHT);
    for (let i = 4; i <= 7; i++) expect(hm.getHeight(i)).toBe(0);
    expect(hm.getHeight(8)).toBe(ROW_H); // 泄漏区恢复
    // 展开后全部恢复（备份已随重锚定平移对齐）
    fs.unfold(hm, 3);
    for (let i = 0; i < 11; i++) expect(hm.getHeight(i)).toBe(ROW_H);
  });

  it('退化区间丢弃：区间坍缩 ≤1 行 → 旧跨度残留折叠值全部恢复', () => {
    const hm = makeMap(12);
    const fs = makeState();
    fs.foldRange(hm, 3, 5);
    hm.syncTo(9, () => ROW_H); // 删除后行数收缩（镜像引擎 truncate）
    fs.applyLineChange(hm, 4, 3, 0, 9); // 删 4,5,6 → [3,5] 只剩第 3 行
    expect(fs.rangeCount).toBe(0);
    for (let i = 3; i <= 5; i++) expect(hm.getHeight(i)).toBe(ROW_H);
    expect(hm.totalHeight).toBeCloseTo(9 * ROW_H, 5);
  });

  it('无折叠态：applyLineChange 零开销（空变更 + 不抛错）', () => {
    const hm = makeMap(12);
    const fs = makeState();
    expect(fs.applyLineChange(hm, 2, 1, 3, 14)).toEqual([]);
    expect(fs.applyLineChange(hm, 0, 12, 0, 0)).toEqual([]);
    expect(hm.totalHeight).toBeCloseTo(12 * ROW_H, 5);
  });

  it('多区间平移保持有序与互不重叠', () => {
    const hm = makeMap(20);
    const fs = makeState();
    fs.foldRange(hm, 3, 5);
    fs.foldRange(hm, 9, 11);
    fs.applyLineChange(hm, 0, 0, 3, 23); // 前插 3 行
    expect(fs.getRanges().map((r) => ({ ...r }))).toEqual([
      { startLine: 6, endLine: 8 },
      { startLine: 12, endLine: 14 },
    ]);
    expect(hm.getHeight(6)).toBe(FOLD_PLACEHOLDER_HEIGHT);
    expect(hm.getHeight(12)).toBe(FOLD_PLACEHOLDER_HEIGHT);
    for (let i = 7; i <= 8; i++) expect(hm.getHeight(i)).toBe(0);
    for (let i = 13; i <= 14; i++) expect(hm.getHeight(i)).toBe(0);
  });
});

describe('clamp 全量重建兜底（setText 路径）', () => {
  it('区间越界裁剪 + 行高重应用 + 备份越界键清理', () => {
    const hm = makeMap(12);
    const fs = makeState();
    fs.foldRange(hm, 3, 8);
    fs.foldRange(hm, 10, 11);
    hm.syncTo(6, () => ROW_H); // 文档缩到 6 行（镜像引擎 truncate）
    const changed = fs.clamp(hm, 6);
    // 折叠行高已由 foldRange 应用过 → clamp 重应用为幂等无写；
    // 语义断言集中在区间裁剪与行高状态
    expect(changed).toEqual([]);
    // [3,8] → [3,5]；[10,11] 完全越界丢弃
    expect(fs.getRanges().map((r) => ({ ...r }))).toEqual([
      { startLine: 3, endLine: 5 },
    ]);
    expect(hm.getHeight(3)).toBe(FOLD_PLACEHOLDER_HEIGHT);
    expect(hm.getHeight(4)).toBe(0);
    expect(hm.getHeight(5)).toBe(0);
    expect(hm.totalHeight).toBeCloseTo(3 * ROW_H + FOLD_PLACEHOLDER_HEIGHT, 5);
    // 裁剪后的区间可正常展开（备份键未越界）
    fs.unfold(hm, 4);
    for (let i = 0; i < 6; i++) expect(hm.getHeight(i)).toBe(ROW_H);
  });

  it('空文档 clamp：全部区间丢弃，不抛错', () => {
    const hm = makeMap(12);
    const fs = makeState();
    fs.foldRange(hm, 3, 8);
    expect(fs.clamp(hm, 0).length).toBe(0);
    expect(fs.rangeCount).toBe(0);
  });
});
