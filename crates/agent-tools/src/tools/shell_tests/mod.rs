//! shell 工具测试（SR-06a-2 / Batch 5 WP39 物理拆分）
//!
//! 测试资产保护铁律：全部既有测试原样迁入，零删除；测试名与断言形状 100% 保持不变。

// G2 禁令豁免：测试 mod——真实 spawn 探测命令门禁语义（红线目标断言
// Blocked）+ pid 存活探测（tasklist / kill -0，T-AB-06/07 验收辅助），
// 非产品执行面；测试 mod 内 allow + 理由（裁决 D8 背书）。
#![allow(clippy::disallowed_methods)]

use super::*;
use crate::context::{create_mock_tool_context, AskChannel, ToolContext};
use conex_test_utils::TempWorkspace;
use std::sync::Arc;

pub(super) fn tool() -> ShellCommandTool {
    ShellCommandTool::new(30_000, 200_000, None)
}

/// 测试用会话上下文：workspace_root 指向临时工作区
pub(super) fn ctx(ws: &TempWorkspace) -> ToolContext {
    ToolContext {
        workspace_root: ws.path().clone(),
        ..create_mock_tool_context()
    }
}

/// 测试用审批通道：记录审批请求（工具名）并返回预设裁决
#[derive(Clone, Debug)]
pub(super) struct MockAskChannel {
    pub(super) decision: AskDecision,
    pub(super) requested: Arc<std::sync::Mutex<Vec<String>>>,
}

#[async_trait]
impl AskChannel for MockAskChannel {
    async fn ask(
        &self,
        tool_name: &str,
        _args: &serde_json::Value,
    ) -> Result<AskDecision, ToolError> {
        self.requested
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(tool_name.to_string());
        Ok(self.decision.clone())
    }
}

mod approval;
mod background;
mod delete_redirect;
mod execution;
mod security_policy;
mod streaming;
