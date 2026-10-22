//! P/S/M/W 四层判定规则（自 interactive.rs 平移）。

use super::{
    DecideCtx, Decision, Excluded, RuleHit, AX_EXTENDED_ROLES, INLINE_EVENT_ATTRS,
    NATIVE_INTERACTIVE_TAGS, SVG_DECORATIVE_TAGS,
};

/// P 层排除前置（P2-P6 短路否决；P1 非元素节点由调用方短路）。
pub(super) fn p_layer(ctx: &DecideCtx) -> Option<Decision> {
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
pub(super) fn s_layer(ctx: &DecideCtx) -> Option<Decision> {
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
pub(super) fn m_layer(ctx: &DecideCtx) -> Option<Decision> {
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
pub(super) fn w_layer(ctx: &DecideCtx) -> Option<Decision> {
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
