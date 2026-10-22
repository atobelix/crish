use super::*;

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
    assert!(
        out.text.contains("中文按钮😀👍"),
        "emoji 代理对不得破坏结构"
    );
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
            EnhancedNode::element("option", 10 + i).push(EnhancedNode::text_node(city, 100 + i)),
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
        out.text
            .contains("options=\"北京|上海|深圳|广州|...(3 more)\""),
        "select 展开应前 4 项 + 省略计数（值含空格加引号）：\n{}",
        out.text
    );
    assert!(
        out.text.contains("format=YYYY-MM-DD"),
        "日期输入应附 ISO 格式提示"
    );
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
        (
            10,
            Bounds {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 40.0,
            },
        ),
        (
            20,
            Bounds {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 40.0,
            },
        ),
    ];
    let out = build_and_serialize(&[root], &o);
    // 被覆盖按钮：保留文本行但无索引
    assert!(out.text.contains("被遮挡按钮"), "被遮盖节点保留文本行");
    assert!(
        !out.selector_map.contains_key(&10),
        "被遮盖节点不给交互索引"
    );
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
            EnhancedNode::element("svg", 4)
                .bounds(0.0, 80.0, 100.0, 100.0)
                .push(
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
