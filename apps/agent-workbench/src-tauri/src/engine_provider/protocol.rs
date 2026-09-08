//! 协议路由域（多模型适配战役 R3 T3.2 / G4-b；engine_provider.rs → engine_provider/protocol.rs）
//!
//! 承载模型级协议路由单一真源消费：URL / 解析器两处按
//! [resolve_wire_protocol]（agent-provider C4）统一决策，与本模块体侧
//! [super::EngineProviderConfig] 一起保证「URL/body/parser 三件套同轨」。
//!
//! - [effective_protocol]：生效配置 → 四协议中的一种（model 级 mode 单一真源）。
//! - [provider_url] / [chat_provider_url]：按协议选择端点；
//! - [http_parser_for]：按协议选择解析器；
//! - [HttpStreamParser]：解析器四态（chat / responses / anthropic / gemini）。
//! - [bundled_catalog] / [responses_supported] / [effective_context_window]：
//!   内置模型目录查询面（既有位置搬移，语义不变）。
//!
//! 头钉：SR-04 · 拆分 · ≠ EL（结构性搬移 + 协议路由补全；URL/parser 决策
//! 收敛于同一 [effective_protocol]，杜绝「URL 改了协议没改解析器」断层）。

use std::sync::OnceLock;

use agent_provider::config::Endpoint;
use agent_provider::events::StreamParseError;
use agent_provider::models::{infer_vendor, ModelCatalog};
use agent_provider::parse::anthropic::AnthropicParser;
use agent_provider::parse::chat::ChatCompletionsParser;
use agent_provider::parse::gemini::GeminiParser;
use agent_provider::parse::responses::ResponsesParser;
use agent_provider::request::{
    infer_reasoning_vendor, resolve_max_tokens_field, resolve_wire_protocol, MaxTokensField,
    ReasoningVendor, WireProtocol,
};
use agent_provider::sse::SseFrame;

use super::EngineProviderConfig;

/// 运行时动态模型目录快照（支持热重载，避免编译期静态死锁）
static LIVE_CATALOG: std::sync::RwLock<Option<std::sync::Arc<ModelCatalog>>> =
    std::sync::RwLock::new(None);

/// 获取当前运行时模型目录快照（优先读取 `~/.conex/models.yaml`）
#[allow(dead_code)]
pub(crate) fn live_catalog() -> std::sync::Arc<ModelCatalog> {
    if let Ok(guard) = LIVE_CATALOG.read() {
        if let Some(cat) = guard.as_ref() {
            return std::sync::Arc::clone(cat);
        }
    }
    let mut guard = LIVE_CATALOG.write().unwrap_or_else(|p| p.into_inner());
    if let Some(cat) = guard.as_ref() {
        return std::sync::Arc::clone(cat);
    }
    let cat = std::sync::Arc::new(ModelCatalog::load_user_catalog_or_default());
    *guard = Some(std::sync::Arc::clone(&cat));
    cat
}

/// 重新加载运行时模型目录（当 models.yaml 保存或外部变更时调用）
pub(crate) fn reload_live_catalog() {
    let cat = std::sync::Arc::new(ModelCatalog::load_user_catalog_or_default());
    if let Ok(mut guard) = LIVE_CATALOG.write() {
        *guard = Some(cat);
    }
}

/// 内置模型目录单例（T-23：Responses 支持判定用）
///
/// catalog.json 编译期打包（include_str!，无运行时 IO）；OnceLock 保证进程内只
/// 解析一次。T-24 壳侧挂 `Arc<RwLock<ModelCatalog>>` 后此处可换为运行时实例，
/// 内置表即当前数据真源。
static BUNDLED_CATALOG: OnceLock<ModelCatalog> = OnceLock::new();

/// 内置模型目录只读引用（进程内单例）
pub(crate) fn bundled_catalog() -> &'static ModelCatalog {
    BUNDLED_CATALOG.get_or_init(ModelCatalog::bundled)
}

/// 生效配置 → 目录 vendor 字符串（对齐 catalog.json 条目 vendor 字段；
/// 未识别 → `"auto"`，命中目录未知厂商的 chat 兜底路径）。
/// pub(crate)：供 thinking 域（B-1 请求面拒绝校验的 catalog 白名单 lookup）复用。
pub(crate) fn catalog_vendor(config: &EngineProviderConfig) -> &'static str {
    match infer_reasoning_vendor(Some(&config.base_url), Some(&config.model)) {
        ReasoningVendor::Deepseek => "deepseek",
        ReasoningVendor::Openai => "openai",
        ReasoningVendor::Anthropic => "anthropic",
        ReasoningVendor::Gemini => "gemini",
        ReasoningVendor::Qwen => "qwen",
        ReasoningVendor::Glm => "glm",
        ReasoningVendor::Kimi => "kimi",
        ReasoningVendor::Auto => "auto",
    }
}

/// T3.6（M3/C5）：per-配置 max tokens 字段决议——消费 [resolve_max_tokens_field]
/// （R1 T1.7 / 2026-08-14 勘误判定表，契约登记）：
/// - 旧式网关（chutes/moonshot/cloudflare-ai-gateway/together/nvidia/ant-ling）→ [MaxTokensField::MaxTokens]；
/// - `openai.com` baseUrl 或 o 系列模型 → [MaxTokensField::MaxCompletionTokens]；
/// - 默认 openai-compatible → [MaxTokensField::MaxTokens]（保持既有字节兼容）。
///
/// vendor 侧复用 [catalog_vendor]（配置面无独立 vendor 字段，base_url 子串判定
/// 已覆盖 C5 全部网关族；未来 provider 配置带独立 vendor 名时改传 config.vendor）。
pub(crate) fn max_tokens_field(config: &EngineProviderConfig) -> MaxTokensField {
    resolve_max_tokens_field(catalog_vendor(config), &config.model, &config.base_url)
}

/// 模型级协议路由（单一真源消费点 C4）：生效配置 → 四协议。
///
/// 经 [resolve_wire_protocol](bundled_catalog, vendor, model, endpoint) 决议
/// model 级 `mode`；URL/body/parser 三处统一以此为键。
///
/// anthropic / gemini 为 model 级强路由（catalog mode 命中即走对应轨）。
/// chat / responses 两态沿用既有保守判定 [responses_endpoint_active]
/// （endpoint==Responses ∧ 目录确认支持）——未收录模型不改既有限制语义
/// （`deepseek-custom` + Responses 端点须降级 chat，回归 `engine_tests` 钉死）。
pub(crate) fn effective_protocol(config: &EngineProviderConfig) -> WireProtocol {
    match resolve_wire_protocol(
        bundled_catalog(),
        catalog_vendor(config),
        &config.model,
        Some(config.endpoint),
    ) {
        // model 级 mode 强路由：anthropic / gemini 恒走对应对应轨
        protocol @ (WireProtocol::Anthropic | WireProtocol::Gemini) => protocol,
        // chat / responses：沿用既有保守 gate（responses 须目录确认支持）
        _ => {
            if responses_endpoint_active(config) {
                WireProtocol::Responses
            } else {
                WireProtocol::Chat
            }
        }
    }
}

/// 摘要专用端点路径：恒 chat-completions（DEEPCHECK-05 #10 修复）
///
/// 摘要请求体恒为 chat 形状（[super::ProviderSummarizer::build_request_body]），URL
/// 必须与 body 匹配——若协议路由到其它端点就等于把 chat body 发往错误 URL。
/// 摘要面无 protocol 解析/构造面，显式钉死 chat URL。
pub(crate) fn chat_provider_url(config: &EngineProviderConfig) -> String {
    format!("{}/chat/completions", config.base_url.trim_end_matches('/'))
}

/// provider 请求端点路径（URL/body/parser 三件套的 URL 侧；DEEPCHECK-05 #10）
///
/// 按协议决策：
/// - Anthropic → `{base}/v1/messages`（anthropic.messages 端点）；
/// - Gemini → `{base}/v1beta/models/{model}:generateContent`；
/// - Responses → `{base}/responses`；
/// - Chat（兜底）→ `{base}/chat/completions`。
pub(crate) fn provider_url(config: &EngineProviderConfig) -> String {
    provider_url_for(config, effective_protocol(config))
}

/// 按显式协议生成 URL（测试/解析器三件套一致性的纯决策入口）。
pub(crate) fn provider_url_for(config: &EngineProviderConfig, protocol: WireProtocol) -> String {
    let base = config.base_url.trim_end_matches('/');
    match protocol {
        WireProtocol::Anthropic => format!("{base}/v1/messages"),
        WireProtocol::Gemini => format!("{base}/v1beta/models/{}:generateContent", config.model),
        WireProtocol::Responses => format!("{base}/responses"),
        WireProtocol::Chat => format!("{base}/chat/completions"),
    }
}

/// Responses 轨是否生效（chat 与 responses 双态既有判定；保留为既有测试钉死的
/// 兼容入口语义——`endpoint=Responses` 且目录确认支持）。
pub(crate) fn responses_endpoint_active(config: &EngineProviderConfig) -> bool {
    config.endpoint == Endpoint::Responses && responses_supported(config)
}

/// Responses API 支持判定（P3 §3.1.5 / §3.4.2，T-18 查询接口）
///
/// vendor 未识别（auto）→ 目录无该厂商数据返回 true（保留现状不干预）；
/// 其余厂商按目录条目 `supports_responses` 判定，未知模型保守视为不支持。
pub(crate) fn responses_supported(config: &EngineProviderConfig) -> bool {
    let vendor = catalog_vendor(config);
    if vendor == "auto" {
        return true;
    }
    bundled_catalog().supports_responses_for(vendor, &config.model)
}

/// 生效模型上下文窗口（DEEPCHECK-06 P0：子代理预算入站数据源）
///
/// engine provider 生效模型 → 内置模型目录 [ModelCatalog::context_window_for]
/// （vendor 判定复用 [infer_vendor] 双通道——baseUrl 关键字 → model 前缀，覆盖
/// grok / minimax / dashscope 等目录厂商，与 cache.rs 目录键路由同源）；目录
/// 缺失或窗口超出 u32 承载 → None = 不钳制（不臆造窗口）。
pub(crate) fn effective_context_window(config: &EngineProviderConfig) -> Option<u32> {
    let vendor = infer_vendor(&config.base_url, &config.model);
    bundled_catalog()
        .context_window_for(vendor.as_str(), &config.model)
        .and_then(|window| u32::try_from(window).ok())
}

/// 端点解析器（按协议选择，URL/body/parser 同轨；DEEPCHECK-05 #10 修复）
///
/// 由 [effective_protocol] 决策后委派给 [http_parser_for_protocol]。
pub(crate) fn http_parser_for(config: &EngineProviderConfig) -> HttpStreamParser {
    http_parser_for_protocol(effective_protocol(config))
}

/// 按显式协议选择解析器（chat → ChatCompletions，responses → Responses，
/// anthropic → Anthropic，gemini → Gemini）。四者同一帧处理接口，为
/// URL/body/parser 三件套一致性的纯决策入口。
pub(crate) fn http_parser_for_protocol(protocol: WireProtocol) -> HttpStreamParser {
    match protocol {
        WireProtocol::Anthropic => HttpStreamParser::Anthropic(AnthropicParser::new()),
        WireProtocol::Gemini => HttpStreamParser::Gemini(GeminiParser::new()),
        WireProtocol::Responses => HttpStreamParser::Responses(ResponsesParser::new()),
        WireProtocol::Chat => HttpStreamParser::Chat(ChatCompletionsParser::new()),
    }
}

/// 端点解析器四态（chat / responses / anthropic / gemini，同一帧处理接口）
pub(crate) enum HttpStreamParser {
    Chat(ChatCompletionsParser),
    Responses(ResponsesParser),
    Anthropic(AnthropicParser),
    Gemini(GeminiParser),
}

impl HttpStreamParser {
    /// 逐帧解析（委派给当前轨解析器；错误语义一致：解析错误 Unknown 不可重试）
    pub(crate) fn push_frame(
        &mut self,
        frame: &SseFrame,
    ) -> Result<Vec<agent_provider::events::ProviderStreamEvent>, StreamParseError> {
        match self {
            HttpStreamParser::Chat(parser) => parser.push_frame(frame),
            HttpStreamParser::Responses(parser) => parser.push_frame(frame),
            HttpStreamParser::Anthropic(parser) => parser.push_frame(frame),
            HttpStreamParser::Gemini(parser) => parser.push_frame(frame),
        }
    }

    /// 流结束收尾（委派；每流恰好一个 stop，由解析器保证）
    pub(crate) fn finish(
        &mut self,
    ) -> Result<Vec<agent_provider::events::ProviderStreamEvent>, StreamParseError> {
        match self {
            HttpStreamParser::Chat(parser) => parser.finish(),
            HttpStreamParser::Responses(parser) => parser.finish(),
            HttpStreamParser::Anthropic(parser) => parser.finish(),
            HttpStreamParser::Gemini(parser) => parser.finish(),
        }
    }
}
