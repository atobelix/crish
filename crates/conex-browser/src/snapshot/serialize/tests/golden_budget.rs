use super::*;

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
    assert!(
        !out.selector_map.contains_key(&111),
        "iframe 占位不分配索引（U-4）"
    );
    assert!(
        !out.selector_map.contains_key(&112),
        "canvas 盲区不分配索引"
    );

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
    let second = build_and_serialize(&fixture, &opts(&budgets, &previous).with_incremental(true));
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
    let third = build_and_serialize(&extended, &opts(&budgets, &previous).with_incremental(true));
    assert!(
        third.text.contains("*[300]<button>新按钮</button>"),
        "新增元素应带 * 前缀：\n{}",
        third.text
    );
    // 版本不连续（previous 为空）→ 全量视角，无 * 标记
    let fresh = build_and_serialize(&extended, &opts(&budgets, &HashSet::new()));
    assert!(
        !fresh.text.contains('*'),
        "无前驱时不得有 * 标记（全量视角）"
    );
}

/// 预算 1（深度）：超深子树折叠为「被截可交互元素计数」提示行。
#[test]
fn budget_depth_folds_deep_subtree() {
    let budgets = BudgetConfig {
        max_depth: 3,
        ..BudgetConfig::active()
    };
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
    let budgets = BudgetConfig {
        max_text_len: 10,
        ..BudgetConfig::active()
    };
    let long = "很长的描述文本超过十个字符的长度限制";
    let root = EnhancedNode::element("div", 1)
        .bounds(0.0, 0.0, 500.0, 100.0)
        .push(
            EnhancedNode::element("button", 2)
                .attr("title", long)
                .bounds(0.0, 0.0, 100.0, 36.0)
                .push(EnhancedNode::text_node(long, 3)),
        );
    let out = build_and_serialize(&[root], &opts(&budgets, &HashSet::new()));
    assert!(out.text.contains('…'), "截断应追加 … 后缀：\n{}", out.text);
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
    assert!(
        out.text.contains("truncated by output budget"),
        "应有输出预算截断标记"
    );
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
