const BUDGETS: Record<string, number> = {
  'store:transaction': 5,
  'render:frame': 12,
  'scroll:handler': 3,
  'event:dispatch': 1,
  'markdown:parse': 50,
  'virtualscroll:rebuild': 16,
};

export function checkBudget(name: string, duration: number): void {
  const budget = BUDGETS[name];
  if (budget === undefined) return;

  if (duration > budget) {
    const pct = Math.round((duration / budget) * 100);
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[Perf] ${name}: ${duration.toFixed(1)}ms (${pct}% of ${budget}ms budget)`);
    }
    if (typeof window !== 'undefined' && (window as any).__crish_perf) {
      (window as any).__crish_perf.budgetExceeded({ name, duration, budget });
    }
  }
}
