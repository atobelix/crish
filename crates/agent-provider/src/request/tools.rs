//! 工具定义与 tool_choice（任务书 B2.6；02-provider-semantics.md §二.6:286-299）
//!
//! 对齐 `model:openai-request-build.ts` 的 toOpenAITool / toChatToolChoice /
//! toResponsesToolChoice / toResponsesTool。缺 schema 时兜底
//! `{type:'object',properties:{},additionalProperties:true}`（§二.6:292-296）。

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
pub fn to_openai_tool(tool: &ToolDefinition) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.effective_input_schema(),
        }
    })
}

/// toResponsesTool：Responses 工具形状（02 §二.6:301-313；strict:false）
pub fn to_responses_tool(tool: &ToolDefinition) -> Value {
    json!({
        "type": "function",
        "name": tool.name,
        "description": tool.description,
        "parameters": tool.effective_input_schema(),
        "strict": false,
    })
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
        ToolChoice::Function { name } => json!({ "type": "function", "function": { "name": name } }),
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

    fn tool(name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: format!("工具 {name} 的描述"),
            input_schema: json!({ "type": "object", "properties": { "msg": { "type": "string" } } }),
        }
    }

    #[test]
    fn openai_tool_shape() {
        let value = to_openai_tool(&tool("echo"));
        assert_eq!(value["type"], "function");
        assert_eq!(value["function"]["name"], "echo");
        assert_eq!(value["function"]["description"], "工具 echo 的描述");
        assert_eq!(
            value["function"]["parameters"],
            json!({ "type": "object", "properties": { "msg": { "type": "string" } } })
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
        assert!(value["parameters"].is_object());
    }

    #[test]
    fn chat_tool_choice_variants() {
        assert_eq!(to_chat_tool_choice(&ToolChoice::Auto), json!("auto"));
        assert_eq!(to_chat_tool_choice(&ToolChoice::None), json!("none"));
        assert_eq!(to_chat_tool_choice(&ToolChoice::Required), json!("required"));
        assert_eq!(
            to_chat_tool_choice(&ToolChoice::Function { name: "read_file".into() }),
            json!({ "type": "function", "function": { "name": "read_file" } })
        );
    }

    #[test]
    fn responses_tool_choice_variants() {
        assert_eq!(to_responses_tool_choice(&ToolChoice::Auto), json!("auto"));
        assert_eq!(
            to_responses_tool_choice(&ToolChoice::Function { name: "read_file".into() }),
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
}
