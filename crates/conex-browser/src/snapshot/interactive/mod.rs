//! 可交互判定启发式（维度 13 §2：P→S→M→W 四层短路）
//!
//! 判定输入：tag、attributes、AX role/properties、computed styles、bounds、
//! JS 监听器（可选增强通道，默认关闭 T-4）、可滚动、后代结构。
//! 规则分四层：**排除前置（P）→ 强正信号（S）→ 结构信号（M）→ 弱信号（W）**；
//! P 层命中即否决；S 层任一命中即通过（不再看弱信号）；M/W 层仅当 S 层
//! 全部未命中时参与，任一命中即通过（§2.1 判定规则总表 + 优先级语义）。
//!
//! 数据面类型（`Bounds`/`StyleInfo`/`AxInfo`）定义于 collect.rs（采集合并产物），
//! 本模块只读消费。

use std::collections::HashMap;
use std::fmt;

mod ctx;
mod layers;
#[cfg(test)]
mod tests;

pub use ctx::DecideCtx;
use layers::{m_layer, p_layer, s_layer, w_layer};

/// 原生交互标签（S2；大小写不敏感，§2.1 规则表）。
pub const NATIVE_INTERACTIVE_TAGS: &[&str] = &[
    "button", "input", "select", "textarea", "a", "details", "summary", "option", "optgroup",
];

/// ARIA role 交互角色集（S3/S4；`+` 号角色为 S4 AX role 扩展项）。
pub const INTERACTIVE_ROLES: &[&str] = &[
    "button",
    "link",
    "menuitem",
    "option",
    "radio",
    "checkbox",
    "tab",
    "textbox",
    "combobox",
    "slider",
    "spinbutton",
    "search",
    "searchbox",
    "row",
    "cell",
    "gridcell",
    "listbox",
    "menubar",
    "tree",
    "grid",
];

/// AX role 扩展集（S4：menubar/tree/grid 仅在 AX 通道命中）。
pub const AX_EXTENDED_ROLES: &[&str] = &["menubar", "tree", "grid"];

/// 内联事件属性（S6）。
pub const INLINE_EVENT_ATTRS: &[&str] = &[
    "onclick",
    "onmousedown",
    "onmouseup",
    "onkeydown",
    "onkeyup",
    "tabindex",
];

/// SVG 子元素默认装饰名单（P6；SVG 根 svg 保留，含显式交互信号的走 S8 放行）。
pub const SVG_DECORATIVE_TAGS: &[&str] = &[
    "path", "rect", "g", "circle", "use", "defs", "line", "polyline", "polygon", "ellipse", "text",
    "tspan", "image", "symbol", "mask", "marker", "pattern", "clippath",
];

/// 搜索类模式标记（M2；class/id/data-* 属性小写化后子串匹配）。
pub const SEARCH_PATTERNS: &[&str] = &[
    "search",
    "magnify",
    "glass",
    "lookup",
    "find",
    "query",
    "searchbox",
];

/// 交互类 data-* 前缀（S8 显式交互 SVG / M3 图标按钮共用）。
pub const INTERACTIVE_DATA_PREFIXES: &[&str] =
    &["data-action", "data-click", "data-toggle", "data-event"];

/// dropdown 容器 class 标记（W2 select_dropdown 无条件可交互）。
pub const DROPDOWN_CLASS_PATTERNS: &[&str] = &["dropdown", "select-menu"];

/// dropdown 容器 role 集合（W2 无条件可交互）。
pub const DROPDOWN_ROLES: &[&str] = &["listbox", "menu", "combobox", "menubar", "tree", "grid"];

/// 命中规则（S/M/W 层正信号来源；测试断言与审计用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleHit {
    /// S1：JS click 类监听器（getEventListeners 通道，默认关闭 T-4）
    S1Listener,
    /// S2：原生交互标签
    S2NativeTag,
    /// S3：ARIA role 属性 ∈ 交互角色集
    S3RoleAttr,
    /// S4：AX role ∈ 交互角色集（含 menubar/tree/grid 扩展）
    S4AxRole,
    /// S5：AX 交互属性任一为真（focusable/editable/checked 等）
    S5AxProperty,
    /// S6：内联事件属性/onclick/tabindex
    S6InlineEvent,
    /// S7：大 iframe（宽高均 > 100px）
    S7BigIframe,
    /// S8：显式交互 SVG（onclick/role/交互 data-*）
    S8ExplicitSvg,
    /// M1：label/span 包裹表单控件（≤2 层）
    M1Wrapped,
    /// M2：搜索类模式（class/id/data-* 标记）
    M2SearchPattern,
    /// M3：图标尺寸元素（10-50px）且含交互类属性
    M3IconButton,
    /// W1：cursor:pointer
    W1CursorPointer,
    /// W2：可滚动容器且无交互后代（dropdown 容器无条件）
    W2ScrollContainer,
}

/// 排除原因（P 层短路否决；测试断言用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Excluded {
    /// P2：html/body 不作交互目标
    P2RootTag,
    /// P3：隐藏（display:none/visibility:hidden/opacity≤0/无 bounds/祖先隐藏）
    P3Hidden,
    /// P4：禁用（disabled/aria-disabled/AX disabled）
    P4Disabled,
    /// P5：AX ignored（装饰性节点）
    P5AxIgnored,
    /// P6：SVG 子元素默认装饰
    P6SvgChild,
    /// 零尺寸（bounds 宽或高为 0 且无滚动内容，§2.3）
    ZeroSize,
    /// 视口外（超出布局视口 ±1000px 缓冲，可滚动容器内元素除外——由调用方保留）
    ViewportOutside,
}

/// 判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// 正信号命中（携带命中的具体规则）
    Interactive(RuleHit),
    /// 排除前置否决（携带排除原因）
    Excluded(Excluded),
    /// 无可交互信号（S/M/W 全未命中）
    NotInteractive,
}

impl fmt::Display for Decision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Decision::Interactive(r) => write!(f, "Interactive({r:?})"),
            Decision::Excluded(e) => write!(f, "Excluded({e:?})"),
            Decision::NotInteractive => write!(f, "NotInteractive"),
        }
    }
}

/// 四层短路判定（§2.1 优先级语义：P 否决 > S 通过 > M > W）。
pub fn decide(ctx: &DecideCtx) -> Decision {
    if let Some(d) = p_layer(ctx) {
        return d;
    }
    if let Some(d) = s_layer(ctx) {
        return d;
    }
    if let Some(d) = m_layer(ctx) {
        return d;
    }
    w_layer(ctx).unwrap_or(Decision::NotInteractive)
}

/// 判定缓存（§2.1 补充规则：同节点结果按 (session_id, backend_node_id) 缓存；
/// CDP 节点 id 在跨域目标间会复用，键必须含会话）。
#[derive(Debug, Default)]
pub struct DecisionCache {
    map: HashMap<(String, i64), Decision>,
    hits: usize,
    misses: usize,
}

impl DecisionCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// 命中式读取：缓存有则复用，无则计算并写入。
    pub fn get_or_else(
        &mut self,
        session_id: &str,
        backend_node_id: i64,
        compute: impl FnOnce() -> Decision,
    ) -> Decision {
        let key = (session_id.to_string(), backend_node_id);
        if let Some(d) = self.map.get(&key) {
            self.hits += 1;
            return *d;
        }
        self.misses += 1;
        let d = compute();
        self.map.insert(key, d);
        d
    }

    /// 命中率统计（自测用；同一节点重复判定应命中缓存）。
    pub fn hit_ratio(&self) -> f64 {
        let total = self.hits + self.misses;
        if total == 0 {
            0.0
        } else {
            self.hits as f64 / total as f64
        }
    }
}

/// 子树探测（≤ max_depth 层）是否存在满足谓词的节点（M1/W2 探测辅助；
/// 深度限制防深层遍历爆炸；递归以引用传递回调避免类型级递归）。
pub fn subtree_probe<N, F, P>(root: &N, max_depth: usize, children_of: &F, pred: &P) -> bool
where
    F: Fn(&N) -> &[N],
    P: Fn(&N) -> bool,
{
    if pred(root) {
        return true;
    }
    if max_depth == 0 {
        return false;
    }
    children_of(root)
        .iter()
        .any(|c| subtree_probe(c, max_depth - 1, children_of, pred))
}
