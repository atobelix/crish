import { logger } from '../services/LoggerService';

// BUDGETS 表收敛（维度 1 步骤 1b）：删除 5 个零调用预算点（原表中定义
// 但全仓无 checkBudget 调用方的 render/scroll/event/markdown/virtualscroll
// 预算项），仅保留 store:transaction（调用方 withLogger.ts:81）。
const BUDGETS: Record<string, number> = {
  'store:transaction': 5,
};

// 维度 5 生产接线：budgetExceeded 注册已移出 DEV 守卫（main.tsx），
// 生产环境也注册；回调仅推入环形缓冲 + logger.warn，不推入 errorStore。
export function checkBudget(name: string, duration: number): void {
  const budget = BUDGETS[name];
  if (budget === undefined) return;

  if (duration > budget) {
    const pct = Math.round((duration / budget) * 100);
    if (process.env.NODE_ENV === 'development') {
      // 修复 8：console.warn → logger.warn（可观测性链路统一）
      logger.warn(
        `[Perf] ${name}: ${duration.toFixed(1)}ms (${pct}% of ${budget}ms budget)`,
        { module: 'performance-budget' }
      );
    }
    if (typeof window !== 'undefined' && window.__crish_perf?.budgetExceeded) {
      window.__crish_perf.budgetExceeded({ name, duration, budget });
    }
  }
}
