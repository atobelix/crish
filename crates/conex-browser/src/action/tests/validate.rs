use super::*;

/// 入参校验穷举：非法坐标/负数/超长/空串/非法键名 → InvalidInput 且零 CDP 调用。
#[tokio::test]
async fn validate_request_exhaustive() {
    let cases: Vec<ActionRequest> = vec![
        // 元素类原语缺元素
        ActionRequest {
            tab_id: "t1".to_string(),
            snapshot_version: 1,
            element: None,
            primitive: Primitive::Click {
                button: MouseButton::Left,
                count: 1,
            },
        },
        // backendNodeId 非正数
        ActionRequest {
            tab_id: "t1".to_string(),
            snapshot_version: 1,
            element: Some(ElementRef {
                index: 0,
                backend_node_id: -1,
            }),
            primitive: Primitive::Hover,
        },
        // click count 非法（0 / 3）
        click_with_count(0),
        click_with_count(3),
        // scroll 负数 / 零
        ActionRequest {
            tab_id: "t1".to_string(),
            snapshot_version: 1,
            element: None,
            primitive: Primitive::Scroll {
                dir: ScrollDir::Down,
                amount: -100,
            },
        },
        ActionRequest {
            tab_id: "t1".to_string(),
            snapshot_version: 1,
            element: None,
            primitive: Primitive::Scroll {
                dir: ScrollDir::Down,
                amount: 0,
            },
        },
        // type 空串且无提交键 / 超长
        ActionRequest {
            tab_id: "t1".to_string(),
            snapshot_version: 1,
            element: Some(ElementRef {
                index: 0,
                backend_node_id: 11,
            }),
            primitive: Primitive::Type {
                text: String::new(),
                submit_key: None,
            },
        },
        ActionRequest {
            tab_id: "t1".to_string(),
            snapshot_version: 1,
            element: Some(ElementRef {
                index: 0,
                backend_node_id: 11,
            }),
            primitive: Primitive::Type {
                text: "x".repeat(MAX_TYPE_CHARS + 1),
                submit_key: None,
            },
        },
        // 非法提交键名
        ActionRequest {
            tab_id: "t1".to_string(),
            snapshot_version: 1,
            element: Some(ElementRef {
                index: 0,
                backend_node_id: 11,
            }),
            primitive: Primitive::Type {
                text: "a".to_string(),
                submit_key: Some("BogusKey".to_string()),
            },
        },
        // 非法键名
        ActionRequest {
            tab_id: "t1".to_string(),
            snapshot_version: 1,
            element: None,
            primitive: Primitive::Key {
                keys: "Bogus+Key".to_string(),
            },
        },
        // select 空值
        ActionRequest {
            tab_id: "t1".to_string(),
            snapshot_version: 1,
            element: Some(ElementRef {
                index: 0,
                backend_node_id: 11,
            }),
            primitive: Primitive::SelectOption {
                value: String::new(),
            },
        },
        // evaluate 空表达式 / 超硬限
        ActionRequest {
            tab_id: "t1".to_string(),
            snapshot_version: 1,
            element: None,
            primitive: Primitive::Evaluate(EvaluateRequest {
                expression: String::new(),
                element: None,
                timeout_ms: 1000,
            }),
        },
        ActionRequest {
            tab_id: "t1".to_string(),
            snapshot_version: 1,
            element: None,
            primitive: Primitive::Evaluate(EvaluateRequest {
                expression: "1".to_string(),
                element: None,
                timeout_ms: 2001,
            }),
        },
    ];
    let (executor, ops, _snap, _t) = exec_with(
        MockOps::new(),
        MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }],
        ),
    );
    for req in cases {
        let err = executor.execute(req).await.expect_err("非法参数应被拒绝");
        assert_eq!(
            err.kind,
            ActionErrorKind::InvalidInput,
            "消息：{}",
            err.message
        );
    }
    // 非法参数全部在派发前拦截（零 CDP 调用）
    let s = ops.state.lock().unwrap();
    assert_eq!(
        s.calls.len(),
        0,
        "非法参数不得产生任何 CDP 调用：{:?}",
        s.calls
    );
}
