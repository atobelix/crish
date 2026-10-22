use super::*;

// =======================================================================
// DOM.getDocument 性能护栏（depth 受限 + 预算联动降级，T-2 复核轮）
// =======================================================================

/// 巨大结构通道应答：attributes 塞入 12000 条长属性（模拟全深度序列化
/// 响应，单通道体积 > 150KB 预算余量）。
fn huge_document_fixture() -> Value {
    let attrs: Vec<String> = (0..12000)
        .map(|i| format!("data-attr-{i}={}", "x".repeat(20)))
        .collect();
    json!({ "root": { "nodeId": 1, "attributes": attrs } })
}

/// 大载荷快照应答：字符串池塞入 count 条 fill 字符串（膨胀主通道体积）。
fn big_snapshot_fixture(count: usize, fill: &str) -> Value {
    let mut strings = vec![String::new()];
    for i in 0..count {
        strings.push(format!("{fill}-{i}"));
    }
    json!({
        "strings": strings,
        "documents": [{
            "documentURL": 1,
            "title": 0,
            "nodes": {
                "parentIndex": [-1],
                "nodeType": [9],
                "nodeName": [0],
                "nodeValue": [-1],
                "backendDOMNodeId": [1],
                "attributes": [[]],
                "childNodeIndexes": [-1]
            },
            "layout": { "nodeIndex": [], "bounds": [] }
        }]
    })
}

/// 主采集四路并行非关键通道的自动应答（布局/AX）。
fn fill_noncritical_auto_replies(mock: &MockServer) {
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
}

/// 性能修复：DOM.getDocument 深度受限（GET_DOCUMENT_DEPTH=15 而非 -1
/// 全深度）——捕获实际发出的命令参数断言（防回归为全深度序列化，
/// bench 实测中页面全深度 getDocument 215KB ≈ DOMSnapshot 85KB 的 2.5 倍）。
#[tokio::test]
async fn get_document_depth_bounded_not_full() {
    let mut mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    fill_noncritical_auto_replies(&mock);
    let session = connect_mock(&mock, "/devtools/browser/depth-bounded").await;
    let collector = CdpCollector::new(session.clone(), BudgetConfig::active());
    let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
    drive_capture_snapshot(&mut mock, main_capture_fixture()).await;
    // 捕获实际发出的 getDocument 命令（restore 流程命令已被自动应答跳过）
    let cmd = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        mock.expect_command(crate::cdp::domains::names::DOM_GET_DOCUMENT),
    )
    .await
    .expect("等待 DOM.getDocument 命令超时");
    assert_eq!(
        cmd["params"]["depth"], GET_DOCUMENT_DEPTH,
        "结构通道深度应受限而非全深度：{cmd}"
    );
    assert_eq!(cmd["params"]["pierce"], true, "pierce 语义保持：{cmd}");
    mock.reply(
        cmd["id"].as_u64().expect("命令 id"),
        json!({ "root": { "nodeId": 1 } }),
    );
    let collected = collect_task
        .await
        .expect("采集任务应完成")
        .expect("采集应成功");
    session.shutdown().await;
    assert_eq!(collected.roots.len(), 1, "主文档根树不受深度限制影响");
}

/// payload 分解（任务书断言面）：中页面场景——主通道小、结构通道巨大
/// （合计 >150KB）→ **采集成功不失败**，结构通道降级丢弃，raw_payload_bytes
/// 仅计主通道（预算内）；主树结构完整不丢。
#[tokio::test]
async fn payload_decomposition_degrades_get_document_only() {
    let mut mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    fill_noncritical_auto_replies(&mock);
    mock.set_auto_reply(
        crate::cdp::domains::names::DOM_GET_DOCUMENT,
        MockReply::Ok(huge_document_fixture()),
    );
    let session = connect_mock(&mock, "/devtools/browser/payload-degrade").await;
    let collector = CdpCollector::new(session.clone(), BudgetConfig::active());
    let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
    drive_capture_snapshot(&mut mock, main_capture_fixture()).await;
    let collected = collect_task
        .await
        .expect("采集任务应完成")
        .expect("结构通道超预算应降级而非失败");
    session.shutdown().await;

    // 分解断言：payload = 主通道字节（结构通道丢弃），≤ 150KB 预算
    let snapshot_bytes = main_capture_fixture().to_string().len();
    assert_eq!(
        collected.raw_payload_bytes, snapshot_bytes,
        "降级后 payload 应仅计 DOMSnapshot 主通道"
    );
    assert!(
        collected.raw_payload_bytes <= MAX_RAW_PAYLOAD_BYTES,
        "降级后总载荷应受控：{}B",
        collected.raw_payload_bytes
    );
    // 主树完整（降级不丢结构）：iframe owner 与按钮均在
    assert_eq!(collected.roots.len(), 1, "降级不产生额外根树");
    let main_root = &collected.roots[0];
    assert!(find_node_by_id(std::slice::from_ref(main_root), 101).is_some());
    assert!(find_node_by_id(std::slice::from_ref(main_root), 202).is_some());
}

/// 主通道硬错误语义保持：DOMSnapshot 自身超 512KB 硬护栏 → PayloadOverflow
/// （主数据缺失无法降级，与结构通道降级严格区分；46 复核后硬护栏从
/// 150KB 提升至 512KB——150KB 仅作常规合计降级触发阈值）。
#[tokio::test]
async fn snapshot_over_budget_remains_hard_error() {
    let mut mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    fill_noncritical_auto_replies(&mock);
    mock.set_auto_reply(
        crate::cdp::domains::names::DOM_GET_DOCUMENT,
        MockReply::Ok(json!({ "root": { "nodeId": 1 } })),
    );
    let session = connect_mock(&mock, "/devtools/browser/snapshot-overflow").await;
    let collector = CdpCollector::new(session.clone(), BudgetConfig::active());
    let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
    // 主通道 3000 条长字符串（200 字符）≈ 618KB > 512KB 硬护栏
    drive_capture_snapshot(&mut mock, big_snapshot_fixture(3000, &"y".repeat(200))).await;
    let res = collect_task.await.expect("采集任务应完成");
    session.shutdown().await;
    assert!(
        matches!(res, Err(SnapshotError::PayloadOverflow { .. })),
        "主通道超硬护栏应为硬错误：{res:?}"
    );
}

/// 46 复核分层语义：主通道超 150KB 常规预算（但低于 512KB 硬护栏）→
/// **采集成功不失败**——结构通道降级丢弃，payload 仅计主通道；模型输入面
/// 32KB 截断树不受影响（列表页形态 300 条目 326KB 的同构场景）。
#[tokio::test]
async fn snapshot_mid_size_succeeds_below_hard_budget() {
    let mut mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    fill_noncritical_auto_replies(&mock);
    mock.set_auto_reply(
        crate::cdp::domains::names::DOM_GET_DOCUMENT,
        MockReply::Ok(json!({ "root": { "nodeId": 1 } })),
    );
    let session = connect_mock(&mock, "/devtools/browser/snapshot-mid-size").await;
    let collector = CdpCollector::new(session.clone(), BudgetConfig::active());
    let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
    // 主通道 3000 条 100 字符字符串 ≈ 330KB：> 150KB 常规预算但 < 512KB 硬护栏
    let mid = big_snapshot_fixture(3000, &"y".repeat(100));
    let mid_bytes = mid.to_string().len();
    assert!(
        mid_bytes > MAX_RAW_PAYLOAD_BYTES && mid_bytes < HARD_RAW_PAYLOAD_BYTES,
        "夹具应落在双层预算之间：{mid_bytes}B"
    );
    drive_capture_snapshot(&mut mock, mid).await;
    let collected = collect_task
        .await
        .expect("采集任务应完成")
        .expect("中量级主通道应成功（硬护栏内）");
    session.shutdown().await;
    assert_eq!(
        collected.raw_payload_bytes, mid_bytes,
        "payload 应计主通道全量字节（硬护栏内不截断）"
    );
    assert!(collected.raw_payload_bytes <= HARD_RAW_PAYLOAD_BYTES);
    assert_eq!(collected.roots.len(), 1, "主树完整");
}

/// 46 复核默认采集最小面：captureSnapshot 命令参数 includeDOMRects/
/// includePaintOrder 默认 false（两路数据当前实现不消费，源级削减载荷）。
#[tokio::test]
async fn capture_payload_minimal_by_default() {
    let mut mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    fill_noncritical_auto_replies(&mock);
    mock.set_auto_reply(
        crate::cdp::domains::names::DOM_GET_DOCUMENT,
        MockReply::Ok(json!({ "root": { "nodeId": 1 } })),
    );
    let session = connect_mock(&mock, "/devtools/browser/payload-minimal").await;
    let collector = CdpCollector::new(session.clone(), BudgetConfig::active());
    let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
    // 捕获实际发出的 captureSnapshot 命令参数（防回归为全量载荷面）
    let cmd = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        mock.expect_command("DOMSnapshot.captureSnapshot"),
    )
    .await
    .expect("等待 captureSnapshot 命令超时");
    assert_eq!(
        cmd["params"]["includeDOMRects"], false,
        "默认最小面不应请求 DOMRects：{cmd}"
    );
    assert_eq!(
        cmd["params"]["includePaintOrder"], false,
        "默认最小面不应请求 paintOrders：{cmd}"
    );
    mock.reply(
        cmd["id"].as_u64().expect("命令 id 缺失"),
        main_capture_fixture(),
    );
    let collected = collect_task
        .await
        .expect("采集任务应完成")
        .expect("最小面采集应成功");
    session.shutdown().await;
    assert_eq!(collected.roots.len(), 1, "最小面不影响主树构建");
}

/// 46 复核完整载荷面 opt-in：`with_full_payload(true)` 后 captureSnapshot
/// 命令参数 includeDOMRects/includePaintOrder 为 true（绘制序过滤接线
/// 或 DOMRects 消费方接入时的开关面）。
#[tokio::test]
async fn capture_full_payload_opt_in() {
    let mut mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    fill_noncritical_auto_replies(&mock);
    mock.set_auto_reply(
        crate::cdp::domains::names::DOM_GET_DOCUMENT,
        MockReply::Ok(json!({ "root": { "nodeId": 1 } })),
    );
    let session = connect_mock(&mock, "/devtools/browser/payload-full").await;
    let collector = CdpCollector::new(
        session.clone(),
        BudgetConfig::active().with_full_payload(true),
    );
    let collect_task = tokio::spawn(async move { collector.collect("t1", "S1").await });
    let cmd = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        mock.expect_command("DOMSnapshot.captureSnapshot"),
    )
    .await
    .expect("等待 captureSnapshot 命令超时");
    assert_eq!(
        cmd["params"]["includeDOMRects"], true,
        "完整载荷面应请求 DOMRects：{cmd}"
    );
    assert_eq!(
        cmd["params"]["includePaintOrder"], true,
        "完整载荷面应请求 paintOrders：{cmd}"
    );
    mock.reply(
        cmd["id"].as_u64().expect("命令 id 缺失"),
        main_capture_fixture(),
    );
    let collected = collect_task
        .await
        .expect("采集任务应完成")
        .expect("完整载荷面采集应成功");
    session.shutdown().await;
    assert_eq!(collected.roots.len(), 1);
}

/// 跨域子帧结构通道超预算：帧级 getDocument 降级（仅 DOMSnapshot 入树），
/// 子帧根树仍并入 + 统计正常——递归采集不被结构通道体积拖垮。
#[tokio::test]
async fn cross_frame_get_document_degrades_keeps_frame() {
    let mut mock = MockServer::spawn().await;
    for (method, reply) in restore_reply_map() {
        mock.set_auto_reply(method, reply);
    }
    fill_noncritical_auto_replies(&mock);
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
    // 结构通道巨大应答（主/帧会话共用 auto_reply 表 → 两级均降级）
    mock.set_auto_reply(
        crate::cdp::domains::names::DOM_GET_DOCUMENT,
        MockReply::Ok(huge_document_fixture()),
    );
    let session = connect_mock(&mock, "/devtools/browser/xframe-degrade").await;
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
        .expect("子帧结构通道超预算应降级而非失败");
    session.shutdown().await;

    // 子帧内容仍入树（DOMSnapshot 主通道保留）
    assert_eq!(
        collected.cross_origin.frames_collected, 1,
        "子帧采集不应被结构通道体积拖垮：{:#?}",
        collected.cross_origin
    );
    assert!(
        collected.roots.iter().any(|r| r.backend_node_id == 1001),
        "子帧根树应并入（降级仅丢结构通道）"
    );
    // payload = 主通道字节，预算内
    assert_eq!(
        collected.raw_payload_bytes,
        main_capture_fixture().to_string().len()
    );
    assert!(collected.raw_payload_bytes <= MAX_RAW_PAYLOAD_BYTES);
}
