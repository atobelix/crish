//! run_subagent 工具域（SR-06a 拆分）：工具定义 / 入参解析（单发+批量）/
//! Tool 实现（execute / execute_many）。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use conex_types::error::codes;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

use super::{
    apply_forgery_boundary, SubagentCapabilityMode, SubagentRole, SubagentSpawnRequest,
    SubagentSpawner, TaskType,
};

// ── run_subagent 工具 ─────────────────────────────────────────────

/// run_subagent 工具：spawn 子代理（独立会话 + run，parent_id 链）
pub(crate) struct RunSubagentTool {
    def: ToolDefinition,
    /// spawn 通道（None = 未接线，返回结构化不可用错误）
    spawner: Option<Arc<dyn SubagentSpawner>>,
}

impl RunSubagentTool {
    /// 新建工具（spawn 通道未接线；测试与未集成环境返回结构化不可用错误）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new() -> Self {
        Self::with_spawner(None)
    }

    /// 新建工具并注入 spawn 通道（注册面接线点：BuiltinToolConfig 注入）
    pub(crate) fn with_spawner(spawner: Option<Arc<dyn SubagentSpawner>>) -> Self {
        Self {
            def: ToolDefinition {
                name: "run_subagent".to_string(),
                description: "启动独立子代理会话与 run（父代理编排用）：子代理在独立会话中工作，\
                              完成后由主 agent 编排下一步。支持单发（prompt）与批量派发（tasks：\
                              一次创建 N 个并行子代理，无依赖平铺并行，REQ-D02 语义；任一守卫拒绝\
                              → 整体失败零 run）；prompt 与 tasks 互斥二选一。返回\
                              subagentId/subagentRunId/sessionId/status。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "prompt": {
                            "type": "string",
                            "description": "任务目标（单发路径必填；与 tasks 互斥，二选一）：子代理在独立会话中执行的指令"
                        },
                        "agentId": {
                            "type": "string",
                            "description": "子代理定义 id（agentId/definitionId，可选）"
                        },
                        "role": {
                            "type": "string",
                            "enum": ["researcher", "implementer", "reviewer", "debugger", "planner"],
                            "description": "角色标签（可选，仅展示与过滤，不影响调度）"
                        },
                        "capabilityMode": {
                            "type": "string",
                            "enum": ["read-only", "read-write", "execute", "all"],
                            "description": "能力模式（可选，控制实际权限；read-only 裁剪工具集）"
                        },
                        "allowedTools": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "允许调用的工具白名单（可选裁剪；缺省继承父代理全部工具）"
                        },
                        "description": {
                            "type": "string",
                            "description": "子代理描述（可选，展示用）"
                        },
                        "mode": {
                            "type": "string",
                            "enum": ["research", "research_single", "solve", "write"],
                            "description": "执行模式（可选，对齐前端 AgentBrowsePad 语义）"
                        },
                        "taskType": {
                            "type": "string",
                            "enum": ["analysis", "design", "review", "implementation", "organization", "commit"],
                            "description": "任务类型（可选，缺省 analysis）：驱动系统默认权限集（工具集/写路径沙箱/命令策略），主 agent 不用配细节"
                        },
                        "allowedWritePaths": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "显式写路径白名单（可选，硬沙箱输入）：覆盖 task_type 默认集，越界写入被拦截；缺省按默认集装配（如 implementation=工作区根）"
                        },
                        "displayLabel": {
                            "type": "string",
                            "description": "角色展示标签（2-5 字自由文本，可选；仅展示，不影响调度）"
                        },
                        "tasks": {
                            "type": "array",
                            "description": "批量派发（与 prompt 互斥，二选一）：一次创建 N 个并行子代理（无依赖平铺并行，REQ-D02 语义）；原子性——任一守卫拒绝整体失败零 run。条目字段：prompt（必填）/ role / displayLabel / capabilityMode / description",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "prompt": {
                                        "type": "string",
                                        "description": "任务目标（必填）：该子代理在独立会话中执行的指令"
                                    },
                                    "role": {
                                        "type": "string",
                                        "enum": ["researcher", "implementer", "reviewer", "debugger", "planner"],
                                        "description": "角色标签（可选，仅展示与过滤，不影响调度）"
                                    },
                                    "displayLabel": {
                                        "type": "string",
                                        "description": "角色展示标签（2-5 字自由文本，可选；仅展示，不影响调度）"
                                    },
                                    "capabilityMode": {
                                        "type": "string",
                                        "enum": ["read-only", "read-write", "execute", "all"],
                                        "description": "能力模式（可选，控制实际权限；read-only 裁剪工具集）"
                                    },
                                    "description": {
                                        "type": "string",
                                        "description": "子代理描述（可选，展示用）"
                                    }
                                },
                                "required": ["prompt"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
            spawner,
        }
    }

    /// 批量派发分支（T-D-06）：tasks 数组逐条装配请求 → [SubagentSpawner::spawn_many]
    /// → 结果数组信封（顺序与入参一致，每条 subagentId/subagentRunId/
    /// sessionId/status/summary/displayLabel）。
    ///
    /// 顶层单发参数（agentId/role/capabilityMode/allowedTools/
    /// description/mode/taskType/allowedWritePaths/displayLabel）在批量模式下
    /// 不适用（以 tasks 条目内字段为准），显式给出即结构化拒绝（与
    /// prompt+tasks 互斥同一「防歧义」语义）。
    async fn execute_many(
        &self,
        ctx: &ToolContext,
        tasks: &[BatchTaskArg],
        args: &Value,
    ) -> Result<Value, ToolError> {
        for key in [
            "agentId",
            "role",
            "capabilityMode",
            "allowedTools",
            "description",
            "mode",
            "taskType",
            "allowedWritePaths",
            "displayLabel",
        ] {
            if args.get(key).is_some() {
                return Err(ToolError::invalid_input(format!(
                    "批量派发（tasks）下顶层参数 {key} 不适用：请在 tasks 条目内配置\
                     （role/capabilityMode/displayLabel/description）"
                )));
            }
        }
        // spawn 通道未接线 → 结构化不可用错误（引擎集成前零副作用）
        let Some(spawner) = &self.spawner else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "run_subagent 未接线：spawn 通道未装配（引擎集成后可用）",
            ));
        };

        let requests: Vec<SubagentSpawnRequest> = tasks
            .iter()
            .map(|task| SubagentSpawnRequest {
                agent_id: None,
                prompt: task.prompt.clone(),
                role: task.role,
                capability_mode: task.capability_mode,
                allowed_tools: None,
                description: task.description.clone(),
                mode: None,
                parent_session_id: ctx.session_id.clone(),
                parent_run_id: None,
                // LK-02：工具直调真键——携带本次工具调用 id（exec_single
                // 注入；None = 非工具上下文）
                parent_tool_call_id: ctx.tool_call_id.clone(),
                // 工具直调路径不携带流程关联（C6 调度器经 spawner 直接 spawn）
                flow_node_id: None,
                is_composite: false,
                task_type: None,
                allowed_write_paths: None,
                display_label: task.display_label.clone(),
                permission_mode: None,
                // 扩展点预留：批量路径同样恒不解析 modelOverride（T-D-10）
                model_override: None,
            })
            .collect();
        // 原子语义由 spawner 实现承担：任一守卫拒绝 → 整体失败零 run
        let results = spawner
            .spawn_many(&requests)
            .await
            .map_err(|e| ToolError::new(e.code(), e.message()))?;

        // 结果数组信封：summary 逐条经伪造审批防护（01 Top 3）；
        // display_label 回显（T-D-05，前端 title 优先展示）
        Ok(serde_json::json!({
            "results": results.iter().map(|result| serde_json::json!({
                "subagentId": result.subagent_id,
                "subagentRunId": result.subagent_run_id,
                "sessionId": result.session_id,
                "status": result.status.as_str(),
                "summary": result.summary.as_ref().map(|s| apply_forgery_boundary(s)),
                "displayLabel": result.display_label,
            })).collect::<Vec<_>>(),
        }))
    }
}

// ── 批量派发解析（T-D-06：tasks 数组）────────────────────────────

/// 批量任务条目（tasks 数组元素，字段对齐方案 schema：prompt/role/
/// displayLabel/capabilityMode/description）
#[derive(Debug, Clone, PartialEq, Eq)]
struct BatchTaskArg {
    /// 任务目标（必填）
    prompt: String,
    /// 角色标签（可选，仅展示/过滤）
    role: Option<SubagentRole>,
    /// 能力模式（可选；read-only 裁剪工具集）
    capability_mode: Option<SubagentCapabilityMode>,
    /// 角色展示标签（可选，仅展示）
    display_label: Option<String>,
    /// 描述（可选，展示用）
    description: Option<String>,
}

/// 解析 tasks 入参（T-D-06 批量分支；缺省 None = 单发路径）。
/// 结构校验：tasks 必须是非空对象数组；条目 prompt 必填非空；枚举字段
/// 未知即结构化拒绝（对齐 role/capabilityMode 单发拒绝面）。
fn parse_tasks(args: &Value) -> Result<Option<Vec<BatchTaskArg>>, ToolError> {
    let Some(raw) = args.get("tasks") else {
        return Ok(None);
    };
    let items = raw
        .as_array()
        .ok_or_else(|| ToolError::invalid_input("tasks 必须是对象数组"))?;
    if items.is_empty() {
        return Err(ToolError::invalid_input("tasks 不得为空数组"));
    }
    let mut tasks = Vec::with_capacity(items.len());
    for item in items {
        let obj = item
            .as_object()
            .ok_or_else(|| ToolError::invalid_input("tasks 条目必须是对象"))?;
        let prompt = obj
            .get("prompt")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| ToolError::invalid_input("tasks 条目缺少必填 prompt"))?
            .to_string();
        let role = match obj.get("role").and_then(Value::as_str) {
            Some(raw_role) => Some(
                SubagentRole::parse(raw_role)
                    .ok_or_else(|| ToolError::invalid_input(format!("未知角色：{raw_role}")))?,
            ),
            None => None,
        };
        let capability_mode = match obj.get("capabilityMode").and_then(Value::as_str) {
            Some(raw_mode) => Some(
                SubagentCapabilityMode::parse(raw_mode)
                    .ok_or_else(|| ToolError::invalid_input(format!("未知能力模式：{raw_mode}")))?,
            ),
            None => None,
        };
        let display_label = obj
            .get("displayLabel")
            .and_then(Value::as_str)
            .map(str::to_string);
        let description = obj
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string);
        tasks.push(BatchTaskArg {
            prompt,
            role,
            capability_mode,
            display_label,
            description,
        });
    }
    Ok(Some(tasks))
}

#[async_trait]
impl Tool for RunSubagentTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        // T-D-06 单发/批量互斥：prompt 与 tasks 二选一（防歧义）
        let prompt = crate::tools::optional_string(&args, "prompt");
        let tasks = parse_tasks(&args)?;
        if tasks.is_some() && prompt.is_some() {
            return Err(ToolError::invalid_input(
                "tasks 与 prompt 不能同时提供：单发与批量互斥，请二选一\
                 （单发给 prompt，批量派发给 tasks）",
            ));
        }
        // 批量分支（T-D-06）：tasks 数组 → spawn_many（原子语义：任一守卫
        // 拒绝 → 整体失败零 run，不产生部分成功）
        if let Some(tasks) = tasks {
            return self.execute_many(ctx, &tasks, &args).await;
        }
        // 单发分支：prompt 必填
        let Some(prompt) = prompt else {
            return Err(ToolError::invalid_input(
                "prompt 或 tasks 必须提供其一：单发给 prompt，批量派发给 tasks",
            ));
        };
        // 控制字符拒绝（对齐原 require_string 校验面）
        if prompt.chars().any(|c| {
            matches!(
                c,
                '\u{0000}'..='\u{0008}' | '\u{000b}' | '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}'
            )
        }) {
            return Err(ToolError::invalid_input(
                "prompt contains invalid control characters",
            ));
        }
        // 入参解析：role/capabilityMode/allowedTools 可选
        let agent_id = crate::tools::optional_string(&args, "agentId");
        let role = match crate::tools::optional_string(&args, "role") {
            Some(raw) => Some(
                SubagentRole::parse(&raw)
                    .ok_or_else(|| ToolError::invalid_input(format!("未知角色：{raw}")))?,
            ),
            None => None,
        };
        let capability_mode = match crate::tools::optional_string(&args, "capabilityMode") {
            Some(raw) => Some(
                SubagentCapabilityMode::parse(&raw)
                    .ok_or_else(|| ToolError::invalid_input(format!("未知能力模式：{raw}")))?,
            ),
            None => None,
        };
        let allowed_tools: Option<Vec<String>> = match args.get("allowedTools") {
            Some(value) => Some(
                value
                    .as_array()
                    .ok_or_else(|| ToolError::invalid_input("allowedTools 必须是字符串数组"))?
                    .iter()
                    .map(|v| {
                        v.as_str().map(str::to_string).ok_or_else(|| {
                            ToolError::invalid_input("allowedTools 必须是字符串数组")
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            None => None,
        };
        let description = crate::tools::optional_string(&args, "description");
        let mode = crate::tools::optional_string(&args, "mode");
        let task_type = match crate::tools::optional_string(&args, "taskType") {
            Some(raw) => Some(
                TaskType::parse(&raw)
                    .ok_or_else(|| ToolError::invalid_input(format!("未知任务类型：{raw}")))?,
            ),
            None => None,
        };
        let allowed_write_paths: Option<Vec<PathBuf>> = match args.get("allowedWritePaths") {
            Some(value) => Some(
                value
                    .as_array()
                    .ok_or_else(|| ToolError::invalid_input("allowedWritePaths 必须是字符串数组"))?
                    .iter()
                    .map(|v| {
                        v.as_str().map(PathBuf::from).ok_or_else(|| {
                            ToolError::invalid_input("allowedWritePaths 必须是字符串数组")
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            None => None,
        };
        let display_label = crate::tools::optional_string(&args, "displayLabel");

        // spawn 通道未接线 → 结构化不可用错误（引擎集成前零副作用）
        let Some(spawner) = &self.spawner else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "run_subagent 未接线：spawn 通道未装配（引擎集成后可用）",
            ));
        };

        let request = SubagentSpawnRequest {
            agent_id,
            prompt,
            role,
            capability_mode,
            allowed_tools,
            description,
            mode,
            parent_session_id: ctx.session_id.clone(),
            parent_run_id: None,
            // LK-02：工具直调真键——携带本次工具调用 id（exec_single
            // 注入；None = 非工具上下文）
            parent_tool_call_id: ctx.tool_call_id.clone(),
            // 工具直调路径不携带流程关联（C6 调度器经 spawner 直接 spawn）
            flow_node_id: None,
            is_composite: false,
            task_type,
            allowed_write_paths,
            display_label,
            permission_mode: crate::tools::optional_string(&args, "permissionMode")
                .or_else(|| crate::tools::optional_string(&args, "permission_mode")),
            // 扩展点预留：工具路径恒不解析 modelOverride 入参（T-D-10 多模型
            // 不做，不得附带消费逻辑）——全构造点显式 None（编译器强制）
            model_override: None,
        };
        let result = spawner
            .spawn(&request)
            .await
            .map_err(|e| ToolError::new(e.code(), e.message()))?;

        // 结果信封：summary 文案经伪造审批防护处理（01 Top 3）；
        // display_label 回显（T-D-05，前端 title 优先展示）
        let summary = result.summary.map(|s| apply_forgery_boundary(&s));
        Ok(serde_json::json!({
            "subagentId": result.subagent_id,
            "subagentRunId": result.subagent_run_id,
            "sessionId": result.session_id,
            "status": result.status.as_str(),
            "summary": summary,
            "displayLabel": result.display_label,
        }))
    }
}
