use super::*;
use crate::cdp::error::CancelReason;
use std::sync::atomic::Ordering;

/// 验收 9.1-20：幂等→急停→审批→审计(before)→传输→审计(after) 顺序断言
#[tokio::test]
async fn sender_pipeline_hooks_order() {
    let (mut mock, client, hooks) = setup(true).await;
    mock.set_auto_reply(
        "Runtime.evaluate",
        MockReply::Ok(json!({ "result": { "value": 1 } })),
    );
    let channel: Arc<dyn CommandChannel> = client;
    let sender = CommandSender::new(channel, hooks.clone());

    let key = IdKey::new(None, "Runtime.evaluate", &json!({ "expression": "1" }));
    let cmd = Command::new("Runtime.evaluate")
        .params(json!({ "expression": "1" }))
        .dangerous()
        .idempotent(key);
    let task = tokio::spawn(async move { sender.execute(cmd).await });
    // 等命令到达 mock（传输段）
    mock.expect_command("Runtime.evaluate").await;
    let result = task.await.expect("任务失败").expect("命令失败");
    assert_eq!(result["result"]["value"], 1);

    let steps = hooks.steps();
    let expected = ["idempotent", "approve", "audit:before", "audit:after"];
    for (i, exp) in expected.iter().enumerate() {
        assert_eq!(steps[i], *exp, "第 {i} 步应为 {exp}，实际 {steps:?}");
    }
    // WireSend 由 mock 收到命令本身证明（audit:before 先于命令到达 mock）
    assert!(steps.len() >= 4);
}

/// 验收 9.1-21：急停旗置位 → 新命令 Cancelled(EmergencyStop)，且未发送
#[tokio::test]
async fn sender_emergency_stop_blocks_new() {
    let (mock, client, hooks) = setup(true).await;
    hooks.stop.store(true, Ordering::SeqCst);
    let channel: Arc<dyn CommandChannel> = client;
    let sender = CommandSender::new(channel, hooks.clone());

    let err = sender
        .execute(Command::new("Runtime.evaluate").params(json!({ "expression": "1" })))
        .await
        .expect_err("急停应拒绝新命令");
    assert!(matches!(
        err,
        CdpError::Cancelled {
            reason: CancelReason::EmergencyStop
        }
    ));
    assert_eq!(mock.commands_seen(), 0, "急停命令不得发送到线上");
}

/// 验收 9.1-22：在途命令经 abort_token 取消、pending 清零
#[tokio::test]
async fn sender_emergency_stop_cancels_inflight() {
    let (mock, client, hooks) = setup(true).await;
    let _ = mock; // 不回包（Silent）
    let channel: Arc<dyn CommandChannel> = client.clone();
    let sender = CommandSender::new(channel, hooks.clone());

    let task = tokio::spawn(async move {
        sender
            .execute(Command::new("Page.navigate").params(json!({ "url": "x" })))
            .await
    });
    // 等命令进入 pending（mock 侧收到）
    tokio::time::sleep(Duration::from_millis(50)).await;
    hooks.token.cancel();
    let err = task.await.expect("任务失败").expect_err("应被取消");
    assert!(matches!(
        err,
        CdpError::Cancelled {
            reason: CancelReason::Aborted
        }
    ));
    // pending 清理（PendingGuard Drop 同步移除）
    assert_eq!(client.pending_len().await, 0, "取消后 pending 必须清零");
}

/// 验收 9.1-23：Deny → 未发送 + 审计 Denied 事件
#[tokio::test]
async fn sender_approval_denied_no_send() {
    let (mock, client, hooks) = setup(false).await;
    let channel: Arc<dyn CommandChannel> = client;
    let sender = CommandSender::new(channel, hooks.clone());

    let err = sender
        .execute(
            Command::new("Input.insertText")
                .params(json!({ "text": "x" }))
                .dangerous(),
        )
        .await
        .expect_err("应被拒绝");
    assert!(matches!(err, CdpError::ApprovalDenied { .. }));
    assert_eq!(mock.commands_seen(), 0, "拒绝的命令不得发送到线上");
    let steps = hooks.steps();
    assert!(
        steps.contains(&"audit:denied".to_string()),
        "应有 Denied 审计，实际 {steps:?}"
    );
    assert!(
        !steps.contains(&"audit:before".to_string()),
        "拒绝后不得有 before 审计"
    );
}

/// 验收 9.1-24：同 IdKey 在途合并，仅一次 WS 发送
#[tokio::test]
async fn sender_idempotent_merges_inflight() {
    let (mock, client, hooks) = setup(true).await;
    let _ = mock; // 不回包直到主动 reply
    let channel: Arc<dyn CommandChannel> = client;
    let sender = Arc::new(CommandSender::new(channel, hooks.clone()));

    let key = IdKey::new(None, "Page.navigate", &json!({ "url": "https://e.com" }));
    let make_cmd = |key: IdKey| {
        Command::new("Page.navigate")
            .params(json!({ "url": "https://e.com" }))
            .idempotent(key)
    };

    let s1 = sender.clone();
    let key1 = key.clone();
    let t1 = tokio::spawn(async move { s1.execute(make_cmd(key1)).await });
    let s2 = sender.clone();
    let key2 = key.clone();
    let t2 = tokio::spawn(async move { s2.execute(make_cmd(key2)).await });

    // 两个并发调用 → 仅一条命令到达 mock
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(
        mock.commands_seen(),
        1,
        "同 IdKey 在途合并应仅一次 WS 发送（实际 {}）",
        mock.commands_seen()
    );
    // 回包 → 两个调用方共享同一结果
    mock.reply(1, json!({ "frameId": "F1" }));
    let r1 = t1.await.expect("任务 1 失败").expect("命令 1 失败");
    let r2 = t2.await.expect("任务 2 失败").expect("命令 2 失败");
    assert_eq!(r1, r2);
    assert_eq!(r1["frameId"], "F1");
}

/// H3 回归（评审 29-H3）：幂等缓存命中时，在途合并等待方应收到**正确缓存结果**
/// 而非 Cancelled。修复前 guard Drop 向共享 broadcast 发布 Cancelled。
#[tokio::test]
async fn sender_cache_hit_merger_gets_result_not_cancelled() {
    let (mock, client, hooks) = setup(true).await;
    let _ = mock; // 缓存命中不应有任何命令到达
    *hooks
        .idempotent_cached
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(Ok(json!({ "cached": true })));
    *hooks.cache_delay.lock().unwrap_or_else(|p| p.into_inner()) = Some(Duration::from_millis(80));
    let channel: Arc<dyn CommandChannel> = client;
    let sender = Arc::new(CommandSender::new(channel, hooks.clone()));

    let key = IdKey::new(None, "Page.navigate", &json!({ "url": "https://e.com" }));
    let make_cmd = |key: IdKey| {
        Command::new("Page.navigate")
            .params(json!({ "url": "https://e.com" }))
            .idempotent(key)
    };

    // A 先插入在途表并进入幂等钩子（延迟 80ms 返回缓存命中）
    let s1 = sender.clone();
    let key1 = key.clone();
    let t1 = tokio::spawn(async move { s1.execute(make_cmd(key1)).await });
    // B 稍后进入：命中在途合并分支，等待 A 发布共享结果
    tokio::time::sleep(Duration::from_millis(20)).await;
    let s2 = sender.clone();
    let key2 = key.clone();
    let t2 = tokio::spawn(async move { s2.execute(make_cmd(key2)).await });

    let r1 = t1.await.expect("任务 A 失败");
    let r2 = t2.await.expect("任务 B 失败");
    assert_eq!(r1.as_ref().expect("A 应收到缓存结果")["cached"], true);
    assert_eq!(
        r2.as_ref().expect("B 应收到缓存结果而非 Cancelled（H3）")["cached"],
        true,
        "合并等待方应共享正确结果"
    );
    assert_eq!(mock.commands_seen(), 0, "缓存命中不得发送命令到线上");
}

// ---------- R-12 会话只读能力集（34 §5.2 E-3）管线接线测试 ----------

/// attach 会话下非白名单命令 fail-closed 拒绝：CapabilityDenied + 零命令发送
/// + Blocked 审计（且无 before/after 审计——未进入传输段）。
#[tokio::test]
async fn sender_attach_caps_denies_non_readonly() {
    let (mock, client, hooks) = setup(true).await;
    hooks.set_caps(ReadonlyCaps::mcp_attach_default());
    let channel: Arc<dyn CommandChannel> = client;
    let sender = CommandSender::new(channel, hooks.clone());

    for method in [
        "Runtime.evaluate",         // 求值类（34 §4.3：唯一拦截点）
        "Input.dispatchMouseEvent", // 交互注入
        "Network.getAllCookies",    // cookie 全量读取
        "Page.navigate",            // 导航
    ] {
        let err = sender
            .execute(Command::new(method).params(json!({})))
            .await
            .expect_err("attach 会话非白名单命令应被拒绝");
        assert!(
            matches!(&err, CdpError::CapabilityDenied { method: m } if m == method),
            "{method} 应返回 CapabilityDenied，实际 {err:?}"
        );
    }
    assert_eq!(mock.commands_seen(), 0, "拒绝的命令不得发送到线上");
    let steps = hooks.steps();
    assert_eq!(
        steps
            .iter()
            .filter(|s| s.as_str() == "audit:blocked")
            .count(),
        4,
        "每条拒绝应有一条 Blocked 审计，实际 {steps:?}"
    );
    assert!(
        !steps.iter().any(|s| s == "audit:before"),
        "拒绝后不得有 before 审计，实际 {steps:?}"
    );
}

/// attach 会话下白名单命令正常放行：Page.captureScreenshot 到达线上并成功。
#[tokio::test]
async fn sender_attach_caps_allows_readonly() {
    let (mock, client, hooks) = setup(true).await;
    mock.set_auto_reply(
        "Page.captureScreenshot",
        MockReply::Ok(json!({ "data": "base64" })),
    );
    hooks.set_caps(ReadonlyCaps::mcp_attach_default());
    let channel: Arc<dyn CommandChannel> = client;
    let sender = CommandSender::new(channel, hooks.clone());

    let result = sender
        .execute(Command::new("Page.captureScreenshot").params(json!({ "format": "png" })))
        .await
        .expect("只读命令应放行");
    assert_eq!(result["data"], "base64");
    assert_eq!(mock.commands_seen(), 1, "放行的命令应恰好发送一次");
    let steps = hooks.steps();
    assert!(
        steps.contains(&"audit:before".to_string()),
        "应有 before 审计"
    );
    assert!(
        steps.contains(&"audit:after".to_string()),
        "应有 after 审计"
    );
    assert!(
        !steps.contains(&"audit:blocked".to_string()),
        "放行命令不得有 Blocked 审计"
    );
}

/// 隔离断言：无能力集注入（默认 None）时正常 browser_* 工具面不受影响——
/// Runtime.evaluate 照常发送执行（能力集仅 attach 会话生效）。
#[tokio::test]
async fn sender_without_caps_normal_tool_surface_unaffected() {
    let (mock, client, hooks) = setup(true).await;
    mock.set_auto_reply(
        "Runtime.evaluate",
        MockReply::Ok(json!({ "result": { "value": 1 } })),
    );
    // hooks 默认无能力集（RecordingHooks::new 不 set_caps）
    let channel: Arc<dyn CommandChannel> = client;
    let sender = CommandSender::new(channel, hooks.clone());

    let result = sender
        .execute(Command::new("Runtime.evaluate").params(json!({ "expression": "1" })))
        .await
        .expect("无能力集时正常面应放行");
    assert_eq!(result["result"]["value"], 1);
    assert_eq!(mock.commands_seen(), 1, "命令应到达线上");
    assert!(
        !hooks.steps().contains(&"audit:blocked".to_string()),
        "正常面不得出现能力集拦截审计"
    );
}

/// 能力集先于审批段：dangerous 非白名单命令被拒且不触发 approve 钩子
/// （17 §2.3 默认拒绝面不可审批豁免——红线语义）。
#[tokio::test]
async fn sender_attach_caps_rejects_before_approval() {
    let (mock, client, hooks) = setup(true).await;
    hooks.set_caps(ReadonlyCaps::mcp_attach_default());
    let channel: Arc<dyn CommandChannel> = client;
    let sender = CommandSender::new(channel, hooks.clone());

    let err = sender
        .execute(
            Command::new("Input.dispatchMouseEvent")
                .params(json!({ "type": "mousePressed" }))
                .dangerous(),
        )
        .await
        .expect_err("交互注入应被能力集拒绝");
    assert!(matches!(err, CdpError::CapabilityDenied { .. }));
    let steps = hooks.steps();
    assert!(
        !steps.contains(&"approve".to_string()),
        "能力集拒绝必须先于审批（不可豁免），实际 {steps:?}"
    );
    assert_eq!(mock.commands_seen(), 0, "拒绝的命令不得发送");
}
