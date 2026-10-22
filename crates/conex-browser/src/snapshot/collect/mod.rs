//! CDP 数据采集（维度 13 §1：DOMSnapshot 主采集 + DOM.getDocument 结构通道 +
//! AX 辅助 + 布局数据；`EnhancedNode` 中间表示 = DOM 属性 + AX + 样式/布局三合一）
//!
//! ## 采集方案（§1.1）
//! - 主采集：`DOMSnapshot.captureSnapshot`（computedStyles 白名单 10 项；
//!   includePaintOrder/includeDOMRects 默认关——最小面，46 复核：两路数据
//!   当前实现不消费，`BudgetConfig::with_full_payload(true)` 可开启）
//! - 结构通道：`DOM.getDocument(depth=15, pierce=true)`（父子关系/backendNodeId/属性；
//!   depth 有限值防全深度序列化载荷爆炸，合计超 150KB 常规预算时降级跳过——
//!   仅用主通道）
//! - 辅助通道：`Accessibility.getFullAXTree`（逐帧并行；失败降级为空 AX）
//! - 布局：`Page.getLayoutMetrics`（CSS 视口 + devicePixelRatio）
//! - 四路并行（`tokio::join!`），首轮 10s 超时，未完成取消重发再等 2s（§1.2）
//!
//! ## 载荷双层护栏（46 复核）
//! - 150KB（`MAX_RAW_PAYLOAD_BYTES`）= 常规页合计降级触发阈值：主通道 + 结构
//!   通道合计超限 → 丢弃结构通道（getDocument 当前不被消费，零损失）
//! - 512KB（`HARD_RAW_PAYLOAD_BYTES`）= 主通道硬护栏：DOMSnapshot 单通道超限
//!   → PayloadOverflow（主数据缺失无法降级；防连接爆炸，4.99MB 级才断连）
//!
//! ## 数据来源双通道（任务口径）
//! 快照数据来源有两种——真实 CDP 采集（需要浏览器，`CdpCollector`）与**构造输入**
//! （测试/引擎侧从内部数据结构直接构建 `EnhancedNode` 树）。单元测试一律基于
//! 构造输入（确定性）；真实采集路径由 e2e 验证（§7.2 T8）。

use crate::cdp::domains::names::{
    ACCESSIBILITY_GET_FULL_AX_TREE, DOM_GET_DOCUMENT, DOM_GET_FRAME_OWNER,
    DOM_SNAPSHOT_CAPTURE_SNAPSHOT, PAGE_GET_FRAME_TREE, PAGE_GET_LAYOUT_METRICS,
    TARGET_GET_TARGETS,
};
use crate::cdp::domains::{
    AXNode, CaptureSnapshotResult, FrameTree, GetDocumentResult, GetFrameOwnerResult,
    GetFrameTreeResult, GetTargetsResult, SnapshotNode,
};
use crate::snapshot::budget::{
    BudgetConfig, COLLECT_P95_TARGET, HARD_RAW_PAYLOAD_BYTES, MAX_RAW_PAYLOAD_BYTES,
};
use crate::snapshot::SnapshotError;
use crate::SessionRef;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// 计算样式采样白名单（§1.3：仅采样以下 10 项，白名单外每加一项都线性增大
/// 快照体积并在重型站点触发崩溃，参考实现已踩坑）。
pub const COMPUTED_STYLES_WHITELIST: &[&str] = &[
    "display",
    "visibility",
    "opacity",
    "overflow",
    "overflow-x",
    "overflow-y",
    "cursor",
    "pointer-events",
    "position",
    "background-color",
];

/// 文档数上限（§1.5：`max_iframes = 64`，一期为 DOMSnapshot 文档数上限）。
pub const MAX_IFRAMES: usize = 64;
/// iframe 嵌套深度上限（§1.5：防恶意深嵌递归爆炸）。
pub const MAX_IFRAME_DEPTH: usize = 4;
/// DOM.getDocument 结构通道深度（性能护栏：`depth=-1` 全深度递归序列化是
/// raw payload 超限主因——bench 实测中页面 getDocument 215KB vs DOMSnapshot
/// 85KB ≈ 2.5 倍；该通道仅作 backendNodeId 兜底校验输入，骨架深度 15 已
/// 覆盖典型 DOM 结构，超深子树由 DOMSnapshot 主通道承担；配合 150KB 预算
/// 联动降级（合计超限时丢弃结构通道仅用主通道），T-2）。
pub const GET_DOCUMENT_DEPTH: i64 = 15;
/// 采集遍历元素护栏（§3.4 防呆上限：遍历元素 10000）。
pub const MAX_TRAVERSE_ELEMENTS: usize = 10_000;
/// 首轮采集超时（10s）+ 重发窗口（2s），合计 12s 硬超时（§1.2/T-1）。
pub const FIRST_ROUND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
pub const RETRY_WINDOW: std::time::Duration = std::time::Duration::from_secs(2);
/// 小 iframe 阈值（宽或高 < 10px 的跨域帧不进入；§1.5）。
pub const MIN_IFRAME_SIZE: f64 = 10.0;
/// 视口缓冲（可见性 = 与布局视口相交，上下各放宽 1000px，§1.5）。
pub const VIEWPORT_THRESHOLD: f64 = 1000.0;
/// 子帧采集超时护栏（§1.5：跨域帧为增强信息，超时降级 `|IFRAME|` 占位
/// 不阻塞主快照；主采集 12s 硬超时由管理器兜底，子帧单次 2s 足够）。
pub const FRAME_COLLECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

mod cdp;
mod fixture;
mod frames;
mod node;
mod tree_build;

pub use cdp::CdpCollector;
pub use fixture::FixtureCollector;
pub use node::{AxInfo, AxProperties, Bounds, EnhancedNode, FrameMarker, StyleInfo};
pub use tree_build::build_enhanced_tree;

/// 布局/视口度量（§1.2：Page.getLayoutMetrics + DPR）。
#[derive(Debug, Clone, Default)]
pub struct LayoutMetrics {
    pub viewport: Bounds,
    pub device_pixel_ratio: f64,
}

/// 跨域 iframe 递归统计（§1.5 二期：超预算截断 + 采集统计面）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CrossOriginStats {
    /// 成功递归采集的帧数
    pub frames_collected: usize,
    /// 尺寸 < 10px×10px 或无法定位 owner 的帧数（不递归，`|IFRAME|` 占位）
    pub skipped_small: usize,
    /// 预算截断帧数（max_iframes=64 / max_iframe_depth=4 / 150KB 载荷，13 §1.5/T-2）
    pub skipped_budget: usize,
    /// attach/采集失败的帧数（降级 `|IFRAME|` 占位，不阻塞主树）
    pub failed: usize,
    /// 建立的帧级 CDP 会话数
    pub sessions_attached: usize,
    /// 关闭的帧级 CDP 会话数（采集后即 detach，防泄漏）
    pub sessions_detached: usize,
}

/// 采集产物（采集阶段输出，进入序列化流水线）。
#[derive(Debug, Clone)]
pub struct CollectedData {
    /// 增强树根森林（真实路径每文档一棵根树；跨域 iframe 子文档以独立根树
    /// 追加于主树之后并带 `|IFRAME|` 标记，13 §1.5 二期）
    pub roots: Vec<EnhancedNode>,
    pub url: String,
    pub title: String,
    pub layout: LayoutMetrics,
    /// CDP 原始载荷估算字节（150KB 采集层护栏，T-2；含跨域帧累计）
    pub raw_payload_bytes: usize,
    /// 阶段耗时明细（自测/观测）
    pub collect_ms: u64,
    /// 跨域 iframe 递归统计（二期启用时非零）
    pub cross_origin: CrossOriginStats,
}

/// 采集错误（AX 降级语义：AX 失败不致命，主结构不丢）。
#[derive(Debug, Clone)]
pub struct CollectError {
    pub message: String,
    /// true = 仅 AX 通道失败（可降级为空 AX 继续）
    pub ax_degraded: bool,
}

impl std::fmt::Display for CollectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for CollectError {}

/// 采集器抽象：真实 CDP 采集（需要浏览器）与构造输入注入共用同一事务入口。
#[async_trait]
pub trait SnapshotCollector: Send + Sync {
    /// 采集指定会话的增强树。实现方负责四路并行、超时与降级语义。
    async fn collect(&self, tab_id: &str, session: &str) -> Result<CollectedData, SnapshotError>;
}

#[cfg(test)]
mod tests;
