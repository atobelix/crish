//! crates/agent-provider/src/request/vendor/dialect.rs
//!
//! 2026 最新模型思考推理方言转换与出站历史消息清洗管线。
//! 严格落地 thinking 拍平 Key-Value 契约 (`IndexMap<String, String>`)。
//!
//! 核心设计契约：
//! 1. 纯英文白名单思考等级 `ReasoningEffort`（TitleCase 到 Wire 参数映射，无中文污染）；
//! 2. 四大主流思考方言装配器 `assemble_thinking_dialect`：
//!    - `OpenAiEffort`: 产生 `{"reasoning_effort": "low"|"medium"|"high"}`（必须是纯字符串，严禁数字！）；
//!    - `OpenAiResponsesNested`: 产生 `{"reasoning": {"effort": str}}`；
//!    - `AnthropicBudget`: 产生 `{"thinking": {"type": "enabled", "budget_tokens": N}}`，保证预算 >= 1024，
//!      且自动安全余量钳制（建议 max_tokens 自动提升 +4096）；
//!    - `DeepSeekNative`: `{"thinking": {"type": "enabled"}}`（当 effort 为 Off 时为 `{"thinking": {"type": "disabled"}}`）；
//!    - `QwenBailianBoolean`: 产生 `{"enable_thinking": true|false}`；
//! 3. 优先读取用户配置在 `ModelSpec.thinking` 中的拍平键值对映射；
//! 4. 代理出站历史消息清洗 `sanitize_outbound_messages_for_proxy`：彻底剥离 assistant 中的 Thought 块，
//!    防止第三方中转代理因未定义字段报 HTTP 400 错误。
//!
//! 兼容层：保留历史 `build_reasoning_wire` 与 `resolve_wire_spelling_with_tiers` 契约，供既有调用链平滑演进。

#![allow(dead_code)]

use std::collections::BTreeMap;

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::reject::{DegradePolicy, ReasoningEffortState, ReasoningReject};
use super::vendor_wire::normalize_reasoning_effort;
use super::{
    ReasoningEffort as LegacyReasoningEffort, ReasoningFormat, ReasoningVendor, ThinkingCapability,
};
use crate::config::Endpoint;

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
            "Off" | "off" => Some(Self::Off),
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

/// 思考方言格式类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ThinkingDialectFormat {
    /// OpenAI 标准标量 (reasoning_effort: "low" | "medium" | "high")
    OpenAiEffort,
    /// OpenAI Responses 嵌套格式 (reasoning: { effort: "medium" })
    OpenAiResponsesNested,
    /// Anthropic 预算制格式 (thinking: { type: "enabled", budget_tokens: N })
    AnthropicBudget,
    /// DeepSeek 原生开关 (thinking: { type: "enabled" | "disabled" })
    DeepSeekNative,
    /// 阿里百炼顶层布尔 (enable_thinking: true | false)
    QwenBailianBoolean,
}

impl From<crate::models::catalog_types::ThinkingFormat> for ThinkingDialectFormat {
    fn from(format: crate::models::catalog_types::ThinkingFormat) -> Self {
        match format {
            crate::models::catalog_types::ThinkingFormat::OpenAi => Self::OpenAiEffort,
            crate::models::catalog_types::ThinkingFormat::DeepSeek => Self::DeepSeekNative,
            crate::models::catalog_types::ThinkingFormat::Qwen => Self::QwenBailianBoolean,
            crate::models::catalog_types::ThinkingFormat::Zai => Self::DeepSeekNative,
            crate::models::catalog_types::ThinkingFormat::Anthropic => Self::AnthropicBudget,
            crate::models::catalog_types::ThinkingFormat::Gemini => Self::OpenAiEffort,
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

    // 优先从用户自定义 thinking 拍平映射中获取 wire 字符串
    let custom_wire_val = opts.thinking_map.and_then(|map| {
        map.get(opts.effort.to_title_case())
            .or_else(|| {
                if opts.effort == ReasoningEffort::XHigh {
                    map.get("XHigh").or_else(|| map.get("X-High"))
                } else {
                    None
                }
            })
            .or_else(|| map.get(opts.effort.as_str()))
            .or_else(|| {
                opts.effort
                    .to_openai_str()
                    .and_then(|key| map.get(key))
            })
    });

    match opts.format {
        ThinkingDialectFormat::OpenAiEffort => {
            let str_val = custom_wire_val
                .map(|s| s.as_str())
                .or_else(|| opts.effort.to_openai_str())
                .unwrap_or("medium");
            (Some(json!({ "reasoning_effort": str_val })), None)
        }
        ThinkingDialectFormat::OpenAiResponsesNested => {
            let str_val = custom_wire_val
                .map(|s| s.as_str())
                .or_else(|| opts.effort.to_openai_str())
                .unwrap_or("medium");
            (Some(json!({ "reasoning": { "effort": str_val } })), None)
        }
        ThinkingDialectFormat::AnthropicBudget => {
            let parsed_custom_budget = custom_wire_val.and_then(|s| s.parse::<u64>().ok());
            let raw_budget = parsed_custom_budget
                .or_else(|| opts.effort.to_anthropic_budget())
                .unwrap_or(8192);
            // 安全余量钳制：不能超过模型物理上限的一半，且至少预留 4096 tokens
            let max_cap = if opts.max_output_tokens > 0 {
                opts.max_output_tokens
            } else {
                64000
            };
            let safe_budget = raw_budget
                .min(max_cap.saturating_sub(4096))
                .max(1024);
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
            (Some(json!({ "thinking": { "type": "enabled" } })), None)
        }
        ThinkingDialectFormat::QwenBailianBoolean => {
            (Some(json!({ "enable_thinking": true })), None)
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

// ── 兼容层：供既有 vendor.rs 调用的历史实现 ──

/// 模型级 wire 拼写改名（T4.2 / G6-a）：档位载体（档位 → Option<wire 拼写>）命中提供档
/// → 返回改名/同名 wire 拼写；隐藏档（None 值）与未收录档 → 回落系列级换算。
pub fn resolve_wire_spelling_with_tiers(
    effort: LegacyReasoningEffort,
    tiers: Option<&BTreeMap<String, Option<String>>>,
) -> Option<String> {
    if let Some(map) = tiers {
        if let Some(wire) = map.get(effort.as_str()) {
            return wire.clone();
        }
    }
    normalize_reasoning_effort(effort).map(str::to_owned)
}

/// 构建 vendor 原生思考 wire（R4 T4.1+T4.2+T4.5 一体化协调入口）。
pub fn build_reasoning_wire(
    endpoint: Endpoint,
    tiers: Option<&BTreeMap<String, Option<String>>>,
    effort: ReasoningEffortState,
    vendor: Option<ReasoningVendor>,
    capability: &ThinkingCapability,
    dialect: Option<ReasoningFormat>,
    policy: DegradePolicy,
) -> Result<Option<Value>, ReasoningReject> {
    // 0. deepseek 方言 off 显式 disabled：早退（无 effort wire）。
    if matches!(effort, ReasoningEffortState::Explicit(LegacyReasoningEffort::Off))
        && matches!(
            vocabulary_vendor(vendor, capability),
            ReasoningVendor::Deepseek
        )
    {
        return Ok(Some(json!({ "thinking": { "type": "disabled" } })));
    }

    // 1. T4.1 三态 → 待发送档位（拒绝/省略/降级收敛于此）。
    let active = match super::resolve_reasoning_level(effort, capability, policy)? {
        Some(level) => level,
        None => return Ok(None),
    };

    // 2. T4.2 模型级 wire 改名（未命中回落系列级）。
    let wire = resolve_wire_spelling_with_tiers(active, tiers)
        .ok_or_else(|| ReasoningReject::hidden_tier(active))?;

    // 3. T4.5 方言分派。
    let format = dialect.unwrap_or(capability.format);
    Ok(Some(dialect_wire(
        endpoint, active, &wire, capability, format,
    )))
}

fn dialect_wire(
    endpoint: Endpoint,
    effort: LegacyReasoningEffort,
    wire: &str,
    capability: &ThinkingCapability,
    format: ReasoningFormat,
) -> Value {
    use ReasoningFormat as F;
    match format {
        F::ReasoningEffort => {
            if capability.vendor == ReasoningVendor::Openai && endpoint == Endpoint::Responses {
                json!({ "reasoning": { "effort": wire } })
            } else {
                json!({ "reasoning_effort": wire })
            }
        }
        F::ThinkingBudget => json!({
            "thinking": { "type": "enabled", "budget_tokens": budget_for(effort) },
        }),
        F::ThinkingAdaptive => json!({
            "thinking": { "type": "adaptive", "display": "summarized" },
            "effort": super::adaptive_effort_wire(effort),
        }),
        F::ThinkingLevel => json!({
            "generation_config": { "thinking_level": level_for(effort) },
        }),
        F::QwenEnableThinking => {
            json!({ "enable_thinking": !matches!(effort, LegacyReasoningEffort::Off) })
        }
        F::ZaiThinking => json!({
            "thinking": { "type": "enabled", "clear_thinking": false },
            "reasoning_effort": wire,
        }),
        F::OpenRouterReasoning => json!({ "reasoning": { "effort": wire } }),
        F::None => json!({}),
    }
}

fn vocabulary_vendor(
    vendor: Option<ReasoningVendor>,
    capability: &ThinkingCapability,
) -> ReasoningVendor {
    vendor
        .filter(|v| *v != ReasoningVendor::Auto)
        .unwrap_or(capability.vendor)
}

fn budget_for(effort: LegacyReasoningEffort) -> u64 {
    super::effort_to_budget_tokens(effort)
}

fn level_for(effort: LegacyReasoningEffort) -> &'static str {
    super::effort_to_gemini_thinking_level(effort)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reasoning_effort_conversions() {
        assert_eq!(ReasoningEffort::from_title_case("Off"), Some(ReasoningEffort::Off));
        assert_eq!(ReasoningEffort::from_title_case("Minimal"), Some(ReasoningEffort::Minimal));
        assert_eq!(ReasoningEffort::from_title_case("Low"), Some(ReasoningEffort::Low));
        assert_eq!(ReasoningEffort::from_title_case("Medium"), Some(ReasoningEffort::Medium));
        assert_eq!(ReasoningEffort::from_title_case("High"), Some(ReasoningEffort::High));
        assert_eq!(ReasoningEffort::from_title_case("XHigh"), Some(ReasoningEffort::XHigh));
        assert_eq!(ReasoningEffort::from_title_case("X-High"), Some(ReasoningEffort::XHigh));
        assert_eq!(ReasoningEffort::from_title_case("Max"), Some(ReasoningEffort::Max));
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
        let opts = DialectBuildOptions {
            effort: ReasoningEffort::High,
            format: ThinkingDialectFormat::OpenAiEffort,
            max_output_tokens: 65536,
            thinking_map: None,
        };
        let (val, _) = assemble_thinking_dialect(&opts);
        let unwrapped = val.unwrap();
        assert_eq!(unwrapped["reasoning_effort"], "high");
        assert!(unwrapped["reasoning_effort"].is_string());
    }

    #[test]
    fn test_openai_responses_nested() {
        let opts = DialectBuildOptions {
            effort: ReasoningEffort::Medium,
            format: ThinkingDialectFormat::OpenAiResponsesNested,
            max_output_tokens: 65536,
            thinking_map: None,
        };
        let (val, _) = assemble_thinking_dialect(&opts);
        let unwrapped = val.unwrap();
        assert_eq!(unwrapped["reasoning"]["effort"], "medium");
        assert!(unwrapped["reasoning"]["effort"].is_string());
    }

    #[test]
    fn test_anthropic_budget_clamping() {
        let opts = DialectBuildOptions {
            effort: ReasoningEffort::High, // 请求 16384 tokens
            format: ThinkingDialectFormat::AnthropicBudget,
            max_output_tokens: 8192, // 模型物理上限较小
            thinking_map: None,
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
        let opts = DialectBuildOptions {
            effort: ReasoningEffort::Medium, // 8192 tokens
            format: ThinkingDialectFormat::AnthropicBudget,
            max_output_tokens: 65536,
            thinking_map: None,
        };
        let (val, elevated_tokens) = assemble_thinking_dialect(&opts);
        let unwrapped = val.unwrap();
        let budget = unwrapped["thinking"]["budget_tokens"].as_u64().unwrap();
        assert_eq!(budget, 8192);
        assert!(elevated_tokens.unwrap() >= 12288);
        assert_eq!(elevated_tokens, Some(12288));
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
        assert!(matches!(&asst.blocks[0], AgentMessageBlock::Text { text } if text == "Here is the response"));
        assert!(matches!(&asst.blocks[1], AgentMessageBlock::ToolCall(_)));

        // Metadata must have thought and reasoning_content stripped
        let meta = asst.metadata.as_ref().unwrap();
        assert!(meta.get("thought").is_none());
        assert!(meta.get("reasoning_content").is_none());
        assert_eq!(meta.get("other_field").unwrap(), 123);
    }
}
