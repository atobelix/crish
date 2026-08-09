//! evaluate 受限求值（维度 14 §8，evaluate.rs）
//!
//! **唯一权威声明（R-6）**：evaluate 的实现以维度 17 §3 为唯一设计
//! （`__crish_read` 白名单代理对象 + 三层校验：静态词法 → isolated world 执行
//! （timeout 2s、constructor 链检查、纯 JSON 返回值）→ 结果预算 64KB/深度 4）。
//! 本模块只保留原语接口与审批对接点，**MVP 返回「未接线」结构化错误**（实现面由
//! M7 引擎侧接线维度 17 §3）。
//!
//! 审批与审计对接（17 §3.3/§6 权威）：能力位默认关（Ask 逐次审批，FullAccess 放行、
//! Plan 拒绝）；审计记 `sha256(expression)` + 长度；操作变体 browser-evaluate 以
//! 17 §6.1 为唯一权威（本模块不自定义审计事件，M-4）。

use crate::action::{ActionError, ActionErrorKind, ActionExecutor, ElementRef};
use serde_json::Value;

/// 受限求值请求（§8.2；允许形态/白名单 API 见 17 §3.1）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvaluateRequest {
    /// 受限求值表达式（白名单 API 见 17 §3.1）
    pub expression: String,
    /// 快照元素索引（可选；内部解析为 backendNodeId/objectId 后经代理求值）
    pub element: Option<ElementRef>,
    /// 求值硬限，上限 2000ms（17 §3.2）
    pub timeout_ms: u32,
}

/// evaluate 派发：接口引用维度 17 §3，MVP 未接线返回结构化错误。
///
/// 失败映射（17 §1.3）：静态词法/运行时拦截 → `tool.browser.eval_forbidden`（工具层）；
/// 能力位未开/审批拒绝 → 工具层先行拦截（17 §2.3/§3.3），原语层凭证兜底
/// `Fatal(ApprovalDenied)`。
pub async fn dispatch_evaluate(
    _exec: &ActionExecutor,
    _request: &EvaluateRequest,
) -> Result<Option<Value>, ActionError> {
    Err(ActionError::new(
        ActionErrorKind::Unsupported,
        "evaluate 未接线：受限求值实现以维度 17 §3 为唯一权威（__crish_read 白名单代理 + 三层校验，M7 接线）",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action::mocks::*;
    use crate::action::{ActionExecutor, ActionRequest, ElementMeta, Primitive};
    use crate::cdp::sender::CancellationToken;
    use std::sync::Arc;

    /// 接口面：evaluate 走统一流水线（门禁/版本/abort 通过后）→ 未接线结构化错误。
    #[tokio::test]
    async fn evaluate_returns_unwired_error() {
        let ops = MockOps::new();
        let executor = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            CancellationToken::new(),
        )
        .with_gate(Arc::new(AllowGate));
        let err = executor
            .execute(ActionRequest {
                tab_id: "t1".to_string(),
                snapshot_version: 1,
                element: None,
                primitive: Primitive::Evaluate(EvaluateRequest {
                    expression: "foo".to_string(),
                    element: None,
                    timeout_ms: 1000,
                }),
            })
            .await
            .expect_err("应返回未接线错误");
        assert_eq!(err.kind, ActionErrorKind::Unsupported);
        assert!(err.message.contains("未接线"));
        assert!(err.message.contains("17 §3"), "应引用维度 17 §3 唯一权威");
        // 未接线面不得触发任何 CDP 交互
        assert_eq!(ops.count(MockOp::Evaluate), 0);
    }
}
