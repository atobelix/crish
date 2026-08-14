//! 写路径声明与引擎级互斥（I4-M3：Reasonix WritePathSet 落地）
//!
//! 把 05 手册 §3 文件域互斥表从提示词纪律升级为引擎强制：
//! - **声明**：写类工具（write_file / delete_file / delete_dir / shell 删除重定向）
//!   执行前经 `ToolContext.write_claims` 注册表声明写路径；子代理 spawn 时
//!   （M2 run_subagent）可声明长期写路径（本模块 `claim` 的持有期由守卫
//!   `WriteClaimGuard` 决定——工具执行期临时声明随守卫 Drop 释放，子代理
//!   声明由 M2/M6 持有守卫到 run 结束）。
//! - **互斥**：Overlaps 检测（路径前缀语义：`a/b/c.txt` 与 `a/b/` 冲突），
//!   冲突 → `tool.write_path_conflict` 结构化错误（谁占用 / 何时 / 有效期）。
//! - **同持有者豁免**：同一 holder 对自身声明路径的再声明 / 扩展不冲突
//!   （子代理可写自己的声明内路径），不同持有者重叠即拒绝。
//! - **超时释放**：声明带 TTL（默认 60s 无活动自动释放，防悬挂）；
//!   `claim` / `check_conflict` 前先清扫过期声明。
//! - **校验**：复用 `resolve_workspace_path`（symlink 解析后比较、拒绝 `..`、
//!   拒绝工作区外、Windows 大小写折叠），另拒绝 glob（`* ? [`）。
//!
//! T-D-08 起增补 run 级硬沙箱（REQ-D04 越权拒绝，权限层）：
//! - **[WritePathPolicy]**（`Allowed` 允许集 / `Unrestricted` 不限制）经
//!   [check_write_allowance] 在写工具执行前拦截：目标不在任何允许前缀下 →
//!   `tool.write_not_allowed`（conex-types 已登记，Permanent 不可重试）；
//! - 允许集与互斥注册表同载体装配（[WritePathRegistry::with_write_policy]，
//!   引擎侧 T-D-13 把 spawn 字段与 task_type 默认集合并后转策略再注册），
//!   但**语义独立**——白名单是"允许集"（权限沙箱）、互斥是"并发控制"，
//!   挂接顺序一先一后串行叠加：先 [check_write_allowance_for_ctx]（越权拒绝）
//!   → 再 `claim_write_guard`（冲突拒绝）；
//! - 未接线语义扩展：`write_claims = None` 或注册表未装配策略 → 不强制，
//!   写工具保持现状行为（测试与直连场景不受影响）。
//!
//! 未接线语义：`ToolContext.write_claims = None` 时写工具不强制互斥
//! （现状行为保持，测试与直连场景不受影响）；接线由执行器按会话装配
//! （session-loop ToolExecutor 或 M2 子代理执行上下文）。
//!
//! 与 M6 调度器交接：`check_conflict` / `active_claims` 供 spawn 前
//! preflight（`ValidateNonOverlappingWriteClaims` 语义）与父代理写预留
//! （`ReserveParentWrite`）消费；本模块只提供会话级记账，不碰调度。
//!
//! 结构（SR-06a-5 · 拆分 · ≠ EL）：本文件为薄门面，按逻辑域拆 2 个子模：
//! - `write_paths_state`：互斥状态机域（声明记账 / 冲突检测与原子插入 /
//!   TTL 清扫 / RAII 守卫 / 工具接线助手 [claim_write_guard] +
//!   [check_write_allowance_for_ctx]）；
//! - `write_paths_validate`：路径校验与冲突判定域（[validate_write_path] /
//!   Overlaps 组件级前缀判定 / 归一化底座 / 白名单策略与越权判定）；
//! 测试外置 `write_paths_tests.rs`（`#[path]` 旁挂，无孤儿，写路径互斥测
//! 全保留）；公开 API 经本文件 `pub use` 保持不 break（lib.rs `pub mod
//! write_paths;` 与 session-loop / workbench 壳消费方 import 路径不变）。
//! 诚实边界：仅结构拆分，互斥语义 / 路径校验 / 越权判定零改动
//! （≠ EL / ≠ 打开完成 / ≠ 结构债清零）。

// ==================== 拆分接线（SR-06a-5 · 结构拆分 · ≠ EL）====================
//
// 本文件为薄门面：全部实现按逻辑域拆入两个子模块（扁平文件必须 #[path]
// 显式接线，吸取 SR-06d 教训）：
//   write_paths_state（互斥状态机域：声明记账 / 注册表 / RAII 守卫 / 工具接线）
//   write_paths_validate（路径校验与冲突判定域：Overlaps / 归一化 / 白名单策略）
// 测试整体外置 write_paths_tests.rs（#[path] 接线，零删除）。
// 诚实边界：仅结构拆分，语义零改动（≠ EL / ≠ 打开完成 / ≠ 结构债清零）。
#[path = "write_paths_state.rs"]
mod write_paths_state;
#[path = "write_paths_validate.rs"]
mod write_paths_validate;

use conex_types::error::codes;

/// 写路径互斥冲突错误码（F8-02：由局部码并入 conex-types 注册表，
/// 与 TS 共享码表同步；本处引用注册表常量保证单一真源。
/// 冲突为确定拒绝、不可重试——等待占用者释放后由主 agent 编排串行重试）
pub(crate) const TOOL_WRITE_PATH_CONFLICT: &str = codes::TOOL_WRITE_PATH_CONFLICT;

pub(crate) use write_paths_state::{check_write_allowance_for_ctx, claim_write_guard};
pub use write_paths_state::{
    ClaimMode, WriteClaimGuard, WritePathClaim, WritePathConflict, WritePathRegistry,
    DEFAULT_CLAIM_TTL_MS,
};
pub use write_paths_validate::{
    check_write_allowance, paths_overlap_normalized, validate_write_path, WriteAllowanceError,
    WritePathPolicy,
};

// ── 测试（SR-06a-5 外置；`#[path]` 旁挂，无孤儿）───────────────────

#[cfg(test)]
#[path = "write_paths_tests.rs"]
mod tests;
