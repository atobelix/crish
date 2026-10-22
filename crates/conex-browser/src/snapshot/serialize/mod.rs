//! 简化树 + 文本序列化 + 索引分配 + 预算截断（维度 13 §3）
//!
//! 构建步骤（§3.1，步骤顺序即预算生效点）：
//! 1. **建树**：DFS 遍历增强树，跳过装饰节点；开放 shadow 以 `|SHADOW(open)|`
//!    进入；closed shadow 内 AX 检出但无 backendNodeId 的元素降级 `|UNOPERABLE|`
//!    （T-5，不分配索引）；**预算 1（depth）与预算 2（tree_nodes）在此步生效**
//! 2. **容器折叠**：传播型容器（a/button/div[role=button|combobox] 等）完全包含
//!    的交互后代折叠进容器行（防「按钮里套按钮」噪音；含显式 onclick/有效
//!    aria-label/独立交互 role 的后代不折叠，防 stopPropagation 场景）
//! 3. **绘制序过滤**（可开关）：按 paintOrders 从后向前维护不相交矩形并集，
//!    被完全覆盖且背景不透明的节点标记 covered（保留文本，不给交互索引）
//! 4. **索引分配**：可交互且可见节点分配模型索引（默认 = backendNodeId；
//!    合成索引从树中全部 backendNodeId 的 max+1 起递增，避开碰撞）；盲区
//!    占位/不可操作/iframe 占位（U-4）一律不分配
//! 5. **序列化**：紧凑文本树；**预算 3（text）与预算 4（selectors）在此步生效**，
//!    另加 32KB 输出预算（T-2）
//!
//! 文本格式（§3.2）：缩进每层 2 空格；`[N]` 模型索引；`*` 新增标记；
//! `|scroll|` 可滚动；`|IFRAME|`/`|SHADOW(open|closed)|`；`|CANVAS|/|VIDEO|/|IMG|`
//! 盲区占位（T-16；占位行保留白名单描述属性——上下文检测呈现
//! aria-label/title/role/src 等，D4 不误伤，与 `|IMG|` 对齐，13 §3.6）；
//! `|UNOPERABLE|` 前缀（T-5）；属性 `key=value`（值含空格加引号）。
//! 元素内仅含文本子节点时文本并入元素行（`<a>注册</a>`）；混排时文本子节点
//! 以裸文本行呈现（§3.2 示例两种形态均支持）。

use crate::snapshot::budget::{BudgetConfig, TruncationInfo, TruncationKind};
use crate::snapshot::collect::{Bounds, EnhancedNode, FrameMarker};
use crate::snapshot::interactive::DecisionCache;
use std::collections::{HashMap, HashSet};

mod attrs;
mod build;
mod index;
mod paint;
mod probe;
mod render;
mod state;

use build::build_subtree;
use index::{assign_indices, collect_ids, collect_selector_map};
use paint::mark_covered;
use render::render_node;
use state::BuildState;

/// 序列化属性白名单（§3.2：防体积爆炸；`format`/`options` 为合成属性，
/// `src` 为 iframe 占位行呈现所需，`alt` 为图片盲区占位行文本描述（D4 不误伤））。
pub const ATTR_WHITELIST: &[&str] = &[
    "id",
    "name",
    "type",
    "placeholder",
    "value",
    "aria-label",
    "title",
    "role",
    "href",
    "src",
    "alt",
    "required",
    "disabled",
    "checked",
    "selected",
    "format",
    "options",
];

/// 传播型容器标签（§3.1 步骤 2 容器折叠）。
pub const PROPAGATION_CONTAINER_TAGS: &[&str] = &["a", "button", "div", "span"];

/// 跳过标签（建树步骤：head 等装饰/非内容区）。
pub const SKIP_TAGS: &[&str] = &["style", "script", "head", "meta", "link", "title"];

/// void 元素（序列化自闭合 `/>`）。
pub const VOID_TAGS: &[&str] = &[
    "input", "br", "img", "hr", "link", "meta", "area", "base", "col", "embed", "source", "track",
    "wbr",
];

/// 日期/时间输入 → ISO 格式提示（§3.2：HTML5 输入必须 ISO 格式，模型最易错点）。
pub const DATE_FORMAT_HINTS: &[(&str, &str)] = &[
    ("date", "YYYY-MM-DD"),
    ("time", "HH:MM"),
    ("datetime-local", "YYYY-MM-DDTHH:MM"),
    ("month", "YYYY-MM"),
    ("week", "YYYY-Www"),
];

/// select options 展开前 N 项（§3.2）。
pub const SELECT_OPTIONS_PREVIEW: usize = 4;

/// 容器折叠包含阈值（containment ≥ 99%）。
pub const FOLD_CONTAINMENT: f64 = 0.99;

/// 绘制序矩形并集上限（§3.1 步骤 3：超限保守放行）。
pub const RECT_UNION_CAP: usize = 5000;

/// 已知盲区种类（§3.6，T-16；ShadowClosedUnoperable 为 T-5 降级标记）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlindZoneKind {
    Canvas,
    Video,
    Image,
    ShadowClosedUnoperable,
}

/// 简化树节点（§3.1；`bounds`/`covered` 为内部扩展字段：容器折叠与绘制序过滤用）。
#[derive(Debug, Clone)]
pub struct SimplifiedNode {
    pub backend_node_id: i64,
    pub tag: Option<String>,
    /// 已脱敏、已裁剪（仅保留白名单属性）
    pub attributes: Vec<(String, String)>,
    /// 已截断文本（元素行内联文本/文本节点内容）
    pub text: Option<String>,
    /// 可交互元素 → 模型索引（预算 4 截断后无索引）
    pub selector_index: Option<u32>,
    pub is_interactive: bool,
    /// 与上一轮对比新增（§3.5；仅增量视角下有效）
    pub is_new: bool,
    pub is_scrollable: bool,
    pub scroll_info: Option<String>,
    pub frame_marker: Option<FrameMarker>,
    pub blind_zone: Option<BlindZoneKind>,
    pub children: Vec<SimplifiedNode>,
    /// 折叠提示（预算/视口外）：`... (N more ...)` 行
    pub hidden_hint: Option<String>,
    /// 被绘制序遮盖（保留文本行但无索引；§3.1 步骤 3）
    pub covered: bool,
    /// 布局 bounds（内部扩展：容器折叠 containment 判定）
    pub bounds: Option<Bounds>,
}

/// 模型索引 → 执行定位引用（§3.3：backendNodeId 为主；frame_target_id 二期启用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeRef {
    pub backend_node_id: i64,
    pub session_id: String,
    /// 二期跨域 iframe 内元素需带 frame targetId（U-4；一期恒 None）
    pub frame_target_id: Option<String>,
}

/// 序列化选项。
pub struct SerializeOptions<'a> {
    pub budgets: &'a BudgetConfig,
    pub session_id: &'a str,
    /// 上一轮 selector_map 的 backendNodeId 集合（§3.5 增量匹配）
    pub previous_selector_ids: &'a HashSet<i64>,
    /// 增量视角开关：previous 为空（首拍/版本不连续）时本轮无 `*` 标记（全量视角）
    pub incremental: bool,
    /// getEventListeners 增强通道（T-4：默认关闭）
    pub listener_channel: bool,
    /// 绘制序过滤开关（§3.1 步骤 3）
    pub paint_filter: bool,
    /// 绘制序条目（按绘制序升序；backend_id + bounds）
    pub paint_orders: &'a [(i64, Bounds)],
    /// 布局视口（Some 时执行视口外折叠提示；None 跳过）
    pub viewport: Option<Bounds>,
}

impl<'a> SerializeOptions<'a> {
    pub fn new(
        budgets: &'a BudgetConfig,
        session_id: &'a str,
        previous_selector_ids: &'a HashSet<i64>,
    ) -> Self {
        SerializeOptions {
            budgets,
            session_id,
            previous_selector_ids,
            incremental: false,
            listener_channel: false,
            paint_filter: false,
            paint_orders: &[],
            viewport: None,
        }
    }

    /// 开启增量视角（`previous_selector_ids` 来自缓存前驱时调用）。
    pub fn with_incremental(mut self, on: bool) -> Self {
        self.incremental = on;
        self
    }
}

/// 序列化产物（进入 SnapshotDocument）。
pub struct SerializeOutput {
    pub text: String,
    pub selector_map: HashMap<u32, NodeRef>,
    /// 简化树节点数（截断前）
    pub element_count: usize,
    /// 已分配索引数（截断前）
    pub selector_count: usize,
    pub truncation: Option<TruncationInfo>,
    pub blind_zone: crate::snapshot::BlindZoneStats,
}

/// 主入口：增强树（根森林）→ 简化树 → 文本 + selector_map（§3.1 五步）。
pub fn build_and_serialize(roots: &[EnhancedNode], opts: &SerializeOptions) -> SerializeOutput {
    let mut state = BuildState::new(opts.budgets);
    let mut cache = DecisionCache::new();

    let mut built_roots = Vec::new();
    for root in roots {
        if state.nodes_left == 0 {
            break;
        }
        let (node, _) = build_subtree(root, 0, false, false, false, opts, &mut state, &mut cache);
        built_roots.push(node);
    }

    // —— 步骤 3：绘制序过滤（标记 covered；文本/表单控件保留）——
    if opts.paint_filter && !opts.paint_orders.is_empty() {
        mark_covered(&mut built_roots, opts.paint_orders);
    }

    // 预构建「树中全部 backendNodeId」集合（合成索引避碰撞，§3.3）
    for root in &built_roots {
        collect_ids(root, &mut state.used_ids);
    }
    let max_id = state.used_ids.iter().filter(|id| **id >= 0).max().copied();
    if let Some(m) = max_id {
        state.synthetic_next = m as u32 + 1;
    }

    // —— 步骤 4：索引分配 ——
    for root in &mut built_roots {
        assign_indices(root, &mut state);
    }

    // —— 步骤 5：序列化（预算 3/4 + 32KB 输出预算）——
    let mut out = String::new();
    for root in &built_roots {
        if state.output_left == 0 {
            break;
        }
        render_node(root, 0, &mut out, &mut state, opts.budgets.max_text_len);
    }
    if state.output_left == 0 {
        // 输出预算截断标记（32KB，T-2）
        state.note_truncation(TruncationKind::Output);
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("... (truncated by output budget)");
    }
    // 文本/索引截断登记（首因优先：已有截断主因时不覆盖）
    if state.text_truncated > 0 {
        state.note_truncation(TruncationKind::Text);
        state.dropped_nodes += state.text_truncated;
    }
    if state.selector_truncated > 0 {
        state.note_truncation(TruncationKind::Selectors);
        state.dropped_nodes += state.selector_truncated;
    }

    let blind_zone = crate::snapshot::BlindZoneStats {
        canvas: state.canvas,
        video: state.video,
        image: state.image,
        unoperable: state.unoperable,
    };
    SerializeOutput {
        text: out,
        selector_map: collect_selector_map(&built_roots, opts.session_id),
        element_count: state.element_count,
        selector_count: state.selector_count,
        truncation: state.finalize_truncation(),
        blind_zone,
    }
}

#[cfg(test)]
mod tests;
