//! 思考档位换算域（多模型适配战役 R3 T3.2 / S-A1；engine_provider.rs → engine_provider/thinking.rs）
//!
//! 承载 `ProviderRequest.reasoning_effort`（T3.1 契约字段，series 级）到
//! agent-provider 思考参数类型的映射。R3 只消费**系列级**思考档位（模型能
//! 力经 [infer_thinking_capability] 界定），模型级档位白名单映射留 R4 T4.2。
//!
//! 契约登记：session-loop `ReasoningEffort` 与 agent-provider `ReasoningEffort`
//! 变体集/字面完全一致（`off/auto/minimal/low/medium/high/xhigh/max`），本模块
//! 提供逐变体映射；gemini 轨 builder 用 `thinking_intensity`（[ThinkingIntensity]），
//! 由 [effort_to_intensity] 换算。

use agent_provider::request::{ReasoningEffort, ThinkingIntensity};

/// session-loop 思考档位 → agent-provider reasoning effort（逐变体映射，
/// 变体集/字面一致，纯转发）。
pub(crate) fn to_provider_effort(
    effort: session_loop::provider::ReasoningEffort,
) -> ReasoningEffort {
    match effort {
        session_loop::provider::ReasoningEffort::Off => ReasoningEffort::Off,
        session_loop::provider::ReasoningEffort::Auto => ReasoningEffort::Auto,
        session_loop::provider::ReasoningEffort::Minimal => ReasoningEffort::Minimal,
        session_loop::provider::ReasoningEffort::Low => ReasoningEffort::Low,
        session_loop::provider::ReasoningEffort::Medium => ReasoningEffort::Medium,
        session_loop::provider::ReasoningEffort::High => ReasoningEffort::High,
        session_loop::provider::ReasoningEffort::Xhigh => ReasoningEffort::Xhigh,
        session_loop::provider::ReasoningEffort::Max => ReasoningEffort::Max,
    }
}

/// session-loop 思考档位 → gemini thinking intensity（gemini 轨 builder 消费
/// [ThinkingIntensity]；逐变体映射，变体集一致）。
pub(crate) fn effort_to_intensity(effort: session_loop::provider::ReasoningEffort) -> ThinkingIntensity {
    match effort {
        session_loop::provider::ReasoningEffort::Off => ThinkingIntensity::Off,
        session_loop::provider::ReasoningEffort::Auto => ThinkingIntensity::Medium,
        session_loop::provider::ReasoningEffort::Minimal => ThinkingIntensity::Minimal,
        session_loop::provider::ReasoningEffort::Low => ThinkingIntensity::Low,
        session_loop::provider::ReasoningEffort::Medium => ThinkingIntensity::Medium,
        session_loop::provider::ReasoningEffort::High => ThinkingIntensity::High,
        session_loop::provider::ReasoningEffort::Xhigh => ThinkingIntensity::Xhigh,
        session_loop::provider::ReasoningEffort::Max => ThinkingIntensity::Max,
    }
}
