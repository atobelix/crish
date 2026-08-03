//! wait_subagents 工具与三模式调度等待（I5-M8：C8 三模式等待）
//!
//! 定位（docs/multi-agent-repair/improvement/02-多Agent调度实现方案.md M8；
//! 需求真源 04-Agent功能需求设计.md §2 C8）：
//! - 等待原语工具化（02 Top 7）：主 agent 的等待经工具调用而非引擎阻塞——
//!   wait_subagents 单次返回、主 agent 串起后续行动（yield 语义，pi 借鉴，
//!   ref-analysis 01 B2）；快照返回不重放全量；
//! - 三模式（04 C8 §2.1）：await-all（等全部终态再规划）/ timer（到点返回
//!   未完成列表，未完成任务保持运行）/ parallel-work（立即返回，主 agent
//!   转入并行工作）；
//! - timeout 硬上限 10 分钟（对齐 grok cap，02 §5.4；超限参数报错）；
//! - 事件驱动等待：工具内部异步等待子代理终态事件（subagent-ended 消费点，
//!   优先事件而非轮询）——[wait_for_terminal_events] 原语即该语义载体；
//! - dispatch_* session_meta：调度模式声明持久化（await-all/timer 参数 +
//!   已分发子代理清单），重启后恢复「等待什么」；
//! - 运行中注入（04 C8 §2.2）：wait 期间主 agent 可向子代理注入提示词，
//!   经目标 run 的 L1 steer 环（session-loop control.rs 的
//!   request_subagent_inject，transfer 语义）——注入不打断子代理执行。
//!
//! 接线契约（对齐 I4-M2 subagent.rs）：agent-tools 是叶子 crate，生产代码
//! 不依赖 conex-db / orchestrator——session_meta 持久化与终态事件流接入在
//! 引擎侧实现 [SubagentWaitChannel]，本模块只定义契约、纯逻辑与工具本身。
//! 测试域以 conex-db（dev-dependency）验证 dispatch_* 落库与重启恢复链路。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use conex_types::error::codes;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

use super::subagent::SubagentState;

// ── 三模式（04 C8 §2.1：主 agent 视角等待策略）──────────────────

/// 调度等待模式（wire 名：await-all / timer / parallel-work）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitMode {
    /// 等待全部已发子代理到达终态（completed/failed）后再规划下一步；
    /// 期间子代理事件只记录、不打断（无 L2/L3）
    AwaitAll,
    /// 等待固定时间窗（dispatch_wait_ms，默认 30s，可配）后唤醒主 agent
    /// 规划，未完成任务保持运行
    Timer,
    /// 分发后立即返回，主 agent 转入自己的并行工作，子代理事件经 L1
    /// 注入带回
    ParallelWork,
}

impl WaitMode {
    /// wire 字面量
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AwaitAll => "await-all",
            Self::Timer => "timer",
            Self::ParallelWork => "parallel-work",
        }
    }

    /// 从 wire 名解析（未知返回 None）
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "await-all" => Some(Self::AwaitAll),
            "timer" => Some(Self::Timer),
            "parallel-work" => Some(Self::ParallelWork),
            _ => None,
        }
    }
}

/// timeout 硬上限（10 分钟，对齐 grok cap；超限参数报错）
pub const MAX_WAIT_TIMEOUT_MS: u64 = 600_000;

/// timer 模式缺省等待窗（04 C8 §2.1：dispatch_wait_ms 默认 30s）
pub const DEFAULT_TIMER_WAIT_MS: u64 = 30_000;

// ── dispatch_* 键命名空间（04 §4 键隔离：C8 独占）───────────────

/// 调度模式键（值：await-all / timer / parallel-work）
pub const DISPATCH_META_KEY_MODE: &str = "dispatch_mode";
/// 等待窗键（毫秒字符串；0 或缺失 = 不限时）
pub const DISPATCH_META_KEY_WAIT_MS: &str = "dispatch_wait_ms";
/// 已分发子代理清单键（JSON 字符串数组）
pub const DISPATCH_META_KEY_AGENTS: &str = "dispatch_agents";
/// 分发时刻键（epoch 毫秒；重启后据此计算剩余等待）
pub const DISPATCH_META_KEY_DISPATCHED_AT: &str = "dispatch_dispatched_at";

// ── 状态摘要 ─────────────────────────────────────────────────────

/// 单个子代理的等待状态摘要（completed_snapshot 语义：不重放全量）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentWaitStatus {
    /// 子代理 id（session_agents.agent_id）
    pub subagent_id: String,
    /// 状态（TS 语义 4 态；终态 = completed / failed）
    pub status: SubagentState,
    /// 终态摘要（可选）
    pub summary: Option<String>,
    /// 自分发时刻起的耗时（毫秒）
    pub elapsed_ms: u64,
    /// 是否终态（completed / failed）
    pub terminal: bool,
}

/// 等待结果（结构化出站信封载荷）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentWaitResult {
    /// 本次等待采用的模式
    pub mode: WaitMode,
    /// await-all 语义：全部指定子代理已到达终态
    pub all_terminal: bool,
    /// timer 语义：到点返回（存在未完成子代理）
    pub timed_out: bool,
    /// 各子代理状态摘要（按入参顺序）
    pub agents: Vec<SubagentWaitStatus>,
}

// ── 调度声明（持久化载荷，重启恢复「等待什么」）──────────────────

/// 一次分发的调度声明（落 session_meta dispatch_* 键）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchDeclaration {
    /// 等待模式
    pub mode: WaitMode,
    /// 等待窗毫秒（None = 不限时；parallel-work / await-all 缺省）
    pub wait_ms: Option<u64>,
    /// 已分发子代理清单
    pub subagent_ids: Vec<String>,
    /// 分发时刻（epoch 毫秒）
    pub dispatched_at_ms: u64,
}

impl DispatchDeclaration {
    /// 剩余等待毫秒（None = 不限时；已到点 = 0）
    pub fn remaining_wait_ms(&self, now_ms: u64) -> Option<u64> {
        let wait = self.wait_ms?;
        let deadline = self.dispatched_at_ms.saturating_add(wait);
        Some(deadline.saturating_sub(now_ms))
    }

    /// 是否已到点（timer 语义：剩余等待为 0）
    pub fn is_expired(&self, now_ms: u64) -> bool {
        self.remaining_wait_ms(now_ms) == Some(0)
    }

    /// 展开为 session_meta 键值对（dispatch_* 命名空间，引擎侧写库）
    pub fn to_meta_pairs(&self) -> Vec<(&'static str, String)> {
        vec![
            (DISPATCH_META_KEY_MODE, self.mode.as_str().to_string()),
            (
                DISPATCH_META_KEY_WAIT_MS,
                self.wait_ms
                    .map(|w| w.to_string())
                    .unwrap_or_else(|| "0".to_string()),
            ),
            (
                DISPATCH_META_KEY_AGENTS,
                serde_json::to_string(&self.subagent_ids).unwrap_or_else(|_| "[]".to_string()),
            ),
            (
                DISPATCH_META_KEY_DISPATCHED_AT,
                self.dispatched_at_ms.to_string(),
            ),
        ]
    }

    /// 从 session_meta 键值对恢复声明（重启恢复入口；关键键缺失或
    /// 非法 → None，fail-open 不 panic）
    pub fn from_meta_pairs<'a>(pairs: impl IntoIterator<Item = (&'a str, String)>) -> Option<Self> {
        let mut mode = None;
        let mut wait_ms = None;
        let mut agents = None;
        let mut dispatched_at_ms = None;
        for (key, value) in pairs {
            match key {
                DISPATCH_META_KEY_MODE => mode = WaitMode::parse(&value),
                DISPATCH_META_KEY_WAIT_MS => wait_ms = value.parse::<u64>().ok().filter(|&w| w > 0),
                DISPATCH_META_KEY_AGENTS => {
                    agents = serde_json::from_str::<Vec<String>>(&value).ok()
                }
                DISPATCH_META_KEY_DISPATCHED_AT => dispatched_at_ms = value.parse::<u64>().ok(),
                _ => {}
            }
        }
        let agents = agents?;
        if agents.is_empty() {
            return None;
        }
        Some(Self {
            mode: mode?,
            wait_ms,
            subagent_ids: agents,
            dispatched_at_ms: dispatched_at_ms?,
        })
    }
}

// ── 终态事件与事件驱动等待原语（yield 语义）──────────────────────

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
        mode: WaitMode::AwaitAll,
        all_terminal,
        timed_out,
        agents,
    }
}

/// 当前时刻（epoch 毫秒；时钟异常时 0）
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── 等待通道契约（引擎侧接线面）─────────────────────────────────

/// 等待失败（结构化错误，映射为 ToolError 出站）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubagentWaitError {
    /// 指定的子代理 id 不存在
    UnknownAgent(String),
    /// dispatch_* session_meta 落库失败
    PersistFailed(String),
    /// 运行中注入失败（目标 run 的 L1 steer 环投递失败）
    InjectFailed(String),
    /// 等待通道未接线（spawner 未装配）
    Unavailable(String),
}

impl SubagentWaitError {
    /// 错误码
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnknownAgent(_) => codes::COMMON_NOT_FOUND,
            Self::PersistFailed(_) => codes::STORE_WRITE_FAILED,
            Self::InjectFailed(_) => codes::TOOL_EXECUTION_FAILED,
            Self::Unavailable(_) => codes::COMMON_UNSUPPORTED,
        }
    }

    /// 错误文案
    pub fn message(&self) -> String {
        match self {
            Self::UnknownAgent(id) => format!("子代理不存在：{id}"),
            Self::PersistFailed(reason) => format!("调度声明落库失败：{reason}"),
            Self::InjectFailed(reason) => format!("子代理注入失败：{reason}"),
            Self::Unavailable(reason) => format!("wait_subagents 未接线：{reason}"),
        }
    }
}

/// 子代理等待通道（引擎侧实现；agent-tools 只定义契约）
///
/// 实现方职责（对齐 M8 内容 1/2/4）：
/// 1. [SubagentWaitChannel::persist_declaration]：dispatch_* 键落
///    session_meta（模式 / 等待窗 / 已分发清单 / 分发时刻），重启可恢复；
/// 2. [SubagentWaitChannel::snapshot]：非阻塞读各子代理当前状态摘要
///    （读 session_agents 行，completed_snapshot 语义，不重放全量）；
/// 3. [SubagentWaitChannel::wait_for_terminal]：事件驱动阻塞等待——订阅
///    subagent-ended 事件流，把终态事件映射为 [SubagentTerminalEvent] 灌入
///    mpsc，交 [wait_for_terminal_events] 消费（优先事件而非轮询）；L3
///    强停经 abort token 竞速取消由实现方承担；
/// 4. [SubagentWaitChannel::inject]：经目标 run 的 ControlBus L1 steer 环
///    注入提示词（session-loop control.rs request_subagent_inject），不打断
///    子代理执行。
#[async_trait]
pub trait SubagentWaitChannel: Send + Sync + std::fmt::Debug {
    /// 持久化调度声明（dispatch_* session_meta 键）
    async fn persist_declaration(
        &self,
        declaration: &DispatchDeclaration,
    ) -> Result<(), SubagentWaitError>;

    /// 非阻塞快照：各指定子代理当前状态摘要
    async fn snapshot(
        &self,
        subagent_ids: &[String],
    ) -> Result<Vec<SubagentWaitStatus>, SubagentWaitError>;

    /// 事件驱动阻塞等待：等待 ids 全部终态或超时；返回各自状态摘要
    async fn wait_for_terminal(
        &self,
        subagent_ids: &[String],
        timeout_ms: Option<u64>,
    ) -> Result<SubagentWaitResult, SubagentWaitError>;

    /// 运行中注入：向指定子代理注入提示词（经 L1 steer 环，不打断流）
    async fn inject(&self, subagent_id: &str, prompt: &str) -> Result<(), SubagentWaitError>;
}

// ── wait_subagents 工具 ──────────────────────────────────────────

/// wait_subagents 工具：三模式调度等待（await-all / timer / parallel-work）
pub(crate) struct WaitSubagentsTool {
    def: ToolDefinition,
    /// 等待通道（None = 未接线，返回结构化不可用错误）
    channel: Option<Arc<dyn SubagentWaitChannel>>,
}

impl WaitSubagentsTool {
    /// 新建工具（等待通道未接线；测试与未集成环境返回结构化不可用错误）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new() -> Self {
        Self::with_channel(None)
    }

    /// 新建工具并注入等待通道（注册面接线点：BuiltinToolConfig 注入）
    pub(crate) fn with_channel(channel: Option<Arc<dyn SubagentWaitChannel>>) -> Self {
        Self {
            def: ToolDefinition {
                name: "wait_subagents".to_string(),
                description: "三模式调度等待（yield 语义：单次返回、主 agent 串起后续行动）：\
                              await-all 等待全部指定子代理终态后再规划下一步（期间事件只记录不打断）；\
                              timer 到点返回未完成列表（未完成任务保持运行）；parallel-work 立即返回快照、\
                              主 agent 转入并行工作。timeoutMs 硬上限 10 分钟。可经 inject 在等待期间\
                              向子代理注入提示词（L1 steer 环，不打断执行）。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "subagentIds": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "已分发子代理 id 列表（run_subagent 返回的 subagentId）"
                        },
                        "mode": {
                            "type": "string",
                            "enum": ["await-all", "timer", "parallel-work"],
                            "description": "等待模式（缺省 await-all）"
                        },
                        "timeoutMs": {
                            "type": "number",
                            "description": "等待超时毫秒（硬上限 600000=10 分钟，超限报错）；\
                                             timer 缺省 30000；await-all 缺省不限时；0 或省略 = 非阻塞快照"
                        },
                        "inject": {
                            "type": "object",
                            "properties": {
                                "subagentId": { "type": "string" },
                                "prompt": { "type": "string" }
                            },
                            "description": "等待期间向指定子代理注入提示词（经目标 run 的 L1 steer 环，不打断流）"
                        }
                    },
                    "required": ["subagentIds"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
            channel,
        }
    }
}

#[async_trait]
impl Tool for WaitSubagentsTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        // 入参解析：subagentIds 必填非空；mode/timeoutMs/inject 可选
        let ids: Vec<String> = args
            .get("subagentIds")
            .and_then(Value::as_array)
            .ok_or_else(|| ToolError::invalid_input("subagentIds must be a non-empty array"))?
            .iter()
            .map(|v| {
                v.as_str()
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string)
                    .ok_or_else(|| {
                        ToolError::invalid_input("subagentIds must be non-empty strings")
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if ids.is_empty() {
            return Err(ToolError::invalid_input(
                "subagentIds must be a non-empty array",
            ));
        }
        let mode = match super::optional_string(&args, "mode") {
            Some(raw) => WaitMode::parse(&raw)
                .ok_or_else(|| ToolError::invalid_input(format!("未知等待模式：{raw}")))?,
            None => WaitMode::AwaitAll,
        };
        // 显式 timeoutMs=0 = 非阻塞快照（02 Top 7：省略 timeout 或 0 均为
        // 快照语义）——与「省略」区分：省略走模式缺省，显式 0 强制快照
        let explicit_zero_timeout =
            matches!(args.get("timeoutMs"), Some(v) if v.as_f64() == Some(0.0));
        let timeout_ms = super::optional_u64(&args, "timeoutMs");
        if timeout_ms.is_some_and(|t| t > MAX_WAIT_TIMEOUT_MS) {
            return Err(ToolError::invalid_input(format!(
                "timeoutMs 超过硬上限 {MAX_WAIT_TIMEOUT_MS}ms（10 分钟）：\
                 请降低超时或拆分等待"
            )));
        }
        let snapshot_mode = explicit_zero_timeout;
        // timer 缺省等待窗 30s（04 C8 §2.1：dispatch_wait_ms 默认 30s）
        let effective_timeout_ms = match mode {
            WaitMode::Timer if !snapshot_mode => timeout_ms.or(Some(DEFAULT_TIMER_WAIT_MS)),
            WaitMode::AwaitAll | WaitMode::ParallelWork => timeout_ms,
            WaitMode::Timer => None,
        };
        let inject = match args.get("inject") {
            Some(value) => {
                let obj = value
                    .as_object()
                    .ok_or_else(|| ToolError::invalid_input("inject must be an object"))?;
                let subagent_id = obj
                    .get("subagentId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| ToolError::invalid_input("inject.subagentId is required"))?
                    .to_string();
                let prompt = obj
                    .get("prompt")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| ToolError::invalid_input("inject.prompt is required"))?
                    .to_string();
                Some((subagent_id, prompt))
            }
            None => None,
        };

        // 等待通道未接线 → 结构化不可用错误（引擎集成前零副作用）
        let Some(channel) = &self.channel else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "wait_subagents 未接线：等待通道未装配（引擎集成后可用）",
            ));
        };

        // 调度声明持久化（dispatch_* 键，重启可恢复「等待什么」）
        let dispatched_at_ms = now_millis();
        let declaration = DispatchDeclaration {
            mode,
            wait_ms: effective_timeout_ms,
            subagent_ids: ids.clone(),
            dispatched_at_ms,
        };
        channel
            .persist_declaration(&declaration)
            .await
            .map_err(|e| ToolError::new(e.code(), e.message()))?;

        // 运行中注入（L1 steer 环，不打断子代理执行）
        if let Some((subagent_id, prompt)) = &inject {
            channel
                .inject(subagent_id, prompt)
                .await
                .map_err(|e| ToolError::new(e.code(), e.message()))?;
        }

        // 三模式等待：parallel-work / timeoutMs=0 立即快照；
        // await-all/timer 事件驱动等待
        let result = match (mode, snapshot_mode) {
            (WaitMode::ParallelWork, _) | (_, true) => {
                let agents = channel
                    .snapshot(&ids)
                    .await
                    .map_err(|e| ToolError::new(e.code(), e.message()))?;
                SubagentWaitResult {
                    mode,
                    all_terminal: agents.iter().all(|a| a.terminal),
                    timed_out: false,
                    agents,
                }
            }
            (WaitMode::AwaitAll | WaitMode::Timer, false) => channel
                .wait_for_terminal(&ids, effective_timeout_ms)
                .await
                .map_err(|e| ToolError::new(e.code(), e.message()))?,
        };

        // 结果信封：结构化摘要（不重放全量消息）
        Ok(serde_json::json!({
            "mode": result.mode.as_str(),
            "allTerminal": result.all_terminal,
            "timedOut": result.timed_out,
            "agents": result.agents.iter().map(|a| serde_json::json!({
                "subagentId": a.subagent_id,
                "status": a.status.as_str(),
                "summary": a.summary,
                "elapsedMs": a.elapsed_ms,
                "terminal": a.terminal,
            })).collect::<Vec<_>>(),
        }))
    }
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use crate::context::create_mock_tool_context;
    use conex_test_utils::TempWorkspace;
    use std::sync::Mutex;
    use tokio::sync::mpsc;

    // ── 测试替身 ──────────────────────────────────────────────────

    /// 记录式等待通道：记录持久化/注入/等待调用，按预设结果应答
    #[derive(Debug)]
    struct RecordingWaitChannel {
        persists: Mutex<Vec<DispatchDeclaration>>,
        injects: Mutex<Vec<(String, String)>>,
        waits: Mutex<Vec<(Vec<String>, Option<u64>)>>,
        snap: Vec<SubagentWaitStatus>,
        wait_result: SubagentWaitResult,
    }

    impl RecordingWaitChannel {
        fn new(snap: Vec<SubagentWaitStatus>, wait_result: SubagentWaitResult) -> Self {
            Self {
                persists: Mutex::new(Vec::new()),
                injects: Mutex::new(Vec::new()),
                waits: Mutex::new(Vec::new()),
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
}
