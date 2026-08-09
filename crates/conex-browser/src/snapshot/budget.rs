//! 预算常量与截断信息类型（维度 13 §3.4；T-6 参数集中可配）
//!
//! 裁决值（13 §3.4 开放问题 1 裁决 + T-6/T-2）：
//! - `max_depth` 10：简化树深度上限，超深子树整体折叠为提示行
//! - `max_tree_nodes` 1000：建树阶段（预算 2）保留节点上限
//! - `max_selector_indices` 500：索引分配上限（预算 4），超出仍入树但不给 `[N]`
//! - `max_text_len` 100：序列化阶段（预算 3）逐行截断
//! - `inactive_budget_factor` 0.25：非活跃标签惰性快照系数（T-6，与维度 15 分摊一致）
//! - 32KB = 序列化输出预算（模型输入面）；150KB = CDP 原始采集载荷上限（采集层，T-2）
//! - 12s = 硬超时上限；p95 ≤ 2s（目标）/ ≤ 5s（硬预算）= 正常耗时目标（T-1）

use std::time::Duration;

/// 最大层级（简化树深度上限；主流 SPA 交互控件典型深度 ≤ 6，10 覆盖嵌套容器余量）。
pub const MAX_DEPTH: usize = 10;
/// 简化树元素数上限（建树阶段预算 2；常规页 200-600 节点，1000 覆盖复杂页）。
pub const MAX_TREE_NODES: usize = 1000;
/// 可交互索引分配上限（预算 4；模型上下文单次可消化约 100-300，500 为上限余量）。
pub const MAX_SELECTOR_INDICES: usize = 500;
/// 单行文本/属性值截断长度（预算 3；超限截断并追加 `…`）。
pub const MAX_TEXT_LEN: usize = 100;
/// 非活跃标签预算系数（T-6：max_tree_nodes 1000→250、max_selector_indices 500→125）。
pub const INACTIVE_BUDGET_FACTOR: f64 = 0.25;
/// 序列化输出预算（模型输入面，32KB，T-2）。
pub const MAX_OUTPUT_BYTES: usize = 32 * 1024;
/// CDP 原始采集载荷上限（采集层，150KB，不直接进模型，T-2）。
pub const MAX_RAW_PAYLOAD_BYTES: usize = 150 * 1024;
/// 单次快照硬超时上限（12s，超时中止本次采集并返回错误，T-1）。
pub const HARD_TIMEOUT: Duration = Duration::from_secs(12);
/// 常规页总耗时目标（p95 ≤ 2s，T-1）。
pub const P95_TARGET: Duration = Duration::from_secs(2);
/// 正常操作耗时硬预算（≤ 5s 内超时返回截断快照 + 警告，不阻塞动作链，T-1）。
pub const HARD_BUDGET: Duration = Duration::from_secs(5);
/// CDP 采集阶段耗时目标（常规页 p95 ≤ 1.5s，§6.1）。
pub const COLLECT_P95_TARGET: Duration = Duration::from_millis(1500);
/// 序列化阶段耗时目标（p95 ≤ 500ms，§7.2 T3）。
pub const SERIALIZE_P95_TARGET: Duration = Duration::from_millis(500);
/// 快照缓存总量预算（M-6，与维度 15 SNAPSHOT_CACHE_TOTAL = 8MB 一致）。
pub const SNAPSHOT_CACHE_TOTAL_BYTES: usize = 8 * 1024 * 1024;
/// 非元素节点（不判可交互，P1 短路否决）。
pub const TEXT_LEN_MIN: usize = 1;
/// 文本节点入树阈值（> 1 字符且非空白，过滤装饰性零文本，§3.4）。
pub const TEXT_NODE_MIN_CHARS: usize = 2;

/// 截断原因（§3.1；深度/元素数截断均保留「被截可交互元素计数」提示行）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TruncationKind {
    /// 预算 1：深度截断（超深子树整体折叠为提示行）
    Depth,
    /// 预算 2：元素数截断（树尾输出 `... (N more elements)`）
    Elements,
    /// 预算 3：文本截断（逐行截断并追加 `…`）
    Text,
    /// 预算 4：索引截断（超出元素仍入树，无 `[N]` 前缀）
    Selectors,
    /// 输出体积截断（32KB 序列化预算，T-2）
    Output,
}

/// 截断信息（§3.1；`dropped_nodes` 为被预算丢弃的节点/行数）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TruncationInfo {
    /// 最先触发的预算（记录主因；其余预算触发行数并入 dropped_nodes）
    pub truncated_by: TruncationKind,
    /// 被预算丢弃的节点/行数
    pub dropped_nodes: usize,
    /// 被截内容的可交互元素计数（提示行 `... (N more interactive elements)` 用）
    pub dropped_interactive: usize,
}

/// 预算参数（T-6 集中可配：活跃标签全额 / 非活跃标签按系数缩放）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BudgetConfig {
    pub max_depth: usize,
    pub max_tree_nodes: usize,
    pub max_selector_indices: usize,
    pub max_text_len: usize,
    pub inactive_budget_factor: f64,
    pub max_output_bytes: usize,
}

impl BudgetConfig {
    /// 全额预算（活跃标签，§3.4 裁决值）。
    pub fn active() -> Self {
        BudgetConfig {
            max_depth: MAX_DEPTH,
            max_tree_nodes: MAX_TREE_NODES,
            max_selector_indices: MAX_SELECTOR_INDICES,
            max_text_len: MAX_TEXT_LEN,
            inactive_budget_factor: INACTIVE_BUDGET_FACTOR,
            max_output_bytes: MAX_OUTPUT_BYTES,
        }
    }

    /// 非活跃标签惰性快照预算（T-6：节点/索引预算按系数缩放，其余参数不变；
    /// 标签被激活或事件推进版本后自动升级为全额快照）。
    pub fn inactive(&self) -> Self {
        let factor = self.inactive_budget_factor.clamp(0.0, 1.0);
        BudgetConfig {
            max_depth: self.max_depth,
            max_tree_nodes: ((self.max_tree_nodes as f64) * factor) as usize,
            max_selector_indices: ((self.max_selector_indices as f64) * factor) as usize,
            max_text_len: self.max_text_len,
            inactive_budget_factor: self.inactive_budget_factor,
            max_output_bytes: self.max_output_bytes,
        }
    }

    /// 单个预算项按系数缩放（构造辅助，测试用）。
    pub fn scaled(&self, nodes: usize, selectors: usize) -> Self {
        BudgetConfig {
            max_tree_nodes: nodes,
            max_selector_indices: selectors,
            ..*self
        }
    }
}

impl Default for BudgetConfig {
    fn default() -> Self {
        Self::active()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 裁决值默认面（§3.4 参数表逐项断言）。
    #[test]
    fn budget_default_values_match_verdict() {
        let b = BudgetConfig::active();
        assert_eq!(b.max_depth, 10);
        assert_eq!(b.max_tree_nodes, 1000);
        assert_eq!(b.max_selector_indices, 500);
        assert_eq!(b.max_text_len, 100);
        assert_eq!(b.inactive_budget_factor, 0.25);
        assert_eq!(b.max_output_bytes, 32 * 1024);
    }

    /// T-6：非活跃标签按 0.25 系数缩放节点/索引预算（1000→250、500→125），其余不变。
    #[test]
    fn budget_inactive_scales_nodes_and_selectors_only() {
        let b = BudgetConfig::active().inactive();
        assert_eq!(b.max_tree_nodes, 250);
        assert_eq!(b.max_selector_indices, 125);
        assert_eq!(b.max_depth, 10, "深度预算不随系数缩放");
        assert_eq!(b.max_text_len, 100, "文本预算不随系数缩放");
        assert_eq!(b.max_output_bytes, 32 * 1024);
    }

    /// 双层体积上界常量（T-2）。
    #[allow(clippy::assertions_on_constants)]
    #[test]
    fn budget_output_and_raw_payload_bounds() {
        assert_eq!(MAX_OUTPUT_BYTES, 32 * 1024);
        assert_eq!(MAX_RAW_PAYLOAD_BYTES, 150 * 1024);
        assert!(MAX_OUTPUT_BYTES < MAX_RAW_PAYLOAD_BYTES);
    }

    /// 耗时双层语义常量（T-1）：硬超时 > 硬预算 > 目标。
    #[allow(clippy::assertions_on_constants)]
    #[test]
    fn budget_timeout_layers() {
        assert!(HARD_TIMEOUT > HARD_BUDGET);
        assert!(HARD_BUDGET > P95_TARGET);
        assert_eq!(HARD_TIMEOUT.as_secs(), 12);
        assert_eq!(P95_TARGET.as_secs(), 2);
        assert_eq!(HARD_BUDGET.as_secs(), 5);
    }
}
