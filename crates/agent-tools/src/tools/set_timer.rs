//! set_timer / cancel_timer 工具与 TimerChannel 契约（T-CF-05）
//!
//! 定位（docs/feature-gap-analysis/plans/02-CF定时唤醒与工具方案.md §4.2 与
//! T-CF-05；需求真源 REQ-agent-engine-capabilities.md REQ-C01/C02）：
//! - 定时器原语工具化：AI 侧经 set_timer 注册一次性定时器——后台静默运行，
//!   不阻塞工具调用，到期由引擎侧 TimerRegistry 注入提示；cancel_timer
//!   显式取消；list_active 供 idle 待命续 run 判定使用（契约面完整承载）；
//! - 早退条件（REQ-C02，§4.1 TimerCondition）：never（无条件等到期，除非
//!   显式取消）/ any（收到任何来源消息即取消）/ <task-id>（仅指定 task-id
//!   的消息可触发早退，含 agent-id 同义复用）；
//! - 约束：同一 sender 只能有一个活跃定时器——重复注册经
//!   [TimerError::Conflict] 上报（结构化错误码，语义见码表映射）；
//! - 接线契约（对齐 I5-M8 wait_subagents）：agent-tools 是叶子 crate，
//!   不依赖引擎；引擎侧实现 [TimerChannel]（TimerRegistry 适配，T-CF-06），
//!   本模块只定义契约、纯逻辑与工具本身；通道未接线时工具返回
//!   common.unsupported（对齐 wait_subagents.rs:533-538）。
//!
//! 类型依赖（对齐 02 方案包依赖：A2 依赖 T-CF-04 的 TimerCondition 类型，
//! conex-types 依赖方向天然成立）：[TimerCondition] / [TimerHandle] 由
//! conex-types timer 模块承载（crates/conex-types/src/timer.rs，§4.1
//! 冻结形状，C-A1 已合并），本文件直接导入，不在 agent-tools 内定义。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use conex_types::error::codes;
use conex_types::timer::{TimerCondition, TimerHandle};
use serde_json::Value;
use std::sync::Arc;

/// durationSeconds 合法区间上界（秒）：86400 = 24 小时（T-CF-05 内容 2）
pub const MAX_TIMER_DURATION_SECONDS: u64 = 86_400;

// ── 早退条件 wire 解析 ──────────────────────────────────────────

/// wire 解析：never / any 为保留字；其余非空字面量原样视为 task-id
/// （缺省 never 由调用方兜底；空串视为非法入参）
fn parse_timer_condition(raw: &str) -> Option<TimerCondition> {
    match raw {
        "never" => Some(TimerCondition::Never),
        "any" => Some(TimerCondition::Any),
        other if !other.trim().is_empty() => Some(TimerCondition::Task(other.to_string())),
        _ => None,
    }
}

// ── 定时器通道契约（引擎侧接线面）───────────────────────────────

/// 定时器错误（结构化，映射为 ToolError 出站；对齐 SubagentWaitError 风格
/// wait_subagents.rs:318-350）
///
/// 偏差登记：任务书 T-CF-05 内容 1 称「五变体」，但 §4.2 冻结形状
/// （02 方案 :286-292）仅定义四变体（Conflict / InvalidDuration /
/// IdNotFound / Unsupported），文档无第五变体定义——按冻结形状实现四变体，
/// 待主 Agent 裁决（若补 PersistFailed 则与 wait_subagents 落库失败变体
/// 同构，落库错误在引擎侧 TimerRegistry 归属）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimerError {
    /// 同 sender 已有活跃定时器（REQ-C02 约束）
    Conflict(String),
    /// durationSeconds 超限或非正
    InvalidDuration,
    /// 取消不存在的定时器
    IdNotFound,
    /// 通道未接线（对齐 common.unsupported 语义）
    Unsupported,
}

impl TimerError {
    /// 错误码（偏差登记：Conflict 复用 tool.version_conflict——码表无通用
    /// 「业务冲突」码，本域新增需 conex-types error.rs + TS 端
    /// CRISH_ERROR_REGISTRY 双登记，超出 agent-tools 文件域，建议后续轮次
    /// 增 common.conflict 专用码后切换）
    pub fn code(&self) -> &'static str {
        match self {
            Self::Conflict(_) => codes::TOOL_VERSION_CONFLICT,
            Self::InvalidDuration => codes::TOOL_INVALID_INPUT,
            Self::IdNotFound => codes::COMMON_NOT_FOUND,
            Self::Unsupported => codes::COMMON_UNSUPPORTED,
        }
    }

    /// 错误文案
    pub fn message(&self) -> String {
        match self {
            Self::Conflict(existing) => format!(
                "同 sender 已有活跃定时器：{existing}（同一 sender 只能有一个活跃定时器，\
                 请先 cancel 或等待其到期）"
            ),
            Self::InvalidDuration => {
                format!("durationSeconds 须为 1~{MAX_TIMER_DURATION_SECONDS} 的正整数（秒）")
            }
            Self::IdNotFound => "定时器不存在或已取消".to_string(),
            Self::Unsupported => "定时器通道未接线（引擎集成后可用）".to_string(),
        }
    }
}

/// 定时器通道契约（AI 侧工具与引擎侧 TimerRegistry 的解耦边界；
/// 与 subagent_wait_channel（mod.rs:54-57）同一注入范式）
///
/// 实现方职责（对齐 §4.2 与 T-CF-06）：
/// 1. [TimerChannel::register]：校验 durationSeconds（1~86400）→ 构造
///    [TimerHandle] + 持久化声明（session_meta timer_* 键）→ 后台 spawn
///    定时任务（tokio sleep，静默运行不阻塞）→ 返回句柄；同 sender 已
///    有活跃定时器返回 [TimerError::Conflict]；
/// 2. [TimerChannel::cancel]：显式取消（早退命中或 AI 主动取消）；不存在的
///    定时器返回 [TimerError::IdNotFound]；
/// 3. [TimerChannel::list_active]：活跃定时器列表（idle 待命续 run 判定用）。
#[async_trait]
pub trait TimerChannel: Send + Sync + std::fmt::Debug {
    /// 注册一次性定时器（后台静默运行，不阻塞工具调用）
    async fn register(
        &self,
        duration_seconds: u64,
        prompt: String,
        condition: TimerCondition,
    ) -> Result<TimerHandle, TimerError>;

    /// 显式取消（早退命中或 AI 主动取消）；不存在返回 id-not-found
    async fn cancel(&self, timer_id: &str) -> Result<bool, TimerError>;

    /// 活跃定时器列表（idle 待命续 run 判定用）
    async fn list_active(&self) -> Result<Vec<TimerHandle>, TimerError>;
}

// ── set_timer 工具 ───────────────────────────────────────────────

/// set_timer 工具：注册一次性后台定时器（T-CF-05 内容 2/4）
pub(crate) struct SetTimerTool {
    def: ToolDefinition,
    /// 定时器通道（None = 未接线，返回结构化不可用错误）
    channel: Option<Arc<dyn TimerChannel>>,
}

impl SetTimerTool {
    /// 新建工具（定时器通道未接线；测试与未集成环境返回结构化不可用错误）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new() -> Self {
        Self::with_channel(None)
    }

    /// 新建工具并注入定时器通道（注册面接线点：BuiltinToolConfig 注入）
    pub(crate) fn with_channel(channel: Option<Arc<dyn TimerChannel>>) -> Self {
        Self {
            def: ToolDefinition {
                name: "set_timer".to_string(),
                description: "注册一次性后台定时器：到时由引擎向当前会话注入 prompt（后台\
                              静默运行，不阻塞本工具调用）；早退条件 timerCondition：\
                              never（无条件等到期，除非显式取消）/ any（收到任何来源消息\
                              即取消）/ <task-id>（仅该任务的消息可触发早退）；同一 sender\
                              只能有一个活跃定时器，重复注册返回冲突；durationSeconds 硬\
                              上限 86400 秒（24 小时）。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "durationSeconds": {
                            "type": "number",
                            "description": "定时时长（秒，必填，合法区间 1~86400）"
                        },
                        "prompt": {
                            "type": "string",
                            "description": "到期注入的提示内容（必填非空）"
                        },
                        "timerCondition": {
                            "type": "string",
                            "description": "早退条件（可选，kebab-case）：never / any / \
                                            <task-id>；缺省 never"
                        }
                    },
                    "required": ["durationSeconds", "prompt"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
            channel,
        }
    }
}

/// 解析必填 durationSeconds（JSON 数值 → 秒；1~86400 闭区间校验）
fn parse_duration_seconds(args: &Value) -> Result<u64, ToolError> {
    let value = args
        .get("durationSeconds")
        .ok_or_else(|| ToolError::invalid_input("durationSeconds is required"))?;
    let f = value
        .as_f64()
        .ok_or_else(|| ToolError::invalid_input("durationSeconds must be a positive number"))?;
    // 非有限数（JSON 超大数 / 非数值）与非正一律拒绝
    if !f.is_finite() || f < 1.0 {
        return Err(ToolError::invalid_input(format!(
            "durationSeconds 须为 1~{MAX_TIMER_DURATION_SECONDS} 的正整数（秒）"
        )));
    }
    let secs = f.floor() as u64;
    if secs > MAX_TIMER_DURATION_SECONDS {
        return Err(ToolError::invalid_input(format!(
            "durationSeconds 超过硬上限 {MAX_TIMER_DURATION_SECONDS} 秒（24 小时）"
        )));
    }
    Ok(secs)
}

#[async_trait]
impl Tool for SetTimerTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        // 入参解析：durationSeconds 必填 1~86400；prompt 必填非空；
        // timerCondition 可选（缺省 never）
        let duration_seconds = parse_duration_seconds(&args)?;
        let prompt = super::require_string(&args, "prompt")?;
        let condition = match super::optional_string(&args, "timerCondition") {
            Some(raw) => parse_timer_condition(&raw).ok_or_else(|| {
                ToolError::invalid_input(format!(
                    "timerCondition 须为 never / any / <task-id>（kebab-case）：{raw}"
                ))
            })?,
            None => TimerCondition::Never,
        };

        // 定时器通道未接线 → 结构化不可用错误（引擎集成前零副作用，
        // 对齐 wait_subagents.rs:533-538）
        let Some(channel) = &self.channel else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "set_timer 未接线：定时器通道未装配（引擎集成后可用）",
            ));
        };

        // 注册定时器（引擎侧后台静默运行，不阻塞本工具）
        let handle = channel
            .register(duration_seconds, prompt, condition)
            .await
            .map_err(|e| ToolError::new(e.code(), e.message()))?;

        // 结果信封：timerId / expiresAtMs / text 摘要
        // （「定时器 <id> 已设置，将于 <时刻> 到期」，时刻为 ISO8601 UTC）
        let expires_iso =
            crate::subagent_inject::iso8601_from_epoch_ms(handle.expires_at_ms as i64);
        Ok(serde_json::json!({
            "timerId": handle.timer_id,
            "expiresAtMs": handle.expires_at_ms,
            "text": format!("定时器 {} 已设置，将于 {} 到期", handle.timer_id, expires_iso),
        }))
    }
}

// ── cancel_timer 工具 ────────────────────────────────────────────

/// cancel_timer 工具：显式取消定时器（T-CF-05 内容 3）
pub(crate) struct CancelTimerTool {
    def: ToolDefinition,
    /// 定时器通道（None = 未接线，返回结构化不可用错误）
    channel: Option<Arc<dyn TimerChannel>>,
}

impl CancelTimerTool {
    /// 新建工具（定时器通道未接线；测试与未集成环境返回结构化不可用错误）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new() -> Self {
        Self::with_channel(None)
    }

    /// 新建工具并注入定时器通道（注册面接线点：BuiltinToolConfig 注入）
    pub(crate) fn with_channel(channel: Option<Arc<dyn TimerChannel>>) -> Self {
        Self {
            def: ToolDefinition {
                name: "cancel_timer".to_string(),
                description: "取消指定定时器（timerId 为 set_timer 返回的 timerId）：\
                              定时器后台静默运行不阻塞，取消后不再注入到期提示；\
                              已到期或已取消的定时器返回未找到。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "timerId": {
                            "type": "string",
                            "description": "set_timer 返回的定时器 id（必填非空）"
                        }
                    },
                    "required": ["timerId"],
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
impl Tool for CancelTimerTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        // 入参解析：timerId 必填非空
        let timer_id = super::require_string(&args, "timerId")?;

        // 定时器通道未接线 → 结构化不可用错误（引擎集成前零副作用）
        let Some(channel) = &self.channel else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "cancel_timer 未接线：定时器通道未装配（引擎集成后可用）",
            ));
        };

        // 显式取消（早退命中或 AI 主动取消）；false = 已到期 / 已取消
        let cancelled = channel
            .cancel(&timer_id)
            .await
            .map_err(|e| ToolError::new(e.code(), e.message()))?;

        // 结果信封：取消结果 + text 摘要
        Ok(serde_json::json!({
            "timerId": timer_id,
            "cancelled": cancelled,
            "text": if cancelled {
                format!("定时器 {timer_id} 已取消")
            } else {
                format!("定时器 {timer_id} 不存在或已到期")
            },
        }))
    }
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use crate::context::create_mock_tool_context;
    use std::sync::Mutex;

    // ── 测试替身 ──────────────────────────────────────────────────

    /// 记录式定时器通道：记录 register / cancel 调用，按预设结果应答
    #[derive(Debug)]
    struct RecordingTimerChannel {
        registers: Mutex<Vec<(u64, String, TimerCondition)>>,
        cancels: Mutex<Vec<String>>,
        register_outcome: Result<TimerHandle, TimerError>,
    }

    impl RecordingTimerChannel {
        fn new(register_outcome: Result<TimerHandle, TimerError>) -> Self {
            Self {
                registers: Mutex::new(Vec::new()),
                cancels: Mutex::new(Vec::new()),
                register_outcome,
            }
        }

        fn registers(&self) -> Vec<(u64, String, TimerCondition)> {
            self.registers.lock().unwrap().clone()
        }

        fn cancels(&self) -> Vec<String> {
            self.cancels.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl TimerChannel for RecordingTimerChannel {
        async fn register(
            &self,
            duration_seconds: u64,
            prompt: String,
            condition: TimerCondition,
        ) -> Result<TimerHandle, TimerError> {
            self.registers
                .lock()
                .unwrap()
                .push((duration_seconds, prompt, condition));
            self.register_outcome.clone()
        }

        async fn cancel(&self, timer_id: &str) -> Result<bool, TimerError> {
            self.cancels.lock().unwrap().push(timer_id.to_string());
            Ok(true)
        }

        async fn list_active(&self) -> Result<Vec<TimerHandle>, TimerError> {
            Ok(Vec::new())
        }
    }

    /// 成功应答句柄（回显参数取默认值，断言关注透传的注册参数）
    fn ok_handle(timer_id: &str, expires_at_ms: u64) -> TimerHandle {
        TimerHandle {
            timer_id: timer_id.to_string(),
            expires_at_ms,
            duration_seconds: 300,
            prompt: "检查编译".to_string(),
            condition: TimerCondition::Never,
        }
    }

    // ── set_timer ────────────────────────────────────────────────

    #[tokio::test]
    async fn set_timer_registers_with_args() {
        let channel = Arc::new(RecordingTimerChannel::new(Ok(ok_handle(
            "timer-1",
            1_700_000_000_000,
        ))));
        let tool = SetTimerTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "durationSeconds": 300,
                    "prompt": "检查编译",
                }),
            )
            .await
            .unwrap();
        // register 恰好收到 (300, "检查编译", Never)（timerCondition 缺省 never）
        assert_eq!(
            channel.registers(),
            vec![(300, "检查编译".to_string(), TimerCondition::Never)]
        );
        // 输出信封：timerId / expiresAtMs / text 摘要
        assert_eq!(out["timerId"], "timer-1");
        assert_eq!(out["expiresAtMs"], serde_json::json!(1_700_000_000_000u64));
        assert!(out["text"]
            .as_str()
            .unwrap()
            .contains("定时器 timer-1 已设置"));
    }

    #[tokio::test]
    async fn set_timer_condition_parsed() {
        let ctx = create_mock_tool_context();
        // any → Any
        let channel = Arc::new(RecordingTimerChannel::new(Ok(ok_handle("timer-2", 1))));
        let tool = SetTimerTool::with_channel(Some(channel.clone()));
        tool.execute(
            &ctx,
            serde_json::json!({
                "durationSeconds": 60,
                "prompt": "p",
                "timerCondition": "any",
            }),
        )
        .await
        .unwrap();
        assert_eq!(channel.registers()[0].2, TimerCondition::Any);
        // task-42 → Task("task-42")
        let channel = Arc::new(RecordingTimerChannel::new(Ok(ok_handle("timer-3", 1))));
        let tool = SetTimerTool::with_channel(Some(channel.clone()));
        tool.execute(
            &ctx,
            serde_json::json!({
                "durationSeconds": 60,
                "prompt": "p",
                "timerCondition": "task-42",
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            channel.registers()[0].2,
            TimerCondition::Task("task-42".to_string())
        );
        // 非法条件（空串）→ 结构化入参错误
        let channel = Arc::new(RecordingTimerChannel::new(Ok(ok_handle("timer-4", 1))));
        let tool = SetTimerTool::with_channel(Some(channel.clone()));
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "durationSeconds": 60,
                    "prompt": "p",
                    "timerCondition": "  ",
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        assert!(channel.registers().is_empty(), "非法条件不得发起 register");
    }

    #[tokio::test]
    async fn set_timer_invalid_duration_rejected() {
        let channel = Arc::new(RecordingTimerChannel::new(Ok(ok_handle("timer-5", 1))));
        let tool = SetTimerTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        // 0（非正）→ 结构化入参错误
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({ "durationSeconds": 0, "prompt": "p" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        // 超上限（86401）→ 结构化入参错误
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({ "durationSeconds": 86_401, "prompt": "p" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        assert!(err.to_string().contains("86400"));
        // 缺 durationSeconds → 结构化入参错误
        let err = tool
            .execute(&ctx, serde_json::json!({ "prompt": "p" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        assert!(channel.registers().is_empty(), "非法时长不得发起 register");
    }

    #[tokio::test]
    async fn set_timer_channel_none_unsupported() {
        let tool = SetTimerTool::new();
        let ctx = create_mock_tool_context();
        // 未接线环境返回 common.unsupported（不 panic）
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({ "durationSeconds": 300, "prompt": "检查编译" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "common.unsupported");
    }

    #[tokio::test]
    async fn set_timer_register_error_mapped_structurally() {
        // 通道侧错误（同 sender 冲突）结构化透传，不 panic
        let channel = Arc::new(RecordingTimerChannel::new(Err(TimerError::Conflict(
            "timer-1".to_string(),
        ))));
        let tool = SetTimerTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({ "durationSeconds": 300, "prompt": "p" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_VERSION_CONFLICT);
        assert!(err.to_string().contains("活跃定时器"));
    }

    // ── cancel_timer ─────────────────────────────────────────────

    #[tokio::test]
    async fn cancel_timer_forwards_id() {
        let channel = Arc::new(RecordingTimerChannel::new(Ok(ok_handle("timer-9", 1))));
        let tool = CancelTimerTool::with_channel(Some(channel.clone()));
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(&ctx, serde_json::json!({ "timerId": "timer-42" }))
            .await
            .unwrap();
        // 取消调用透传 timerId
        assert_eq!(channel.cancels(), vec!["timer-42".to_string()]);
        assert_eq!(out["timerId"], "timer-42");
        assert_eq!(out["cancelled"], true);
        assert!(out["text"].as_str().unwrap().contains("已取消"));
    }

    #[tokio::test]
    async fn cancel_timer_channel_none_unsupported() {
        let tool = CancelTimerTool::new();
        let ctx = create_mock_tool_context();
        // 未接线环境返回 common.unsupported（不 panic）
        let err = tool
            .execute(&ctx, serde_json::json!({ "timerId": "timer-1" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "common.unsupported");
    }

    #[tokio::test]
    async fn timer_error_code_mapping() {
        // 错误码映射回归（对齐 SubagentWaitError 风格）
        assert_eq!(
            TimerError::Conflict("t".to_string()).code(),
            codes::TOOL_VERSION_CONFLICT
        );
        assert_eq!(
            TimerError::InvalidDuration.code(),
            codes::TOOL_INVALID_INPUT
        );
        assert_eq!(TimerError::IdNotFound.code(), codes::COMMON_NOT_FOUND);
        assert_eq!(TimerError::Unsupported.code(), codes::COMMON_UNSUPPORTED);
        assert!(TimerError::IdNotFound.message().contains("不存在"));
    }
}
