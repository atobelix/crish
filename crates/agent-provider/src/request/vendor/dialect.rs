//! wire 方言与模型级改名域（多模型适配战役 R4 T4.2+T4.5 一体 · G6-a + G5-c + G6-c）
//!
//! 自 request/vendor.rs 拆出的实现域：
//! - **模型级 wire 拼写改名（T4.2 / G6-a）**：[resolve_wire_spelling_with_tiers] 在
//!   effort→wire 换算链前插「模型级覆盖」——命中模型级档位载体用其 wire 拼写（改名如
//!   `{medium:"high"}` → "high"），未命中回落系列级换算（[super::normalize_reasoning_effort]）。
//! - **开关/嵌套型 wire 方言（T4.5 / G5-c）**：qwen `enable_thinking`、zai `thinking:{type}`、
//!   openrouter 嵌套 `reasoning:{effort}`（对齐 pi-ai `openai-completions.js:560-641`
//!   方言矩阵 2-3 高频）。
//! - **off 显式 disabled（T4.5 / G6-c）**：deepseek 方言 off → 显式
//!   `thinking:{type:"disabled"}`（无 reasoning_effort，对齐 pi-ai openai-completions.js:590-592
//!   与 DSH llm-deepseek README.md:44）。
//!
//! 门面（request/vendor.rs）re-export 全部公开符号，对外路径不变。

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::reject::{DegradePolicy, ReasoningEffortState, ReasoningReject};
use super::vendor_wire::normalize_reasoning_effort;
use super::{ReasoningEffort, ReasoningFormat, ReasoningVendor, ThinkingCapability};
use crate::config::Endpoint;

/// 模型级 wire 拼写改名（T4.2 / G6-a）：档位载体（档位 → Option<wire 拼写>）命中提供档
/// → 返回改名/同名 wire 拼写；隐藏档（None 值）与未收录档 → 回落系列级换算。
///
/// 收敛点：effort→wire 链上「模型级覆盖」插点；未命中即沿用
/// [super::normalize_reasoning_effort]（系列级换算），两级同链、单真源。
/// 隐藏档返回 None（由上层走拒绝/省略语义）。
pub fn resolve_wire_spelling_with_tiers(
    effort: ReasoningEffort,
    tiers: Option<&BTreeMap<String, Option<String>>>,
) -> Option<String> {
    if let Some(map) = tiers {
        if let Some(wire) = map.get(effort.as_str()) {
            return wire.clone();
        }
    }
    normalize_reasoning_effort(effort).map(str::to_owned)
}

/// 构建 vendor 原生思考 wire（R4 T4.1+T4.2+T4.5 一体化协调入口）。
///
/// 组合：T4.1 拒绝（[super::resolve_reasoning_level]）→ T4.2 模型级改名
/// （[resolve_wire_spelling_with_tiers]）→ T4.5 方言与 off disabled（本函数分派）。
/// `capability` 提供档位白名单与方言模式；`dialect` 显式指定方言时优先（供 T4.5 测试）。
///
/// 语义要点：
/// - `Omitted` → `Ok(None)`（不发送，保留提供方默认）；
/// - 显式/默认档位不在能力内 → `Err(ReasoningReject)`（默认策略不降级）；
/// - deepseek + `Explicit(Off)` → `thinking:{type:"disabled"}`（无 effort）。
pub fn build_reasoning_wire(
    endpoint: Endpoint,
    tiers: Option<&BTreeMap<String, Option<String>>>,
    effort: ReasoningEffortState,
    vendor: Option<ReasoningVendor>,
    capability: &ThinkingCapability,
    dialect: Option<ReasoningFormat>,
    policy: DegradePolicy,
) -> Result<Option<Value>, ReasoningReject> {
    // 0. deepseek 方言 off 显式 disabled：早退（无 effort wire）。
    if matches!(effort, ReasoningEffortState::Explicit(ReasoningEffort::Off))
        && matches!(
            vocabulary_vendor(vendor, capability),
            ReasoningVendor::Deepseek
        )
    {
        return Ok(Some(json!({ "thinking": { "type": "disabled" } })));
    }

    // 1. T4.1 三态 → 待发送档位（拒绝/省略/降级收敛于此）。
    let active = match super::resolve_reasoning_level(effort, capability, policy)? {
        Some(level) => level,
        None => return Ok(None),
    };

    // 2. T4.2 模型级 wire 改名（未命中回落系列级）。
    let wire = resolve_wire_spelling_with_tiers(active, tiers)
        .ok_or_else(|| ReasoningReject::hidden_tier(active))?;

    // 3. T4.5 方言分派。
    let format = dialect.unwrap_or(capability.format);
    Ok(Some(dialect_wire(
        endpoint, active, &wire, capability, format,
    )))
}

/// 方言 wire 构造（T4.5 / G5-c + G6-c）：按 `ReasoningFormat` 分派。
fn dialect_wire(
    endpoint: Endpoint,
    effort: ReasoningEffort,
    wire: &str,
    capability: &ThinkingCapability,
    format: ReasoningFormat,
) -> Value {
    use ReasoningFormat as F;
    match format {
        F::ReasoningEffort => {
            if capability.vendor == ReasoningVendor::Openai && endpoint == Endpoint::Responses {
                json!({ "reasoning": { "effort": wire } })
            } else {
                json!({ "reasoning_effort": wire })
            }
        }
        F::ThinkingBudget => json!({
            "thinking": { "type": "enabled", "budget_tokens": budget_for(effort) },
        }),
        F::ThinkingAdaptive => json!({
            "thinking": { "type": "adaptive", "display": "summarized" },
            "effort": super::adaptive_effort_wire(effort),
        }),
        F::ThinkingLevel => json!({
            "generation_config": { "thinking_level": level_for(effort) },
        }),
        F::QwenEnableThinking => {
            json!({ "enable_thinking": !matches!(effort, ReasoningEffort::Off) })
        }
        F::ZaiThinking => json!({
            "thinking": { "type": "enabled", "clear_thinking": false },
            "reasoning_effort": wire,
        }),
        F::OpenRouterReasoning => json!({ "reasoning": { "effort": wire } }),
        F::None => json!({}),
    }
}

/// 词汇 vendor 判定（显式优先；auto/None 回落能力表）。
fn vocabulary_vendor(
    vendor: Option<ReasoningVendor>,
    capability: &ThinkingCapability,
) -> ReasoningVendor {
    vendor
        .filter(|v| *v != ReasoningVendor::Auto)
        .unwrap_or(capability.vendor)
}

// 换算委托（与 request/vendor_wire.rs 单真源，避免本域重复实现）：

fn budget_for(effort: ReasoningEffort) -> u64 {
    super::effort_to_budget_tokens(effort)
}

fn level_for(effort: ReasoningEffort) -> &'static str {
    super::effort_to_gemini_thinking_level(effort)
}
