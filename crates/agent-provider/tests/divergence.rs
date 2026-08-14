//! 分歧点核对测试（任务书 B7.3 的 agent-provider 侧：00 主方案 §3 D3/D4）
//!
//! - 00 D3：provider endpoint 选择——模型侧有工具→Responses API、runtime 侧
//!   恒 chat-completions；裁决：默认恒 chat-completions（chat-completions
//!   已完整支持工具）。
//! - 00 D4：vendor 推理/reasoning-effort 头——model 有 / runtime 无；裁决：
//!   保留 vendor 机制（取 model 行为），独立于请求路径。
//!
//! 正向断言 = 裁决后行为；反向断言 = 旧行为（Responses 默认 / vendor 缺失）
//! 不复现。复用 agent-provider 公开 API（config / request::build /
//! request::vendor），不引入新依赖。

use agent_provider::config::Endpoint;
use agent_provider::request::{infer_reasoning_vendor, resolve_endpoint, ReasoningVendor};

// ── 00 D3：endpoint 默认 chat-completions ──

/// 00 D3 正向：endpoint 未显式指定（None / auto）时恒解析为
/// chat-completions——chat-completions 已完整支持工具，不默认走 Responses。
#[test]
fn endpoint_defaults_to_chat_completions() {
    // 未显式指定 → chat-completions
    assert_eq!(resolve_endpoint(None), Endpoint::ChatCompletions);
    // auto 退化 → chat-completions（02 §五 #1 裁决：当前实现恒退化）
    assert_eq!(
        resolve_endpoint(Some(Endpoint::Auto)),
        Endpoint::ChatCompletions
    );
    // 显式指定仍生效（默认只在未指定时兜底）
    assert_eq!(
        resolve_endpoint(Some(Endpoint::Responses)),
        Endpoint::Responses
    );
    // 反向：旧行为（模型侧「有工具→Responses API」默认）不复现——
    // 无工具上下文下默认也不会解析为 responses
    assert_ne!(resolve_endpoint(None), Endpoint::Responses);
    assert_ne!(resolve_endpoint(Some(Endpoint::Auto)), Endpoint::Responses);
}

// ── 00 D4：vendor 机制保留 ──

/// 00 D4 正向：vendor 推断机制保留（inferReasoningVendor 等价物）——
/// baseUrl / model 关键字可识别 anthropic / deepseek / gemini / openai。
#[test]
fn vendor_mechanism_preserved_infers_by_base_url_and_model() {
    // baseUrl 关键字推断（02 §五 #2 取 model 行为）
    assert_eq!(
        infer_reasoning_vendor(Some("https://api.anthropic.com"), None),
        ReasoningVendor::Anthropic
    );
    assert_eq!(
        infer_reasoning_vendor(Some("https://api.deepseek.com"), None),
        ReasoningVendor::Deepseek
    );
    // model 前缀推断
    assert_eq!(
        infer_reasoning_vendor(None, Some("deepseek-reasoner")),
        ReasoningVendor::Deepseek
    );
    assert_eq!(
        infer_reasoning_vendor(None, Some("claude-sonnet-4")),
        ReasoningVendor::Anthropic
    );
    assert_eq!(
        infer_reasoning_vendor(None, Some("gpt-4o")),
        ReasoningVendor::Openai
    );
}

/// 00 D4 反向：未识别的 baseUrl / model 退化到 Auto（不 panic、不硬编码
/// 具体 vendor）；显式 Auto 也保持 Auto——vendor 检测独立于请求路径。
#[test]
fn vendor_unrecognized_degrades_to_auto_not_defaulted() {
    assert_eq!(
        infer_reasoning_vendor(Some("https://unknown.example"), None),
        ReasoningVendor::Auto,
        "未识别 baseUrl 应退化为 auto"
    );
    assert_eq!(
        infer_reasoning_vendor(None, Some("unknown-model")),
        ReasoningVendor::Auto,
        "未识别 model 应退化为 auto"
    );
    assert_eq!(
        infer_reasoning_vendor(None, None),
        ReasoningVendor::Auto,
        "全缺省应退化为 auto"
    );
    // 反向：旧行为（runtime 无 vendor 机制 → 无法识别即缺失）不复现——
    // 枚举默认值即 Auto（无请求路径硬编码 vendor）
    assert_eq!(
        ReasoningVendor::default(),
        ReasoningVendor::Auto,
        "vendor 未指定时默认 auto（独立于请求路径）"
    );
}
