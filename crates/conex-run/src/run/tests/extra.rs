//! run/tests.rs 拆出的独立小测试（仅搬移，断言与用例数不变）。
//!
//! 经 run/tests.rs `mod extra;` 挂载；显式导入被搬移用例所需符号
//! （与 run/tests.rs 的 `use super::*` 聚合面同源，不依赖父模 glob 细节）。

use conex_types::error::codes;
use conex_types::events::ApprovalDecision;

use crate::run::run_launch::crish_payload_from_message;

/// 错误文案 → payload：77 码兜底 + 人读文案
#[test]
fn failure_payload_uses_common_unknown_code() {
    let payload = crish_payload_from_message("provider 调用失败");
    assert_eq!(payload.code, codes::COMMON_UNKNOWN);
    assert!(payload.message.contains("provider 调用失败"));
    assert!(!payload.retryable);
}

/// 审批映射：wire 决策规范值（approved / denied / expired，03 §5.3-3）
#[test]
fn approval_decisions_map_to_wire_values() {
    let json = serde_json::to_string(&ApprovalDecision::Denied).unwrap();
    assert_eq!(json, "\"denied\"");
    let approved = serde_json::to_string(&ApprovalDecision::Approved).unwrap();
    assert_eq!(approved, "\"approved\"");
}
