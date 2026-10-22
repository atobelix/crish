use super::*;

/// 流水线顺序（T-8）：门禁 → 版本 → abort → 定位 → 派发；门禁拒绝 → 零派发。
#[tokio::test]
async fn pipeline_gate_blocks_dispatch() {
    let ops = MockOps::new();
    ops.state.lock().unwrap().url = "https://denied.example".to_string();
    let gate = Arc::new(DenyGate::new(vec!["denied.example".to_string()]));
    let token = CancellationToken::new();
    let executor = ActionExecutor::new(
        Arc::new(ops.clone()),
        Arc::new(MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }],
        )),
        token,
    )
    .with_gate(gate);
    let err = executor
        .execute(click_req(1, 11))
        .await
        .expect_err("门禁应拒绝");
    assert_eq!(err.kind, ActionErrorKind::GateDenied);
    assert!(ops.count(MockOp::CurrentUrl) >= 1, "门禁前应取当前 URL");
    assert_eq!(ops.count(MockOp::PushNodes), 0, "门禁拒绝不得派发定位");
    assert_eq!(ops.count(MockOp::MouseEvent), 0, "门禁拒绝不得派发坐标事件");
}

/// 门禁未接线：默认执行器返回「未接线」结构化错误。
#[tokio::test]
async fn gate_unwired_returns_error() {
    let ops = MockOps::new();
    let snapshot = MockSnapshotStore::with_elements(
        1,
        &[ElementMeta {
            backend_node_id: 11,
            is_password: false,
        }],
    );
    let token = CancellationToken::new();
    let executor = ActionExecutor::new(Arc::new(ops.clone()), Arc::new(snapshot), token);
    let err = executor
        .execute(click_req(1, 11))
        .await
        .expect_err("未接线应报错");
    assert_eq!(err.kind, ActionErrorKind::GateDenied);
    assert!(err.message.contains("未接线"));
}

/// 版本失效重试（E2E-9）：旧版本 → 重快照 → 重定位到新 backendNodeId → 动作成功。
#[tokio::test]
async fn version_invalid_retakes_and_succeeds() {
    let snapshot = MockSnapshotStore::new(1); // 兜底索引表注入在下方
    // 新快照 v2 上索引 0 存在（重定位到新 backendNodeId 21）
    snapshot.state.lock().unwrap().elements.insert(
        2,
        vec![ElementMeta {
            backend_node_id: 21,
            is_password: false,
        }],
    );
    let (executor, ops, snapshot, _t) = exec_with(MockOps::new(), snapshot);
    let success = executor
        .execute(click_req(0, 11))
        .await
        .expect("版本失效应自动重快照重试成功");
    assert!(!success.navigated);
    assert_eq!(snapshot.take_count(), 1, "重快照恰好一次");
    // 重派发发生在新 backend 21 的坐标上：box(121) 中心 (250, 25)
    let moved = ops.calls_of(MockOp::MouseEvent);
    assert!(
        moved
            .iter()
            .any(|c| c.detail.contains("mouseMoved") && c.detail.contains("x=250")),
        "应在新元素坐标派发：{:?}",
        moved
    );
    assert!(
        ops.calls_of(MockOp::PushNodes)
            .iter()
            .any(|c| c.detail.contains("21")),
        "应重定位到新 backendNodeId 21"
    );
}

/// 节点过期（E2E-10）：NodeStale → 重快照 → 索引不存在 → InvalidInput 致命。
#[tokio::test]
async fn node_stale_then_index_missing_is_fatal_invalid_input() {
    let ops = MockOps::new();
    // 元素被 JS 删除：backend 99 未登记（push 空 → NodeStale）；新快照中索引 0 不存在
    let snapshot = MockSnapshotStore::new(1);
    let (executor, ops, _snapshot, _t) = exec_with(ops.clone(), snapshot);
    let err = executor
        .execute(click_req(1, 99))
        .await
        .expect_err("应致命");
    assert_eq!(err.kind, ActionErrorKind::InvalidInput);
    assert!(err.message.contains("不存在"));
    assert_eq!(ops.count(MockOp::MouseEvent), 0, "索引不存在不得派发");
}

/// 3 次上限（E2E-18）：持续 NodeStale → escalate 升级提示（T-10）。
#[tokio::test]
async fn node_stale_exhaustion_escalates() {
    let (executor, ops, _snapshot, _t) = exec_with(
        MockOps::new(),
        MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }],
        ),
    );
    // pushNodes 恒 NodeStale（元素反复重建）
    ops.state.lock().unwrap().persist_errors.insert(
        MockOp::PushNodes,
        ActionError::new(ActionErrorKind::NodeStale, "push 空"),
    );
    let err = executor
        .execute(click_req(1, 11))
        .await
        .expect_err("应耗尽");
    assert_eq!(err.kind, ActionErrorKind::NodeStale);
    assert_eq!(err.attempt, 3, "attempt 应停在 3（计入上限，R-8）");
    assert!(err.escalate, "NodeStale 耗尽应升级（T-10）");
    assert!(err.message.contains("节点定位失败"));
    assert_eq!(ops.count(MockOp::PushNodes), 3, "3 次重试后不再自动重试");
}

/// Aborted 不计入额度（R-8）：重试中注入 abort → 中止于第 2 次尝试（额度未耗尽）。
#[tokio::test]
async fn aborted_does_not_count_quota() {
    let token = CancellationToken::new();
    let ops = MockOps::new();
    {
        let mut s = ops.state.lock().unwrap();
        s.fail_queue.push_back((
            MockOp::PushNodes,
            ActionError::new(ActionErrorKind::NodeStale, "首轮节点过期"),
        ));
        s.on_fail_cancel = Some(token.clone());
    }
    let executor = ActionExecutor::new(
        Arc::new(ops.clone()),
        Arc::new(MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }],
        )),
        token.clone(),
    )
    .with_gate(Arc::new(AllowGate))
    .with_delay(Arc::new(RecordingDelay::new()));
    let err = executor
        .execute(click_req(1, 11))
        .await
        .expect_err("应中止");
    assert_eq!(err.kind, ActionErrorKind::Aborted, "接管应立即中止");
    // 中止发生在重试决策入口（首轮 NodeStale 之后），未发起任何重试（不计入，R-8）
    assert_eq!(err.attempt, 1);
    assert_eq!(ops.count(MockOp::MouseEvent), 0, "中止后不得派发");
    assert_eq!(
        ops.count(MockOp::PushNodes),
        1,
        "仅首轮定位发生过（重试轮被中止拦截）"
    );
    // 额度未耗尽：新令牌 + 同一 mock（队列已清空）→ 完整动作应成功
    let executor2 = ActionExecutor::new(
        Arc::new(ops.clone()),
        Arc::new(MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }],
        )),
        CancellationToken::new(),
    )
    .with_gate(Arc::new(AllowGate))
    .with_delay(Arc::new(RecordingDelay::new()));
    let success = executor2
        .execute(click_req(1, 11))
        .await
        .expect("额度应完好");
    assert!(!success.navigated);
}

/// 120s 总预算（T-9）：慢速 mock（挂起派发）→ Timeout 失败（注入小预算）。
#[tokio::test]
async fn total_timeout_fires_on_hang() {
    let ops = MockOps::new();
    ops.state.lock().unwrap().hang.insert(MockOp::MouseEvent);
    let snapshot = MockSnapshotStore::with_elements(
        1,
        &[ElementMeta {
            backend_node_id: 11,
            is_password: false,
        }],
    );
    let executor = ActionExecutor::new(
        Arc::new(ops.clone()),
        Arc::new(snapshot),
        CancellationToken::new(),
    )
    .with_gate(Arc::new(AllowGate))
    .with_options(ActionOptions {
        total_timeout: Duration::from_millis(50),
        ..ActionOptions::default()
    });
    let err = executor
        .execute(click_req(1, 11))
        .await
        .expect_err("挂起应超时");
    assert_eq!(err.kind, ActionErrorKind::Timeout);
    assert!(err.message.contains("总预算"));
}

/// 后置导航复核（§7.1 ③）：动作后 URL 变化 → Success{navigated:true}。
#[tokio::test]
async fn post_check_navigation_success() {
    let ops = MockOps::new();
    ops.state.lock().unwrap().url_after_mouse = Some("https://next.example".to_string());
    let (executor, _ops, _snap, _t) = exec_with(
        ops,
        MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }],
        ),
    );
    let success = executor
        .execute(click_req(1, 11))
        .await
        .expect("点击应成功");
    assert!(success.navigated, "URL 变化应标记导航");
    assert_eq!(success.url_after.as_deref(), Some("https://next.example"));
}

/// 后置门禁复核（§7.1 ③）：导航到白名单外 → 回退 + GateDenied。
#[tokio::test]
async fn post_check_gate_denial_goes_back() {
    let ops = MockOps::new();
    ops.state.lock().unwrap().url_after_mouse = Some("https://evil.example".to_string());
    let gate = Arc::new(DenyGate::new(vec!["evil.example".to_string()]));
    let token = CancellationToken::new();
    let executor = ActionExecutor::new(
        Arc::new(ops.clone()),
        Arc::new(MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }],
        )),
        token,
    )
    .with_gate(gate);
    let err = executor
        .execute(click_req(1, 11))
        .await
        .expect_err("门禁复核应拦截");
    assert_eq!(err.kind, ActionErrorKind::GateDenied);
    assert!(err.message.contains("已回退"));
    assert_eq!(ops.count(MockOp::GoBack), 1, "应触发回退");
}
