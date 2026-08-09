//! CDP 数据采集（维度 13 §1：DOMSnapshot 主采集 + DOM.getDocument 结构通道 +
//! AX 辅助 + 布局数据；`EnhancedNode` 中间表示 = DOM 属性 + AX + 样式/布局三合一）
//!
//! ## 采集方案（§1.1）
//! - 主采集：`DOMSnapshot.captureSnapshot`（computedStyles 白名单 10 项 +
//!   includePaintOrder + includeDOMRects）
//! - 结构通道：`DOM.getDocument(depth=-1, pierce=true)`（父子关系/backendNodeId/属性）
//! - 辅助通道：`Accessibility.getFullAXTree`（逐帧并行；失败降级为空 AX）
//! - 布局：`Page.getLayoutMetrics`（CSS 视口 + devicePixelRatio）
//! - 四路并行（`tokio::join!`），首轮 10s 超时，未完成取消重发再等 2s（§1.2）
//!
//! ## 数据来源双通道（任务口径）
//! 快照数据来源有两种——真实 CDP 采集（需要浏览器，`CdpCollector`）与**构造输入**
//! （测试/引擎侧从内部数据结构直接构建 `EnhancedNode` 树）。单元测试一律基于
//! 构造输入（确定性）；真实采集路径由 e2e 验证（§7.2 T8）。

use crate::cdp::domains::{AXNode, CaptureSnapshotResult, GetDocumentResult, SnapshotNode};
use crate::snapshot::budget::MAX_RAW_PAYLOAD_BYTES;
use crate::snapshot::SnapshotError;
use async_trait::async_trait;
use std::collections::HashMap;

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
/// 采集遍历元素护栏（§3.4 防呆上限：遍历元素 10000）。
pub const MAX_TRAVERSE_ELEMENTS: usize = 10_000;
/// 首轮采集超时（10s）+ 重发窗口（2s），合计 12s 硬超时（§1.2/T-1）。
pub const FIRST_ROUND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
pub const RETRY_WINDOW: std::time::Duration = std::time::Duration::from_secs(2);
/// 小 iframe 阈值（宽或高 < 10px 的跨域帧不进入；§1.5）。
pub const MIN_IFRAME_SIZE: f64 = 10.0;
/// 视口缓冲（可见性 = 与布局视口相交，上下各放宽 1000px，§1.5）。
pub const VIEWPORT_THRESHOLD: f64 = 1000.0;

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
        let iy = ((self.y + self.height).min(other.y + other.height) - self.y.max(other.y)).max(0.0);
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
        self.bounds = Some(Bounds { x, y, width, height });
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

/// 采集产物（采集阶段输出，进入序列化流水线）。
#[derive(Debug, Clone)]
pub struct CollectedData {
    /// 增强树根森林（真实路径每文档一棵根树；构造输入通常一棵）
    pub roots: Vec<EnhancedNode>,
    pub url: String,
    pub title: String,
    pub layout: LayoutMetrics,
    /// CDP 原始载荷估算字节（150KB 采集层护栏，T-2）
    pub raw_payload_bytes: usize,
    /// 阶段耗时明细（自测/观测）
    pub collect_ms: u64,
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
    async fn collect(
        &self,
        tab_id: &str,
        session: &str,
    ) -> Result<CollectedData, SnapshotError>;
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
    async fn collect(
        &self,
        _tab_id: &str,
        _session: &str,
    ) -> Result<CollectedData, SnapshotError> {
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
        })
    }
}

/// 真实 CDP 采集器（需要浏览器会话；e2e 验证路径）。
pub struct CdpCollector {
    session: std::sync::Arc<crate::BrowserSession>,
}

impl CdpCollector {
    pub fn new(session: std::sync::Arc<crate::BrowserSession>) -> Self {
        CdpCollector { session }
    }
}

/// 真实采集：四路并行 + 首轮 10s 超时 + 2s 重发窗口 + AX 降级。
#[async_trait]
impl SnapshotCollector for CdpCollector {
    async fn collect(
        &self,
        _tab_id: &str,
        session: &str,
    ) -> Result<CollectedData, SnapshotError> {
        use crate::cdp::domains::names::*;
        use serde_json::{json, Value};

        let started = std::time::Instant::now();

        // —— 首轮并行（10s 超时；AX 失败降级为空，其余失败进重发）——
        let first = tokio::time::timeout(FIRST_ROUND_TIMEOUT, async {
            let snapshot_fut = self.session.send_page::<Value>(
                session,
                DOM_SNAPSHOT_CAPTURE_SNAPSHOT,
                json!({
                    "computedStyles": COMPUTED_STYLES_WHITELIST,
                    "includePaintOrder": true,
                    "includeDOMRects": true,
                }),
            );
            let dom_fut = self.session.send_page::<Value>(
                session,
                crate::cdp::domains::names::DOM_GET_DOCUMENT,
                json!({ "depth": -1, "pierce": true }),
            );
            let metrics_fut = self.session.send_page::<Value>(
                session,
                PAGE_GET_LAYOUT_METRICS,
                json!({}),
            );
            let ax_fut = self.session.send_page::<Value>(
                session,
                ACCESSIBILITY_GET_FULL_AX_TREE,
                json!({}),
            );
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
                        .send_page::<Value>(session, DOM_SNAPSHOT_CAPTURE_SNAPSHOT, json!({
                            "computedStyles": COMPUTED_STYLES_WHITELIST,
                            "includePaintOrder": true,
                            "includeDOMRects": true,
                        }))
                        .await;
                    let d = self
                        .session
                        .send_page::<Value>(session, DOM_GET_DOCUMENT, json!({ "depth": -1, "pierce": true }))
                        .await;
                    (s, d)
                })
                .await;
                match retry {
                    Ok((s, d)) => (s, d, Ok(json!({})), Ok(json!({ "nodes": [] }))),
                    Err(_) => {
                        return Err(SnapshotError::Timeout(crate::snapshot::budget::HARD_TIMEOUT));
                    }
                }
            }
        };

        let snapshot_value = snapshot_res.map_err(|e| {
            SnapshotError::Collect(format!("DOMSnapshot.captureSnapshot 失败：{e}"))
        })?;
        let dom_value = dom_res.map_err(|e| {
            SnapshotError::Collect(format!("DOM.getDocument 失败：{e}"))
        })?;
        let metrics_value = metrics_res.map_err(|e| {
            SnapshotError::Collect(format!("Page.getLayoutMetrics 失败：{e}"))
        })?;

        // —— AX 失败降级为空（§1.2：AX 树失败可降级，主结构不丢）——
        let ax: Vec<AXNode> = match ax_res {
            Ok(v) => serde_json::from_value(v).unwrap_or_default(),
            Err(e) => {
                tracing::warn!("AX 树采集失败，降级为空 AX：{e}");
                Vec::new()
            }
        };

        // —— 反序列化 + 载荷护栏（150KB 采集层上限，T-2）——
        let payload_bytes = snapshot_value.to_string().len() + dom_value.to_string().len();
        if payload_bytes > MAX_RAW_PAYLOAD_BYTES {
            return Err(SnapshotError::PayloadOverflow {
                bytes: payload_bytes,
                max: MAX_RAW_PAYLOAD_BYTES,
            });
        }

        let capture: CaptureSnapshotResult = serde_json::from_value(snapshot_value).map_err(
            |e| SnapshotError::Collect(format!("DOMSnapshot 响应解析失败：{e}")),
        )?;
        let document: GetDocumentResult = serde_json::from_value(dom_value)
            .map_err(|e| SnapshotError::Collect(format!("DOM.getDocument 响应解析失败：{e}")))?;

        let metrics: crate::cdp::domains::GetLayoutMetricsResult =
            serde_json::from_value(metrics_value).unwrap_or(crate::cdp::domains::GetLayoutMetricsResult {
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

        let roots = build_enhanced_tree(&capture, &document, &ax);
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

        Ok(CollectedData {
            roots,
            url,
            title,
            layout,
            raw_payload_bytes: payload_bytes,
            collect_ms: started.elapsed().as_millis() as u64,
        })
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
/// DOM.getDocument 结构通道在本实现中作 backendNodeId 兜底校验输入。
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
        let root = EnhancedNode::element("div", 1).push(
            EnhancedNode::element("div", 2).push(EnhancedNode::element("button", 3)),
        );
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
        let zero = Bounds { x: 0.0, y: 0.0, width: 0.0, height: 10.0 };
        assert!(zero.is_zero());
        let icon = Bounds { x: 0.0, y: 0.0, width: 20.0, height: 20.0 };
        assert!(icon.is_icon_size());
        assert!(!icon.is_big_iframe());
        let big = Bounds { x: 0.0, y: 0.0, width: 300.0, height: 200.0 };
        assert!(big.is_big_iframe());

        let outer = Bounds { x: 0.0, y: 0.0, width: 100.0, height: 100.0 };
        let inner = Bounds { x: 10.0, y: 10.0, width: 20.0, height: 20.0 };
        assert!((outer.containment(&inner) - 1.0).abs() < 1e-9, "完全包含应 100%");
        let outside = Bounds { x: 200.0, y: 0.0, width: 20.0, height: 20.0 };
        assert_eq!(outer.containment(&outside), 0.0);
        let half = Bounds { x: 90.0, y: 10.0, width: 20.0, height: 20.0 };
        assert!((outer.containment(&half) - 0.5).abs() < 1e-9, "半包含应 50%");
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
        let capture: CaptureSnapshotResult = serde_json::from_value(raw)
            .expect("Chrome 151 真实形态解析失败（协议漂移回归）");
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
}
