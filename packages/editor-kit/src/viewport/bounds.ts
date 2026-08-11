/**
 * A-PERF 结构门常量（H3 / W6-C）
 *
 * 权威：
 * - `docs/block-workspace-architecture/plans/acceptance/perf-baseline.md`
 * - `docs/block-workspace-architecture/plans/specs/perf-governance.md`
 * - D5 §3.3.3 overscan 建议区间 8～20 块
 *
 * 数值门（TTI / 键入 p95 等）见 perf-baseline.md，**不得**在此伪造标定初值。
 */

/** 默认 overscan 块数（前后各扩展；非像素） */
export const DEFAULT_OVERSCAN_BLOCKS = 12;

/** overscan 建议区间下界（D5） */
export const OVERSCAN_BLOCKS_MIN = 8;

/** overscan 建议区间上界（D5） */
export const OVERSCAN_BLOCKS_MAX = 20;

/**
 * DOM 挂载块数硬上界（结构门 A-PERF-01 / S-DOM）。
 *
 * 含义：可见窗口 + 双侧 overscan 后的索引数上界（常规路径）；
 * pin 并集可短暂超出，但默认路径不得把「取消窗口化」当策略。
 * 必须 ≤ 热集默认上界 512（A-MEM-01 / `DEFAULT_MAX_HOT`）。
 */
export const MAX_MOUNTED_DOM_BLOCKS = 256;

/** A-MEM-01 热集默认上界（与 conex-doc-collab `DEFAULT_MAX_HOT` 对齐，供 TS 侧结构门断言） */
export const DEFAULT_MAX_HOT_YTEXT = 512;

/**
 * 断言挂载块数未突破结构门上界。
 * @returns true 若 count ≤ MAX_MOUNTED_DOM_BLOCKS
 */
export function isWithinDomMountBound(count: number): boolean {
  return (
    Number.isFinite(count) && count >= 0 && count <= MAX_MOUNTED_DOM_BLOCKS
  );
}
