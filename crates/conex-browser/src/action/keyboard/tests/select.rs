//! select_option 设值与回读校验用例（自 keyboard.rs 平移）。

use super::*;

/// select_option：设值 + change/input + 回读一致。
#[tokio::test]
async fn select_option_success() {
    let ops = MockOps::new();
    ops.state.lock().unwrap().select_return = "value2".to_string();
    let (exec, ops, _delay) = executor(
        ops,
        MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }],
        ),
    );
    let success = exec
        .select_option(
            &"t1".to_string(),
            1,
            ElementRef {
                index: 0,
                backend_node_id: 11,
            },
            "value2",
        )
        .await
        .expect("选中应成功");
    assert_eq!(success.payload.as_ref().unwrap()["selected"], "value2");
    let calls = ops.calls_of(MockOp::CallFunctionOn);
    assert!(
        calls[0].detail.contains("this.options"),
        "固定模板设值：{}",
        calls[0].detail
    );
    assert!(
        calls[0].detail.contains("args=[String(\"value2\")]"),
        "参数应为原始值（call_function_on 统一包装，禁二次包装，联调 E3 根因）：{}",
        calls[0].detail
    );
}

/// select_option 回读不符 → Timeout 可重试（重试 1 次仍不符 → Fatal）。
#[tokio::test]
async fn select_option_readback_mismatch_fatal() {
    let ops = MockOps::new(); // select_return 默认空串 ≠ value2
    let (exec, _ops, _delay) = executor(
        ops,
        MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }],
        ),
    );
    let err = exec
        .select_option(
            &"t1".to_string(),
            1,
            ElementRef {
                index: 0,
                backend_node_id: 11,
            },
            "value2",
        )
        .await
        .expect_err("回读不符应失败");
    assert_eq!(err.kind, ActionErrorKind::Timeout);
    assert!(err.message.contains("回读校验不符"));
}
