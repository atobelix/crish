//! effort/intensity → wire 值换算域（SR-06e · 拆分 · ≠ EL）
//!
//! 自 request/vendor.rs 拆出的实现域：effort/intensity 到厂商原生 wire 值
//! （budget_tokens / thinking_level / 归一化 effort）的换算与 Anthropic
//! adaptive 形态辅助（[is_adaptive_thinking_model] / [adaptive_effort_wire]）。
//! 门面（request/vendor.rs）re-export 全部公开符号，对外路径不变。

use super::{infer_thinking_capability, ReasoningEffort, ReasoningFormat, ThinkingIntensity};

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
pub fn is_adaptive_thinking_model(model: &str) -> bool {
    infer_thinking_capability(model).format == ReasoningFormat::ThinkingAdaptive
}

/// Anthropic 自适应思考的 wire effort：xhigh/max 直发（新代际有效档位）；
/// minimal 不在 adaptive 档位集 → 降级 low（对齐 normalize_thinking_intensity）。
/// off/auto 已在上游提前返回，不会到达此处。
pub fn adaptive_effort_wire(effort: ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::Minimal => "low",
        other => other.as_str(),
    }
}
