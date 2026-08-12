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
use crate::snapshot::interactive::{decide, Decision, DecisionCache, DecideCtx};
use crate::snapshot::redact;
use std::collections::{HashMap, HashSet};

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
    "input", "br", "img", "hr", "link", "meta", "area", "base", "col", "embed", "source",
    "track", "wbr",
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

/// 构建状态（预算/统计贯穿构建与序列化）。
struct BuildState {
    nodes_left: usize,
    selectors_left: usize,
    output_left: usize,
    element_count: usize,
    selector_count: usize,
    dropped_nodes: usize,
    dropped_interactive: usize,
    truncation: Option<TruncationInfo>,
    /// 树中全部 backendNodeId（合成索引碰撞避开用）
    used_ids: HashSet<i64>,
    synthetic_next: u32,
    assigned: HashSet<u32>,
    canvas: usize,
    video: usize,
    image: usize,
    unoperable: usize,
    /// 文本截断计数（预算 3）
    text_truncated: usize,
    /// 索引截断计数（预算 4）
    selector_truncated: usize,
}

impl BuildState {
    fn new(budgets: &BudgetConfig) -> Self {
        BuildState {
            nodes_left: budgets.max_tree_nodes,
            selectors_left: budgets.max_selector_indices,
            output_left: budgets.max_output_bytes,
            element_count: 0,
            selector_count: 0,
            dropped_nodes: 0,
            dropped_interactive: 0,
            truncation: None,
            used_ids: HashSet::new(),
            synthetic_next: 1,
            assigned: HashSet::new(),
            canvas: 0,
            video: 0,
            image: 0,
            unoperable: 0,
            text_truncated: 0,
            selector_truncated: 0,
        }
    }

    fn note_truncation(&mut self, kind: TruncationKind) {
        if self.truncation.is_none() {
            self.truncation = Some(TruncationInfo {
                truncated_by: kind,
                dropped_nodes: 0,
                dropped_interactive: 0,
            });
        }
    }

    fn finalize_truncation(mut self) -> Option<TruncationInfo> {
        if let Some(t) = self.truncation.as_mut() {
            t.dropped_nodes = self.dropped_nodes;
            t.dropped_interactive = self.dropped_interactive;
        }
        self.truncation
    }
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

/// 空简化节点（hint/跳过占位；不参与索引与渲染）。
fn hint_node(backend_id: i64, hidden_hint: Option<String>) -> SimplifiedNode {
    SimplifiedNode {
        backend_node_id: backend_id,
        tag: None,
        attributes: Vec::new(),
        text: None,
        selector_index: None,
        is_interactive: false,
        is_new: false,
        is_scrollable: false,
        scroll_info: None,
        frame_marker: None,
        blind_zone: None,
        children: Vec::new(),
        hidden_hint,
        covered: false,
        bounds: None,
    }
}

/// 简化树构建（步骤 1）；返回 (简化节点, 子树内是否含可交互元素)。
///
/// `ancestors_hidden`：祖先隐藏沿链传播（P3）；`closed_shadow`：closed shadow 内
/// （子元素若 AX 检出但无 backendNodeId → `|UNOPERABLE|` 降级，T-5）；
/// `in_scrollable`：祖先链可滚动（视口外折叠提示保留滚动可达元素）。
#[allow(clippy::too_many_arguments)]
fn build_subtree(
    node: &EnhancedNode,
    depth: usize,
    ancestors_hidden: bool,
    closed_shadow: bool,
    in_scrollable: bool,
    opts: &SerializeOptions,
    state: &mut BuildState,
    cache: &mut DecisionCache,
) -> (SimplifiedNode, bool) {
    // —— 预算 1：深度截断（保留被截可交互元素计数提示行）——
    if depth >= opts.budgets.max_depth && !node.is_text() {
        let interactive = count_interactive_subtree(node, opts, cache);
        state.dropped_nodes += subtree_size(node);
        state.dropped_interactive += interactive;
        state.note_truncation(TruncationKind::Depth);
        let hint = hint_node(
            node.backend_node_id,
            Some(format!("... ({interactive} more interactive elements)")),
        );
        if state.nodes_left > 0 {
            state.nodes_left -= 1;
        }
        state.element_count += 1;
        return (hint, interactive > 0);
    }

    // —— 视口外折叠（可滚动容器内元素保留，滚动可达，§2.3）——
    if !node.is_text() && !in_scrollable {
        if let Some(vp) = opts.viewport {
            let outside = node
                .bounds
                .is_some_and(|b| b.y > vp.y + vp.height + crate::snapshot::collect::VIEWPORT_THRESHOLD);
            if outside {
                let n = subtree_size(node);
                let hint = hint_node(
                    node.backend_node_id,
                    Some(format!("... ({n} more elements - scroll to reveal)")),
                );
                return (hint, false);
            }
        }
    }

    // —— 文本节点：仅保留可见且 >1 字符文本（§3.4 入树阈值）——
    if node.is_text() {
        let text = node.text.as_deref().unwrap_or("").trim();
        if text.chars().count() <= crate::snapshot::budget::TEXT_NODE_MIN_CHARS {
            return (hint_node(node.backend_node_id, None), false);
        }
        state.element_count += 1;
        return (
            SimplifiedNode {
                backend_node_id: node.backend_node_id,
                tag: None,
                attributes: Vec::new(),
                text: Some(text.to_string()),
                selector_index: None,
                is_interactive: false,
                is_new: false,
                is_scrollable: false,
                scroll_info: None,
                frame_marker: None,
                blind_zone: None,
                children: Vec::new(),
                hidden_hint: None,
                covered: false,
                bounds: None,
            },
            false,
        );
    }

    let tag = node.tag.as_deref().unwrap_or("");
    // —— 跳过装饰标签（head/script/style/meta/link/title）——
    if SKIP_TAGS.contains(&tag) {
        return (hint_node(node.backend_node_id, None), false);
    }

    // —— 预算 2：元素数截断（达到上限停止收纳子节点）——
    if state.nodes_left == 0 {
        let interactive = count_interactive_subtree(node, opts, cache);
        state.dropped_nodes += subtree_size(node);
        state.dropped_interactive += interactive;
        state.note_truncation(TruncationKind::Elements);
        return (
            hint_node(
                node.backend_node_id,
                Some(format!("... ({interactive} more interactive elements)")),
            ),
            false,
        );
    }
    state.nodes_left -= 1;
    state.element_count += 1;

    // —— 盲区登记（T-16：占位呈现、不分配索引、头部统计；检出通道 = DOM 标签，
    // 13 §3.6）——
    // canvas/WebGL：canvas 标签承载 2D 与 WebGL 渲染上下文——DOM 快照面不可观测
    // JS getContext 调用，2D/WebGL 统一按 canvas 标签检出（无独立 WebGL 元素）；
    // video：video 标签（画面内容不可读）；img：纯图片内容（img 无可操作文本，
    // void 元素）。「上下文检测」在占位行呈现面落地：白名单描述属性
    // （aria-label/title/role/src 等）随占位行呈现，模型可识别盲区元素用途，
    // 统计口径不变（canvas/video/image 计数 = 进入简化树的盲区占位元素数）。
    let blind_zone = match tag {
        "canvas" => {
            state.canvas += 1;
            Some(BlindZoneKind::Canvas)
        }
        "video" => {
            state.video += 1;
            Some(BlindZoneKind::Video)
        }
        "img" => {
            state.image += 1;
            Some(BlindZoneKind::Image)
        }
        _ => None,
    };

    // closed shadow 内 AX 检出但无 backendNodeId 的元素 → 不可操作（T-5）
    let unoperable = closed_shadow && node.backend_node_id < 0 && !node.is_text();
    if unoperable {
        state.unoperable += 1;
    }

    // —— 隐藏链/滚动链传播 ——
    let self_hidden = node.styles.is_hidden();
    let child_hidden = ancestors_hidden || self_hidden;
    let child_scrollable = in_scrollable || node.scrollable || node.styles.scroll_candidate();

    // —— 子节点构建（后序：先子后父，父判定需要子树信息）——
    // 仅含文本子节点 → 文本并入元素行；混排 → 文本子节点以裸文本行呈现
    let leaf_text_only = !node.children.iter().any(|c| !c.is_text());
    let mut children = Vec::new();
    let mut subtree_has_interactive = false;
    for (ci, child) in node.children.iter().enumerate() {
        if child.is_text() {
            continue; // 直接文本子节点由父行吸收或裸行呈现
        }
        // select 的 option 子节点不单独成行（已由 `options=` 合成属性呈现，§3.2）
        if tag == "select" && child.tag.as_deref() == Some("option") {
            continue;
        }
        // —— 预算 2：元素数上限 ——
        if state.nodes_left == 0 {
            // 本节点及后续兄弟整批折叠（保留被截可交互元素计数提示行，§3.4）
            let mut dropped = 0usize;
            let mut dropped_interactive = 0usize;
            for rest in node.children[ci..].iter().filter(|c| !c.is_text()) {
                dropped += subtree_size(rest);
                dropped_interactive += count_interactive_subtree(rest, opts, cache);
            }
            state.dropped_nodes += dropped;
            state.dropped_interactive += dropped_interactive;
            state.note_truncation(TruncationKind::Elements);
            children.push(hint_node(
                child.backend_node_id,
                Some(format!("... ({dropped_interactive} more interactive elements)")),
            ));
            break;
        }
        let (child_node, child_interactive) = build_subtree(
            child,
            depth + 1,
            child_hidden,
            closed_shadow || node.frame_marker == Some(FrameMarker::ShadowClosed),
            child_scrollable,
            opts,
            state,
            cache,
        );
        subtree_has_interactive |= child_interactive;
        if child_node.tag.is_none() {
            // hint/跳过节点：无渲染文本时丢弃，有提示行时挂载
            if child_node.hidden_hint.is_some() {
                children.push(child_node);
            }
        } else {
            children.push(child_node);
        }
    }

    // —— 直接子文本拼接（仅纯文本容器内联，§3.2 示例）——
    let inline_text: String = if leaf_text_only {
        node.children
            .iter()
            .filter(|c| c.is_text())
            .filter_map(|c| c.text.as_deref())
            .collect::<String>()
            .trim()
            .to_string()
    } else {
        // 混排：文本子节点作为裸文本行挂入 children
        for child in &node.children {
            if child.is_text() {
                let t = child.text.as_deref().unwrap_or("").trim();
                if t.chars().count() > crate::snapshot::budget::TEXT_NODE_MIN_CHARS {
                    children.push(SimplifiedNode {
                        backend_node_id: child.backend_node_id,
                        tag: None,
                        attributes: Vec::new(),
                        text: Some(t.to_string()),
                        selector_index: None,
                        is_interactive: false,
                        is_new: false,
                        is_scrollable: false,
                        scroll_info: None,
                        frame_marker: None,
                        blind_zone: None,
                        children: Vec::new(),
                        hidden_hint: None,
                        covered: false,
                        bounds: None,
                    });
                }
            }
        }
        String::new()
    };

    // —— 可交互判定（四层短路；M1/W2 探测子树信息）——
    let wrapped = wrapped_control_probe(node);
    let ctx = DecideCtx {
        tag,
        attributes: &node.attributes,
        ax: &node.ax,
        styles: &node.styles,
        bounds: node.bounds,
        has_click_listener: node.has_click_listener,
        listener_channel_enabled: opts.listener_channel,
        is_scrollable: node.scrollable || node.styles.scroll_candidate(),
        in_svg: node.in_svg,
        ancestor_hidden: ancestors_hidden,
        subtree_has_interactive,
        wrapped_control: wrapped.0,
        wrapped_by_label_for: wrapped.1,
    };
    let decision = if node.backend_node_id >= 0 {
        cache.get_or_else(opts.session_id, node.backend_node_id, || decide(&ctx))
    } else {
        // 合成负 id（closed shadow 内部）不入缓存（同 id 复用碰撞防护）
        decide(&ctx)
    };
    let is_interactive = matches!(decision, Decision::Interactive(_));

    // 属性裁剪（白名单）+ 脱敏（D1/D2）+ 合成属性（format/options）
    let attributes = render_attrs(node, tag);

    // 复合组件恒标记新增（select/日期/文件等虚拟子组件，§3.5）
    let composite = tag == "select"
        || node.get_attr("type").is_some_and(|t| {
            ["date", "time", "datetime-local", "month", "week", "file"].contains(&t)
        });
    // 盲区/iframe 占位不参与增量标记（不可索引元素无「变化聚焦」价值，防每拍噪音）
    let is_new = opts.incremental
        && blind_zone.is_none()
        && node.frame_marker != Some(FrameMarker::Iframe)
        && ((is_interactive && !opts.previous_selector_ids.contains(&node.backend_node_id))
            || composite);

    let is_scrollable = node.scrollable || node.styles.scroll_candidate();
    let mut s = SimplifiedNode {
        backend_node_id: node.backend_node_id,
        tag: Some(tag.to_string()),
        attributes,
        text: if inline_text.is_empty() {
            None
        } else {
            Some(inline_text)
        },
        selector_index: None,
        is_interactive,
        is_new,
        is_scrollable,
        scroll_info: None,
        frame_marker: node.frame_marker,
        blind_zone,
        children,
        hidden_hint: None,
        covered: false,
        bounds: node.bounds,
    };
    if unoperable {
        s.blind_zone = Some(BlindZoneKind::ShadowClosedUnoperable);
    }
    let is_interactive_final = is_interactive;

    // —— 步骤 2（构建期执行）：容器折叠 ——
    let container = is_propagation_container(tag, &node.attributes);
    if container && s.children.iter().any(|c| c.tag.is_some()) {
        let cb = s.bounds;
        let mut kept = Vec::with_capacity(s.children.len());
        for child in s.children.drain(..) {
            let foldable = child.is_interactive
                && child.blind_zone.is_none()
                && !child.covered
                && containment_ok(cb, child.bounds)
                && !has_explicit_signal(&child);
            if foldable {
                // 折叠：文本合并进容器行（后代不单独分配索引）
                if let Some(t) = child.text.clone() {
                    let merged = match s.text.take() {
                        Some(existing) => format!("{existing} {t}"),
                        None => t,
                    };
                    s.text = Some(merged);
                }
            } else {
                kept.push(child);
            }
        }
        s.children = kept;
    }

    (s, subtree_has_interactive || is_interactive_final)
}

/// 传播型容器判定（§3.1 步骤 2：a/button 无条件；div/span 需 role=button|combobox）。
fn is_propagation_container(tag: &str, attributes: &[(String, String)]) -> bool {
    if tag == "a" || tag == "button" {
        return true;
    }
    let role_match = attributes
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("role") && (v == "button" || v == "combobox"));
    (tag == "div" || tag == "span") && role_match
}

/// 包含比例判定（containment ≥ 99%）。
fn containment_ok(container: Option<Bounds>, child: Option<Bounds>) -> bool {
    match (container, child) {
        (Some(c), Some(ch)) => c.containment(&ch) >= FOLD_CONTAINMENT,
        _ => false,
    }
}

/// 显式信号防折叠（§3.1：含 onclick/有效 aria-label/独立交互 role 的后代不折叠）。
fn has_explicit_signal(node: &SimplifiedNode) -> bool {
    node.attributes.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case("onclick")
            || (k.eq_ignore_ascii_case("aria-label") && !v.is_empty())
            || (k.eq_ignore_ascii_case("role") && !v.is_empty())
    })
}

/// 属性渲染：白名单裁剪（按白名单序稳定输出）+ 脱敏 + 合成属性（format/options）。
fn render_attrs(node: &EnhancedNode, tag: &str) -> Vec<(String, String)> {
    let redacted = redact::redact_attributes(&node.attributes);
    let mut out: Vec<(String, String)> = redacted
        .into_iter()
        .filter(|(k, _)| ATTR_WHITELIST.iter().any(|w| w.eq_ignore_ascii_case(k)))
        .collect();
    // 白名单顺序稳定输出（golden 确定性）
    out.sort_by_key(|(k, _)| {
        ATTR_WHITELIST
            .iter()
            .position(|w| w.eq_ignore_ascii_case(k))
            .unwrap_or(usize::MAX)
    });
    // 合成属性：日期/时间 format 提示
    if tag == "input" {
        if let Some(t) = node.get_attr("type") {
            if let Some((_, fmt)) = DATE_FORMAT_HINTS.iter().find(|(f, _)| *f == t) {
                out.push(("format".to_string(), fmt.to_string()));
            }
        }
    }
    // 合成属性：select options 展开（前 4 项 + 省略计数）
    if tag == "select" {
        let options: Vec<String> = node
            .children
            .iter()
            .filter(|c| c.tag.as_deref() == Some("option"))
            .map(|o| o.inline_text().trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        if !options.is_empty() {
            let preview: Vec<&str> = options
                .iter()
                .take(SELECT_OPTIONS_PREVIEW)
                .map(String::as_str)
                .collect();
            let mut s = preview.join("|");
            if options.len() > SELECT_OPTIONS_PREVIEW {
                s.push_str(&format!("|...({} more)", options.len() - SELECT_OPTIONS_PREVIEW));
            }
            out.push(("options".to_string(), s));
        }
    }
    out
}

/// 文本/属性值截断（预算 3：超限追加 `…`）。
fn truncate_text(s: &str, max_len: usize, state: &mut BuildState) -> String {
    if s.chars().count() <= max_len {
        return s.to_string();
    }
    state.text_truncated += 1;
    let cut: String = s.chars().take(max_len).collect();
    format!("{cut}…")
}

/// 属性行渲染：`key=value`（值含空白加引号）。
fn render_attr_kv(k: &str, v: &str, max_len: usize, state: &mut BuildState) -> String {
    let v = truncate_text(v, max_len, state);
    if v.is_empty() {
        return k.to_string();
    }
    if v.chars().any(|c| c.is_whitespace()) {
        format!("{k}=\"{v}\"")
    } else {
        format!("{k}={v}")
    }
}

/// 绘制序过滤（步骤 3）：被完全覆盖的节点标记 covered（保留文本不给索引）。
fn mark_covered(roots: &mut [SimplifiedNode], paint_orders: &[(i64, Bounds)]) {
    // paint_orders 按绘制序升序（先画的在前）；从后向前维护不相交矩形并集
    let mut union: Vec<Bounds> = Vec::new();
    let mut covered_ids: HashSet<i64> = HashSet::new();
    for (id, b) in paint_orders.iter().rev() {
        if union.len() >= RECT_UNION_CAP {
            break; // 超限保守放行
        }
        if rect_covered(*b, &union) {
            covered_ids.insert(*id);
        }
        add_to_union(&mut union, *b);
    }
    apply_covered(roots, &covered_ids);
}

/// 矩形是否完全被并集覆盖。
fn rect_covered(b: Bounds, union: &[Bounds]) -> bool {
    union.iter().any(|u| {
        u.x <= b.x
            && u.y <= b.y
            && u.x + u.width >= b.x + b.width
            && u.y + u.height >= b.y + b.height
    })
}

/// 不相交矩形并集（相交合并）。
fn add_to_union(union: &mut Vec<Bounds>, b: Bounds) {
    if b.width <= 0.0 || b.height <= 0.0 {
        return;
    }
    if let Some(existing) = union.iter_mut().find(|u| rects_intersect(**u, b)) {
        existing.x = existing.x.min(b.x);
        existing.y = existing.y.min(b.y);
        existing.width = (existing.x + existing.width).max(b.x + b.width) - existing.x;
        existing.height = (existing.y + existing.height).max(b.y + b.height) - existing.y;
    } else {
        union.push(b);
    }
}

fn rects_intersect(a: Bounds, b: Bounds) -> bool {
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

fn apply_covered(roots: &mut [SimplifiedNode], covered: &HashSet<i64>) {
    for root in roots {
        apply_covered_node(root, covered);
    }
}

fn apply_covered_node(node: &mut SimplifiedNode, covered: &HashSet<i64>) {
    if covered.contains(&node.backend_node_id)
        && node.tag.is_some()
        && !is_form_control(node)
    {
        // 文本节点与表单控件不因遮盖而删除（弹窗/下拉遮罩下保留原文，不给索引）
        node.covered = true;
    }
    for child in &mut node.children {
        apply_covered_node(child, covered);
    }
}

/// 表单控件（遮盖过滤豁免：仅保留文本，不给交互索引）。
fn is_form_control(node: &SimplifiedNode) -> bool {
    matches!(
        node.tag.as_deref(),
        Some("input") | Some("select") | Some("textarea")
    )
}

/// 索引分配（步骤 4）：可交互且可见、非盲区/不可操作/iframe 占位 → 模型索引。
fn assign_indices(node: &mut SimplifiedNode, state: &mut BuildState) {
    let indexable = node.is_interactive
        && !node.covered
        && node.blind_zone.is_none()
        && node.frame_marker.is_none();
    if node.tag.is_some() && indexable {
        if state.selectors_left > 0 {
            state.selectors_left -= 1;
            state.selector_count += 1;
            node.selector_index = Some(next_index(node.backend_node_id, state));
        } else {
            // 预算 4：超出部分元素仍入树（无 [N] 前缀，仅文本可读）
            state.selector_truncated += 1;
            state.note_truncation(TruncationKind::Selectors);
        }
    }
    for child in &mut node.children {
        assign_indices(child, state);
    }
}

/// 索引合成（§3.3）：默认 = backendNodeId（u32 可表示且无碰撞）；
/// 否则从树中全部 id 的 max+1 起递增，避开已有 id。
fn next_index(backend_id: i64, state: &mut BuildState) -> u32 {
    if let Ok(id) = u32::try_from(backend_id) {
        if !state.assigned.contains(&id) {
            state.assigned.insert(id);
            return id;
        }
    }
    // 合成索引：从 max+1 起递增，避开全部已出现 id
    loop {
        let candidate = state.synthetic_next;
        state.synthetic_next = state.synthetic_next.saturating_add(1);
        if !state.assigned.contains(&candidate) {
            state.assigned.insert(candidate);
            return candidate;
        }
    }
}

/// 收集树中全部 backendNodeId（合成索引避碰撞）。
fn collect_ids(node: &SimplifiedNode, ids: &mut HashSet<i64>) {
    ids.insert(node.backend_node_id);
    for child in &node.children {
        collect_ids(child, ids);
    }
}

/// 收集 selector_map（模型索引 → NodeRef 绑定）。
fn collect_selector_map(roots: &[SimplifiedNode], session_id: &str) -> HashMap<u32, NodeRef> {
    let mut map = HashMap::new();
    for root in roots {
        collect_map_node(root, session_id, &mut map);
    }
    map
}

fn collect_map_node(node: &SimplifiedNode, session_id: &str, map: &mut HashMap<u32, NodeRef>) {
    if let Some(idx) = node.selector_index {
        map.insert(
            idx,
            NodeRef {
                backend_node_id: node.backend_node_id,
                session_id: session_id.to_string(),
                frame_target_id: None,
            },
        );
    }
    for child in &node.children {
        collect_map_node(child, session_id, map);
    }
}

/// 序列化单节点（步骤 5）；逐行预算/输出预算在渲染过程中扣减。
#[allow(clippy::too_many_arguments)]
fn render_node(
    node: &SimplifiedNode,
    depth: usize,
    out: &mut String,
    state: &mut BuildState,
    max_text_len: usize,
) {
    let indent = "  ".repeat(depth);

    // 折叠/截断提示行（预算 1/2/视口外）
    if let Some(hint) = node.hidden_hint.as_deref() {
        push_line(out, &format!("{indent}{hint}"), state);
        return;
    }

    // 文本节点裸文本行
    if node.tag.is_none() {
        if let Some(t) = node.text.as_deref() {
            push_line(
                out,
                &format!("{indent}{}", truncate_text(t, max_text_len, state)),
                state,
            );
        }
        return;
    }

    let tag = node.tag.as_deref().unwrap_or("");

    // 盲区占位/不可操作（无索引；占位行保留白名单描述属性——上下文检测
    // 呈现 aria-label/title/role/src 等，D4 不误伤，与 |IMG| 对齐，T-16 补齐）
    match node.blind_zone {
        Some(BlindZoneKind::Canvas) => {
            let attrs = render_attr_list(node, max_text_len, state);
            push_line(out, &format!("{indent}|CANVAS|<{tag}{attrs}>"), state);
            return;
        }
        Some(BlindZoneKind::Video) => {
            let attrs = render_attr_list(node, max_text_len, state);
            push_line(out, &format!("{indent}|VIDEO|<{tag}{attrs}>"), state);
            return;
        }
        Some(BlindZoneKind::Image) => {
            let attrs = render_attr_list(node, max_text_len, state);
            push_line(out, &format!("{indent}|IMG|<{tag}{attrs}>"), state);
            return;
        }
        Some(BlindZoneKind::ShadowClosedUnoperable) => {
            let attrs = render_attr_list(node, max_text_len, state);
            let text = node.text.as_deref().unwrap_or("");
            let line = if text.is_empty() {
                format!("{indent}|UNOPERABLE|<{tag}{attrs} />")
            } else {
                let text_part = truncate_text(text, max_text_len, state);
                format!("{indent}|UNOPERABLE|<{tag}{attrs}>{text_part}</{tag}>")
            };
            push_line(out, &line, state);
            return;
        }
        None => {}
    }

    // shadow 标记（开放/封闭 shadow root 行 + Shadow End）
    match node.frame_marker {
        Some(FrameMarker::ShadowOpen) => {
            push_line(out, &format!("{indent}|SHADOW(open)|"), state);
            for child in &node.children {
                render_node(child, depth + 1, out, state, max_text_len);
            }
            push_line(out, &format!("{}Shadow End", "  ".repeat(depth + 1)), state);
            return;
        }
        Some(FrameMarker::ShadowClosed) => {
            push_line(out, &format!("{indent}|SHADOW(closed)|"), state);
            for child in &node.children {
                render_node(child, depth + 1, out, state, max_text_len);
            }
            push_line(out, &format!("{}Shadow End", "  ".repeat(depth + 1)), state);
            return;
        }
        _ => {}
    }

    // 常规元素行
    let star = if node.is_new { "*" } else { "" };
    let idx = match node.selector_index {
        Some(i) => format!("[{i}]"),
        None => String::new(),
    };
    let iframe = if node.frame_marker == Some(FrameMarker::Iframe) {
        "|IFRAME|"
    } else {
        ""
    };
    let scroll = if node.is_scrollable { "|scroll|" } else { "" };
    let attrs = render_attr_list(node, max_text_len, state);
    let text = node.text.as_deref().unwrap_or("");

    let line = if !text.is_empty() {
        let text_part = truncate_text(text, max_text_len, state);
        if VOID_TAGS.contains(&tag) {
            format!("{indent}{iframe}{star}{idx}<{tag}{attrs} />{scroll}")
        } else {
            format!("{indent}{iframe}{star}{idx}<{tag}{attrs}>{text_part}</{tag}>{scroll}")
        }
    } else {
        format!("{indent}{iframe}{star}{idx}<{tag}{attrs} />{scroll}")
    };
    push_line(out, &line, state);

    for child in &node.children {
        render_node(child, depth + 1, out, state, max_text_len);
    }
}

/// 属性列表渲染（白名单顺序输出；`key=value`，值含空白加引号）。
fn render_attr_list(node: &SimplifiedNode, max_len: usize, state: &mut BuildState) -> String {
    let mut parts = Vec::new();
    for (k, v) in &node.attributes {
        parts.push(render_attr_kv(k, v, max_len, state));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" {}", parts.join(" "))
    }
}

/// 行输出（带 32KB 输出预算扣减；预算耗尽即停）。
fn push_line(out: &mut String, line: &str, state: &mut BuildState) {
    if state.output_left == 0 {
        return;
    }
    let bytes = line.len();
    if bytes > state.output_left {
        state.output_left = 0;
        return;
    }
    state.output_left -= bytes;
    out.push_str(line);
    out.push('\n');
}

/// 被截子树的可交互元素计数（预算 1/2 提示行；判定复用四层规则，后序统计）。
fn count_interactive_subtree(
    node: &EnhancedNode,
    opts: &SerializeOptions,
    cache: &mut DecisionCache,
) -> usize {
    let mut count = 0;
    count_interactive_rec(node, opts, cache, &mut count);
    count
}

fn count_interactive_rec(
    node: &EnhancedNode,
    opts: &SerializeOptions,
    cache: &mut DecisionCache,
    count: &mut usize,
) {
    if node.is_text() {
        return;
    }
    let sub_has = false;
    for child in &node.children {
        if !child.is_text() {
            count_interactive_rec(child, opts, cache, count);
        }
    }
    // 后序：先统计子树，再以子树结果判定自身（W2 语义）
    if !node.is_element_candidate() {
        return;
    }
    let ctx = DecideCtx {
        tag: node.tag.as_deref().unwrap_or(""),
        attributes: &node.attributes,
        ax: &node.ax,
        styles: &node.styles,
        bounds: node.bounds,
        has_click_listener: node.has_click_listener,
        listener_channel_enabled: opts.listener_channel,
        is_scrollable: node.scrollable || node.styles.scroll_candidate(),
        in_svg: node.in_svg,
        ancestor_hidden: false,
        subtree_has_interactive: sub_has,
        wrapped_control: false,
        wrapped_by_label_for: false,
    };
    let d = if node.backend_node_id >= 0 {
        cache.get_or_else(opts.session_id, node.backend_node_id, || decide(&ctx))
    } else {
        decide(&ctx)
    };
    if matches!(d, Decision::Interactive(_)) {
        *count += 1;
    }
}

/// 子树节点数（预算 1/2 丢弃统计/视口外提示）。
fn subtree_size(node: &EnhancedNode) -> usize {
    let mut n = 0;
    node.walk(&mut |_| n += 1);
    n
}

/// M1 探测：label/span 包裹表单控件（≤2 层；label 带 for 时 M0 跳过）。
fn wrapped_control_probe(node: &EnhancedNode) -> (bool, bool) {
    let tag = node.tag.as_deref().unwrap_or("");
    if tag != "label" && tag != "span" {
        return (false, false);
    }
    let by_label_for = tag == "label" && node.get_attr("for").is_some();
    let is_control =
        |n: &EnhancedNode| matches!(n.tag.as_deref(), Some("input") | Some("select") | Some("textarea"));
    // ≤2 层：直接子或孙
    let direct = node.children.iter().any(&is_control);
    let grand = node
        .children
        .iter()
        .any(|c| c.children.iter().any(&is_control));
    ((direct || grand), by_label_for)
}

/// AX 辅助：可访问名称提取优先链（AX name → aria-label → title → placeholder → 文本）。
#[allow(dead_code)]
fn accessible_name(node: &EnhancedNode) -> Option<String> {
    if let Some(name) = node.ax.name.as_deref().filter(|s| !s.is_empty()) {
        return Some(name.to_string());
    }
    for attr in ["aria-label", "title", "placeholder"] {
        if let Some(v) = node.get_attr(attr).filter(|s| !s.is_empty()) {
            return Some(v.to_string());
        }
    }
    let inline = node.inline_text();
    if !inline.trim().is_empty() {
        return Some(inline.trim().to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::collect::EnhancedNode;

    fn opts<'a>(budgets: &'a BudgetConfig, previous: &'a HashSet<i64>) -> SerializeOptions<'a> {
        SerializeOptions::new(budgets, "test-session", previous)
    }

    /// §3.2 文档示例（登录页：搜索框 + shadow 组件 + 密码框 + iframe + canvas +
    /// closed shadow）——根森林形态（每顶层元素一棵根树）。
    fn login_fixture() -> Vec<EnhancedNode> {
        vec![
            EnhancedNode::element("input", 101)
                .attr("name", "q")
                .attr("placeholder", "搜索")
                .attr("aria-label", "搜索框")
                .bounds(0.0, 0.0, 300.0, 36.0),
            EnhancedNode::text_node("Search the web: 示例搜索结果页", 102),
            EnhancedNode::element("button", 103)
                .attr("aria-label", "搜索")
                .bounds(310.0, 0.0, 80.0, 36.0),
            // 开放 shadow：用户名/密码输入框
            EnhancedNode::element("div", 104)
                .marker(FrameMarker::ShadowOpen)
                .bounds(0.0, 60.0, 400.0, 120.0)
                .push(
                    EnhancedNode::element("input", 105)
                        .attr("placeholder", "用户名")
                        .bounds(0.0, 0.0, 200.0, 32.0),
                )
                .push(
                    EnhancedNode::element("input", 106)
                        .attr("type", "password")
                        .attr("placeholder", "密码")
                        .attr("value", "s3cret!")
                        .bounds(0.0, 40.0, 200.0, 32.0),
                ),
            EnhancedNode::element("button", 107).push(EnhancedNode::text_node("登录", 108)),
            EnhancedNode::element("a", 109)
                .attr("href", "/register")
                .push(EnhancedNode::text_node("注册", 110)),
            // 跨域 iframe 占位（无子文档）
            EnhancedNode::element("iframe", 111)
                .attr("src", "https://ads.example.com/ad.js")
                .marker(FrameMarker::Iframe)
                .bounds(0.0, 300.0, 300.0, 200.0),
            // canvas 盲区
            EnhancedNode::element("canvas", 112).bounds(400.0, 60.0, 200.0, 150.0),
            // closed shadow：AX 检出但无 backendNodeId 的不可操作元素
            EnhancedNode::element("div", 113)
                .marker(FrameMarker::ShadowClosed)
                .bounds(0.0, 520.0, 400.0, 80.0)
                .push(
                    EnhancedNode::element("div", -1)
                        .attr("role", "button")
                        .bounds(0.0, 0.0, 100.0, 32.0)
                        .push(EnhancedNode::text_node("主题切换", -2)),
                ),
        ]
    }

    /// 序列化 golden：§3.2 文档示例（登录页）精确文本断言。
    #[test]
    fn serialize_golden_login_page() {
        let budgets = BudgetConfig::active();
        let previous = HashSet::new();
        let out = build_and_serialize(&login_fixture(), &opts(&budgets, &previous));

        let expected = "\
[101]<input name=q placeholder=搜索 aria-label=搜索框 />
Search the web: 示例搜索结果页
[103]<button aria-label=搜索 />
|SHADOW(open)|
  [105]<input placeholder=用户名 />
  [106]<input type=password placeholder=密码 value=[REDACTED] />
  Shadow End
[107]<button>登录</button>
[109]<a href=/register>注册</a>
|IFRAME|<iframe src=https://ads.example.com/ad.js />
|CANVAS|<canvas>
|SHADOW(closed)|
  |UNOPERABLE|<div role=button>主题切换</div>
  Shadow End
";
        assert_eq!(out.text, expected);

        // 索引映射：可交互元素绑定 backendNodeId（106 密码框也应可交互；
        // iframe/canvas/unoperable 不占索引）
        assert_eq!(out.selector_map.len(), 6);
        assert_eq!(out.selector_map[&101].backend_node_id, 101);
        assert_eq!(out.selector_map[&106].backend_node_id, 106);
        assert_eq!(out.selector_map[&107].backend_node_id, 107);
        assert!(!out.selector_map.contains_key(&111), "iframe 占位不分配索引（U-4）");
        assert!(!out.selector_map.contains_key(&112), "canvas 盲区不分配索引");

        // 盲区统计（V4）：canvas=1、unoperable=1（closed shadow 降级）
        assert_eq!(out.blind_zone.canvas, 1);
        assert_eq!(out.blind_zone.unoperable, 1);
        assert_eq!(out.blind_zone.video, 0);
        assert_eq!(out.blind_zone.image, 0);

        // 密码脱敏（T5）：序列化文本不含明文
        assert!(!out.text.contains("s3cret"));
        assert!(out.text.contains("value=[REDACTED]"));

        // 头部元数据（截断前计数）
        assert_eq!(out.element_count, 12);
        assert_eq!(out.selector_count, 6);
        assert!(out.truncation.is_none());
    }

    /// 索引稳定性（T6）：同一 backendNodeId 在相邻快照间索引恒定；新增元素带 *。
    #[test]
    fn serialize_index_stability_and_is_new() {
        let budgets = BudgetConfig::active();
        let fixture = login_fixture();
        let first = build_and_serialize(&fixture, &opts(&budgets, &HashSet::new()));
        assert!(first.text.contains("[101]"));

        // 上一轮索引集合（全部 selector backend ids）
        let mut previous = HashSet::new();
        for v in first.selector_map.values() {
            previous.insert(v.backend_node_id);
        }
        let second = build_and_serialize(
            &fixture,
            &opts(&budgets, &previous).with_incremental(true),
        );
        // 索引稳定：同一元素仍 [101]（索引 = backendNodeId 本身）
        assert!(second.text.contains("[101]<input name=q"));
        // 无新增元素 → 无 * 标记
        assert!(!second.text.contains('*'), "全量重拍后不应有 * 标记");

        // 新增按钮（id 300）→ *[300]
        let mut extended = fixture;
        extended.push(
            EnhancedNode::element("button", 300)
                .push(EnhancedNode::text_node("新按钮", 301))
                .bounds(0.0, 400.0, 100.0, 36.0),
        );
        let third = build_and_serialize(
            &extended,
            &opts(&budgets, &previous).with_incremental(true),
        );
        assert!(
            third.text.contains("*[300]<button>新按钮</button>"),
            "新增元素应带 * 前缀：\n{}",
            third.text
        );
        // 版本不连续（previous 为空）→ 全量视角，无 * 标记
        let fresh = build_and_serialize(&extended, &opts(&budgets, &HashSet::new()));
        assert!(!fresh.text.contains('*'), "无前驱时不得有 * 标记（全量视角）");
    }

    /// 预算 1（深度）：超深子树折叠为「被截可交互元素计数」提示行。
    #[test]
    fn budget_depth_folds_deep_subtree() {
        let budgets = BudgetConfig { max_depth: 3, ..BudgetConfig::active() };
        // 构造深层嵌套链，最深层有按钮（折叠后应提示 1 个被截可交互元素）
        let mut cur = EnhancedNode::element("div", 1)
            .bounds(0.0, 0.0, 100.0, 100.0)
            .push(EnhancedNode::element("button", 999).bounds(0.0, 0.0, 50.0, 20.0));
        for i in 0..6 {
            cur = EnhancedNode::element("div", 10 + i)
                .bounds(0.0, 0.0, 100.0, 100.0)
                .push(cur);
        }
        let out = build_and_serialize(&[cur], &opts(&budgets, &HashSet::new()));
        assert!(
            out.text.contains("... (1 more interactive elements)"),
            "深度截断应保留被截可交互元素计数：\n{}",
            out.text
        );
        let t = out.truncation.expect("深度截断应有 TruncationInfo");
        assert_eq!(t.truncated_by, TruncationKind::Depth);
        assert!(t.dropped_nodes > 0);
        assert_eq!(t.dropped_interactive, 1);
    }

    /// 预算 2（元素数）：超大节点数截断语义 + 提示行。
    #[test]
    fn budget_elements_truncates_big_tree() {
        let budgets = BudgetConfig::active().scaled(10, 500);
        let mut root = EnhancedNode::element("div", 1).bounds(0.0, 0.0, 500.0, 500.0);
        for i in 0..50 {
            root = root.push(
                EnhancedNode::element("button", 100 + i)
                    .push(EnhancedNode::text_node(&format!("项 {i}"), 1000 + i))
                    .bounds(0.0, (i * 10) as f64, 100.0, 8.0),
            );
        }
        let out = build_and_serialize(&[root], &opts(&budgets, &HashSet::new()));
        let t = out.truncation.expect("元素数截断应有 TruncationInfo");
        assert_eq!(t.truncated_by, TruncationKind::Elements);
        assert!(t.dropped_nodes > 0, "被丢弃节点应统计");
        assert!(
            out.text.contains("more interactive elements"),
            "元素数截断应保留被截可交互元素计数提示行：\n{}",
            out.text
        );
        assert!(out.element_count <= 10, "元素预算 10 内保留");
        // 预算耗尽后不再出现后续按钮行（预算外元素不入树）
        assert!(!out.text.contains("[110]<button>项 10</button>"));
    }

    /// 预算 3（文本）：单行/属性值超限截断并追加 …。
    #[test]
    fn budget_text_truncates_long_lines() {
        let budgets = BudgetConfig { max_text_len: 10, ..BudgetConfig::active() };
        let long = "很长的描述文本超过十个字符的长度限制";
        let root = EnhancedNode::element("div", 1).bounds(0.0, 0.0, 500.0, 100.0).push(
            EnhancedNode::element("button", 2)
                .attr("title", long)
                .bounds(0.0, 0.0, 100.0, 36.0)
                .push(EnhancedNode::text_node(long, 3)),
        );
        let out = build_and_serialize(&[root], &opts(&budgets, &HashSet::new()));
        assert!(
            out.text.contains('…'),
            "截断应追加 … 后缀：\n{}",
            out.text
        );
        let long_prefix = long.chars().take(15).collect::<String>();
        assert!(!out.text.contains(&long_prefix), "超长文本不应完整出现");
        let t = out.truncation.expect("文本截断应有 TruncationInfo");
        assert_eq!(t.truncated_by, TruncationKind::Text);
    }

    /// 预算 4（索引）：超出上限元素仍入树（无 [N] 前缀，仅文本可读）。
    #[test]
    fn budget_selectors_capped_no_prefix() {
        let budgets = BudgetConfig::active().scaled(1000, 3);
        let mut root = EnhancedNode::element("div", 1).bounds(0.0, 0.0, 500.0, 500.0);
        for i in 0..5 {
            root = root.push(
                EnhancedNode::element("button", 100 + i)
                    .push(EnhancedNode::text_node(&format!("按钮 {i}"), 1000 + i))
                    .bounds(0.0, (i * 40) as f64, 100.0, 30.0),
            );
        }
        let out = build_and_serialize(&[root], &opts(&budgets, &HashSet::new()));
        assert_eq!(out.selector_map.len(), 3, "索引上限 3");
        assert!(out.text.contains("[100]<button>按钮 0</button>"));
        assert!(
            out.text.contains("<button>按钮 4</button>"),
            "超出上限元素仍入树（无 [N]）：\n{}",
            out.text
        );
        let t = out.truncation.expect("索引截断应有 TruncationInfo");
        assert_eq!(t.truncated_by, TruncationKind::Selectors);
    }

    /// 32KB 输出预算（T-2）：超大输出截断 + 标记行。
    #[test]
    fn budget_output_bytes_caps_serialization() {
        let budgets = BudgetConfig {
            max_output_bytes: 200,
            ..BudgetConfig::active()
        };
        let mut root = EnhancedNode::element("div", 1).bounds(0.0, 0.0, 500.0, 500.0);
        for i in 0..30 {
            root = root.push(
                EnhancedNode::element("button", 100 + i)
                    .attr("aria-label", "标签内容标签内容标签内容")
                    .bounds(0.0, (i * 20) as f64, 200.0, 16.0),
            );
        }
        let out = build_and_serialize(&[root], &opts(&budgets, &HashSet::new()));
        assert!(out.text.len() <= 200 + 64, "输出应被输出预算截断");
        assert!(out.text.contains("truncated by output budget"), "应有输出预算截断标记");
        let t = out.truncation.expect("输出截断应有 TruncationInfo");
        assert_eq!(t.truncated_by, TruncationKind::Output);
    }

    /// 非活跃标签预算（T-6）：节点/索引按 0.25 缩放生效。
    #[test]
    fn budget_inactive_factor_applied() {
        let inactive = BudgetConfig::active().inactive();
        let fixture = login_fixture();
        let out = build_and_serialize(&fixture, &opts(&inactive, &HashSet::new()));
        // 非活跃预算下完整页仍可表达（250 节点/125 索引足够），不截断主结构
        assert!(out.text.contains("[101]<input name=q"));
        // 小预算验证缩放面
        let tiny = BudgetConfig {
            max_tree_nodes: 4,
            max_selector_indices: 2,
            ..BudgetConfig::active()
        };
        let out2 = build_and_serialize(&fixture, &opts(&tiny, &HashSet::new()));
        assert_eq!(out2.selector_map.len(), 2);
    }

    /// 空树/纯文本树边界。
    #[test]
    fn serialize_empty_and_text_only() {
        let budgets = BudgetConfig::active();
        let empty = build_and_serialize(&[], &opts(&budgets, &HashSet::new()));
        assert_eq!(empty.text, "");
        assert_eq!(empty.selector_map.len(), 0);
        assert_eq!(empty.element_count, 0);
        assert!(empty.truncation.is_none());

        let text_only = build_and_serialize(
            &[EnhancedNode::text_node("只有一段文本内容", 1)],
            &opts(&budgets, &HashSet::new()),
        );
        assert_eq!(text_only.text, "只有一段文本内容\n");
        // 单字符文本（入树阈值 >1 字符）被过滤
        let single = build_and_serialize(
            &[EnhancedNode::text_node("字", 2)],
            &opts(&budgets, &HashSet::new()),
        );
        assert_eq!(single.text, "");
    }

    /// 编码鲁棒性：中文/emoji 代理对/零宽字符/控制字符不破坏结构。
    #[test]
    fn serialize_unicode_robust() {
        let budgets = BudgetConfig::active();
        let root = EnhancedNode::element("div", 1)
            .bounds(0.0, 0.0, 500.0, 200.0)
            .push(
                EnhancedNode::element("button", 2)
                    .push(EnhancedNode::text_node("中文按钮😀👍", 3))
                    .bounds(0.0, 0.0, 100.0, 30.0),
            )
            .push(
                EnhancedNode::element("div", 4)
                    .bounds(0.0, 40.0, 100.0, 30.0)
                    .push(EnhancedNode::text_node("零宽\u{200B}字符\u{200C}测试", 5)),
            )
            .push(
                EnhancedNode::element("div", 6)
                    .bounds(0.0, 80.0, 100.0, 30.0)
                    .push(EnhancedNode::text_node("控制\u{0001}字符\u{0008}扫描", 7)),
            );
        let out = build_and_serialize(&[root], &opts(&budgets, &HashSet::new()));
        assert!(out.text.contains("中文按钮😀👍"), "emoji 代理对不得破坏结构");
        assert!(out.text.contains("零宽"));
        assert!(out.text.contains("字符") && out.text.contains("测试"));
        assert!(out.text.contains("扫描"), "控制字符不破坏行结构");
        for line in out.text.lines() {
            assert!(!line.is_empty(), "行结构完整（无空行）");
        }
        assert_eq!(out.selector_map.len(), 1);
    }

    /// select 展开（options 前 4 项 + 省略计数）与日期输入 format 提示。
    #[test]
    fn serialize_select_options_and_date_format() {
        let budgets = BudgetConfig::active();
        let mut select = EnhancedNode::element("select", 1).bounds(0.0, 0.0, 200.0, 32.0);
        for (i, city) in ["北京", "上海", "深圳", "广州", "杭州", "成都", "武汉"]
            .iter()
            .enumerate()
        {
            let i = i as i64;
            select = select.push(
                EnhancedNode::element("option", 10 + i)
                    .push(EnhancedNode::text_node(city, 100 + i)),
            );
        }
        let root = EnhancedNode::element("form", 0)
            .bounds(0.0, 0.0, 400.0, 200.0)
            .push(select)
            .push(
                EnhancedNode::element("input", 2)
                    .attr("type", "date")
                    .attr("name", "birthday")
                    .bounds(0.0, 50.0, 200.0, 32.0),
            );
        let out = build_and_serialize(
            &[root],
            &opts(&budgets, &HashSet::new()).with_incremental(true),
        );
        assert!(
            out.text.contains("options=\"北京|上海|深圳|广州|...(3 more)\""),
            "select 展开应前 4 项 + 省略计数（值含空格加引号）：\n{}",
            out.text
        );
        assert!(out.text.contains("format=YYYY-MM-DD"), "日期输入应附 ISO 格式提示");
        // 复合组件恒标记新增（*）
        assert!(out.text.contains("*[1]<select"), "select 为复合组件恒 new");
    }

    /// 容器折叠：按钮里套按钮折叠进容器行（防双索引）。
    #[test]
    fn serialize_container_folding() {
        let budgets = BudgetConfig::active();
        // 外层 a 完全包含内层 button（无显式信号）→ 折叠，仅外层索引
        let root = EnhancedNode::element("a", 1)
            .attr("href", "/x")
            .bounds(0.0, 0.0, 200.0, 40.0)
            .push(
                EnhancedNode::element("button", 2)
                    .push(EnhancedNode::text_node("内层按钮", 3))
                    .bounds(10.0, 5.0, 180.0, 30.0),
            );
        let out = build_and_serialize(&[root], &opts(&budgets, &HashSet::new()));
        assert_eq!(out.selector_map.len(), 1, "折叠后不应双索引");
        assert!(out.selector_map.contains_key(&1));
        assert!(out.text.contains("内层按钮"), "折叠后文本应合并进容器行");
        assert!(!out.text.contains("[2]"), "被折叠按钮不应有索引");
    }

    /// 绘制序过滤：被完全不透明覆盖的非表单节点 → 保留文本行但无索引。
    #[test]
    fn serialize_paint_order_covered_no_index() {
        let budgets = BudgetConfig::active();
        let previous = HashSet::new();
        let root = EnhancedNode::element("div", 1)
            .bounds(0.0, 0.0, 500.0, 400.0)
            .push(
                // 被覆盖的按钮（后画的覆盖层完全遮挡）
                EnhancedNode::element("button", 10)
                    .push(EnhancedNode::text_node("被遮挡按钮", 11))
                    .bounds(0.0, 0.0, 200.0, 40.0),
            )
            .push(
                // 覆盖层（后画，完全覆盖按钮 10）
                EnhancedNode::element("div", 20)
                    .bounds(0.0, 0.0, 200.0, 40.0)
                    .style("background-color", "#000"),
            );
        let mut o = opts(&budgets, &previous);
        o.paint_filter = true;
        o.paint_orders = &[
            (10, Bounds { x: 0.0, y: 0.0, width: 200.0, height: 40.0 }),
            (20, Bounds { x: 0.0, y: 0.0, width: 200.0, height: 40.0 }),
        ];
        let out = build_and_serialize(&[root], &o);
        // 被覆盖按钮：保留文本行但无索引
        assert!(out.text.contains("被遮挡按钮"), "被遮盖节点保留文本行");
        assert!(!out.selector_map.contains_key(&10), "被遮盖节点不给交互索引");
    }

    /// 索引合成：负 backendNodeId（closed shadow 内部无 id）不进入索引；
    /// 索引 = backendNodeId 本身（u32 越界时合成）。
    #[test]
    fn serialize_synthetic_index_guard() {
        let budgets = BudgetConfig::active();
        // UNOPERABLE 元素（-1）不分配索引
        let root = EnhancedNode::element("div", 1)
            .marker(FrameMarker::ShadowClosed)
            .bounds(0.0, 0.0, 200.0, 100.0)
            .push(
                EnhancedNode::element("div", -1)
                    .attr("role", "button")
                    .bounds(0.0, 0.0, 100.0, 30.0),
            );
        let out = build_and_serialize(&[root], &opts(&budgets, &HashSet::new()));
        assert!(out.text.contains("|UNOPERABLE|"));
        assert_eq!(out.selector_map.len(), 0, "不可操作元素不分配索引");
    }

    /// 隐藏元素/禁用/装饰 SVG 不进索引（负例面）。
    #[test]
    fn serialize_negatives_no_index() {
        let budgets = BudgetConfig::active();
        let root = EnhancedNode::element("div", 1)
            .bounds(0.0, 0.0, 500.0, 500.0)
            .push(
                EnhancedNode::element("button", 2)
                    .style("display", "none")
                    .bounds(0.0, 0.0, 100.0, 30.0),
            )
            .push(
                EnhancedNode::element("button", 3)
                    .attr("disabled", "")
                    .bounds(0.0, 40.0, 100.0, 30.0),
            )
            .push(
                EnhancedNode::element("svg", 4).bounds(0.0, 80.0, 100.0, 100.0).push(
                    EnhancedNode::element("path", 5)
                        .svg_child()
                        .bounds(0.0, 80.0, 100.0, 100.0),
                ),
            );
        let out = build_and_serialize(&[root], &opts(&budgets, &HashSet::new()));
        assert_eq!(out.selector_map.len(), 0, "隐藏/禁用/装饰 SVG 一律不索引");
        assert!(!out.text.contains("[2]"));
        assert!(!out.text.contains("[3]"));
        assert!(!out.text.contains("[5]"));
    }

    /// 视口外折叠：超出视口 + 1000px 缓冲且不可滚动到达 → 滚动提示行。
    #[test]
    fn serialize_viewport_outside_folds() {
        let budgets = BudgetConfig::active();
        let previous = HashSet::new();
        let root = EnhancedNode::element("div", 1)
            .bounds(0.0, 0.0, 500.0, 500.0)
            .push(
                EnhancedNode::element("button", 2)
                    .bounds(0.0, 5000.0, 100.0, 30.0), // 远超出视口
            );
        let mut o = opts(&budgets, &previous);
        o.viewport = Some(Bounds { x: 0.0, y: 0.0, width: 1280.0, height: 800.0 });
        let out = build_and_serialize(&[root], &o);
        assert!(
            out.text.contains("more elements - scroll to reveal"),
            "视口外应折叠为滚动提示：\n{}",
            out.text
        );
        // 可滚动容器内元素保留（滚动可达）
        let scroller = EnhancedNode::element("div", 1)
            .scrollable()
            .bounds(0.0, 0.0, 500.0, 500.0)
            .push(
                EnhancedNode::element("button", 2)
                    .bounds(0.0, 5000.0, 100.0, 30.0),
            );
        let out2 = build_and_serialize(&[scroller], &o);
        assert!(
            out2.text.contains("[2]<button"),
            "可滚动容器内元素应保留：\n{}",
            out2.text
        );
    }

    /// T-16 补齐（审计待查项 3）：canvas/video/img 盲区标记 + 统计 +
    /// 属性上下文呈现（占位行保留白名单描述属性，D4 不误伤，与 |IMG| 对齐）
    /// + 无索引 + 与常规交互元素共存互不干扰。
    #[test]
    fn serialize_blind_zone_canvas_video_img_marking() {
        let budgets = BudgetConfig::active();
        let roots = vec![
            // canvas 带描述属性（width 非白名单项，仅描述属性呈现）
            EnhancedNode::element("canvas", 1)
                .attr("aria-label", "价格走势图")
                .attr("title", "近30天成交额")
                .attr("width", "800")
                .bounds(0.0, 0.0, 800.0, 400.0),
            // video 带 src/aria-label（白名单顺序：aria-label 在 src 前）
            EnhancedNode::element("video", 2)
                .attr("src", "intro.mp4")
                .attr("aria-label", "产品介绍视频")
                .bounds(0.0, 420.0, 320.0, 180.0),
            // img 带 alt/title/aria-label（白名单顺序：aria-label→title→alt）
            EnhancedNode::element("img", 3)
                .attr("alt", "示意图")
                .attr("title", "架构图")
                .attr("aria-label", "系统架构图")
                .bounds(0.0, 620.0, 100.0, 100.0),
            // 常规交互元素共存（互不干扰）
            EnhancedNode::element("button", 4)
                .push(EnhancedNode::text_node("正常按钮", 5))
                .bounds(0.0, 740.0, 100.0, 36.0),
        ];
        let out = build_and_serialize(&roots, &opts(&budgets, &HashSet::new()));

        // 盲区标记呈现 + 属性上下文（D4 不误伤）
        assert!(
            out.text
                .contains("|CANVAS|<canvas aria-label=价格走势图 title=近30天成交额>"),
            "canvas 占位行应呈现描述属性：\n{}",
            out.text
        );
        assert!(
            out.text
                .contains("|VIDEO|<video aria-label=产品介绍视频 src=intro.mp4>"),
            "video 占位行应呈现 src/描述：\n{}",
            out.text
        );
        assert!(
            out.text
                .contains("|IMG|<img aria-label=系统架构图 title=架构图 alt=示意图>"),
            "img 占位行应呈现描述属性：\n{}",
            out.text
        );

        // 头部统计（盲区元素不参与检出率口径，13 §3.6）
        assert_eq!(out.blind_zone.canvas, 1);
        assert_eq!(out.blind_zone.video, 1);
        assert_eq!(out.blind_zone.image, 1);
        assert_eq!(out.blind_zone.unoperable, 0);

        // 盲区不分配索引；常规元素正常检出
        let indexed: HashSet<i64> = out
            .selector_map
            .values()
            .map(|r| r.backend_node_id)
            .collect();
        assert!(
            !indexed.contains(&1) && !indexed.contains(&2) && !indexed.contains(&3),
            "盲区元素一律不分配索引：{indexed:?}"
        );
        assert!(indexed.contains(&4), "常规交互元素正常检出");
    }

    /// T-16 契约：盲区元素「不展开内容」（13 §3.6 占位符呈现语义）——
    /// canvas 带后备内容子节点（HTML 替代内容）与 video 带 source 子节点时，
    /// 仍以占位行呈现且子节点不展开，统计不变。
    #[test]
    fn serialize_blind_zone_fallback_not_expanded() {
        let budgets = BudgetConfig::active();
        let roots = vec![
            // canvas 带后备内容（不支持 canvas 的浏览器/辅助技术可读）
            EnhancedNode::element("canvas", 1)
                .bounds(0.0, 0.0, 300.0, 150.0)
                .push(EnhancedNode::text_node("浏览器不支持 canvas", 10))
                .push(EnhancedNode::element("p", 11).push(EnhancedNode::text_node("后备段落", 12))),
            // video 带 source 子节点
            EnhancedNode::element("video", 2)
                .attr("src", "clip.mp4")
                .bounds(0.0, 200.0, 320.0, 180.0)
                .push(EnhancedNode::element("source", 13).attr("src", "clip.webm")),
        ];
        let out = build_and_serialize(&roots, &opts(&budgets, &HashSet::new()));
        assert!(
            out.text.contains("|CANVAS|<canvas>"),
            "canvas 占位行：\n{}",
            out.text
        );
        assert!(
            !out.text.contains("浏览器不支持 canvas"),
            "canvas 后备内容不得展开（占位符契约）：\n{}",
            out.text
        );
        assert!(!out.text.contains("后备段落"), "canvas 后备元素不得展开");
        assert!(
            out.text.contains("|VIDEO|<video src=clip.mp4>"),
            "video 占位行保留 src：\n{}",
            out.text
        );
        assert!(
            !out.text.contains("clip.webm"),
            "video source 子节点不得展开"
        );
        assert_eq!(out.blind_zone.canvas, 1);
        assert_eq!(out.blind_zone.video, 1);
        assert!(out.selector_map.is_empty(), "盲区元素一律不分配索引");
    }

    /// T-16 补齐：WebGL 与 2D 上下文共用 canvas 标签检出——带 width/height
    /// 尺寸属性（典型 WebGL 绘图表面配置）的 canvas 与普通 canvas 同样
    /// |CANVAS| 占位 + 统一统计（DOM 快照面不可观测 JS getContext 调用，
    /// 13 §3.6 检出通道 = DOM 标签）。
    #[test]
    fn serialize_blind_zone_webgl_canvas_same_tag() {
        let budgets = BudgetConfig::active();
        let roots = vec![
            // WebGL 表面（尺寸属性配置绘图缓冲区，与 2D 无检出差异）
            EnhancedNode::element("canvas", 1)
                .attr("width", "1024")
                .attr("height", "768")
                .attr("aria-label", "3D场景")
                .bounds(0.0, 0.0, 1024.0, 768.0),
            // 2D 绘图 canvas（无尺寸属性，默认 300×150）
            EnhancedNode::element("canvas", 2)
                .attr("aria-label", "2D图表")
                .bounds(0.0, 800.0, 300.0, 150.0),
        ];
        let out = build_and_serialize(&roots, &opts(&budgets, &HashSet::new()));
        assert!(
            out.text.contains("|CANVAS|<canvas aria-label=3D场景>"),
            "WebGL 表面 canvas 同样 |CANVAS| 占位：\n{}",
            out.text
        );
        assert!(out.text.contains("|CANVAS|<canvas aria-label=2D图表>"));
        assert_eq!(out.blind_zone.canvas, 2, "WebGL/2D 同标签检出统一计数");
        assert!(out.selector_map.is_empty(), "盲区元素一律不分配索引");
    }
}
