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

/// 布局 bounds（坐标 + 尺寸，CSS 像素；设备像素 ÷ DPR 换算）。
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    /// 零尺寸（§2.3 排除：宽或高为 0 且无滚动内容）。
    pub fn is_zero(&self) -> bool {
        self.width <= 0.0 || self.height <= 0.0
    }

    /// 大 iframe 判定（S7：宽高均 > 100px）。
    pub fn is_big_iframe(&self) -> bool {
        self.width > 100.0 && self.height > 100.0
    }

    /// 图标尺寸（M3：10px ≤ 宽高 ≤ 50px）。
    pub fn is_icon_size(&self) -> bool {
        (10.0..=50.0).contains(&self.width) && (10.0..=50.0).contains(&self.height)
    }

    /// 包含比例（容器折叠用：other 被本矩形包含的面积比例，0-1）。
    pub fn containment(&self, other: &Bounds) -> f64 {
        if other.width <= 0.0 || other.height <= 0.0 || self.width <= 0.0 || self.height <= 0.0 {
            return 0.0;
        }
        let ix = ((self.x + self.width).min(other.x + other.width) - self.x.max(other.x)).max(0.0);
        let iy =
            ((self.y + self.height).min(other.y + other.height) - self.y.max(other.y)).max(0.0);
        (ix * iy) / (other.width * other.height)
    }
}

/// 计算样式子集（§1.3 白名单中判定/序列化用到的子集）。
#[derive(Debug, Clone, Default)]
pub struct StyleInfo {
    pub display: Option<String>,
    pub visibility: Option<String>,
    pub opacity: Option<f64>,
    /// overflow/overflow-x/overflow-y 合并值（任一非 visible → 可滚动候选）
    pub overflow: Option<String>,
    pub cursor: Option<String>,
    pub pointer_events: Option<String>,
    pub position: Option<String>,
    pub background_color: Option<String>,
}

impl StyleInfo {
    /// 隐藏判定（P3）：display:none / visibility:hidden / opacity≤0。
    pub fn is_hidden(&self) -> bool {
        self.display
            .as_deref()
            .is_some_and(|v| v.eq_ignore_ascii_case("none"))
            || self
                .visibility
                .as_deref()
                .is_some_and(|v| v.eq_ignore_ascii_case("hidden"))
            || self.opacity.is_some_and(|o| o <= 0.0)
    }

    /// 可滚动候选（W2）：overflow 任一值非 visible/clip。
    pub fn scroll_candidate(&self) -> bool {
        self.overflow
            .as_deref()
            .is_some_and(|v| !v.eq_ignore_ascii_case("visible") && !v.eq_ignore_ascii_case("clip"))
    }

    /// 背景不透明（绘制序过滤用：background-color 非 transparent 且 opacity ≥ 0.8）。
    pub fn bg_opaque(&self) -> bool {
        let opaque_color = self
            .background_color
            .as_deref()
            .is_some_and(|c| !c.eq_ignore_ascii_case("transparent") && !c.is_empty());
        let opaque_alpha = self.opacity.unwrap_or(1.0) >= 0.8;
        opaque_color && opaque_alpha
    }

    /// cursor:pointer（W1 弱信号）。
    pub fn cursor_pointer(&self) -> bool {
        self.cursor
            .as_deref()
            .is_some_and(|v| v.eq_ignore_ascii_case("pointer"))
    }
}

/// AX 合并信息（§1.4：DOM 属性 + AX name/role/properties + 布局数据三合一）。
#[derive(Debug, Clone, Default)]
pub struct AxInfo {
    /// AX 树中是否有对应节点（false = AX 通道无数据，相应规则不生效）
    pub present: bool,
    /// AX ignored（装饰性节点，P5 排除）
    pub ignored: bool,
    /// AX role（S4）
    pub role: Option<String>,
    /// 可访问名称（名称提取优先链：AX name → aria-label → title → placeholder → 文本）
    pub name: Option<String>,
    /// AX 交互属性（S5）
    pub properties: AxProperties,
}

/// AX 交互属性集合（S5：任一为真即强正信号）。
#[derive(Debug, Clone, Default)]
pub struct AxProperties {
    pub focusable: bool,
    pub editable: bool,
    pub settable: bool,
    pub checked: bool,
    pub expanded: bool,
    pub pressed: bool,
    pub selected: bool,
    pub required: bool,
    pub autocomplete: bool,
    pub keyshortcuts: bool,
    pub disabled: bool,
    pub hidden: bool,
}

impl AxProperties {
    /// S5 判定：任一交互属性为真。
    pub fn any_interactive(&self) -> bool {
        self.focusable
            || self.editable
            || self.settable
            || self.checked
            || self.expanded
            || self.pressed
            || self.selected
            || self.required
            || self.autocomplete
            || self.keyshortcuts
    }
}

/// 帧/影子标记（§3.2：`|IFRAME|`/`|SHADOW(open|closed)|`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameMarker {
    Iframe,
    ShadowOpen,
    ShadowClosed,
}

/// 增强节点（采集合并产物：DOM 域数据 + AX 合并 + 样式/布局）。
///
/// 构造输入路径：测试与引擎侧用 `EnhancedNode::element` 等构造器直接构建
/// 确定性树（fixture JSON / 内部数据结构）；真实采集路径由 `build_enhanced_tree`
/// 从 CDP 响应重建。
#[derive(Debug, Clone)]
pub struct EnhancedNode {
    /// backendNodeId（CDP 会话内全局唯一，直接作默认模型索引）
    pub backend_node_id: i64,
    /// 元素标签（小写）；None = 文本节点（tag 为空时 text 为内容）
    pub tag: Option<String>,
    pub attributes: Vec<(String, String)>,
    /// 文本节点内容（元素节点为 None；元素文本由直接子文本节点拼接）
    pub text: Option<String>,
    pub ax: AxInfo,
    pub styles: StyleInfo,
    pub bounds: Option<Bounds>,
    /// 可滚动（overflow* 样式或显式标注）
    pub scrollable: bool,
    /// 是否处于 SVG 子树（P6/S8；svg 根自身为 false，构造时从父继承）
    pub in_svg: bool,
    pub frame_marker: Option<FrameMarker>,
    /// 是否含 JS click 类监听器（getEventListeners 探测通道；默认关闭 T-4）
    pub has_click_listener: bool,
    pub children: Vec<EnhancedNode>,
}

impl EnhancedNode {
    /// 元素节点构造（构造输入入口）。
    pub fn element(tag: &str, backend_node_id: i64) -> Self {
        EnhancedNode {
            backend_node_id,
            tag: Some(tag.to_ascii_lowercase()),
            attributes: Vec::new(),
            text: None,
            ax: AxInfo::default(),
            styles: StyleInfo::default(),
            bounds: None,
            scrollable: false,
            in_svg: false,
            frame_marker: None,
            has_click_listener: false,
            children: Vec::new(),
        }
    }

    /// 文本节点构造（tag=None）。
    pub fn text_node(text: &str, backend_node_id: i64) -> Self {
        EnhancedNode {
            backend_node_id,
            tag: None,
            attributes: Vec::new(),
            text: Some(text.to_string()),
            ax: AxInfo::default(),
            styles: StyleInfo::default(),
            bounds: None,
            scrollable: false,
            in_svg: false,
            frame_marker: None,
            has_click_listener: false,
            children: Vec::new(),
        }
    }

    /// 追加属性（构造输入）。
    pub fn attr(mut self, name: &str, value: &str) -> Self {
        self.attributes.push((name.to_string(), value.to_string()));
        self
    }

    /// 设置 bounds（构造输入）。
    pub fn bounds(mut self, x: f64, y: f64, width: f64, height: f64) -> Self {
        self.bounds = Some(Bounds {
            x,
            y,
            width,
            height,
        });
        self
    }

    /// 设置可见样式（构造输入）。
    pub fn style(mut self, name: &str, value: &str) -> Self {
        match name {
            "display" => self.styles.display = Some(value.to_string()),
            "visibility" => self.styles.visibility = Some(value.to_string()),
            "opacity" => self.styles.opacity = value.parse().ok(),
            "overflow" => self.styles.overflow = Some(value.to_string()),
            "cursor" => self.styles.cursor = Some(value.to_string()),
            "pointer-events" => self.styles.pointer_events = Some(value.to_string()),
            "position" => self.styles.position = Some(value.to_string()),
            "background-color" => self.styles.background_color = Some(value.to_string()),
            _ => {}
        }
        self
    }

    /// 设置 AX role（构造输入）。
    pub fn ax_role(mut self, role: &str) -> Self {
        self.ax.present = true;
        self.ax.role = Some(role.to_string());
        self
    }

    /// 设置 AX 交互属性（构造输入）。
    pub fn ax_prop(mut self, name: &str, value: bool) -> Self {
        self.ax.present = true;
        let p = &mut self.ax.properties;
        match name {
            "focusable" => p.focusable = value,
            "editable" => p.editable = value,
            "settable" => p.settable = value,
            "checked" => p.checked = value,
            "expanded" => p.expanded = value,
            "pressed" => p.pressed = value,
            "selected" => p.selected = value,
            "required" => p.required = value,
            "autocomplete" => p.autocomplete = value,
            "keyshortcuts" => p.keyshortcuts = value,
            "disabled" => p.disabled = value,
            "hidden" => p.hidden = value,
            _ => {}
        }
        self
    }

    /// 设置 AX ignored（构造输入）。
    pub fn ax_ignored(mut self) -> Self {
        self.ax.present = true;
        self.ax.ignored = true;
        self
    }

    /// 设置滚动性（构造输入）。
    pub fn scrollable(mut self) -> Self {
        self.scrollable = true;
        self
    }

    /// 设置 SVG 子树标记（构造输入；svg 根自身不设）。
    pub fn svg_child(mut self) -> Self {
        self.in_svg = true;
        self
    }

    /// 设置帧/影子标记（构造输入）。
    pub fn marker(mut self, m: FrameMarker) -> Self {
        self.frame_marker = Some(m);
        self
    }

    /// 设置 JS click 类监听器（getEventListeners 探测通道，T-4 默认关闭）。
    pub fn listener(mut self) -> Self {
        self.has_click_listener = true;
        self
    }

    /// 追加子节点（构造输入）。
    pub fn push(mut self, child: EnhancedNode) -> Self {
        self.children.push(child);
        self
    }

    /// 读取属性（大小写不敏感）。
    pub fn get_attr(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// 是否为文本节点。
    pub fn is_text(&self) -> bool {
        self.tag.is_none()
    }

    /// 直接子文本拼接（元素行内联文本）。
    pub fn inline_text(&self) -> String {
        self.children
            .iter()
            .filter(|c| c.is_text())
            .filter_map(|c| c.text.as_deref())
            .collect()
    }

    /// 子树探测（≤ max_depth 层，含自身）是否存在满足谓词的节点（M1/W2 探测；
    /// 直接递归实现，避免泛型闭包的类型级递归）。
    pub fn subtree_has(&self, max_depth: usize, pred: &impl Fn(&EnhancedNode) -> bool) -> bool {
        if pred(self) {
            return true;
        }
        if max_depth == 0 {
            return false;
        }
        self.children
            .iter()
            .any(|c| c.subtree_has(max_depth - 1, pred))
    }

    /// 预遍历（前序；含自身）。
    pub fn walk(&self, f: &mut impl FnMut(&EnhancedNode)) {
        f(self);
        for c in &self.children {
            c.walk(f);
        }
    }

    /// 后序遍历（含自身；父节点在子节点之后访问，供「无任何可交互后代」统计）。
    pub fn walk_post(&self, f: &mut impl FnMut(&EnhancedNode)) {
        for c in &self.children {
            c.walk_post(f);
        }
        f(self);
    }

    /// 是否为可判定的元素节点（文本/文档根不参与可交互判定，P1 前置）。
    pub fn is_element_candidate(&self) -> bool {
        !self.is_text()
            && self.tag.as_deref() != Some("#document")
            && self.tag.as_deref() != Some("html")
            && self.tag.as_deref() != Some("body")
    }
}

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

/// 跨域帧预算（§1.5：max_iframes=64 与主 DOMSnapshot 文档数**共用**同一上限，
/// 跨域递归帧数并入；512KB 硬护栏原始载荷跨帧累计，46 复核——T-2 双层语义
/// 中硬护栏承接跨帧累计，150KB 降级阈值仅作用于单文档合计）。
#[derive(Debug, Clone, Copy)]
struct FrameBudget {
    /// 剩余可处理的跨域帧数（主文档数已从 64 中扣除）
    frames_left: usize,
    /// 剩余可用原始载荷字节
    payload_left: usize,
}

impl FrameBudget {
    fn new(frames_left: usize, payload_left: usize) -> Self {
        FrameBudget {
            frames_left,
            payload_left,
        }
    }
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

/// 构造输入采集器（测试/引擎侧确定性输入；不触网）。
pub struct FixtureCollector {
    roots: Vec<EnhancedNode>,
    url: String,
    title: String,
    payload_bytes: usize,
    /// 模拟挂起（时间预算测试用；Some(secs) = 挂起指定时长后返回）
    hang: Option<std::time::Duration>,
}

impl FixtureCollector {
    pub fn new(roots: Vec<EnhancedNode>) -> Self {
        FixtureCollector {
            roots,
            url: "https://example.com".to_string(),
            title: String::new(),
            payload_bytes: 0,
            hang: None,
        }
    }

    /// 构造输入 + 元数据（url/title/载荷估算）。
    pub fn with_meta(
        roots: Vec<EnhancedNode>,
        url: &str,
        title: &str,
        payload_bytes: usize,
    ) -> Self {
        FixtureCollector {
            roots,
            url: url.to_string(),
            title: title.to_string(),
            payload_bytes,
            hang: None,
        }
    }

    /// 注入挂起（时间预算测试：12s 硬超时断言用）。
    pub fn hang_for(mut self, d: std::time::Duration) -> Self {
        self.hang = Some(d);
        self
    }
}

#[async_trait]
impl SnapshotCollector for FixtureCollector {
    async fn collect(&self, _tab_id: &str, _session: &str) -> Result<CollectedData, SnapshotError> {
        if let Some(d) = self.hang {
            tokio::time::sleep(d).await;
        }
        Ok(CollectedData {
            roots: self.roots.clone(),
            url: self.url.clone(),
            title: self.title.clone(),
            layout: LayoutMetrics::default(),
            raw_payload_bytes: self.payload_bytes,
            collect_ms: 0,
            cross_origin: CrossOriginStats::default(),
        })
    }
}

/// 真实 CDP 采集器（需要浏览器会话；e2e 验证路径）。
pub struct CdpCollector {
    session: std::sync::Arc<crate::BrowserSession>,
    /// 采集预算全集（跨域递归开关 + 采集载荷面开关，46 复核后整体持有；
    /// 构造时传入 BudgetConfig，采集参数面随预算派生一致）
    budgets: BudgetConfig,
}

impl CdpCollector {
    pub fn new(session: std::sync::Arc<crate::BrowserSession>, budgets: BudgetConfig) -> Self {
        CdpCollector { session, budgets }
    }
}

/// 真实采集：四路并行 + 首轮 10s 超时 + 2s 重发窗口 + AX 降级。
#[async_trait]
impl SnapshotCollector for CdpCollector {
    async fn collect(&self, _tab_id: &str, session: &str) -> Result<CollectedData, SnapshotError> {
        let started = std::time::Instant::now();

        // —— 首轮并行（10s 超时；AX 失败降级为空，其余失败进重发）——
        let first = tokio::time::timeout(FIRST_ROUND_TIMEOUT, async {
            let snapshot_fut = self.session.send_page::<Value>(
                session,
                DOM_SNAPSHOT_CAPTURE_SNAPSHOT,
                json!({
                    "computedStyles": COMPUTED_STYLES_WHITELIST,
                    "includePaintOrder": self.budgets.include_paint_order,
                    "includeDOMRects": self.budgets.include_dom_rects,
                }),
            );
            let dom_fut = self.session.send_page::<Value>(
                session,
                crate::cdp::domains::names::DOM_GET_DOCUMENT,
                json!({ "depth": GET_DOCUMENT_DEPTH, "pierce": true }),
            );
            let metrics_fut =
                self.session
                    .send_page::<Value>(session, PAGE_GET_LAYOUT_METRICS, json!({}));
            let ax_fut =
                self.session
                    .send_page::<Value>(session, ACCESSIBILITY_GET_FULL_AX_TREE, json!({}));
            (
                snapshot_fut.await,
                dom_fut.await,
                metrics_fut.await,
                ax_fut.await,
            )
        })
        .await;

        let (snapshot_res, dom_res, metrics_res, ax_res) = match first {
            Ok(v) => v,
            Err(_) => {
                // 首轮超时：全部取消，2s 窗口内重发主三路（AX 直接降级为空）
                tracing::warn!("快照首轮采集超时，2s 窗口重发主通道");
                let retry = tokio::time::timeout(RETRY_WINDOW, async {
                    let s = self
                        .session
                        .send_page::<Value>(
                            session,
                            DOM_SNAPSHOT_CAPTURE_SNAPSHOT,
                            json!({
                                "computedStyles": COMPUTED_STYLES_WHITELIST,
                                "includePaintOrder": self.budgets.include_paint_order,
                                "includeDOMRects": self.budgets.include_dom_rects,
                            }),
                        )
                        .await;
                    let d = self
                        .session
                        .send_page::<Value>(
                            session,
                            DOM_GET_DOCUMENT,
                            json!({ "depth": GET_DOCUMENT_DEPTH, "pierce": true }),
                        )
                        .await;
                    (s, d)
                })
                .await;
                match retry {
                    Ok((s, d)) => (s, d, Ok(json!({})), Ok(json!({ "nodes": [] }))),
                    Err(_) => {
                        return Err(SnapshotError::Timeout(
                            crate::snapshot::budget::HARD_TIMEOUT,
                        ));
                    }
                }
            }
        };

        let snapshot_value = snapshot_res.map_err(|e| {
            SnapshotError::Collect(format!("DOMSnapshot.captureSnapshot 失败：{e}"))
        })?;
        let dom_value =
            dom_res.map_err(|e| SnapshotError::Collect(format!("DOM.getDocument 失败：{e}")))?;
        let metrics_value = metrics_res
            .map_err(|e| SnapshotError::Collect(format!("Page.getLayoutMetrics 失败：{e}")))?;

        // —— AX 失败降级为空（§1.2：AX 树失败可降级，主结构不丢）——
        let ax: Vec<AXNode> = match ax_res {
            Ok(v) => serde_json::from_value(v).unwrap_or_default(),
            Err(e) => {
                tracing::warn!("AX 树采集失败，降级为空 AX：{e}");
                Vec::new()
            }
        };

        // —— 反序列化 + 载荷双层护栏（46 复核）——
        // 分层语义：主通道 DOMSnapshot 超 512KB 硬护栏 = 硬错误（主数据缺失
        // 无法降级，防连接爆炸）；结构通道 getDocument 为兜底校验输入
        // （build_enhanced_tree 实际以 DOMSnapshot 重建，getDocument 仅预留
        // 校验面），合计超 150KB 常规预算时**降级跳过结构通道**——仅用
        // DOMSnapshot 继续，快照不失败（性能修复：中页面 getDocument 全深度
        // 215KB vs DOMSnapshot 85KB，曾致合计 ≈300KB 直接报 PayloadOverflow
        // 使采集整体失败；46 复核后 300 条目列表页主通道 326KB 在硬护栏内
        // 成功采集——模型输入面 32KB 截断树不受影响）。
        let snapshot_bytes = snapshot_value.to_string().len();
        if snapshot_bytes > HARD_RAW_PAYLOAD_BYTES {
            return Err(SnapshotError::PayloadOverflow {
                bytes: snapshot_bytes,
                max: HARD_RAW_PAYLOAD_BYTES,
            });
        }
        let dom_bytes = dom_value.to_string().len();
        let dom_degraded = snapshot_bytes + dom_bytes > MAX_RAW_PAYLOAD_BYTES;
        if dom_degraded {
            tracing::warn!(
                "DOM.getDocument 结构通道载荷超常规预算（快照 {snapshot_bytes}B + 结构 {dom_bytes}B > {}B），降级仅用 DOMSnapshot 主通道",
                MAX_RAW_PAYLOAD_BYTES
            );
        }
        // 降级后 payload 仅计主通道（被丢弃的结构通道不计入原始载荷估算）
        let payload_bytes = if dom_degraded {
            snapshot_bytes
        } else {
            snapshot_bytes + dom_bytes
        };

        let capture: CaptureSnapshotResult = serde_json::from_value(snapshot_value)
            .map_err(|e| SnapshotError::Collect(format!("DOMSnapshot 响应解析失败：{e}")))?;
        // 降级时结构通道以空占位（build_enhanced_tree 不使用该输入，仅签名占位）
        let document: GetDocumentResult = if dom_degraded {
            GetDocumentResult::default()
        } else {
            serde_json::from_value(dom_value)
                .map_err(|e| SnapshotError::Collect(format!("DOM.getDocument 响应解析失败：{e}")))?
        };

        let metrics: crate::cdp::domains::GetLayoutMetricsResult = serde_json::from_value(
            metrics_value,
        )
        .unwrap_or(crate::cdp::domains::GetLayoutMetricsResult {
            layout_viewport: crate::cdp::domains::LayoutViewport {
                x: 0.0,
                y: 0.0,
                width: 1280.0,
                height: 800.0,
                page_x: 0.0,
                page_y: 0.0,
                client_width: 1280.0,
                client_height: 800.0,
                scale: Some(1.0),
            },
            visual_viewport: crate::cdp::domains::VisualViewport {
                offset_x: 0.0,
                offset_y: 0.0,
                page_x: 0.0,
                page_y: 0.0,
                client_width: 1280.0,
                client_height: 800.0,
                scale: 1.0,
            },
            content_size: None,
        });

        let layout = LayoutMetrics {
            viewport: Bounds {
                x: metrics.layout_viewport.viewport_x(),
                y: metrics.layout_viewport.viewport_y(),
                width: metrics.layout_viewport.viewport_width(),
                height: metrics.layout_viewport.viewport_height(),
            },
            device_pixel_ratio: metrics.layout_viewport.scale.unwrap_or(1.0),
        };

        let mut roots = build_enhanced_tree(&capture, &document, &ax);
        let mut cross_origin = CrossOriginStats::default();

        // —— 跨域 iframe 递归（U-4 二期；`cross_origin_iframes` 配置位开启时）——
        // §1.5：Page.getFrameTree 取主 frame 树 → 对「未 pierce 的 frame」
        // （其 frameId 不在 DOMSnapshot 文档集内）帧级 attach → 递归采集。
        if self.budgets.cross_origin_iframes {
            match tokio::time::timeout(
                FRAME_COLLECT_TIMEOUT,
                self.session.send_page::<GetFrameTreeResult>(
                    session,
                    PAGE_GET_FRAME_TREE,
                    json!({}),
                ),
            )
            .await
            {
                Ok(Ok(frame_tree)) => {
                    // 已 pierce 帧集合 = DOMSnapshot 文档集的 frameId（同源帧
                    // 已在主采集文档内；frameId 为字符串池下标形态（Chrome 151
                    // 实测），经池解析；缺失时集合为空 → 全部帧按未覆盖处理）
                    let pierced: HashSet<String> = capture
                        .documents
                        .iter()
                        .filter_map(|d| d.frame_id.as_ref().map(|f| f.resolve(&capture.strings)))
                        .collect();
                    // 去重集合（防环/重复子树防御；主帧自身先行占位）
                    let mut visited: HashSet<String> = HashSet::new();
                    visited.insert(frame_tree.frame_tree.frame.id.clone());
                    // 预算：max_iframes=64 与主文档数共用；512KB 硬护栏载荷跨帧累计
                    let mut budget = FrameBudget::new(
                        MAX_IFRAMES.saturating_sub(capture.documents.len()),
                        HARD_RAW_PAYLOAD_BYTES.saturating_sub(payload_bytes),
                    );
                    self.recurse_frames(
                        session,
                        &mut roots,
                        &frame_tree.frame_tree,
                        &pierced,
                        &mut visited,
                        0,
                        &mut budget,
                        &mut cross_origin,
                    )
                    .await;
                }
                Ok(Err(e)) => {
                    tracing::warn!("Page.getFrameTree 失败，跳过跨域 iframe 递归：{e}");
                }
                Err(_) => {
                    tracing::warn!("Page.getFrameTree 超时，跳过跨域 iframe 递归");
                }
            }
            tracing::info!("跨域 iframe 快照统计：{cross_origin:?}");
        }

        let title = capture
            .documents
            .first()
            .and_then(|d| d.title.as_ref())
            .map(|t| t.resolve(&capture.strings))
            .unwrap_or_default();
        let url = capture
            .documents
            .first()
            .and_then(|d| d.document_url.as_ref())
            .map(|u| u.resolve(&capture.strings))
            .unwrap_or_default();

        // —— 耗时预算联动（T-1/46 复核观测面）——
        // 单次采集超出常规页 p95 目标（1.5s）时告警（含载荷分解），为
        // 「12s 硬超时（管理器兜底）→ 5s 硬预算 → p95 2s → 采集 p95 1.5s」
        // 分层中补上采集层自身的观测点；不中止采集（硬超时由管理器负责）。
        let collect_ms = started.elapsed().as_millis() as u64;
        if collect_ms > COLLECT_P95_TARGET.as_millis() as u64 {
            tracing::warn!(
                "快照采集超常规耗时预算：{collect_ms}ms > 目标 {}ms（载荷 {payload_bytes}B，结构通道{}）",
                COLLECT_P95_TARGET.as_millis(),
                if dom_degraded { "降级丢弃" } else { "保留" }
            );
        }

        Ok(CollectedData {
            roots,
            url,
            title,
            layout,
            raw_payload_bytes: payload_bytes,
            collect_ms,
            cross_origin,
        })
    }
}

// ===========================================================================
// 跨域 iframe 递归采集（维度 13 §1.5 二期语义，U-4）
// ===========================================================================
//
// ## 索引协调选择（backendNodeId 碰撞处理）
// 采用**全局唯一（合成索引兜底）**而非帧内索引空间隔离：
// - 各帧会话的 DOMSnapshot.backendNodeId 在其**会话内**全局唯一，但跨会话
//   会复用（CDP 不保证跨会话唯一）；
// - 子帧根树与主树同入 `roots` 根森林，序列化侧（serialize.rs §3.3）以
//   「默认索引 = backendNodeId，冲突时从树中全部 id 的 max+1 起分配合成
//   索引」保证最终模型索引全局唯一——本层不做二次分配，碰撞由既有机制
//   消解（测试断言索引唯一性）。
// - 遗留交接：`NodeRef`（selector_map）的 `session_id`/`frame_target_id`
//   目前由序列化侧统一填写（一期接口）；跨帧元素的会话归属注入执行面
//   （维度 14 动作跨 iframe 执行）为执行侧接线项，登记交接。
//
// ## 跨域帧会话生命周期选择：采集后立即 detach（不缓存）
// 理由：① 快照是只读一次性读取，下一轮快照重新 attach 的单轮往返成本
// 可忽略；② 帧导航/替换会使缓存会话失效，缓存需失效管理与错误重试面；
// ③ 不 detach 会在长会话中累积至多 64 个附加会话（泄漏面）。若后续实测
// attach 开销显著，可升级为会话级 LRU 缓存（登记为演进项）。

/// 帧级采集中间产物（子帧 DOMSnapshot 解析 + AX + 载荷 + 已 pierce 帧集合）。
struct FrameDocument {
    capture: CaptureSnapshotResult,
    document: GetDocumentResult,
    ax: Vec<AXNode>,
    /// 原始载荷估算字节（DOMSnapshot + DOM.getDocument 文本长）
    payload: usize,
    /// 该帧会话 DOMSnapshot 文档集的 frameId（子帧递归的 pierce 集合）
    pierced: HashSet<String>,
}

/// 帧候选筛选（纯函数，单测面）：同源 pierce 排除 → 去重 → 深度预算 →
/// 帧数/载荷预算。返回 true = 值得继续（尺寸门限需 owner 树定位，留在
/// 调用方异步判定）。
///
/// 预算语义：**尺寸/定位不过门的帧不计入 64 上限**（§1.5「小 iframe 不
/// 进入」），帧数预算在通过全部前置判定后才由调用方扣减。
fn frame_candidate_eligible(
    frame_id: &str,
    pierced: &HashSet<String>,
    visited: &mut HashSet<String>,
    depth: usize,
    budget: &FrameBudget,
    stats: &mut CrossOriginStats,
) -> bool {
    // 同源 pierce 已覆盖（DOMSnapshot 文档集内）→ 跳过
    if pierced.contains(frame_id) {
        return false;
    }
    // 已访问去重（防环/重复子树防御）
    if !visited.insert(frame_id.to_string()) {
        return false;
    }
    // 深度预算（max_iframe_depth=4：主文档深度 0，递归至多 4 层）
    if depth + 1 > MAX_IFRAME_DEPTH {
        stats.skipped_budget += 1;
        return false;
    }
    // 帧数预算（max_iframes=64 共用）与载荷预算（150KB，T-2）
    if budget.frames_left == 0 || budget.payload_left == 0 {
        stats.skipped_budget += 1;
        return false;
    }
    true
}

/// 尺寸门限（§1.5：尺寸 ≥ 10px×10px 才进入递归；无法确认尺寸 → 不进入，
/// 保守语义——无 bounds 的帧按占位呈现）。
fn iframe_size_qualified(bounds: Option<Bounds>) -> bool {
    match bounds {
        Some(b) => b.width >= MIN_IFRAME_SIZE && b.height >= MIN_IFRAME_SIZE,
        None => false,
    }
}

/// src URL 匹配兜底（§1.5：getFrameOwner 失败/frameId 不在树时按 src 定位
/// iframe owner；精确匹配，重定向场景由 getFrameOwner 主路径覆盖）。
fn find_owner_by_src(roots: &[EnhancedNode], url: &str) -> Option<i64> {
    for root in roots {
        let mut hit = None;
        root.walk(&mut |n| {
            if hit.is_none() && n.tag.as_deref() == Some("iframe") && n.get_attr("src") == Some(url)
            {
                hit = Some(n.backend_node_id);
            }
        });
        if hit.is_some() {
            return hit;
        }
    }
    None
}

/// 按 backendNodeId 查找节点（owner 存在性/尺寸定位；显式递归，避免
/// 闭包借用逃逸——walk 回调的生命周期约束）。
fn find_node_by_id(roots: &[EnhancedNode], backend_id: i64) -> Option<&EnhancedNode> {
    for root in roots {
        if let Some(hit) = find_node_rec(root, backend_id) {
            return Some(hit);
        }
    }
    None
}

fn find_node_rec(node: &EnhancedNode, backend_id: i64) -> Option<&EnhancedNode> {
    if node.backend_node_id == backend_id {
        return Some(node);
    }
    node.children
        .iter()
        .find_map(|c| find_node_rec(c, backend_id))
}

/// 节点布局 bounds 查找（尺寸门限输入）。
fn find_node_bounds(roots: &[EnhancedNode], backend_id: i64) -> Option<Bounds> {
    find_node_by_id(roots, backend_id).and_then(|n| n.bounds)
}

/// 给 owner 元素打 `|IFRAME|` 标记（无论递归成功还是占位，标记恒打——
/// 序列化面呈现 iframe 语义，§3.2）。
fn mark_owner_iframe(roots: &mut [EnhancedNode], backend_id: i64) -> bool {
    for root in roots {
        if let Some(found) = find_mut_node(root, backend_id) {
            found.frame_marker = Some(FrameMarker::Iframe);
            return true;
        }
    }
    false
}

/// 可变查找（mark_owner_iframe 用；独立于只读 walk 的借用）。
fn find_mut_node(node: &mut EnhancedNode, backend_id: i64) -> Option<&mut EnhancedNode> {
    if node.backend_node_id == backend_id {
        return Some(node);
    }
    for child in &mut node.children {
        if let Some(hit) = find_mut_node(child, backend_id) {
            return Some(hit);
        }
    }
    None
}

impl CdpCollector {
    /// 跨域帧递归（§1.5）：对父树未覆盖的帧逐帧「定位 owner → 尺寸门限 →
    /// attach → 采集 → 子树递归 → detach」，子文档根树追加进父树。
    ///
    /// `roots`：父会话增强树（owner 打 `|IFRAME|` 标记 + 接收子根）；
    /// `pierced`：父会话 DOMSnapshot 文档集 frameId（同源已覆盖集合）；
    /// `visited`：全递归共享去重集合；`depth`：相对主文档嵌套深度。
    ///
    /// 实现注记：递归 async 调用需引入间接层避免无限尺寸 future
    /// （E0733）——整体返回 `Pin<Box<dyn Future>>`，与深度预算 4 联动
    /// （盒装指针摊平尺寸，递归深度由 `max_iframe_depth` 钳制）。
    #[allow(clippy::too_many_arguments)]
    fn recurse_frames<'a>(
        &'a self,
        parent_session: &'a str,
        roots: &'a mut Vec<EnhancedNode>,
        tree: &'a FrameTree,
        pierced: &'a HashSet<String>,
        visited: &'a mut HashSet<String>,
        depth: usize,
        budget: &'a mut FrameBudget,
        stats: &'a mut CrossOriginStats,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let children = tree.child_frames.as_deref().unwrap_or_default();
            for child in children {
                let frame_id = &child.frame.id;
                let frame_url = child.frame.url.as_str();
                // 前置判定（pierce/去重/深度/帧数/载荷预算；纯函数）
                if !frame_candidate_eligible(frame_id, pierced, visited, depth, budget, stats) {
                    continue;
                }
                // 定位 owner（getFrameOwner 主路径 + src URL 兜底）并打 |IFRAME| 标记
                let owner = match self
                    .locate_frame_owner(roots, parent_session, frame_id, frame_url)
                    .await
                {
                    Some(owner) => owner,
                    None => {
                        // 无法定位 owner：按小/未知帧处理（占位已尽力标记，见 locate）
                        stats.skipped_small += 1;
                        continue;
                    }
                };
                // 尺寸门限（10px×10px，§1.5）
                if !iframe_size_qualified(owner.1) {
                    stats.skipped_small += 1;
                    continue;
                }
                // 预算扣减（至此才占额：尺寸/定位不过门的帧不计入 64）
                budget.frames_left -= 1;
                // 帧级会话建立（frameId 即 OOPIF targetId 主路径；getTargets URL 兜底）
                let frame_session = match self.attach_frame_session(frame_id, frame_url).await {
                    Ok(s) => s,
                    Err(e) => {
                        stats.failed += 1;
                        tracing::warn!("跨域帧 attach 失败（{frame_id}）：{e}");
                        continue;
                    }
                };
                stats.sessions_attached += 1;
                // 子文档采集（DOMSnapshot + DOM.getDocument + AX；失败降级占位）
                let frame_doc = match self.collect_frame_document(&frame_session.session).await {
                    Ok(d) => d,
                    Err(e) => {
                        stats.failed += 1;
                        tracing::warn!("跨域帧采集失败（{frame_id}）：{e}");
                        self.detach_frame_session(&frame_session.session, stats)
                            .await;
                        continue;
                    }
                };
                // 载荷预算（150KB 采集层护栏，T-2）：超限该帧不入树并停止递归
                if frame_doc.payload > budget.payload_left {
                    stats.skipped_budget += 1;
                    tracing::warn!(
                        "跨域帧载荷超剩余预算（{frame_id}：{}B），截断",
                        frame_doc.payload
                    );
                    budget.payload_left = 0;
                    self.detach_frame_session(&frame_session.session, stats)
                        .await;
                    continue;
                }
                budget.payload_left -= frame_doc.payload;

                // 子文档增强树（独立根树，与主树同入根森林；索引碰撞由序列化
                // 合成索引消解——见模块注释「索引协调选择」）
                let mut frame_roots =
                    build_enhanced_tree(&frame_doc.capture, &frame_doc.document, &frame_doc.ax);

                // 子帧自身的跨域子帧递归（其 getFrameTree 失败则跳过嵌套递归，
                // 已采内容保留——best-effort 语义）
                match tokio::time::timeout(
                    FRAME_COLLECT_TIMEOUT,
                    self.session.send_page::<GetFrameTreeResult>(
                        &frame_session.session,
                        PAGE_GET_FRAME_TREE,
                        json!({}),
                    ),
                )
                .await
                {
                    Ok(Ok(sub_tree)) => {
                        self.recurse_frames(
                            &frame_session.session,
                            &mut frame_roots,
                            &sub_tree.frame_tree,
                            &frame_doc.pierced,
                            visited,
                            depth + 1,
                            budget,
                            stats,
                        )
                        .await;
                    }
                    Ok(Err(e)) => tracing::warn!("子帧帧树采集失败（{frame_id}）：{e}"),
                    Err(_) => tracing::warn!("子帧帧树采集超时（{frame_id}）"),
                }

                // 合并：子文档根树追加进父树根森林
                roots.append(&mut frame_roots);
                stats.frames_collected += 1;

                // 会话生命周期：采集后立即 detach（见模块注释「会话生命周期选择」）
                self.detach_frame_session(&frame_session.session, stats)
                    .await;
            }
        })
    }

    /// 定位 iframe owner（主路径 `DOM.getFrameOwner(frameId)` → backendNodeId；
    /// 失败/结果不在树中时按 src URL 匹配兜底，§1.5）；返回 (backend_id, bounds)。
    /// 标记打点：主路径与兜底路径命中后均给 owner 打 `|IFRAME|` 标记（占位语义）。
    async fn locate_frame_owner(
        &self,
        roots: &mut [EnhancedNode],
        parent_session: &str,
        frame_id: &str,
        frame_url: &str,
    ) -> Option<(i64, Option<Bounds>)> {
        let by_frame = async {
            let res = tokio::time::timeout(
                FRAME_COLLECT_TIMEOUT,
                self.session.send_page::<GetFrameOwnerResult>(
                    parent_session,
                    DOM_GET_FRAME_OWNER,
                    json!({ "frameId": frame_id }),
                ),
            )
            .await
            .ok()?
            .ok()?;
            let backend = res.backend_node_id?;
            // 结果须落在父树中（防御：协议异常/帧漂移时回退 src 匹配）
            if find_node_by_id(roots, backend).is_some() {
                Some(backend)
            } else {
                None
            }
        };
        let owner_id = by_frame
            .await
            .or_else(|| find_owner_by_src(roots, frame_url))?;
        let bounds = find_node_bounds(roots, owner_id);
        mark_owner_iframe(roots, owner_id);
        Some((owner_id, bounds))
    }

    /// 建立帧级会话（主路径：OOPIF 的 targetId 即其 frameId，直接
    /// `Target.attachToTarget`；兜底：`Target.getTargets` 按 type=iframe +
    /// URL 匹配目标再 attach——13 §1.5「src URL 匹配兜底」）。
    async fn attach_frame_session(
        &self,
        frame_id: &str,
        frame_url: &str,
    ) -> Result<SessionRef, String> {
        match self.session.attach_frame(frame_id).await {
            Ok(r) => Ok(r),
            Err(e) => {
                tracing::warn!(
                    "iframe attach 主路径失败（{frame_id}：{e}），尝试 getTargets URL 兜底"
                );
                self.attach_by_target_url(frame_url).await
            }
        }
    }

    /// getTargets URL 兜底（attach 主路径失败时按 iframe 目标 URL 精确匹配）。
    async fn attach_by_target_url(&self, url: &str) -> Result<SessionRef, String> {
        let targets: GetTargetsResult = self
            .session
            .send_browser(TARGET_GET_TARGETS, json!({}))
            .await
            .map_err(|e| e.to_string())?;
        let hit = targets
            .target_infos
            .iter()
            .find(|t| t.target_type == "iframe" && t.url == url)
            .map(|t| t.target_id.clone());
        match hit {
            Some(target_id) => self
                .session
                .attach_frame(&target_id)
                .await
                .map_err(|e| e.to_string()),
            None => Err("getTargets 未找到匹配 URL 的 iframe 目标".to_string()),
        }
    }

    /// 子帧文档采集（DOMSnapshot + DOM.getDocument + AX 三路并行；
    /// 2s 子帧超时护栏；AX 失败降级为空——子帧挂断不得拖垮主快照，§1.5）。
    async fn collect_frame_document(&self, session: &str) -> Result<FrameDocument, String> {
        let fut = async {
            let s = self.session.send_page::<Value>(
                session,
                DOM_SNAPSHOT_CAPTURE_SNAPSHOT,
                json!({
                    "computedStyles": COMPUTED_STYLES_WHITELIST,
                    "includePaintOrder": self.budgets.include_paint_order,
                    "includeDOMRects": self.budgets.include_dom_rects,
                }),
            );
            let d = self.session.send_page::<Value>(
                session,
                DOM_GET_DOCUMENT,
                json!({ "depth": GET_DOCUMENT_DEPTH, "pierce": true }),
            );
            let ax =
                self.session
                    .send_page::<Value>(session, ACCESSIBILITY_GET_FULL_AX_TREE, json!({}));
            (s.await, d.await, ax.await)
        };
        let (s, d, ax) = tokio::time::timeout(FRAME_COLLECT_TIMEOUT, fut)
            .await
            .map_err(|_| "子帧采集超时".to_string())?;
        let snapshot_value = s.map_err(|e| format!("子帧 DOMSnapshot 失败：{e}"))?;
        let dom_value = d.map_err(|e| format!("子帧 DOM.getDocument 失败：{e}"))?;
        // 载荷估算同主通道分层：结构通道超预算 → 降级丢弃（payload 仅计主通道）
        let snapshot_bytes = snapshot_value.to_string().len();
        let dom_bytes = dom_value.to_string().len();
        let dom_degraded = snapshot_bytes + dom_bytes > MAX_RAW_PAYLOAD_BYTES;
        if dom_degraded {
            tracing::warn!(
                "子帧 DOM.getDocument 结构通道载荷超预算（快照 {snapshot_bytes}B + 结构 {dom_bytes}B），降级仅用 DOMSnapshot"
            );
        }
        let payload = if dom_degraded {
            snapshot_bytes
        } else {
            snapshot_bytes + dom_bytes
        };
        let capture: CaptureSnapshotResult = serde_json::from_value(snapshot_value)
            .map_err(|e| format!("子帧 DOMSnapshot 响应解析失败：{e}"))?;
        let document: GetDocumentResult = if dom_degraded {
            GetDocumentResult::default()
        } else {
            serde_json::from_value(dom_value)
                .map_err(|e| format!("子帧 DOM.getDocument 响应解析失败：{e}"))?
        };
        let ax: Vec<AXNode> = match ax {
            Ok(v) => serde_json::from_value(v).unwrap_or_default(),
            Err(e) => {
                tracing::warn!("子帧 AX 采集失败，降级为空 AX：{e}");
                Vec::new()
            }
        };
        let pierced: HashSet<String> = capture
            .documents
            .iter()
            .filter_map(|d| d.frame_id.as_ref().map(|f| f.resolve(&capture.strings)))
            .collect();
        Ok(FrameDocument {
            capture,
            document,
            ax,
            payload,
            pierced,
        })
    }

    /// 帧会话关闭（best-effort：失败仅告警——目标销毁时 Chrome 自行清理）。
    async fn detach_frame_session(&self, session: &str, stats: &mut CrossOriginStats) {
        match self.session.detach_frame(session).await {
            Ok(()) => stats.sessions_detached += 1,
            Err(e) => tracing::warn!("iframe 会话 detach 失败（{session}）：{e}"),
        }
    }
}

/// AX value 中提取布尔属性（focusable/disabled 等；"true"/"false"/bool 容错）。
fn ax_bool(value: &crate::cdp::domains::AXValue) -> bool {
    match value.value.as_ref() {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => s.eq_ignore_ascii_case("true"),
        Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0) != 0,
        _ => false,
    }
}

/// 文本节点类型（CDP nodeType：1=element，3=text，9=document）。
const NODE_TYPE_ELEMENT: i64 = 1;
const NODE_TYPE_TEXT: i64 = 3;
const NODE_TYPE_DOCUMENT: i64 = 9;

/// 字符串池解析 + 布局绑定 + AX 合并 → 增强树（§1.2/§1.4）。
///
/// 以 DOMSnapshot 的 documents 数组重建（`parent_index` 定父、字符串池定名、
/// layout 定 bounds、AX 按 backendDOMNodeId 合并）；每文档一棵根树。
/// 同源 iframe 子树（pierce 后 DOMSnapshot 给出 contentDocument）以独立根树
/// 呈现并标注 `|IFRAME|` 占位（跨文档挂接所需 contentDocumentIndex 字段在
/// 现有 domains 类型面未暴露，挂接细节留 e2e 实证；U-4 跨域递归为二期）。
/// DOM.getDocument 结构通道在本实现中作 backendNodeId 兜底校验输入（当前
/// 重建不消费该参数；结构通道载荷超预算时由采集层降级为默认占位传入）。
pub fn build_enhanced_tree(
    capture: &CaptureSnapshotResult,
    _document: &GetDocumentResult,
    ax: &[AXNode],
) -> Vec<EnhancedNode> {
    let strings = &capture.strings;

    // —— AX 索引：backendDOMNodeId → AX 节点（§1.4 去重：同 id 取首条）——
    let mut ax_by_id: HashMap<i64, &AXNode> = HashMap::new();
    for node in ax {
        if let Some(id) = node.backend_d_o_m_node_id {
            ax_by_id.entry(id).or_insert(node);
        }
    }

    let mut roots = Vec::new();
    let documents = capture.documents.iter().take(MAX_IFRAMES);

    for doc in documents {
        let nodes = &doc.nodes;
        // —— 布局索引：node_index → bounds（预构建 HashMap 防 O(n²)）——
        let layout_by_node: HashMap<i64, Bounds> = doc
            .layout
            .node_index
            .iter()
            .zip(doc.layout.bounds.iter())
            .filter_map(|(idx, v)| {
                let arr = v.as_array()?;
                if arr.len() < 4 {
                    return None;
                }
                let get = |i: usize| arr.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0);
                Some((
                    *idx,
                    Bounds {
                        x: get(0),
                        y: get(1),
                        width: get(2),
                        height: get(3),
                    },
                ))
            })
            .collect();

        // —— 父索引 → 子索引邻接表 ——
        let mut children_of: HashMap<i64, Vec<i64>> = HashMap::new();
        for (i, parent) in nodes.parent_index.iter().enumerate() {
            if *parent >= 0 && *parent != i as i64 {
                children_of.entry(*parent).or_default().push(i as i64);
            }
        }

        let mut built: HashMap<i64, EnhancedNode> = HashMap::new();
        let mut order: Vec<i64> = Vec::new();

        // 后序构建（子先于父）；根节点（parent=-1）逐一构建
        for (i, parent) in nodes.parent_index.iter().enumerate() {
            let idx = i as i64;
            if *parent >= 0 && *parent != idx {
                continue;
            }
            build_node(
                idx,
                strings,
                nodes,
                &layout_by_node,
                &ax_by_id,
                &children_of,
                &mut built,
                &mut order,
            );
        }

        for idx in order {
            if let Some(n) = built.remove(&idx) {
                roots.push(n);
            }
        }
    }
    roots
}

/// 递归构建单个节点（后序：先子后父；同一 backendNodeId 重复出现取首条）。
#[allow(clippy::too_many_arguments)]
fn build_node(
    idx: i64,
    strings: &[String],
    nodes: &SnapshotNode,
    layout: &HashMap<i64, Bounds>,
    ax: &HashMap<i64, &AXNode>,
    children_of: &HashMap<i64, Vec<i64>>,
    built: &mut HashMap<i64, EnhancedNode>,
    order: &mut Vec<i64>,
) {
    if built.contains_key(&idx) {
        return;
    }
    let ntype = nodes.node_type.get(idx as usize).copied().unwrap_or(0);
    let name = str_at(strings, node_name_idx(nodes, idx));
    let backend = nodes
        .backend_dom_node_id
        .as_ref()
        .and_then(|v| v.get(idx as usize))
        .copied()
        .unwrap_or(-idx);

    let mut node = match ntype {
        NODE_TYPE_TEXT => {
            EnhancedNode::text_node(str_at(strings, node_value_idx(nodes, idx)), backend)
        }
        NODE_TYPE_ELEMENT | NODE_TYPE_DOCUMENT => {
            let mut e = EnhancedNode::element(&name.to_ascii_lowercase(), backend);
            // 属性对（[nameIdx, valueIdx, ...]）
            if let Some(attrs) = nodes.attributes.as_ref().and_then(|v| v.get(idx as usize)) {
                let mut it = attrs.iter();
                while let (Some(ni), Some(vi)) = (it.next(), it.next()) {
                    let n = str_at(strings, *ni).to_string();
                    let v = str_at(strings, *vi).to_string();
                    e.attributes.push((n, v));
                }
            }
            // iframe 元素恒打 |IFRAME| 标记（13 §1.5/§3.2：iframe 元素本身在
            // 序列化中以 |IFRAME| 占位呈现，一期即生效）。真实 Chrome 主采集
            // DOMSnapshot 已含跨域帧文档（2026-08-12 双本地服务器实测：关闭态
            // 根树即含跨域子文档），跨域递归仅是 frameId 不在文档集的防御路径
            // ——标记不能只依赖递归路径的 mark_owner_iframe。
            if e.tag.as_deref() == Some("iframe") {
                e.frame_marker = Some(FrameMarker::Iframe);
            }
            // 计算样式（styles 池未在现有 domains 类型面暴露时跳过；e2e 实证）
            e
        }
        // 其他节点类型（注释节点等）以元素形态兜底入树
        _ => EnhancedNode::element(str_at(strings, node_name_idx(nodes, idx)), backend),
    };

    // 布局绑定（CSS 像素；bounds 数组 [x, y, width, height]）
    if let Some(b) = layout.get(&idx) {
        node.bounds = Some(*b);
    }

    // AX 合并（§1.4：以 backendDOMNodeId 为键；D3：value/valuetext 在合并阶段即清除）
    if let Some(ax_node) = ax.get(&node.backend_node_id) {
        let props = &mut node.ax;
        props.present = true;
        props.ignored = ax_node.ignored.unwrap_or(false);
        if let Some(role) = ax_node.role.as_ref() {
            if let Some(serde_json::Value::String(s)) = role.value.as_ref() {
                props.role = Some(s.clone());
            }
        }
        if let Some(name) = ax_node.name.as_ref() {
            if let Some(serde_json::Value::String(s)) = name.value.as_ref() {
                props.name = Some(s.clone());
            }
        }
        if let Some(properties) = ax_node.properties.as_ref() {
            for p in properties {
                let is_true = ax_bool(&p.value);
                match p.name.as_str() {
                    "focusable" => props.properties.focusable = is_true,
                    "editable" => props.properties.editable = is_true,
                    "settable" => props.properties.settable = is_true,
                    "checked" => props.properties.checked = is_true,
                    "expanded" => props.properties.expanded = is_true,
                    "pressed" => props.properties.pressed = is_true,
                    "selected" => props.properties.selected = is_true,
                    "required" => props.properties.required = is_true,
                    "autocomplete" => props.properties.autocomplete = is_true,
                    "keyshortcuts" => props.properties.keyshortcuts = is_true,
                    "disabled" => props.properties.disabled = is_true,
                    "hidden" => props.properties.hidden = is_true,
                    // D3：value/valuetext 不流入增强节点
                    _ => {}
                }
            }
        }
    }

    // 子节点（后序挂接）
    if let Some(kids) = children_of.get(&idx) {
        for &kid in kids {
            if !built.contains_key(&kid) {
                build_node(kid, strings, nodes, layout, ax, children_of, built, order);
            }
            if let Some(child) = built.remove(&kid) {
                node.children.push(child);
            }
        }
    }

    built.insert(idx, node);
    order.push(idx);
}

/// 节点名索引（字符串池下标；负数/越界 → -1）。
fn node_name_idx(nodes: &SnapshotNode, idx: i64) -> i64 {
    nodes.node_name.get(idx as usize).copied().unwrap_or(-1)
}

/// 节点值索引（文本节点内容；负数/越界 → -1）。
fn node_value_idx(nodes: &SnapshotNode, idx: i64) -> i64 {
    nodes.node_value.get(idx as usize).copied().unwrap_or(-1)
}

/// 字符串池索引 → 文本（负数/越界返回空串）。
fn str_at(strings: &[String], idx: i64) -> &str {
    strings.get(idx as usize).map(|s| s.as_str()).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::mock::{MockReply, MockServer};
    use crate::cdp::sender::{
        ApprovalDenied, BrowserAuditEvent, CancellationToken, CdpCommandView, CommandPolicyHooks,
        IdKey,
    };
    use crate::cdp::transport::{CdpEndpoint, ExpectedBrowser};
    use crate::snapshot::serialize::{build_and_serialize, SerializeOptions};
    use crate::{BrowserSession, CdpError};
    use std::sync::{atomic::AtomicBool, Arc};

    /// 放行钩子（mock CDP 集成测试用；对齐 lib.rs 测试面）。
    struct AllowHooks {
        stop: Arc<AtomicBool>,
        token: CancellationToken,
    }

    impl AllowHooks {
        fn new() -> Self {
            AllowHooks {
                stop: Arc::new(AtomicBool::new(false)),
                token: CancellationToken::new(),
            }
        }
    }

    #[async_trait]
    impl CommandPolicyHooks for AllowHooks {
        async fn idempotent(&self, _key: &IdKey) -> Option<Result<Value, CdpError>> {
            None
        }
        async fn approve(&self, _cmd: &CdpCommandView) -> Result<(), ApprovalDenied> {
            Ok(())
        }
        fn audit(&self, _event: BrowserAuditEvent) {}
        fn emergency_stop(&self) -> Arc<AtomicBool> {
            self.stop.clone()
        }
        fn abort_token(&self) -> CancellationToken {
            self.token.clone()
        }
    }

    /// 恢复流程所需的 mock 自动应答全表（对齐 lib.rs 测试面）。
    fn restore_reply_map() -> Vec<(&'static str, MockReply)> {
        use crate::cdp::domains::names::*;
        vec![
            (
                BROWSER_GET_VERSION,
                MockReply::Ok(json!({
                    "protocolVersion": "1.3",
                    "product": "Chrome/131.0.6778.204",
                    "revision": "@abc",
                    "userAgent": "ua",
                    "jsVersion": "13.1.71"
                })),
            ),
            (TARGET_SET_DISCOVER_TARGETS, MockReply::Ok(json!({}))),
            (
                TARGET_GET_TARGETS,
                MockReply::Ok(json!({
                    "targetInfos": [
                        { "targetId": "T1", "type": "page", "title": "A", "url": "https://a.example" }
                    ]
                })),
            ),
            (
                TARGET_ATTACH_TO_TARGET,
                MockReply::Ok(json!({ "sessionId": "FRAME_S1" })),
            ),
            (
                TARGET_DETACH_FROM_TARGET,
                MockReply::Ok(json!({ "success": true })),
            ),
            (PAGE_ENABLE, MockReply::Ok(json!({}))),
            (PAGE_SET_LIFECYCLE_EVENTS_ENABLED, MockReply::Ok(json!({}))),
            (RUNTIME_ENABLE, MockReply::Ok(json!({}))),
            (DOM_ENABLE, MockReply::Ok(json!({}))),
            (NETWORK_ENABLE, MockReply::Ok(json!({}))),
            (NETWORK_SET_BLOCKED_URLS, MockReply::Ok(json!({}))),
            (
                RUNTIME_RUN_IF_WAITING_FOR_DEBUGGER,
                MockReply::Ok(json!({})),
            ),
            (
                RUNTIME_EVALUATE,
                MockReply::Ok(json!({ "result": { "value": 1 } })),
            ),
            (PAGE_SET_WINDOW_OPEN_HANDLER, MockReply::Ok(json!({}))),
            (PAGE_HANDLE_JAVASCRIPT_DIALOG, MockReply::Ok(json!({}))),
        ]
    }

    /// 主会话快照应答：主文档（frameId=MAIN）+ iframe owner(101) + 按钮(202)。
    /// iframe owner 布局 320×240 ≥ 10px 门限；按钮 bounds 正常。
    fn main_capture_fixture() -> Value {
        json!({
            "strings": ["", "#document", "IFRAME", "BUTTON", "src",
                        "https://b.example/embed", "https://a.example", "跨域测试页"],
            "documents": [{
                "documentURL": 6,
                "title": 7,
                "frameId": "MAIN",
                "nodes": {
                    "parentIndex": [-1, 0, 0],
                    "nodeType": [9, 1, 1],
                    "nodeName": [1, 2, 3],
                    "nodeValue": [-1, -1, -1],
                    "backendNodeId": [1, 101, 202],
                    "attributes": [[], [4, 5], []],
                    "childNodeIndexes": [1, 2, -1]
                },
                "layout": {
                    "nodeIndex": [0, 1, 2],
                    "bounds": [
                        [0, 0, 800, 600],
                        [0, 0, 320, 240],
                        [10, 10, 120, 36]
                    ]
                }
            }]
        })
    }

    /// 子帧会话快照应答：子文档（frameId=F1）+ 按钮(202)——与主树 backendNodeId
    /// **复用**（跨会话 id 空间独立），验证索引碰撞由合成索引消解。
    fn frame_capture_fixture() -> Value {
        json!({
            "strings": ["", "#document", "BUTTON", "https://b.example/embed"],
            "documents": [{
                "documentURL": 3,
                "title": 0,
                "frameId": "F1",
                "nodes": {
                    "parentIndex": [-1, 0],
                    "nodeType": [9, 1],
                    "nodeName": [1, 2],
                    "nodeValue": [-1, -1],
                    "backendNodeId": [1001, 202],
                    "attributes": [[], []],
                    "childNodeIndexes": [1, -1]
                },
                "layout": {
                    "nodeIndex": [0, 1],
                    "bounds": [
                        [0, 0, 640, 480],
                        [0, 0, 100, 30]
                    ]
                }
            }]
        })
    }

    /// mock CDP 会话面辅助：建连（恢复流程自动应答见 restore_reply_map）。
    async fn connect_mock(mock: &MockServer, ws_path: &str) -> Arc<BrowserSession> {
        let endpoint = CdpEndpoint {
            port: mock.addr.port(),
            ws_path: ws_path.to_string(),
        };
        Arc::new(
            BrowserSession::connect(
                endpoint,
                ExpectedBrowser {
                    product_prefix: Some("Chrome/".to_string()),
                    min_major: None,
                },
                Arc::new(AllowHooks::new()),
            )
            .await
            .expect("建连失败"),
        )
    }

    /// 两态之一的主采集驱动：等待主 captureSnapshot 并应答（递归开启时再答一帧）。
    async fn drive_capture_snapshot(mock: &mut MockServer, reply_value: Value) {
        let cmd = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            mock.expect_command("DOMSnapshot.captureSnapshot"),
        )
        .await
        .expect("等待 captureSnapshot 超时");
        let id = cmd["id"].as_u64().expect("命令 id 缺失");
        mock.reply(id, reply_value);
    }

    /// 构造输入：元素/文本/属性/样式/bounds/AX 链式构造冒烟。
    #[test]
    fn enhanced_node_builder_smoke() {
        let root = EnhancedNode::element("div", 1)
            .attr("class", "page")
            .bounds(0.0, 0.0, 800.0, 600.0)
            .push(
                EnhancedNode::element("button", 2)
                    .attr("onclick", "go()")
                    .bounds(10.0, 10.0, 120.0, 36.0)
                    .style("cursor", "pointer")
                    .push(EnhancedNode::text_node("登录", 3)),
            );
        assert_eq!(root.tag.as_deref(), Some("div"));
        assert_eq!(root.get_attr("class"), Some("page"));
        assert_eq!(root.children.len(), 1);
        let btn = &root.children[0];
        assert_eq!(btn.get_attr("onclick"), Some("go()"));
        assert_eq!(btn.bounds.unwrap().width, 120.0);
        assert_eq!(btn.styles.cursor.as_deref(), Some("pointer"));
        assert_eq!(btn.inline_text(), "登录");
    }

    /// 文本/元素区分与子树探测。
    #[test]
    fn enhanced_node_text_and_probe() {
        let root = EnhancedNode::element("label", 1)
            .push(EnhancedNode::element("span", 2).push(EnhancedNode::element("input", 3)));
        assert!(!root.is_text());
        let has_input = root.subtree_has(2, &|n| n.tag.as_deref() == Some("input"));
        assert!(has_input, "2 层内应探测到 input");
        assert!(
            !root.subtree_has(1, &|n| n.tag.as_deref() == Some("input")),
            "1 层内探测不到孙级 input"
        );
    }

    /// 遍历与可交互计数（后序/前序语义）。
    #[test]
    fn enhanced_node_walk_counts() {
        let root = EnhancedNode::element("div", 1)
            .push(EnhancedNode::element("div", 2).push(EnhancedNode::element("button", 3)));
        let mut visited = Vec::new();
        root.walk(&mut |n| visited.push(n.backend_node_id));
        assert_eq!(visited, vec![1, 2, 3]);

        let mut post = Vec::new();
        root.walk_post(&mut |n| post.push(n.backend_node_id));
        assert_eq!(post, vec![3, 2, 1], "后序：子先于父");
    }

    /// 布局：零尺寸/图标尺寸/大 iframe/包含比例。
    #[test]
    fn bounds_helpers() {
        let zero = Bounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 10.0,
        };
        assert!(zero.is_zero());
        let icon = Bounds {
            x: 0.0,
            y: 0.0,
            width: 20.0,
            height: 20.0,
        };
        assert!(icon.is_icon_size());
        assert!(!icon.is_big_iframe());
        let big = Bounds {
            x: 0.0,
            y: 0.0,
            width: 300.0,
            height: 200.0,
        };
        assert!(big.is_big_iframe());

        let outer = Bounds {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let inner = Bounds {
            x: 10.0,
            y: 10.0,
            width: 20.0,
            height: 20.0,
        };
        assert!(
            (outer.containment(&inner) - 1.0).abs() < 1e-9,
            "完全包含应 100%"
        );
        let outside = Bounds {
            x: 200.0,
            y: 0.0,
            width: 20.0,
            height: 20.0,
        };
        assert_eq!(outer.containment(&outside), 0.0);
        let half = Bounds {
            x: 90.0,
            y: 10.0,
            width: 20.0,
            height: 20.0,
        };
        assert!(
            (outer.containment(&half) - 0.5).abs() < 1e-9,
            "半包含应 50%"
        );
    }

    /// 样式：隐藏/可滚动候选/背景不透明。
    #[allow(clippy::field_reassign_with_default)]
    #[test]
    fn style_helpers() {
        let mut s = StyleInfo::default();
        assert!(!s.is_hidden());
        s.display = Some("none".into());
        assert!(s.is_hidden());
        let mut s = StyleInfo::default();
        s.opacity = Some(0.0);
        assert!(s.is_hidden());
        let mut s = StyleInfo::default();
        s.overflow = Some("auto".into());
        assert!(s.scroll_candidate());
        let mut s = StyleInfo::default();
        s.overflow = Some("visible".into());
        assert!(!s.scroll_candidate());
        let mut s = StyleInfo::default();
        s.background_color = Some("#fff".into());
        assert!(s.bg_opaque());
        let mut s = StyleInfo::default();
        s.background_color = Some("transparent".into());
        assert!(!s.bg_opaque());
    }

    /// AX：交互属性任一为真（S5 判定面）。
    #[test]
    fn ax_properties_any_interactive() {
        let mut p = AxProperties::default();
        assert!(!p.any_interactive());
        p.focusable = true;
        assert!(p.any_interactive());
        assert!(!p.disabled && !p.hidden, "disabled/hidden 不属于正信号");
    }

    /// 采集错误 Display/降级标志。
    #[test]
    fn collect_error_shapes() {
        let e = CollectError {
            message: "boom".into(),
            ax_degraded: true,
        };
        assert_eq!(e.to_string(), "boom");
        assert!(e.ax_degraded);
    }

    /// DOMSnapshot 响应重建：字符串池 + parent_index + layout + AX 合并。
    /// 构造确定性输入（fixture JSON 形状），验证解析/绑定/合并逻辑。
    #[test]
    fn build_tree_from_capture_response() {
        // strings 池：0=空、1=DIV、2=#text、3=BUTTON、4=登录、5=class、6=btn
        let capture: CaptureSnapshotResult = serde_json::from_value(serde_json::json!({
            "strings": ["", "DIV", "#text", "BUTTON", "登录", "class", "btn"],
            "documents": [{
                "documentURL": "https://example.com",
                "title": "示例",
                "nodeCount": 5,
                "nodes": {
                    "parentIndex": [-1, 0, 1, 0, -1],
                    "nodeType": [1, 1, 3, 1, 1],
                    "nodeName": [1, 3, 2, 3, 3],
                    "nodeValue": [-1, -1, 4, -1, -1],
                    "backendDOMNodeId": [10, 11, 12, 13, 20],
                    "attributes": [
                        [],
                        [5, 6],
                        [],
                        [],
                        []
                    ],
                    "childNodeIndexes": [1, 3, -1, -1, -1]
                },
                "layout": {
                    "nodeIndex": [0, 1, 3],
                    "bounds": [
                        [0, 0, 800, 600],
                        [10, 10, 120, 36],
                        [140, 10, 100, 30]
                    ]
                }
            }]
        }))
        .expect("capture fixture 解析失败");
        let document: GetDocumentResult = serde_json::from_value(serde_json::json!({
            "root": { "nodeId": 1, "backendNodeId": 10, "nodeType": 1, "nodeName": "DIV", "attributes": [], "children": [] }
        }))
        .expect("getDocument fixture 解析失败");
        let ax: Vec<AXNode> = serde_json::from_value(serde_json::json!([
            {
                "nodeId": "1",
                "ignored": false,
                "role": { "type": "role", "value": "button" },
                "name": { "type": "string", "value": "登录" },
                "properties": [
                    { "name": "focusable", "value": { "type": "boolean", "value": true } }
                ],
                "backendDOMNodeId": 13
            }
        ]))
        .expect("AX fixture 解析失败");

        let roots = build_enhanced_tree(&capture, &document, &ax);
        assert_eq!(roots.len(), 2, "两个根（parent=-1 的两棵子树）");

        let root = roots
            .iter()
            .find(|r| r.backend_node_id == 10)
            .expect("DIV 根应存在");
        assert_eq!(root.tag.as_deref(), Some("div"));
        assert_eq!(root.bounds.unwrap().width, 800.0);

        let btn = root
            .children
            .iter()
            .find(|c| c.backend_node_id == 11)
            .expect("BUTTON 应挂接在 DIV 下");
        assert_eq!(btn.tag.as_deref(), Some("button"));
        assert_eq!(btn.get_attr("class"), Some("btn"));
        assert_eq!(btn.bounds.unwrap().width, 120.0);
        // 文本子节点（登录）
        assert_eq!(btn.children.len(), 1);
        assert_eq!(btn.children[0].text.as_deref(), Some("登录"));
        // 无 AX 数据时保持缺省
        assert!(!btn.ax.present);

        // AX 合并：backend 13 的按钮获得 role/name/focusable
        let ax_btn = root
            .children
            .iter()
            .find(|c| c.backend_node_id == 13)
            .expect("AX 目标按钮应挂接在 DIV 下");
        assert_eq!(ax_btn.ax.role.as_deref(), Some("button"));
        assert_eq!(ax_btn.ax.name.as_deref(), Some("登录"));
        assert!(ax_btn.ax.properties.focusable);

        // 未匹配 AX 的节点不受影响
        let second = roots
            .iter()
            .find(|r| r.backend_node_id == 20)
            .expect("第二个根应存在");
        assert_eq!(second.tag.as_deref(), Some("button"));
        assert!(!second.ax.present, "无 AX 数据时 present 保持 false");
    }

    /// 文档数上限护栏（MAX_IFRAMES=64）。
    #[test]
    fn capture_documents_capped_at_max_iframes() {
        let mut documents = Vec::new();
        for i in 0..70 {
            documents.push(serde_json::json!({
                "documentURL": format!("https://f{i}.example"),
                "title": "",
                "nodeCount": 1,
                "nodes": {
                    "parentIndex": [-1],
                    "nodeType": [9],
                    "nodeName": [0],
                    "nodeValue": [-1],
                    "backendDOMNodeId": [i],
                    "childNodeIndexes": [-1]
                },
                "layout": { "nodeIndex": [], "bounds": [] }
            }));
        }
        let capture: CaptureSnapshotResult = serde_json::from_value(serde_json::json!({
            "strings": [""],
            "documents": documents
        }))
        .expect("fixture 解析失败");
        let document: GetDocumentResult = serde_json::from_value(serde_json::json!({
            "root": { "nodeId": 1 }
        }))
        .unwrap();
        let roots = build_enhanced_tree(&capture, &document, &[]);
        assert_eq!(roots.len(), MAX_IFRAMES, "文档数应截断到 64");
    }

    /// 回归（联调 E2 根因）：Chrome 151 实测响应形态必须可解析——`backendNodeId`
    /// 字段名（非旧文档 backendDOMNodeId）、稀疏数据映射（Rare*Data {index,value}）、
    /// `nodeCount`/`childNodeIndexes` 缺失、documentURL/title 为字符串池下标。
    /// 全部断言使用真实浏览器抓取的响应原样。
    #[test]
    fn capture_chrome151_real_shape_parses() {
        let raw = serde_json::json!({
            "strings": [
                "data:text/html;charset=utf-8,%3Cinput%3E",
                "联调测试页",
                "#document", "HTML", "HEAD", "BODY", "INPUT", "id", "name",
                "BUTTON", "中文按钮", "#text", "\n"
            ],
            "documents": [{
                "documentURL": 0,
                "title": 1,
                "nodes": {
                    "attributes": [[], [7, 8], [], [], [11, 12], [], []],
                    "backendNodeId": [2, 3, 4, 5, 1, 6, 7],
                    "contentDocumentIndex": { "index": [], "value": [] },
                    "currentSourceURL": { "index": [], "value": [] },
                    "inputChecked": { "index": [] },
                    "inputValue": { "index": [4], "value": [-1] },
                    "isClickable": { "index": [4] },
                    "nodeName": [3, 4, 5, 6, 9, 10, 12],
                    "nodeType": [9, 1, 1, 1, 1, 1, 3],
                    "nodeValue": [-1, -1, -1, -1, -1, -1, 11],
                    "optionSelected": { "index": [] },
                    "originURL": { "index": [], "value": [] },
                    "parentIndex": [-1, 0, 1, 1, 3, 3, 5],
                    "pseudoIdentifier": { "index": [], "value": [] },
                    "pseudoType": { "index": [], "value": [] },
                    "shadowRootType": { "index": [], "value": [] },
                    "textValue": { "index": [], "value": [] }
                },
                "layout": {
                    "bounds": [[0, 0, 1262, 624], [8, 8, 1246, 608], [8, 8, 177, 21], [185, 8, 23, 21], [193, 11, 7, 15]],
                    "clientRects": [[], [0, 0, 1262, 624], [2, 2, 173, 17], [2, 2, 19, 17], []],
                    "nodeIndex": [0, 1, 3, 4, 5],
                    "offsetRects": [[], [0, 0, 1246, 608], [8, 8, 177, 21], [185, 8, 23, 21], []],
                    "paintOrders": [0, 1, 2, 1, 1],
                    "scrollRects": [[], [0, 0, 1262, 624], [0, 0, 173, 17], [0, 0, 19, 17], []],
                    "stackingContexts": { "index": [0] },
                    "styles": [[], [], [], [], []]
                },
                "textBoxes": { "nodeIndex": [], "bounds": [], "runs": [] },
                "baseURL": 0,
                "contentLanguage": "zh-CN",
                "encodingName": "UTF-8",
                "frameId": "F1",
                "publicId": "",
                "systemId": "",
                "scrollOffsetX": 0,
                "scrollOffsetY": 0,
                "contentWidth": 1262,
                "contentHeight": 624
            }]
        });
        let capture: CaptureSnapshotResult =
            serde_json::from_value(raw).expect("Chrome 151 真实形态解析失败（协议漂移回归）");
        let doc = &capture.documents[0];
        // documentURL/title 为字符串池下标 → 池解析
        assert_eq!(
            doc.document_url.as_ref().unwrap().resolve(&capture.strings),
            "data:text/html;charset=utf-8,%3Cinput%3E",
            "documentURL 应经字符串池解析"
        );
        assert_eq!(
            doc.title.as_ref().unwrap().resolve(&capture.strings),
            "联调测试页",
            "title 应经字符串池解析"
        );
        // 稀疏数据映射形态
        assert_eq!(doc.nodes.input_value.as_ref().unwrap().index, vec![4]);
        assert_eq!(doc.nodes.input_value.as_ref().unwrap().value, vec![-1]);
        // backendNodeId（新字段名）绑定
        assert_eq!(
            doc.nodes.backend_dom_node_id.as_ref().unwrap().len(),
            7,
            "backendNodeId 数组应完整解析"
        );
        // 整链：增强树后端 id 可用（click/type 输入面）
        let document: GetDocumentResult = serde_json::from_value(serde_json::json!({
            "root": { "nodeId": 1, "backendNodeId": 1, "nodeType": 9, "nodeName": "#document", "attributes": [], "children": [] }
        }))
        .unwrap();
        let roots = build_enhanced_tree(&capture, &document, &[]);
        assert!(
            roots
                .iter()
                .any(|r| r.subtree_has(8, &|n| n.backend_node_id == 1)),
            "增强树应携带 backendNodeId（新字段名解析）"
        );
    }

    // =======================================================================
    // 跨域 iframe 递归（维度 13 §1.5 二期，U-4）
    // =======================================================================

    /// 帧候选筛选（纯函数）：pierce 排除 / 去重 / 深度预算 / 帧数预算 / 载荷预算。
    #[test]
    fn frame_candidate_eligible_filters() {
        let pierced: HashSet<String> = ["MAIN"].iter().map(|s| s.to_string()).collect();
        let mut visited: HashSet<String> = HashSet::new();
        let mut stats = CrossOriginStats::default();
        let budget = FrameBudget::new(64, HARD_RAW_PAYLOAD_BYTES);

        // 同源 pierce 已覆盖 → 排除（不占统计）
        assert!(!frame_candidate_eligible(
            "MAIN",
            &pierced,
            &mut visited,
            0,
            &budget,
            &mut stats
        ));
        // 合格帧 → 通过并入 visited
        assert!(frame_candidate_eligible(
            "F1",
            &pierced,
            &mut visited,
            0,
            &budget,
            &mut stats
        ));
        // 去重：已访问帧 → 排除（防环/重复子树防御）
        assert!(!frame_candidate_eligible(
            "F1",
            &pierced,
            &mut visited,
            0,
            &budget,
            &mut stats
        ));
        assert_eq!(stats.skipped_budget, 0, "pierce/去重不占预算统计");

        // 深度预算：父深度 4 → 子帧深度 5 > max_iframe_depth=4 → 截断
        assert!(!frame_candidate_eligible(
            "D5",
            &pierced,
            &mut visited,
            4,
            &budget,
            &mut stats
        ));
        assert_eq!(stats.skipped_budget, 1);
        // 父深度 3 → 子帧深度 4 = 上限内
        assert!(frame_candidate_eligible(
            "D4",
            &pierced,
            &mut visited,
            3,
            &budget,
            &mut stats
        ));

        // 帧数预算耗尽（max_iframes=64 共用）→ 截断
        let exhausted = FrameBudget::new(0, HARD_RAW_PAYLOAD_BYTES);
        assert!(!frame_candidate_eligible(
            "B0",
            &pierced,
            &mut visited,
            0,
            &exhausted,
            &mut stats
        ));
        // 载荷预算耗尽（512KB 硬护栏，T-2/46）→ 截断
        let no_payload = FrameBudget::new(64, 0);
        assert!(!frame_candidate_eligible(
            "P0",
            &pierced,
            &mut visited,
            0,
            &no_payload,
            &mut stats
        ));
        assert_eq!(stats.skipped_budget, 3);
    }

    /// 尺寸门限（§1.5：≥ 10px×10px 才进入；无法确认尺寸不进入——保守）。
    #[test]
    fn iframe_size_gate() {
        let min = Bounds {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        };
        assert!(iframe_size_qualified(Some(min)), "恰好 10px 应通过");
        let big = Bounds {
            x: 0.0,
            y: 0.0,
            width: 320.0,
            height: 240.0,
        };
        assert!(iframe_size_qualified(Some(big)));
        let narrow = Bounds {
            x: 0.0,
            y: 0.0,
            width: 9.0,
            height: 300.0,
        };
        assert!(!iframe_size_qualified(Some(narrow)), "宽 < 10px 不进入");
        let thin = Bounds {
            x: 0.0,
            y: 0.0,
            width: 300.0,
            height: 5.0,
        };
        assert!(!iframe_size_qualified(Some(thin)), "高 < 10px 不进入");
        assert!(
            !iframe_size_qualified(None),
            "无法确认尺寸 → 不进入（保守占位）"
        );
    }

    /// owner 定位辅助：src URL 兜底匹配 / bounds 查找 / `|IFRAME|` 标记。
    #[test]
    fn owner_locators_and_marker() {
        let root = EnhancedNode::element("div", 1)
            .push(
                EnhancedNode::element("iframe", 2)
                    .attr("src", "https://b.example/x")
                    .bounds(0.0, 0.0, 320.0, 240.0),
            )
            .push(EnhancedNode::element("button", 3));
        let mut roots = vec![root];

        // src URL 兜底（§1.5：getFrameOwner 失败时按 src 精确匹配）
        assert_eq!(find_owner_by_src(&roots, "https://b.example/x"), Some(2));
        assert_eq!(find_owner_by_src(&roots, "https://other.example"), None);
        // bounds 查找（尺寸门限输入）
        let b = find_node_bounds(&roots, 2).expect("owner bounds 应可查");
        assert!(b.width > 300.0 && b.height > 200.0);
        assert!(find_node_bounds(&roots, 999).is_none());
        // 标记（递归成功与占位两路共用；打点后序列化呈现 |IFRAME|）
        assert!(mark_owner_iframe(&mut roots, 2), "命中 owner 应打标记");
        assert_eq!(roots[0].children[0].frame_marker, Some(FrameMarker::Iframe));
        assert!(!mark_owner_iframe(&mut roots, 999), "未命中不误标");
        // 标记不影响子树结构
        assert_eq!(roots[0].children.len(), 2);
    }

    /// 跨域合并的序列化面：子帧根树独立呈现 + `|IFRAME|` 标记 + 索引不碰撞
    /// （跨会话 backendNodeId 复用 → 合成索引兜底，模块注释「索引协调选择」）。
    #[test]
    fn cross_frame_merge_serialization_indices_unique() {
        // 主树：iframe owner(101) + 按钮(202)；子帧树：按钮(202)——跨会话 id 复用
        let main_root = EnhancedNode::element("#document", 1)
            .push(
                EnhancedNode::element("iframe", 101)
                    .attr("src", "https://b.example/embed")
                    .bounds(0.0, 0.0, 320.0, 240.0),
            )
            .push(
                EnhancedNode::element("button", 202)
                    .push(EnhancedNode::text_node("主按钮", 203))
                    .bounds(10.0, 10.0, 120.0, 36.0),
            );
        let frame_root = EnhancedNode::element("#document", 1001).push(
            EnhancedNode::element("button", 202)
                .push(EnhancedNode::text_node("帧按钮", 1002))
                .bounds(0.0, 0.0, 100.0, 30.0),
        );
        let mut roots = vec![main_root];
        // 模拟递归路径：owner 定位后打标记 + 子帧根树并入根森林
        assert!(mark_owner_iframe(&mut roots, 101));
        roots.push(frame_root);

        let budgets = BudgetConfig::active().with_cross_origin_iframes(true);
        let out = build_and_serialize(
            &roots,
            &SerializeOptions::new(&budgets, "S1", &HashSet::new()),
        );
        // |IFRAME| 标记行（src 属性经白名单序列化）
        assert!(
            out.text
                .contains("|IFRAME|<iframe src=https://b.example/embed"),
            "iframe 占位/标记行应呈现：{}",
            out.text
        );
        // 两个按钮均入树且索引互不相同（碰撞 → 合成索引）
        assert!(
            out.text.contains("<button>主按钮</button>"),
            "主树按钮应入树"
        );
        assert!(
            out.text.contains("<button>帧按钮</button>"),
            "子帧按钮应入树（独立根树）"
        );
        let mut indices: Vec<u32> = Vec::new();
        for line in out.text.lines() {
            if let Some(rest) = line.split('[').nth(1) {
                if let Some(close) = rest.find(']') {
                    if let Ok(n) = rest[..close].parse::<u32>() {
                        indices.push(n);
                    }
                }
            }
        }
        assert_eq!(indices.len(), 2, "两个按钮共 2 个索引：{indices:?}");
        let unique: HashSet<u32> = indices.iter().copied().collect();
        assert_eq!(
            unique.len(),
            indices.len(),
            "跨会话 id 复用不得产生索引碰撞：{indices:?}"
        );
        assert!(
            unique.contains(&202),
            "默认索引 = backendNodeId：{indices:?}"
        );
        // 合成索引：从简化树内全部 backendNodeId 的 max+1 起——文本节点被元素
        // 行吸收（inline_text）不进简化树，树内 id 集 = {1,101,202,1001} →
        // max=1001 → 子帧按钮（跨会话复用 202）合成索引 = 1002
        assert!(
            indices.contains(&1002),
            "跨会话 id 复用应分配合成索引：{indices:?}"
        );
        // selector_map 两条目（执行面跨帧会话归属为遗留交接项，此处仅断言映射存在）
        assert_eq!(out.selector_map.len(), 2);
        assert!(out.selector_map.values().all(|r| r.backend_node_id == 202));
    }

    /// 跨域递归开启（配置位 true）：mock CDP 全链路——帧树 → owner 定位 →
    /// 尺寸门限 → attach → 子帧采集 → 子根树并入 → detach；断言 iframe
    /// 标记、子文档根、预算/会话统计与索引不碰撞。
    #[tokio::test]
    async fn collect_cross_origin_recursion_enabled() {
        let mut mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        // 帧树（MAIN 嵌跨域 F1，无孙帧——深度预算/去重路径由纯函数测试覆盖）
        mock.set_auto_reply(
            crate::cdp::domains::names::PAGE_GET_FRAME_TREE,
            MockReply::Ok(json!({
                "frameTree": {
                    "frame": { "id": "MAIN", "url": "https://a.example", "mimeType": "text/html" },
                    "childFrames": [{
                        "frame": { "id": "F1", "url": "https://b.example/embed", "parentId": "MAIN", "mimeType": "text/html" },
                        "childFrames": []
                    }]
                }
            })),
        );
        // owner 定位：DOM.getFrameOwner(F1) → 主树 iframe(101)
        mock.set_auto_reply(
            crate::cdp::domains::names::DOM_GET_FRAME_OWNER,
            MockReply::Ok(json!({ "backendNodeId": 101, "nodeId": 3 })),
        );
        // 其余采集通道自动应答
        mock.set_auto_reply(
            crate::cdp::domains::names::DOM_GET_DOCUMENT,
            MockReply::Ok(json!({ "root": { "nodeId": 1, "backendNodeId": 1, "nodeType": 9, "nodeName": "#document", "attributes": [], "children": [] } })),
        );
        mock.set_auto_reply(
            crate::cdp::domains::names::PAGE_GET_LAYOUT_METRICS,
            MockReply::Ok(json!({
                "layoutViewport": { "pageX": 0.0, "pageY": 0.0, "clientWidth": 1280.0, "clientHeight": 800.0, "scale": 1.0 },
                "visualViewport": { "offsetX": 0.0, "offsetY": 0.0, "pageX": 0.0, "pageY": 0.0, "clientWidth": 1280.0, "clientHeight": 800.0, "scale": 1.0 }
            })),
        );
        mock.set_auto_reply(
            crate::cdp::domains::names::ACCESSIBILITY_GET_FULL_AX_TREE,
            MockReply::Ok(json!({ "nodes": [] })),
        );
        // captureSnapshot 手工应答（主/帧会话内容不同，按到达顺序两阶段应答）
        let session = connect_mock(&mock, "/devtools/browser/xframe-on").await;
        let collector = CdpCollector::new(
            session.clone(),
            BudgetConfig::active().with_cross_origin_iframes(true),
        );
        let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
        drive_capture_snapshot(&mut mock, main_capture_fixture()).await;
        drive_capture_snapshot(&mut mock, frame_capture_fixture()).await;
        let collected = collect_task
            .await
            .expect("采集任务应完成")
            .expect("采集应成功");
        session.shutdown().await;

        // —— 统计：1 帧递归 + 1 attach + 1 detach，无截断无失败 ——
        assert_eq!(
            collected.cross_origin,
            CrossOriginStats {
                frames_collected: 1,
                sessions_attached: 1,
                sessions_detached: 1,
                ..CrossOriginStats::default()
            },
            "跨域递归统计：{:#?}",
            collected.cross_origin
        );

        // —— 主树：iframe owner 打 |IFRAME| 标记（src 属性白名单呈现）——
        let main_root = collected
            .roots
            .iter()
            .find(|r| r.backend_node_id == 1)
            .expect("主文档根应存在");
        let owner = find_node_by_id(std::slice::from_ref(main_root), 101)
            .expect("iframe owner 应保留在树中");
        assert_eq!(owner.frame_marker, Some(FrameMarker::Iframe));
        assert_eq!(owner.get_attr("src"), Some("https://b.example/embed"));

        // —— 子文档独立根树（frameId=F1 内容并入根森林）——
        let frame_root = collected
            .roots
            .iter()
            .find(|r| r.backend_node_id == 1001)
            .expect("子帧文档根应并入");
        assert!(
            find_node_by_id(std::slice::from_ref(frame_root), 202).is_some(),
            "子帧按钮应入树"
        );

        // —— 序列化面：|IFRAME| 标记 + 索引唯一（跨会话 backendNodeId 复用
        //    ——主/帧按钮同 202——由合成索引消解，模块注释「索引协调选择」）——
        let budgets = BudgetConfig::active().with_cross_origin_iframes(true);
        let out = build_and_serialize(
            &collected.roots,
            &SerializeOptions::new(&budgets, "S1", &HashSet::new()),
        );
        assert!(
            out.text
                .contains("|IFRAME|<iframe src=https://b.example/embed"),
            "序列化应呈现 iframe 占位/标记：{}",
            out.text
        );
        let mut indices: Vec<u32> = Vec::new();
        for line in out.text.lines() {
            if let Some(rest) = line.split('[').nth(1) {
                if let Some(close) = rest.find(']') {
                    if let Ok(n) = rest[..close].parse::<u32>() {
                        indices.push(n);
                    }
                }
            }
        }
        assert_eq!(indices.len(), 2, "主/帧两个按钮各一个索引：{indices:?}");
        let unique: HashSet<u32> = indices.iter().copied().collect();
        assert_eq!(unique.len(), indices.len(), "索引不得碰撞：{indices:?}");
    }

    /// 跨域递归关闭（配置位默认 false——一期行为）：不取帧树、不建帧会话、
    /// 子帧内容不进树、iframe 不打标记；统计全零。
    #[tokio::test]
    async fn collect_cross_origin_recursion_disabled_default() {
        let mut mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        mock.set_auto_reply(
            crate::cdp::domains::names::DOM_GET_DOCUMENT,
            MockReply::Ok(json!({ "root": { "nodeId": 1, "backendNodeId": 1, "nodeType": 9, "nodeName": "#document", "attributes": [], "children": [] } })),
        );
        mock.set_auto_reply(
            crate::cdp::domains::names::PAGE_GET_LAYOUT_METRICS,
            MockReply::Ok(json!({
                "layoutViewport": { "pageX": 0.0, "pageY": 0.0, "clientWidth": 1280.0, "clientHeight": 800.0, "scale": 1.0 },
                "visualViewport": { "offsetX": 0.0, "offsetY": 0.0, "pageX": 0.0, "pageY": 0.0, "clientWidth": 1280.0, "clientHeight": 800.0, "scale": 1.0 }
            })),
        );
        mock.set_auto_reply(
            crate::cdp::domains::names::ACCESSIBILITY_GET_FULL_AX_TREE,
            MockReply::Ok(json!({ "nodes": [] })),
        );
        // 帧树/owner 应答**故意注册**（负向对照）：若配置位被破坏为恒开启，
        // 递归路径将真实执行 → 下述「无标记/无子帧/统计全零」断言即失败；
        // 配置位正确时这些命令根本不会发出（无触网、无挂起）。
        mock.set_auto_reply(
            crate::cdp::domains::names::PAGE_GET_FRAME_TREE,
            MockReply::Ok(json!({
                "frameTree": {
                    "frame": { "id": "MAIN", "url": "https://a.example", "mimeType": "text/html" },
                    "childFrames": [{
                        "frame": { "id": "F1", "url": "https://b.example/embed", "parentId": "MAIN", "mimeType": "text/html" },
                        "childFrames": []
                    }]
                }
            })),
        );
        mock.set_auto_reply(
            crate::cdp::domains::names::DOM_GET_FRAME_OWNER,
            MockReply::Ok(json!({ "backendNodeId": 101, "nodeId": 3 })),
        );

        let session = connect_mock(&mock, "/devtools/browser/xframe-off").await;
        let collector = CdpCollector::new(session.clone(), BudgetConfig::active());
        let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
        drive_capture_snapshot(&mut mock, main_capture_fixture()).await;
        let collected = collect_task
            .await
            .expect("采集任务应完成")
            .expect("采集应成功");
        session.shutdown().await;

        // 一期行为：仅主文档根树；子帧内容不进入；统计全零；但 iframe 元素
        // 恒打 |IFRAME| 占位标记（13 §1.5/§3.2——占位是一期语义，与递归开关
        // 无关；关闭态不打标记的旧断言与文档冲突，2026-08-12 修正）
        assert_eq!(collected.roots.len(), 1, "关闭态仅主文档根树");
        assert!(
            find_node_by_id(&collected.roots, 1001).is_none(),
            "子帧内容不得入树"
        );
        let owner = find_node_by_id(&collected.roots, 101).expect("iframe 元素仍在树中");
        assert_eq!(
            owner.frame_marker,
            Some(FrameMarker::Iframe),
            "iframe 元素恒打 |IFRAME| 占位标记（一期占位语义，不依赖递归开关）"
        );
        // 序列化面闭环：占位标记行（src 属性经白名单呈现）
        let out = build_and_serialize(
            &collected.roots,
            &SerializeOptions::new(&BudgetConfig::active(), "S1", &HashSet::new()),
        );
        assert!(
            out.text
                .contains("|IFRAME|<iframe src=https://b.example/embed"),
            "关闭态也应呈现 |IFRAME| 占位：{}",
            out.text
        );
        assert_eq!(collected.cross_origin, CrossOriginStats::default());
    }

    // =======================================================================
    // DOM.getDocument 性能护栏（depth 受限 + 预算联动降级，T-2 复核轮）
    // =======================================================================

    /// 巨大结构通道应答：attributes 塞入 12000 条长属性（模拟全深度序列化
    /// 响应，单通道体积 > 150KB 预算余量）。
    fn huge_document_fixture() -> Value {
        let attrs: Vec<String> = (0..12000)
            .map(|i| format!("data-attr-{i}={}", "x".repeat(20)))
            .collect();
        json!({ "root": { "nodeId": 1, "attributes": attrs } })
    }

    /// 大载荷快照应答：字符串池塞入 count 条 fill 字符串（膨胀主通道体积）。
    fn big_snapshot_fixture(count: usize, fill: &str) -> Value {
        let mut strings = vec![String::new()];
        for i in 0..count {
            strings.push(format!("{fill}-{i}"));
        }
        json!({
            "strings": strings,
            "documents": [{
                "documentURL": 1,
                "title": 0,
                "nodes": {
                    "parentIndex": [-1],
                    "nodeType": [9],
                    "nodeName": [0],
                    "nodeValue": [-1],
                    "backendDOMNodeId": [1],
                    "attributes": [[]],
                    "childNodeIndexes": [-1]
                },
                "layout": { "nodeIndex": [], "bounds": [] }
            }]
        })
    }

    /// 主采集四路并行非关键通道的自动应答（布局/AX）。
    fn fill_noncritical_auto_replies(mock: &MockServer) {
        mock.set_auto_reply(
            crate::cdp::domains::names::PAGE_GET_LAYOUT_METRICS,
            MockReply::Ok(json!({
                "layoutViewport": { "pageX": 0.0, "pageY": 0.0, "clientWidth": 1280.0, "clientHeight": 800.0, "scale": 1.0 },
                "visualViewport": { "offsetX": 0.0, "offsetY": 0.0, "pageX": 0.0, "pageY": 0.0, "clientWidth": 1280.0, "clientHeight": 800.0, "scale": 1.0 }
            })),
        );
        mock.set_auto_reply(
            crate::cdp::domains::names::ACCESSIBILITY_GET_FULL_AX_TREE,
            MockReply::Ok(json!({ "nodes": [] })),
        );
    }

    /// 性能修复：DOM.getDocument 深度受限（GET_DOCUMENT_DEPTH=15 而非 -1
    /// 全深度）——捕获实际发出的命令参数断言（防回归为全深度序列化，
    /// bench 实测中页面全深度 getDocument 215KB ≈ DOMSnapshot 85KB 的 2.5 倍）。
    #[tokio::test]
    async fn get_document_depth_bounded_not_full() {
        let mut mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        fill_noncritical_auto_replies(&mock);
        let session = connect_mock(&mock, "/devtools/browser/depth-bounded").await;
        let collector = CdpCollector::new(session.clone(), BudgetConfig::active());
        let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
        drive_capture_snapshot(&mut mock, main_capture_fixture()).await;
        // 捕获实际发出的 getDocument 命令（restore 流程命令已被自动应答跳过）
        let cmd = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            mock.expect_command(crate::cdp::domains::names::DOM_GET_DOCUMENT),
        )
        .await
        .expect("等待 DOM.getDocument 命令超时");
        assert_eq!(
            cmd["params"]["depth"], GET_DOCUMENT_DEPTH,
            "结构通道深度应受限而非全深度：{cmd}"
        );
        assert_eq!(cmd["params"]["pierce"], true, "pierce 语义保持：{cmd}");
        mock.reply(
            cmd["id"].as_u64().expect("命令 id"),
            json!({ "root": { "nodeId": 1 } }),
        );
        let collected = collect_task
            .await
            .expect("采集任务应完成")
            .expect("采集应成功");
        session.shutdown().await;
        assert_eq!(collected.roots.len(), 1, "主文档根树不受深度限制影响");
    }

    /// payload 分解（任务书断言面）：中页面场景——主通道小、结构通道巨大
    /// （合计 >150KB）→ **采集成功不失败**，结构通道降级丢弃，raw_payload_bytes
    /// 仅计主通道（预算内）；主树结构完整不丢。
    #[tokio::test]
    async fn payload_decomposition_degrades_get_document_only() {
        let mut mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        fill_noncritical_auto_replies(&mock);
        mock.set_auto_reply(
            crate::cdp::domains::names::DOM_GET_DOCUMENT,
            MockReply::Ok(huge_document_fixture()),
        );
        let session = connect_mock(&mock, "/devtools/browser/payload-degrade").await;
        let collector = CdpCollector::new(session.clone(), BudgetConfig::active());
        let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
        drive_capture_snapshot(&mut mock, main_capture_fixture()).await;
        let collected = collect_task
            .await
            .expect("采集任务应完成")
            .expect("结构通道超预算应降级而非失败");
        session.shutdown().await;

        // 分解断言：payload = 主通道字节（结构通道丢弃），≤ 150KB 预算
        let snapshot_bytes = main_capture_fixture().to_string().len();
        assert_eq!(
            collected.raw_payload_bytes, snapshot_bytes,
            "降级后 payload 应仅计 DOMSnapshot 主通道"
        );
        assert!(
            collected.raw_payload_bytes <= MAX_RAW_PAYLOAD_BYTES,
            "降级后总载荷应受控：{}B",
            collected.raw_payload_bytes
        );
        // 主树完整（降级不丢结构）：iframe owner 与按钮均在
        assert_eq!(collected.roots.len(), 1, "降级不产生额外根树");
        let main_root = &collected.roots[0];
        assert!(find_node_by_id(std::slice::from_ref(main_root), 101).is_some());
        assert!(find_node_by_id(std::slice::from_ref(main_root), 202).is_some());
    }

    /// 主通道硬错误语义保持：DOMSnapshot 自身超 512KB 硬护栏 → PayloadOverflow
    /// （主数据缺失无法降级，与结构通道降级严格区分；46 复核后硬护栏从
    /// 150KB 提升至 512KB——150KB 仅作常规合计降级触发阈值）。
    #[tokio::test]
    async fn snapshot_over_budget_remains_hard_error() {
        let mut mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        fill_noncritical_auto_replies(&mock);
        mock.set_auto_reply(
            crate::cdp::domains::names::DOM_GET_DOCUMENT,
            MockReply::Ok(json!({ "root": { "nodeId": 1 } })),
        );
        let session = connect_mock(&mock, "/devtools/browser/snapshot-overflow").await;
        let collector = CdpCollector::new(session.clone(), BudgetConfig::active());
        let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
        // 主通道 3000 条长字符串（200 字符）≈ 618KB > 512KB 硬护栏
        drive_capture_snapshot(&mut mock, big_snapshot_fixture(3000, &"y".repeat(200))).await;
        let res = collect_task.await.expect("采集任务应完成");
        session.shutdown().await;
        assert!(
            matches!(res, Err(SnapshotError::PayloadOverflow { .. })),
            "主通道超硬护栏应为硬错误：{res:?}"
        );
    }

    /// 46 复核分层语义：主通道超 150KB 常规预算（但低于 512KB 硬护栏）→
    /// **采集成功不失败**——结构通道降级丢弃，payload 仅计主通道；模型输入面
    /// 32KB 截断树不受影响（列表页形态 300 条目 326KB 的同构场景）。
    #[tokio::test]
    async fn snapshot_mid_size_succeeds_below_hard_budget() {
        let mut mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        fill_noncritical_auto_replies(&mock);
        mock.set_auto_reply(
            crate::cdp::domains::names::DOM_GET_DOCUMENT,
            MockReply::Ok(json!({ "root": { "nodeId": 1 } })),
        );
        let session = connect_mock(&mock, "/devtools/browser/snapshot-mid-size").await;
        let collector = CdpCollector::new(session.clone(), BudgetConfig::active());
        let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
        // 主通道 3000 条 100 字符字符串 ≈ 330KB：> 150KB 常规预算但 < 512KB 硬护栏
        let mid = big_snapshot_fixture(3000, &"y".repeat(100));
        let mid_bytes = mid.to_string().len();
        assert!(
            mid_bytes > MAX_RAW_PAYLOAD_BYTES && mid_bytes < HARD_RAW_PAYLOAD_BYTES,
            "夹具应落在双层预算之间：{mid_bytes}B"
        );
        drive_capture_snapshot(&mut mock, mid).await;
        let collected = collect_task
            .await
            .expect("采集任务应完成")
            .expect("中量级主通道应成功（硬护栏内）");
        session.shutdown().await;
        assert_eq!(
            collected.raw_payload_bytes, mid_bytes,
            "payload 应计主通道全量字节（硬护栏内不截断）"
        );
        assert!(collected.raw_payload_bytes <= HARD_RAW_PAYLOAD_BYTES);
        assert_eq!(collected.roots.len(), 1, "主树完整");
    }

    /// 46 复核默认采集最小面：captureSnapshot 命令参数 includeDOMRects/
    /// includePaintOrder 默认 false（两路数据当前实现不消费，源级削减载荷）。
    #[tokio::test]
    async fn capture_payload_minimal_by_default() {
        let mut mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        fill_noncritical_auto_replies(&mock);
        mock.set_auto_reply(
            crate::cdp::domains::names::DOM_GET_DOCUMENT,
            MockReply::Ok(json!({ "root": { "nodeId": 1 } })),
        );
        let session = connect_mock(&mock, "/devtools/browser/payload-minimal").await;
        let collector = CdpCollector::new(session.clone(), BudgetConfig::active());
        let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
        // 捕获实际发出的 captureSnapshot 命令参数（防回归为全量载荷面）
        let cmd = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            mock.expect_command("DOMSnapshot.captureSnapshot"),
        )
        .await
        .expect("等待 captureSnapshot 命令超时");
        assert_eq!(
            cmd["params"]["includeDOMRects"], false,
            "默认最小面不应请求 DOMRects：{cmd}"
        );
        assert_eq!(
            cmd["params"]["includePaintOrder"], false,
            "默认最小面不应请求 paintOrders：{cmd}"
        );
        mock.reply(
            cmd["id"].as_u64().expect("命令 id 缺失"),
            main_capture_fixture(),
        );
        let collected = collect_task
            .await
            .expect("采集任务应完成")
            .expect("最小面采集应成功");
        session.shutdown().await;
        assert_eq!(collected.roots.len(), 1, "最小面不影响主树构建");
    }

    /// 46 复核完整载荷面 opt-in：`with_full_payload(true)` 后 captureSnapshot
    /// 命令参数 includeDOMRects/includePaintOrder 为 true（绘制序过滤接线
    /// 或 DOMRects 消费方接入时的开关面）。
    #[tokio::test]
    async fn capture_full_payload_opt_in() {
        let mut mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        fill_noncritical_auto_replies(&mock);
        mock.set_auto_reply(
            crate::cdp::domains::names::DOM_GET_DOCUMENT,
            MockReply::Ok(json!({ "root": { "nodeId": 1 } })),
        );
        let session = connect_mock(&mock, "/devtools/browser/payload-full").await;
        let collector = CdpCollector::new(
            session.clone(),
            BudgetConfig::active().with_full_payload(true),
        );
        let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
        let cmd = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            mock.expect_command("DOMSnapshot.captureSnapshot"),
        )
        .await
        .expect("等待 captureSnapshot 命令超时");
        assert_eq!(
            cmd["params"]["includeDOMRects"], true,
            "完整载荷面应请求 DOMRects：{cmd}"
        );
        assert_eq!(
            cmd["params"]["includePaintOrder"], true,
            "完整载荷面应请求 paintOrders：{cmd}"
        );
        mock.reply(
            cmd["id"].as_u64().expect("命令 id 缺失"),
            main_capture_fixture(),
        );
        let collected = collect_task
            .await
            .expect("采集任务应完成")
            .expect("完整载荷面采集应成功");
        session.shutdown().await;
        assert_eq!(collected.roots.len(), 1);
    }

    /// 跨域子帧结构通道超预算：帧级 getDocument 降级（仅 DOMSnapshot 入树），
    /// 子帧根树仍并入 + 统计正常——递归采集不被结构通道体积拖垮。
    #[tokio::test]
    async fn cross_frame_get_document_degrades_keeps_frame() {
        let mut mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        fill_noncritical_auto_replies(&mock);
        mock.set_auto_reply(
            crate::cdp::domains::names::PAGE_GET_FRAME_TREE,
            MockReply::Ok(json!({
                "frameTree": {
                    "frame": { "id": "MAIN", "url": "https://a.example", "mimeType": "text/html" },
                    "childFrames": [{
                        "frame": { "id": "F1", "url": "https://b.example/embed", "parentId": "MAIN", "mimeType": "text/html" },
                        "childFrames": []
                    }]
                }
            })),
        );
        mock.set_auto_reply(
            crate::cdp::domains::names::DOM_GET_FRAME_OWNER,
            MockReply::Ok(json!({ "backendNodeId": 101, "nodeId": 3 })),
        );
        // 结构通道巨大应答（主/帧会话共用 auto_reply 表 → 两级均降级）
        mock.set_auto_reply(
            crate::cdp::domains::names::DOM_GET_DOCUMENT,
            MockReply::Ok(huge_document_fixture()),
        );
        let session = connect_mock(&mock, "/devtools/browser/xframe-degrade").await;
        let collector = CdpCollector::new(
            session.clone(),
            BudgetConfig::active().with_cross_origin_iframes(true),
        );
        let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
        drive_capture_snapshot(&mut mock, main_capture_fixture()).await;
        drive_capture_snapshot(&mut mock, frame_capture_fixture()).await;
        let collected = collect_task
            .await
            .expect("采集任务应完成")
            .expect("子帧结构通道超预算应降级而非失败");
        session.shutdown().await;

        // 子帧内容仍入树（DOMSnapshot 主通道保留）
        assert_eq!(
            collected.cross_origin.frames_collected, 1,
            "子帧采集不应被结构通道体积拖垮：{:#?}",
            collected.cross_origin
        );
        assert!(
            collected.roots.iter().any(|r| r.backend_node_id == 1001),
            "子帧根树应并入（降级仅丢结构通道）"
        );
        // payload = 主通道字节，预算内
        assert_eq!(
            collected.raw_payload_bytes,
            main_capture_fixture().to_string().len()
        );
        assert!(collected.raw_payload_bytes <= MAX_RAW_PAYLOAD_BYTES);
    }
}
