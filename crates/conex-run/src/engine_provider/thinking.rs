//! 思考档位换算域（多模型适配战役 R3 T3.2 / S-A1；engine_provider.rs → engine_provider/thinking.rs）
//!
//! 承载 `ProviderRequest.reasoning_effort`（T3.1 契约字段，series 级）到
//! agent-provider 思考参数类型的映射，以及**请求面思考档位拒绝校验**
//! （战役 I4 / R5 B-1：显式档位不在模型能力白名单 → 网络 I/O 前分类错误拒绝）。
//!
//! 契约登记：session-loop `ReasoningEffort` 与 agent-provider `ReasoningEffort`
//! 变体集/字面完全一致（`off/auto/minimal/low/medium/high/xhigh/max`），本模块
//! 提供逐变体映射；四轨思考键统一由出站剖面 + dialect 产出（plans/04 §3）。

use agent_provider::request::build::dialect::ReasoningEffort as DialectEffort;
use agent_provider::request::{ReasoningEffort, ReasoningReject};
use conex_types::error::ProviderErrorKind;
use conex_types::response::ClassifiedStreamError;
use indexmap::IndexMap;

use super::protocol::CatalogRequestProfile;

/// session-loop 思考档位 → agent-provider reasoning effort（逐变体映射，
/// 变体集/字面一致，纯转发）。
pub fn to_provider_effort(effort: session_loop::provider::ReasoningEffort) -> ReasoningEffort {
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

/// 请求面思考档位拒绝校验（战役 I4 · R5 B-1 接线；plans/04 §1.4）。
///
/// 数据源 = 出站剖面 [CatalogRequestProfile] 的 `thinking_map`（yaml 字典
/// TitleCase 键白名单，经 `ReasoningEffort::from_title_case` 归一比较——禁止
/// 拿小写 `"high"` 撞 yaml `"High"` 误杀）。C17 语义（DegradePolicy 默认
/// Reject，不降级不改写）：
///
/// - `effort = None`（省略）→ `Ok(())`（不发送思考参数，保留提供方默认）；
/// - 显式档位为 off / auto → `Ok(())`（关闭/默认思考，不发送、不进能力校验）；
/// - 无 `thinking` 字典 + 显式档位（非 off/auto）→ `Err`（模型声明不支持思考）；
/// - 显式档位在字典白名单内 → `Ok(())`（直发不降级）；
/// - 显式档位不在字典 → `Err`：已分类流前错误 [ClassifiedStreamError]
///   （kind = [ProviderErrorKind::InvalidRequest]，文案含
///   [ReasoningReject::UNSUPPORTED_TAG] 语义标签，并列出**该模型可用档位集合**）。
///
/// 由 [crate::engine_provider::HttpProviderCall::stream] 在 HTTP I/O 之前调用——
/// 错误在请求发送前返回，满足「请求面不支持的档位在网络 I/O 前拒绝」。
pub fn validate_reasoning_effort(
    profile: &CatalogRequestProfile,
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
    // 白名单 = yaml thinking 字典的 TitleCase 键（归一比较：键拼写 High /
    // XHigh / X-High 均可命中对应档位）。
    let Some(map) = profile.thinking_map.as_ref() else {
        return Err(reject_to_classified(provider_effort, &[]));
    };
    let in_whitelist = map
        .keys()
        .any(|title| DialectEffort::from_title_case(title) == Some(provider_effort.into()));
    if in_whitelist {
        Ok(())
    } else {
        // 拒绝前把该模型可用档位集合（归一后的规范拼写，去重按词表序）带进文案。
        Err(reject_to_classified(
            provider_effort,
            &available_effort_titles(Some(map)),
        ))
    }
}

/// 思考词表序（与内核 [DialectEffort] 强度序一致）：Off→Minimal→Low→Medium→High→XHigh→Max。
const EFFORT_VOCABULARY: [DialectEffort; 7] = [
    DialectEffort::Off,
    DialectEffort::Minimal,
    DialectEffort::Low,
    DialectEffort::Medium,
    DialectEffort::High,
    DialectEffort::XHigh,
    DialectEffort::Max,
];

/// 该模型可用档位集合：`thinking_map` 的键经 [DialectEffort::from_title_case] 归一后的
/// **规范拼写**，去重并按词表序排列（`None`/`Disabled` 等别名归一到其规范档位）。
/// map 缺省 → 空集。
fn available_effort_titles(map: Option<&IndexMap<String, String>>) -> Vec<&'static str> {
    let Some(map) = map else {
        return Vec::new();
    };
    EFFORT_VOCABULARY
        .iter()
        .filter(|canon| {
            map.keys()
                .any(|k| DialectEffort::from_title_case(k) == Some(**canon))
        })
        .map(|canon| canon.to_title_case())
        .collect()
}

/// 拒绝载荷 → 已分类流前错误（C17 语义：复用 [ProviderErrorKind::InvalidRequest] 分类，
/// 与既有 HTTP 400 同类；文案含 `UNSUPPORTED_REASONING_EFFORT` 语义标签与**该模型可用档位
/// 集合**，不降级不改写）。
fn reject_to_classified(effort: ReasoningEffort, available: &[&str]) -> ClassifiedStreamError {
    let available_text = if available.is_empty() {
        "（该模型未声明任何可用档位）".to_string()
    } else {
        available.join(" / ")
    };
    ClassifiedStreamError {
        kind: ProviderErrorKind::InvalidRequest,
        message: format!(
            "不支持的思考档位 '{}' 超出此模型能力 —— {}；可用档位集合：{}（请求前拒绝，不降级）",
            effort.as_str(),
            ReasoningReject::UNSUPPORTED_TAG,
            available_text,
        ),
        retryable: false,
        retry_after_ms: None,
    }
}
