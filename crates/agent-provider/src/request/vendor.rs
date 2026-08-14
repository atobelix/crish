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
//!
//! SR-06e · 拆分 · ≠ EL：门面文件。实现域拆分如下（测试旁挂 vendor_tests.rs）：
//! - [vendor_capability]：模型系列能力映射表（MODEL_SERIES_CAPABILITIES）与
//!   [infer_thinking_capability] 最长前缀推断
//! - [vendor_wire]：effort/intensity → 厂商原生 wire 值换算（budget_tokens /
//!   thinking_level / effort 归一化与 adaptive 辅助）
//!
//! 枚举面（ReasoningVendor/ReasoningEffort/ReasoningEffortFormat/ThinkingIntensity/
//! ReasoningFormat/ThinkingCapability/NO_THINKING）与 vendor 推断/注入入口
//! 保持本文件单定义，消费方 import 路径不变。

use serde_json::{json, Value};

use crate::config::Endpoint;

#[path = "vendor_capability.rs"]
mod vendor_capability;
#[path = "vendor_wire.rs"]
mod vendor_wire;

pub use vendor_capability::infer_thinking_capability;
pub use vendor_wire::{
    effort_to_budget_tokens, effort_to_gemini_thinking_level, normalize_reasoning_effort,
    thinking_to_budget_tokens, thinking_to_gemini_thinking_level,
};

use vendor_wire::{adaptive_effort_wire, is_adaptive_thinking_model};

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
#[path = "vendor_tests.rs"]
mod tests;
