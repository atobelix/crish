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
