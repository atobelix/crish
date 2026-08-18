// BUDGETS 表收敛（维度 1 步骤 1b）：删除 5 个零调用预算点（原表中定义
// 但全仓无 checkBudget 调用方的 render/scroll/event/markdown/virtualscroll
// 预算项），仅保留 store:transaction（调用方 withLogger.ts:81）。
const BUDGETS: Record<string, number> = {
  'store:transaction': 5,
};

// @pending 维度 5 生产接线：本函数当前仅 dev 环境 console.warn +
// window.__crish_perf.budgetExceeded（main.tsx:182-204 dev 注册块），
// 生产环境无超预算观测路径；维度 5 处理生产注册接线。
export function checkBudget(name: string, duration: number): void {
  const budget = BUDGETS[name];
  if (budget === undefined) return;

  if (duration > budget) {
    const pct = Math.round((duration / budget) * 100);
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[Perf] ${name}: ${duration.toFixed(1)}ms (${pct}% of ${budget}ms budget)`);
    }
    if (typeof window !== 'undefined' && window.__crish_perf?.budgetExceeded) {
      window.__crish_perf.budgetExceeded({ name, duration, budget });
    }
  }
}
