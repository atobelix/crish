//! vendor 机制与思考透传（任务书 B2.6；02-provider-semantics.md §五 #2/#3、§一.4；01 D5）
//!
//! - [infer_reasoning_vendor]：baseUrl/model 关键字推断（02 §五 #2 取 model 行为）
//! - [reasoning_effort_object]：vendor 分支生成原生 reasoning 字段（§五 #2）
//! - [reasoning_effort_headers]：anthropic-beta 头（仅 vendor=anthropic 且 effort 非 off/auto，§五 #3）
//! - thinkingIntensity 透传（01 D5）：能力推断 → 归一化 → vendor 原生参数
//!   （resolveThinkingParams，对齐 `shared:thinking-intensity.ts` 单一真源）
//! - G7 自适应思考（模型目录 v2）：Opus 4.7+ / Sonnet 5+（含 Fable/Mythos 5 与
//!   SAP 倒置形态）按模型系列前缀切 `thinking{type:"adaptive",display:"summarized"}`
//!   + 顶层 `effort`；display 强制 summarized 保证思考摘要存活——新版默认 omitted
//!     会吐空 thinking 块，块内容漂移破坏缓存前缀（对齐 opencode transform.ts:791-794）

use serde_json::{json, Value};

use crate::config::Endpoint;

/// reasoning vendor（对齐 `shared:thinking-intensity.ts` 的 ReasoningVendor）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReasoningVendor {
    Openai,
    Anthropic,
    Deepseek,
    Gemini,
    Qwen,
    Glm,
    Kimi,
    /// 未显式指定：按 endpoint/format 推断退化（02 §五 #2）
    #[default]
    Auto,
}

impl ReasoningVendor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Deepseek => "deepseek",
            Self::Gemini => "gemini",
            Self::Qwen => "qwen",
            Self::Glm => "glm",
            Self::Kimi => "kimi",
            Self::Auto => "auto",
        }
    }
}

/// reasoning effort（对齐 OpenAICompatibleReasoningEffort）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReasoningEffort {
    /// 关闭思考参数
    Off,
    #[default]
    Auto,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    /// 最高档位（Opus 4.7+/Sonnet 5+ 自适应思考、DeepSeek/Kimi 官方语义均含）
    Max,
}

impl ReasoningEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Auto => "auto",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

/// reasoningEffortFormat（auto/responses/chat-completions/none）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReasoningEffortFormat {
    /// 按 endpoint 推断（保持向后兼容）
    #[default]
    Auto,
    Responses,
    ChatCompletions,
    /// 不发送任何 reasoning 参数
    None,
}

/// thinking 强度档位（对齐 ThinkingIntensity；01 D5 透传）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThinkingIntensity {
    /// 关闭思考
    #[default]
    Off,
    Minimal,
    Low,
    Medium,
    High,
    /// 仅 Anthropic 系支持（OpenAI/Gemini 降级为 high）
    Xhigh,
    /// 最高档位（Anthropic 自适应思考；OpenAI/Gemini 降级为 high）
    Max,
}

impl ThinkingIntensity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

/// 推理参数格式（对齐 ReasoningFormat）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasoningFormat {
    /// OpenAI/DeepSeek/Qwen/GLM/Kimi：reasoning.effort 或 reasoning_effort
    ReasoningEffort,
    /// Anthropic：thinking.budget_tokens
    ThinkingBudget,
    /// Anthropic 自适应思考（Opus 4.7+ 等新代际）：
    /// thinking{type:"adaptive",display:"summarized"} + 顶层 effort
    ThinkingAdaptive,
    /// Gemini：generation_config.thinking_level
    ThinkingLevel,
    /// 不支持思考
    None,
}

/// 模型思考能力声明（对齐 ThinkingCapability）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThinkingCapability {
    pub supported: bool,
    /// 支持档位（不含 Off）
    pub levels: &'static [ThinkingIntensity],
    pub format: ReasoningFormat,
    pub vendor: ReasoningVendor,
}

/// 不支持思考的默认能力声明
pub const NO_THINKING: ThinkingCapability = ThinkingCapability {
    supported: false,
    levels: &[],
    format: ReasoningFormat::None,
    vendor: ReasoningVendor::Auto,
};

// ── 模型系列能力映射表（对齐 shared:thinking-intensity.ts:80-127，最长前缀命中）──

const LEVELS_FULL: &[ThinkingIntensity] = &[
    ThinkingIntensity::Minimal,
    ThinkingIntensity::Low,
    ThinkingIntensity::Medium,
    ThinkingIntensity::High,
    ThinkingIntensity::Xhigh,
];
const LEVELS_NO_XHIGH: &[ThinkingIntensity] = &[
    ThinkingIntensity::Minimal,
    ThinkingIntensity::Low,
    ThinkingIntensity::Medium,
    ThinkingIntensity::High,
];
const LEVELS_NO_MINIMAL: &[ThinkingIntensity] = &[
    ThinkingIntensity::Low,
    ThinkingIntensity::Medium,
    ThinkingIntensity::High,
];

/// Anthropic 自适应思考档位（对齐 opencode anthropicAdaptiveEfforts：
/// [low,medium,high,xhigh,max]；无 minimal）
const LEVELS_ADAPTIVE: &[ThinkingIntensity] = &[
    ThinkingIntensity::Low,
    ThinkingIntensity::Medium,
    ThinkingIntensity::High,
    ThinkingIntensity::Xhigh,
    ThinkingIntensity::Max,
];

const OPENAI_REASONING: ThinkingCapability = ThinkingCapability {
    supported: true,
    levels: LEVELS_NO_XHIGH,
    format: ReasoningFormat::ReasoningEffort,
    vendor: ReasoningVendor::Openai,
};
const OPENAI_O1: ThinkingCapability = ThinkingCapability {
    supported: true,
    levels: LEVELS_NO_MINIMAL,
    format: ReasoningFormat::ReasoningEffort,
    vendor: ReasoningVendor::Openai,
};
const ANTHROPIC_REASONING: ThinkingCapability = ThinkingCapability {
    supported: true,
    levels: LEVELS_FULL,
    format: ReasoningFormat::ThinkingBudget,
    vendor: ReasoningVendor::Anthropic,
};
const ANTHROPIC_NO_XHIGH: ThinkingCapability = ThinkingCapability {
    supported: true,
    levels: LEVELS_NO_XHIGH,
    format: ReasoningFormat::ThinkingBudget,
    vendor: ReasoningVendor::Anthropic,
};
/// Anthropic 自适应思考（Opus 4.7+ / Sonnet 5+ 等新代际）：
/// thinking{type:"adaptive",display:"summarized"} + effort（G7）
const ANTHROPIC_ADAPTIVE: ThinkingCapability = ThinkingCapability {
    supported: true,
    levels: LEVELS_ADAPTIVE,
    format: ReasoningFormat::ThinkingAdaptive,
    vendor: ReasoningVendor::Anthropic,
};
const GEMINI_REASONING: ThinkingCapability = ThinkingCapability {
    supported: true,
    levels: LEVELS_NO_XHIGH,
    format: ReasoningFormat::ThinkingLevel,
    vendor: ReasoningVendor::Gemini,
};
const DEEPSEEK_REASONING: ThinkingCapability = ThinkingCapability {
    supported: true,
    levels: LEVELS_NO_MINIMAL,
    format: ReasoningFormat::ReasoningEffort,
    vendor: ReasoningVendor::Deepseek,
};
const QWEN_REASONING: ThinkingCapability = ThinkingCapability {
    supported: true,
    levels: LEVELS_NO_MINIMAL,
    format: ReasoningFormat::ReasoningEffort,
    vendor: ReasoningVendor::Qwen,
};
const GLM_REASONING: ThinkingCapability = ThinkingCapability {
    supported: true,
    levels: LEVELS_NO_MINIMAL,
    format: ReasoningFormat::ReasoningEffort,
    vendor: ReasoningVendor::Glm,
};
const KIMI_REASONING: ThinkingCapability = ThinkingCapability {
    supported: true,
    levels: LEVELS_NO_MINIMAL,
    format: ReasoningFormat::ReasoningEffort,
    vendor: ReasoningVendor::Kimi,
};

/// 匹配规则：model 名前缀（不区分大小写）命中，取最长前缀（对齐
/// `shared:thinking-intensity.ts:80-127` 的 MODEL_SERIES_CAPABILITIES）
static MODEL_SERIES_CAPABILITIES: &[(&str, ThinkingCapability)] = &[
    // ── OpenAI ──
    ("gpt-5.", OPENAI_REASONING),
    ("gpt-5", OPENAI_REASONING),
    ("o4-", OPENAI_REASONING),
    ("o3-", OPENAI_REASONING),
    ("o3", OPENAI_REASONING),
    ("o1-", OPENAI_O1),
    ("o1", OPENAI_O1),
    ("gpt-4o", NO_THINKING),
    ("gpt-4.1", NO_THINKING),
    ("gpt-4", NO_THINKING),
    // ── Anthropic Claude ──
    // 新代际自适应思考（G7：Opus 4.7+ / Sonnet 5+ / Fable 5 / Mythos 5；
    // "claude-4-7"/"claude-4-8" 兼容 SAP 倒置形态 claude-4-7-opus 等，最长前缀
    // 命中优先于 "claude-4"）
    ("claude-opus-4-7", ANTHROPIC_ADAPTIVE),
    ("claude-opus-4-8", ANTHROPIC_ADAPTIVE),
    ("claude-opus-5", ANTHROPIC_ADAPTIVE),
    ("claude-sonnet-5", ANTHROPIC_ADAPTIVE),
    ("claude-fable-5", ANTHROPIC_ADAPTIVE),
    ("claude-mythos-5", ANTHROPIC_ADAPTIVE),
    ("claude-4-7", ANTHROPIC_ADAPTIVE),
    ("claude-4-8", ANTHROPIC_ADAPTIVE),
    // 旧代际保持既有映射（enabled+budget_tokens）
    ("claude-opus-4", ANTHROPIC_REASONING),
    ("claude-sonnet-4", ANTHROPIC_REASONING),
    ("claude-4", ANTHROPIC_REASONING),
    ("claude-3-7", ANTHROPIC_NO_XHIGH),
    ("claude-3-5", NO_THINKING),
    ("claude-3", NO_THINKING),
    // ── Google Gemini ──
    ("gemini-3", GEMINI_REASONING),
    ("gemini-2.5", GEMINI_REASONING),
    ("gemini-2.0", NO_THINKING),
    ("gemini-1.5", NO_THINKING),
    // ── DeepSeek ──
    ("deepseek-reasoner", DEEPSEEK_REASONING),
    ("deepseek-v4", DEEPSEEK_REASONING),
    ("deepseek-r1", DEEPSEEK_REASONING),
    ("deepseek-chat", NO_THINKING),
    ("deepseek", NO_THINKING),
    // ── Qwen / GLM / Kimi ──
    ("qwen3", QWEN_REASONING),
    ("qwen-3", QWEN_REASONING),
    ("qwen", NO_THINKING),
    ("glm-5", GLM_REASONING),
    ("glm", NO_THINKING),
    ("kimi-2.5", KIMI_REASONING),
    ("kimi", NO_THINKING),
];

/// 推断模型思考能力（最长前缀命中；未命中 → [NO_THINKING]）
pub fn infer_thinking_capability(model: &str) -> ThinkingCapability {
    let lower = model.to_ascii_lowercase();
    let mut best: Option<&(&str, ThinkingCapability)> = None;
    for entry in MODEL_SERIES_CAPABILITIES {
        if lower.starts_with(entry.0)
            && best.is_none_or(|current| entry.0.len() > current.0.len())
        {
            best = Some(entry);
        }
    }
    best.map_or(NO_THINKING, |entry| entry.1)
}

/// 推断 reasoning vendor（对齐 `shared:thinking-intensity.ts:154-173`；02 §五 #2）
///
/// 优先级 baseUrl 关键字 → model 前缀：anthropic/claude、deepseek、gemini、
/// openai/gpt/o1/o3/o4、qwen、glm、kimi；未命中 → auto（按 endpoint/format 退化）。
pub fn infer_reasoning_vendor(base_url: Option<&str>, model: Option<&str>) -> ReasoningVendor {
    let url = base_url.unwrap_or("").to_ascii_lowercase();
    let model = model.unwrap_or("").to_ascii_lowercase();
    if url.contains("anthropic") || model.starts_with("claude") {
        return ReasoningVendor::Anthropic;
    }
    if url.contains("deepseek") || model.starts_with("deepseek") {
        return ReasoningVendor::Deepseek;
    }
    if url.contains("generativelanguage.googleapis.com")
        || url.contains("gemini")
        || model.starts_with("gemini")
    {
        return ReasoningVendor::Gemini;
    }
    if url.contains("openai")
        || model.starts_with("gpt")
        || model.starts_with("o1")
        || model.starts_with("o3")
        || model.starts_with("o4")
    {
        return ReasoningVendor::Openai;
    }
    if model.starts_with("qwen") {
        return ReasoningVendor::Qwen;
    }
    if model.starts_with("glm") {
        return ReasoningVendor::Glm;
    }
    if model.starts_with("kimi") {
        return ReasoningVendor::Kimi;
    }
    ReasoningVendor::Auto
}

/// 归一化 reasoning effort（对齐 `model:openai-request-build.ts:107-113`）：
/// off/auto → None（不发送 reasoning 参数）；xhigh → high；max 直发；其余原样
pub fn normalize_reasoning_effort(effort: ReasoningEffort) -> Option<&'static str> {
    match effort {
        ReasoningEffort::Off | ReasoningEffort::Auto => None,
        ReasoningEffort::Xhigh => Some("high"),
        other => Some(other.as_str()),
    }
}

/// effort → Anthropic thinking budget_tokens（对齐 `model:openai-request-build.ts:119-136`）
pub fn effort_to_budget_tokens(effort: ReasoningEffort) -> u64 {
    match effort {
        ReasoningEffort::Minimal => 128,
        ReasoningEffort::Low => 1024,
        ReasoningEffort::Medium => 2048,
        ReasoningEffort::High => 4096,
        ReasoningEffort::Xhigh => 8192,
        // 防御性兜底（自适应模型不走 budget_tokens；旧模型档位集无 Max，
        // 归一化已降级）——沿用既有倍增档位刻度
        ReasoningEffort::Max => 16384,
        ReasoningEffort::Off | ReasoningEffort::Auto => 2048,
    }
}

/// intensity → Anthropic thinking budget_tokens（对齐 `shared:thinking-intensity.ts:212-221`）
pub fn thinking_to_budget_tokens(intensity: ThinkingIntensity) -> u64 {
    match intensity {
        ThinkingIntensity::Minimal => 128,
        ThinkingIntensity::Low => 1024,
        ThinkingIntensity::Medium => 2048,
        ThinkingIntensity::High => 4096,
        ThinkingIntensity::Xhigh => 8192,
        // 防御性兜底（同上：adaptive 形态不走本函数）
        ThinkingIntensity::Max => 16384,
        ThinkingIntensity::Off => 2048,
    }
}

/// effort → Gemini thinking_level（对齐 `model:openai-request-build.ts:139-155`）
pub fn effort_to_gemini_thinking_level(effort: ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::Minimal => "minimal",
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High | ReasoningEffort::Xhigh | ReasoningEffort::Max => "high",
        ReasoningEffort::Off | ReasoningEffort::Auto => "high",
    }
}

/// intensity → Gemini thinking_level（对齐 `shared:thinking-intensity.ts:228-237`；xhigh 降级 high）
pub fn thinking_to_gemini_thinking_level(intensity: ThinkingIntensity) -> &'static str {
    match intensity {
        ThinkingIntensity::Minimal => "minimal",
        ThinkingIntensity::Low => "low",
        ThinkingIntensity::Medium => "medium",
        ThinkingIntensity::High | ThinkingIntensity::Xhigh | ThinkingIntensity::Max => "high",
        ThinkingIntensity::Off => "medium",
    }
}

/// 判定 Anthropic 自适应思考代际（Opus 4.7+ / Sonnet 5+ / Fable 5 / Mythos 5，
/// 含 SAP 倒置形态 claude-4-7-opus 等）：按模型系列前缀命中能力表的
/// ThinkingAdaptive 形态（对齐 opencode anthropicOpus47OrLater /
/// anthropicSonnet5OrLater 的系列门控；旧代际保持 ThinkingBudget 既有映射）
fn is_adaptive_thinking_model(model: &str) -> bool {
    infer_thinking_capability(model).format == ReasoningFormat::ThinkingAdaptive
}

/// Anthropic 自适应思考的 wire effort：xhigh/max 直发（新代际有效档位）；
/// minimal 不在 adaptive 档位集 → 降级 low（对齐 normalize_thinking_intensity）。
/// off/auto 已在上游提前返回，不会到达此处。
fn adaptive_effort_wire(effort: ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::Minimal => "low",
        other => other.as_str(),
    }
}

/// reasoningEffortObject（对齐 `model:openai-request-build.ts:214-270`；02 §五 #2 取 model 行为）
///
/// 显式 vendor（非 auto）优先，按 vendor 原生格式生成（忽略 endpoint/format）：
/// - openai：responses 用 `reasoning.effort`，chat-completions 用 `reasoning_effort`
/// - anthropic：旧代际 `thinking{type:'enabled',budget_tokens}`（需配合
///   [reasoning_effort_headers]）；Opus 4.7+/Sonnet 5+ 等新代际（[is_adaptive_thinking_model]）
///   切 adaptive 形态：`thinking{type:'adaptive',display:'summarized'}` + 顶层 `effort`
/// - deepseek/qwen/glm/kimi：仅 `reasoning_effort`（原生 API 不支持 extra_body.thinking）
/// - gemini：`generation_config.thinking_level`
///
/// vendor=auto：按 format/endpoint 推断（02 §五 #2 "auto 退化"为 runtime 行为）。
/// effort 为 off/auto 或 format=none → None（不注入任何字段）。
pub fn reasoning_effort_object(
    endpoint: Endpoint,
    model: &str,
    effort: Option<ReasoningEffort>,
    format: Option<ReasoningEffortFormat>,
    vendor: Option<ReasoningVendor>,
) -> Option<Value> {
    let wire_effort = effort.and_then(normalize_reasoning_effort)?;
    if format == Some(ReasoningEffortFormat::None) {
        return None;
    }
    let resolved_vendor = vendor.unwrap_or(ReasoningVendor::Auto);
    if resolved_vendor != ReasoningVendor::Auto {
        return match resolved_vendor {
            ReasoningVendor::Openai => {
                if endpoint == Endpoint::Responses {
                    Some(json!({ "reasoning": { "effort": wire_effort } }))
                } else {
                    Some(json!({ "reasoning_effort": wire_effort }))
                }
            }
            ReasoningVendor::Anthropic => {
                if is_adaptive_thinking_model(model) {
                    // G7 自适应形态：effort 档位直发（xhigh/max 有效），display 强制
                    // "summarized"——新版默认 omitted 会吐空 thinking 块，块内容漂移
                    // 破坏缓存前缀（对齐 opencode transform.ts:791-794）
                    Some(json!({
                        "thinking": { "type": "adaptive", "display": "summarized" },
                        "effort": adaptive_effort_wire(effort.unwrap_or(ReasoningEffort::Medium)),
                    }))
                } else {
                    Some(json!({
                        "thinking": {
                            "type": "enabled",
                            "budget_tokens": effort_to_budget_tokens(effort.unwrap_or(ReasoningEffort::Medium)),
                        }
                    }))
                }
            }
            ReasoningVendor::Deepseek
            | ReasoningVendor::Qwen
            | ReasoningVendor::Glm
            | ReasoningVendor::Kimi => Some(json!({ "reasoning_effort": wire_effort })),
            ReasoningVendor::Gemini => Some(json!({
                "generation_config": {
                    "thinking_level": effort_to_gemini_thinking_level(
                        effort.unwrap_or(ReasoningEffort::High),
                    ),
                }
            })),
            ReasoningVendor::Auto => unreachable!("auto 已在上方分支处理"),
        };
    }
    // auto：按 format/endpoint 推断（保持向后兼容）
    let resolved_format = format.unwrap_or(ReasoningEffortFormat::Auto);
    if matches!(resolved_format, ReasoningEffortFormat::Responses)
        || (resolved_format == ReasoningEffortFormat::Auto && endpoint == Endpoint::Responses)
    {
        return Some(json!({ "reasoning": { "effort": wire_effort } }));
    }
    if matches!(resolved_format, ReasoningEffortFormat::ChatCompletions)
        || (resolved_format == ReasoningEffortFormat::Auto && endpoint == Endpoint::ChatCompletions)
    {
        return Some(json!({ "reasoning_effort": wire_effort }));
    }
    None
}

/// reasoning-effort 相关请求头（对齐 `model:openai-request-build.ts:190-199`；02 §五 #3）
///
/// 仅 vendor=anthropic 且 effort 非 off/auto 时返回 `anthropic-beta` 头，其余不返回。
pub fn reasoning_effort_headers(
    vendor: Option<ReasoningVendor>,
    effort: Option<ReasoningEffort>,
) -> Option<(&'static str, &'static str)> {
    match (vendor, effort) {
        (
            Some(ReasoningVendor::Anthropic),
            Some(ReasoningEffort::Minimal)
            | Some(ReasoningEffort::Low)
            | Some(ReasoningEffort::Medium)
            | Some(ReasoningEffort::High)
            | Some(ReasoningEffort::Xhigh)
            | Some(ReasoningEffort::Max),
        ) => Some(("anthropic-beta", "interleaved-thinking-2025-05-14")),
        _ => None,
    }
}

/// 归一化思考强度（对齐 `shared:thinking-intensity.ts:182-200`）：
/// off → None；不支持思考的模型 → None；档位缺失时降级
/// （xhigh → high、minimal → low、其余取最大支持档位）
pub fn normalize_thinking_intensity(
    intensity: ThinkingIntensity,
    capability: &ThinkingCapability,
) -> Option<ThinkingIntensity> {
    if intensity == ThinkingIntensity::Off || !capability.supported {
        return None;
    }
    if !capability.levels.contains(&intensity) {
        return match intensity {
            ThinkingIntensity::Xhigh => {
                if capability.levels.contains(&ThinkingIntensity::High) {
                    Some(ThinkingIntensity::High)
                } else {
                    None
                }
            }
            ThinkingIntensity::Minimal => {
                if capability.levels.contains(&ThinkingIntensity::Low) {
                    Some(ThinkingIntensity::Low)
                } else {
                    None
                }
            }
            _ => capability.levels.last().copied(),
        };
    }
    Some(intensity)
}

/// resolveThinkingParams（对齐 `shared:thinking-intensity.ts:264-312`；01 D5 透传）
///
/// 注入到请求体的 vendor 原生思考参数；off / 不支持思考的模型 → 空对象。
pub fn resolve_thinking_params(
    capability: &ThinkingCapability,
    intensity: ThinkingIntensity,
    endpoint: Endpoint,
) -> Value {
    let Some(active) = normalize_thinking_intensity(intensity, capability) else {
        return json!({});
    };
    match capability.format {
        ReasoningFormat::ReasoningEffort => {
            // OpenAI 且 responses 端点用 reasoning.effort，其余（含 deepseek/qwen/glm/kimi）用 reasoning_effort
            if capability.vendor == ReasoningVendor::Openai && endpoint == Endpoint::Responses {
                json!({ "reasoning": { "effort": active.as_str() } })
            } else {
                json!({ "reasoning_effort": active.as_str() })
            }
        }
        ReasoningFormat::ThinkingBudget => json!({
            "thinking": {
                "type": "enabled",
                "budget_tokens": thinking_to_budget_tokens(active),
            }
        }),
        ReasoningFormat::ThinkingAdaptive => {
            // G7：新代际自适应思考——display:"summarized" 强制（新版默认 omitted
            // 会吐空 thinking 块，思考摘要不存活；块内容漂移破坏缓存前缀，
            // 对齐 opencode transform.ts:791-794）
            json!({
                "thinking": { "type": "adaptive", "display": "summarized" },
                "effort": active.as_str(),
            })
        }
        ReasoningFormat::ThinkingLevel => json!({
            "generation_config": {
                "thinking_level": thinking_to_gemini_thinking_level(active),
            }
        }),
        ReasoningFormat::None => json!({}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── inferReasoningVendor（02 §五 #2 语义）──

    #[test]
    fn infer_vendor_by_base_url_keyword() {
        assert_eq!(
            infer_reasoning_vendor(Some("https://api.anthropic.com"), None),
            ReasoningVendor::Anthropic
        );
        assert_eq!(
            infer_reasoning_vendor(Some("https://api.deepseek.com"), None),
            ReasoningVendor::Deepseek
        );
        assert_eq!(
            infer_reasoning_vendor(Some("https://generativelanguage.googleapis.com"), None),
            ReasoningVendor::Gemini
        );
        assert_eq!(
            infer_reasoning_vendor(Some("https://api.openai.com"), None),
            ReasoningVendor::Openai
        );
    }

    #[test]
    fn infer_vendor_by_model_prefix() {
        assert_eq!(infer_reasoning_vendor(None, Some("claude-sonnet-4")), ReasoningVendor::Anthropic);
        assert_eq!(infer_reasoning_vendor(None, Some("deepseek-reasoner")), ReasoningVendor::Deepseek);
        assert_eq!(infer_reasoning_vendor(None, Some("gemini-2.5-flash")), ReasoningVendor::Gemini);
        assert_eq!(infer_reasoning_vendor(None, Some("gpt-4o")), ReasoningVendor::Openai);
        assert_eq!(infer_reasoning_vendor(None, Some("o3-mini")), ReasoningVendor::Openai);
        assert_eq!(infer_reasoning_vendor(None, Some("qwen3-max")), ReasoningVendor::Qwen);
        assert_eq!(infer_reasoning_vendor(None, Some("glm-5")), ReasoningVendor::Glm);
        assert_eq!(infer_reasoning_vendor(None, Some("kimi-2.5")), ReasoningVendor::Kimi);
    }

    #[test]
    fn infer_vendor_unrecognized_falls_back_to_auto() {
        assert_eq!(infer_reasoning_vendor(Some("https://unknown.example"), None), ReasoningVendor::Auto);
        assert_eq!(infer_reasoning_vendor(None, Some("unknown-model")), ReasoningVendor::Auto);
        assert_eq!(infer_reasoning_vendor(None, None), ReasoningVendor::Auto);
    }

    // ── reasoningEffortObject（vendor 分支）──

    #[test]
    fn effort_object_vendor_auto_chat_completions_uses_reasoning_effort() {
        // auto 退化：chat-completions → reasoning_effort（02 §五 #2）
        assert_eq!(
            reasoning_effort_object(
                Endpoint::ChatCompletions,
                "m",
                Some(ReasoningEffort::High),
                None,
                None,
            ),
            Some(json!({ "reasoning_effort": "high" }))
        );
    }

    #[test]
    fn effort_object_vendor_auto_responses_uses_reasoning_nested() {
        assert_eq!(
            reasoning_effort_object(
                Endpoint::Responses,
                "m",
                Some(ReasoningEffort::Low),
                None,
                None,
            ),
            Some(json!({ "reasoning": { "effort": "low" } }))
        );
    }

    #[test]
    fn effort_object_format_overrides_endpoint_in_auto() {
        // 显式 format=responses 时即使 chat-completions endpoint 也用 reasoning.effort
        assert_eq!(
            reasoning_effort_object(
                Endpoint::ChatCompletions,
                "m",
                Some(ReasoningEffort::Medium),
                Some(ReasoningEffortFormat::Responses),
                None,
            ),
            Some(json!({ "reasoning": { "effort": "medium" } }))
        );
    }

    #[test]
    fn effort_object_openai_vendor_split_by_endpoint() {
        assert_eq!(
            reasoning_effort_object(Endpoint::ChatCompletions, "gpt-5", Some(ReasoningEffort::High), None, Some(ReasoningVendor::Openai)),
            Some(json!({ "reasoning_effort": "high" }))
        );
        assert_eq!(
            reasoning_effort_object(Endpoint::Responses, "gpt-5", Some(ReasoningEffort::High), None, Some(ReasoningVendor::Openai)),
            Some(json!({ "reasoning": { "effort": "high" } }))
        );
    }

    #[test]
    fn effort_object_anthropic_uses_thinking_budget() {
        assert_eq!(
            reasoning_effort_object(Endpoint::ChatCompletions, "claude-x", Some(ReasoningEffort::High), None, Some(ReasoningVendor::Anthropic)),
            Some(json!({ "thinking": { "type": "enabled", "budget_tokens": 4096 } }))
        );
        // xhigh 保留 8192 语义
        assert_eq!(
            reasoning_effort_object(Endpoint::ChatCompletions, "claude-x", Some(ReasoningEffort::Xhigh), None, Some(ReasoningVendor::Anthropic)),
            Some(json!({ "thinking": { "type": "enabled", "budget_tokens": 8192 } }))
        );
    }

    #[test]
    fn effort_object_deepseek_uses_only_reasoning_effort() {
        assert_eq!(
            reasoning_effort_object(Endpoint::ChatCompletions, "deepseek-reasoner", Some(ReasoningEffort::Medium), None, Some(ReasoningVendor::Deepseek)),
            Some(json!({ "reasoning_effort": "medium" }))
        );
    }

    #[test]
    fn effort_object_gemini_uses_thinking_level() {
        assert_eq!(
            reasoning_effort_object(Endpoint::ChatCompletions, "gemini-2.5", Some(ReasoningEffort::High), None, Some(ReasoningVendor::Gemini)),
            Some(json!({ "generation_config": { "thinking_level": "high" } }))
        );
    }

    #[test]
    fn effort_object_off_auto_and_none_format_yield_nothing() {
        for effort in [ReasoningEffort::Off, ReasoningEffort::Auto] {
            assert_eq!(
                reasoning_effort_object(Endpoint::ChatCompletions, "m", Some(effort), None, Some(ReasoningVendor::Anthropic)),
                None,
                "effort={effort:?} 不注入",
            );
        }
        assert_eq!(
            reasoning_effort_object(
                Endpoint::ChatCompletions,
                "m",
                Some(ReasoningEffort::High),
                Some(ReasoningEffortFormat::None),
                None,
            ),
            None
        );
    }

    #[test]
    fn effort_object_xhigh_normalizes_to_high() {
        // 归一化：xhigh → high（发送层 wire 值）
        assert_eq!(
            reasoning_effort_object(Endpoint::ChatCompletions, "m", Some(ReasoningEffort::Xhigh), None, None),
            Some(json!({ "reasoning_effort": "high" }))
        );
    }

    // ── anthropic-beta 头（02 §五 #3）──

    #[test]
    fn anthropic_beta_header_only_for_anthropic_with_active_effort() {
        // 仅 vendor=anthropic 且 effort 非 off/auto
        assert_eq!(
            reasoning_effort_headers(Some(ReasoningVendor::Anthropic), Some(ReasoningEffort::High)),
            Some(("anthropic-beta", "interleaved-thinking-2025-05-14"))
        );
        // off / auto 不发
        assert_eq!(reasoning_effort_headers(Some(ReasoningVendor::Anthropic), Some(ReasoningEffort::Off)), None);
        assert_eq!(reasoning_effort_headers(Some(ReasoningVendor::Anthropic), Some(ReasoningEffort::Auto)), None);
        // 非 anthropic vendor 不发
        assert_eq!(reasoning_effort_headers(Some(ReasoningVendor::Openai), Some(ReasoningEffort::High)), None);
        assert_eq!(reasoning_effort_headers(Some(ReasoningVendor::Deepseek), Some(ReasoningEffort::High)), None);
        // vendor 未指定（auto）不发
        assert_eq!(reasoning_effort_headers(None, Some(ReasoningEffort::High)), None);
        // effort 缺失不发
        assert_eq!(reasoning_effort_headers(Some(ReasoningVendor::Anthropic), None), None);
    }

    // ── thinking 能力推断与归一化（01 D5）──

    #[test]
    fn infer_capability_by_model_prefix() {
        let cap = infer_thinking_capability("o3-mini");
        assert!(cap.supported);
        assert_eq!(cap.vendor, ReasoningVendor::Openai);
        assert_eq!(cap.format, ReasoningFormat::ReasoningEffort);

        let cap = infer_thinking_capability("claude-sonnet-4-20250514");
        assert!(cap.supported);
        assert_eq!(cap.vendor, ReasoningVendor::Anthropic);
        assert_eq!(cap.format, ReasoningFormat::ThinkingBudget);
        assert!(cap.levels.contains(&ThinkingIntensity::Xhigh));

        let cap = infer_thinking_capability("gemini-2.5-flash");
        assert!(cap.supported);
        assert_eq!(cap.format, ReasoningFormat::ThinkingLevel);
        assert!(!cap.levels.contains(&ThinkingIntensity::Xhigh));

        let cap = infer_thinking_capability("deepseek-reasoner");
        assert!(cap.supported);
        assert_eq!(cap.vendor, ReasoningVendor::Deepseek);

        // 最长前缀命中：deepseek-chat 覆盖 deepseek 前缀 → 不支持
        assert!(!infer_thinking_capability("deepseek-chat").supported);
        assert!(!infer_thinking_capability("deepseek-v3").supported);
        assert!(!infer_thinking_capability("gpt-4o").supported);
        assert!(!infer_thinking_capability("unknown-model").supported);
    }

    #[test]
    fn normalize_intensity_respects_capability() {
        let claude = infer_thinking_capability("claude-sonnet-4");
        let gemini = infer_thinking_capability("gemini-2.5-flash");
        let unsupported = infer_thinking_capability("gpt-4o");

        // off → None
        assert_eq!(normalize_thinking_intensity(ThinkingIntensity::Off, &claude), None);
        // 不支持的模型 → None
        assert_eq!(normalize_thinking_intensity(ThinkingIntensity::High, &unsupported), None);
        // Gemini xhigh 降级为 high
        assert_eq!(
            normalize_thinking_intensity(ThinkingIntensity::Xhigh, &gemini),
            Some(ThinkingIntensity::High)
        );
        // Claude 保留 xhigh
        assert_eq!(
            normalize_thinking_intensity(ThinkingIntensity::Xhigh, &claude),
            Some(ThinkingIntensity::Xhigh)
        );
        // o1 系 minimal 降级为 low
        let o1 = infer_thinking_capability("o1");
        assert_eq!(
            normalize_thinking_intensity(ThinkingIntensity::Minimal, &o1),
            Some(ThinkingIntensity::Low)
        );
    }

    #[test]
    fn resolve_thinking_params_by_vendor() {
        let openai = infer_thinking_capability("o3-mini");
        assert_eq!(
            resolve_thinking_params(&openai, ThinkingIntensity::High, Endpoint::ChatCompletions),
            json!({ "reasoning_effort": "high" })
        );
        assert_eq!(
            resolve_thinking_params(&openai, ThinkingIntensity::High, Endpoint::Responses),
            json!({ "reasoning": { "effort": "high" } })
        );

        let anthropic = infer_thinking_capability("claude-sonnet-4");
        assert_eq!(
            resolve_thinking_params(&anthropic, ThinkingIntensity::High, Endpoint::ChatCompletions),
            json!({ "thinking": { "type": "enabled", "budget_tokens": 4096 } })
        );

        let gemini = infer_thinking_capability("gemini-2.5-flash");
        assert_eq!(
            resolve_thinking_params(&gemini, ThinkingIntensity::Xhigh, Endpoint::ChatCompletions),
            json!({ "generation_config": { "thinking_level": "high" } })
        );

        let deepseek = infer_thinking_capability("deepseek-reasoner");
        assert_eq!(
            resolve_thinking_params(&deepseek, ThinkingIntensity::Medium, Endpoint::ChatCompletions),
            json!({ "reasoning_effort": "medium" })
        );

        // off 与不支持 → 空对象
        assert_eq!(resolve_thinking_params(&anthropic, ThinkingIntensity::Off, Endpoint::ChatCompletions), json!({}));
        assert_eq!(resolve_thinking_params(&unsupported(), ThinkingIntensity::High, Endpoint::ChatCompletions), json!({}));
    }

    fn unsupported() -> ThinkingCapability {
        infer_thinking_capability("gpt-4o")
    }

    #[test]
    fn budget_tokens_and_gemini_level_mappings() {
        assert_eq!(thinking_to_budget_tokens(ThinkingIntensity::Minimal), 128);
        assert_eq!(thinking_to_budget_tokens(ThinkingIntensity::Low), 1024);
        assert_eq!(thinking_to_budget_tokens(ThinkingIntensity::Medium), 2048);
        assert_eq!(thinking_to_budget_tokens(ThinkingIntensity::High), 4096);
        assert_eq!(thinking_to_budget_tokens(ThinkingIntensity::Xhigh), 8192);

        assert_eq!(thinking_to_gemini_thinking_level(ThinkingIntensity::Minimal), "minimal");
        assert_eq!(thinking_to_gemini_thinking_level(ThinkingIntensity::Xhigh), "high");
        assert_eq!(effort_to_gemini_thinking_level(ReasoningEffort::Xhigh), "high");
        assert_eq!(effort_to_budget_tokens(ReasoningEffort::High), 4096);
    }

    // ── G7：Anthropic 自适应思考（Opus 4.7+ / Sonnet 5+）──

    #[test]
    fn adaptive_model_detection_by_series_prefix() {
        // 新代际：Opus 4.7+ / Sonnet 5+ / Fable 5 / Mythos 5 启用 adaptive 档位集
        for model in [
            "claude-opus-4-7",
            "claude-opus-4-8",
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-fable-5",
            "claude-mythos-5",
            "claude-4-7-opus", // SAP 倒置形态
            "claude-4-8-opus", // SAP 倒置形态
        ] {
            let cap = infer_thinking_capability(model);
            assert!(cap.supported, "{model} 应支持思考");
            assert_eq!(
                cap.format,
                ReasoningFormat::ThinkingAdaptive,
                "{model} 应为 adaptive 形态"
            );
            assert!(cap.levels.contains(&ThinkingIntensity::Xhigh), "{model} 应含 xhigh");
            assert!(cap.levels.contains(&ThinkingIntensity::Max), "{model} 应含 max");
            assert!(
                !cap.levels.contains(&ThinkingIntensity::Minimal),
                "{model} 不应含 minimal"
            );
        }
        // 旧代际保持既有映射（ThinkingBudget + 含 xhigh、无 max）
        for model in ["claude-opus-4-6", "claude-opus-4-5", "claude-sonnet-4-6", "claude-sonnet-4"] {
            let cap = infer_thinking_capability(model);
            assert_eq!(cap.format, ReasoningFormat::ThinkingBudget, "{model} 保持 budget 形态");
            assert!(!cap.levels.contains(&ThinkingIntensity::Max), "{model} 不应含 max");
        }
    }

    #[test]
    fn adaptive_effort_object_injects_display_summarized() {
        // 新代际：thinking{type:adaptive,display:summarized} + effort（xhigh/max 直发）
        assert_eq!(
            reasoning_effort_object(Endpoint::ChatCompletions, "claude-opus-4-7", Some(ReasoningEffort::Max), None, Some(ReasoningVendor::Anthropic)),
            Some(json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "max" }))
        );
        assert_eq!(
            reasoning_effort_object(Endpoint::ChatCompletions, "claude-opus-4-8", Some(ReasoningEffort::Xhigh), None, Some(ReasoningVendor::Anthropic)),
            Some(json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "xhigh" }))
        );
        assert_eq!(
            reasoning_effort_object(Endpoint::ChatCompletions, "claude-sonnet-5", Some(ReasoningEffort::High), None, Some(ReasoningVendor::Anthropic)),
            Some(json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "high" }))
        );
        // minimal 不在 adaptive 档位集 → 降级 low
        assert_eq!(
            reasoning_effort_object(Endpoint::ChatCompletions, "claude-opus-4-7", Some(ReasoningEffort::Minimal), None, Some(ReasoningVendor::Anthropic)),
            Some(json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "low" }))
        );
        // 旧代际保持 enabled+budget_tokens 既有映射（Max 走预算兜底）
        assert_eq!(
            reasoning_effort_object(Endpoint::ChatCompletions, "claude-opus-4-6", Some(ReasoningEffort::Max), None, Some(ReasoningVendor::Anthropic)),
            Some(json!({ "thinking": { "type": "enabled", "budget_tokens": 16384 } }))
        );
    }

    #[test]
    fn adaptive_thinking_params_inject_display_summarized() {
        let cap = infer_thinking_capability("claude-opus-4-7");
        assert_eq!(
            resolve_thinking_params(&cap, ThinkingIntensity::High, Endpoint::ChatCompletions),
            json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "high" })
        );
        assert_eq!(
            resolve_thinking_params(&cap, ThinkingIntensity::Xhigh, Endpoint::ChatCompletions),
            json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "xhigh" })
        );
        assert_eq!(
            resolve_thinking_params(&cap, ThinkingIntensity::Max, Endpoint::ChatCompletions),
            json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "max" })
        );
        // minimal 在 adaptive 档位集外 → 归一化降级 low
        assert_eq!(
            resolve_thinking_params(&cap, ThinkingIntensity::Minimal, Endpoint::ChatCompletions),
            json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "low" })
        );
        // off → 空对象（不注入）
        assert_eq!(resolve_thinking_params(&cap, ThinkingIntensity::Off, Endpoint::ChatCompletions), json!({}));
        // 旧代际：max 降级到最大支持档位 xhigh → 保持 enabled+budget_tokens
        let old = infer_thinking_capability("claude-sonnet-4");
        assert_eq!(
            resolve_thinking_params(&old, ThinkingIntensity::Max, Endpoint::ChatCompletions),
            json!({ "thinking": { "type": "enabled", "budget_tokens": 8192 } })
        );
    }

    #[test]
    fn adaptive_effort_enum_and_header_extensions() {
        assert_eq!(ReasoningEffort::Max.as_str(), "max");
        assert_eq!(ThinkingIntensity::Max.as_str(), "max");
        assert_eq!(normalize_reasoning_effort(ReasoningEffort::Max), Some("max"));
        assert_eq!(effort_to_budget_tokens(ReasoningEffort::Max), 16384);
        assert_eq!(thinking_to_budget_tokens(ThinkingIntensity::Max), 16384);
        assert_eq!(effort_to_gemini_thinking_level(ReasoningEffort::Max), "high");
        assert_eq!(thinking_to_gemini_thinking_level(ThinkingIntensity::Max), "high");
        // anthropic-beta 头把 max 视为活跃档位
        assert_eq!(
            reasoning_effort_headers(Some(ReasoningVendor::Anthropic), Some(ReasoningEffort::Max)),
            Some(("anthropic-beta", "interleaved-thinking-2025-05-14"))
        );
    }
}
