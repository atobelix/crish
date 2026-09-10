//! 2026 最新模型思考推理方言转换与出站历史消息清洗管线。
//! 严格落地 thinking 拍平 Key-Value 契约 (`IndexMap<String, String>`)。
//!
//! 核心设计契约：
//! 1. 纯英文白名单思考等级 `ReasoningEffort`（TitleCase 到 Wire 参数映射，无中文污染）；
//! 2. 四大主流思考方言装配器 `assemble_thinking_dialect`：
//!    - `OpenAiEffort`: 产生 `{"reasoning_effort": "<wire>"}`（必须是纯字符串，严禁数字！）；
//!    - `OpenAiResponsesNested`: 产生 `{"reasoning": {"effort": "<wire>"}}`；
//!    - `AnthropicBudget`: 产生 `{"thinking": {"type": "enabled", "budget_tokens": N}}`（N 来自
//!      用户字典 parse，≥1024；值为 `adaptive` → `{"type": "adaptive"}`）；
//!    - `DeepSeekNative`: `{"thinking": {"type": "enabled"|"disabled"}}`（map 值若是
//!      `enabled`/`disabled` 用字面，否则非 Off → enabled）；
//!    - `QwenBailianBoolean`: `{"enable_thinking": true|false}`（map 值 `"true"/"false"/"1"/"0"`
//!      解析，否则非 Off → true）；
//!    - `GeminiThinkingConfig`: 并入 `generationConfig.thinkingConfig.thinkingLevel`（map 值原样，
//!      数值字符串走 `thinkingBudget`）；
//! 3. wire 值只来自用户配置在 `ModelSpec.thinking` 中的拍平键值对映射
//!    （`thinking_map` 为 `Some` 时**只准**用 map 命中值；禁止 `to_openai_str` 折叠兜底；
//!    map 为 `None` → 不注入思考键，除 DeepSeek/Qwen 显式 Off → disabled/false）。
//! 4. 代理出站历史消息清洗 `sanitize_outbound_messages_for_proxy`：彻底剥离 assistant 中的
//!    Thought 块，防止第三方中转代理因未定义字段报 HTTP 400 错误。
//!
//! SSOT（轨A）：生产四轨思考键唯一入口 = [assemble_thinking_dialect]。
//! 旧兼容层 `build_reasoning_wire` / `resolve_wire_spelling_with_tiers` 已物理删除
//! （无生产调用者；模型级 wire 改名经 yaml thinking 字典 value 直达）。

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::request::vendor::{ReasoningEffort as LegacyReasoningEffort, ThinkingIntensity};

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};

/// 2026 标准化思考强度等级（纯英文白名单，无中文污染）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    #[serde(rename = "xhigh")]
    XHigh,
    Max,
}

impl Default for ReasoningEffort {
    fn default() -> Self {
        Self::Medium
    }
}

impl std::fmt::Display for ReasoningEffort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_title_case())
    }
}

impl ReasoningEffort {
    /// 解析 TitleCase 纯英文键（如 "Minimal", "Low", "Medium", "High", "X-High", "Max"）
    pub fn from_title_case(key: &str) -> Option<Self> {
        match key.trim() {
            "Off" | "off" | "None" | "none" | "Disabled" | "disabled" => Some(Self::Off),
            "Minimal" | "minimal" => Some(Self::Minimal),
            "Low" | "low" => Some(Self::Low),
            "Medium" | "medium" => Some(Self::Medium),
            "High" | "high" => Some(Self::High),
            "XHigh" | "xhigh" | "X-High" | "x-high" => Some(Self::XHigh),
            "Max" | "max" => Some(Self::Max),
            _ => None,
        }
    }

    /// 转换为标准 TitleCase 纯英文显示名
    pub fn to_title_case(&self) -> &'static str {
        match self {
            Self::Off => "Off",
            Self::Minimal => "Minimal",
            Self::Low => "Low",
            Self::Medium => "Medium",
            Self::High => "High",
            Self::XHigh => "X-High",
            Self::Max => "Max",
        }
    }

    /// 转换为纯小写字符串表示
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Max => "max",
        }
    }

    /// 转换为 OpenAI 标量字符串（严禁返回数字）
    pub fn to_openai_str(&self) -> Option<&'static str> {
        match self {
            Self::Off => None,
            Self::Minimal | Self::Low => Some("low"),
            Self::Medium => Some("medium"),
            Self::High | Self::XHigh | Self::Max => Some("high"),
        }
    }

    /// 转换为 Anthropic 预算 Token 数量（确保 >= 1024）
    pub fn to_anthropic_budget(&self) -> Option<u64> {
        match self {
            Self::Off => None,
            Self::Minimal => Some(1024),
            Self::Low => Some(2048),
            Self::Medium => Some(8192),
            Self::High => Some(16384),
            Self::XHigh => Some(32768),
            Self::Max => Some(64000),
        }
    }
}

impl From<LegacyReasoningEffort> for ReasoningEffort {
    fn from(legacy: LegacyReasoningEffort) -> Self {
        match legacy {
            LegacyReasoningEffort::Off => Self::Off,
            LegacyReasoningEffort::Auto | LegacyReasoningEffort::Medium => Self::Medium,
            LegacyReasoningEffort::Minimal => Self::Minimal,
            LegacyReasoningEffort::Low => Self::Low,
            LegacyReasoningEffort::High => Self::High,
            LegacyReasoningEffort::Xhigh => Self::XHigh,
            LegacyReasoningEffort::Max => Self::Max,
        }
    }
}

impl From<ThinkingIntensity> for ReasoningEffort {
    fn from(intensity: ThinkingIntensity) -> Self {
        match intensity {
            ThinkingIntensity::Off => Self::Off,
            ThinkingIntensity::Minimal => Self::Minimal,
            ThinkingIntensity::Low => Self::Low,
            ThinkingIntensity::Medium => Self::Medium,
            ThinkingIntensity::High => Self::High,
            ThinkingIntensity::Xhigh => Self::XHigh,
            ThinkingIntensity::Max => Self::Max,
        }
    }
}

/// 思考方言格式类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ThinkingDialectFormat {
    /// OpenAI 标准标量 (reasoning_effort: "<wire>")
    OpenAiEffort,
    /// OpenAI Responses 嵌套格式 (reasoning: { effort: "<wire>" })
    OpenAiResponsesNested,
    /// Anthropic 预算制格式 (thinking: { type: "enabled", budget_tokens: N })
    AnthropicBudget,
    /// DeepSeek 原生开关 (thinking: { type: "enabled" | "disabled" })
    DeepSeekNative,
    /// 阿里百炼顶层布尔 (enable_thinking: true | false)
    QwenBailianBoolean,
    /// Gemini 原生思考 (generationConfig.thinkingConfig.thinkingLevel / thinkingBudget)
    GeminiThinkingConfig,
}

impl From<crate::models::catalog_types::ThinkingFormat> for ThinkingDialectFormat {
    fn from(format: crate::models::catalog_types::ThinkingFormat) -> Self {
        match format {
            crate::models::catalog_types::ThinkingFormat::OpenAi => Self::OpenAiEffort,
            crate::models::catalog_types::ThinkingFormat::DeepSeek => Self::DeepSeekNative,
            crate::models::catalog_types::ThinkingFormat::Qwen => Self::QwenBailianBoolean,
            crate::models::catalog_types::ThinkingFormat::Zai => Self::DeepSeekNative,
            crate::models::catalog_types::ThinkingFormat::Anthropic => Self::AnthropicBudget,
            crate::models::catalog_types::ThinkingFormat::Gemini => Self::GeminiThinkingConfig,
        }
    }
}

/// 思考方言构建选项
#[derive(Debug, Clone)]
pub struct DialectBuildOptions<'a> {
    pub effort: ReasoningEffort,
    pub format: ThinkingDialectFormat,
    pub max_output_tokens: u64,
    /// 用户在 models.yaml 中配置的 thinking 拍平 Key-Value 字典映射
    pub thinking_map: Option<&'a IndexMap<String, String>>,
}

/// 组装思考方言 JSON 片段
///
/// 返回值：
/// - `Option<Value>`: 注入请求体的思考参数 JSON 对象
/// - `Option<u64>`: 建议自动向上抬升的 max_tokens（主要供 Anthropic 预算余量钳制使用）
///
/// 生产契约（plans/04 §2.3）：
/// - `thinking_map` 为 `Some`：wire 值**只准**来自 map 命中（TitleCase 键；
///   XHigh 兼容 `XHigh` / `X-High` 双拼写）。键未命中 → `(None, None)`
///   （fail-closed；非法档位在 validate 已拒，本函数不降级、不用
///   `to_openai_str` 当 map 的 fallback 键）。
/// - `thinking_map` 为 `None`：不注入思考键；唯一例外是 DeepSeek / Qwen 的
///   显式 Off → disabled / false（且仅当 format 已显式声明）。
pub fn assemble_thinking_dialect(opts: &DialectBuildOptions<'_>) -> (Option<Value>, Option<u64>) {
    if opts.effort == ReasoningEffort::Off {
        match opts.format {
            ThinkingDialectFormat::DeepSeekNative => {
                return (Some(json!({ "thinking": { "type": "disabled" } })), None);
            }
            ThinkingDialectFormat::QwenBailianBoolean => {
                return (Some(json!({ "enable_thinking": false })), None);
            }
            _ => return (None, None),
        }
    }

    // wire 值只来自用户字典（TitleCase 键；XHigh 兼容双拼写）。
    // 禁止 `.or_else(|| opts.effort.to_openai_str())` 折叠兜底。
    let custom_wire_val = opts.thinking_map.and_then(|map| {
        map.get(opts.effort.to_title_case())
            .or_else(|| {
                if opts.effort == ReasoningEffort::XHigh {
                    map.get("XHigh").or_else(|| map.get("X-High"))
                } else {
                    None
                }
            })
    });

    match opts.format {
        ThinkingDialectFormat::OpenAiEffort => {
            let Some(str_val) = custom_wire_val else {
                return (None, None);
            };
            (Some(json!({ "reasoning_effort": str_val })), None)
        }
        ThinkingDialectFormat::OpenAiResponsesNested => {
            let Some(str_val) = custom_wire_val else {
                return (None, None);
            };
            (Some(json!({ "reasoning": { "effort": str_val } })), None)
        }
        ThinkingDialectFormat::AnthropicBudget => {
            let Some(wire) = custom_wire_val else {
                return (None, None);
            };
            // 值为 adaptive → { type: "adaptive" }（Opus 4.7+ 新代际）
            if wire == "adaptive" {
                return (Some(json!({ "thinking": { "type": "adaptive" } })), None);
            }
            // 预算只来自用户字典数字（≥1024）；禁止 effort_to_budget_tokens 魔法刻度
            let Some(parsed_budget) = wire.parse::<u64>().ok() else {
                return (None, None);
            };
            let raw_budget = parsed_budget.max(1024);
            // 安全余量钳制：不能超过模型物理上限的一半，且至少预留 4096 tokens
            let max_cap = if opts.max_output_tokens > 0 {
                opts.max_output_tokens
            } else {
                64000
            };
            let safe_budget = raw_budget.min(max_cap.saturating_sub(4096)).max(1024);
            let elevated_max_tokens = safe_budget
                .saturating_add(4096)
                .min(max_cap.max(safe_budget + 4096));
            (
                Some(json!({
                    "thinking": {
                        "type": "enabled",
                        "budget_tokens": safe_budget
                    }
                })),
                Some(elevated_max_tokens),
            )
        }
        ThinkingDialectFormat::DeepSeekNative => {
            // map 值若是 enabled/disabled 用字面，否则非 Off → enabled
            let type_val: &str = match custom_wire_val.map(String::as_str) {
                Some("enabled") => "enabled",
                Some("disabled") => "disabled",
                _ => "enabled",
            };
            (Some(json!({ "thinking": { "type": type_val } })), None)
        }
        ThinkingDialectFormat::QwenBailianBoolean => {
            // map 值 "true"/"false"/"1"/"0" 解析，否则非 Off → true
            let enabled = match custom_wire_val.map(String::as_str) {
                Some("false") | Some("0") => false,
                _ => true,
            };
            (Some(json!({ "enable_thinking": enabled })), None)
        }
        ThinkingDialectFormat::GeminiThinkingConfig => {
            let Some(wire) = custom_wire_val else {
                return (None, None);
            };
            // map 值原样（"HIGH" / "high" / 用户自定义）；数值字符串走 thinkingBudget
            let thinking_config = if let Ok(budget) = wire.parse::<u64>() {
                json!({ "thinkingBudget": budget })
            } else {
                json!({ "thinkingLevel": wire })
            };
            (
                Some(json!({ "generationConfig": { "thinkingConfig": thinking_config } })),
                None,
            )
        }
    }
}

/// 出站历史消息清洗管线：剥离历史 Assistant 中的 Thought 块与 reasoning_content
/// 针对第三方中转网关，防止因为未定义字段报 400 Bad Request
pub fn sanitize_outbound_messages_for_proxy(messages: &mut [AgentMessage]) {
    for msg in messages.iter_mut() {
        if msg.role == AgentMessageRole::Assistant {
            // 过滤掉 Thought 块，仅保留 Text 与 ToolCall 块
            msg.blocks
                .retain(|b| !matches!(b, AgentMessageBlock::Thought { .. }));

            // 彻底清理 metadata 中残留的 thought 或 reasoning_content
            if let Some(Value::Object(map)) = &mut msg.metadata {
                map.remove("thought");
                map.remove("reasoning_content");
            }
        }
    }
}

/// 出站历史消息清洗管线（只读切片入参，返回全新克隆的清洗消息集合）
pub fn sanitize_outbound_messages(raw_messages: &[AgentMessage]) -> Vec<AgentMessage> {
    let mut cloned = raw_messages.to_vec();
    sanitize_outbound_messages_for_proxy(&mut cloned);
    cloned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reasoning_effort_conversions() {
        assert_eq!(
            ReasoningEffort::from_title_case("Off"),
            Some(ReasoningEffort::Off)
        );
        assert_eq!(
            ReasoningEffort::from_title_case("Minimal"),
            Some(ReasoningEffort::Minimal)
        );
        assert_eq!(
            ReasoningEffort::from_title_case("Low"),
            Some(ReasoningEffort::Low)
        );
        assert_eq!(
            ReasoningEffort::from_title_case("Medium"),
            Some(ReasoningEffort::Medium)
        );
        assert_eq!(
            ReasoningEffort::from_title_case("High"),
            Some(ReasoningEffort::High)
        );
        assert_eq!(
            ReasoningEffort::from_title_case("XHigh"),
            Some(ReasoningEffort::XHigh)
        );
        assert_eq!(
            ReasoningEffort::from_title_case("X-High"),
            Some(ReasoningEffort::XHigh)
        );
        assert_eq!(
            ReasoningEffort::from_title_case("Max"),
            Some(ReasoningEffort::Max)
        );
        assert_eq!(ReasoningEffort::from_title_case("Unknown"), None);

        assert_eq!(ReasoningEffort::Off.to_title_case(), "Off");
        assert_eq!(ReasoningEffort::High.to_title_case(), "High");
        assert_eq!(ReasoningEffort::XHigh.to_title_case(), "X-High");
        assert_eq!(ReasoningEffort::Max.to_title_case(), "Max");

        assert_eq!(ReasoningEffort::Off.to_openai_str(), None);
        assert_eq!(ReasoningEffort::Low.to_openai_str(), Some("low"));
        assert_eq!(ReasoningEffort::Medium.to_openai_str(), Some("medium"));
        assert_eq!(ReasoningEffort::High.to_openai_str(), Some("high"));
        assert_eq!(ReasoningEffort::Max.to_openai_str(), Some("high"));

        assert_eq!(ReasoningEffort::Off.to_anthropic_budget(), None);
        assert!(ReasoningEffort::Minimal.to_anthropic_budget().unwrap() >= 1024);
        assert_eq!(ReasoningEffort::Medium.to_anthropic_budget(), Some(8192));
    }

    #[test]
    fn test_openai_effort_never_produces_numbers() {
        let mut map = IndexMap::new();
        map.insert("High".to_string(), "high".to_string());
        let opts = DialectBuildOptions {
            effort: ReasoningEffort::High,
            format: ThinkingDialectFormat::OpenAiEffort,
            max_output_tokens: 65536,
            thinking_map: Some(&map),
        };
        let (val, _) = assemble_thinking_dialect(&opts);
        let unwrapped = val.unwrap();
        assert_eq!(unwrapped["reasoning_effort"], "high");
        assert!(unwrapped["reasoning_effort"].is_string());
    }

    #[test]
    fn test_openai_responses_nested() {
        let mut map = IndexMap::new();
        map.insert("Medium".to_string(), "medium".to_string());
        let opts = DialectBuildOptions {
            effort: ReasoningEffort::Medium,
            format: ThinkingDialectFormat::OpenAiResponsesNested,
            max_output_tokens: 65536,
            thinking_map: Some(&map),
        };
        let (val, _) = assemble_thinking_dialect(&opts);
        let unwrapped = val.unwrap();
        assert_eq!(unwrapped["reasoning"]["effort"], "medium");
        assert!(unwrapped["reasoning"]["effort"].is_string());
    }

    #[test]
    fn test_anthropic_budget_clamping() {
        // 预算只来自用户字典数字（≥1024）；钳制逻辑保持
        let mut map = IndexMap::new();
        map.insert("High".to_string(), "16384".to_string());
        let opts = DialectBuildOptions {
            effort: ReasoningEffort::High, // 字典 16384 tokens
            format: ThinkingDialectFormat::AnthropicBudget,
            max_output_tokens: 8192, // 模型物理上限较小
            thinking_map: Some(&map),
        };
        let (val, elevated_tokens) = assemble_thinking_dialect(&opts);
        let unwrapped = val.unwrap();
        let budget = unwrapped["thinking"]["budget_tokens"].as_u64().unwrap();
        assert!(budget >= 1024);
        // 预算受上限钳制：8192 - 4096 = 4096
        assert_eq!(budget, 4096);
        assert_eq!(elevated_tokens, Some(8192));
    }

    #[test]
    fn test_anthropic_budget_elevation_assertion_3_2() {
        let mut map = IndexMap::new();
        map.insert("Medium".to_string(), "8192".to_string());
        let opts = DialectBuildOptions {
            effort: ReasoningEffort::Medium, // 字典 8192 tokens
            format: ThinkingDialectFormat::AnthropicBudget,
            max_output_tokens: 65536,
            thinking_map: Some(&map),
        };
        let (val, elevated_tokens) = assemble_thinking_dialect(&opts);
        let unwrapped = val.unwrap();
        let budget = unwrapped["thinking"]["budget_tokens"].as_u64().unwrap();
        assert_eq!(budget, 8192);
        assert!(elevated_tokens.unwrap() >= 12288);
        assert_eq!(elevated_tokens, Some(12288));
    }

    #[test]
    fn test_anthropic_adaptive_from_map_value() {
        let mut map = IndexMap::new();
        map.insert("Max".to_string(), "adaptive".to_string());
        let opts = DialectBuildOptions {
            effort: ReasoningEffort::Max,
            format: ThinkingDialectFormat::AnthropicBudget,
            max_output_tokens: 65536,
            thinking_map: Some(&map),
        };
        let (val, _) = assemble_thinking_dialect(&opts);
        assert_eq!(val.unwrap()["thinking"]["type"], "adaptive");
    }

    #[test]
    fn test_gemini_thinking_config_preserves_map_literal() {
        // W7 语义：map 值原样进 thinkingConfig.thinkingLevel（"HIGH" 不折 "high"）
        let mut map = IndexMap::new();
        map.insert("High".to_string(), "HIGH".to_string());
        let opts = DialectBuildOptions {
            effort: ReasoningEffort::High,
            format: ThinkingDialectFormat::GeminiThinkingConfig,
            max_output_tokens: 65536,
            thinking_map: Some(&map),
        };
        let (val, _) = assemble_thinking_dialect(&opts);
        let unwrapped = val.unwrap();
        assert_eq!(
            unwrapped["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "HIGH"
        );
    }

    #[test]
    fn test_gemini_thinking_config_numeric_goes_budget() {
        let mut map = IndexMap::new();
        map.insert("High".to_string(), "16384".to_string());
        let opts = DialectBuildOptions {
            effort: ReasoningEffort::High,
            format: ThinkingDialectFormat::GeminiThinkingConfig,
            max_output_tokens: 65536,
            thinking_map: Some(&map),
        };
        let (val, _) = assemble_thinking_dialect(&opts);
        let unwrapped = val.unwrap();
        assert_eq!(
            unwrapped["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            16384
        );
    }

    #[test]
    fn test_map_miss_or_none_fails_closed_no_key() {
        // 字典有、当前 TitleCase 键缺 → (None, None)（validate 已拒；不降级）
        let mut map = IndexMap::new();
        map.insert("Low".to_string(), "low".to_string());
        let opts = DialectBuildOptions {
            effort: ReasoningEffort::High,
            format: ThinkingDialectFormat::OpenAiEffort,
            max_output_tokens: 65536,
            thinking_map: Some(&map),
        };
        assert_eq!(assemble_thinking_dialect(&opts), (None, None));

        // map 为 None → 不注入思考键（OpenAiEffort 等非开关方言）
        let no_map = DialectBuildOptions {
            effort: ReasoningEffort::High,
            format: ThinkingDialectFormat::OpenAiEffort,
            max_output_tokens: 65536,
            thinking_map: None,
        };
        assert_eq!(assemble_thinking_dialect(&no_map), (None, None));
    }

    #[test]
    fn test_deepseek_native_enabled_and_disabled() {
        let opts_on = DialectBuildOptions {
            effort: ReasoningEffort::Medium,
            format: ThinkingDialectFormat::DeepSeekNative,
            max_output_tokens: 65536,
            thinking_map: None,
        };
        let (val_on, _) = assemble_thinking_dialect(&opts_on);
        assert_eq!(val_on.unwrap()["thinking"]["type"], "enabled");

        let opts_off = DialectBuildOptions {
            effort: ReasoningEffort::Off,
            format: ThinkingDialectFormat::DeepSeekNative,
            max_output_tokens: 65536,
            thinking_map: None,
        };
        let (val_off, _) = assemble_thinking_dialect(&opts_off);
        assert_eq!(val_off.unwrap()["thinking"]["type"], "disabled");
    }

    #[test]
    fn test_qwen_bailian_boolean() {
        let opts_on = DialectBuildOptions {
            effort: ReasoningEffort::Medium,
            format: ThinkingDialectFormat::QwenBailianBoolean,
            max_output_tokens: 65536,
            thinking_map: None,
        };
        let (val_on, _) = assemble_thinking_dialect(&opts_on);
        assert_eq!(val_on.unwrap()["enable_thinking"], true);

        let opts_off = DialectBuildOptions {
            effort: ReasoningEffort::Off,
            format: ThinkingDialectFormat::QwenBailianBoolean,
            max_output_tokens: 65536,
            thinking_map: None,
        };
        let (val_off, _) = assemble_thinking_dialect(&opts_off);
        assert_eq!(val_off.unwrap()["enable_thinking"], false);
    }

    #[test]
    fn test_flattened_thinking_map_resolution() {
        let mut map = IndexMap::new();
        map.insert("Medium".to_string(), "custom-medium-wire".to_string());

        let opts = DialectBuildOptions {
            effort: ReasoningEffort::Medium,
            format: ThinkingDialectFormat::OpenAiEffort,
            max_output_tokens: 65536,
            thinking_map: Some(&map),
        };
        let (val, _) = assemble_thinking_dialect(&opts);
        let unwrapped = val.unwrap();
        assert_eq!(unwrapped["reasoning_effort"], "custom-medium-wire");
    }

    #[test]
    fn test_sanitize_outbound_messages_for_proxy() {
        use conex_types::message::ToolCallBlock;

        let mut messages = vec![
            AgentMessage {
                id: "msg-user-1".into(),
                role: AgentMessageRole::User,
                created_at: "2026-09-07T00:00:00Z".into(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "Hello".into(),
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            },
            AgentMessage {
                id: "msg-asst-1".into(),
                role: AgentMessageRole::Assistant,
                created_at: "2026-09-07T00:00:01Z".into(),
                blocks: vec![
                    AgentMessageBlock::Thought {
                        text: "Secret internal chain of thought...".into(),
                        redacted: None,
                    },
                    AgentMessageBlock::Text {
                        text: "Here is the response".into(),
                    },
                    AgentMessageBlock::ToolCall(ToolCallBlock {
                        id: "call_1".into(),
                        tool_name: "test_tool".into(),
                        input: json!({}),
                    }),
                ],
                metadata: Some(json!({
                    "thought": "Internal thought in metadata",
                    "reasoning_content": "Internal reasoning",
                    "other_field": 123
                })),
                client_message_id: None,
                content: None,
            },
        ];

        sanitize_outbound_messages_for_proxy(&mut messages);

        // User message must be untouched
        assert_eq!(messages[0].blocks.len(), 1);

        // Assistant message must have Thought blocks stripped
        let asst = &messages[1];
        assert_eq!(asst.blocks.len(), 2);
        assert!(asst
            .blocks
            .iter()
            .all(|b| !matches!(b, AgentMessageBlock::Thought { .. })));
        assert!(
            matches!(&asst.blocks[0], AgentMessageBlock::Text { text } if text == "Here is the response")
        );
        assert!(matches!(&asst.blocks[1], AgentMessageBlock::ToolCall(_)));

        // Metadata must have thought and reasoning_content stripped
        let meta = asst.metadata.as_ref().unwrap();
        assert!(meta.get("thought").is_none());
        assert!(meta.get("reasoning_content").is_none());
        assert_eq!(meta.get("other_field").unwrap(), 123);
    }
}
