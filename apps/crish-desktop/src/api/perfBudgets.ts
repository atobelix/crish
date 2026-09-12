// perfBudgets.ts — 前端预算镜像
// SoT: crates/conex-shared/src/perf_budget.rs（数值以 Rust 为准）
// 本文件禁止成为第三真源：改数值先改 perf_budget，再同步本镜像并跑 check-perf-budgets
//
// 缓存族转口：数值真源在 packages/shared-utils/src/bounds.ts（package 导出面）；
// 应用侧「只认 perfBudgets」——禁止在 apps/crish-desktop/src/** 再写第二份数值。

// ── 工具输出展示 / store cap ──────────────────────────────────────────

/** 前端工具输出展示行数 cap（SoT: TOOL_OUTPUT_LINE_CAP） */
export const TOOL_OUTPUT_LINE_CAP = 2000;

/** 前端工具输出展示字节 cap（SoT: TOOL_OUTPUT_BYTE_CAP） */
export const TOOL_OUTPUT_BYTE_CAP = 256 * 1024;

/** 前端 store 写入 hardCap；生效逻辑归 D5（SoT: TOOL_OUTPUT_STORE_HARD_CAP） */
export const TOOL_OUTPUT_STORE_HARD_CAP = 256 * 1024;

/** PTY 环形缓冲字节上限（SoT: PTY_HISTORY_MAX_BYTES） */
export const PTY_HISTORY_MAX_BYTES = 256 * 1024;

/** 常驻已水合会话数上限 LRU K（SoT: SESSION_HYDRATE_KEEP_K；驱逐逻辑归 D5） */
export const SESSION_HYDRATE_KEEP_K = 3;

// ── 缓存族转口（bounds.ts 为数值真源；禁止 apps 二次定义） ─────────────

export {
  MARKDOWN_CACHE_ENTRIES,
  MARKDOWN_CACHE_BUDGET_BYTES,
  HIGHLIGHT_CACHE_ENTRIES,
  HIGHLIGHT_CACHE_BUDGET_BYTES,
  DIFF_CACHE_ENTRIES,
  DIFF_CACHE_BUDGET_BYTES,
  ENCODING_CACHE_ENTRIES,
  ENCODING_CACHE_BUDGET_BYTES,
  URL_CACHE_ENTRIES,
  URL_CACHE_BUDGET_BYTES,
  TOTAL_MEMORY_BUDGET,
} from '@crish/shared-utils/browser';
