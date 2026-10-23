//! vendor 机制与思考透传（任务书 B2.6；02-provider-semantics.md §五 #2/#3、§一.4；01 D5）
//!
//! - [infer_reasoning_vendor]：baseUrl/model 关键字推断（vendor 路由，非思考能力猜测）
//! - 档位换算纯函数（[vendor_wire]：normalize / budget_tokens / gemini thinking_level）
//! - [resolve_reasoning_level]：请求面档位白名单拒绝校验（R4 T4.1，三态+开关）
//!
//! SSOT（轨A 净清）：出站思考键唯一入口 = `assemble_thinking_dialect`
//! （`request/vendor/dialect.rs`，四个 builder 共用）。已物理删除旧双轨入口：
//! `reasoning_effort_object` / `resolve_thinking_params` / `build_reasoning_wire` /
//! `reasoning_effort_headers*` / `is_adaptive_thinking_model` /
//! `infer_thinking_capability`——无生产调用者，已物理移除。
//! 自适应思考由 yaml 字典值 `High: "adaptive"` 经 dialect 表达，不触 MODEL_SERIES。
//!
//! SR-06e · 拆分 · ≠ EL：门面文件。实现域拆分（测试旁挂 vendor_tests.rs）：
//! [vendor_capability] 系列能力声明 · [vendor_wire] wire 换算 ·
//! [reject] R4 T4.1 拒绝校验（三态+开关）。

#[path = "vendor/reject.rs"]
mod reject;
#[path = "vendor_capability.rs"]
mod vendor_capability;
#[path = "vendor_wire.rs"]
mod vendor_wire;

// dialect 单模块（plans/04 §3.2）：只由 `build.rs` 的 `pub mod dialect` 编译，
// 本模块不再声明第二个 `#[path]` 副本——四个 builder 共用同一
// `assemble_thinking_dialect`，杜绝双份类型与双实现漂移。
pub use reject::{resolve_reasoning_level, DegradePolicy, ReasoningEffortState, ReasoningReject};
pub use vendor_capability::{ThinkingCapability, NO_THINKING};
pub use vendor_wire::{
    effort_to_budget_tokens, effort_to_gemini_thinking_level, normalize_reasoning_effort,
    thinking_to_budget_tokens, thinking_to_gemini_thinking_level,
};

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
    /// qwen 开关型方言：enable_thinking（G5-c；pi-ai openai-completions.js:571-573）
    QwenEnableThinking,
    /// zai/GLM 方言：thinking{type:"enabled",clear_thinking:false} + reasoning_effort（G5-c）
    ZaiThinking,
    /// openrouter 嵌套方言：reasoning:{effort}（G5-c；pi-ai openai-completions.js:598-609）
    OpenRouterReasoning,
    /// 不支持思考
    None,
}

/// 推断 reasoning vendor（对齐 `shared:thinking-intensity.ts:154-173`；02 §五 #2）。
/// 优先级 baseUrl 关键字 → model 前缀：anthropic/deepseek/gemini/openai(gpt/o1/o3/o4)/qwen/glm/kimi；
/// 未命中 → auto（按 endpoint/format 退化）。
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

// reasoning-effort 相关请求头的旧入口已物理删除（轨A SSOT）：
// 生产 anthropic-beta 头由壳层 `headers.rs` 按显式档位判定（不触 MODEL_SERIES），
// 自适应思考由 yaml 字典值 `"adaptive"` 经 `assemble_thinking_dialect` 表达。

/// 归一化思考强度（对齐 `shared:thinking-intensity.ts:182-200`）：off/不支持 → None；
/// 档位缺失降级（xhigh→high、minimal→low、其余取最大支持档位）。
///
/// 注意（R4 T4.1）：保留为**降级钳制**辅助，供 [DegradePolicy::AllowDegrade] 使用；
/// 默认拒绝语义走 [resolve_reasoning_level]。
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

#[cfg(test)]
#[path = "vendor_tests.rs"]
mod tests;
