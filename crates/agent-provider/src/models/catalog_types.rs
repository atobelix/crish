//! catalog_types：统一供应商与模型能力强类型契约
//!
//! 本模块建立统一的树状强类型数据契约（Provider-Centric SSOT），
//! 为 Rust 内核接通 `~/.conex/models.yaml` 与前端 TypeScript 镜像提供坚实的类型基石。
//!
//! 核心设计契约：
//! 1. 树状拓扑：以 Provider 作为第一公民统辖 BaseURL、Protocol 与所属模型集合；
//! 2. 协议分级覆盖：模型级别协议（0.1% 异构场景）局部覆盖 Provider 默认协议；
//! 3. 思考能力彻底拍平：`Option<IndexMap<String, String>>` 纯英文 TitleCase 到 Wire 参数字典映射，无 `levels:` 嵌套；
//! 4. 多模态输入输出一等公民：`ModalitiesSpec` 声明输入与输出模态支持，绝不丢失；
//! 5. 四维双币独立单价：`ModelPricingSpec` 独立录入输入、输出、缓存读取、缓存写入价格，绝非固定打折；
//! 6. 对齐 TypeScript 镜像契约，全结构体使用 `#[serde(rename_all = "camelCase")]` 序列化。

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// 树状模型配置顶层绝对单一真源（SSOT）根结构
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedModelsConfig {
    /// 配置文件版本号，统一契约默认为 2
    #[serde(default = "default_config_version")]
    pub version: u32,
    /// 供应商映射字典，键为供应商机器可读标识符 (如 "deepseek", "anthropic", "openai")
    #[serde(default)]
    pub providers: IndexMap<String, ProviderSpec>,
}

/// 默认配置版本号（统一为 2）
pub fn default_config_version() -> u32 {
    2
}

impl Default for UnifiedModelsConfig {
    fn default() -> Self {
        Self {
            version: default_config_version(),
            providers: IndexMap::new(),
        }
    }
}

impl UnifiedModelsConfig {
    /// 根据供应商 ID 查找对应供应商规范
    pub fn find_provider(&self, provider_id: &str) -> Option<&ProviderSpec> {
        self.providers.get(provider_id)
    }

    /// 在指定供应商下查找模型规范
    pub fn find_model(&self, provider_id: &str, model_id: &str) -> Option<&ModelSpec> {
        self.find_provider(provider_id).and_then(|p| p.find_model(model_id))
    }

    /// 解析指定供应商与模型的最终生效通信协议
    pub fn effective_protocol(&self, provider_id: &str, model_id: &str) -> Option<ProtocolKind> {
        let provider = self.find_provider(provider_id)?;
        let model = provider.find_model(model_id)?;
        Some(model.effective_protocol(provider))
    }
}

/// 供应商主体规格定义 (Provider 作为第一公民)
/// 管理服务基地址、默认通信协议、鉴权凭据以及统辖的模型列表
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSpec {
    /// 供应商界面展示友好全称 (如 "DeepSeek", "Anthropic", "阿里云百炼")
    pub display_name: String,
    /// 供应商 API 服务基准地址 (如 "https://api.deepseek.com")
    pub base_url: String,
    /// 身份认证凭据，支持环境变量模板 (如 "$DEEPSEEK_API_KEY") 或字面量明文
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// 供应商全局默认通信协议，下属模型未显式声明时自动继承，默认 "openai/chat"
    #[serde(default = "default_protocol")]
    pub protocol: ProtocolKind,
    /// 供应商级通用方言兼容性与网关特性配置
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<CompatSpec>,
    /// 供应商统辖的模型列表
    #[serde(default)]
    pub models: Vec<ModelSpec>,
}

impl ProviderSpec {
    /// 在当前供应商下根据模型 ID 检索模型规范
    pub fn find_model(&self, model_id: &str) -> Option<&ModelSpec> {
        self.models.iter().find(|m| m.id == model_id)
    }
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
#[serde(rename_all = "camelCase", default)]
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
    /// Anthropic 风格 (cache_control: { type: "ephemeral" })
    #[serde(rename = "anthropic")]
    Anthropic,
}

/// 模型层级规范定义 (ModelSpec)
/// 依附于 ProviderSpec 存在，仅在关键属性存在异构特征时允许局部覆盖
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    /// 模型在 API Wire 中的真实调用代号 (如 "deepseek-v4-pro", "claude-3-7-sonnet-20250219")
    pub id: String,
    /// 模型在 UI、选择器与日志中的友好展示名
    pub display_name: String,
    /// 模型输入上下文最大容量 (Tokens)
    pub context_window: u64,
    /// 模型单次生成最大输出 Token 上限
    pub max_output_tokens: u64,
    /// 模型级协议显式局部覆盖项。若为 None，则强制继承 ProviderSpec.protocol
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ProtocolKind>,
    /// 多模态输入与输出能力规格（一等公民，绝不丢失）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modalities: Option<ModalitiesSpec>,
    /// 思考/推理能力扁平映射字典 (彻底拍平，无 levels: 冗余包装)。
    /// - None: 不支持思考模式 (UI 彻底折叠隐藏胶囊)
    /// - Some(IndexMap): Key 为前端 UI 纯英文 TitleCase (如 "Off", "Low", "Medium", "High", "Max")，
    ///   Value 为传递给 API Wire 的真实参数字符串 (如 "off", "low", "medium", "high")。
    ///   若字典中不包含 "Off"，天然代表强制思考，UI 自动剔除 Off 选项，零多余布尔值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<IndexMap<String, String>>,
    /// 模型四维独立单价计量规格。选填，未配置时系统静默跳过费用核算
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ModelPricingSpec>,
}

impl ModelSpec {
    /// 获取该模型的最终生效通信协议（优先模型局部覆盖，缺省继承 Provider 协议）
    pub fn effective_protocol(&self, provider: &ProviderSpec) -> ProtocolKind {
        self.protocol.unwrap_or(provider.protocol)
    }

    /// 判断模型是否支持思考能力
    pub fn supports_thinking(&self) -> bool {
        self.thinking.is_some()
    }

    /// 判断模型是否支持多模态图片输入
    pub fn supports_image_input(&self) -> bool {
        self.modalities.as_ref().map(|m| m.supports_input("image")).unwrap_or(false)
    }
}

/// 多模态能力规格声明 (ModalitiesSpec)
/// 作为模型的一等公民，明确区分输入与输出能力维度
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModalitiesSpec {
    /// 输入模态列表 (如 "text", "image", "audio", "video", "file")
    #[serde(default)]
    pub input: Vec<String>,
    /// 输出模态列表 (如 "text", "image", "audio")
    #[serde(default)]
    pub output: Vec<String>,
}

impl ModalitiesSpec {
    /// 构造仅纯文本出入的默认规格
    pub fn text_only() -> Self {
        Self {
            input: vec!["text".to_string()],
            output: vec!["text".to_string()],
        }
    }

    /// 构造支持图文多模态输入的标准规格
    pub fn multimodal_vision() -> Self {
        Self {
            input: vec!["text".to_string(), "image".to_string()],
            output: vec!["text".to_string()],
        }
    }

    /// 检查是否支持特定输入模态
    pub fn supports_input(&self, modality: &str) -> bool {
        self.input.iter().any(|m| m.eq_ignore_ascii_case(modality))
    }

    /// 检查是否支持特定输出模态
    pub fn supports_output(&self, modality: &str) -> bool {
        self.output.iter().any(|m| m.eq_ignore_ascii_case(modality))
    }
}

/// 结算货币种类强类型定义
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CurrencyKind {
    /// 人民币结算 (¥)
    #[serde(rename = "CNY")]
    Cny,
    /// 美元结算 ($)
    #[serde(rename = "USD")]
    Usd,
}

impl Default for CurrencyKind {
    fn default() -> Self {
        Self::Usd
    }
}

impl CurrencyKind {
    /// 获取货币符号
    pub fn symbol(&self) -> &'static str {
        match self {
            Self::Cny => "¥",
            Self::Usd => "$",
        }
    }

    /// 获取 ISO 4217 货币代码
    pub fn code(&self) -> &'static str {
        match self {
            Self::Cny => "CNY",
            Self::Usd => "USD",
        }
    }
}

/// 四维双币独立单价计量契约 (ModelPricingSpec)
/// 严格四指标：输入、输出、缓存读取、缓存写入，全选填且价格完全独立，绝非固定一折
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricingSpec {
    /// 结算货币类型 (CNY / USD)
    pub currency: CurrencyKind,
    /// 基础普通提示词输入单价 (元/1M Tokens 或 $/1M Tokens)
    pub input: f64,
    /// 生成补全输出单价 (元/1M Tokens 或 $/1M Tokens)
    pub output: f64,
    /// 提示词上下文缓存命中读取独立单价 (Cache Read / Hit)，绝非固定一折
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    /// 提示词上下文缓存创建写入独立单价 (Cache Write / Creation)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
    /// 独立按生成张数计费 (针对生图模型)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_image: Option<f64>,
}

impl ModelPricingSpec {
    /// 基于独立的四维单价计算用量真实费用（元或美元，按每百万 Tokens 比例换算）
    pub fn calculate_cost(
        &self,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
    ) -> f64 {
        let mut total = 0.0;
        total += (input_tokens as f64 / 1_000_000.0) * self.input;
        total += (output_tokens as f64 / 1_000_000.0) * self.output;

        if let Some(cache_read_price) = self.cache_read {
            total += (cache_read_tokens as f64 / 1_000_000.0) * cache_read_price;
        }
        if let Some(cache_write_price) = self.cache_write {
            total += (cache_write_tokens as f64 / 1_000_000.0) * cache_write_price;
        }

        total
    }
}

/// 针对扁平思考字典 Option<IndexMap<String, String>> 的业务扩展 Trait
pub trait ThinkingMapExt {
    /// 判断是否允许用户手动关闭思考 (即字典中是否显式配置了 "Off" 键)
    fn allows_off(&self) -> bool;
    /// 根据前端纯英文 TitleCase 显示名获取对应的 Wire 参数值
    fn get_wire_value(&self, title: &str) -> Option<&str>;
    /// 获取所有支持的纯英文档位 Title 列表 (保持物理配置顺序)
    fn available_titles(&self) -> Vec<&str>;
    /// 是否存在思考能力配置
    fn is_thinking_supported(&self) -> bool;
}

impl ThinkingMapExt for Option<IndexMap<String, String>> {
    fn allows_off(&self) -> bool {
        match self {
            Some(map) => map.contains_key("Off"),
            None => false,
        }
    }

    fn get_wire_value(&self, title: &str) -> Option<&str> {
        self.as_ref().and_then(|m| m.get(title).map(|s| s.as_str()))
    }

    fn available_titles(&self) -> Vec<&str> {
        match self {
            Some(map) => map.keys().map(|k| k.as_str()).collect(),
            None => Vec::new(),
        }
    }

    fn is_thinking_supported(&self) -> bool {
        self.as_ref().map(|m| !m.is_empty()).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unified_models_config_serde_json() {
        let json_data = r#"{
            "version": 2,
            "providers": {
                "deepseek": {
                    "displayName": "DeepSeek",
                    "baseUrl": "https://api.deepseek.com",
                    "apiKey": "$DEEPSEEK_API_KEY",
                    "protocol": "openai/chat",
                    "compat": {
                        "thinkingFormat": "deepseek",
                        "supportsDeveloperRole": false,
                        "maxTokensField": "max_tokens"
                    },
                    "models": [
                        {
                            "id": "deepseek-v4-pro",
                            "displayName": "DeepSeek V4 Pro",
                            "contextWindow": 1048576,
                            "maxOutputTokens": 384000,
                            "modalities": {
                                "input": ["text", "image"],
                                "output": ["text"]
                            },
                            "thinking": {
                                "Low": "low",
                                "Medium": "medium",
                                "High": "high"
                            },
                            "pricing": {
                                "currency": "CNY",
                                "input": 3.0,
                                "output": 9.0,
                                "cacheRead": 0.1,
                                "cacheWrite": 0.0
                            }
                        }
                    ]
                }
            }
        }"#;

        let config: UnifiedModelsConfig = serde_json::from_str(json_data).expect("反序列化 UnifiedModelsConfig 必须成功");
        assert_eq!(config.version, 2);
        assert_eq!(config.providers.len(), 1);

        let provider = config.find_provider("deepseek").expect("应能查找到 deepseek");
        assert_eq!(provider.display_name, "DeepSeek");
        assert_eq!(provider.protocol, ProtocolKind::OpenAiChat);
        assert_eq!(provider.api_key.as_deref(), Some("$DEEPSEEK_API_KEY"));

        let model = provider.find_model("deepseek-v4-pro").expect("应能查找到 deepseek-v4-pro");
        assert_eq!(model.display_name, "DeepSeek V4 Pro");
        assert_eq!(model.context_window, 1048576);
        assert_eq!(model.max_output_tokens, 384000);

        // modalities 一等公民断言
        let modalities = model.modalities.as_ref().expect("modalities 必须存在");
        assert!(modalities.supports_input("text"));
        assert!(modalities.supports_input("image"));
        assert!(!modalities.supports_input("audio"));
        assert!(modalities.supports_output("text"));
        assert!(!modalities.supports_output("image"));
        assert!(model.supports_image_input());

        // 拍平 thinking 验证 (无 levels 包装)
        assert!(model.supports_thinking());
        assert_eq!(model.thinking.available_titles(), vec!["Low", "Medium", "High"]);
        assert_eq!(model.thinking.get_wire_value("Low"), Some("low"));
        assert_eq!(model.thinking.get_wire_value("Medium"), Some("medium"));
        assert_eq!(model.thinking.get_wire_value("High"), Some("high"));
        assert_eq!(model.thinking.get_wire_value("Off"), None);
        assert!(!model.thinking.allows_off()); // 强制思考：无 "Off" 键

        // 四维独立价格验证
        let pricing = model.pricing.as_ref().expect("pricing 必须存在");
        assert_eq!(pricing.currency, CurrencyKind::Cny);
        assert_eq!(pricing.currency.symbol(), "¥");
        assert_eq!(pricing.input, 3.0);
        assert_eq!(pricing.output, 9.0);
        assert_eq!(pricing.cache_read, Some(0.1));
        assert_eq!(pricing.cache_write, Some(0.0));

        // 独立单价算费验证 (绝非固定一折)
        let cost = pricing.calculate_cost(1_000_000, 500_000, 2_000_000, 100_000);
        // input: 1M * 3.0 = 3.0
        // output: 0.5M * 9.0 = 4.5
        // cache_read: 2M * 0.1 = 0.2
        // cache_write: 0.1M * 0.0 = 0.0
        // total: 7.7
        assert!((cost - 7.7).abs() < 1e-6);

        // 协议继承验证
        assert_eq!(model.effective_protocol(provider), ProtocolKind::OpenAiChat);
        assert_eq!(config.effective_protocol("deepseek", "deepseek-v4-pro"), Some(ProtocolKind::OpenAiChat));

        // 重新序列化测试
        let serialized = serde_json::to_string_pretty(&config).expect("序列化必须成功");
        assert!(serialized.contains("\"displayName\": \"DeepSeek\""));
        assert!(serialized.contains("\"cacheRead\": 0.1"));
        assert!(!serialized.contains("\"levels\""));
    }

    #[test]
    fn test_thinking_with_off_and_protocol_override() {
        let json_data = r#"{
            "id": "gpt-5.6-sol",
            "displayName": "GPT-5.6 Sol",
            "protocol": "openai/responses",
            "contextWindow": 1050000,
            "maxOutputTokens": 128000,
            "thinking": {
                "Off": "off",
                "Low": "low",
                "High": "high"
            }
        }"#;

        let model: ModelSpec = serde_json::from_str(json_data).expect("反序列化 ModelSpec 必须成功");
        assert_eq!(model.protocol, Some(ProtocolKind::OpenAiResponses));
        assert!(model.thinking.allows_off());
        assert_eq!(model.thinking.get_wire_value("Off"), Some("off"));
        assert_eq!(model.thinking.get_wire_value("High"), Some("high"));

        let provider = ProviderSpec {
            display_name: "OpenAI".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: None,
            protocol: ProtocolKind::OpenAiChat,
            compat: None,
            models: vec![model.clone()],
        };

        // 模型局部协议覆盖生效
        assert_eq!(model.effective_protocol(&provider), ProtocolKind::OpenAiResponses);
    }
}
