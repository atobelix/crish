//! request/vendor.rs 测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 轨A SSOT 净清后：只保留仍存在的生产符号测试（infer_reasoning_vendor /
//! normalize_thinking_intensity / 换算纯函数 / resolve_reasoning_level 拒绝路径 /
//! deprecated 的 infer_thinking_capability 行为钉死）。已删除的双轨入口
//! （reasoning_effort_object / resolve_thinking_params / build_reasoning_wire /
//! reasoning_effort_headers*）的测试随函数一并移除——出站思考键唯一入口 =
//! assemble_thinking_dialect（dialect.rs 单测 + build_chat_tests 钉死）。

use super::*;
use crate::config::Endpoint;

// ── inferReasoningVendor（02 §五 #2 语义；vendor 路由，非思考能力猜测）──

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

// ── 换算纯函数（vendor_wire）──

#[test]
fn normalize_reasoning_effort_maps() {
    assert_eq!(normalize_reasoning_effort(ReasoningEffort::Off), None);
    assert_eq!(normalize_reasoning_effort(ReasoningEffort::Auto), None);
    assert_eq!(
        normalize_reasoning_effort(ReasoningEffort::Xhigh),
        Some("high")
    );
    assert_eq!(
        normalize_reasoning_effort(ReasoningEffort::Max),
        Some("max")
    );
    assert_eq!(
        normalize_reasoning_effort(ReasoningEffort::High),
        Some("high")
    );
}

#[test]
fn budget_and_level_conversion_tables() {
    use ThinkingIntensity as I;
    assert_eq!(thinking_to_budget_tokens(I::Minimal), 1024);
    assert_eq!(thinking_to_budget_tokens(I::Low), 1024);
    assert_eq!(thinking_to_budget_tokens(I::Medium), 2048);
    assert_eq!(thinking_to_budget_tokens(I::High), 4096);
    assert_eq!(thinking_to_budget_tokens(I::Xhigh), 8192);
    assert_eq!(effort_to_budget_tokens(ReasoningEffort::High), 4096);
    assert_eq!(effort_to_budget_tokens(ReasoningEffort::Max), 16384);
    assert_eq!(
        effort_to_gemini_thinking_level(ReasoningEffort::Xhigh),
        "high"
    );
    assert_eq!(
        effort_to_gemini_thinking_level(ReasoningEffort::Max),
        "high"
    );
    assert_eq!(
        thinking_to_gemini_thinking_level(I::Minimal),
        "minimal"
    );
    assert_eq!(
        thinking_to_gemini_thinking_level(I::Xhigh),
        "high"
    );
    assert_eq!(
        thinking_to_gemini_thinking_level(I::Max),
        "high"
    );
}

// ── deprecated infer_thinking_capability：行为钉死（禁止再接入生产出站路径）──

#[test]
#[allow(deprecated)]
fn infer_capability_series_table_behavior() {
    use crate::request::ReasoningFormat as F;
    let cap = infer_thinking_capability("o3-mini");
    assert!(cap.supported);
    assert_eq!(cap.format, F::ReasoningEffort);

    let cap = infer_thinking_capability("claude-sonnet-4-20250514");
    assert!(cap.supported);
    assert_eq!(cap.format, F::ThinkingBudget);

    let cap = infer_thinking_capability("claude-opus-4-7");
    assert!(cap.supported);
    assert_eq!(
        cap.format,
        F::ThinkingAdaptive,
        "Opus 4.7+ 新代际应为 ThinkingAdaptive"
    );

    let cap = infer_thinking_capability("gemini-2.5-flash");
    assert!(cap.supported);
    assert_eq!(cap.format, F::ThinkingLevel);

    let cap = infer_thinking_capability("deepseek-reasoner");
    assert!(cap.supported);

    assert!(!infer_thinking_capability("deepseek-chat").supported);
    assert!(!infer_thinking_capability("deepseek-v3").supported);
    assert!(!infer_thinking_capability("gpt-4o").supported);
    assert!(!infer_thinking_capability("unknown-model").supported);
}

// ── normalize_thinking_intensity（降级钳制；AllowDegrade 路径消费）──

#[test]
fn normalize_intensity_clamps_out_of_whitelist() {
    use ThinkingIntensity as I;
    const CAP: ThinkingCapability = ThinkingCapability {
        supported: true,
        levels: &[I::Low, I::Medium, I::High],
        format: ReasoningFormat::ReasoningEffort,
        vendor: ReasoningVendor::Deepseek,
    };
    assert_eq!(normalize_thinking_intensity(I::Off, &CAP), None);
    assert_eq!(
        normalize_thinking_intensity(I::Xhigh, &CAP),
        Some(I::High),
        "xhigh → high 降级"
    );
    assert_eq!(
        normalize_thinking_intensity(I::Minimal, &CAP),
        Some(I::Low),
        "minimal → low 降级"
    );
    assert_eq!(normalize_thinking_intensity(I::Medium, &CAP), Some(I::Medium));
    assert_eq!(
        normalize_thinking_intensity(I::High, &NO_THINKING),
        None,
        "不支持思考 → None"
    );
}

// ── resolve_reasoning_level（R4 T4.1 请求面拒绝校验）──

use conex_types::error::ProviderErrorKind as Kind;

/// 白名单 ['low','medium','high'] 的能力（系列级 typical）。
fn whitelist_low_medium_high() -> ThinkingCapability {
    ThinkingCapability {
        supported: true,
        levels: &[
            ThinkingIntensity::Low,
            ThinkingIntensity::Medium,
            ThinkingIntensity::High,
        ],
        format: ReasoningFormat::ReasoningEffort,
        vendor: ReasoningVendor::Deepseek,
    }
}

#[test]
fn reject_explicit_max_outside_whitelist() {
    let cap = whitelist_low_medium_high();
    let err = resolve_reasoning_level(
        ReasoningEffortState::Explicit(ReasoningEffort::Max),
        &cap,
        DegradePolicy::Reject,
    )
    .expect_err("max 不在白名单 → 应拒绝");
    assert_eq!(err.kind, Kind::InvalidRequest, "复用 InvalidRequest 分类");
    assert_eq!(err.effort, "max");
    assert!(
        err.message.contains(ReasoningReject::UNSUPPORTED_TAG),
        "拒绝文案应携带 UNSUPPORTED_REASONING_EFFORT 语义标签"
    );
}

#[test]
fn reject_explicit_unknown_model() {
    let unknown = NO_THINKING;
    let err = resolve_reasoning_level(
        ReasoningEffortState::Explicit(ReasoningEffort::Low),
        &unknown,
        DegradePolicy::Reject,
    )
    .expect_err("未知模型显式档位 → 应拒绝");
    assert_eq!(err.kind, Kind::InvalidRequest);
}

#[test]
fn omitted_state_yields_no_params() {
    let cap = whitelist_low_medium_high();
    assert_eq!(
        resolve_reasoning_level(ReasoningEffortState::Omitted, &cap, DegradePolicy::Reject),
        Ok(None)
    );
}

#[test]
fn three_state_explicit_default_omitted_distinguishable() {
    let cap = whitelist_low_medium_high();
    assert_eq!(
        resolve_reasoning_level(
            ReasoningEffortState::Explicit(ReasoningEffort::Medium),
            &cap,
            DegradePolicy::Reject,
        ),
        Ok(Some(ReasoningEffort::Medium))
    );
    assert_eq!(
        resolve_reasoning_level(ReasoningEffortState::Default, &cap, DegradePolicy::Reject),
        Ok(Some(ReasoningEffort::Low))
    );
    assert_eq!(
        resolve_reasoning_level(ReasoningEffortState::Omitted, &cap, DegradePolicy::Reject),
        Ok(None)
    );
}

#[test]
fn off_and_auto_never_send() {
    let cap = whitelist_low_medium_high();
    for off in [ReasoningEffort::Off, ReasoningEffort::Auto] {
        assert_eq!(
            resolve_reasoning_level(
                ReasoningEffortState::Explicit(off),
                &cap,
                DegradePolicy::Reject,
            ),
            Ok(None),
            "{off:?} 关闭思考，不发送"
        );
    }
}

#[test]
fn degrade_policy_switch_preserves_old_behavior_when_on() {
    let cap = whitelist_low_medium_high();
    assert_eq!(
        resolve_reasoning_level(
            ReasoningEffortState::Explicit(ReasoningEffort::Xhigh),
            &cap,
            DegradePolicy::AllowDegrade,
        ),
        Ok(Some(ReasoningEffort::High)),
        "AllowDegrade 时 xhigh 降级到 high"
    );
    assert!(resolve_reasoning_level(
        ReasoningEffortState::Explicit(ReasoningEffort::Xhigh),
        &cap,
        DegradePolicy::Reject,
    )
    .is_err());
}

// ── Endpoint 仍被测试使用（wire 路由断言的辅助常量）──

#[test]
fn endpoint_enum_is_usable() {
    // 确认 Endpoint 类型在 vendor 域可用（拒绝路径不直接消费，但 wire 路由共用）。
    let _ = Endpoint::ChatCompletions;
    let _ = Endpoint::Responses;
}
