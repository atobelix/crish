//! Anthropic 请求体选项与默认 Token 计算（自 build_anthropic.rs 平移）。

use super::super::cache::CachePolicy;
use super::super::tools::ToolChoice;
use super::super::vendor::ReasoningEffort;
use super::super::ThinkingIntensity;
use crate::models::catalog_types::ThinkingFormat;
use indexmap::IndexMap;

/// 默认 Anthropic 物理最大输出 Token 限制（64K）
pub const DEFAULT_ANTHROPIC_MAX_OUTPUT: u64 = 64_000;

/// Anthropic 请求体构建选项（对齐 pi-ai buildParams 的 opts 子集）
#[derive(Debug, Clone, Default)]
pub struct AnthropicRequestOptions {
    /// 模型名
    pub model: Option<String>,
    /// 是否流式（缺省 false；流式头由发送层决定）
    pub stream: Option<bool>,
    pub temperature: Option<f64>,
    /// max_tokens（Anthropic 官方恒 `max_tokens`，无三字段兼容）
    pub max_tokens: Option<u64>,
    /// reasoning effort（旧代际 → thinking.enabled budget_tokens）
    pub reasoning_effort: Option<ReasoningEffort>,
    /// 01 D5 thinkingIntensity 透传（提供时覆盖 reasoning_effort 换算）
    pub thinking_intensity: Option<ThinkingIntensity>,
    /// 显式下发的精确 Token 预算（1024 ~ 64000）
    pub thinking_budget: Option<u64>,
    /// 用户在 models.yaml 中配置的思考拍平映射（TitleCase → wire）
    pub thinking_map: Option<IndexMap<String, String>>,
    /// 显式配置的思考方言组装格式（思考键只来自 dialect）
    pub thinking_format: Option<ThinkingFormat>,
    pub tool_choice: Option<ToolChoice>,
    /// 显式 PromptCache 策略
    pub cache: Option<CachePolicy>,
}

/// 根据模型名称与思考预算动态解析默认 max_tokens（修正 BC08-11 长回答上限截断问题）
pub fn default_anthropic_max_tokens(model: Option<&str>, budget: Option<u64>) -> u64 {
    let min_budget_tokens = budget.map(|b| b.saturating_add(4096));

    let base_default = if let Some(m) = model {
        let m_lower = m.to_ascii_lowercase();
        if m_lower.contains("3-7") || m_lower.contains("3.7") {
            // Claude 3.7 Sonnet 官方原生支持 64K 最大输出
            64_000
        } else if m_lower.contains("3-5") || m_lower.contains("3.5") {
            // Claude 3.5 Sonnet & Claude 3.5 Haiku 官方最大输出 8192
            8_192
        } else if m_lower.contains("opus") {
            // Claude 3 Opus 官方最大输出 4096
            4_096
        } else if m_lower.contains("claude-3") {
            // Claude 3 (legacy) 官方最大输出 4096
            4_096
        } else {
            // 现代 Anthropic 默认合理输出上限
            8_192
        }
    } else {
        8_192
    };

    if let Some(min) = min_budget_tokens {
        base_default.max(min)
    } else {
        base_default
    }
}
