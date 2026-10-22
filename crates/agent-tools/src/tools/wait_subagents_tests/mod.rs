//! wait_subagents · 测试旁挂（SR-06a-3 外置；`#[path]` 接线，无孤儿）
//!
//! 全部既有测试原样迁移（零删除、零合并）：三模式 wire 解析与硬上限、
//! 工具入参解析与三模式行为（多代理批完成语义）、事件驱动等待原语、
//! 调度声明序列化与重启恢复（conex-db dev-dependency）、通道错误映射、
//! 产出文件收集（G02 完成通知字段）、dispatch_outputs 序列化与旧数据容错。
//! 诚实边界：仅结构拆分，语义零改动（≠ EL / ≠ 打开完成 / ≠ 结构债清零）。

// G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use super::*;
use crate::context::{create_mock_tool_context, ToolContext};
use crate::definition::Tool;
use crate::tools::subagent::SubagentState;
use crate::write_paths::{ClaimMode, WritePathRegistry};
use async_trait::async_trait;
use conex_test_utils::TempWorkspace;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

// ── 测试替身 ──────────────────────────────────────────────────

/// 记录式等待通道：记录持久化/注入/等待调用，按预设结果应答
#[derive(Debug)]
struct RecordingWaitChannel {
    persists: Mutex<Vec<DispatchDeclaration>>,
    injects: Mutex<Vec<(String, String)>>,
    waits: Mutex<Vec<(Vec<String>, Option<u64>)>>,
    output_persists: Mutex<Vec<HashMap<String, Vec<SubagentOutput>>>>,
    snap: Vec<SubagentWaitStatus>,
    wait_result: SubagentWaitResult,
}

impl RecordingWaitChannel {
    fn new(snap: Vec<SubagentWaitStatus>, wait_result: SubagentWaitResult) -> Self {
        Self {
            persists: Mutex::new(Vec::new()),
            injects: Mutex::new(Vec::new()),
            waits: Mutex::new(Vec::new()),
            output_persists: Mutex::new(Vec::new()),
            snap,
            wait_result,
        }
    }

    fn persists(&self) -> Vec<DispatchDeclaration> {
        self.persists.lock().unwrap().clone()
    }

    fn injects(&self) -> Vec<(String, String)> {
        self.injects.lock().unwrap().clone()
    }

    fn waits(&self) -> Vec<(Vec<String>, Option<u64>)> {
        self.waits.lock().unwrap().clone()
    }

    fn output_persists(&self) -> Vec<HashMap<String, Vec<SubagentOutput>>> {
        self.output_persists.lock().unwrap().clone()
    }
}

#[async_trait]
impl SubagentWaitChannel for RecordingWaitChannel {
    async fn persist_declaration(
        &self,
        declaration: &DispatchDeclaration,
    ) -> Result<(), SubagentWaitError> {
        self.persists.lock().unwrap().push(declaration.clone());
        Ok(())
    }

    async fn persist_outputs(
        &self,
        outputs: &HashMap<String, Vec<SubagentOutput>>,
    ) -> Result<(), SubagentWaitError> {
        self.output_persists.lock().unwrap().push(outputs.clone());
        Ok(())
    }

    async fn snapshot(
        &self,
        _subagent_ids: &[String],
    ) -> Result<Vec<SubagentWaitStatus>, SubagentWaitError> {
        Ok(self.snap.clone())
    }

    async fn wait_for_terminal(
        &self,
        subagent_ids: &[String],
        timeout_ms: Option<u64>,
    ) -> Result<SubagentWaitResult, SubagentWaitError> {
        self.waits
            .lock()
            .unwrap()
            .push((subagent_ids.to_vec(), timeout_ms));
        Ok(self.wait_result.clone())
    }

    async fn inject(&self, subagent_id: &str, prompt: &str) -> Result<(), SubagentWaitError> {
        self.injects
            .lock()
            .unwrap()
            .push((subagent_id.to_string(), prompt.to_string()));
        Ok(())
    }
}

/// 事件流通道：把注入的终态事件 mpsc 直接对接等待原语
/// （引擎侧实现同构：subagent-ended 事件流 → mpsc → 原语）
#[derive(Debug)]
struct EventStreamChannel {
    rx: Mutex<Option<mpsc::Receiver<SubagentTerminalEvent>>>,
    dispatched_at_ms: u64,
}

#[async_trait]
impl SubagentWaitChannel for EventStreamChannel {
    async fn persist_declaration(
        &self,
        _declaration: &DispatchDeclaration,
    ) -> Result<(), SubagentWaitError> {
        Ok(())
    }

    async fn snapshot(
        &self,
        subagent_ids: &[String],
    ) -> Result<Vec<SubagentWaitStatus>, SubagentWaitError> {
        Ok(subagent_ids
            .iter()
            .map(|id| SubagentWaitStatus {
                subagent_id: id.clone(),
                status: SubagentState::Running,
                summary: None,
                elapsed_ms: 0,
                terminal: false,
            })
            .collect())
    }

    async fn wait_for_terminal(
        &self,
        subagent_ids: &[String],
        timeout_ms: Option<u64>,
    ) -> Result<SubagentWaitResult, SubagentWaitError> {
        let rx = self
            .rx
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| SubagentWaitError::Unavailable("事件流已消费".to_string()))?;
        Ok(wait_for_terminal_events(
            subagent_ids,
            rx,
            timeout_ms.map(Duration::from_millis),
            self.dispatched_at_ms,
        )
        .await)
    }

    async fn inject(&self, _subagent_id: &str, _prompt: &str) -> Result<(), SubagentWaitError> {
        Ok(())
    }
}

fn status(id: &str, state: SubagentState, elapsed_ms: u64) -> SubagentWaitStatus {
    SubagentWaitStatus {
        subagent_id: id.to_string(),
        status: state,
        summary: None,
        elapsed_ms,
        terminal: matches!(state, SubagentState::Completed | SubagentState::Failed),
    }
}

mod declaration_dispatch;
mod output_files;
mod primitive;
mod tool_modes;
