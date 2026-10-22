//! type 回读校验/password/CJK 用例（自 keyboard.rs 平移）。

use super::*;

/// 回读校验补差（§4.4）：页面吞字符 → insertText 补缺失片段。
#[tokio::test]
async fn type_verify_replenishes_missing() {
    let ops = MockOps::new();
    // activeElement 值保持空（页面吞掉第 1 块）
    ops.state.lock().unwrap().active_value = String::new();
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
    exec.type_text(
        &"t1".to_string(),
        1,
        ElementRef {
            index: 0,
            backend_node_id: 11,
        },
        &"a".repeat(51),
        None,
    )
    .await
    .expect("补差后应成功");
    let inserts: Vec<String> = ops
        .calls_of(MockOp::InsertText)
        .iter()
        .map(|c| c.detail.clone())
        .collect();
    assert!(
        inserts
            .iter()
            .any(|d| d.contains(&format!("\"{}\"", "a".repeat(50)))),
        "应补差插入缺失片段：{inserts:?}"
    );
}

/// 回读校验连续 2 块失败 → 可重试错误（页面吞字符且不可恢复）。
#[tokio::test]
async fn type_verify_two_failures_stops() {
    let ops = MockOps::new();
    ops.state.lock().unwrap().active_value = "junk-diverged".to_string();
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
    let err = exec
        .type_text(
            &"t1".to_string(),
            1,
            ElementRef {
                index: 0,
                backend_node_id: 11,
            },
            &"a".repeat(120),
            None,
        )
        .await
        .expect_err("连续 2 块失败应中断");
    assert_eq!(err.kind, ActionErrorKind::NotInteractive);
    assert_eq!(ops.count(MockOp::InsertText), 0, "分歧不可恢复时不做补差");
}

/// password 回读只比对长度（§4.4）：长度一致 → 成功。
#[tokio::test]
async fn type_password_readback_length_only() {
    let ops = MockOps::new();
    ops.state.lock().unwrap().active_value = "x".repeat(100);
    let snapshot = MockSnapshotStore::with_elements(
        1,
        &[ElementMeta {
            backend_node_id: 11,
            is_password: true,
        }],
    );
    let (exec, ops, _delay) = executor(ops, snapshot);
    exec.type_text(
        &"t1".to_string(),
        1,
        ElementRef {
            index: 0,
            backend_node_id: 11,
        },
        &"a".repeat(120),
        None,
    )
    .await
    .expect("长度一致应通过");
    // 120 字符 → 3 块 → 2 次回读；密码回读无明文补差
    assert_eq!(ops.count(MockOp::InsertText), 0, "密码路径不补明文");
}

/// M2：password 输入目标 + CJK 文本走整块 insertText（IME 路径），回读仅
/// 长度比对（页面掩码态不回读明文比对）——密码框输入在工具面可用。
#[tokio::test]
async fn type_password_cjk_insert_text_length_only() {
    let ops = MockOps::new();
    // 页面掩码态：回读值恒为掩码字符（"x"×100）——若走明文前缀比对，
    // 两次回读必失配 → NotInteractive 中断；成功即证明仅长度比对（M2）
    ops.state.lock().unwrap().active_value = "x".repeat(100);
    let snapshot = MockSnapshotStore::with_elements(
        1,
        &[ElementMeta {
            backend_node_id: 11,
            is_password: true,
        }],
    );
    let (exec, ops, _delay) = executor(ops, snapshot);
    let text = "密码输入测试".repeat(10); // 100 个中文字符 → 2 整块
    exec.type_text(
        &"t1".to_string(),
        1,
        ElementRef {
            index: 0,
            backend_node_id: 11,
        },
        &text,
        None,
    )
    .await
    .expect("密码框中文输入应成功（insertText + 长度比对）");
    assert_eq!(ops.count(MockOp::KeyEvent), 0, "CJK 不走逐字符三事件");
    assert_eq!(
        ops.count(MockOp::InsertText),
        2,
        "两整块 insertText（IME 路径）"
    );
}

/// CJK 整块 insertText（IME 路径，§4.4）：中文 60 字符 → 2 块 insertText + 1 次补差。
#[tokio::test]
async fn type_cjk_uses_insert_text() {
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
    let text = "中文输入测试".repeat(10); // 60 个中文字符
    exec.type_text(
        &"t1".to_string(),
        1,
        ElementRef {
            index: 0,
            backend_node_id: 11,
        },
        &text,
        None,
    )
    .await
    .expect("中文输入应成功");
    assert_eq!(ops.count(MockOp::KeyEvent), 0, "CJK 不走逐字符三事件");
    // 块 1(50) + 块间补差(50) + 块 2(10) = 3 次 insertText
    assert_eq!(
        ops.count(MockOp::InsertText),
        3,
        "整块 insertText（2 块 + 1 补差）"
    );
}
