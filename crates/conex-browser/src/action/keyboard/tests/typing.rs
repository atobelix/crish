//! type 分块/节流/abort/submit 用例（自 keyboard.rs 平移）。

use super::*;

/// type 分块边界（§4.1）：49/50 单块零延迟；51 两块一次 12ms 节流。
#[tokio::test]
async fn type_chunk_boundaries() {
    let (exec, ops, delay) = executor(
        MockOps::new(),
        MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }],
        ),
    );
    let el = ElementRef {
        index: 0,
        backend_node_id: 11,
    };
    let tab = "t1".to_string();
    // 49 字符：1 块，无节流
    exec.type_text(&tab, 1, el, &"a".repeat(49), None)
        .await
        .expect("49 应成功");
    assert_eq!(ops.count(MockOp::KeyEvent), 49 * 3, "49 字符三事件");
    assert!(delay.durations().is_empty(), "49 字符不应有块间延迟");
    assert_eq!(ops.count(MockOp::FocusNode), 1, "type 先 focus");
    assert_eq!(ops.count(MockOp::Evaluate), 0, "单块无回读");

    // 50 字符：1 块，无节流
    exec.type_text(&tab, 1, el, &"a".repeat(50), None)
        .await
        .expect("50 应成功");
    assert_eq!(ops.count(MockOp::KeyEvent), (49 + 50) * 3);
    assert!(delay.durations().is_empty());

    // 51 字符：2 块，恰 1 次 12ms 节流 + 回读
    exec.type_text(&tab, 1, el, &"a".repeat(51), None)
        .await
        .expect("51 应成功");
    assert_eq!(ops.count(MockOp::KeyEvent), (49 + 50 + 51) * 3);
    assert_eq!(delay.durations().len(), 1, "恰 1 次块间节流");
    assert_eq!(
        delay.durations()[0],
        Duration::from_millis(TYPE_CHUNK_DELAY_MS)
    );
}

/// F1 回归：ASCII 输入插入载体唯一——keyDown 不得携带 text（text 只能由
/// char 事件承载，且同一字符恰一个载体）。Chrome 实测（K6）：keyDown(text)
/// 又发独立 char → 双写（"d"→"dd"；组合键 Control+A → "AA"）；mock 层
/// 参数面锁住该不变量：所有 text 非空的 KeyEvent 必须是 char 事件。
#[tokio::test]
async fn type_ascii_insert_carrier_unique() {
    let (exec, ops, _delay) = executor(
        MockOps::new(),
        MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }],
        ),
    );
    exec.type_text(
        &"t1".to_string(),
        1,
        ElementRef {
            index: 0,
            backend_node_id: 11,
        },
        "demo",
        None,
    )
    .await
    .expect("ASCII 输入应成功");
    let events = ops.calls_of(MockOp::KeyEvent);
    assert_eq!(events.len(), 12, "4 字符 × 三事件");
    let mut carriers: Vec<String> = Vec::new();
    for call in &events {
        let text_field = call
            .detail
            .split("text=")
            .nth(1)
            .unwrap_or_default()
            .to_string();
        if !text_field.starts_with("\"\"") {
            assert!(
                call.detail.starts_with("char"),
                "text 只能由 char 事件携带（keyDown 携 text 即双写面）：{}",
                call.detail
            );
            carriers.push(text_field);
        }
    }
    assert_eq!(carriers.len(), 4, "每个字符恰一个插入载体：{carriers:?}");
    for c in ['d', 'e', 'm', 'o'] {
        assert!(
            carriers.iter().any(|t| t == &format!("\"{c}\"")),
            "缺字符 {c} 的插入载体：{carriers:?}"
        );
    }

    // 组合键路径同规则（§4.3）：keyDown A 不携 text，char 唯一承载
    let base = ops.calls_of(MockOp::KeyEvent).len();
    exec.key(&"t1".to_string(), 1, "Control+A")
        .await
        .expect("组合键应成功");
    let combo_events = &ops.calls_of(MockOp::KeyEvent)[base..];
    let keydown_a = combo_events
        .iter()
        .find(|c| c.detail.contains("keyDown key=\"A\""))
        .expect("组合键应含 keyDown A");
    assert!(
        !keydown_a.detail.contains("text=\"A\""),
        "组合键 keyDown A 不得携带 text：{}",
        keydown_a.detail
    );
    let char_carriers: Vec<&MockCall> = combo_events
        .iter()
        .filter(|c| c.detail.starts_with("char") && !c.detail.contains("text=\"\""))
        .collect();
    assert_eq!(char_carriers.len(), 1, "组合键 char 恰一个插入载体");
    assert!(char_carriers[0].detail.contains("text=\"A\""));
}

/// type 节流时长（注入时钟断言 12ms 定值）。
#[tokio::test]
async fn type_chunk_delay_value() {
    let (exec, _ops, delay) = executor(
        MockOps::new(),
        MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }],
        ),
    );
    // 120 字符 → 3 块 → 2 次节流
    exec.type_text(
        &"t1".to_string(),
        1,
        ElementRef {
            index: 0,
            backend_node_id: 11,
        },
        &"x".repeat(120),
        None,
    )
    .await
    .expect("120 应成功");
    assert_eq!(delay.durations().len(), 2);
    for d in delay.durations() {
        assert_eq!(
            d,
            Duration::from_millis(TYPE_CHUNK_DELAY_MS),
            "块间节流定值 12ms"
        );
    }
}

/// 分块间 abort（E2E-17）：第 1 块派发完成后接管 → 已输入部分保留，返回 Aborted。
#[tokio::test]
async fn type_abort_between_chunks() {
    let ops = MockOps::new();
    let token = CancellationToken::new();
    // 第 50 个字符事件后触发接管（恰在第 1 块末尾）
    ops.state.lock().unwrap().cancel_after_char = Some((50, token.clone()));
    let exec = ActionExecutor::new(
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
    .with_gate(Arc::new(AllowGate))
    .with_delay(Arc::new(RecordingDelay::new()));
    let err = exec
        .type_text(
            &"t1".to_string(),
            1,
            ElementRef {
                index: 0,
                backend_node_id: 11,
            },
            &"a".repeat(60),
            None,
        )
        .await
        .expect_err("分块间应中断");
    assert_eq!(err.kind, ActionErrorKind::Aborted);
    assert_eq!(
        ops.count(MockOp::KeyEvent),
        50 * 3,
        "第 1 块完整保留（已输入部分）"
    );
    // 块间回读校验可能已做补差（第 1 块收尾），但第 2 块零注入（E2E-17）
    assert!(
        ops.count(MockOp::InsertText) <= 1,
        "第 2 块不得注入（补差最多 1 次）"
    );
}

/// submit_key：末尾按键。
#[tokio::test]
async fn type_submit_key_pressed() {
    let (exec, ops, _delay) = executor(
        MockOps::new(),
        MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }],
        ),
    );
    exec.type_text(
        &"t1".to_string(),
        1,
        ElementRef {
            index: 0,
            backend_node_id: 11,
        },
        "hello",
        Some("Enter"),
    )
    .await
    .expect("提交键应成功");
    let summary: Vec<String> = ops
        .calls_of(MockOp::KeyEvent)
        .iter()
        .map(|c| c.detail.clone())
        .collect();
    assert!(summary.last().unwrap().contains("keyUp key=\"Enter\""));
}
