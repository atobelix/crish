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

// ── 模式 wire 解析 ────────────────────────────────────────────

#[test]
fn wait_mode_wire_roundtrip() {
    for (wire, mode) in [
        ("await-all", WaitMode::AwaitAll),
        ("timer", WaitMode::Timer),
        ("parallel-work", WaitMode::ParallelWork),
    ] {
        assert_eq!(WaitMode::parse(wire), Some(mode));
        assert_eq!(mode.as_str(), wire);
    }
    assert_eq!(WaitMode::parse("await_all"), None);
    assert_eq!(WaitMode::parse("unknown"), None);
}

#[test]
fn hard_cap_and_timer_default_constants() {
    // 02 §5.4：timeout 硬上限 10 分钟（对齐 grok cap）
    assert_eq!(MAX_WAIT_TIMEOUT_MS, 600_000);
    // 04 C8 §2.1：timer 默认 30s
    assert_eq!(DEFAULT_TIMER_WAIT_MS, 30_000);
}

// ── 工具入参解析 ──────────────────────────────────────────────

#[tokio::test]
async fn tool_requires_subagent_ids() {
    let channel = Arc::new(RecordingWaitChannel::new(
        Vec::new(),
        SubagentWaitResult {
            mode: WaitMode::AwaitAll,
            all_terminal: true,
            timed_out: false,
            agents: Vec::new(),
        },
    ));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let err = tool.execute(&ctx, serde_json::json!({})).await.unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    let err = tool
        .execute(&ctx, serde_json::json!({ "subagentIds": [] }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    let err = tool
        .execute(&ctx, serde_json::json!({ "subagentIds": ["sub-1", ""] }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(channel.persists().is_empty(), "入参非法不得持久化声明");
}

#[tokio::test]
async fn tool_rejects_unknown_mode() {
    let channel = Arc::new(RecordingWaitChannel::new(
        Vec::new(),
        SubagentWaitResult {
            mode: WaitMode::AwaitAll,
            all_terminal: true,
            timed_out: false,
            agents: Vec::new(),
        },
    ));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(
            &ctx,
            serde_json::json!({ "subagentIds": ["sub-1"], "mode": "wait-forever" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("未知等待模式"));
    assert!(channel.persists().is_empty());
}

#[tokio::test]
async fn tool_rejects_timeout_over_hard_cap() {
    let channel = Arc::new(RecordingWaitChannel::new(
        Vec::new(),
        SubagentWaitResult {
            mode: WaitMode::AwaitAll,
            all_terminal: true,
            timed_out: false,
            agents: Vec::new(),
        },
    ));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(
            &ctx,
            serde_json::json!({ "subagentIds": ["sub-1"], "timeoutMs": 600_001 }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("10 分钟"));
    // 恰在上限内（600_000）不拒绝
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({ "subagentIds": ["sub-1"], "timeoutMs": 600_000 }),
        )
        .await
        .unwrap();
    assert_eq!(out["mode"], "await-all");
}

// ── 三模式行为 ────────────────────────────────────────────────

#[tokio::test]
async fn parallel_work_returns_immediately_with_snapshot() {
    let snap = vec![status("sub-1", SubagentState::Running, 1_000)];
    let channel = Arc::new(RecordingWaitChannel::new(
        snap,
        SubagentWaitResult {
            mode: WaitMode::ParallelWork,
            all_terminal: true,
            timed_out: false,
            agents: Vec::new(),
        },
    ));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "subagentIds": ["sub-1"],
                "mode": "parallel-work",
                "timeoutMs": 300_000
            }),
        )
        .await
        .unwrap();
    // 立即返回：快照非终态 → allTerminal=false、未走 wait_for_terminal
    assert_eq!(out["mode"], "parallel-work");
    assert_eq!(out["allTerminal"], false);
    assert_eq!(out["timedOut"], false);
    assert_eq!(out["agents"][0]["subagentId"], "sub-1");
    assert_eq!(out["agents"][0]["status"], "running");
    assert_eq!(out["agents"][0]["terminal"], false);
    assert!(channel.waits().is_empty(), "parallel-work 不得走阻塞等待");
    // 声明已持久化（模式 + 已分发清单）
    let persists = channel.persists();
    assert_eq!(persists.len(), 1);
    assert_eq!(persists[0].mode, WaitMode::ParallelWork);
    assert_eq!(persists[0].subagent_ids, vec!["sub-1"]);
}

#[tokio::test]
async fn await_all_waits_all_terminal_before_returning() {
    let done = SubagentWaitResult {
        mode: WaitMode::AwaitAll,
        all_terminal: true,
        timed_out: false,
        agents: vec![
            status("sub-1", SubagentState::Completed, 12_000),
            status("sub-2", SubagentState::Failed, 8_000),
        ],
    };
    let channel = Arc::new(RecordingWaitChannel::new(Vec::new(), done));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({ "subagentIds": ["sub-1", "sub-2"] }),
        )
        .await
        .unwrap();
    assert_eq!(out["mode"], "await-all", "缺省模式 = await-all");
    assert_eq!(out["allTerminal"], true);
    assert_eq!(out["timedOut"], false);
    assert_eq!(out["agents"][0]["status"], "completed");
    assert_eq!(out["agents"][1]["status"], "failed");
    assert_eq!(out["agents"][0]["elapsedMs"], 12_000);
    let waits = channel.waits();
    assert_eq!(waits.len(), 1);
    assert_eq!(waits[0].0, vec!["sub-1", "sub-2"]);
    assert_eq!(waits[0].1, None, "await-all 缺省不限时");
    // 声明含 wait_ms=None
    assert_eq!(channel.persists()[0].wait_ms, None);
}

#[tokio::test]
async fn timer_returns_incomplete_list_at_timeout() {
    let timed_out = SubagentWaitResult {
        mode: WaitMode::Timer,
        all_terminal: false,
        timed_out: true,
        agents: vec![
            status("sub-1", SubagentState::Completed, 5_000),
            status("sub-2", SubagentState::Running, 30_000),
        ],
    };
    let channel = Arc::new(RecordingWaitChannel::new(Vec::new(), timed_out));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    // 缺省 timeoutMs → 默认 30s（dispatch_wait_ms）
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({ "subagentIds": ["sub-1", "sub-2"], "mode": "timer" }),
        )
        .await
        .unwrap();
    assert_eq!(out["timedOut"], true);
    assert_eq!(out["allTerminal"], false);
    assert_eq!(
        out["agents"][1]["status"], "running",
        "未完成 run 保持 running"
    );
    let waits = channel.waits();
    assert_eq!(waits[0].1, Some(30_000), "timer 缺省等待窗 30s");
    assert_eq!(channel.persists()[0].wait_ms, Some(30_000));
    // 显式 timeoutMs 生效
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "subagentIds": ["sub-1", "sub-2"],
                "mode": "timer",
                "timeoutMs": 120_000
            }),
        )
        .await
        .unwrap();
    assert_eq!(out["mode"], "timer");
    assert_eq!(channel.waits()[1].1, Some(120_000));
}

#[tokio::test]
async fn timeout_zero_is_non_blocking_snapshot() {
    // 02 Top 7：省略 timeout 或 0 = 非阻塞快照
    let snap = vec![status("sub-1", SubagentState::Completed, 9_000)];
    let channel = Arc::new(RecordingWaitChannel::new(
        snap,
        SubagentWaitResult {
            mode: WaitMode::Timer,
            all_terminal: true,
            timed_out: false,
            agents: Vec::new(),
        },
    ));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({ "subagentIds": ["sub-1"], "mode": "timer", "timeoutMs": 0 }),
        )
        .await
        .unwrap();
    assert_eq!(out["agents"][0]["status"], "completed");
    assert!(channel.waits().is_empty(), "timeoutMs=0 不得阻塞等待");
}

#[tokio::test]
async fn inject_routed_to_channel_during_wait() {
    let done = SubagentWaitResult {
        mode: WaitMode::AwaitAll,
        all_terminal: true,
        timed_out: false,
        agents: vec![status("sub-1", SubagentState::Completed, 1_000)],
    };
    let channel = Arc::new(RecordingWaitChannel::new(Vec::new(), done));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "subagentIds": ["sub-1"],
                "inject": { "subagentId": "sub-1", "prompt": "调整方向：优先低风险改动" }
            }),
        )
        .await
        .unwrap();
    assert_eq!(out["allTerminal"], true);
    let injects = channel.injects();
    assert_eq!(injects.len(), 1, "等待期间注入一次");
    assert_eq!(injects[0].0, "sub-1");
    assert_eq!(injects[0].1, "调整方向：优先低风险改动");
    // 注入先于等待
    assert!(!channel.persists().is_empty());
}

#[tokio::test]
async fn tool_without_channel_returns_structured_unavailable() {
    let tool = WaitSubagentsTool::new();
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(&ctx, serde_json::json!({ "subagentIds": ["sub-1"] }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "common.unsupported");
    assert!(err.to_string().contains("未接线"));
}

#[tokio::test]
async fn inject_malformed_args_rejected() {
    let done = SubagentWaitResult {
        mode: WaitMode::AwaitAll,
        all_terminal: true,
        timed_out: false,
        agents: Vec::new(),
    };
    let channel = Arc::new(RecordingWaitChannel::new(Vec::new(), done));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    for bad in [
        serde_json::json!({ "subagentIds": ["sub-1"], "inject": "x" }),
        serde_json::json!({ "subagentIds": ["sub-1"], "inject": { "prompt": "p" } }),
        serde_json::json!({ "subagentIds": ["sub-1"], "inject": { "subagentId": "s" } }),
    ] {
        let err = tool.execute(&ctx, bad).await.unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
    }
    assert!(channel.persists().is_empty());
}

// ── 事件驱动等待原语 ──────────────────────────────────────────

fn terminal_event(id: &str, state: SubagentState, ended_at_ms: u64) -> SubagentTerminalEvent {
    SubagentTerminalEvent {
        subagent_id: id.to_string(),
        status: state,
        summary: Some(format!("{id} 完成")),
        ended_at_ms,
    }
}

#[tokio::test]
async fn primitive_waits_all_terminal_via_events() {
    let (tx, rx) = mpsc::channel(8);
    tx.send(terminal_event("sub-2", SubagentState::Completed, 2_000))
        .await
        .unwrap();
    tx.send(terminal_event("sub-1", SubagentState::Failed, 1_000))
        .await
        .unwrap();
    drop(tx);
    let result = wait_for_terminal_events(
        &["sub-1".to_string(), "sub-2".to_string()],
        rx,
        Some(Duration::from_secs(5)),
        0,
    )
    .await;
    assert!(result.all_terminal, "全部终态事件到达 → all_terminal");
    assert!(!result.timed_out);
    assert_eq!(result.agents[0].status, SubagentState::Failed);
    assert_eq!(
        result.agents[0].elapsed_ms, 1_000,
        "elapsed = ended - dispatched"
    );
    assert_eq!(result.agents[1].status, SubagentState::Completed);
    assert_eq!(result.agents[1].summary.as_deref(), Some("sub-2 完成"));
}

#[tokio::test]
async fn primitive_times_out_returning_incomplete() {
    let (tx, rx) = mpsc::channel(8);
    tx.send(terminal_event("sub-1", SubagentState::Completed, 500))
        .await
        .unwrap();
    // 不发送 sub-2 终态：到点返回
    let result = wait_for_terminal_events(
        &["sub-1".to_string(), "sub-2".to_string()],
        rx,
        Some(Duration::from_millis(60)),
        0,
    )
    .await;
    assert!(!result.all_terminal);
    assert!(result.timed_out, "timer 到点返回");
    assert_eq!(result.agents[0].status, SubagentState::Completed);
    assert_eq!(
        result.agents[1].status,
        SubagentState::Running,
        "未完成保持 running"
    );
    assert!(!result.agents[1].terminal);
    drop(tx);
}

#[tokio::test]
async fn primitive_no_timeout_waits_until_stream_closed_or_all_terminal() {
    let (tx, rx) = mpsc::channel(8);
    tx.send(terminal_event("sub-1", SubagentState::Completed, 100))
        .await
        .unwrap();
    drop(tx);
    // 无超时 + 流关闭：返回当前态（fail-open 不 panic）
    let result =
        wait_for_terminal_events(&["sub-1".to_string(), "sub-2".to_string()], rx, None, 0)
            .await;
    assert!(!result.all_terminal);
    assert!(!result.timed_out);
    assert_eq!(result.agents[1].status, SubagentState::Running);
}

#[tokio::test]
async fn primitive_ignores_duplicates_and_unknown_ids() {
    let (tx, rx) = mpsc::channel(8);
    // 重复终态事件（幂等）+ 非等待名单子代理终态（并发其它子代理）
    tx.send(terminal_event("sub-1", SubagentState::Completed, 100))
        .await
        .unwrap();
    tx.send(terminal_event("sub-1", SubagentState::Completed, 200))
        .await
        .unwrap();
    tx.send(terminal_event("sub-9", SubagentState::Completed, 300))
        .await
        .unwrap();
    tx.send(terminal_event("sub-2", SubagentState::Failed, 400))
        .await
        .unwrap();
    let result = wait_for_terminal_events(
        &["sub-1".to_string(), "sub-2".to_string()],
        rx,
        Some(Duration::from_secs(5)),
        0,
    )
    .await;
    assert!(result.all_terminal);
    assert_eq!(
        result.agents[0].elapsed_ms, 100,
        "首条终态事件生效，重复事件不覆盖"
    );
}

#[tokio::test]
async fn primitive_empty_ids_returns_immediately() {
    let (_tx, rx) = mpsc::channel(8);
    let result = wait_for_terminal_events(&[], rx, None, 0).await;
    assert!(result.all_terminal);
    assert!(result.agents.is_empty());
}

#[tokio::test]
async fn channel_level_event_driven_wait() {
    // 通道级联测：EventStreamChannel（引擎侧实现同构）经 mpsc 对接原语
    let (tx, rx) = mpsc::channel(8);
    let channel = EventStreamChannel {
        rx: Mutex::new(Some(rx)),
        dispatched_at_ms: 1_000,
    };
    let tool = WaitSubagentsTool::with_channel(Some(Arc::new(channel)));
    let ctx = create_mock_tool_context();
    let wait_task = tool.execute(
        &ctx,
        serde_json::json!({ "subagentIds": ["sub-1"], "mode": "timer", "timeoutMs": 60_000 }),
    );
    // 等待期间注入终态事件（subagent-ended 消费点）
    tx.send(terminal_event("sub-1", SubagentState::Completed, 2_000))
        .await
        .unwrap();
    drop(tx);
    let out = wait_task.await.unwrap();
    assert_eq!(out["allTerminal"], true);
    assert_eq!(out["agents"][0]["status"], "completed");
    assert_eq!(
        out["agents"][0]["elapsedMs"], 1_000,
        "elapsed = ended(2000) - dispatched(1000)"
    );
}

// ── 调度声明：序列化与剩余等待（重启恢复）───────────────────

#[test]
fn declaration_meta_pairs_roundtrip() {
    let decl = DispatchDeclaration {
        mode: WaitMode::Timer,
        wait_ms: Some(30_000),
        subagent_ids: vec!["sub-1".to_string(), "sub-2".to_string()],
        dispatched_at_ms: 1_000_000,
    };
    let pairs = decl.to_meta_pairs();
    assert_eq!(pairs[0].0, "dispatch_mode");
    assert_eq!(pairs[0].1, "timer");
    assert_eq!(pairs[1].0, "dispatch_wait_ms");
    assert_eq!(pairs[1].1, "30000");
    assert_eq!(pairs[2].0, "dispatch_agents");
    assert!(pairs[2].1.contains("sub-1"));
    let restored = DispatchDeclaration::from_meta_pairs(pairs).expect("恢复声明");
    assert_eq!(restored, decl);
}

#[test]
fn declaration_remaining_wait_computation() {
    let decl = DispatchDeclaration {
        mode: WaitMode::Timer,
        wait_ms: Some(30_000),
        subagent_ids: vec!["sub-1".to_string()],
        dispatched_at_ms: 1_000_000,
    };
    assert_eq!(decl.remaining_wait_ms(1_010_000), Some(20_000));
    assert_eq!(decl.remaining_wait_ms(1_030_000), Some(0));
    assert!(decl.is_expired(1_030_000));
    assert!(!decl.is_expired(1_029_999));
    // 不限时（await-all / parallel-work 缺省）：剩余恒 None
    let unlimited = DispatchDeclaration {
        mode: WaitMode::AwaitAll,
        wait_ms: None,
        subagent_ids: vec!["sub-1".to_string()],
        dispatched_at_ms: 1_000_000,
    };
    assert_eq!(unlimited.remaining_wait_ms(u64::MAX), None);
}

#[test]
fn declaration_from_meta_pairs_fail_open() {
    // 关键键缺失 / 非法 → None（不 panic）
    assert!(
        DispatchDeclaration::from_meta_pairs([("dispatch_mode", "timer".to_string())])
            .is_none()
    );
    let bad = vec![
        ("dispatch_mode", "timer".to_string()),
        ("dispatch_wait_ms", "abc".to_string()),
        ("dispatch_agents", "[]".to_string()),
        ("dispatch_dispatched_at", "1000".to_string()),
    ];
    assert!(
        DispatchDeclaration::from_meta_pairs(bad).is_none(),
        "空清单视为无效"
    );
    // wait_ms 非法 → 宽容为 None（不限时）
    let ok = vec![
        ("dispatch_mode", "timer".to_string()),
        ("dispatch_wait_ms", "abc".to_string()),
        ("dispatch_agents", "[\"sub-1\"]".to_string()),
        ("dispatch_dispatched_at", "1000".to_string()),
    ];
    let decl = DispatchDeclaration::from_meta_pairs(ok).expect("恢复");
    assert_eq!(decl.mode, WaitMode::Timer);
    assert_eq!(decl.wait_ms, None);
}

// ── dispatch_* 落库与重启恢复（conex-db dev-dependency）───────

/// 引擎侧同构的 dispatch_* 存储（session_meta 键 → 值，只读接口）
struct DbDispatchStore {
    db: conex_db::LocalDb,
}

impl DbDispatchStore {
    fn persist(&self, declaration: &DispatchDeclaration) -> Result<(), conex_db::DbFailure> {
        for (key, value) in declaration.to_meta_pairs() {
            self.db.set_session_meta(key, &value)?;
        }
        Ok(())
    }

    fn load(&self) -> Option<DispatchDeclaration> {
        let pairs = [
            DISPATCH_META_KEY_MODE,
            DISPATCH_META_KEY_WAIT_MS,
            DISPATCH_META_KEY_AGENTS,
            DISPATCH_META_KEY_DISPATCHED_AT,
        ]
        .iter()
        .filter_map(|key| {
            self.db
                .get_session_meta(key)
                .ok()
                .flatten()
                .map(|value| (*key, value))
        })
        .collect::<Vec<_>>();
        DispatchDeclaration::from_meta_pairs(pairs)
    }
}

#[test]
fn dispatch_meta_persists_across_restart() {
    let ws = TempWorkspace::new("wait_dispatch_meta");
    let db_path = ws.path().join("sessions.db");
    let declaration = DispatchDeclaration {
        mode: WaitMode::Timer,
        wait_ms: Some(30_000),
        subagent_ids: vec!["sub-1".to_string(), "sub-2".to_string()],
        dispatched_at_ms: 1_000_000,
    };

    // 第一次打开：持久化调度声明
    {
        let db = conex_db::LocalDb::open(&db_path).expect("打开测试库失败");
        DbDispatchStore { db }
            .persist(&declaration)
            .expect("落库失败");
    }

    // 模拟重启：重新打开同一库文件，恢复「等待什么」
    let db = conex_db::LocalDb::open(&db_path).expect("重开测试库失败");
    let restored = DbDispatchStore { db }.load().expect("重启恢复声明");
    assert_eq!(restored, declaration);
    assert_eq!(
        restored.remaining_wait_ms(1_010_000),
        Some(20_000),
        "重启后按 dispatch_dispatched_at 重算剩余等待"
    );
    assert!(restored.is_expired(1_030_000), "到点判定可跨重启");
}

#[test]
fn dispatch_meta_mode_roundtrip_all_modes() {
    let ws = TempWorkspace::new("wait_dispatch_modes");
    let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    let store = DbDispatchStore { db };
    for (mode, wait_ms) in [
        (WaitMode::AwaitAll, None),
        (WaitMode::Timer, Some(45_000)),
        (WaitMode::ParallelWork, None),
    ] {
        let declaration = DispatchDeclaration {
            mode,
            wait_ms,
            subagent_ids: vec!["sub-1".to_string()],
            dispatched_at_ms: 2_000_000,
        };
        store.persist(&declaration).expect("落库失败");
        let restored = store.load().expect("恢复");
        assert_eq!(restored, declaration, "模式 {mode:?} 跨写读一致");
    }
}

// ── 通道错误映射 ──────────────────────────────────────────────

#[test]
fn wait_error_codes_mapped() {
    assert_eq!(
        SubagentWaitError::UnknownAgent("x".to_string()).code(),
        "common.not_found"
    );
    assert_eq!(
        SubagentWaitError::PersistFailed("e".to_string()).code(),
        "store.write_failed"
    );
    assert_eq!(
        SubagentWaitError::InjectFailed("e".to_string()).code(),
        "tool.execution_failed"
    );
    assert_eq!(
        SubagentWaitError::Unavailable("e".to_string()).code(),
        "common.unsupported"
    );
}

// ── 产出文件（G02 完成通知字段，T-EG-10）──────────────────────

/// 从 write_claims 持有者记录收集产出文件：写模式声明命中、目录声明
/// 展开为直接子文件（不递归）、其他持有者与删除模式声明排除、
/// 摘要取子代理最终消息摘要、字节数为实际文件大小、路径为工作区相对
#[test]
fn output_files_collected_from_write_claims() {
    let ws = TempWorkspace::new("output_files_collect");
    let root = ws.path();
    std::fs::write(root.join("01-kernel-analysis.md"), "# 内核分析\n正文").unwrap();
    std::fs::create_dir_all(root.join("docs")).unwrap();
    std::fs::write(root.join("docs/02-frontend.md"), "# 前端分析").unwrap();
    std::fs::create_dir_all(root.join("docs/nested")).unwrap();
    std::fs::write(root.join("docs/nested/03-inner.md"), "嵌套子目录").unwrap();
    std::fs::write(root.join("99-delete-mode.md"), "删除模式声明").unwrap();
    std::fs::write(root.join("04-other-holder.md"), "其他持有者").unwrap();
    let registry = Arc::new(WritePathRegistry::new("s1", root));
    // 子代理 sub-1：单文件声明 + 目录级声明（产出目录语义）
    let _a = registry
        .claim_one("sub-1", "01-kernel-analysis.md", ClaimMode::Write)
        .unwrap();
    let _b = registry.claim_one("sub-1", "docs", ClaimMode::Write).unwrap();
    // 其他持有者 / 删除模式声明 → 不得混入产出清单
    let _c = registry
        .claim_one("sub-2", "04-other-holder.md", ClaimMode::Write)
        .unwrap();
    let _d = registry
        .claim_one("sub-3", "99-delete-mode.md", ClaimMode::Delete)
        .unwrap();

    let files = collect_subagent_output_files(
        Some(&registry),
        "sub-1",
        root,
        Some("sub-1 完成"),
    );
    let paths = files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>();
    assert_eq!(
        paths,
        ["01-kernel-analysis.md", "docs/02-frontend.md"],
        "目录声明展开为直接子文件，嵌套子目录与越权持有者/删除模式不产出"
    );
    // 字节数为实际文件大小
    assert_eq!(files[0].bytes, "# 内核分析\n正文".len() as u64);
    assert_eq!(files[1].bytes, "# 前端分析".len() as u64);
    // 摘要取子代理最终消息摘要（同一子代理全部产出共享）
    assert_eq!(files[0].summary, "sub-1 完成");
    assert_eq!(files[1].summary, "sub-1 完成");
}

/// 无最终消息摘要时摘要回退文件首行概述（§4.6）；空文件 → 空摘要
#[test]
fn output_files_summary_falls_back_to_first_line() {
    let ws = TempWorkspace::new("output_files_summary");
    let root = ws.path();
    std::fs::write(root.join("a.md"), "# 标题\n\n正文第二行").unwrap();
    std::fs::write(root.join("empty.md"), "").unwrap();
    let registry = Arc::new(WritePathRegistry::new("s1", root));
    let _a = registry.claim_one("sub-1", "a.md", ClaimMode::Write).unwrap();
    let _b = registry
        .claim_one("sub-1", "empty.md", ClaimMode::Write)
        .unwrap();

    let files = collect_subagent_output_files(Some(&registry), "sub-1", root, None);
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].summary, "# 标题", "首行概述（跳过空行）");
    assert_eq!(files[1].summary, "", "空文件无首行可概述");
}

/// 声明路径已被删除 → 不产出（运行期删除的中间文件不进完成通知）
#[test]
fn output_files_skip_deleted_paths() {
    let ws = TempWorkspace::new("output_files_deleted");
    let root = ws.path();
    std::fs::write(root.join("gone.md"), "已删除").unwrap();
    let registry = Arc::new(WritePathRegistry::new("s1", root));
    let _a = registry.claim_one("sub-1", "gone.md", ClaimMode::Write).unwrap();
    std::fs::remove_file(root.join("gone.md")).unwrap();
    let files = collect_subagent_output_files(Some(&registry), "sub-1", root, None);
    assert!(files.is_empty(), "删除后的路径不得出现在产出清单");
}

/// 注册表未接线（None）→ 空清单（fail-open，不报错）
#[test]
fn output_files_unwired_registry_returns_empty() {
    assert!(collect_subagent_output_files(None, "sub-1", Path::new("."), None).is_empty());
}

/// await-all 终态载荷附带 outputFiles（path/summary/bytes），且产出
/// 清单随 dispatch_* 持久化（persist_outputs 调用，G02 完成通知字段）
#[tokio::test]
async fn await_all_envelope_carries_output_files() {
    let ws = TempWorkspace::new("wait_output_files");
    let root = ws.path();
    std::fs::write(root.join("01-kernel-analysis.md"), "KERNEL_BODY").unwrap();
    let registry = Arc::new(WritePathRegistry::new("s1", root));
    let _guard = registry
        .claim_one("sub-1", "01-kernel-analysis.md", ClaimMode::Write)
        .unwrap();
    let done = SubagentWaitResult {
        mode: WaitMode::AwaitAll,
        all_terminal: true,
        timed_out: false,
        agents: vec![SubagentWaitStatus {
            subagent_id: "sub-1".to_string(),
            status: SubagentState::Completed,
            summary: Some("内核分析完成".to_string()),
            elapsed_ms: 12_000,
            terminal: true,
        }],
    };
    let channel = Arc::new(RecordingWaitChannel::new(Vec::new(), done));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let mut ctx = ToolContext::new("s1", root.to_path_buf());
    ctx.write_claims = Some(Arc::clone(&registry));

    let out = tool
        .execute(&ctx, serde_json::json!({ "subagentIds": ["sub-1"] }))
        .await
        .unwrap();
    // 结构与内容断言：路径相对化、摘要取最终消息、字节数为实际大小
    let files = out["agents"][0]["outputFiles"]
        .as_array()
        .expect("outputFiles 必须是数组");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["path"], "01-kernel-analysis.md");
    assert_eq!(files[0]["summary"], "内核分析完成");
    assert_eq!(files[0]["bytes"], 11, "KERNEL_BODY 共 11 字节");
    // 产出清单已随 dispatch 持久化（dispatch_outputs 键承载）
    let output_persists = channel.output_persists();
    assert_eq!(output_persists.len(), 1);
    assert_eq!(output_persists[0]["sub-1"].len(), 1);
    assert_eq!(output_persists[0]["sub-1"][0].path, "01-kernel-analysis.md");
}

/// 未接线 write_claims（None）→ 载荷输出空数组，等待主流程不受影响
#[tokio::test]
async fn await_all_envelope_output_files_empty_when_unwired() {
    let done = SubagentWaitResult {
        mode: WaitMode::AwaitAll,
        all_terminal: true,
        timed_out: false,
        agents: vec![status("sub-1", SubagentState::Completed, 12_000)],
    };
    let channel = Arc::new(RecordingWaitChannel::new(Vec::new(), done));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let out = tool
        .execute(&ctx, serde_json::json!({ "subagentIds": ["sub-1"] }))
        .await
        .unwrap();
    assert_eq!(out["agents"][0]["outputFiles"].as_array().unwrap().len(), 0);
    assert!(
        channel.output_persists().is_empty(),
        "无产出不得触发持久化"
    );
}

// ── dispatch_outputs 持久化 JSON：往返与旧数据兼容 ─────────────

/// 序列化 → 解析往返一致
#[test]
fn dispatch_outputs_value_roundtrip() {
    let mut outputs = HashMap::new();
    outputs.insert(
        "sub-1".to_string(),
        vec![
            SubagentOutput {
                path: "01-kernel-analysis.md".to_string(),
                summary: "内核分析完成".to_string(),
                bytes: 1_024,
            },
            SubagentOutput {
                path: "docs/02-frontend.md".to_string(),
                summary: "内核分析完成".to_string(),
                bytes: 512,
            },
        ],
    );
    outputs.insert(
        "sub-2".to_string(),
        vec![SubagentOutput {
            path: "03-missing.md".to_string(),
            summary: String::new(),
            bytes: 0,
        }],
    );
    let value = dispatch_outputs_value(&outputs);
    let parsed = parse_dispatch_outputs(Some(&value));
    assert_eq!(parsed, outputs, "序列化 → 解析往返一致");
}

/// 旧数据兼容（parse 容错，对齐 explore_quota.rs:70-88）：
/// 缺失键 / 损坏 JSON / 非对象 → 空清单，不回退
#[test]
fn dispatch_outputs_parse_tolerant_for_old_data() {
    assert!(parse_dispatch_outputs(None).is_empty(), "旧格式无该键 → 空");
    assert!(parse_dispatch_outputs(Some("not-json")).is_empty(), "损坏 JSON → 空");
    assert!(parse_dispatch_outputs(Some("[1, 2]")).is_empty(), "非对象 → 空");
    assert!(parse_dispatch_outputs(Some("{}")).is_empty(), "空对象 → 空");
}

/// 条目级容错：单条损坏不影响其余条目解析（bytes 非法值按 0 兜底）
#[test]
fn dispatch_outputs_parse_entry_level_tolerance() {
    let value = r#"{
        "sub-1": [
            {"path": "01.md", "summary": "s", "bytes": 12},
            {"path": ""},
            {"summary": "缺路径"}
        ],
        "sub-2": "不是数组",
        "sub-3": [{"path": "03.md", "bytes": "非数字"}]
    }"#;
    let parsed = parse_dispatch_outputs(Some(value));
    assert_eq!(parsed.len(), 2, "非法条目与非法键跳过，合法条目保留");
    // sub-1：仅合法条目保留，非法条目丢弃
    assert_eq!(parsed["sub-1"].len(), 1);
    assert_eq!(parsed["sub-1"][0].path, "01.md");
    assert_eq!(parsed["sub-1"][0].summary, "s");
    assert_eq!(parsed["sub-1"][0].bytes, 12);
    // sub-3：path 合法即保留，bytes 非法值按 0 兜底（容错不丢弃）
    assert_eq!(parsed["sub-3"].len(), 1);
    assert_eq!(parsed["sub-3"][0].path, "03.md");
    assert_eq!(parsed["sub-3"][0].bytes, 0);
}

/// 旧格式 dispatch 数据解析不回退：有无 dispatch_outputs 键均可恢复
/// 声明（未知键忽略，from_meta_pairs 既有 `_ => {}` 容错）
#[test]
fn dispatch_declaration_parses_with_and_without_outputs_key() {
    // 旧格式（F9 及以前，无 dispatch_outputs 键）
    let old = vec![
        ("dispatch_mode", "await-all".to_string()),
        ("dispatch_wait_ms", "0".to_string()),
        ("dispatch_agents", "[\"sub-1\",\"sub-2\"]".to_string()),
        ("dispatch_dispatched_at", "1000".to_string()),
    ];
    let decl = DispatchDeclaration::from_meta_pairs(old).expect("旧格式必须可恢复");
    assert_eq!(decl.subagent_ids, vec!["sub-1", "sub-2"]);
    // 新格式（含 dispatch_outputs 键）同样可恢复，键值互不影响
    let mut outputs = HashMap::new();
    outputs.insert(
        "sub-1".to_string(),
        vec![SubagentOutput {
            path: "01.md".to_string(),
            summary: "s".to_string(),
            bytes: 12,
        }],
    );
    let new = vec![
        ("dispatch_mode", "await-all".to_string()),
        ("dispatch_wait_ms", "0".to_string()),
        ("dispatch_agents", "[\"sub-1\",\"sub-2\"]".to_string()),
        ("dispatch_dispatched_at", "1000".to_string()),
        (DISPATCH_META_KEY_OUTPUTS, dispatch_outputs_value(&outputs)),
    ];
    let decl = DispatchDeclaration::from_meta_pairs(new).expect("新格式必须可恢复");
    assert_eq!(decl.subagent_ids, vec!["sub-1", "sub-2"]);
    // dispatch_outputs 值经独立解析函数读回（声明结构不含该字段）
    let parsed = parse_dispatch_outputs(Some(&dispatch_outputs_value(&outputs)));
    assert_eq!(parsed, outputs);
}
