//! 模型系列能力声明域（SR-06e · 拆分 · ≠ EL）
//!
//! 声明模型思考能力 [ThinkingCapability] 与默认非思考能力 [NO_THINKING]。
//! 已物理移除已废弃的模型系列静态推断表与猜词入口（Audit-13 单轨收敛）。

use super::{ReasoningFormat, ReasoningVendor, ThinkingIntensity};

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
