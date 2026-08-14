//! request/vendor.rs 测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 自 vendor.rs `mod tests` 整段搬入，零删除零合并；测试名与断言形状不变。

use super::*;

// ── inferReasoningVendor（02 §五 #2 语义）──

#[test]
fn infer_vendor_by_base_url_keyword() {
    assert_eq!(
        infer_reasoning_vendor(Some("https://api.anthropic.com"), None),
        ReasoningVendor::Anthropic
    );
    assert_eq!(
        infer_reasoning_vendor(Some("https://api.deepseek.com"), None),
        ReasoningVendor::Deepseek
    );
    assert_eq!(
        infer_reasoning_vendor(Some("https://generativelanguage.googleapis.com"), None),
        ReasoningVendor::Gemini
    );
    assert_eq!(
        infer_reasoning_vendor(Some("https://api.openai.com"), None),
        ReasoningVendor::Openai
    );
}

#[test]
fn infer_vendor_by_model_prefix() {
    assert_eq!(
        infer_reasoning_vendor(None, Some("claude-sonnet-4")),
        ReasoningVendor::Anthropic
    );
    assert_eq!(
        infer_reasoning_vendor(None, Some("deepseek-reasoner")),
        ReasoningVendor::Deepseek
    );
    assert_eq!(
        infer_reasoning_vendor(None, Some("gemini-2.5-flash")),
        ReasoningVendor::Gemini
    );
    assert_eq!(
        infer_reasoning_vendor(None, Some("gpt-4o")),
        ReasoningVendor::Openai
    );
    assert_eq!(
        infer_reasoning_vendor(None, Some("o3-mini")),
        ReasoningVendor::Openai
    );
    assert_eq!(
        infer_reasoning_vendor(None, Some("qwen3-max")),
        ReasoningVendor::Qwen
    );
    assert_eq!(
        infer_reasoning_vendor(None, Some("glm-5")),
        ReasoningVendor::Glm
    );
    assert_eq!(
        infer_reasoning_vendor(None, Some("kimi-2.5")),
        ReasoningVendor::Kimi
    );
}

#[test]
fn infer_vendor_unrecognized_falls_back_to_auto() {
    assert_eq!(
        infer_reasoning_vendor(Some("https://unknown.example"), None),
        ReasoningVendor::Auto
    );
    assert_eq!(
        infer_reasoning_vendor(None, Some("unknown-model")),
        ReasoningVendor::Auto
    );
    assert_eq!(infer_reasoning_vendor(None, None), ReasoningVendor::Auto);
}

// ── reasoningEffortObject（vendor 分支）──

#[test]
fn effort_object_vendor_auto_chat_completions_uses_reasoning_effort() {
    // auto 退化：chat-completions → reasoning_effort（02 §五 #2）
    assert_eq!(
        reasoning_effort_object(
            Endpoint::ChatCompletions,
            "m",
            Some(ReasoningEffort::High),
            None,
            None,
        ),
        Some(json!({ "reasoning_effort": "high" }))
    );
}

#[test]
fn effort_object_vendor_auto_responses_uses_reasoning_nested() {
    assert_eq!(
        reasoning_effort_object(
            Endpoint::Responses,
            "m",
            Some(ReasoningEffort::Low),
            None,
            None,
        ),
        Some(json!({ "reasoning": { "effort": "low" } }))
    );
}

#[test]
fn effort_object_format_overrides_endpoint_in_auto() {
    // 显式 format=responses 时即使 chat-completions endpoint 也用 reasoning.effort
    assert_eq!(
        reasoning_effort_object(
            Endpoint::ChatCompletions,
            "m",
            Some(ReasoningEffort::Medium),
            Some(ReasoningEffortFormat::Responses),
            None,
        ),
        Some(json!({ "reasoning": { "effort": "medium" } }))
    );
}

#[test]
fn effort_object_openai_vendor_split_by_endpoint() {
    assert_eq!(
        reasoning_effort_object(
            Endpoint::ChatCompletions,
            "gpt-5",
            Some(ReasoningEffort::High),
            None,
            Some(ReasoningVendor::Openai)
        ),
        Some(json!({ "reasoning_effort": "high" }))
    );
    assert_eq!(
        reasoning_effort_object(
            Endpoint::Responses,
            "gpt-5",
            Some(ReasoningEffort::High),
            None,
            Some(ReasoningVendor::Openai)
        ),
        Some(json!({ "reasoning": { "effort": "high" } }))
    );
}

#[test]
fn effort_object_anthropic_uses_thinking_budget() {
    assert_eq!(
        reasoning_effort_object(
            Endpoint::ChatCompletions,
            "claude-x",
            Some(ReasoningEffort::High),
            None,
            Some(ReasoningVendor::Anthropic)
        ),
        Some(json!({ "thinking": { "type": "enabled", "budget_tokens": 4096 } }))
    );
    // xhigh 保留 8192 语义
    assert_eq!(
        reasoning_effort_object(
            Endpoint::ChatCompletions,
            "claude-x",
            Some(ReasoningEffort::Xhigh),
            None,
            Some(ReasoningVendor::Anthropic)
        ),
        Some(json!({ "thinking": { "type": "enabled", "budget_tokens": 8192 } }))
    );
}

#[test]
fn effort_object_deepseek_uses_only_reasoning_effort() {
    assert_eq!(
        reasoning_effort_object(
            Endpoint::ChatCompletions,
            "deepseek-reasoner",
            Some(ReasoningEffort::Medium),
            None,
            Some(ReasoningVendor::Deepseek)
        ),
        Some(json!({ "reasoning_effort": "medium" }))
    );
}

#[test]
fn effort_object_gemini_uses_thinking_level() {
    assert_eq!(
        reasoning_effort_object(
            Endpoint::ChatCompletions,
            "gemini-2.5",
            Some(ReasoningEffort::High),
            None,
            Some(ReasoningVendor::Gemini)
        ),
        Some(json!({ "generation_config": { "thinking_level": "high" } }))
    );
}

#[test]
fn effort_object_off_auto_and_none_format_yield_nothing() {
    for effort in [ReasoningEffort::Off, ReasoningEffort::Auto] {
        assert_eq!(
            reasoning_effort_object(
                Endpoint::ChatCompletions,
                "m",
                Some(effort),
                None,
                Some(ReasoningVendor::Anthropic)
            ),
            None,
            "effort={effort:?} 不注入",
        );
    }
    assert_eq!(
        reasoning_effort_object(
            Endpoint::ChatCompletions,
            "m",
            Some(ReasoningEffort::High),
            Some(ReasoningEffortFormat::None),
            None,
        ),
        None
    );
}

#[test]
fn effort_object_xhigh_normalizes_to_high() {
    // 归一化：xhigh → high（发送层 wire 值）
    assert_eq!(
        reasoning_effort_object(
            Endpoint::ChatCompletions,
            "m",
            Some(ReasoningEffort::Xhigh),
            None,
            None
        ),
        Some(json!({ "reasoning_effort": "high" }))
    );
}

// ── anthropic-beta 头（02 §五 #3）──

#[test]
fn anthropic_beta_header_only_for_anthropic_with_active_effort() {
    // 仅 vendor=anthropic 且 effort 非 off/auto
    assert_eq!(
        reasoning_effort_headers(
            Some(ReasoningVendor::Anthropic),
            Some(ReasoningEffort::High)
        ),
        Some(("anthropic-beta", "interleaved-thinking-2025-05-14"))
    );
    // off / auto 不发
    assert_eq!(
        reasoning_effort_headers(Some(ReasoningVendor::Anthropic), Some(ReasoningEffort::Off)),
        None
    );
    assert_eq!(
        reasoning_effort_headers(
            Some(ReasoningVendor::Anthropic),
            Some(ReasoningEffort::Auto)
        ),
        None
    );
    // 非 anthropic vendor 不发
    assert_eq!(
        reasoning_effort_headers(Some(ReasoningVendor::Openai), Some(ReasoningEffort::High)),
        None
    );
    assert_eq!(
        reasoning_effort_headers(Some(ReasoningVendor::Deepseek), Some(ReasoningEffort::High)),
        None
    );
    // vendor 未指定（auto）不发
    assert_eq!(
        reasoning_effort_headers(None, Some(ReasoningEffort::High)),
        None
    );
    // effort 缺失不发
    assert_eq!(
        reasoning_effort_headers(Some(ReasoningVendor::Anthropic), None),
        None
    );
}

// ── thinking 能力推断与归一化（01 D5）──

#[test]
fn infer_capability_by_model_prefix() {
    let cap = infer_thinking_capability("o3-mini");
    assert!(cap.supported);
    assert_eq!(cap.vendor, ReasoningVendor::Openai);
    assert_eq!(cap.format, ReasoningFormat::ReasoningEffort);

    let cap = infer_thinking_capability("claude-sonnet-4-20250514");
    assert!(cap.supported);
    assert_eq!(cap.vendor, ReasoningVendor::Anthropic);
    assert_eq!(cap.format, ReasoningFormat::ThinkingBudget);
    assert!(cap.levels.contains(&ThinkingIntensity::Xhigh));

    let cap = infer_thinking_capability("gemini-2.5-flash");
    assert!(cap.supported);
    assert_eq!(cap.format, ReasoningFormat::ThinkingLevel);
    assert!(!cap.levels.contains(&ThinkingIntensity::Xhigh));

    let cap = infer_thinking_capability("deepseek-reasoner");
    assert!(cap.supported);
    assert_eq!(cap.vendor, ReasoningVendor::Deepseek);

    // 最长前缀命中：deepseek-chat 覆盖 deepseek 前缀 → 不支持
    assert!(!infer_thinking_capability("deepseek-chat").supported);
    assert!(!infer_thinking_capability("deepseek-v3").supported);
    assert!(!infer_thinking_capability("gpt-4o").supported);
    assert!(!infer_thinking_capability("unknown-model").supported);
}

#[test]
fn normalize_intensity_respects_capability() {
    let claude = infer_thinking_capability("claude-sonnet-4");
    let gemini = infer_thinking_capability("gemini-2.5-flash");
    let unsupported = infer_thinking_capability("gpt-4o");

    // off → None
    assert_eq!(
        normalize_thinking_intensity(ThinkingIntensity::Off, &claude),
        None
    );
    // 不支持的模型 → None
    assert_eq!(
        normalize_thinking_intensity(ThinkingIntensity::High, &unsupported),
        None
    );
    // Gemini xhigh 降级为 high
    assert_eq!(
        normalize_thinking_intensity(ThinkingIntensity::Xhigh, &gemini),
        Some(ThinkingIntensity::High)
    );
    // Claude 保留 xhigh
    assert_eq!(
        normalize_thinking_intensity(ThinkingIntensity::Xhigh, &claude),
        Some(ThinkingIntensity::Xhigh)
    );
    // o1 系 minimal 降级为 low
    let o1 = infer_thinking_capability("o1");
    assert_eq!(
        normalize_thinking_intensity(ThinkingIntensity::Minimal, &o1),
        Some(ThinkingIntensity::Low)
    );
}

#[test]
fn resolve_thinking_params_by_vendor() {
    let openai = infer_thinking_capability("o3-mini");
    assert_eq!(
        resolve_thinking_params(&openai, ThinkingIntensity::High, Endpoint::ChatCompletions),
        json!({ "reasoning_effort": "high" })
    );
    assert_eq!(
        resolve_thinking_params(&openai, ThinkingIntensity::High, Endpoint::Responses),
        json!({ "reasoning": { "effort": "high" } })
    );

    let anthropic = infer_thinking_capability("claude-sonnet-4");
    assert_eq!(
        resolve_thinking_params(
            &anthropic,
            ThinkingIntensity::High,
            Endpoint::ChatCompletions
        ),
        json!({ "thinking": { "type": "enabled", "budget_tokens": 4096 } })
    );

    let gemini = infer_thinking_capability("gemini-2.5-flash");
    assert_eq!(
        resolve_thinking_params(&gemini, ThinkingIntensity::Xhigh, Endpoint::ChatCompletions),
        json!({ "generation_config": { "thinking_level": "high" } })
    );

    let deepseek = infer_thinking_capability("deepseek-reasoner");
    assert_eq!(
        resolve_thinking_params(
            &deepseek,
            ThinkingIntensity::Medium,
            Endpoint::ChatCompletions
        ),
        json!({ "reasoning_effort": "medium" })
    );

    // off 与不支持 → 空对象
    assert_eq!(
        resolve_thinking_params(
            &anthropic,
            ThinkingIntensity::Off,
            Endpoint::ChatCompletions
        ),
        json!({})
    );
    assert_eq!(
        resolve_thinking_params(
            &unsupported(),
            ThinkingIntensity::High,
            Endpoint::ChatCompletions
        ),
        json!({})
    );
}

fn unsupported() -> ThinkingCapability {
    infer_thinking_capability("gpt-4o")
}

#[test]
fn budget_tokens_and_gemini_level_mappings() {
    assert_eq!(thinking_to_budget_tokens(ThinkingIntensity::Minimal), 128);
    assert_eq!(thinking_to_budget_tokens(ThinkingIntensity::Low), 1024);
    assert_eq!(thinking_to_budget_tokens(ThinkingIntensity::Medium), 2048);
    assert_eq!(thinking_to_budget_tokens(ThinkingIntensity::High), 4096);
    assert_eq!(thinking_to_budget_tokens(ThinkingIntensity::Xhigh), 8192);

    assert_eq!(
        thinking_to_gemini_thinking_level(ThinkingIntensity::Minimal),
        "minimal"
    );
    assert_eq!(
        thinking_to_gemini_thinking_level(ThinkingIntensity::Xhigh),
        "high"
    );
    assert_eq!(
        effort_to_gemini_thinking_level(ReasoningEffort::Xhigh),
        "high"
    );
    assert_eq!(effort_to_budget_tokens(ReasoningEffort::High), 4096);
}

// ── G7：Anthropic 自适应思考（Opus 4.7+ / Sonnet 5+）──

#[test]
fn adaptive_model_detection_by_series_prefix() {
    // 新代际：Opus 4.7+ / Sonnet 5+ / Fable 5 / Mythos 5 启用 adaptive 档位集
    for model in [
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-fable-5",
        "claude-mythos-5",
        "claude-4-7-opus", // SAP 倒置形态
        "claude-4-8-opus", // SAP 倒置形态
    ] {
        let cap = infer_thinking_capability(model);
        assert!(cap.supported, "{model} 应支持思考");
        assert_eq!(
            cap.format,
            ReasoningFormat::ThinkingAdaptive,
            "{model} 应为 adaptive 形态"
        );
        assert!(
            cap.levels.contains(&ThinkingIntensity::Xhigh),
            "{model} 应含 xhigh"
        );
        assert!(
            cap.levels.contains(&ThinkingIntensity::Max),
            "{model} 应含 max"
        );
        assert!(
            !cap.levels.contains(&ThinkingIntensity::Minimal),
            "{model} 不应含 minimal"
        );
    }
    // 旧代际保持既有映射（ThinkingBudget + 含 xhigh、无 max）
    for model in [
        "claude-opus-4-6",
        "claude-opus-4-5",
        "claude-sonnet-4-6",
        "claude-sonnet-4",
    ] {
        let cap = infer_thinking_capability(model);
        assert_eq!(
            cap.format,
            ReasoningFormat::ThinkingBudget,
            "{model} 保持 budget 形态"
        );
        assert!(
            !cap.levels.contains(&ThinkingIntensity::Max),
            "{model} 不应含 max"
        );
    }
}

#[test]
fn adaptive_effort_object_injects_display_summarized() {
    // 新代际：thinking{type:adaptive,display:summarized} + effort（xhigh/max 直发）
    assert_eq!(
        reasoning_effort_object(
            Endpoint::ChatCompletions,
            "claude-opus-4-7",
            Some(ReasoningEffort::Max),
            None,
            Some(ReasoningVendor::Anthropic)
        ),
        Some(
            json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "max" })
        )
    );
    assert_eq!(
        reasoning_effort_object(
            Endpoint::ChatCompletions,
            "claude-opus-4-8",
            Some(ReasoningEffort::Xhigh),
            None,
            Some(ReasoningVendor::Anthropic)
        ),
        Some(
            json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "xhigh" })
        )
    );
    assert_eq!(
        reasoning_effort_object(
            Endpoint::ChatCompletions,
            "claude-sonnet-5",
            Some(ReasoningEffort::High),
            None,
            Some(ReasoningVendor::Anthropic)
        ),
        Some(
            json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "high" })
        )
    );
    // minimal 不在 adaptive 档位集 → 降级 low
    assert_eq!(
        reasoning_effort_object(
            Endpoint::ChatCompletions,
            "claude-opus-4-7",
            Some(ReasoningEffort::Minimal),
            None,
            Some(ReasoningVendor::Anthropic)
        ),
        Some(
            json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "low" })
        )
    );
    // 旧代际保持 enabled+budget_tokens 既有映射（Max 走预算兜底）
    assert_eq!(
        reasoning_effort_object(
            Endpoint::ChatCompletions,
            "claude-opus-4-6",
            Some(ReasoningEffort::Max),
            None,
            Some(ReasoningVendor::Anthropic)
        ),
        Some(json!({ "thinking": { "type": "enabled", "budget_tokens": 16384 } }))
    );
}

#[test]
fn adaptive_thinking_params_inject_display_summarized() {
    let cap = infer_thinking_capability("claude-opus-4-7");
    assert_eq!(
        resolve_thinking_params(&cap, ThinkingIntensity::High, Endpoint::ChatCompletions),
        json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "high" })
    );
    assert_eq!(
        resolve_thinking_params(&cap, ThinkingIntensity::Xhigh, Endpoint::ChatCompletions),
        json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "xhigh" })
    );
    assert_eq!(
        resolve_thinking_params(&cap, ThinkingIntensity::Max, Endpoint::ChatCompletions),
        json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "max" })
    );
    // minimal 在 adaptive 档位集外 → 归一化降级 low
    assert_eq!(
        resolve_thinking_params(&cap, ThinkingIntensity::Minimal, Endpoint::ChatCompletions),
        json!({ "thinking": { "type": "adaptive", "display": "summarized" }, "effort": "low" })
    );
    // off → 空对象（不注入）
    assert_eq!(
        resolve_thinking_params(&cap, ThinkingIntensity::Off, Endpoint::ChatCompletions),
        json!({})
    );
    // 旧代际：max 降级到最大支持档位 xhigh → 保持 enabled+budget_tokens
    let old = infer_thinking_capability("claude-sonnet-4");
    assert_eq!(
        resolve_thinking_params(&old, ThinkingIntensity::Max, Endpoint::ChatCompletions),
        json!({ "thinking": { "type": "enabled", "budget_tokens": 8192 } })
    );
}

#[test]
fn adaptive_effort_enum_and_header_extensions() {
    assert_eq!(ReasoningEffort::Max.as_str(), "max");
    assert_eq!(ThinkingIntensity::Max.as_str(), "max");
    assert_eq!(
        normalize_reasoning_effort(ReasoningEffort::Max),
        Some("max")
    );
    assert_eq!(effort_to_budget_tokens(ReasoningEffort::Max), 16384);
    assert_eq!(thinking_to_budget_tokens(ThinkingIntensity::Max), 16384);
    assert_eq!(
        effort_to_gemini_thinking_level(ReasoningEffort::Max),
        "high"
    );
    assert_eq!(
        thinking_to_gemini_thinking_level(ThinkingIntensity::Max),
        "high"
    );
    // anthropic-beta 头把 max 视为活跃档位
    assert_eq!(
        reasoning_effort_headers(Some(ReasoningVendor::Anthropic), Some(ReasoningEffort::Max)),
        Some(("anthropic-beta", "interleaved-thinking-2025-05-14"))
    );
}
