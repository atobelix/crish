//! 用户配置的规范类型：模型身份、供应商、能力与活动选择。
//! 读取与提交归一只经过 config_parse；字典不参与配置补全。

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

#[path = "config_parse.rs"]
mod config_parse;
#[path = "model_identity.rs"]
mod model_identity;
#[path = "model_pricing.rs"]
mod model_pricing;

pub use config_parse::YamlParseError;
pub use model_identity::ModelRef;
pub use model_pricing::{CurrencyKind, ModelPricingSpec, PricingTier, PricingUnit};

/// 配置文件的唯一根结构；活动选择与模型能力使用同一修订。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnifiedModelsConfig {
    #[serde(default = "default_config_version")]
    pub version: u32,
    #[serde(default)]
    pub providers: IndexMap<String, ProviderSpec>,
    /// 失效或禁用的选择在提交归一时清空；不查找替代模型。
    #[serde(default)]
    pub active_model: Option<ModelRef>,
}

pub fn default_config_version() -> u32 {
    2
}

impl Default for UnifiedModelsConfig {
    fn default() -> Self {
        Self {
            version: default_config_version(),
            providers: IndexMap::new(),
            active_model: None,
        }
    }
}

/// 供应商配置；凭据仅保留引用，不携带明文。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// dpapi:<不透明槽标识> 或 env:<显式变量名>；槽标识与供应商身份独立。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<IndexMap<String, String>>,
    #[serde(default = "default_protocol")]
    pub protocol: ProtocolKind,
    /// 是否使用流式响应；省略表示启用，显式 false 保留为非流请求。
    #[serde(default = "enabled_by_default")]
    pub stream: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<CompatSpec>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,
    #[serde(default)]
    pub models: Vec<ModelSpec>,
}

impl Default for ProviderSpec {
    fn default() -> Self {
        Self {
            display_name: None,
            base_url: None,
            api_key_ref: None,
            proxy_url: None,
            headers: None,
            protocol: default_protocol(),
            stream: true,
            compat: None,
            enabled: true,
            order: None,
            models: Vec::new(),
        }
    }
}

impl ProviderSpec {
    /// 精确查找；身份仅去首尾空白，不改大小写。
    pub fn find_model(&self, model_id: &str) -> Option<&ModelSpec> {
        let model_id = model_id.trim();
        self.models.iter().find(|model| model.id == model_id)
    }
}

fn enabled_by_default() -> bool {
    true
}

/// 默认供应商通信协议
pub fn default_protocol() -> ProtocolKind {
    ProtocolKind::OpenAiChat
}

/// 底层线网通信协议大类枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProtocolKind {
    /// 经典 OpenAI Chat Completions 协议 (/v1/chat/completions)
    #[serde(rename = "openai/chat")]
    OpenAiChat,
    /// OpenAI Responses 状态化协议 (/v1/responses)
    #[serde(rename = "openai/responses")]
    OpenAiResponses,
    /// Anthropic 原生 Messages 协议 (/v1/messages)
    #[serde(rename = "anthropic/messages")]
    AnthropicMessages,
    /// Google 原生 GenerateContent 协议 (/v1beta/models/{model}:streamGenerateContent)
    #[serde(rename = "google/generate-content")]
    GoogleGenerateContent,
}

impl Default for ProtocolKind {
    fn default() -> Self {
        default_protocol()
    }
}

impl ProtocolKind {
    /// 获取协议对应的 Wire 字符串标识
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenAiChat => "openai/chat",
            Self::OpenAiResponses => "openai/responses",
            Self::AnthropicMessages => "anthropic/messages",
            Self::GoogleGenerateContent => "google/generate-content",
        }
    }
}

/// 供应商及模型级兼容性矩阵与网关方言定义 (CompatSpec)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct CompatSpec {
    /// 思考/推理参数组装方言
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_format: Option<ThinkingFormat>,
    /// 是否支持 OpenAI 标准的 developer 角色。若为 false，内核自动降级为 system 角色
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_developer_role: Option<bool>,
    /// 生成长度限制的 Wire 字段名 (如 max_tokens vs max_completion_tokens)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens_field: Option<MaxTokensField>,
    /// 缓存断点控制注入格式
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control_format: Option<CacheControlFormat>,
    /// 是否要求工具参数使用严格结构，显式 false 必须覆盖供应商默认。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strict_json_schema: Option<bool>,
}

/// 思考参数 Wire 组装方言枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ThinkingFormat {
    /// OpenAI 标准 (reasoning_effort: "low" | "medium" | "high")
    #[serde(rename = "openai")]
    OpenAi,
    /// DeepSeek 原生方言 (thinking: { type: "enabled" | "disabled" })
    #[serde(rename = "deepseek")]
    DeepSeek,
    /// 阿里百炼方言 (enable_thinking: bool)
    #[serde(rename = "qwen")]
    Qwen,
    /// 智谱 BigModel 方言 (thinking: { type: "enable" })
    #[serde(rename = "zai")]
    Zai,
    /// Anthropic 原生方言 (thinking: { type: "enabled", budget_tokens: N })
    #[serde(rename = "anthropic")]
    Anthropic,
    /// Google 原生方言 (thinkingConfig: { thinkingLevel: ... })
    #[serde(rename = "gemini")]
    Gemini,
}

impl ThinkingFormat {
    /// 获取内核写出字面量（`google` / `qwen_enable_thinking` 只在读边界认一次）
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::DeepSeek => "deepseek",
            Self::Qwen => "qwen",
            Self::Zai => "zai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }
}

/// 生成上限字段定义枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MaxTokensField {
    #[serde(rename = "max_tokens")]
    MaxTokens,
    #[serde(rename = "max_completion_tokens")]
    MaxCompletionTokens,
}

/// 缓存控制注入格式枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CacheControlFormat {
    /// 明确关闭缓存，覆盖供应商级声明。
    #[serde(rename = "disabled")]
    Disabled,
    /// Anthropic 风格 (cache_control: { type: "ephemeral" })
    #[serde(rename = "anthropic")]
    Anthropic,
}

impl CompatSpec {
    /// 字段级继承的唯一入口：模型显式值覆盖供应商，false 不视为缺省。
    pub fn merge(provider: Option<&Self>, model: Option<&Self>) -> Option<Self> {
        if provider.is_none() && model.is_none() {
            return None;
        }
        Some(Self {
            thinking_format: model
                .and_then(|c| c.thinking_format)
                .or_else(|| provider.and_then(|c| c.thinking_format)),
            supports_developer_role: model
                .and_then(|c| c.supports_developer_role)
                .or_else(|| provider.and_then(|c| c.supports_developer_role)),
            max_tokens_field: model
                .and_then(|c| c.max_tokens_field)
                .or_else(|| provider.and_then(|c| c.max_tokens_field)),
            cache_control_format: model
                .and_then(|c| c.cache_control_format)
                .or_else(|| provider.and_then(|c| c.cache_control_format)),
            strict_json_schema: model
                .and_then(|c| c.strict_json_schema)
                .or_else(|| provider.and_then(|c| c.strict_json_schema)),
        })
    }
}

/// 模型配置只保存用户声明，不从名称推断能力。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelSpec {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// 模型级请求头覆盖，保留与供应商级 headers 不同的作用域。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<IndexMap<String, String>>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ProtocolKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<CompatSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modalities: Option<ModalitiesSpec>,
    /// 规范档位到 wire 字符串；键归一仅发生在配置读取/提交入口。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<IndexMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_tools: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_ttl: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ModelPricingSpec>,
}

impl Default for ModelSpec {
    fn default() -> Self {
        Self {
            id: String::new(),
            display_name: None,
            headers: None,
            enabled: true,
            order: None,
            context_window: None,
            max_output_tokens: None,
            protocol: None,
            compat: None,
            modalities: None,
            thinking: None,
            supports_tools: None,
            cache_ttl: None,
            pricing: None,
        }
    }
}

impl ModelSpec {
    pub fn effective_protocol(&self, provider: &ProviderSpec) -> ProtocolKind {
        self.protocol.unwrap_or(provider.protocol)
    }

    pub fn effective_compat(&self, provider: &ProviderSpec) -> Option<CompatSpec> {
        CompatSpec::merge(provider.compat.as_ref(), self.compat.as_ref())
    }

    pub fn supports_thinking(&self) -> bool {
        self.thinking.is_thinking_supported()
    }

    pub fn supports_image_input(&self) -> bool {
        self.modalities
            .as_ref()
            .is_some_and(|m| m.supports_input("image"))
    }
}

/// 输入与输出模态独立声明；空集合与未声明保持不同形态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModalitiesSpec {
    #[serde(default)]
    pub input: Vec<String>,
    #[serde(default)]
    pub output: Vec<String>,
}

impl ModalitiesSpec {
    pub fn text_only() -> Self {
        Self {
            input: vec!["text".into()],
            output: vec!["text".into()],
        }
    }

    pub fn multimodal_vision() -> Self {
        Self {
            input: vec!["text".into(), "image".into()],
            output: vec!["text".into()],
        }
    }

    pub fn supports_input(&self, modality: &str) -> bool {
        self.input.iter().any(|m| m.eq_ignore_ascii_case(modality))
    }

    pub fn supports_output(&self, modality: &str) -> bool {
        self.output.iter().any(|m| m.eq_ignore_ascii_case(modality))
    }
}

/// 规范思考配置的只读查询；别名不能在运行时再开第二条解析路径。
pub trait ThinkingMapExt {
    fn allows_off(&self) -> bool;
    fn get_wire_value(&self, title: &str) -> Option<&str>;
    fn available_titles(&self) -> Vec<&str>;
    fn is_thinking_supported(&self) -> bool;
}

impl ThinkingMapExt for Option<IndexMap<String, String>> {
    fn allows_off(&self) -> bool {
        self.as_ref().is_some_and(|map| map.contains_key("Off"))
    }

    fn get_wire_value(&self, title: &str) -> Option<&str> {
        self.as_ref()
            .and_then(|map| map.get(title).map(String::as_str))
    }

    fn available_titles(&self) -> Vec<&str> {
        self.as_ref()
            .map(|map| map.keys().map(String::as_str).collect())
            .unwrap_or_default()
    }

    fn is_thinking_supported(&self) -> bool {
        self.as_ref().is_some_and(|map| !map.is_empty())
    }
}

#[cfg(test)]
#[path = "catalog_types_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "config_contract_tests.rs"]
mod contract_tests;
