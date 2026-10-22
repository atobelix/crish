use super::*;

/// 跨域递归开启（配置位 true）：mock CDP 全链路——帧树 → owner 定位 →
/// 尺寸门限 → attach → 子帧采集 → 子根树并入 → detach；断言 iframe
/// 标记、子文档根、预算/会话统计与索引不碰撞。
#[tokio::test]
async fn collect_cross_origin_recursion_enabled() {
    let mut mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    // 帧树（MAIN 嵌跨域 F1，无孙帧——深度预算/去重路径由纯函数测试覆盖）
    mock.set_auto_reply(
        crate::cdp::domains::names::PAGE_GET_FRAME_TREE,
        MockReply::Ok(json!({
            "frameTree": {
                "frame": { "id": "MAIN", "url": "https://a.example", "mimeType": "text/html" },
                "childFrames": [{
                    "frame": { "id": "F1", "url": "https://b.example/embed", "parentId": "MAIN", "mimeType": "text/html" },
                    "childFrames": []
                }]
            }
        })),
    );
    // owner 定位：DOM.getFrameOwner(F1) → 主树 iframe(101)
    mock.set_auto_reply(
        crate::cdp::domains::names::DOM_GET_FRAME_OWNER,
        MockReply::Ok(json!({ "backendNodeId": 101, "nodeId": 3 })),
    );
    // 其余采集通道自动应答
    mock.set_auto_reply(
        crate::cdp::domains::names::DOM_GET_DOCUMENT,
        MockReply::Ok(json!({ "root": { "nodeId": 1, "backendNodeId": 1, "nodeType": 9, "nodeName": "#document", "attributes": [], "children": [] } })),
    );
    mock.set_auto_reply(
        crate::cdp::domains::names::PAGE_GET_LAYOUT_METRICS,
        MockReply::Ok(json!({
            "layoutViewport": { "pageX": 0.0, "pageY": 0.0, "clientWidth": 1280.0, "clientHeight": 800.0, "scale": 1.0 },
            "visualViewport": { "offsetX": 0.0, "offsetY": 0.0, "pageX": 0.0, "pageY": 0.0, "clientWidth": 1280.0, "clientHeight": 800.0, "scale": 1.0 }
        })),
    );
    mock.set_auto_reply(
        crate::cdp::domains::names::ACCESSIBILITY_GET_FULL_AX_TREE,
        MockReply::Ok(json!({ "nodes": [] })),
    );
    // captureSnapshot 手工应答（主/帧会话内容不同，按到达顺序两阶段应答）
    let session = connect_mock(&mock, "/devtools/browser/xframe-on").await;
    let collector = CdpCollector::new(
        session.clone(),
        BudgetConfig::active().with_cross_origin_iframes(true),
    );
    let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
    drive_capture_snapshot(&mut mock, main_capture_fixture()).await;
    drive_capture_snapshot(&mut mock, frame_capture_fixture()).await;
    let collected = collect_task
        .await
        .expect("采集任务应完成")
        .expect("采集应成功");
    session.shutdown().await;

    // —— 统计：1 帧递归 + 1 attach + 1 detach，无截断无失败 ——
    assert_eq!(
        collected.cross_origin,
        CrossOriginStats {
            frames_collected: 1,
            sessions_attached: 1,
            sessions_detached: 1,
            ..CrossOriginStats::default()
        },
        "跨域递归统计：{:#?}",
        collected.cross_origin
    );

    // —— 主树：iframe owner 打 |IFRAME| 标记（src 属性白名单呈现）——
    let main_root = collected
        .roots
        .iter()
        .find(|r| r.backend_node_id == 1)
        .expect("主文档根应存在");
    let owner =
        find_node_by_id(std::slice::from_ref(main_root), 101).expect("iframe owner 应保留在树中");
    assert_eq!(owner.frame_marker, Some(FrameMarker::Iframe));
    assert_eq!(owner.get_attr("src"), Some("https://b.example/embed"));

    // —— 子文档独立根树（frameId=F1 内容并入根森林）——
    let frame_root = collected
        .roots
        .iter()
        .find(|r| r.backend_node_id == 1001)
        .expect("子帧文档根应并入");
    assert!(
        find_node_by_id(std::slice::from_ref(frame_root), 202).is_some(),
        "子帧按钮应入树"
    );

    // —— 序列化面：|IFRAME| 标记 + 索引唯一（跨会话 backendNodeId 复用
    //    ——主/帧按钮同 202——由合成索引消解，模块注释「索引协调选择」）——
    let budgets = BudgetConfig::active().with_cross_origin_iframes(true);
    let out = build_and_serialize(
        &collected.roots,
        &SerializeOptions::new(&budgets, "S1", &HashSet::new()),
    );
    assert!(
        out.text
            .contains("|IFRAME|<iframe src=https://b.example/embed"),
        "序列化应呈现 iframe 占位/标记：{}",
        out.text
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
    assert_eq!(indices.len(), 2, "主/帧两个按钮各一个索引：{indices:?}");
    let unique: HashSet<u32> = indices.iter().copied().collect();
    assert_eq!(unique.len(), indices.len(), "索引不得碰撞：{indices:?}");
}

/// 跨域递归关闭（配置位默认 false——一期行为）：不取帧树、不建帧会话、
/// 子帧内容不进树、iframe 不打标记；统计全零。
#[tokio::test]
async fn collect_cross_origin_recursion_disabled_default() {
    let mut mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    mock.set_auto_reply(
        crate::cdp::domains::names::DOM_GET_DOCUMENT,
        MockReply::Ok(json!({ "root": { "nodeId": 1, "backendNodeId": 1, "nodeType": 9, "nodeName": "#document", "attributes": [], "children": [] } })),
    );
    mock.set_auto_reply(
        crate::cdp::domains::names::PAGE_GET_LAYOUT_METRICS,
        MockReply::Ok(json!({
            "layoutViewport": { "pageX": 0.0, "pageY": 0.0, "clientWidth": 1280.0, "clientHeight": 800.0, "scale": 1.0 },
            "visualViewport": { "offsetX": 0.0, "offsetY": 0.0, "pageX": 0.0, "pageY": 0.0, "clientWidth": 1280.0, "clientHeight": 800.0, "scale": 1.0 }
        })),
    );
    mock.set_auto_reply(
        crate::cdp::domains::names::ACCESSIBILITY_GET_FULL_AX_TREE,
        MockReply::Ok(json!({ "nodes": [] })),
    );
    // 帧树/owner 应答**故意注册**（负向对照）：若配置位被破坏为恒开启，
    // 递归路径将真实执行 → 下述「无标记/无子帧/统计全零」断言即失败；
    // 配置位正确时这些命令根本不会发出（无触网、无挂起）。
    mock.set_auto_reply(
        crate::cdp::domains::names::PAGE_GET_FRAME_TREE,
        MockReply::Ok(json!({
            "frameTree": {
                "frame": { "id": "MAIN", "url": "https://a.example", "mimeType": "text/html" },
                "childFrames": [{
                    "frame": { "id": "F1", "url": "https://b.example/embed", "parentId": "MAIN", "mimeType": "text/html" },
                    "childFrames": []
                }]
            }
        })),
    );
    mock.set_auto_reply(
        crate::cdp::domains::names::DOM_GET_FRAME_OWNER,
        MockReply::Ok(json!({ "backendNodeId": 101, "nodeId": 3 })),
    );

    let session = connect_mock(&mock, "/devtools/browser/xframe-off").await;
    let collector = CdpCollector::new(session.clone(), BudgetConfig::active());
    let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
    drive_capture_snapshot(&mut mock, main_capture_fixture()).await;
    let collected = collect_task
        .await
        .expect("采集任务应完成")
        .expect("采集应成功");
    session.shutdown().await;

    // 一期行为：仅主文档根树；子帧内容不进入；统计全零；但 iframe 元素
    // 恒打 |IFRAME| 占位标记（13 §1.5/§3.2——占位是一期语义，与递归开关
    // 无关；关闭态不打标记的旧断言与文档冲突，2026-08-12 修正）
    assert_eq!(collected.roots.len(), 1, "关闭态仅主文档根树");
    assert!(
        find_node_by_id(&collected.roots, 1001).is_none(),
        "子帧内容不得入树"
    );
    let owner = find_node_by_id(&collected.roots, 101).expect("iframe 元素仍在树中");
    assert_eq!(
        owner.frame_marker,
        Some(FrameMarker::Iframe),
        "iframe 元素恒打 |IFRAME| 占位标记（一期占位语义，不依赖递归开关）"
    );
    // 序列化面闭环：占位标记行（src 属性经白名单呈现）
    let out = build_and_serialize(
        &collected.roots,
        &SerializeOptions::new(&BudgetConfig::active(), "S1", &HashSet::new()),
    );
    assert!(
        out.text
            .contains("|IFRAME|<iframe src=https://b.example/embed"),
        "关闭态也应呈现 |IFRAME| 占位：{}",
        out.text
    );
    assert_eq!(collected.cross_origin, CrossOriginStats::default());
}
