//! 思考档位换算域（多模型适配战役 R3 T3.2 / S-A1；engine_provider.rs → engine_provider/thinking.rs）
//!
//! 承载 `ProviderRequest.reasoning_effort`（T3.1 契约字段，series 级）到
//! agent-provider 思考参数类型的映射，以及**请求面思考档位拒绝校验**
//! （战役 I4 / R5 B-1：显式档位不在模型能力白名单 → 网络 I/O 前分类错误拒绝）。
//!
//! 契约登记：session-loop `ReasoningEffort` 与 agent-provider `ReasoningEffort`
//! 变体集/字面完全一致（`off/auto/minimal/low/medium/high/xhigh/max`），本模块
//! 提供逐变体映射；gemini 轨 builder 用 `thinking_intensity`（[ThinkingIntensity]），
//! 由 [effort_to_intensity] 换算。

use agent_provider::request::{
    describe_model, ReasoningEffort, ReasoningReject, ThinkingIntensity,
};
use conex_types::error::ProviderErrorKind;
use conex_types::response::ClassifiedStreamError;

use super::protocol::{bundled_catalog, catalog_vendor};
use super::EngineProviderConfig;

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
pub(crate) fn effort_to_intensity(
    effort: session_loop::provider::ReasoningEffort,
) -> ThinkingIntensity {
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

/// 请求面思考档位拒绝校验（战役 I4 · R5 B-1 接线）。
///
/// 数据源 = [describe_model]（C9，模型级白名单，合并 catalog `offered_levels` 与
/// 系列级能力表，坏配置不藏同 provider 其它模型）。C17 语义（DegradePolicy 默认
/// Reject，不降级不改写）：
///
/// - `effort = None`（省略）→ `Ok(())`（不发送思考参数，保留提供方默认）；
/// - 显式档位为 off / auto → `Ok(())`（关闭/默认思考，不发送、不进能力校验）；
/// - 显式档位在模型能力白名单内 → `Ok(())`（直发不降级）；
/// - 显式档位不在能力白名单（或模型不支持 reasoning）→ `Err`：已分类流前错误
///   [ClassifiedStreamError]（kind = [ProviderErrorKind::InvalidRequest]，文案含
///   [ReasoningReject::UNSUPPORTED_TAG] 语义标签）。
///
/// 由 [crate::engine_provider::HttpProviderCall::stream] 在 HTTP I/O 之前调用——
/// 错误在请求发送前返回，满足「请求面不支持的档位在网络 I/O 前拒绝」。
pub(crate) fn validate_reasoning_effort(
    config: &EngineProviderConfig,
    effort: Option<session_loop::provider::ReasoningEffort>,
) -> Result<(), ClassifiedStreamError> {
    let Some(sl_effort) = effort else {
        // 省略 → 不发送思考参数（保留提供方默认）。
        return Ok(());
    };
    let provider_effort = to_provider_effort(sl_effort);
    // off/auto → 关闭/默认思考，不发送、不校验。
    if matches!(
        provider_effort,
        ReasoningEffort::Off | ReasoningEffort::Auto
    ) {
        return Ok(());
    }
    let capability = describe_model(
        bundled_catalog(),
        catalog_vendor(config),
        &config.model,
        Some(config.endpoint),
    );
    let in_whitelist = capability.supports_reasoning
        && capability
            .efforts
            .iter()
            .any(|e| e == provider_effort.as_str());
    if in_whitelist {
        Ok(())
    } else {
        Err(reject_to_classified(provider_effort))
    }
}

/// 拒绝载荷 → 已分类流前错误（C17 语义：复用 [ProviderErrorKind::InvalidRequest] 分类，
/// 与既有 HTTP 400 同类；文案含 `UNSUPPORTED_REASONING_EFFORT` 语义标签，不降级不改写）。
fn reject_to_classified(effort: ReasoningEffort) -> ClassifiedStreamError {
    ClassifiedStreamError {
        kind: ProviderErrorKind::InvalidRequest,
        message: format!(
            "不支持的思考档位 '{}' 超出此模型能力 —— {}（请求前拒绝，不降级）",
            effort.as_str(),
            ReasoningReject::UNSUPPORTED_TAG,
        ),
        retryable: false,
        retry_after_ms: None,
    }
}
