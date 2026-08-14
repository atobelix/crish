//! 模型系列能力映射域（SR-06e · 拆分 · ≠ EL）
//!
//! 自 request/vendor.rs 拆出的实现域：模型思考能力映射表
//! （[MODEL_SERIES_CAPABILITIES]，对齐 `shared:thinking-intensity.ts:80-127`
//! 最长前缀命中）与 [infer_thinking_capability] 推断入口。
//! 门面（request/vendor.rs）re-export [infer_thinking_capability]，对外路径不变。

use super::{ReasoningFormat, ReasoningVendor, ThinkingCapability, ThinkingIntensity, NO_THINKING};

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
        if lower.starts_with(entry.0) && best.is_none_or(|current| entry.0.len() > current.0.len())
        {
            best = Some(entry);
        }
    }
    best.map_or(NO_THINKING, |entry| entry.1)
}
