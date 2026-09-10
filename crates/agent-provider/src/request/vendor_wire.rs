//! effort/intensity → wire 值换算域（SR-06e · 拆分 · ≠ EL）
//!
//! 自 request/vendor.rs 拆出的实现域：effort/intensity 到厂商原生 wire 值
//! （budget_tokens / thinking_level / 归一化 effort）的换算。
//! 门面（request/vendor.rs）re-export 全部公开符号，对外路径不变。
//!
//! SSOT 注记（轨A）：出站思考键唯一入口 = `assemble_thinking_dialect`；
//! 本域的换算函数仅供方言字典构造与测试参考，**禁止**再按模型名前缀
//! 推断思考能力（`infer_thinking_capability` 已标 deprecated，无生产调用者）。

use super::{ReasoningEffort, ThinkingIntensity};

/// 归一化 reasoning effort（对齐 `model:openai-request-build.ts:107-113`）：
/// off/auto → None（不发送 reasoning 参数）；xhigh → high；max 直发；其余原样
pub fn normalize_reasoning_effort(effort: ReasoningEffort) -> Option<&'static str> {
    match effort {
        ReasoningEffort::Off | ReasoningEffort::Auto => None,
        ReasoningEffort::Xhigh => Some("high"),
        other => Some(other.as_str()),
    }
}

/// effort → Anthropic thinking budget_tokens（Anthropic 官方硬性约束 budget_tokens >= 1024）
pub fn effort_to_budget_tokens(effort: ReasoningEffort) -> u64 {
    match effort {
        ReasoningEffort::Minimal => 1024,
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

/// intensity → Anthropic thinking budget_tokens（Anthropic 官方硬性约束 budget_tokens >= 1024）
pub fn thinking_to_budget_tokens(intensity: ThinkingIntensity) -> u64 {
    match intensity {
        ThinkingIntensity::Minimal => 1024,
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
