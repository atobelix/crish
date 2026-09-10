//! 交互类工具（8 个，17 §1.2 交互表；全 dangerous=true，Ask 审批联动）
//!
//! 执行路径：经 `ActionExecutor` 统一流水线（门禁 → 版本 → abort → 定位 → 派发 →
//! 后置复核，14 §2.2 T-8）；元素定位经共享快照缓存（`resolve_ref`：无缓存快照 →
//! stale_snapshot，索引缺失 → node_gone）。权限分级：dangerous 标记 + agent-tools
//! 既有 PermissionMode 体系（本 crate 不改动）；upload 另有默认拒绝能力位
//! （17 §2.3，SensitiveCapabilities.upload，红线语义不可豁免）。
//!
//! 未接线面（P1）：click 的 modifiers（执行器无修饰键面）、type 的 delay_ms（分块
//! 节流为执行器内部 12ms 节奏，R-4）、select_option 的 label/index 定位。

use crate::error;
use crate::exec;
use crate::helpers;
use crate::tools::{resolve_ref, resolve_tab, validate_tab_id, Ctx};
use agent_tools::context::ToolContext;
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use conex_browser::action::{ActionRequest, MouseButton, PathBufLike, Primitive, ScrollDir};
use serde_json::{json, Value};
use std::sync::Arc;

/// 可选 tab_id（targetId 字符串语义，P1）入参解析：校验后返回，缺省 = 活动标签。
fn optional_tab_id(args: &Value) -> Result<Option<String>, ToolError> {
    let tab_id = helpers::optional_string(args, "tab_id")?;
    if let Some(id) = &tab_id {
        validate_tab_id(id, "tab_id")?;
    }
    Ok(tab_id)
}

/// browser_click：点击元素（左/右/双击；ref 快照索引）。
pub(crate) struct ClickTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl ClickTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_click".to_string(),
                description: "点击快照中的 [N] 元素（危险操作，需审批）。button=left/right/middle，double_click=true 双击。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string", "description": "可选，标签 targetId（browser_list_tabs 输出；缺省 = 当前活动标签）" },
                        "ref": { "type": "number", "description": "快照索引 [N]（browser_snapshot 输出）" },
                        "button": { "type": "string", "description": "可选，left|right|middle（缺省 left）" },
                        "double_click": { "type": "boolean", "description": "可选，双击（缺省 false）" },
                        "modifiers": { "type": "array", "items": { "type": "string" }, "description": "可选，修饰键 alt/control/meta/shift（MVP 接线注记：校验后忽略）" }
                    },
                    "required": ["ref"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for ClickTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_click", &self.ctx.session).await?;
        helpers::reject_unknown(
            &args,
            &["tab_id", "ref", "button", "double_click", "modifiers"],
        )?;
        let tab_id = optional_tab_id(&args)?;
        let index = helpers::require_u64(&args, "ref")?;
        let button =
            helpers::optional_string(&args, "button")?.unwrap_or_else(|| "left".to_string());
        let double_click = helpers::optional_bool(&args, "double_click")?.unwrap_or(false);
        let modifiers = helpers::optional_string_array(&args, "modifiers")?.unwrap_or_default();
        let button = match button.as_str() {
            "left" => MouseButton::Left,
            "right" => MouseButton::Right,
            "middle" => MouseButton::Middle,
            other => {
                return Err(ToolError::invalid_input(format!(
                    "button 仅支持 left/right/middle，收到 {other}"
                )))
            }
        };
        for m in &modifiers {
            if !matches!(m.as_str(), "alt" | "control" | "meta" | "shift") {
                return Err(ToolError::invalid_input(format!(
                    "modifiers 仅支持 alt/control/meta/shift，收到 {m}"
                )));
            }
        }
        if !modifiers.is_empty() {
            // modifiers 未接线（执行器无修饰键面，P1）；校验后忽略并留痕
            tracing::debug!(tool = "browser_click", "modifiers 未接线（P1），已忽略");
        }
        // P1 多标签：缺省活动标签，可指定 targetId 路由到目标标签
        let tab = resolve_tab(ops, tab_id.as_deref())?;
        let el = resolve_ref(ops, &tab, index)?;
        ops.execute_action(ActionRequest {
            tab_id: tab.target_id.clone(),
            snapshot_version: ops.snapshot_version(&tab.target_id),
            element: Some(el),
            primitive: Primitive::Click {
                button,
                count: if double_click { 2 } else { 1 },
            },
        })
        .await
        .map_err(|e| error::map_action_error("browser_click", e))?;
        Ok(json!({
            "ok": true,
            "snapshotVersion": ops.snapshot_version(&tab.target_id),
        }))
    }
}

/// browser_type：向元素输入文本（分块 + 节流 + 回读校验，14 §4）。
pub(crate) struct TypeTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl TypeTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_type".to_string(),
                description: "向快照中的 [N] 元素输入文本（中文经 Input.insertText 安全路径，14 §4.4）。可选 submit_key 结尾提交（如 Enter）。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string", "description": "可选，标签 targetId（缺省 = 当前活动标签）" },
                        "ref": { "type": "number", "description": "快照索引 [N]" },
                        "text": { "type": "string", "description": "输入文本（上限 65536 字符）" },
                        "submit_key": { "type": "string", "description": "可选，结尾提交键（如 Enter/Tab）" },
                        "delay_ms": { "type": "number", "description": "可选，逐字符延迟（毫秒，0..10000；MVP 接线注记：分块节流由执行器内部节奏，忽略）" }
                    },
                    "required": ["ref", "text"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for TypeTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_type", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["tab_id", "ref", "text", "submit_key", "delay_ms"])?;
        let tab_id = optional_tab_id(&args)?;
        let index = helpers::require_u64(&args, "ref")?;
        let text = helpers::require_string(&args, "text")?;
        let submit_key = helpers::optional_string(&args, "submit_key")?;
        let delay_ms = helpers::optional_u32(&args, "delay_ms")?;
        let char_count = text.chars().count();
        if char_count > conex_browser::action::MAX_TYPE_CHARS {
            return Err(ToolError::invalid_input(format!(
                "text 超长（{char_count} 字符 > {} 上限）",
                conex_browser::action::MAX_TYPE_CHARS
            )));
        }
        // 恶意字符串护栏：控制字符样本（NUL/ESC 等）拒绝注入
        helpers::validate_no_control_chars(&text, "text")?;
        if let Some(key) = &submit_key {
            if key.chars().count() > 64 {
                return Err(ToolError::invalid_input("submit_key 超长（> 64 字符）"));
            }
            helpers::validate_no_control_chars(key, "submit_key")?;
        }
        if delay_ms.is_some_and(|d| d > 10_000) {
            return Err(ToolError::invalid_input(
                "delay_ms 超出范围（0..10000 毫秒）",
            ));
        }
        if text.is_empty() && submit_key.is_none() {
            return Err(ToolError::invalid_input("text 为空且未指定 submit_key"));
        }
        if delay_ms.is_some() {
            // delay_ms 未接线（分块节流为执行器内部 50 字符/12ms 节奏，R-4）
            tracing::debug!(tool = "browser_type", "delay_ms 未接线（P1），已忽略");
        }
        let tab = resolve_tab(ops, tab_id.as_deref())?;
        let el = resolve_ref(ops, &tab, index)?;
        ops.execute_action(ActionRequest {
            tab_id: tab.target_id.clone(),
            snapshot_version: ops.snapshot_version(&tab.target_id),
            element: Some(el),
            primitive: Primitive::Type { text, submit_key },
        })
        .await
        .map_err(|e| error::map_action_error("browser_type", e))?;
        Ok(json!({
            "ok": true,
            "snapshotVersion": ops.snapshot_version(&tab.target_id),
        }))
    }
}

/// browser_key：组合键（"Control+A" 语义，14 §4.3 键映射表）。
pub(crate) struct KeyTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl KeyTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_key".to_string(),
                description: "发送组合键（keys 数组按 '+' 连接，如 [\"Control\",\"A\"] 全选、[\"Enter\"] 回车）。作用于当前焦点元素/页面。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "keys": { "type": "array", "items": { "type": "string" }, "description": "组合键序列（每项 ≤ 64 字符，总量 ≤ 1024）" },
                        "tab_id": { "type": "string", "description": "可选，标签 targetId（缺省 = 当前活动标签）" }
                    },
                    "required": ["keys"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for KeyTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_key", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["keys", "tab_id"])?;
        let tab_id = optional_tab_id(&args)?;
        let keys = helpers::require_string_array(&args, "keys")?;
        if keys.is_empty() {
            return Err(ToolError::invalid_input("keys 不能为空数组"));
        }
        let mut joined = String::new();
        for (i, key) in keys.iter().enumerate() {
            if key.is_empty() || key.chars().count() > 64 {
                return Err(ToolError::invalid_input("keys 元素为空或超长（> 64 字符）"));
            }
            helpers::validate_no_control_chars(key, "keys")?;
            if i > 0 {
                joined.push('+');
            }
            joined.push_str(key);
        }
        if joined.chars().count() > 1024 {
            return Err(ToolError::invalid_input("keys 总量超长（> 1024 字符）"));
        }
        let tab = resolve_tab(ops, tab_id.as_deref())?;
        ops.execute_action(ActionRequest {
            tab_id: tab.target_id.clone(),
            snapshot_version: ops.snapshot_version(&tab.target_id),
            element: None,
            primitive: Primitive::Key { keys: joined },
        })
        .await
        .map_err(|e| error::map_action_error("browser_key", e))?;
        Ok(json!({
            "ok": true,
            "snapshotVersion": ops.snapshot_version(&tab.target_id),
        }))
    }
}

/// browser_scroll：滚动（页面级或 [N] 元素内滚动，14 §2.3 scroll 原语）。
pub(crate) struct ScrollTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl ScrollTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_scroll".to_string(),
                description: "滚动页面（无 ref）或 [N] 元素内滚动容器（带 ref）。direction=up/down/left/right，amount 为正整数（像素）。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string", "description": "可选，标签 targetId（缺省 = 当前活动标签）" },
                        "ref": { "type": "number", "description": "可选，元素内滚动容器的快照索引 [N]" },
                        "direction": { "type": "string", "description": "up|down|left|right" },
                        "amount": { "type": "number", "description": "滚动距离（像素，1..1000000）" }
                    },
                    "required": ["direction", "amount"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for ScrollTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_scroll", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["tab_id", "ref", "direction", "amount"])?;
        let tab_id = optional_tab_id(&args)?;
        let index = helpers::optional_u64(&args, "ref")?;
        let direction = helpers::require_string(&args, "direction")?;
        let amount = helpers::require_u64(&args, "amount")?;
        if amount == 0 || amount > 1_000_000 {
            return Err(ToolError::invalid_input("amount 超出范围（1..1000000）"));
        }
        let dir = match direction.as_str() {
            "up" => ScrollDir::Up,
            "down" => ScrollDir::Down,
            "left" => ScrollDir::Left,
            "right" => ScrollDir::Right,
            other => {
                return Err(ToolError::invalid_input(format!(
                    "direction 仅支持 up/down/left/right，收到 {other}"
                )))
            }
        };
        let tab = resolve_tab(ops, tab_id.as_deref())?;
        let el = if let Some(i) = index {
            Some(resolve_ref(ops, &tab, i)?)
        } else {
            None
        };
        ops.execute_action(ActionRequest {
            tab_id: tab.target_id.clone(),
            snapshot_version: ops.snapshot_version(&tab.target_id),
            element: el,
            primitive: Primitive::Scroll {
                dir,
                amount: amount as i32,
            },
        })
        .await
        .map_err(|e| error::map_action_error("browser_scroll", e))?;
        Ok(json!({
            "ok": true,
            "snapshotVersion": ops.snapshot_version(&tab.target_id),
        }))
    }
}

/// browser_hover：悬停元素（坐标路径，定位链 §3）。
pub(crate) struct HoverTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl HoverTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_hover".to_string(),
                description: "鼠标悬停到快照中的 [N] 元素（触发 hover 效果）。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string", "description": "可选，标签 targetId（缺省 = 当前活动标签）" },
                        "ref": { "type": "number", "description": "快照索引 [N]" }
                    },
                    "required": ["ref"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for HoverTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_hover", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["tab_id", "ref"])?;
        let tab_id = optional_tab_id(&args)?;
        let index = helpers::require_u64(&args, "ref")?;
        let tab = resolve_tab(ops, tab_id.as_deref())?;
        let el = resolve_ref(ops, &tab, index)?;
        ops.execute_action(ActionRequest {
            tab_id: tab.target_id.clone(),
            snapshot_version: ops.snapshot_version(&tab.target_id),
            element: Some(el),
            primitive: Primitive::Hover,
        })
        .await
        .map_err(|e| error::map_action_error("browser_hover", e))?;
        Ok(json!({ "ok": true }))
    }
}

/// browser_drag：拖拽（from_ref → to_ref，插值轨迹，14 §2.3 drag）。
pub(crate) struct DragTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl DragTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_drag".to_string(),
                description: "从快照 [from_ref] 元素拖拽到 [to_ref] 元素（拖拽轨迹 8 步插值）。"
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string", "description": "可选，标签 targetId（缺省 = 当前活动标签）" },
                        "from_ref": { "type": "number", "description": "拖拽起点快照索引 [N]" },
                        "to_ref": { "type": "number", "description": "拖拽终点快照索引 [N]" }
                    },
                    "required": ["from_ref", "to_ref"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for DragTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_drag", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["tab_id", "from_ref", "to_ref"])?;
        let tab_id = optional_tab_id(&args)?;
        let from_index = helpers::require_u64(&args, "from_ref")?;
        let to_index = helpers::require_u64(&args, "to_ref")?;
        let tab = resolve_tab(ops, tab_id.as_deref())?;
        let from = resolve_ref(ops, &tab, from_index)?;
        let to = resolve_ref(ops, &tab, to_index)?;
        ops.execute_action(ActionRequest {
            tab_id: tab.target_id.clone(),
            snapshot_version: ops.snapshot_version(&tab.target_id),
            element: Some(from),
            primitive: Primitive::Drag { to },
        })
        .await
        .map_err(|e| error::map_action_error("browser_drag", e))?;
        Ok(json!({
            "ok": true,
            "snapshotVersion": ops.snapshot_version(&tab.target_id),
        }))
    }
}

/// browser_select_option：下拉选择（MVP 仅 value；label/index 未接线）。
pub(crate) struct SelectOptionTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl SelectOptionTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_select_option".to_string(),
                description: "为快照中的 [N] 下拉框选择选项（value/label/index 三选一；MVP 仅支持 value，label/index 返回未接线错误）。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string", "description": "可选，标签 targetId（缺省 = 当前活动标签）" },
                        "ref": { "type": "number", "description": "快照索引 [N]" },
                        "value": { "type": "string", "description": "选项 value（与 label/index 三选一）" },
                        "label": { "type": "string", "description": "选项 label（未接线，P1）" },
                        "index": { "type": "number", "description": "选项序号（未接线，P1）" }
                    },
                    "required": ["ref"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for SelectOptionTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops =
            exec::run_browser_action(tctx, "browser_select_option", &self.ctx.session).await?;
        helpers::reject_unknown(&args, &["tab_id", "ref", "value", "label", "index"])?;
        let tab_id = optional_tab_id(&args)?;
        let index = helpers::require_u64(&args, "ref")?;
        let value = helpers::optional_string(&args, "value")?;
        let label = helpers::optional_string(&args, "label")?;
        let index_arg = helpers::optional_u64(&args, "index")?;
        let chosen = usize::from(value.is_some())
            + usize::from(label.is_some())
            + usize::from(index_arg.is_some());
        if chosen != 1 {
            return Err(ToolError::invalid_input(
                "value/label/index 必须且只能提供一个",
            ));
        }
        let value = match (value, label, index_arg) {
            (Some(v), None, None) => {
                if v.chars().count() > 1024 {
                    return Err(ToolError::invalid_input("value 超长（> 1024 字符）"));
                }
                helpers::validate_no_control_chars(&v, "value")?;
                v
            }
            // label/index 定位需 DOM 解析（14 §2.3 select 仅 value 路径），MVP 未接线
            (None, Some(_), None) | (None, None, Some(_)) => {
                return Err(error::unwired("select_option 的 label/index 定位"))
            }
            _ => {
                return Err(ToolError::invalid_input(
                    "value/label/index 必须且只能提供一个",
                ))
            }
        };
        let tab = resolve_tab(ops, tab_id.as_deref())?;
        let el = resolve_ref(ops, &tab, index)?;
        ops.execute_action(ActionRequest {
            tab_id: tab.target_id.clone(),
            snapshot_version: ops.snapshot_version(&tab.target_id),
            element: Some(el),
            primitive: Primitive::SelectOption { value },
        })
        .await
        .map_err(|e| error::map_action_error("browser_select_option", e))?;
        Ok(json!({
            "ok": true,
            "snapshotVersion": ops.snapshot_version(&tab.target_id),
        }))
    }
}

/// browser_upload：上传文件（危险 + 默认拒绝能力位，17 §2.3/§7.2）。
pub(crate) struct UploadTool {
    ctx: Arc<Ctx>,
    def: ToolDefinition,
}

impl UploadTool {
    pub(crate) fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            def: ToolDefinition {
                name: "browser_upload".to_string(),
                description: "向快照中的 [N] 文件输入元素上传工作区内文件（files 为工作区相对/绝对路径，越出工作区拒绝；危险操作，需能力位开启 + 审批）。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": { "type": "string", "description": "可选，标签 targetId（缺省 = 当前活动标签）" },
                        "ref": { "type": "number", "description": "快照索引 [N]（文件输入元素）" },
                        "files": { "type": "array", "items": { "type": "string" }, "description": "工作区内文件路径（1..8 个）" }
                    },
                    "required": ["ref", "files"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for UploadTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        let ops = exec::run_browser_action(tctx, "browser_upload", &self.ctx.session).await?;
        // 默认拒绝面（17 §2.3 红线语义）：能力位未开 → 任何权限模式直接 Deny
        if !self.ctx.sensitive.upload {
            return Err(error::capability_disabled("upload"));
        }
        helpers::reject_unknown(&args, &["tab_id", "ref", "files"])?;
        let tab_id = optional_tab_id(&args)?;
        let index = helpers::require_u64(&args, "ref")?;
        let files = helpers::require_string_array(&args, "files")?;
        if files.is_empty() {
            return Err(ToolError::invalid_input("files 不能为空数组"));
        }
        if files.len() > 8 {
            return Err(ToolError::invalid_input("files 最多 8 个文件"));
        }
        // 工作区路径校验（17 §7.2：canonicalize + symlink 双保险；越界 path_escape）
        let mut resolved = Vec::with_capacity(files.len());
        for file in &files {
            helpers::validate_no_control_chars(file, "files")?;
            resolved.push(helpers::resolve_workspace_path(&tctx.workspace_root, file)?);
        }
        let tab = resolve_tab(ops, tab_id.as_deref())?;
        let el = resolve_ref(ops, &tab, index)?;
        // MVP：逐文件执行上传原语（多文件一次 setFileInputFiles 合并为 P1 接线项）
        for path in &resolved {
            ops.execute_action(ActionRequest {
                tab_id: tab.target_id.clone(),
                snapshot_version: ops.snapshot_version(&tab.target_id),
                element: Some(el),
                primitive: Primitive::Upload {
                    path: PathBufLike(path.clone()),
                },
            })
            .await
            .map_err(|e| error::map_action_error("browser_upload", e))?;
        }
        Ok(json!({
            "ok": true,
            "files": files,
        }))
    }
}
