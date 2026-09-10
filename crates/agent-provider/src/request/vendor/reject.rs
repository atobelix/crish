//! 请求面思考档位校验/拒绝域（多模型适配战役 R4 T4.1 一体 · G8-b + G8-c）
//!
//! 自 request/vendor.rs 拆出的实现域：把「校验 effort 是否在能力内」从
//! [super::normalize_thinking_intensity]（降级钳制）拆出为独立拒绝路径——
//! 显式/默认档位不在模型能力内 → 网络 I/O 前以分类错误拒绝（不降级不改写，
//! 对齐 DSH `UNSUPPORTED_REASONING_EFFORT` 语义）；省略档位 → 不发送思考参数。
//! 保留一个显式「允许降级」开关位（默认关闭）供兼容调用方（方案 T4.1 验收 C3）。
//!
//! ## 三态分流（G8-c / S-A7）
//!
//! - [ReasoningEffortState::Omitted]：省略档位 → 不发送思考参数（保留提供方默认）；
//! - [ReasoningEffortState::Default]：派生默认档位（白名单首个，恒在白名单内）；
//! - [ReasoningEffortState::Explicit]：显式档位 → 不在能力内时拒绝（防隐私降级）。
//!
//! ## 拒绝语义登记（契约登记）
//!
//! 错误分类复用既有 [ProviderErrorKind::InvalidRequest]（analysis 04:98「复用既有分类」
//! 路径；conex-types 数据面不新增变体），错误文案携带 [ReasoningReject::UNSUPPORTED_TAG]
//! 语义标识，供上层/前端按语义识别。
//!
//! 门面（request/vendor.rs）re-export 全部公开符号，对外路径不变。

use thiserror::Error;

use conex_types::error::ProviderErrorKind;

use super::{ReasoningEffort, ThinkingCapability, ThinkingIntensity};

/// 档位来源三态（G8-c：显式 / 默认 / 省略分流可辨）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasoningEffortState {
    /// 省略档位（None）：不发送思考参数，保留提供方默认。
    Omitted,
    /// 派生默认档位（白名单首个；恒在白名单内，故默认请求不拒绝）。
    Default,
    /// 显式档位：不在模型能力内 → 拒绝（防隐私降级），不降级不改写。
    Explicit(ReasoningEffort),
}

/// 降级策略开关（T4.1 验收 C3：默认关闭=拒绝；开启时保留旧降级行为供兼容调用方）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DegradePolicy {
    /// 默认：显式/默认档位不在能力内 → 拒绝（分类错误），不降级不改写。
    #[default]
    Reject,
    /// 兼容降级：保留旧 [super::normalize_thinking_intensity] 钳制行为
    /// （xhigh→high、minimal→low、其余取最大支持档位；不支持 → None）。
    AllowDegrade,
}

/// 思考档位拒绝（请求面 I/O 前拒绝的分类载荷）。
///
/// 分类复用 [ProviderErrorKind::InvalidRequest]（与 HTTP 400 其余归同类，analysis 04:98），
/// 文案携带 [ReasoningReject::UNSUPPORTED_TAG]（对齐 DSH `UNSUPPORTED_REASONING_EFFORT`），
/// 请求面**不降级不改写**。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct ReasoningReject {
    /// 被拒绝的档位字面（如 "max"）。
    pub effort: &'static str,
    /// 分类（恒 [ProviderErrorKind::InvalidRequest]）。
    pub kind: ProviderErrorKind,
    /// 错误文案（含 `UNSUPPORTED_REASONING_EFFORT` 语义标签）。
    pub message: String,
}

impl ReasoningReject {
    /// 语义标签（对齐 DSH `UNSUPPORTED_REASONING_EFFORT`）。
    pub const UNSUPPORTED_TAG: &'static str = "UNSUPPORTED_REASONING_EFFORT";

    /// 档位超出能力白名单（拒绝，不降级）。
    fn unsupported(effort: &'static str) -> Self {
        Self {
            effort,
            kind: ProviderErrorKind::InvalidRequest,
            message: format!(
                "不支持的思考档位 '{effort}' 超出此模型能力 —— {}（请求前拒绝，不降级）",
                Self::UNSUPPORTED_TAG
            ),
        }
    }
}

/// 校验 resolve 显式/默认档位（R4 T4.1 校验面核心入口；纯函数无 IO）。
///
/// - [ReasoningEffortState::Omitted] → `Ok(None)`（不发送思考参数）；
/// - 档位为 off/auto → `Ok(None)`（关闭/不显式发送思考）；
/// - [ReasoningEffortState::Default] → `Ok(能力白名单首个支持档)`（派生默认恒在白名单）；
/// - 档位在能力白名单内 → `Ok(Some(档位))`（直发不降级）；
/// - [DegradePolicy::Reject]（默认）且档位不在能力内 → `Err(ReasoningReject)`；
/// - [DegradePolicy::AllowDegrade] → 走旧降级钳制（[super::normalize_thinking_intensity]）。
///
/// `capability.supported == false`（未知模型/不支持推理）：显式非 off 档 → 拒绝（默认）
/// / 省略 → `Ok(None)`。
pub fn resolve_reasoning_level(
    effort: ReasoningEffortState,
    capability: &ThinkingCapability,
    policy: DegradePolicy,
) -> Result<Option<ReasoningEffort>, ReasoningReject> {
    match effort {
        // 1. 省略 → 不发送；默认 → 白名单首个（恒在白名单，故不拒绝）。
        ReasoningEffortState::Omitted => Ok(None),
        ReasoningEffortState::Default => Ok(capability
            .levels
            .first()
            .copied()
            .and_then(intensity_to_effort)),
        ReasoningEffortState::Explicit(level) => {
            // 2. off/auto 一律不发送（关闭思考）。
            if matches!(level, ReasoningEffort::Off | ReasoningEffort::Auto) {
                Ok(None)
            } else if capability.supported && in_whitelist(level, capability) {
                // 3. 档位在能力白名单内 → 直发（不降级）。
                Ok(Some(level))
            } else {
                // 4. 不支持/越白名单：按策略拒绝或降级。
                match policy {
                    DegradePolicy::Reject => Err(ReasoningReject::unsupported(level.as_str())),
                    DegradePolicy::AllowDegrade => Ok(capability_normalize(level, capability)),
                }
            }
        }
    }
}

/// effort 是否出现在能力白名单（按 ThinkingIntensity 档位序对应判定）。
fn in_whitelist(effort: ReasoningEffort, capability: &ThinkingCapability) -> bool {
    effort_to_intensity(effort).is_some_and(|intensity| capability.levels.contains(&intensity))
}

/// 旧降级钳制（兼容开关 AllowDegrade 用）：ReasoningEffort → ThinkingIntensity → 钳制。
/// 返回规范档位（effort 与能力白名单档位序一一对应）。
fn capability_normalize(
    effort: ReasoningEffort,
    capability: &ThinkingCapability,
) -> Option<ReasoningEffort> {
    let intensity = effort_to_intensity(effort)?;
    intensity_to_effort(super::normalize_thinking_intensity(intensity, capability)?)
}

/// ReasoningEffort → ThinkingIntensity（off/auto 无档位对应 → None）。
fn effort_to_intensity(effort: ReasoningEffort) -> Option<ThinkingIntensity> {
    use ReasoningEffort as E;
    use ThinkingIntensity as I;
    Some(match effort {
        E::Minimal => I::Minimal,
        E::Low => I::Low,
        E::Medium => I::Medium,
        E::High => I::High,
        E::Xhigh => I::Xhigh,
        E::Max => I::Max,
        E::Off | E::Auto => return None,
    })
}

/// ThinkingIntensity → ReasoningEffort（off 无 effort 对应 → None）。
fn intensity_to_effort(intensity: ThinkingIntensity) -> Option<ReasoningEffort> {
    use ReasoningEffort as E;
    use ThinkingIntensity as I;
    Some(match intensity {
        I::Minimal => E::Minimal,
        I::Low => E::Low,
        I::Medium => E::Medium,
        I::High => E::High,
        I::Xhigh => E::Xhigh,
        I::Max => E::Max,
        I::Off => return None,
    })
}
