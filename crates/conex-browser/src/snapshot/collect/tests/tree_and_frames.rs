use super::*;

/// DOMSnapshot 响应重建：字符串池 + parent_index + layout + AX 合并。
/// 构造确定性输入（fixture JSON 形状），验证解析/绑定/合并逻辑。
#[test]
fn build_tree_from_capture_response() {
    // strings 池：0=空、1=DIV、2=#text、3=BUTTON、4=登录、5=class、6=btn
    let capture: CaptureSnapshotResult = serde_json::from_value(serde_json::json!({
        "strings": ["", "DIV", "#text", "BUTTON", "登录", "class", "btn"],
        "documents": [{
            "documentURL": "https://example.com",
            "title": "示例",
            "nodeCount": 5,
            "nodes": {
                "parentIndex": [-1, 0, 1, 0, -1],
                "nodeType": [1, 1, 3, 1, 1],
                "nodeName": [1, 3, 2, 3, 3],
                "nodeValue": [-1, -1, 4, -1, -1],
                "backendDOMNodeId": [10, 11, 12, 13, 20],
                "attributes": [
                    [],
                    [5, 6],
                    [],
                    [],
                    []
                ],
                "childNodeIndexes": [1, 3, -1, -1, -1]
            },
            "layout": {
                "nodeIndex": [0, 1, 3],
                "bounds": [
                    [0, 0, 800, 600],
                    [10, 10, 120, 36],
                    [140, 10, 100, 30]
                ]
            }
        }]
    }))
    .expect("capture fixture 解析失败");
    let document: GetDocumentResult = serde_json::from_value(serde_json::json!({
        "root": { "nodeId": 1, "backendNodeId": 10, "nodeType": 1, "nodeName": "DIV", "attributes": [], "children": [] }
    }))
    .expect("getDocument fixture 解析失败");
    let ax: Vec<AXNode> = serde_json::from_value(serde_json::json!([
        {
            "nodeId": "1",
            "ignored": false,
            "role": { "type": "role", "value": "button" },
            "name": { "type": "string", "value": "登录" },
            "properties": [
                { "name": "focusable", "value": { "type": "boolean", "value": true } }
            ],
            "backendDOMNodeId": 13
        }
    ]))
    .expect("AX fixture 解析失败");

    let roots = build_enhanced_tree(&capture, &document, &ax);
    assert_eq!(roots.len(), 2, "两个根（parent=-1 的两棵子树）");

    let root = roots
        .iter()
        .find(|r| r.backend_node_id == 10)
        .expect("DIV 根应存在");
    assert_eq!(root.tag.as_deref(), Some("div"));
    assert_eq!(root.bounds.unwrap().width, 800.0);

    let btn = root
        .children
        .iter()
        .find(|c| c.backend_node_id == 11)
        .expect("BUTTON 应挂接在 DIV 下");
    assert_eq!(btn.tag.as_deref(), Some("button"));
    assert_eq!(btn.get_attr("class"), Some("btn"));
    assert_eq!(btn.bounds.unwrap().width, 120.0);
    // 文本子节点（登录）
    assert_eq!(btn.children.len(), 1);
    assert_eq!(btn.children[0].text.as_deref(), Some("登录"));
    // 无 AX 数据时保持缺省
    assert!(!btn.ax.present);

    // AX 合并：backend 13 的按钮获得 role/name/focusable
    let ax_btn = root
        .children
        .iter()
        .find(|c| c.backend_node_id == 13)
        .expect("AX 目标按钮应挂接在 DIV 下");
    assert_eq!(ax_btn.ax.role.as_deref(), Some("button"));
    assert_eq!(ax_btn.ax.name.as_deref(), Some("登录"));
    assert!(ax_btn.ax.properties.focusable);

    // 未匹配 AX 的节点不受影响
    let second = roots
        .iter()
        .find(|r| r.backend_node_id == 20)
        .expect("第二个根应存在");
    assert_eq!(second.tag.as_deref(), Some("button"));
    assert!(!second.ax.present, "无 AX 数据时 present 保持 false");
}

/// 文档数上限护栏（MAX_IFRAMES=64）。
#[test]
fn capture_documents_capped_at_max_iframes() {
    let mut documents = Vec::new();
    for i in 0..70 {
        documents.push(serde_json::json!({
            "documentURL": format!("https://f{i}.example"),
            "title": "",
            "nodeCount": 1,
            "nodes": {
                "parentIndex": [-1],
                "nodeType": [9],
                "nodeName": [0],
                "nodeValue": [-1],
                "backendDOMNodeId": [i],
                "childNodeIndexes": [-1]
            },
            "layout": { "nodeIndex": [], "bounds": [] }
        }));
    }
    let capture: CaptureSnapshotResult = serde_json::from_value(serde_json::json!({
        "strings": [""],
        "documents": documents
    }))
    .expect("fixture 解析失败");
    let document: GetDocumentResult = serde_json::from_value(serde_json::json!({
        "root": { "nodeId": 1 }
    }))
    .unwrap();
    let roots = build_enhanced_tree(&capture, &document, &[]);
    assert_eq!(roots.len(), MAX_IFRAMES, "文档数应截断到 64");
}

/// 回归（联调 E2 根因）：Chrome 151 实测响应形态必须可解析——`backendNodeId`
/// 字段名（非旧文档 backendDOMNodeId）、稀疏数据映射（Rare*Data {index,value}）、
/// `nodeCount`/`childNodeIndexes` 缺失、documentURL/title 为字符串池下标。
/// 全部断言使用真实浏览器抓取的响应原样。
#[test]
fn capture_chrome151_real_shape_parses() {
    let raw = serde_json::json!({
        "strings": [
            "data:text/html;charset=utf-8,%3Cinput%3E",
            "联调测试页",
            "#document", "HTML", "HEAD", "BODY", "INPUT", "id", "name",
            "BUTTON", "中文按钮", "#text", "\n"
        ],
        "documents": [{
            "documentURL": 0,
            "title": 1,
            "nodes": {
                "attributes": [[], [7, 8], [], [], [11, 12], [], []],
                "backendNodeId": [2, 3, 4, 5, 1, 6, 7],
                "contentDocumentIndex": { "index": [], "value": [] },
                "currentSourceURL": { "index": [], "value": [] },
                "inputChecked": { "index": [] },
                "inputValue": { "index": [4], "value": [-1] },
                "isClickable": { "index": [4] },
                "nodeName": [3, 4, 5, 6, 9, 10, 12],
                "nodeType": [9, 1, 1, 1, 1, 1, 3],
                "nodeValue": [-1, -1, -1, -1, -1, -1, 11],
                "optionSelected": { "index": [] },
                "originURL": { "index": [], "value": [] },
                "parentIndex": [-1, 0, 1, 1, 3, 3, 5],
                "pseudoIdentifier": { "index": [], "value": [] },
                "pseudoType": { "index": [], "value": [] },
                "shadowRootType": { "index": [], "value": [] },
                "textValue": { "index": [], "value": [] }
            },
            "layout": {
                "bounds": [[0, 0, 1262, 624], [8, 8, 1246, 608], [8, 8, 177, 21], [185, 8, 23, 21], [193, 11, 7, 15]],
                "clientRects": [[], [0, 0, 1262, 624], [2, 2, 173, 17], [2, 2, 19, 17], []],
                "nodeIndex": [0, 1, 3, 4, 5],
                "offsetRects": [[], [0, 0, 1246, 608], [8, 8, 177, 21], [185, 8, 23, 21], []],
                "paintOrders": [0, 1, 2, 1, 1],
                "scrollRects": [[], [0, 0, 1262, 624], [0, 0, 173, 17], [0, 0, 19, 17], []],
                "stackingContexts": { "index": [0] },
                "styles": [[], [], [], [], []]
            },
            "textBoxes": { "nodeIndex": [], "bounds": [], "runs": [] },
            "baseURL": 0,
            "contentLanguage": "zh-CN",
            "encodingName": "UTF-8",
            "frameId": "F1",
            "publicId": "",
            "systemId": "",
            "scrollOffsetX": 0,
            "scrollOffsetY": 0,
            "contentWidth": 1262,
            "contentHeight": 624
        }]
    });
    let capture: CaptureSnapshotResult =
        serde_json::from_value(raw).expect("Chrome 151 真实形态解析失败（协议漂移回归）");
    let doc = &capture.documents[0];
    // documentURL/title 为字符串池下标 → 池解析
    assert_eq!(
        doc.document_url.as_ref().unwrap().resolve(&capture.strings),
        "data:text/html;charset=utf-8,%3Cinput%3E",
        "documentURL 应经字符串池解析"
    );
    assert_eq!(
        doc.title.as_ref().unwrap().resolve(&capture.strings),
        "联调测试页",
        "title 应经字符串池解析"
    );
    // 稀疏数据映射形态
    assert_eq!(doc.nodes.input_value.as_ref().unwrap().index, vec![4]);
    assert_eq!(doc.nodes.input_value.as_ref().unwrap().value, vec![-1]);
    // backendNodeId（新字段名）绑定
    assert_eq!(
        doc.nodes.backend_dom_node_id.as_ref().unwrap().len(),
        7,
        "backendNodeId 数组应完整解析"
    );
    // 整链：增强树后端 id 可用（click/type 输入面）
    let document: GetDocumentResult = serde_json::from_value(serde_json::json!({
        "root": { "nodeId": 1, "backendNodeId": 1, "nodeType": 9, "nodeName": "#document", "attributes": [], "children": [] }
    }))
    .unwrap();
    let roots = build_enhanced_tree(&capture, &document, &[]);
    assert!(
        roots
            .iter()
            .any(|r| r.subtree_has(8, &|n| n.backend_node_id == 1)),
        "增强树应携带 backendNodeId（新字段名解析）"
    );
}

// =======================================================================
// 跨域 iframe 递归（维度 13 §1.5 二期，U-4）
// =======================================================================

/// 帧候选筛选（纯函数）：pierce 排除 / 去重 / 深度预算 / 帧数预算 / 载荷预算。
#[test]
fn frame_candidate_eligible_filters() {
    let pierced: HashSet<String> = ["MAIN"].iter().map(|s| s.to_string()).collect();
    let mut visited: HashSet<String> = HashSet::new();
    let mut stats = CrossOriginStats::default();
    let budget = FrameBudget::new(64, HARD_RAW_PAYLOAD_BYTES);

    // 同源 pierce 已覆盖 → 排除（不占统计）
    assert!(!frame_candidate_eligible(
        "MAIN",
        &pierced,
        &mut visited,
        0,
        &budget,
        &mut stats
    ));
    // 合格帧 → 通过并入 visited
    assert!(frame_candidate_eligible(
        "F1",
        &pierced,
        &mut visited,
        0,
        &budget,
        &mut stats
    ));
    // 去重：已访问帧 → 排除（防环/重复子树防御）
    assert!(!frame_candidate_eligible(
        "F1",
        &pierced,
        &mut visited,
        0,
        &budget,
        &mut stats
    ));
    assert_eq!(stats.skipped_budget, 0, "pierce/去重不占预算统计");

    // 深度预算：父深度 4 → 子帧深度 5 > max_iframe_depth=4 → 截断
    assert!(!frame_candidate_eligible(
        "D5",
        &pierced,
        &mut visited,
        4,
        &budget,
        &mut stats
    ));
    assert_eq!(stats.skipped_budget, 1);
    // 父深度 3 → 子帧深度 4 = 上限内
    assert!(frame_candidate_eligible(
        "D4",
        &pierced,
        &mut visited,
        3,
        &budget,
        &mut stats
    ));

    // 帧数预算耗尽（max_iframes=64 共用）→ 截断
    let exhausted = FrameBudget::new(0, HARD_RAW_PAYLOAD_BYTES);
    assert!(!frame_candidate_eligible(
        "B0",
        &pierced,
        &mut visited,
        0,
        &exhausted,
        &mut stats
    ));
    // 载荷预算耗尽（512KB 硬护栏，T-2/46）→ 截断
    let no_payload = FrameBudget::new(64, 0);
    assert!(!frame_candidate_eligible(
        "P0",
        &pierced,
        &mut visited,
        0,
        &no_payload,
        &mut stats
    ));
    assert_eq!(stats.skipped_budget, 3);
}

/// 尺寸门限（§1.5：≥ 10px×10px 才进入；无法确认尺寸不进入——保守）。
#[test]
fn iframe_size_gate() {
    let min = Bounds {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    };
    assert!(iframe_size_qualified(Some(min)), "恰好 10px 应通过");
    let big = Bounds {
        x: 0.0,
        y: 0.0,
        width: 320.0,
        height: 240.0,
    };
    assert!(iframe_size_qualified(Some(big)));
    let narrow = Bounds {
        x: 0.0,
        y: 0.0,
        width: 9.0,
        height: 300.0,
    };
    assert!(!iframe_size_qualified(Some(narrow)), "宽 < 10px 不进入");
    let thin = Bounds {
        x: 0.0,
        y: 0.0,
        width: 300.0,
        height: 5.0,
    };
    assert!(!iframe_size_qualified(Some(thin)), "高 < 10px 不进入");
    assert!(
        !iframe_size_qualified(None),
        "无法确认尺寸 → 不进入（保守占位）"
    );
}

/// owner 定位辅助：src URL 兜底匹配 / bounds 查找 / `|IFRAME|` 标记。
#[test]
fn owner_locators_and_marker() {
    let root = EnhancedNode::element("div", 1)
        .push(
            EnhancedNode::element("iframe", 2)
                .attr("src", "https://b.example/x")
                .bounds(0.0, 0.0, 320.0, 240.0),
        )
        .push(EnhancedNode::element("button", 3));
    let mut roots = vec![root];

    // src URL 兜底（§1.5：getFrameOwner 失败时按 src 精确匹配）
    assert_eq!(find_owner_by_src(&roots, "https://b.example/x"), Some(2));
    assert_eq!(find_owner_by_src(&roots, "https://other.example"), None);
    // bounds 查找（尺寸门限输入）
    let b = find_node_bounds(&roots, 2).expect("owner bounds 应可查");
    assert!(b.width > 300.0 && b.height > 200.0);
    assert!(find_node_bounds(&roots, 999).is_none());
    // 标记（递归成功与占位两路共用；打点后序列化呈现 |IFRAME|）
    assert!(mark_owner_iframe(&mut roots, 2), "命中 owner 应打标记");
    assert_eq!(roots[0].children[0].frame_marker, Some(FrameMarker::Iframe));
    assert!(!mark_owner_iframe(&mut roots, 999), "未命中不误标");
    // 标记不影响子树结构
    assert_eq!(roots[0].children.len(), 2);
}

/// 跨域合并的序列化面：子帧根树独立呈现 + `|IFRAME|` 标记 + 索引不碰撞
/// （跨会话 backendNodeId 复用 → 合成索引兜底，模块注释「索引协调选择」）。
#[test]
fn cross_frame_merge_serialization_indices_unique() {
    // 主树：iframe owner(101) + 按钮(202)；子帧树：按钮(202)——跨会话 id 复用
    let main_root = EnhancedNode::element("#document", 1)
        .push(
            EnhancedNode::element("iframe", 101)
                .attr("src", "https://b.example/embed")
                .bounds(0.0, 0.0, 320.0, 240.0),
        )
        .push(
            EnhancedNode::element("button", 202)
                .push(EnhancedNode::text_node("主按钮", 203))
                .bounds(10.0, 10.0, 120.0, 36.0),
        );
    let frame_root = EnhancedNode::element("#document", 1001).push(
        EnhancedNode::element("button", 202)
            .push(EnhancedNode::text_node("帧按钮", 1002))
            .bounds(0.0, 0.0, 100.0, 30.0),
    );
    let mut roots = vec![main_root];
    // 模拟递归路径：owner 定位后打标记 + 子帧根树并入根森林
    assert!(mark_owner_iframe(&mut roots, 101));
    roots.push(frame_root);

    let budgets = BudgetConfig::active().with_cross_origin_iframes(true);
    let out = build_and_serialize(
        &roots,
        &SerializeOptions::new(&budgets, "S1", &HashSet::new()),
    );
    // |IFRAME| 标记行（src 属性经白名单序列化）
    assert!(
        out.text
            .contains("|IFRAME|<iframe src=https://b.example/embed"),
        "iframe 占位/标记行应呈现：{}",
        out.text
    );
    // 两个按钮均入树且索引互不相同（碰撞 → 合成索引）
    assert!(
        out.text.contains("<button>主按钮</button>"),
        "主树按钮应入树"
    );
    assert!(
        out.text.contains("<button>帧按钮</button>"),
        "子帧按钮应入树（独立根树）"
    );
    let mut indices: Vec<u32> = Vec::new();
    for line in out.text.lines() {
        if let Some(rest) = line.split('[').nth(1) {
            if let Some(close) = rest.find(']') {
                if let Ok(n) = rest[..close].parse::<u32>() {
                    indices.push(n);
                }
            }
        }
    }
    assert_eq!(indices.len(), 2, "两个按钮共 2 个索引：{indices:?}");
    let unique: HashSet<u32> = indices.iter().copied().collect();
    assert_eq!(
        unique.len(),
        indices.len(),
        "跨会话 id 复用不得产生索引碰撞：{indices:?}"
    );
    assert!(
        unique.contains(&202),
        "默认索引 = backendNodeId：{indices:?}"
    );
    // 合成索引：从简化树内全部 backendNodeId 的 max+1 起——文本节点被元素
    // 行吸收（inline_text）不进简化树，树内 id 集 = {1,101,202,1001} →
    // max=1001 → 子帧按钮（跨会话复用 202）合成索引 = 1002
    assert!(
        indices.contains(&1002),
        "跨会话 id 复用应分配合成索引：{indices:?}"
    );
    // selector_map 两条目（执行面跨帧会话归属为遗留交接项，此处仅断言映射存在）
    assert_eq!(out.selector_map.len(), 2);
    assert!(out.selector_map.values().all(|r| r.backend_node_id == 202));
}
