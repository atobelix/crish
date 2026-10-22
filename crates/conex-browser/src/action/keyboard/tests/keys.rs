//! 键映射表、组合键解析与 key 派发（修饰键掩码/释放顺序/finally 释放）用例（自 keyboard.rs 平移）。

use super::*;

/// 键映射表全覆盖（§4.3 表逐项）。
#[test]
fn key_map_full_coverage() {
    let names = [
        "Enter",
        "Tab",
        "Escape",
        "Space",
        "Backspace",
        "Delete",
        "Insert",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "ArrowLeft",
        "ArrowUp",
        "ArrowRight",
        "ArrowDown",
        "Shift",
        "Control",
        "Alt",
        "Meta",
        "F1",
        "F2",
        "F3",
        "F4",
        "F5",
        "F6",
        "F7",
        "F8",
        "F9",
        "F10",
        "F11",
        "F12",
        "Numpad0",
        "Numpad1",
        "Numpad2",
        "Numpad3",
        "Numpad4",
        "Numpad5",
        "Numpad6",
        "Numpad7",
        "Numpad8",
        "Numpad9",
        "NumpadAdd",
        "NumpadSubtract",
        "NumpadMultiply",
        "NumpadDivide",
        "NumpadDecimal",
        ";",
    ];
    assert_eq!(KEY_MAP.len(), names.len(), "映射表条目与键名表一致");
    for name in names {
        assert!(lookup_key(name).is_some(), "缺键：{name}");
    }
    // 掩码抽查
    assert_eq!(lookup_key("control").unwrap().modifier_mask, MOD_CTRL);
    assert_eq!(lookup_key("Shift").unwrap().modifier_mask, MOD_SHIFT);
    assert_eq!(lookup_key("Enter").unwrap().vk, 13);
    assert_eq!(lookup_key("F12").unwrap().vk, 123);
    assert_eq!(lookup_key("NumpadDecimal").unwrap().vk, 110);
}

/// 组合键解析（§4.3）：修饰键 + 主键；"Control++" 尾随加号字面键。
#[test]
fn parse_key_sequences() {
    let seq = parse_key_sequence("Control+A").expect("合法组合键");
    assert_eq!(seq.modifiers.len(), 1);
    assert_eq!(seq.modifiers[0].modifier_mask, MOD_CTRL);
    assert_eq!(seq.main.name, "A");
    assert!(seq.main.shift, "大写 A 需 Shift");

    let seq = parse_key_sequence("Control+Shift+ArrowUp").expect("多修饰键");
    assert_eq!(seq.modifiers.len(), 2);
    assert_eq!(seq.main.code, "ArrowUp");

    let seq = parse_key_sequence("Control++").expect("尾随 + 为字面键");
    assert_eq!(seq.main.name, "+");

    let seq = parse_key_sequence("Enter").expect("单键");
    assert!(seq.modifiers.is_empty());
    assert_eq!(seq.main.vk, 13);

    let seq = parse_key_sequence("control+a").expect("大小写不敏感");
    assert_eq!(seq.modifiers[0].modifier_mask, MOD_CTRL);

    // 非法键名
    assert!(parse_key_sequence("").is_err());
    assert!(parse_key_sequence("BogusKey").is_err());
    assert!(parse_key_sequence("Control+A+B").is_err(), "多个主键非法");
    assert!(
        parse_key_sequence("Control+").is_ok(),
        "Control+ 尾随 + 为字面加号"
    );
}

/// 组合键掩码序列（§4.3）：Control+A → down(2) → down(2)/char/up(2) → up(0)。
#[tokio::test]
async fn key_modifier_mask_sequence() {
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
    exec.key(&"t1".to_string(), 1, "Control+A")
        .await
        .expect("组合键应成功");
    let events = ops.calls_of(MockOp::KeyEvent);
    let summary: Vec<String> = events.iter().map(|c| c.detail.clone()).collect();
    assert_eq!(events.len(), 5, "down(Ctrl) down(A) char(A) up(A) up(Ctrl)");
    assert!(
        summary[0].contains("keyDown key=\"Control\"") && summary[0].contains("mods=2"),
        "{}",
        summary[0]
    );
    assert!(
        summary[1].contains("keyDown key=\"A\"") && summary[1].contains("mods=2"),
        "{}",
        summary[1]
    );
    assert!(
        summary[2].contains("char") && summary[2].contains("text=\"A\""),
        "{}",
        summary[2]
    );
    assert!(
        summary[3].contains("keyUp key=\"A\"") && summary[3].contains("mods=2"),
        "{}",
        summary[3]
    );
    assert!(
        summary[4].contains("keyUp key=\"Control\"") && summary[4].contains("mods=0"),
        "{}",
        summary[4]
    );
}

/// 多修饰键掩码序列：Control+Shift+A → 2/10/10/10/8/0（逆序释放）。
#[tokio::test]
async fn key_multi_modifier_release_order() {
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
    exec.key(&"t1".to_string(), 1, "Control+Shift+A")
        .await
        .expect("组合键应成功");
    let summary: Vec<String> = ops
        .calls_of(MockOp::KeyEvent)
        .iter()
        .map(|c| c.detail.clone())
        .collect();
    assert_eq!(summary.len(), 7);
    assert!(summary[0].contains("keyDown key=\"Control\"") && summary[0].contains("mods=2"));
    assert!(
        summary[1].contains("keyDown key=\"Shift\"") && summary[1].contains("mods=10"),
        "{}",
        summary[1]
    );
    assert!(summary[2].contains("keyDown key=\"A\"") && summary[2].contains("mods=10"));
    assert!(summary[3].contains("char") && summary[3].contains("text=\"A\""));
    assert!(summary[4].contains("keyUp key=\"A\"") && summary[4].contains("mods=10"));
    assert!(
        summary[5].contains("keyUp key=\"Shift\"") && summary[5].contains("mods=2"),
        "逆序释放 Shift（Control 仍按下）"
    );
    assert!(summary[6].contains("keyUp key=\"Control\"") && summary[6].contains("mods=0"));
}

/// try/finally 卡键恢复（§4.3）：主键 keyDown 抛错 → 修饰键仍逆序释放。
/// 错误持久注入：3 次尝试均失败 → 最终 Fatal（每次尝试的释放事件都必须存在）。
#[tokio::test]
async fn key_finally_releases_modifiers_on_error() {
    let ops = MockOps::new();
    ops.state.lock().unwrap().persist_errors.insert(
        MockOp::KeyEvent,
        ActionError::new(ActionErrorKind::ContextGone, "执行上下文销毁"),
    );
    let token = CancellationToken::new();
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
        .key(&"t1".to_string(), 1, "Control+Shift+A")
        .await
        .expect_err("应失败");
    assert_eq!(err.kind, ActionErrorKind::ContextGone);
    let summary: Vec<String> = ops
        .calls_of(MockOp::KeyEvent)
        .iter()
        .map(|c| c.detail.clone())
        .collect();
    // 每次尝试 = down(失败) + 释放×2 = 3 条；3 次尝试共 9 条
    assert_eq!(summary.len(), 9, "3 次尝试 × 3 条（每次含释放）");
    // 每次尝试的末尾两条必须是修饰键释放（try/finally 兜底，防逻辑卡键）
    for base in [0usize, 3, 6] {
        assert!(
            summary[base + 1].contains("keyUp key=\"Shift\"")
                && summary[base + 1].contains("mods=2"),
            "{}",
            summary[base + 1]
        );
        assert!(
            summary[base + 2].contains("keyUp key=\"Control\"")
                && summary[base + 2].contains("mods=0"),
            "{}",
            summary[base + 2]
        );
    }
}

/// 单键（Enter/Tab）：无修饰键序列。
#[tokio::test]
async fn key_single_enter() {
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
    exec.key(&"t1".to_string(), 1, "Enter")
        .await
        .expect("单键应成功");
    let summary: Vec<String> = ops
        .calls_of(MockOp::KeyEvent)
        .iter()
        .map(|c| c.detail.clone())
        .collect();
    assert_eq!(summary.len(), 2, "down + up");
    assert!(
        summary[0].contains("keyDown key=\"Enter\"")
            && summary[0].contains("mods=0")
            && summary[0].contains("vk=13")
    );
    assert!(
        summary[1].contains("keyUp key=\"Enter\"")
            && summary[1].contains("mods=0")
            && summary[1].contains("vk=13")
    );
}
