//! wait_subagents · 事件驱动等待域（SR-06a-3 拆分子模块）
//!
//! 逻辑域：终态事件信封（SubagentTerminalEvent）与事件驱动等待原语
//! （wait_for_terminal_events，yield 语义：单次返回 + 状态摘要，主 agent
//! 串起后续行动）。消费 subagent-ended 事件流直到全部指定子代理终态或
//! 超时；重复终态事件忽略（幂等）、非等待名单子代理忽略、流关闭 fail-open。
//! 时间助手 now_millis 位于 wait_defs（共享）。
//! 诚实边界：仅结构拆分，语义零改动（≠ EL / ≠ 打开完成 / ≠ 结构债清零）。

use crate::tools::subagent::SubagentState;
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::mpsc;

use super::wait_defs::{now_millis, SubagentWaitResult, SubagentWaitStatus};

// ── 终态事件（引擎侧把 subagent-ended 事件流映射后灌入 mpsc）──────

/// 子代理终态事件（引擎侧把 subagent-ended 事件流映射为
/// [SubagentTerminalEvent] 后灌入 mpsc；信封语义对齐 02 方案 M7：
/// subagentId / status（completed|failed）/ summary）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentTerminalEvent {
    /// 子代理 id
    pub subagent_id: String,
    /// 终态（completed / failed；cancelled 归一 failed，I0 裁决）
    pub status: SubagentState,
    /// 终态摘要（可选）
    pub summary: Option<String>,
    /// 到达终态的时刻（epoch 毫秒）
    pub ended_at_ms: u64,
}

enum RecvOutcome {
    Event(SubagentTerminalEvent),
    Closed,
    TimedOut,
}

/// 事件驱动等待原语：消费终态事件流直到全部指定子代理终态或超时。
///
/// yield 语义（pi 借鉴）：单次返回 + 状态摘要，主 agent 串起后续行动；
/// 主 agent 的等待由本原语承载，不阻塞引擎循环。规则：
/// - 终态事件只记录不打断（无 L2/L3）；
/// - 重复终态事件忽略（幂等）；非等待名单子代理的终态忽略（并发其它
///   子代理仍在运行）；
/// - 事件流关闭（rx 返回 None）→ 返回当前态（fail-open，不 panic）；
/// - 超时 → timed_out=true，未完成子代理保持 running 状态返回。
pub async fn wait_for_terminal_events(
    ids: &[String],
    mut rx: mpsc::Receiver<SubagentTerminalEvent>,
    timeout: Option<Duration>,
    dispatched_at_ms: u64,
) -> SubagentWaitResult {
    // 等待名单内已到达终态的子代理（id → 终态/摘要/时刻）
    let mut terminal: HashMap<String, (SubagentState, Option<String>, u64)> = HashMap::new();
    let deadline = timeout.map(|d| tokio::time::Instant::now() + d);
    let mut timed_out = false;

    loop {
        if ids.iter().all(|id| terminal.contains_key(id)) {
            break;
        }
        let outcome = match deadline {
            Some(deadline) => match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(event)) => RecvOutcome::Event(event),
                Ok(None) => RecvOutcome::Closed,
                Err(_) => RecvOutcome::TimedOut,
            },
            None => match rx.recv().await {
                Some(event) => RecvOutcome::Event(event),
                None => RecvOutcome::Closed,
            },
        };
        match outcome {
            RecvOutcome::Event(event) => {
                if ids.contains(&event.subagent_id) {
                    terminal
                        .entry(event.subagent_id.clone())
                        .or_insert_with(|| (event.status, event.summary, event.ended_at_ms));
                }
            }
            RecvOutcome::Closed => break,
            RecvOutcome::TimedOut => {
                timed_out = true;
                break;
            }
        }
    }

    let now_ms = now_millis();
    let agents = ids
        .iter()
        .map(|id| {
            if let Some((status, summary, ended_at)) = terminal.get(id) {
                SubagentWaitStatus {
                    subagent_id: id.clone(),
                    status: *status,
                    summary: summary.clone(),
                    elapsed_ms: ended_at.saturating_sub(dispatched_at_ms),
                    terminal: true,
                }
            } else {
                SubagentWaitStatus {
                    subagent_id: id.clone(),
                    status: SubagentState::Running,
                    summary: None,
                    elapsed_ms: now_ms.saturating_sub(dispatched_at_ms),
                    terminal: false,
                }
            }
        })
        .collect::<Vec<_>>();
    let all_terminal = agents.iter().all(|a| a.terminal);
    SubagentWaitResult {
        mode: super::wait_defs::WaitMode::AwaitAll,
        all_terminal,
        timed_out,
        agents,
    }
}
