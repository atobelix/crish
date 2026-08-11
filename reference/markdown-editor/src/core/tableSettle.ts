// src/core/tableSettle.ts
// W3-3（docs/streaming-render/00 流式渲染极致化总方案 S-EL-11）M6 引擎
// 登记点：表格列宽定型（setTableWidths 调用）的引擎侧登记——
// - recordTableWidthSettle(tableId)：在 MarkdownEngine 表格锁宽处接线
//   （W1-3 流式结构定型锁宽 / grow-only 修正 / 非流式闭合定型，三处
//   setTableWidths 调用点各一次登记；调用语义 = 「本表执行了一次列宽
//   定型」——首次定型（锁宽）计 1，后续每次 grow-only 修正再计 1）；
// - getTableSettleStats()：只读快照（per-table 计数 + 总调用次数）；
// - resetTableSettleStats()：清零（测试隔离用）；
// - window.__CRISH_TABLE_SETTLE__：window 只读钩子（惰性 getter 返回
//   实时快照）——perf suite 的 M6 场景（tests/perf/suite/scenarios/
//   table-stream.mjs）据此读取引擎登记值，替代页面侧包装
//   setTableWidths 的间接计数（pagesrc.mjs 注释：「引擎登记点
//   recordTableWidthSettle 落地后可切换」即本登记点）。
// 开销：每次定型一次整数 Map 自增（O(1)），不侵入热路径。

/** 表格定型登记快照形状（perTable：tableId → 定型调用次数） */
export interface TableSettleStats {
  perTable: Readonly<Record<string, number>>;
  totalCalls: number;
}

// 模块级登记表（与 metrics 全局单例同构：引擎登记点常驻，宿主无需
// 创建实例；多引擎实例共享同一计数——列宽定型语义是文档级而非引擎级，
// 与 TableStore.tableWidths 的全局形状对齐）
const settleCounts = new Map<string, number>();

/**
 * 登记一次表格列宽定型（MarkdownEngine 的 setTableWidths 调用点接线）：
 * 该表定型调用计数 +1。幂等语义由调用方（setTableWidths 实际执行与否）
 * 保证——本函数只做纯计数，不判定定型是否「修正」。
 */
export function recordTableWidthSettle(tableId: string): void {
  settleCounts.set(tableId, (settleCounts.get(tableId) ?? 0) + 1);
}

/** 只读快照（拷贝，调用方修改不影响登记表） */
export function getTableSettleStats(): TableSettleStats {
  const perTable: Record<string, number> = {};
  let totalCalls = 0;
  for (const [tid, n] of settleCounts) {
    perTable[tid] = n;
    totalCalls += n;
  }
  return { perTable, totalCalls };
}

/** 清零登记表（测试隔离；生产不调用） */
export function resetTableSettleStats(): void {
  settleCounts.clear();
}

// window 只读钩子（perf suite 读取面）：惰性 getter 每次返回实时快照。
// 模块加载即安装（与 metrics/renderTheme 的「模块加载即生效」同构）；
// SSR/node 无 window 环境静默跳过。声明合并进 Window 类型供 perf 脚本
// 与测试的 TS 面使用。
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__CRISH_TABLE_SETTLE__', {
    configurable: true,
    enumerable: true,
    get: () => getTableSettleStats(),
  });
}

declare global {
  interface Window {
    /** M6 引擎登记点只读钩子（tableSettle.ts 安装）：perf suite 表格
     *  流式场景读取列宽定型计数（首次定型 + 后续修正，按 tableId） */
    __CRISH_TABLE_SETTLE__?: TableSettleStats;
  }
}
