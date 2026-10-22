use super::*;

/// R-1：动作执行成功 → 版本即时 +1（note_action_done）。
#[tokio::test]
async fn action_success_bumps_version() {
    let snapshot = MockSnapshotStore::with_elements(
        1,
        &[ElementMeta {
            backend_node_id: 11,
            is_password: false,
        }],
    );
    let (executor, _ops, snapshot, _t) = exec_with(MockOps::new(), snapshot);
    executor
        .execute(click_req(1, 11))
        .await
        .expect("点击应成功");
    assert_eq!(
        snapshot.state.lock().unwrap().bumps,
        vec!["t1".to_string()],
        "成功动作即时 +1（R-1：AI 动作执行成功）"
    );
}

/// 导航竞态（§5.4）：ContextGone → 延迟 300ms → 版本未变 → 原节点重派发 → 成功。
#[tokio::test]
async fn context_gone_delays_then_retries() {
    let ops = MockOps::new();
    ops.state.lock().unwrap().fail_queue.push_back((
        MockOp::MouseEvent,
        ActionError::new(
            ActionErrorKind::ContextGone,
            "Execution context was destroyed",
        ),
    ));
    let delay = Arc::new(RecordingDelay::new());
    let executor = ActionExecutor::new(
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
    .with_delay(delay.clone());
    let success = executor
        .execute(click_req(1, 11))
        .await
        .expect("竞态延迟后应成功");
    assert!(!success.navigated);
    assert_eq!(
        delay.durations(),
        vec![Duration::from_millis(RETRY_DELAY_MS)],
        "延迟 300ms 恰一次"
    );
    assert_eq!(
        ops.count(MockOp::MouseEvent),
        1 + 3,
        "首轮 moved 失败 + 重派发完整序列"
    );
    // 重快照未发生（版本未变，原 backendNodeId 重派发）
    assert_eq!(
        ops.count(MockOp::PushNodes),
        2,
        "两轮定位（同 backendNodeId）"
    );
}

/// TargetClosed（§5.1）：延迟 → 目标存活 → 重快照重定位 → 成功。
#[tokio::test]
async fn target_closed_alive_retakes_and_succeeds() {
    let ops = MockOps::new();
    ops.state.lock().unwrap().fail_queue.push_back((
        MockOp::MouseEvent,
        ActionError::new(ActionErrorKind::TargetClosed, "Target closed"),
    ));
    let executor = ActionExecutor::new(
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
    let success = executor
        .execute(click_req(1, 11))
        .await
        .expect("目标存活应重试成功");
    assert!(!success.navigated);
    assert_eq!(ops.count(MockOp::TargetAlive), 1, "存活校验恰一次");
    assert_eq!(
        ops.count(MockOp::MouseEvent),
        1 + 3,
        "首轮失败 + 重派发完整序列"
    );
}

/// TargetClosed（§5.1）：延迟 → 目标已销毁 → 致命（不无限重试）。
#[tokio::test]
async fn target_closed_dead_is_fatal() {
    let ops = MockOps::new();
    {
        let mut s = ops.state.lock().unwrap();
        s.alive = false;
        s.persist_errors.insert(
            MockOp::MouseEvent,
            ActionError::new(ActionErrorKind::TargetClosed, "Target closed"),
        );
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
        CancellationToken::new(),
    )
    .with_gate(Arc::new(AllowGate))
    .with_delay(Arc::new(RecordingDelay::new()));
    let err = executor
        .execute(click_req(1, 11))
        .await
        .expect_err("目标销毁应致命");
    assert_eq!(err.kind, ActionErrorKind::TargetClosed);
    assert!(err.message.contains("已销毁"));
    assert_eq!(
        ops.count(MockOp::MouseEvent),
        1,
        "仅首轮 moved（不做第二次点击）"
    );
}

/// ConnectionLost（R-9）：等恢复事件 → 重试 ≤1 次（不消耗额度）→ 成功。
#[tokio::test]
async fn connection_lost_recovers_once() {
    let ops = MockOps::new();
    ops.state.lock().unwrap().fail_queue.push_back((
        MockOp::MouseEvent,
        ActionError::new(ActionErrorKind::ConnectionLost, "CDP 连接断开"),
    ));
    let executor = ActionExecutor::new(
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
    let success = executor
        .execute(click_req(1, 11))
        .await
        .expect("恢复后应重试成功");
    assert!(!success.navigated);
    assert_eq!(
        ops.count(MockOp::AwaitConnectionRestored),
        1,
        "等待恢复事件恰一次"
    );
    assert_eq!(
        ops.count(MockOp::MouseEvent),
        1 + 3,
        "首轮失败 + 恢复后重派发"
    );
}

/// ConnectionLost 恢复超时（R-9）：恢复窗口内无事件 → 致命。
#[tokio::test]
async fn connection_lost_restore_timeout_fatal() {
    let ops = MockOps::new();
    {
        let mut s = ops.state.lock().unwrap();
        s.restored = false;
        s.persist_errors.insert(
            MockOp::MouseEvent,
            ActionError::new(ActionErrorKind::ConnectionLost, "CDP 连接断开"),
        );
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
        CancellationToken::new(),
    )
    .with_gate(Arc::new(AllowGate))
    .with_options(ActionOptions {
        connection_wait: Duration::from_millis(1),
        ..ActionOptions::default()
    })
    .with_delay(Arc::new(RecordingDelay::new()));
    let err = executor
        .execute(click_req(1, 11))
        .await
        .expect_err("恢复超时应致命");
    assert_eq!(err.kind, ActionErrorKind::ConnectionLost);
    assert_eq!(
        ops.count(MockOp::AwaitConnectionRestored),
        1,
        "恢复后重试 ≤1 次"
    );
}
