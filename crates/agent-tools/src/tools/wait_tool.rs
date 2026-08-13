//! wait_subagents · 工具域（SR-06a-3 拆分子模块）
//!
//! 逻辑域：WaitSubagentsTool（工具定义 + Tool 实现 + execute 入参解析 /
//! 调度声明持久化 / 运行中注入 / 三模式等待 / 终态产出收集 / 结果信封）。
//! 类型与契约定义位于 wait_defs，事件驱动等待原语位于 wait_events。
//! 诚实边界：仅结构拆分，语义零改动（≠ EL / ≠ 打开完成 / ≠ 结构债清零）。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::{optional_string, optional_u64};
use async_trait::async_trait;
use conex_types::error::codes;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

use super::wait_defs::{
    collect_subagent_output_files, now_millis, DispatchDeclaration, SubagentOutput,
    SubagentWaitChannel, SubagentWaitResult, WaitMode, DEFAULT_TIMER_WAIT_MS,
    MAX_WAIT_TIMEOUT_MS,
};

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

    async fn execute(&self, ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
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
        let mode = match optional_string(&args, "mode") {
            Some(raw) => WaitMode::parse(&raw)
                .ok_or_else(|| ToolError::invalid_input(format!("未知等待模式：{raw}")))?,
            None => WaitMode::AwaitAll,
        };
        // 显式 timeoutMs=0 = 非阻塞快照（02 Top 7：省略 timeout 或 0 均为
        // 快照语义）——与「省略」区分：省略走模式缺省，显式 0 强制快照
        let explicit_zero_timeout =
            matches!(args.get("timeoutMs"), Some(v) if v.as_f64() == Some(0.0));
        let timeout_ms = optional_u64(&args, "timeoutMs");
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

        // 终态产出收集（G02 完成通知字段）：从 write_claims 持有者记录
        // 按子代理身份收集产出文件（引擎强制，不依赖 AI 自觉）；摘要取
        // 子代理最终消息摘要。空结果不持久化、载荷输出空数组
        let mut outputs_by_agent: HashMap<String, Vec<SubagentOutput>> = HashMap::new();
        for agent in &result.agents {
            let files = collect_subagent_output_files(
                ctx.write_claims.as_deref(),
                &agent.subagent_id,
                &ctx.workspace_root,
                agent.summary.as_deref(),
            );
            if !files.is_empty() {
                outputs_by_agent.insert(agent.subagent_id.clone(), files);
            }
        }
        if !outputs_by_agent.is_empty() {
            channel
                .persist_outputs(&outputs_by_agent)
                .await
                .map_err(|e| ToolError::new(e.code(), e.message()))?;
        }

        // 结果信封：结构化摘要（不重放全量消息）；终态载荷附带 outputFiles
        //（path/summary/bytes，供主控汇总各子代理产出路径，REQ-G02）
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
                "outputFiles": outputs_by_agent.get(&a.subagent_id).map(|files| files.iter().map(|o| serde_json::json!({
                    "path": o.path,
                    "summary": o.summary,
                    "bytes": o.bytes,
                })).collect::<Vec<_>>()).unwrap_or_default(),
            })).collect::<Vec<_>>(),
        }))
    }
}
