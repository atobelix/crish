//! snapshot::interactive 单元测试：公共构造辅助（自 interactive.rs 平移）。

use super::*;
use crate::snapshot::collect::{AxInfo, Bounds, StyleInfo};

mod mw_priority_cache;
mod p_layer;
mod s_layer;

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
