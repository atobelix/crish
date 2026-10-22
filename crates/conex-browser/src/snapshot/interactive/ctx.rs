//! 判定上下文 DecideCtx 及其属性读取/信号探测辅助（自 interactive.rs 平移）。

use super::{
    DROPDOWN_CLASS_PATTERNS, DROPDOWN_ROLES, INTERACTIVE_DATA_PREFIXES, INTERACTIVE_ROLES,
    SEARCH_PATTERNS,
};
use crate::snapshot::collect::{AxInfo, Bounds, StyleInfo};

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
    pub(super) fn has_attr(&self, name: &str) -> bool {
        self.attributes
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case(name))
    }

    /// 交互角色判定（S3 属性 / S4 AX 共用）。
    pub(super) fn role_is_interactive(role: &str) -> bool {
        INTERACTIVE_ROLES
            .iter()
            .any(|r| r.eq_ignore_ascii_case(role))
    }

    /// 搜索模式命中（M2：class/id/data-* 属性小写化子串匹配）。
    pub(super) fn search_pattern_hit(&self) -> bool {
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
    pub(super) fn interactive_data_attr(&self) -> bool {
        self.attributes.iter().any(|(k, _)| {
            let lower = k.to_ascii_lowercase();
            INTERACTIVE_DATA_PREFIXES
                .iter()
                .any(|p| lower.starts_with(p))
        })
    }

    /// 图标按钮的「交互类属性」存在性（M3：class/role/onclick/data-action/aria-label）。
    pub(super) fn icon_interactive_attr(&self) -> bool {
        self.has_attr("class")
            || self.has_attr("role")
            || self.has_attr("onclick")
            || self.has_attr("data-action")
            || self.has_attr("aria-label")
    }

    /// dropdown 容器判定（W2：无条件可交互的容器形态）。
    pub(super) fn dropdown_container(&self) -> bool {
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
