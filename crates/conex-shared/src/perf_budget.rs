//! 性能预算单一真源（D0 / U-BUDGET · INV-8）
//!
//! 全仓性能数字只允许出现在本模块（Rust 侧 SoT）。业务代码一律
//! `use conex_shared::perf_budget::…` 或 crate 内 re-export，禁止再定义
//! 第二份同语义字面量。
//!
//! 镜像（前端）：`apps/crish-desktop/src/api/perfBudgets.ts`
//! （数值以本文件为准；改值先改本文件，再同步镜像并跑
//! `node scripts/check-perf-budgets.mjs`）。
//!
//! 门禁：`scripts/check-perf-budgets.mjs`（fail 级，进 `check:desktop`）。
//!
//! 收录原则（详案 §1.1）：
//! - 同名同语义迁入业务本地 `const`，默认保持现值（本维不调阈值）；
//! - 按命名空间分节；预留常量可建但标注「解锁前禁止生产读取」；
//! - 不做行为逻辑；纯 `pub const` + 文档注释。
//!
//! 分层语义（禁止错误合并，详案 §1.1 第二层）：
//! - 事件载荷预算 `TOOL_OUTPUT_BUDGET_BYTES_DEFAULT`
//! - G8 conversation 截断 `G8_TOOL_OUTPUT_MAX_*`
//! - shell 累积/spill `SHELL_*`
//! - 展示/PTY/store cap `TOOL_OUTPUT_*_CAP` / `PTY_*` / `STORE_HARD_CAP`
//! - 启动体积 `STARTUP_*`（仅 D9 门禁消费；不进业务 import）

// ── 执行 / 工具输出字节账（agent-tools / 执行面） ─────────────────────

/// shell 预览头字节上限。
/// 镜像: 无（引擎侧）· 接线主责: D2 · 现源: agent-tools shell_output.rs
pub const SHELL_PREVIEW_HEAD_BYTES: usize = 24 * 1024;

/// shell 预览尾字节上限。
/// 镜像: 无（引擎侧）· 接线主责: D2 · 现源: agent-tools shell_output.rs
pub const SHELL_PREVIEW_TAIL_BYTES: usize = 24 * 1024;

/// 工具 inline 正文默认预算（字节）。
/// 镜像: 无（引擎侧）· 接线主责: D1/D2 · 现源: agent-tools output.rs `DEFAULT_INLINE_BYTES`
pub const TOOL_INLINE_BYTES_DEFAULT: usize = 24_000;

/// shell 输出默认上限（字节）。
/// 镜像: 无（引擎侧）· 接线主责: D1/D2 · 现源: agent-tools tools/mod.rs
pub const SHELL_MAX_OUTPUT_BYTES_DEFAULT: usize = 200_000;

/// shell 累积器完成前内存 hard_cap 倍数（U-MEM · 10-S1）。
/// 语义：OutputAccumulator 全量字节增长上限 = `SHELL_MAX_OUTPUT_BYTES_DEFAULT × 本因子`；
/// 超限后停止 `bytes.extend`（仅继续有界 preview + 溢出计数），防止完成前无界驻留。
/// 取 8：hard_cap = 1.6MiB——覆盖既有 1MB spill/流式测试资产（完整落盘语义不回归），
/// 同时为 100MB+ 病理输出提供内存上界（INV-B5）。
pub const SHELL_ACCUM_HARD_CAP_FACTOR: usize = 8;

/// MCP stdout 单行字节上限（U-MEM · 10-M1）。
/// 语义：bridge_session stdout 读线程对单行累计超限 → `mark_exited("stdout line too long")`
/// （connection_failed 语义，非静默），替换 `lines().next_line()` 无界形态。
pub const MCP_STDOUT_MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// read_file 默认 maxBytes。
/// 镜像: 无（引擎侧）· 接线主责: D2 · 现源: agent-tools tools/fs.rs
pub const READ_FILE_MAX_BYTES_DEFAULT: usize = 256_000;

/// search 单文件字节上限。
/// 镜像: 无（引擎侧）· 接线主责: D2 · 现源: agent-tools tools/search.rs
pub const SEARCH_MAX_FILE_BYTES_DEFAULT: u64 = 512_000;

/// list_dir 分页默认上限（条目数）。
/// 门禁/接线: D2 · U-BLOCK——壳 `fs_commands/directory.rs` 超限截断
/// （truncated/cursor/total 向后兼容扩字段）；本值为唯一定义面。
pub const FS_LIST_DIRECTORY_DEFAULT_LIMIT: usize = 2000;

// ── G8 conversation 截断（conex-compaction / D10） ────────────────────

/// G8 默认最大行数（对齐 opencode MAX_LINES=2000）。
/// 镜像: 无（引擎侧）· 接线主责: D10（U-G8）· 现源: conex-compaction tool_output.rs
pub const G8_TOOL_OUTPUT_MAX_LINES_DEFAULT: usize = 2_000;

/// G8 默认最大字节数（对齐 opencode MAX_BYTES=50KB）。
/// 镜像: 无（引擎侧）· 接线主责: D10 · 现源: conex-compaction tool_output.rs
pub const G8_TOOL_OUTPUT_MAX_BYTES_DEFAULT: usize = 50 * 1024;

// ── 执行器输出预算（事件载荷层 · 新建） ───────────────────────────────

/// 执行器默认工具输出预算（字节）。
/// 语义：进事件/上下文的工具输出大小（非 G8、非 shell spill）。
/// 02 建议 64KiB；现默认行为仍为 `None`（接线归 **D1** `run_launch` 默认 `Some`）。
/// 本维只登记定义，**不改任何调用点行为**。
pub const TOOL_OUTPUT_BUDGET_BYTES_DEFAULT: usize = 64 * 1024;

// ── 前端展示 / PTY / store cap（FE 镜像面） ───────────────────────────

/// 前端工具输出展示行数 cap。
/// 镜像: perfBudgets.TOOL_OUTPUT_LINE_CAP · 接线: D0 机械迁 · 现源: ToolCallOutput.tsx
pub const TOOL_OUTPUT_LINE_CAP: usize = 2000;

/// 前端工具输出展示字节 cap。
/// 镜像: perfBudgets.TOOL_OUTPUT_BYTE_CAP · 接线: D0 机械迁 · 现源: ToolCallOutput.tsx
pub const TOOL_OUTPUT_BYTE_CAP: usize = 256 * 1024;

/// 前端 store 写入 hardCap（与展示层同量级；**生效逻辑归 D5**）。
/// 镜像: perfBudgets.TOOL_OUTPUT_STORE_HARD_CAP · 新建登记
pub const TOOL_OUTPUT_STORE_HARD_CAP: usize = 256 * 1024;

/// PTY 环形缓冲字节上限。
/// 镜像: perfBudgets.PTY_HISTORY_MAX_BYTES · 接线: D0 机械迁 · 现源: ptySessionApi.ts
pub const PTY_HISTORY_MAX_BYTES: usize = 256 * 1024;

/// 常驻已水合会话数上限（LRU 保留 K）。
/// 镜像: perfBudgets.SESSION_HYDRATE_KEEP_K · 接线主责: D5（驱逐逻辑）
/// 03 建议默认 3；现场尚无同名常量。
pub const SESSION_HYDRATE_KEEP_K: usize = 3;

// ── 引擎侧 markdown 缓存（conex-markdown · moka） ─────────────────────

/// Rust markdown 高亮/渲染共享缓存字节预算（UTF-16 估算口径）。
/// 镜像: FE 缓存族见 bounds.ts（**跨端不要求逐字节相等**；同端禁止第二份）
/// · 接线主责: D1/06 U3（builder 使用本常量）· 现源: conex-markdown cache.rs
pub const RUST_MARKDOWN_CACHE_BUDGET_BYTES: u32 = 32 * 1024 * 1024;

/// Rust markdown 缓存单条目字节上限。
/// 镜像: FE 无同名（语义对照见 bounds.ts 缓存族）· 接线主责: D1/06 U3
/// · 现源: conex-markdown cache.rs
pub const RUST_MARKDOWN_CACHE_ENTRY_MAX_BYTES: u32 = 1024 * 1024;

// ── FE 缓存族语义对照（数值真源在 bounds.ts，不在本文件复制） ─────────
//
// FE 侧缓存字节预算的**定义位置唯一**在
// `packages/shared-utils/src/bounds.ts`（package 导出面；apps 禁止第二份）。
// `perfBudgets.ts` re-export 转口。本模块登记 Rust 侧对应量级：
//
// | FE（bounds.ts）              | 值        | Rust 对照（本模块）              |
// | ---------------------------- | --------- | -------------------------------- |
// | MARKDOWN_CACHE_BUDGET_BYTES  | 16 MiB    | RUST_MARKDOWN_CACHE_BUDGET_BYTES |
// | HIGHLIGHT_CACHE_BUDGET_BYTES | 8 MiB     | （引擎共享 32MiB 桶语义）        |
// | DIFF/ENCODING/URL_*          | 1–4 MiB   | 同上分域                         |
// | TOTAL_MEMORY_BUDGET          | 200 MiB   | FE 专属                          |

// ── 启动体积门禁（D9 命名空间 · 不进业务 import） ─────────────────────

/// entry JS 软/过渡预算（KiB）。
/// 门禁: D9 `check-startup-budget.mjs` · 现源: 脚本 DEFAULT_BUDGET_KB
/// **仅 D9 门禁消费**；禁止业务 crate import。
pub const STARTUP_ENTRY_BUDGET_KB: u64 = 520;

/// 静态图过渡 fail 阈值（KiB）。
/// 门禁: D9 · 按 04/92：过渡 1800 → 断边后 900 冻结
pub const STARTUP_STATIC_GRAPH_BUDGET_KB_TRANSITION: u64 = 1800;

/// 静态图冻结 fail 阈值（KiB）。门禁: D9
pub const STARTUP_STATIC_GRAPH_BUDGET_KB_FROZEN: u64 = 900;

// ── 事件缓冲水位（EventBuffer · 有界化接线归 D1） ─────────────────────

/// EventBuffer Soft 水位默认（达此水位优先丢 Soft 旧帧）。
/// 现源: agent-workbench buffer.rs `Default` · 接线主责: D1（有界化）
pub const EVENT_BUFFER_SOFT_WATERMARK: usize = 64;

/// EventBuffer Critical 水位默认（Critical 永不丢；超限防御性接受）。
/// 现源: agent-workbench buffer.rs `Default` · 接线主责: D1
pub const EVENT_BUFFER_HARD_CAP: usize = 256;

// ── PE-02 合并窗（预留 · 解锁前禁止生产读取） ─────────────────────────

/// PE-02 同 block 追加合并窗——**预留占位**。
/// 解锁条件: T2 契约会签（PR-PE-02）通过后方可生产消费。
/// **禁止**在业务 crate 出现本常量引用；门禁可检。
#[doc = "预留：PE-02 合并窗（条数）。解锁前禁止生产读取。"]
pub const PE02_MERGE_WINDOW_MAX_EVENTS: usize = 1;

/// PE-02 合并窗时间窗（ms）——**预留占位**。
/// 解锁条件: T2 契约会签（PR-PE-02）通过后方可生产消费。
/// **禁止**在业务 crate 出现本常量引用。
#[doc = "预留：PE-02 合并窗（ms）。解锁前禁止生产读取。"]
pub const PE02_MERGE_WINDOW_MS: u64 = 0;

// ── 契约冒烟单测（防错误合并 / 分列） ─────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budgets_are_positive() {
        // 全部是编译期常量：用 const 块在编译期求值，任一预算被改成 0
        // （或水位倒挂）时测试目标直接编译失败，而不是运行期才报。
        const {
            assert!(SHELL_PREVIEW_HEAD_BYTES > 0);
            assert!(SHELL_PREVIEW_TAIL_BYTES > 0);
            assert!(TOOL_INLINE_BYTES_DEFAULT > 0);
            assert!(SHELL_MAX_OUTPUT_BYTES_DEFAULT > 0);
            assert!(READ_FILE_MAX_BYTES_DEFAULT > 0);
            assert!(SEARCH_MAX_FILE_BYTES_DEFAULT > 0);
            assert!(G8_TOOL_OUTPUT_MAX_LINES_DEFAULT > 0);
            assert!(G8_TOOL_OUTPUT_MAX_BYTES_DEFAULT > 0);
            assert!(TOOL_OUTPUT_BUDGET_BYTES_DEFAULT > 0);
            assert!(TOOL_OUTPUT_LINE_CAP > 0);
            assert!(TOOL_OUTPUT_BYTE_CAP > 0);
            assert!(TOOL_OUTPUT_STORE_HARD_CAP > 0);
            assert!(PTY_HISTORY_MAX_BYTES > 0);
            assert!(SESSION_HYDRATE_KEEP_K > 0);
            assert!(RUST_MARKDOWN_CACHE_BUDGET_BYTES > 0);
            assert!(RUST_MARKDOWN_CACHE_ENTRY_MAX_BYTES > 0);
            assert!(STARTUP_ENTRY_BUDGET_KB > 0);
            assert!(EVENT_BUFFER_SOFT_WATERMARK > 0);
            assert!(EVENT_BUFFER_HARD_CAP >= EVENT_BUFFER_SOFT_WATERMARK);
        }
    }

    #[test]
    fn semantic_layers_stay_split() {
        // G8 字节阈值 ≠ store hardCap（分列语义，禁止错误合并）
        assert_ne!(
            G8_TOOL_OUTPUT_MAX_BYTES_DEFAULT as usize,
            TOOL_OUTPUT_STORE_HARD_CAP
        );
        // 事件载荷预算 ≠ G8 字节阈值（第二层语义分列）
        assert_ne!(
            TOOL_OUTPUT_BUDGET_BYTES_DEFAULT,
            G8_TOOL_OUTPUT_MAX_BYTES_DEFAULT
        );
        // shell 预览头/尾分列常量但当前同值（历史）
        assert_eq!(SHELL_PREVIEW_HEAD_BYTES, SHELL_PREVIEW_TAIL_BYTES);
    }

    #[test]
    fn locked_values_match_migrations() {
        // 迁移时锁定的现值（改值须走接线票 + 变更表，禁止本测试静默漂移）
        assert_eq!(TOOL_INLINE_BYTES_DEFAULT, 24_000);
        assert_eq!(SHELL_MAX_OUTPUT_BYTES_DEFAULT, 200_000);
        assert_eq!(READ_FILE_MAX_BYTES_DEFAULT, 256_000);
        assert_eq!(SEARCH_MAX_FILE_BYTES_DEFAULT, 512_000);
        assert_eq!(G8_TOOL_OUTPUT_MAX_LINES_DEFAULT, 2_000);
        assert_eq!(G8_TOOL_OUTPUT_MAX_BYTES_DEFAULT, 50 * 1024);
        assert_eq!(TOOL_OUTPUT_LINE_CAP, 2000);
        assert_eq!(TOOL_OUTPUT_BYTE_CAP, 256 * 1024);
        assert_eq!(PTY_HISTORY_MAX_BYTES, 256 * 1024);
        assert_eq!(RUST_MARKDOWN_CACHE_BUDGET_BYTES, 32 * 1024 * 1024);
        assert_eq!(RUST_MARKDOWN_CACHE_ENTRY_MAX_BYTES, 1024 * 1024);
        assert_eq!(STARTUP_ENTRY_BUDGET_KB, 520);
        assert_eq!(STARTUP_STATIC_GRAPH_BUDGET_KB_TRANSITION, 1800);
        assert_eq!(STARTUP_STATIC_GRAPH_BUDGET_KB_FROZEN, 900);
        assert_eq!(EVENT_BUFFER_SOFT_WATERMARK, 64);
        assert_eq!(EVENT_BUFFER_HARD_CAP, 256);
    }
}
