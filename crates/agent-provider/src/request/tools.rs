//! 工具定义与 tool_choice（任务书 B2.6；02-provider-semantics.md §二.6:286-299）
//!
//! 对齐 `model:openai-request-build.ts` 的 toOpenAITool / toChatToolChoice /
//! toResponsesToolChoice / toResponsesTool。缺 schema 时兜底
//! `{type:'object',properties:{},additionalProperties:true}`（§二.6:292-296）。

use super::cache::cache_control_for_ttl;
use super::cache::TtlBucket;
use super::schema::canonicalize_schema;
use serde_json::{json, Value};

/// 工具定义（provider 请求层自持的声明面，与 agent-tools 的 ToolDefinition 形状一致；
/// 协议层不依赖工具执行面）
#[derive(Debug, Clone, PartialEq)]
pub struct ToolDefinition {
    /// 工具名（请求中作为 function.name）
    pub name: String,
    /// 人读描述
    pub description: String,
    /// 入参 JSON Schema；Null（缺省）时回退兜底形状
    pub input_schema: Value,
}

impl ToolDefinition {
    /// 有效入参 schema：Null 时回退 `{type:'object',properties:{},additionalProperties:true}`
    pub fn effective_input_schema(&self) -> Value {
        if self.input_schema.is_null() {
            default_input_schema()
        } else {
            self.input_schema.clone()
        }
    }
}

/// 缺失 schema 的兜底形状（02 §二.6:292-296）
pub fn default_input_schema() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": true })
}

/// toOpenAITool：ToolDefinition → OpenAI tools 格式（02 §二.6:286-299）
///
/// P1 A4：parameters 单点规范化（规则真源 P6 §3.1 R2）——`effective_input_schema`
/// 返回克隆（tools.rs:23-29），规范化在克隆上做，不污染注册表。
pub fn to_openai_tool(tool: &ToolDefinition) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": canonicalize_schema(&tool.effective_input_schema()),
        }
    })
}

/// toResponsesTool：Responses 工具形状（02 §二.6:301-313；strict:false）
///
/// P1 A4：与 to_openai_tool 同款规范化，防止 Responses 端点接入时漂移。
pub fn to_responses_tool(tool: &ToolDefinition) -> Value {
    json!({
        "type": "function",
        "name": tool.name,
        "description": tool.description,
        "parameters": canonicalize_schema(&tool.effective_input_schema()),
        "strict": false,
    })
}

/// 缓存感知的工具序列化（P2 步骤 3 / T-15）：to_openai_tool 基础上，
/// `ttl` 为 Some 时在工具对象顶层附加 `cache_control`（Anthropic 系断点）。
///
/// 断点值经 [cache_control_for_ttl] 映射（与消息级 apply_cache_controls 共用
/// 同一 TTL 桶 → 断点值转换，避免双实现漂移）；`None` 时输出与
/// to_openai_tool 逐字节一致（无缓存配置回归护栏）。
///
/// 附加位置约定：调用方（build.rs）只在**最后一个工具**传 Some（tools 层级
/// 锚点，对齐 jcode format_tools 只放最后工具，jcode-cache-analysis.md:53-59）；
/// 是否附加由能力表 supports_cache_control_on_tools 门控（plan.tools，
/// Fireworks 类拒绝未知字段的厂商不附加，pi-cache-analysis.md:314）。
pub fn to_cache_aware_tool(tool: &ToolDefinition, ttl: Option<TtlBucket>) -> Value {
    let mut value = to_openai_tool(tool);
    if let Some(ttl) = ttl {
        if let Some(obj) = value.as_object_mut() {
            obj.insert(
                "cache_control".to_string(),
                cache_control_for_ttl(ttl).to_value(),
            );
        }
    }
    value
}

/// tool_choice（对齐 OpenAICompatibleToolChoice：auto/none/required/指定函数）
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ToolChoice {
    /// 模型自行决定（默认）
    #[default]
    Auto,
    /// 不调用工具
    None,
    /// 必须调用工具
    Required,
    /// 指定函数
    Function { name: String },
}

/// toChatToolChoice（02 §二.6:272-277）
pub fn to_chat_tool_choice(choice: &ToolChoice) -> Value {
    match choice {
        ToolChoice::Auto => json!("auto"),
        ToolChoice::None => json!("none"),
        ToolChoice::Required => json!("required"),
        ToolChoice::Function { name } => {
            json!({ "type": "function", "function": { "name": name } })
        }
    }
}

/// toResponsesToolChoice（02 §二.6:279-284）
pub fn to_responses_tool_choice(choice: &ToolChoice) -> Value {
    match choice {
        ToolChoice::Auto => json!("auto"),
        ToolChoice::None => json!("none"),
        ToolChoice::Required => json!("required"),
        ToolChoice::Function { name } => json!({ "type": "function", "name": name }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::request::schema::canonical_json_string;

    /// 乱序输入 schema（P1 步骤 1.3：既有 shape 测试更新为期望规范化输出）
    fn tool(name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: format!("工具 {name} 的描述"),
            input_schema: json!({
                "required": ["msg", "zeta"],
                "type": "object",
                "properties": {
                    "zeta": { "type": "string" },
                    "msg": { "type": "string" },
                },
            }),
        }
    }

    /// 规范化后的参数字节（canonicalize_schema 产出 R2.9 键序对象；
    /// canonical_json_string / wire 序列化为键字典序 → 字典序字节）
    const CANONICAL_PARAMETERS_BYTES: &str = r#"{"properties":{"msg":{"type":"string"},"zeta":{"type":"string"}},"required":["msg","zeta"],"type":"object"}"#;

    #[test]
    fn openai_tool_shape() {
        let value = to_openai_tool(&tool("echo"));
        assert_eq!(value["type"], "function");
        assert_eq!(value["function"]["name"], "echo");
        assert_eq!(value["function"]["description"], "工具 echo 的描述");
        // parameters 为规范化字节（P1 步骤 1.3：shape 断言更新为规范化输出）
        assert_eq!(
            canonical_json_string(&value["function"]["parameters"]),
            CANONICAL_PARAMETERS_BYTES
        );
    }

    #[test]
    fn openai_tool_missing_schema_falls_back_to_default() {
        let tool = ToolDefinition {
            name: "noop".to_string(),
            description: "无 schema".to_string(),
            input_schema: Value::Null,
        };
        let value = to_openai_tool(&tool);
        assert_eq!(
            value["function"]["parameters"],
            json!({ "type": "object", "properties": {}, "additionalProperties": true })
        );
    }

    #[test]
    fn responses_tool_shape() {
        let value = to_responses_tool(&tool("echo"));
        assert_eq!(value["type"], "function");
        assert_eq!(value["name"], "echo");
        assert_eq!(value["strict"], false);
        // parameters 与 to_openai_tool 同款规范化字节
        assert_eq!(
            canonical_json_string(&value["parameters"]),
            CANONICAL_PARAMETERS_BYTES
        );
    }

    #[test]
    fn to_openai_tool_bytes_stable_across_calls() {
        // P1 E1：同一 ToolDefinition 两次 to_openai_tool → canonical 字节相等
        let tool = ToolDefinition {
            name: "search".to_string(),
            description: "搜索".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "b": { "const": 1 },
                    "a": { "required": ["x"], "type": "object" },
                },
            }),
        };
        let first = canonical_json_string(&to_openai_tool(&tool));
        let second = canonical_json_string(&to_openai_tool(&tool));
        assert_eq!(first, second);

        // 接线验证：parameters 字节 = canonicalize_schema(effective_input_schema())，
        // 且注册表 input_schema 不被污染（规范化在克隆上做）
        let wire = to_openai_tool(&tool);
        let raw = canonical_json_string(&tool.input_schema);
        assert_eq!(
            canonical_json_string(&wire["function"]["parameters"]),
            canonical_json_string(&canonicalize_schema(&tool.effective_input_schema()))
        );
        assert_ne!(
            canonical_json_string(&wire["function"]["parameters"]),
            raw,
            "乱序输入必须被规范化（字节变化）"
        );
        assert_eq!(
            canonical_json_string(&tool.input_schema),
            raw,
            "input_schema 不得被规范化污染"
        );
    }

    #[test]
    fn chat_tool_choice_variants() {
        assert_eq!(to_chat_tool_choice(&ToolChoice::Auto), json!("auto"));
        assert_eq!(to_chat_tool_choice(&ToolChoice::None), json!("none"));
        assert_eq!(
            to_chat_tool_choice(&ToolChoice::Required),
            json!("required")
        );
        assert_eq!(
            to_chat_tool_choice(&ToolChoice::Function {
                name: "read_file".into()
            }),
            json!({ "type": "function", "function": { "name": "read_file" } })
        );
    }

    #[test]
    fn responses_tool_choice_variants() {
        assert_eq!(to_responses_tool_choice(&ToolChoice::Auto), json!("auto"));
        assert_eq!(
            to_responses_tool_choice(&ToolChoice::Function {
                name: "read_file".into()
            }),
            json!({ "type": "function", "name": "read_file" })
        );
    }

    #[test]
    fn default_input_schema_shape() {
        assert_eq!(
            default_input_schema(),
            json!({ "type": "object", "properties": {}, "additionalProperties": true })
        );
    }

    // ── P2 步骤 3（T-15）：to_cache_aware_tool 工具级断点附加 ──

    #[test]
    fn cache_aware_tool_none_matches_openai_tool_bytes() {
        // ttl=None → 输出与 to_openai_tool 逐字节一致（无缓存回归护栏）
        let tool = tool("echo");
        assert_eq!(to_cache_aware_tool(&tool, None), to_openai_tool(&tool));
        assert!(to_cache_aware_tool(&tool, None)
            .get("cache_control")
            .is_none());
    }

    #[test]
    fn cache_aware_tool_some_attaches_cache_control() {
        // ttl=Some → 附加 cache_control（断点值经 cache_control_for_ttl 映射，
        // 与消息级断点同一 TTL 桶 → 断点值转换，避免双实现漂移）
        let tool = tool("echo");
        let value = to_cache_aware_tool(&tool, Some(TtlBucket::FiveMinutes));
        assert_eq!(
            value["cache_control"],
            json!({ "type": "ephemeral" }),
            "5m 桶 → ephemeral"
        );
        assert_eq!(value["function"]["name"], "echo");
        assert_eq!(value["type"], "function");
        assert_eq!(
            canonical_json_string(&value["function"]["parameters"]),
            CANONICAL_PARAMETERS_BYTES,
            "既有规范化字段不受附加影响"
        );

        let value = to_cache_aware_tool(&tool, Some(TtlBucket::OneHour));
        assert_eq!(
            value["cache_control"],
            json!({ "type": "ephemeral", "ttl": "1h" }),
            "1h 桶 → ephemeral + ttl"
        );
    }

    #[test]
    fn cache_aware_tool_attaches_at_top_level_object() {
        // cache_control 挂在工具对象顶层（非 function 内），对齐 Anthropic 系
        // tools[].cache_control wire 形态
        let value = to_cache_aware_tool(&tool("echo"), Some(TtlBucket::FiveMinutes));
        let obj = value.as_object().expect("工具对象");
        let keys: Vec<&String> = obj.keys().collect();
        assert!(
            keys.contains(&&"cache_control".to_string()),
            "顶层键：{keys:?}"
        );
        assert_eq!(
            obj.get("function").and_then(|v| v.get("cache_control")),
            None
        );
    }
}
