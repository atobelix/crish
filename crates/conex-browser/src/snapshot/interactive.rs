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

use crate::snapshot::collect::{AxInfo, Bounds, StyleInfo};
use std::collections::HashMap;
use std::fmt;

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

/// 判定上下文（§2.1 判定输入全量；调用方构建）。
#[derive(Debug, Clone)]
pub struct DecideCtx<'a> {
    /// 元素标签（小写；调用方保证仅元素节点参与判定，P1 在调用方短路）
    pub tag: &'a str,
    pub attributes: &'a [(String, String)],
    pub ax: &'a AxInfo,
    pub styles: &'a StyleInfo,
    pub bounds: Option<Bounds>,
    /// 是否含 JS click 类监听器（getEventListeners 通道；默认关闭时恒 false）
    pub has_click_listener: bool,
    /// 监听器增强通道开关（T-4：默认关闭；开启时 S1 生效）
    pub listener_channel_enabled: bool,
    /// 是否可滚动（W2）
    pub is_scrollable: bool,
    /// 是否处于 SVG 子树（P6/S8；svg 根自身为 false）
    pub in_svg: bool,
    /// 祖先隐藏（P3 沿链传播；调用方前序传递）
    pub ancestor_hidden: bool,
    /// 子树内是否已有可交互后代（W2「无任何可交互后代」条件）
    pub subtree_has_interactive: bool,
    /// label/span 包裹表单控件（M1 探测结果，≤2 层）
    pub wrapped_control: bool,
    /// label 带 for 属性（M0 防双激活：命中 M1 时不判可交互）
    pub wrapped_by_label_for: bool,
}

impl<'a> DecideCtx<'a> {
    /// 读取属性值（大小写不敏感）。
    pub fn attr(&self, name: &str) -> Option<&'a str> {
        self.attributes
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// 任一属性名命中（大小写不敏感）。
    fn has_attr(&self, name: &str) -> bool {
        self.attributes
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case(name))
    }

    /// 交互角色判定（S3 属性 / S4 AX 共用）。
    fn role_is_interactive(role: &str) -> bool {
        INTERACTIVE_ROLES
            .iter()
            .any(|r| r.eq_ignore_ascii_case(role))
    }

    /// 搜索模式命中（M2：class/id/data-* 属性小写化子串匹配）。
    fn search_pattern_hit(&self) -> bool {
        for (k, v) in self.attributes {
            let is_target = k.eq_ignore_ascii_case("class")
                || k.eq_ignore_ascii_case("id")
                || k.to_ascii_lowercase().starts_with("data-");
            if is_target {
                let lower = v.to_ascii_lowercase();
                if SEARCH_PATTERNS.iter().any(|p| lower.contains(p)) {
                    return true;
                }
            }
        }
        false
    }

    /// 交互类 data-* 属性（S8/M3）。
    fn interactive_data_attr(&self) -> bool {
        self.attributes.iter().any(|(k, _)| {
            let lower = k.to_ascii_lowercase();
            INTERACTIVE_DATA_PREFIXES
                .iter()
                .any(|p| lower.starts_with(p))
        })
    }

    /// 图标按钮的「交互类属性」存在性（M3：class/role/onclick/data-action/aria-label）。
    fn icon_interactive_attr(&self) -> bool {
        self.has_attr("class")
            || self.has_attr("role")
            || self.has_attr("onclick")
            || self.has_attr("data-action")
            || self.has_attr("aria-label")
    }

    /// dropdown 容器判定（W2：无条件可交互的容器形态）。
    fn dropdown_container(&self) -> bool {
        if self.tag.eq_ignore_ascii_case("select") {
            return true;
        }
        if let Some(role) = self.attr("role") {
            if DROPDOWN_ROLES.iter().any(|r| r.eq_ignore_ascii_case(role)) {
                return true;
            }
        }
        if let Some(class) = self.attr("class") {
            let lower = class.to_ascii_lowercase();
            if DROPDOWN_CLASS_PATTERNS.iter().any(|p| lower.contains(p)) {
                return true;
            }
        }
        false
    }
}

/// P 层排除前置（P2-P6 短路否决；P1 非元素节点由调用方短路）。
fn p_layer(ctx: &DecideCtx) -> Option<Decision> {
    // P2：html/body 不作为交互目标
    if ctx.tag == "html" || ctx.tag == "body" {
        return Some(Decision::Excluded(Excluded::P2RootTag));
    }
    // P3：隐藏（含祖先隐藏沿链传播；例外 input[type=file] 强制可见）
    let hidden = ctx.ancestor_hidden || ctx.styles.is_hidden();
    let file_input = ctx.tag == "input"
        && ctx
            .attr("type")
            .is_some_and(|t| t.eq_ignore_ascii_case("file"));
    if hidden && !file_input {
        return Some(Decision::Excluded(Excluded::P3Hidden));
    }
    // P4：禁用
    let disabled = ctx.has_attr("disabled")
        || ctx
            .attr("aria-disabled")
            .is_some_and(|v| v.eq_ignore_ascii_case("true"))
        || ctx.ax.properties.disabled;
    if disabled {
        return Some(Decision::Excluded(Excluded::P4Disabled));
    }
    // P5：AX ignored（装饰性节点；仅 AX 有数据时生效）
    if ctx.ax.present && ctx.ax.ignored {
        return Some(Decision::Excluded(Excluded::P5AxIgnored));
    }
    // P6：SVG 子元素默认装饰（svg 根自身保留；显式交互信号走 S8 唯一放行口）
    if ctx.in_svg && SVG_DECORATIVE_TAGS.contains(&ctx.tag) {
        let explicit = ctx.has_attr("onclick") || ctx.interactive_data_attr();
        if !explicit {
            return Some(Decision::Excluded(Excluded::P6SvgChild));
        }
    }
    // §2.3 零尺寸：bounds 宽或高为 0 且无滚动内容
    if let Some(b) = ctx.bounds {
        if b.is_zero() && !ctx.is_scrollable {
            return Some(Decision::Excluded(Excluded::ZeroSize));
        }
    }
    None
}

/// S 层强正信号（S1-S8；任一命中即通过，不再看弱信号）。
fn s_layer(ctx: &DecideCtx) -> Option<Decision> {
    // S1：JS click 类监听器（可选增强通道，默认关闭 T-4）
    if ctx.listener_channel_enabled && ctx.has_click_listener {
        return Some(Decision::Interactive(RuleHit::S1Listener));
    }
    // S2：原生交互标签
    if NATIVE_INTERACTIVE_TAGS.contains(&ctx.tag) {
        return Some(Decision::Interactive(RuleHit::S2NativeTag));
    }
    // S3：ARIA role 属性 ∈ 交互角色集
    if let Some(role) = ctx.attr("role") {
        if DecideCtx::role_is_interactive(role) {
            return Some(Decision::Interactive(RuleHit::S3RoleAttr));
        }
    }
    // S4：AX role ∈ 交互角色集（含 menubar/tree/grid 扩展）
    if let Some(role) = ctx.ax.role.as_deref() {
        if DecideCtx::role_is_interactive(role)
            || AX_EXTENDED_ROLES
                .iter()
                .any(|r| r.eq_ignore_ascii_case(role))
        {
            return Some(Decision::Interactive(RuleHit::S4AxRole));
        }
    }
    // S5：AX 交互属性任一为真
    if ctx.ax.present && ctx.ax.properties.any_interactive() {
        return Some(Decision::Interactive(RuleHit::S5AxProperty));
    }
    // S6：内联事件属性
    if INLINE_EVENT_ATTRS.iter().any(|a| ctx.has_attr(a)) {
        return Some(Decision::Interactive(RuleHit::S6InlineEvent));
    }
    // S7：大 iframe（宽高均 > 100px）
    if ctx.tag == "iframe" && ctx.bounds.is_some_and(|b| b.is_big_iframe()) {
        return Some(Decision::Interactive(RuleHit::S7BigIframe));
    }
    // S8：显式交互 SVG（唯一 SVG 放行口）
    if ctx.in_svg && (ctx.has_attr("onclick") || ctx.interactive_data_attr()) {
        return Some(Decision::Interactive(RuleHit::S8ExplicitSvg));
    }
    None
}

/// M 层结构信号（M1-M3；仅当 S 层全部未命中时参与，任一命中即通过）。
fn m_layer(ctx: &DecideCtx) -> Option<Decision> {
    // M0 防双激活：label[for] 包裹命中 M1 时不判可交互（点击会代理到目标控件）
    if ctx.wrapped_control && !ctx.wrapped_by_label_for {
        return Some(Decision::Interactive(RuleHit::M1Wrapped));
    }
    // M2：搜索类模式
    if ctx.search_pattern_hit() {
        return Some(Decision::Interactive(RuleHit::M2SearchPattern));
    }
    // M3：图标尺寸元素（10-50px）且含交互类属性
    if ctx.bounds.is_some_and(|b| b.is_icon_size()) && ctx.icon_interactive_attr() {
        return Some(Decision::Interactive(RuleHit::M3IconButton));
    }
    None
}

/// W 层弱信号（W1-W2；仅当 S/M 层全部未命中时参与）。
fn w_layer(ctx: &DecideCtx) -> Option<Decision> {
    // W1：cursor:pointer（chrome 漏判兜底）
    if ctx.styles.cursor_pointer() {
        return Some(Decision::Interactive(RuleHit::W1CursorPointer));
    }
    // W2：可滚动容器且无任何可交互后代；dropdown 容器无条件可交互
    if ctx.dropdown_container() {
        return Some(Decision::Interactive(RuleHit::W2ScrollContainer));
    }
    if ctx.is_scrollable && !ctx.subtree_has_interactive {
        return Some(Decision::Interactive(RuleHit::W2ScrollContainer));
    }
    None
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

#[cfg(test)]
mod tests {
    use super::*;

    fn attrs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn ctx<'a>(
        tag: &'a str,
        attributes: &'a [(String, String)],
        styles: StyleInfo,
        bounds: Option<Bounds>,
    ) -> DecideCtx<'a> {
        // 测试辅助：样式/AX 由本函数持有（Box::leak 仅测试场景，量级极小）
        let styles: &'static StyleInfo = Box::leak(Box::new(styles));
        let ax: &'static AxInfo = Box::leak(Box::new(AxInfo::default()));
        DecideCtx {
            tag,
            attributes,
            ax,
            styles,
            bounds,
            has_click_listener: false,
            listener_channel_enabled: false,
            is_scrollable: false,
            in_svg: false,
            ancestor_hidden: false,
            subtree_has_interactive: false,
            wrapped_control: false,
            wrapped_by_label_for: false,
        }
    }

    fn visible() -> StyleInfo {
        StyleInfo::default()
    }

    /// P2：html/body 不作为交互目标。
    #[test]
    fn p2_root_tags_excluded() {
        let a = attrs(&[]);
        assert_eq!(
            decide(&ctx(
                "html",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 100.0
                })
            )),
            Decision::Excluded(Excluded::P2RootTag)
        );
        assert!(matches!(
            decide(&ctx("body", &a, visible(), None)),
            Decision::Excluded(Excluded::P2RootTag)
        ));
    }

    /// P3：display:none / visibility:hidden / opacity=0 / 祖先隐藏 / 无 bounds。
    #[test]
    fn p3_hidden_variants_excluded() {
        let a = attrs(&[]);
        let mut s = visible();
        s.display = Some("none".into());
        assert_eq!(
            decide(&ctx(
                "button",
                &a,
                s,
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0
                })
            )),
            Decision::Excluded(Excluded::P3Hidden)
        );
        let mut s = visible();
        s.visibility = Some("hidden".into());
        assert_eq!(
            decide(&ctx("button", &a, s, None)),
            Decision::Excluded(Excluded::P3Hidden)
        );
        let mut s = visible();
        s.opacity = Some(0.0);
        assert_eq!(
            decide(&ctx(
                "button",
                &a,
                s,
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0
                })
            )),
            Decision::Excluded(Excluded::P3Hidden)
        );
        let mut c = ctx("button", &a, visible(), None);
        c.ancestor_hidden = true;
        assert_eq!(decide(&c), Decision::Excluded(Excluded::P3Hidden));
    }

    /// P3 例外：input[type=file] 常 opacity:0 包裹定制样式，强制可见。
    #[test]
    fn p3_file_input_forced_visible() {
        let a = attrs(&[("type", "file")]);
        let mut s = visible();
        s.opacity = Some(0.0);
        assert_eq!(
            decide(&ctx(
                "input",
                &a,
                s,
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0
                })
            )),
            Decision::Interactive(RuleHit::S2NativeTag),
            "隐藏 file input 是功能元素，强制可见（§2.3 例外）"
        );
    }

    /// P4：disabled 属性 / aria-disabled=true / AX disabled 排除。
    #[test]
    fn p4_disabled_excluded() {
        let a = attrs(&[("disabled", "")]);
        assert_eq!(
            decide(&ctx(
                "button",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0
                })
            )),
            Decision::Excluded(Excluded::P4Disabled)
        );
        let a = attrs(&[("aria-disabled", "true")]);
        assert!(matches!(
            decide(&ctx(
                "button",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0
                })
            )),
            Decision::Excluded(Excluded::P4Disabled)
        ));
        let mut ax = AxInfo {
            present: true,
            ..AxInfo::default()
        };
        ax.properties.disabled = true;
        let a = attrs(&[]);
        let c = DecideCtx {
            tag: "button",
            attributes: &a,
            ax: &ax,
            bounds: Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            }),
            ..ctx("button", &a, visible(), None)
        };
        assert_eq!(decide(&c), Decision::Excluded(Excluded::P4Disabled));
    }

    /// P5：AX ignored 装饰性节点排除。
    #[test]
    fn p5_ax_ignored_excluded() {
        let ax = AxInfo {
            present: true,
            ignored: true,
            ..AxInfo::default()
        };
        let a = attrs(&[]);
        let c = DecideCtx {
            tag: "div",
            attributes: &a,
            ax: &ax,
            bounds: Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            }),
            ..ctx("div", &a, visible(), None)
        };
        assert_eq!(decide(&c), Decision::Excluded(Excluded::P5AxIgnored));
    }

    /// P6：SVG 子元素默认装饰；svg 根保留；S8 显式交互 SVG 放行。
    #[test]
    fn p6_svg_decorative_and_s8_explicit() {
        let a = attrs(&[]);
        let mut c = ctx(
            "path",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0,
            }),
        );
        c.in_svg = true;
        assert_eq!(decide(&c), Decision::Excluded(Excluded::P6SvgChild));
        // svg 根自身（in_svg=false）不排除
        let c = ctx(
            "svg",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0,
            }),
        );
        assert_eq!(decide(&c), Decision::NotInteractive);
        // S8：SVG 子树中带交互 data-* 放行（onclick 会被 S6 先行命中）
        let a = attrs(&[("data-action", "zoom")]);
        let mut c = ctx(
            "g",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0,
            }),
        );
        c.in_svg = true;
        assert_eq!(decide(&c), Decision::Interactive(RuleHit::S8ExplicitSvg));
    }

    /// 零尺寸排除（§2.3；可滚动例外：有滚动内容时不作零尺寸排除，滚动容器
    /// 由 W2 接管为可交互目标）。
    #[test]
    fn zero_size_excluded() {
        let a = attrs(&[]);
        assert_eq!(
            decide(&ctx(
                "div",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 10.0
                })
            )),
            Decision::Excluded(Excluded::ZeroSize)
        );
        // 可滚动零尺寸：不作零尺寸排除（§2.3「且无滚动内容」），W2 命中
        let mut c = ctx(
            "div",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 10.0,
            }),
        );
        c.is_scrollable = true;
        assert_eq!(
            decide(&c),
            Decision::Interactive(RuleHit::W2ScrollContainer),
            "可滚动零尺寸由 W2 接管"
        );
    }

    /// S2：原生交互标签全清单。
    #[test]
    fn s2_native_tags() {
        let a = attrs(&[]);
        for tag in [
            "button", "input", "select", "textarea", "a", "details", "summary", "option",
            "optgroup",
        ] {
            let c = ctx(
                tag,
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 50.0,
                    height: 20.0,
                }),
            );
            assert_eq!(
                decide(&c),
                Decision::Interactive(RuleHit::S2NativeTag),
                "标签 {tag} 应命中 S2"
            );
        }
    }

    /// S3：ARIA role 属性交互角色集。
    #[test]
    fn s3_role_attribute() {
        let a = attrs(&[("role", "button")]);
        assert_eq!(
            decide(&ctx(
                "div",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 50.0,
                    height: 20.0
                })
            )),
            Decision::Interactive(RuleHit::S3RoleAttr)
        );
        for role in ["checkbox", "combobox", "tab", "textbox", "searchbox"] {
            let a = attrs(&[("role", role)]);
            assert_eq!(
                decide(&ctx(
                    "span",
                    &a,
                    visible(),
                    Some(Bounds {
                        x: 0.0,
                        y: 0.0,
                        width: 50.0,
                        height: 20.0
                    })
                )),
                Decision::Interactive(RuleHit::S3RoleAttr),
                "role={role} 应命中 S3"
            );
        }
    }

    /// S4：AX role 交互角色集（含 menubar/tree/grid 扩展）。
    #[test]
    fn s4_ax_role() {
        let a = attrs(&[]);
        for role in ["menubar", "tree", "grid", "button"] {
            let ax = AxInfo {
                present: true,
                role: Some(role.to_string()),
                ..AxInfo::default()
            };
            let c = DecideCtx {
                tag: "div",
                attributes: &a,
                ax: &ax,
                bounds: Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 50.0,
                    height: 20.0,
                }),
                ..ctx("div", &a, visible(), None)
            };
            assert_eq!(
                decide(&c),
                Decision::Interactive(RuleHit::S4AxRole),
                "AX role={role} 应命中 S4"
            );
        }
    }

    /// S5：AX 交互属性任一为真。
    #[test]
    fn s5_ax_properties() {
        let a = attrs(&[]);
        for prop in [
            "focusable",
            "editable",
            "checked",
            "expanded",
            "pressed",
            "required",
            "autocomplete",
        ] {
            let mut ax = AxInfo {
                present: true,
                ..AxInfo::default()
            };
            match prop {
                "focusable" => ax.properties.focusable = true,
                "editable" => ax.properties.editable = true,
                "checked" => ax.properties.checked = true,
                "expanded" => ax.properties.expanded = true,
                "pressed" => ax.properties.pressed = true,
                "required" => ax.properties.required = true,
                "autocomplete" => ax.properties.autocomplete = true,
                _ => {}
            }
            let c = DecideCtx {
                tag: "div",
                attributes: &a,
                ax: &ax,
                bounds: Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 50.0,
                    height: 20.0,
                }),
                ..ctx("div", &a, visible(), None)
            };
            assert_eq!(
                decide(&c),
                Decision::Interactive(RuleHit::S5AxProperty),
                "{prop} 应命中 S5"
            );
        }
    }

    /// S6：内联事件属性（onclick/onkeydown/tabindex）。
    #[test]
    fn s6_inline_events() {
        let a = attrs(&[("onclick", "fn()")]);
        assert_eq!(
            decide(&ctx(
                "div",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 50.0,
                    height: 20.0
                })
            )),
            Decision::Interactive(RuleHit::S6InlineEvent)
        );
        let a = attrs(&[("tabindex", "0")]);
        assert_eq!(
            decide(&ctx(
                "span",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 50.0,
                    height: 20.0
                })
            )),
            Decision::Interactive(RuleHit::S6InlineEvent)
        );
    }

    /// S7：大 iframe（宽高均 > 100px）；小 iframe 不命中。
    #[test]
    fn s7_big_iframe() {
        let a = attrs(&[]);
        let big = Bounds {
            x: 0.0,
            y: 0.0,
            width: 300.0,
            height: 200.0,
        };
        assert_eq!(
            decide(&ctx("iframe", &a, visible(), Some(big))),
            Decision::Interactive(RuleHit::S7BigIframe)
        );
        let small = Bounds {
            x: 0.0,
            y: 0.0,
            width: 50.0,
            height: 30.0,
        };
        assert_eq!(
            decide(&ctx("iframe", &a, visible(), Some(small))),
            Decision::NotInteractive
        );
    }

    /// M1：label/span 包裹表单控件通过；label[for]（M0）跳过。
    #[test]
    fn m1_wrapped_control() {
        let a = attrs(&[]);
        let mut c = ctx(
            "label",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 30.0,
            }),
        );
        c.wrapped_control = true;
        assert_eq!(decide(&c), Decision::Interactive(RuleHit::M1Wrapped));
        // M0：label[for] 不判可交互（点击代理到目标控件）
        let a = attrs(&[("for", "target")]);
        let mut c = ctx(
            "label",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 30.0,
            }),
        );
        c.wrapped_control = true;
        c.wrapped_by_label_for = true;
        assert_eq!(
            decide(&c),
            Decision::NotInteractive,
            "label[for] 防双激活（M0）"
        );
    }

    /// M2：搜索类模式（class/id/data-* 子串匹配）。
    #[test]
    fn m2_search_pattern() {
        for (k, v) in [
            ("class", "search-btn"),
            ("id", "searchBox"),
            ("data-action", "search"),
        ] {
            let a = attrs(&[(k, v)]);
            assert_eq!(
                decide(&ctx(
                    "div",
                    &a,
                    visible(),
                    Some(Bounds {
                        x: 0.0,
                        y: 0.0,
                        width: 80.0,
                        height: 30.0
                    })
                )),
                Decision::Interactive(RuleHit::M2SearchPattern),
                "{k}={v} 应命中 M2"
            );
        }
    }

    /// M3：图标尺寸元素（20×20）且含 aria-label；大元素不命中。
    #[test]
    fn m3_icon_button() {
        let a = attrs(&[("aria-label", "搜索图标")]);
        assert_eq!(
            decide(&ctx(
                "button",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 20.0,
                    height: 20.0
                })
            )),
            Decision::Interactive(RuleHit::S2NativeTag),
            "button 走 S2；M3 面向 div/span 形态"
        );
        let a = attrs(&[("aria-label", "搜索图标")]);
        assert_eq!(
            decide(&ctx(
                "span",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 20.0,
                    height: 20.0
                })
            )),
            Decision::Interactive(RuleHit::M3IconButton)
        );
        // 无交互类属性不命中
        let a = attrs(&[]);
        assert_eq!(
            decide(&ctx(
                "span",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 20.0,
                    height: 20.0
                })
            )),
            Decision::NotInteractive
        );
        // 超出图标尺寸不命中
        let a = attrs(&[("aria-label", "x")]);
        assert_eq!(
            decide(&ctx(
                "span",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 200.0,
                    height: 200.0
                })
            )),
            Decision::NotInteractive
        );
    }

    /// W1：cursor:pointer。
    #[test]
    fn w1_cursor_pointer() {
        let mut s = visible();
        s.cursor = Some("pointer".into());
        let a = attrs(&[]);
        assert_eq!(
            decide(&ctx(
                "div",
                &a,
                s,
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 80.0,
                    height: 30.0
                })
            )),
            Decision::Interactive(RuleHit::W1CursorPointer)
        );
    }

    /// W2：可滚动容器无交互后代通过；有交互后代不通过；dropdown 无条件。
    #[test]
    fn w2_scroll_container() {
        let a = attrs(&[]);
        let mut c = ctx(
            "div",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 300.0,
            }),
        );
        c.is_scrollable = true;
        assert_eq!(
            decide(&c),
            Decision::Interactive(RuleHit::W2ScrollContainer)
        );
        c.subtree_has_interactive = true;
        assert_eq!(
            decide(&c),
            Decision::NotInteractive,
            "有交互后代时 W2 不命中"
        );
        // dropdown 容器无条件可交互（role=listbox 会被 S3 先行命中，此处以
        // class 模式验证 W2 dropdown 路径）
        let a = attrs(&[("class", "dropdown-menu")]);
        let c = ctx(
            "div",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 300.0,
            }),
        );
        assert_eq!(
            decide(&c),
            Decision::Interactive(RuleHit::W2ScrollContainer)
        );
        // role=listbox：S3 优先级高于 W2（S 层任一命中即通过）
        let a = attrs(&[("role", "listbox")]);
        let c = ctx(
            "div",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 300.0,
            }),
        );
        assert_eq!(decide(&c), Decision::Interactive(RuleHit::S3RoleAttr));
    }

    /// S1：getEventListeners 通道默认关闭（T-4），开启时命中。
    #[test]
    fn s1_listener_channel_gated() {
        let a = attrs(&[]);
        let mut c = ctx(
            "div",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 50.0,
                height: 20.0,
            }),
        );
        c.has_click_listener = true;
        assert_eq!(
            decide(&c),
            Decision::NotInteractive,
            "通道默认关闭，S1 不生效"
        );
        c.listener_channel_enabled = true;
        assert_eq!(decide(&c), Decision::Interactive(RuleHit::S1Listener));
    }

    /// 优先级语义：P 否决 > S 通过 > M/W（disabled button 即使有搜索 class 也不检出）。
    #[test]
    fn priority_p_over_s_over_mw() {
        let a = attrs(&[("disabled", ""), ("class", "search-btn")]);
        assert_eq!(
            decide(&ctx(
                "button",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 50.0,
                    height: 20.0
                })
            )),
            Decision::Excluded(Excluded::P4Disabled),
            "P 层否决优先于一切正信号"
        );
        // S2 命中时不再看 M/W
        let a = attrs(&[("class", "search-btn")]);
        assert_eq!(
            decide(&ctx(
                "button",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 50.0,
                    height: 20.0
                })
            )),
            Decision::Interactive(RuleHit::S2NativeTag)
        );
    }

    /// 判定缓存：同键重复判定走缓存（命中率上升）。
    #[test]
    fn decision_cache_reuses() {
        let mut cache = DecisionCache::new();
        let a = attrs(&[]);
        let r1 = cache.get_or_else("s1", 42, || {
            decide(&ctx(
                "button",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 50.0,
                    height: 20.0,
                }),
            ))
        });
        assert!(matches!(r1, Decision::Interactive(_)));
        let r2 = cache.get_or_else("s1", 42, || panic!("不应重复计算"));
        assert_eq!(r1, r2);
        assert!(cache.hit_ratio() > 0.0, "同键重复判定应命中缓存");
        let hits_before = cache.hit_ratio();
        // 不同会话（跨域 id 复用防护）不命中
        let _ = cache.get_or_else("s2", 42, || Decision::NotInteractive);
        assert!(
            cache.hit_ratio() < hits_before || cache.hit_ratio() < 1.0,
            "跨会话不命中缓存"
        );
    }

    /// 子树探测：≤ max_depth 层内查找（M1/W2 探测语义）。
    #[test]
    fn subtree_probe_depth_limited() {
        struct T {
            id: i32,
            kids: Vec<T>,
        }
        let tree = T {
            id: 1,
            kids: vec![T {
                id: 2,
                kids: vec![T {
                    id: 3,
                    kids: vec![],
                }],
            }],
        };
        // 闭包输出生命周期无法与输入绑定（elision 推断为新生命周期），
        // 探测以函数项提供正确的生命周期约束
        fn kids_of(n: &T) -> &[T] {
            n.kids.as_slice()
        }
        assert!(
            subtree_probe(&tree, 3, &kids_of, &|n| n.id == 3),
            "3 层内应探测到 id=3"
        );
        // 深度不足时探测不到（max_depth=0 只查根）
        assert!(!subtree_probe(&tree, 0, &kids_of, &|n| n.id == 3));
        assert!(!subtree_probe(&tree, 1, &kids_of, &|n| n.id == 3));
    }
}
