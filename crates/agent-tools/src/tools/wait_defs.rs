//! wait_subagents · 定义与结果聚合域（SR-06a-3 拆分子模块）
//!
//! 逻辑域：三模式枚举与常量（WaitMode / 超时硬上限 / dispatch_* 键）、等待
//! 状态与结果类型（SubagentWaitStatus / SubagentWaitResult）、产出文件
//! （SubagentOutput + collect_subagent_output_files，G02 完成通知字段）、
//! 调度声明（DispatchDeclaration，重启恢复「等待什么」）、错误与等待通道
//! 契约（SubagentWaitError / SubagentWaitChannel）、共享时间助手（now_millis）。
//! 不含事件驱动等待原语（wait_events）与工具面（wait_tool）。
//! 诚实边界：仅结构拆分，语义零改动（≠ EL / ≠ 打开完成 / ≠ 结构债清零）。

use crate::tools::display_path;
use crate::tools::subagent::SubagentState;
use crate::write_paths::{ClaimMode, WritePathRegistry};
use async_trait::async_trait;
use conex_types::error::codes;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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
/// 各子代理产出文件清单键（JSON 对象：subagent_id → [SubagentOutput]
/// 数组；G02 完成通知字段，T-EG-10；旧数据无该键 = 空清单，parse 容错）
pub const DISPATCH_META_KEY_OUTPUTS: &str = "dispatch_outputs";

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

// ── 产出文件（G02 完成通知字段，T-EG-10）─────────────────────────

/// 子代理产出文件（REQ-G02「附带文件路径与内容摘要」的结构化承载，
/// 方案 §4.6 载荷草案：path / summary / bytes）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubagentOutput {
    /// 产出文件相对路径（工作区内；无法相对化时回退绝对路径）
    pub path: String,
    /// 内容摘要（子代理最终消息摘要；缺失时取文件首行概述）
    pub summary: String,
    /// 产出字节数（供主控生成汇总索引：文件名 / 行数 / 摘要）
    pub bytes: u64,
}

/// 从 write_claims 持有者记录收集子代理产出文件（引擎强制，不依赖 AI 自觉）
///
/// 规则：
/// - 来源：注册表活跃声明中 holder 匹配且为写模式的路径（F7 已接线；
///   holder 身份对齐声明侧——引擎以 run id 作 holder 时需在调用侧映射
///   为 subagent id，见轮次报告对接细节）；
/// - 目录声明展开为直接子文件（产出文档按 NN-*.md 约定平铺，不递归）；
/// - 已被删除 / 不存在的路径跳过；去重 + 排序（确定性输出）；
/// - 摘要：优先子代理最终消息摘要，缺失时取文件首行概述（§4.6）；
/// - 注册表未接线（None）→ 空清单（fail-open，不报错）。
pub fn collect_subagent_output_files(
    registry: Option<&WritePathRegistry>,
    holder: &str,
    workspace_root: &Path,
    summary: Option<&str>,
) -> Vec<SubagentOutput> {
    let Some(registry) = registry else {
        return Vec::new();
    };
    let mut paths = registry
        .active_claims()
        .into_iter()
        .filter(|claim| claim.holder == holder && claim.mode == ClaimMode::Write)
        .flat_map(|claim| resolved_output_paths(&claim.path))
        .collect::<Vec<_>>();
    // 去重 + 排序：同一路径经目录展开与单文件声明重复命中时只保留一份；
    // 排序保证输出确定（汇总索引稳定、测试可断言）
    paths.sort();
    paths.dedup();
    paths
        .into_iter()
        .map(|path| SubagentOutput {
            path: display_path(workspace_root, &path),
            summary: summary
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| first_line_summary(&path)),
            bytes: std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
        })
        .collect()
}

/// 单条声明的产出路径展开：文件声明原样返回；目录声明取直接子文件
/// （不递归——产出文档按约定平铺在产出目录下，递归会误收嵌套子目录）；
/// 声明路径已不存在（运行期删除 / 从未创建）→ 空
fn resolved_output_paths(claim_path: &PathBuf) -> Vec<PathBuf> {
    if claim_path.is_file() {
        return vec![claim_path.clone()];
    }
    if claim_path.is_dir() {
        return std::fs::read_dir(claim_path)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .filter(|path| path.is_file())
                    .collect()
            })
            .unwrap_or_default();
    }
    Vec::new()
}

/// 文件首行概述（§4.6：摘要 = 子代理最终消息摘要或首行概述；
/// 读取失败 / 空文件 → 空摘要；取前 200 字符防超长）
fn first_line_summary(path: &Path) -> String {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| {
            text.lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(|line| line.chars().take(200).collect())
        })
        .unwrap_or_default()
}

/// 各子代理产出清单序列化（dispatch_outputs 键值：JSON 对象
/// subagent_id → [SubagentOutput] 数组）
pub fn dispatch_outputs_value(outputs: &HashMap<String, Vec<SubagentOutput>>) -> String {
    serde_json::to_string(outputs).unwrap_or_else(|_| "{}".to_string())
}

/// 各子代理产出清单解析（容错：缺失 / 损坏 → 空清单，不 panic；
/// 对齐 explore_quota.rs:70-88 的 parse 容错模式——旧数据无该键时
/// 回到空清单，不回退）
pub fn parse_dispatch_outputs(value: Option<&str>) -> HashMap<String, Vec<SubagentOutput>> {
    let Some(value) = value else {
        return HashMap::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(value) else {
        return HashMap::new();
    };
    let Some(object) = parsed.as_object() else {
        return HashMap::new();
    };
    let mut outputs = HashMap::new();
    for (subagent_id, files) in object {
        // 条目级容错：非法条目跳过，不因单条损坏丢弃全部
        let files = files
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let path = item.get("path")?.as_str()?.trim();
                        if path.is_empty() {
                            return None;
                        }
                        Some(SubagentOutput {
                            path: path.to_string(),
                            summary: item
                                .get("summary")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            bytes: item.get("bytes").and_then(Value::as_u64).unwrap_or(0),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !files.is_empty() {
            outputs.insert(subagent_id.clone(), files);
        }
    }
    outputs
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

// ── 时间助手（共享：事件驱动等待与工具面均消费）─────────────────

/// 当前时刻（epoch 毫秒；时钟异常时 0）
pub(crate) fn now_millis() -> u64 {
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

    /// 持久化各子代理产出文件清单（dispatch_outputs 键；重启后恢复
    /// 「各子代理产出」。缺省实现不落库（no-op）——引擎侧重载后写
    /// session_meta，F10 未接线时静默跳过，不阻塞等待主流程）
    async fn persist_outputs(
        &self,
        _outputs: &HashMap<String, Vec<SubagentOutput>>,
    ) -> Result<(), SubagentWaitError> {
        Ok(())
    }

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
