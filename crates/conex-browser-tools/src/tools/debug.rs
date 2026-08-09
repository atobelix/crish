//! 调试类工具（2 个只读：console/network，17 §1.2 调试表）
//!
//! 只读面：读取事件总线缓冲（自首次调用起订阅，广播通道 tail 语义，此前事件不
//! 追溯）；审计面（全量审计）由引擎侧 M-4 接线，MVP 以结构化日志占位。
//! 字段缺口（11 事件面现状，P1 补齐）：console 无 url/line，network 无
//! status/size 与资源类型——输出置 null，resource_types 过滤未接线。
//! browser_evaluate 不在 MVP 注册清单（R-13 §8.2：动作执行无 evaluate；P1 落地时
//! 经 `error::unwired` 返回未接线错误）。

use crate::exec;
use crate::helpers;
use crate::tools::Ctx;
use agent_tools::context::ToolContext;
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

/// browser_console：控制台条目（只读，全量审计留接线）。
pub(crate) struct ConsoleTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl ConsoleTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_console".to_string(),
                description: "读取当前标签页的控制台条目（level/text；url/line 字段 MVP 置 null）。since_seq 增量读取。只读。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "number", "description": "可选，标签页序号（MVP 单标签：仅校验）" },
                        "since_seq": { "type": "number", "description": "可选，增量游标（返回 seq 大于该值的条目）" },
                        "level": { "type": "string", "description": "可选，过滤 debug|info|log|warn|error" }
                    },
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for ConsoleTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_console", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["tab_id", "since_seq", "level"])?;
        if let Some(tab_id) = helpers::optional_u64(&args, "tab_id")? {
            if tab_id == 0 {
                return Err(ToolError::invalid_input("tab_id 为 1 起始的标签序号"));
            }
        }
        let since_seq = helpers::optional_u64(&args, "since_seq")?.unwrap_or(0);
        let level_filter = helpers::optional_string(&args, "level")?;
        if let Some(level) = &level_filter {
            if !matches!(level.as_str(), "debug" | "info" | "log" | "warn" | "error") {
                return Err(ToolError::invalid_input(format!(
                    "level 仅支持 debug/info/log/warn/error，收到 {level}"
                )));
            }
        }
        let entries = ops.console_entries(since_seq).await;
        let entries: Vec<Value> = entries
            .iter()
            .filter(|e| level_filter.as_ref().is_none_or(|l| e.level == *l))
            .map(|e| {
                // 11 事件面未携带 url/line，MVP 置 null（P1 补）
                json!({ "level": e.level, "text": e.text, "url": Value::Null, "line": Value::Null })
            })
            .collect();
        Ok(json!({ "ok": true, "entries": entries }))
    }
}

/// browser_network：网络请求条目（只读；URL 已脱敏入库，17 §6.2）。
pub(crate) struct NetworkTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl NetworkTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_network".to_string(),
                description: "读取当前标签页的网络请求条目（id/url(脱敏)/method；status/size 字段 MVP 置 null）。since_seq 增量读取。只读。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "number", "description": "可选，标签页序号（MVP 单标签：仅校验）" },
                        "since_seq": { "type": "number", "description": "可选，增量游标（返回 seq 大于该值的条目）" },
                        "resource_types": { "type": "array", "items": { "type": "string" }, "description": "可选，资源类型过滤（未接线，P1；校验后忽略）" }
                    },
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for NetworkTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_network", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["tab_id", "since_seq", "resource_types"])?;
        if let Some(tab_id) = helpers::optional_u64(&args, "tab_id")? {
            if tab_id == 0 {
                return Err(ToolError::invalid_input("tab_id 为 1 起始的标签序号"));
            }
        }
        let since_seq = helpers::optional_u64(&args, "since_seq")?.unwrap_or(0);
        // resource_types 过滤未接线（事件面无资源类型字段，P1 补）
        if let Some(types) = helpers::optional_string_array(&args, "resource_types")? {
            if !types.is_empty() {
                tracing::debug!(
                    tool = "browser_network",
                    "resource_types 过滤未接线（P1），已忽略"
                );
            }
        }
        let entries = ops.network_entries(since_seq).await;
        let requests: Vec<Value> = entries
            .iter()
            .map(|e| {
                // 11 事件面未携带 status/size，MVP 置 null（P1 补）
                json!({
                    "id": e.id,
                    "url": e.url,
                    "method": e.method,
                    "status": Value::Null,
                    "size": Value::Null,
                })
            })
            .collect();
        Ok(json!({ "ok": true, "requests": requests }))
    }
}
