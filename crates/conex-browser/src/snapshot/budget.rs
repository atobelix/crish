//! 预算常量与截断信息类型（维度 13 §3.4；T-6 参数集中可配）
//!
//! 裁决值（13 §3.4 开放问题 1 裁决 + T-6/T-2 + 46 性能优化复核）：
//! - `max_depth` 10：简化树深度上限，超深子树整体折叠为提示行
//! - `max_tree_nodes` 1000：建树阶段（预算 2）保留节点上限
//! - `max_selector_indices` 500：索引分配上限（预算 4），超出仍入树但不给 `[N]`
//! - `max_text_len` 100：序列化阶段（预算 3）逐行截断
//! - `inactive_budget_factor` 0.25：非活跃标签惰性快照系数（T-6，与维度 15 分摊一致）
//! - 32KB = 序列化输出预算（模型输入面）；150KB = 常规页合计降级触发阈值、
//!   512KB = 主通道硬护栏（采集层双层语义，T-2 + 46 复核：150KB 对列表页形态
//!   不足——300 条目列表页最小面 326KB 实测，硬护栏提升至 512KB 且实测
//!   1.1MB+1.3MB+10.7MB 顺序传输连接稳定，4.99MB 级才断连）
//! - 12s = 硬超时上限；p95 ≤ 2s（目标）/ ≤ 5s（硬预算）= 正常耗时目标（T-1）
//! - `include_dom_rects`/`include_paint_order` 默认 false = 采集最小面（46 复核：
//!   rects/paint 数据当前实现不消费——rects 未解析、paintOrders 恒空，
//!   源级削减 12-20% 载荷且零语义损失）

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
/// CDP 原始采集载荷**常规页降级触发阈值**（150KB，T-2；46 复核保留裁决值）：
/// DOMSnapshot 主通道 + 结构通道 getDocument 合计超限 → 降级丢弃结构通道
/// （仅用主通道），快照不失败。该阈值对表格页形态有余量（400 单元格
/// 最小面 125.8KB ≈ 82%），对列表页形态不足（300 条目最小面 326KB）——
/// 超限页面由下方 512KB 硬护栏承接，仅丢结构通道不丢主数据。
pub const MAX_RAW_PAYLOAD_BYTES: usize = 150 * 1024;
/// CDP 原始采集载荷**主通道硬护栏**（512KB，46 性能优化复核新增）：
/// DOMSnapshot 主通道单通道超限 → PayloadOverflow（主数据缺失无法降级）。
/// 提升依据（46 实测）：① 模型输入面 32KB 序列化输出不变，采集层载荷不
/// 直接进模型——提升护栏不增加模型成本；② 150KB 对列表页形态直接失败
/// （300 条目 326KB / 800 条目 884KB，最小面参数实测），而列表页是常见
/// 中页面形态；③ 内存面：512KB wire → serde_json Value + 建树中间态瞬时
/// 峰值 ≈ 6-8MB（采集完成即释放，对比快照缓存总预算 8MB），桌面无压力；
/// ④ 连接稳定性：实测 1.1MB+1.3MB+10.7MB 顺序传输无异常，4.99MB 级
/// （bench 1500 条目）才断连——512KB 低于临界点一个数量级。
pub const HARD_RAW_PAYLOAD_BYTES: usize = 512 * 1024;
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
    /// 跨域 iframe 递归采集开关（U-4 二期：默认 false 保持一期「同源 pierce +
    /// `|IFRAME|` 占位」行为；true 启用 §1.5 跨域递归——Page.getFrameTree 取
    /// 帧树 → frame 级 attach → 逐帧 DOMSnapshot）。
    pub cross_origin_iframes: bool,
    /// DOMSnapshot 是否请求 offsetRects/clientRects/scrollRects（46 复核：
    /// 当前实现不消费 DOMRects——SnapshotLayout 仅解析 node_index/bounds，
    /// 默认 false 最小面，源级削减 12-20% 载荷；布局 bounds 不受影响）。
    pub include_dom_rects: bool,
    /// DOMSnapshot 是否请求 paintOrders（46 复核：绘制序过滤（paint_filter）
    /// 的 paint_orders 输入在生产路径恒空（SerializeOptions::new 默认 &[]），
    /// 默认 false 最小面；**将来接线绘制序过滤时必须同时开启本开关**）。
    pub include_paint_order: bool,
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
            cross_origin_iframes: false,
            // 46 复核默认采集最小面：rects/paint 数据当前实现不消费
            include_dom_rects: false,
            include_paint_order: false,
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
            cross_origin_iframes: self.cross_origin_iframes,
            include_dom_rects: self.include_dom_rects,
            include_paint_order: self.include_paint_order,
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

    /// 开启/关闭跨域 iframe 递归采集（U-4 二期；默认关闭保持一期行为）。
    pub fn with_cross_origin_iframes(mut self, on: bool) -> Self {
        self.cross_origin_iframes = on;
        self
    }

    /// 开启/关闭 DOMSnapshot 完整载荷面（includeDOMRects + includePaintOrder）。
    /// 默认最小面（46 复核：两路数据当前实现不消费，源级削减 12-20% 载荷）；
    /// 接线绘制序过滤（paint_filter）或 DOMRects 消费方时开启。
    pub fn with_full_payload(mut self, on: bool) -> Self {
        self.include_dom_rects = on;
        self.include_paint_order = on;
        self
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

    /// U-4 二期配置位两态：默认 false（保持一期「同源 pierce + |IFRAME| 占位」
    /// 行为，不建帧会话不递归）；builder 开启 true；非活跃/缩放派生保持原值。
    #[test]
    fn budget_cross_origin_iframes_two_state() {
        let b = BudgetConfig::active();
        assert!(!b.cross_origin_iframes, "默认关闭（一期行为）");
        let on = BudgetConfig::active().with_cross_origin_iframes(true);
        assert!(on.cross_origin_iframes, "builder 开启后为 true");
        let off = BudgetConfig::active().with_cross_origin_iframes(false);
        assert!(!off.cross_origin_iframes, "显式关闭保持 false");
        // 派生预算不改变采集开关（活跃/非活跃是输出面预算，跨域采集配置独立）
        assert!(
            BudgetConfig::active().with_cross_origin_iframes(true).inactive().cross_origin_iframes,
            "非活跃派生应保留开启状态"
        );
        assert!(
            !BudgetConfig::active().inactive().cross_origin_iframes,
            "默认关闭派生保持关闭"
        );
        // scaled（测试构造辅助）经 ..*self 继承
        assert!(
            BudgetConfig::active().with_cross_origin_iframes(true).scaled(10, 10).cross_origin_iframes,
            "scaled 派生应保留开启状态"
        );
        // Default 实现同 active
        assert!(!BudgetConfig::default().cross_origin_iframes);
    }

    /// 双层体积上界常量（T-2 + 46 复核：150KB 降级阈值 + 512KB 硬护栏）。
    #[allow(clippy::assertions_on_constants)]
    #[test]
    fn budget_output_and_raw_payload_bounds() {
        assert_eq!(MAX_OUTPUT_BYTES, 32 * 1024);
        assert_eq!(MAX_RAW_PAYLOAD_BYTES, 150 * 1024);
        assert_eq!(HARD_RAW_PAYLOAD_BYTES, 512 * 1024);
        assert!(MAX_OUTPUT_BYTES < MAX_RAW_PAYLOAD_BYTES);
        assert!(
            MAX_RAW_PAYLOAD_BYTES < HARD_RAW_PAYLOAD_BYTES,
            "降级阈值应低于硬护栏（双层语义分层）"
        );
    }

    /// 46 复核：采集最小面默认（rects/paint 不请求——当前实现不消费），
    /// builder 可整体开启；非活跃/缩放派生保持原值。
    #[test]
    fn budget_capture_payload_flags_default_minimal() {
        let b = BudgetConfig::active();
        assert!(!b.include_dom_rects, "默认最小面：不请求 DOMRects");
        assert!(!b.include_paint_order, "默认最小面：不请求 paintOrders");
        let full = BudgetConfig::active().with_full_payload(true);
        assert!(full.include_dom_rects, "builder 开启后请求 DOMRects");
        assert!(full.include_paint_order, "builder 开启后请求 paintOrders");
        // 派生预算不改变采集载荷面（活跃/非活跃是输出面预算，采集参数独立）
        let full_inactive = BudgetConfig::active().with_full_payload(true).inactive();
        assert!(full_inactive.include_dom_rects, "非活跃派生保留开启状态");
        assert!(full_inactive.include_paint_order, "非活跃派生保留开启状态");
        assert!(
            !BudgetConfig::active().scaled(10, 10).include_dom_rects,
            "scaled 派生继承默认关闭"
        );
        // 显式关闭
        assert!(
            !BudgetConfig::active().with_full_payload(true).with_full_payload(false).include_dom_rects,
            "显式关闭后恢复最小面"
        );
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
