//! `error/tests.rs` 尾部测试旁挂（行数门禁拆分；测试名、断言与逻辑零改动）。
//!
//! 由模块根 `error/tests.rs` 经 `mod extra;` 接入（子模块路径 `error/tests/extra.rs`）。
//! 承载：RequestBuildError 导线层 Fail-Closed 守门错误（详案 02 §4.3）两测。

use crate::error::RequestBuildError;

// ── RequestBuildError（导线层 Fail-Closed 守门错误，详案 02 §4.3）──

/// UnpairedToolCalls：孤儿 ID 访问器、协议标识与 Display 语义（会话循环
/// 「补齐后重试」路径依赖这些字段做逐 ID 对账）
#[test]
fn request_build_error_unpaired_tool_calls_shape() {
    let err = RequestBuildError::UnpairedToolCalls {
        protocol: "anthropic",
        orphan_ids: vec!["call_a".to_string(), "call_b".to_string()],
    };
    assert_eq!(err.orphan_ids(), ["call_a", "call_b"]);
    assert_eq!(err.protocol(), Some("anthropic"));
    let display = err.to_string();
    assert!(
        display.contains("anthropic"),
        "Display 应含协议轨：{display}"
    );
    assert!(display.contains("call_a"), "Display 应含孤儿 ID：{display}");
    assert!(display.contains("call_b"), "Display 应含孤儿 ID：{display}");
}

/// Other 变体：orphan_ids 返回空切片、protocol 返回 None（非成对性错误）
#[test]
fn request_build_error_other_has_no_orphans() {
    let err = RequestBuildError::Other("构造失败".to_string());
    assert!(err.orphan_ids().is_empty());
    assert_eq!(err.protocol(), None);
    assert!(err.to_string().contains("构造失败"));
}
