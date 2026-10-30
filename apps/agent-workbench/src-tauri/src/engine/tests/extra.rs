//! `engine/tests.rs` 尾部测试旁挂（行数门禁拆分；测试名、断言与逻辑零改动）。
//!
//! 由模块根 `engine/tests.rs` 经 `mod extra;` 接入（子模块路径 `engine/tests/extra.rs`）。
//! 承载：M1 注入顺序冻结契约测（仅依赖 `conex_run::context_injection` 公开常量与枚举）。

use conex_run::context_injection::{ContextInjectionKind, CONTEXT_INJECTION_ORDER};

/// M1 注入顺序契约（冻结快照）：`system → skills → mcp → agent 定义`
///
/// 断言（02 M1 内容 4 + 任务书内容 2）：顺序常量与枚举声明序/排序序
/// 三方一致——排序即协议，M11 重注入断言以此为契约；顺序变化必须
/// 同时改三处并被本快照捕获。
#[test]
fn injection_order_contract_is_frozen() {
    assert_eq!(
        CONTEXT_INJECTION_ORDER,
        [
            ContextInjectionKind::System,
            ContextInjectionKind::Skills,
            ContextInjectionKind::Mcp,
            ContextInjectionKind::AgentDefinition,
        ],
        "注入顺序契约：system → skills → mcp → agent 定义（变化视为协议变更）"
    );
    // 常量已按 enum Ord 升序（声明序 = 排序序 = 协议序）
    let mut sorted = CONTEXT_INJECTION_ORDER.to_vec();
    sorted.sort();
    assert_eq!(sorted, CONTEXT_INJECTION_ORDER);
}
