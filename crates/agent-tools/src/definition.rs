//! 工具定义与工具接口（对齐 TS 端 tools/tool-definition.ts 语义）
//!
//! 定义与执行分离：ToolDefinition 只承载声明（名称/描述/入参 schema/危险标记），
//! 第三方工具实现 Tool trait 的执行面 execute，注册后由 ToolRegistry 统一管理。

use crate::context::ToolContext;
use async_trait::async_trait;
use conex_types::error::{codes, CrishError, CrishErrorPayload};
use serde::{Deserialize, Serialize};

/// 缺失入参 schema 时的兜底形状（02 §二.6：{type:'object',properties:{},additionalProperties:true}）
pub fn default_input_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {},
        "additionalProperties": true
    })
}

static DEFAULT_INPUT_SCHEMA: std::sync::LazyLock<serde_json::Value> =
    std::sync::LazyLock::new(default_input_schema);

/// 工具定义（对齐 TS ToolDefinition）
///
/// 仅承载声明信息，不含执行逻辑。序列化字段 camelCase，
/// 与 provider 工具定义形状（02 §二.6）对齐：缺 schema 时回退兜底形状。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    /// 工具名，注册表全局唯一键（provider 请求中作为 function.name）
    pub name: String,
    /// 人读描述，随工具定义发送给模型
    pub description: String,
    /// 入参 JSON Schema；缺省时回退到 `default_input_schema()` 兜底形状
    #[serde(default = "default_input_schema")]
    pub input_schema: serde_json::Value,
    /// 危险标记：true 表示执行可能有破坏性副作用（删除/推送/提权等），需审批联动
    #[serde(default)]
    pub dangerous: bool,
    /// fatalOnError 标记（01 §五.8）：true 表示该工具**任何执行错误**都是致命的，
    /// run 应以 error 收场；默认 false——工具失败（文件不存在、命令失败等）作为
    /// 错误结果喂回模型，由模型调整策略继续（对齐 pi：工具错误不终止 run）。
    /// fatalOnError 是工具级属性，不是按错误类型一刀切。
    #[serde(default)]
    pub fatal_on_error: bool,
}

impl ToolDefinition {
    /// 有效入参 schema：input_schema 为 null（程序化构造缺省）时回退兜底形状
    pub fn effective_input_schema(&self) -> &serde_json::Value {
        if self.input_schema.is_null() {
            &DEFAULT_INPUT_SCHEMA
        } else {
            &self.input_schema
        }
    }

    /// fatalOnError 判定（01 §五.8）：工具定义标记 fatalOnError 时，**任何**
    /// 执行错误都是致命的；未标记时工具错误作为结果喂回模型继续（pi 语义）。
    /// 审批/超时/取消类由调用方排除（softDeny/timedOut/cancelled/
    /// approval_expired/user_denied 永不致命）。
    pub fn is_fatal_error(&self) -> bool {
        self.fatal_on_error
    }
}

/// 工具执行错误（基于 conex-types 错误体系）
///
/// 包一层 CrishError 以承载 tool.* 域错误码（tool.not_found /
/// tool.invalid_input / tool.execution_failed），序列化透明透传
/// CrishError 的 camelCase 结构，可经 `to_error_payload` 出站。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ToolError(CrishError);

impl ToolError {
    /// 用错误码构造（category/retryable 由码表决定）
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self(CrishError::new(code, message))
    }

    /// 工具未找到（tool.not_found）
    pub fn not_found(tool_name: impl Into<String>) -> Self {
        Self::new(
            codes::TOOL_NOT_FOUND,
            format!("工具未注册：{}", tool_name.into()),
        )
    }

    /// 入参非法（tool.invalid_input）
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(codes::TOOL_INVALID_INPUT, message)
    }

    /// 执行失败（tool.execution_failed）
    pub fn execution_failed(tool_name: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(
            codes::TOOL_EXECUTION_FAILED,
            format!("工具 {} 执行失败：{}", tool_name.into(), message.into()),
        )
    }

    /// 错误码（供上层判断错误类别，如 tool.requires_approval 走审批流）
    pub fn code(&self) -> &str {
        &self.0.code
    }

    /// 转为出站错误负载（cause 链深度上限截断）
    pub fn to_error_payload(&self, depth: u8) -> CrishErrorPayload {
        self.0.to_error_payload(depth)
    }
}

impl From<CrishError> for ToolError {
    fn from(e: CrishError) -> Self {
        Self(e)
    }
}

impl From<ToolError> for CrishError {
    fn from(e: ToolError) -> Self {
        e.0
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.0.code, self.0.message)
    }
}

impl std::error::Error for ToolError {}

/// 工具接口（对齐 TS AgentTool 执行面）
///
/// 所有内置工具与第三方工具经本 trait 进入工具执行器（B3.5）。
/// 实现须保证 `name()` 与 `definition().name` 一致；execute 的幂等性
/// 由工具自身保证（幂等守卫在 B5.3 提供）。
#[async_trait]
pub trait Tool: Send + Sync {
    /// 工具名（注册键，与 definition().name 保持一致）
    fn name(&self) -> &str;

    /// 工具定义（声明信息，随工具列表发送给模型）
    fn definition(&self) -> &ToolDefinition;

    /// 执行工具（R3 T9：携带会话级上下文）
    ///
    /// ctx 为会话级上下文（session_id / abort_token / ask / workspace_root），
    /// 工具需要会话数据（工作区根、中止检查、审批提问）时从 ctx 读取；
    /// args 为结构化入参（JSON 对象），须与 definition().input_schema 匹配；
    /// 返回结构化输出（JSON 值）。失败返回类型化 ToolError（tool.* 错误码）。
    async fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn definition_serde_camel_case() {
        let def = ToolDefinition {
            name: "echo".to_string(),
            description: "回显入参".to_string(),
            input_schema: json!({ "type": "object" }),
            dangerous: true,
            fatal_on_error: false,
        };
        let v = serde_json::to_value(&def).unwrap();
        // 序列化字段对齐 02 §二.6：inputSchema 驼峰
        assert_eq!(v["name"], "echo");
        assert_eq!(v["inputSchema"], json!({ "type": "object" }));
        assert_eq!(v["dangerous"], true);
        assert!(v.get("input_schema").is_none());

        let back: ToolDefinition = serde_json::from_value(v).unwrap();
        assert_eq!(back, def);
    }

    #[test]
    fn missing_input_schema_falls_back_to_default() {
        // 缺 inputSchema 字段时回退兜底形状（02 §二.6 验收）
        let def: ToolDefinition =
            serde_json::from_value(json!({ "name": "echo", "description": "d" })).unwrap();
        assert_eq!(
            def.input_schema,
            json!({ "type": "object", "properties": {}, "additionalProperties": true })
        );
    }

    #[test]
    fn effective_input_schema_handles_null() {
        let def = ToolDefinition {
            name: "echo".to_string(),
            description: "d".to_string(),
            input_schema: serde_json::Value::Null,
            dangerous: false,
            fatal_on_error: false,
        };
        assert_eq!(
            def.effective_input_schema(),
            &json!({ "type": "object", "properties": {}, "additionalProperties": true })
        );

        let custom = json!({ "type": "object", "properties": { "msg": { "type": "string" } } });
        let def2 = ToolDefinition {
            input_schema: custom.clone(),
            ..def
        };
        assert_eq!(def2.effective_input_schema(), &custom);
    }

    #[test]
    fn tool_error_uses_types_error_system() {
        let err = ToolError::not_found("nope");
        assert_eq!(err.to_string(), "[tool.not_found] 工具未注册：nope");

        let payload = err.to_error_payload(0);
        assert_eq!(payload.code, "tool.not_found");
        assert!(!payload.retryable);

        // 与 conex-types 错误体系互转无损
        let inner: CrishError = err.clone().into();
        assert_eq!(inner.code, "tool.not_found");
        let back: ToolError = inner.into();
        assert_eq!(back, err);
    }

    #[tokio::test]
    async fn echo_tool_execute_roundtrip() {
        use crate::context::create_mock_tool_context;
        use crate::test_support::EchoTool;

        let tool = EchoTool::new("echo");
        assert_eq!(tool.name(), "echo");
        let out = tool
            .execute(&create_mock_tool_context(), json!({ "msg": "你好" }))
            .await
            .unwrap();
        assert_eq!(out, json!({ "echo": { "msg": "你好" } }));
    }
}
