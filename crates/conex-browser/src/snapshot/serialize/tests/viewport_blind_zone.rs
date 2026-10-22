use super::*;

/// 视口外折叠：超出视口 + 1000px 缓冲且不可滚动到达 → 滚动提示行。
#[test]
fn serialize_viewport_outside_folds() {
    let budgets = BudgetConfig::active();
    let previous = HashSet::new();
    let root = EnhancedNode::element("div", 1)
        .bounds(0.0, 0.0, 500.0, 500.0)
        .push(
            EnhancedNode::element("button", 2).bounds(0.0, 5000.0, 100.0, 30.0), // 远超出视口
        );
    let mut o = opts(&budgets, &previous);
    o.viewport = Some(Bounds {
        x: 0.0,
        y: 0.0,
        width: 1280.0,
        height: 800.0,
    });
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
        .push(EnhancedNode::element("button", 2).bounds(0.0, 5000.0, 100.0, 30.0));
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
