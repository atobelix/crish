//! shell 工具测试（SR-06a-2 / Batch 5 WP39 物理拆分）

#![allow(clippy::disallowed_methods)]

use super::*;
use crate::context::{create_mock_tool_context, ToolContext};
use conex_test_utils::TempWorkspace;

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

mod background;
mod execution;
mod streaming;
