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

use std::sync::{Arc, OnceLock, RwLock};

#[cfg(test)]
use agent_provider::config::Endpoint;
use agent_provider::events::StreamParseError;
use agent_provider::models::{
    CompatSpec, LiveModels, ModelCatalog, ModelSpec, ProtocolKind, ProviderSpec, ThinkingFormat,
};
use agent_provider::parse::anthropic::AnthropicParser;
use agent_provider::parse::chat::ChatCompletionsParser;
use agent_provider::parse::gemini::GeminiParser;
use agent_provider::parse::responses::ResponsesParser;
use agent_provider::request::{build_endpoint_url, MaxTokensField, ReasoningContentMode, WireProtocol};
use agent_provider::sse::SseFrame;
use indexmap::IndexMap;

#[cfg(test)]
use agent_provider::request::{infer_reasoning_vendor, ReasoningVendor};

use super::EngineProviderConfig;

/// 运行时 yaml 树 + 扁平投影快照（支持热重载）。
///
/// **热路径唯一入口是 [live_catalog]。** `bundled_catalog()` 只服务内置
/// `catalog.json`（测试、预填、历史 lookup）。S4 必须把 `request_options`
/// 的 catalog 参数从 `bundled_catalog()` 换成 `live_catalog()`，并复制
/// `EngineProviderConfig.thinking_map`；本维不改该调用点，不得宣称出站已通。
///
/// 持有 α-1 导出的 [LiveModels]（tree + 由 tree 投影的 catalog），禁止第三套解析器。
static LIVE_CATALOG: RwLock<Option<Arc<LiveModels>>> = RwLock::new(None);

/// `load_provider_endpoint` 从 live 快照灌入的槽位（零/多命中全为 None）。
#[derive(Debug, Clone, Default)]
pub(crate) struct LiveLookupSlots {
    pub vendor: Option<String>,
    pub protocol: Option<ProtocolKind>,
    pub thinking_map: Option<IndexMap<String, String>>,
    pub thinking_format: Option<ThinkingFormat>,
    pub provider_id: Option<String>,
}

fn slots_from_spec(provider_id: &str, provider: &ProviderSpec, spec: &ModelSpec) -> LiveLookupSlots {
    LiveLookupSlots {
        vendor: Some(provider_id.to_string()),
        protocol: Some(spec.effective_protocol(provider)),
        thinking_map: spec.thinking.clone(),
        thinking_format: spec
            .compat
            .as_ref()
            .and_then(|compat| compat.thinking_format)
            .or_else(|| {
                provider
                    .compat
                    .as_ref()
                    .and_then(|compat| compat.thinking_format)
            }),
        provider_id: Some(provider_id.to_string()),
    }
}

/// 权威模型能力解析（严格遵循选定供应商作用域）：
/// 1. 若有明确的 provider_id（当前选中的供应商），仅在该供应商下查找模型，杜绝跨供应商盲查；
/// 2. 若无 provider_id 但有 base_url，尝试通过 base_url 定位所属供应商；
/// 3. 若均无上下文，回退至全局唯一模型匹配。
pub(crate) fn slots_for_model(
    live: &LiveModels,
    provider_id: Option<&str>,
    base_url: Option<&str>,
    model_id: &str,
) -> LiveLookupSlots {
    if let Some(pid) = provider_id {
        if let Some(provider) = live.tree.find_provider(pid) {
            if let Some(spec) = provider.find_model(model_id) {
                return slots_from_spec(pid, provider, spec);
            }
        }
    }
    if let Some(url) = base_url {
        let clean_url = url.trim_end_matches('/');
        for (pid, provider) in &live.tree.providers {
            if provider.base_url.as_deref().map(|u| u.trim_end_matches('/')) == Some(clean_url) {
                if let Some(spec) = provider.find_model(model_id) {
                    return slots_from_spec(pid.as_str(), provider, spec);
                }
            }
        }
    }
    slots_for_unique_model(live, model_id)
}

/// 配置面尚无 providerId 时：仅当模型 id 在整棵树中**唯一**命中才灌槽。
/// 多命中或零命中 → 全 None（fail-closed，禁止前缀表猜厂商）。
pub(crate) fn slots_for_unique_model(live: &LiveModels, model_id: &str) -> LiveLookupSlots {
    let mut hit: Option<(&str, &ProviderSpec, &ModelSpec)> = None;
    for (provider_id, provider) in &live.tree.providers {
        if let Some(spec) = provider.find_model(model_id) {
            if hit.is_some() {
                return LiveLookupSlots::default();
            }
            hit = Some((provider_id.as_str(), provider, spec));
        }
    }
    match hit {
        Some((provider_id, provider, spec)) => slots_from_spec(provider_id, provider, spec),
        None => LiveLookupSlots::default(),
    }
}

/// 出站请求剖面（plans/04 §1.2）：`live_catalog().find(provider_id, model)`
/// 单次命中，协议 / 思考字典 / 方言 / 模态 / 字段名 / 开发者角色全部从这
/// 一次命中长出。lookup 未命中或 provider_id 为空 → fail-closed（[Self::fail_closed]），
/// 禁止再拿 URL / 模型前缀补一层。
///
/// `provider_id` 为空 = 引擎未就绪于 I-LOOKUP（M13）；S4 热路径每次调用本函数，
/// 禁止把 `EngineProviderConfig` 槽位当过期副本。
#[derive(Debug, Clone)]
pub(crate) struct CatalogRequestProfile {
    pub protocol: WireProtocol,
    pub thinking_map: Option<IndexMap<String, String>>,
    pub thinking_format: Option<ThinkingFormat>,
    pub supports_image: bool,
    pub supports_reasoning: bool,
    pub max_tokens_field: MaxTokensField,
    pub reasoning_content: ReasoningContentMode,
    pub compat: Option<CompatSpec>,
    /// 供应商级 yaml `providers.*.headers`（M16：全局 DeepSeek 头已删，
    /// 亲和头只来自这里）
    pub headers: Option<IndexMap<String, String>>,
}

impl CatalogRequestProfile {
    /// lookup 未命中 / provider_id 缺失 → 协议 chat、无思考键、`supports_image=false`。
    fn fail_closed() -> Self {
        Self {
            protocol: WireProtocol::Chat,
            thinking_map: None,
            thinking_format: None,
            supports_image: false,
            supports_reasoning: false,
            max_tokens_field: MaxTokensField::MaxTokens,
            reasoning_content: ReasoningContentMode::Omit,
            compat: None,
            headers: None,
        }
    }
}

/// 出站请求剖面组装（I-LOOKUP 唯一热路径；plans/04 §1.2 填充算法）。
///
/// - protocol：`Model.protocol ≻ Provider.protocol ≻ openai/chat`（yaml 全称，
///   禁止 `p.contains("responses")`）；
/// - thinking_map：`spec.thinking` 原样（键 = yaml TitleCase）；
/// - thinking_format：模型级 ≻ 供应商级 `compat.thinkingFormat`；
/// - supports_image：`modalities.input` 含 `image`（禁止 `capabilities.image` 双读）；
/// - max_tokens_field：仅 `CompatSpec.max_tokens_field`，否则协议缺省；
/// - reasoning_content：`thinking_format == DeepSeek` → Require，否则 Omit。
pub(crate) fn catalog_request_profile(
    config: &EngineProviderConfig,
) -> CatalogRequestProfile {
    let live = live_catalog();
    let (provider, spec) = if let Some(provider_id) = config.provider_id.as_deref() {
        if let Some(p) = live.tree.find_provider(provider_id) {
            if let Some(m) = p.find_model(&config.model) {
                (p, m)
            } else {
                return CatalogRequestProfile::fail_closed();
            }
        } else {
            return CatalogRequestProfile::fail_closed();
        }
    } else {
        let slots = slots_for_model(&live, None, Some(&config.base_url), &config.model);
        if let Some(pid) = slots.provider_id.as_deref() {
            if let Some(p) = live.tree.find_provider(pid) {
                if let Some(m) = p.find_model(&config.model) {
                    (p, m)
                } else {
                    return CatalogRequestProfile::fail_closed();
                }
            } else {
                return CatalogRequestProfile::fail_closed();
            }
        } else {
            return CatalogRequestProfile::fail_closed();
        }
    };

    let protocol = WireProtocol::from(spec.effective_protocol(provider));
    let compat = spec.compat.as_ref().or(provider.compat.as_ref());
    // thinking_format：yaml compat ≻ 协议缺省（openai/chat 与 openai/responses →
    // OpenAi；anthropic/gemini 无声明 → None = fail-closed 不注入思考键，§2.3）
    let thinking_format = compat
        .and_then(|c| c.thinking_format)
        .or_else(|| match protocol {
            WireProtocol::Chat | WireProtocol::Responses => Some(ThinkingFormat::OpenAi),
            _ => None,
        });
    let max_tokens_field = compat
        .and_then(|c| c.max_tokens_field)
        .map(|f| match f {
            agent_provider::models::MaxTokensField::MaxTokens => MaxTokensField::MaxTokens,
            agent_provider::models::MaxTokensField::MaxCompletionTokens => {
                MaxTokensField::MaxCompletionTokens
            }
        })
        .unwrap_or(match protocol {
            WireProtocol::Responses | WireProtocol::Gemini => MaxTokensField::MaxOutputTokens,
            WireProtocol::Chat | WireProtocol::Anthropic => MaxTokensField::MaxTokens,
        });

    CatalogRequestProfile {
        protocol,
        thinking_map: spec.thinking.clone(),
        thinking_format,
        supports_image: spec.supports_image_input(),
        supports_reasoning: spec.thinking.as_ref().is_some_and(|t| !t.is_empty()),
        max_tokens_field,
        reasoning_content: match thinking_format {
            Some(ThinkingFormat::DeepSeek) => ReasoningContentMode::Require,
            _ => ReasoningContentMode::Omit,
        },
        compat: compat.cloned(),
        headers: provider.headers.clone(),
    }
}

/// 获取当前运行时模型目录快照（热路径唯一 getter）。
///
/// - 文件缺失：诚实空树 + 空目录（`parse_error = None`），**不是** `catalog.json`；
/// - 解析失败：保持上一份成功快照；从未成功过则返回 [LiveModels::parse_failed]
///   显式错误态（`parse_error = Some`），**不写入**槽位，禁止把坏文件装成 empty tree 当真源。
///
/// S4 必须把 `request_options` 的 catalog 从 [bundled_catalog] 换成本函数；
/// 本维不改该调用点，不得宣称出站已通。
pub(crate) fn live_catalog() -> Arc<LiveModels> {
    if let Ok(guard) = LIVE_CATALOG.read() {
        if let Some(live) = guard.as_ref() {
            return Arc::clone(live);
        }
    }
    let mut guard = LIVE_CATALOG
        .write()
        .unwrap_or_else(|poison| poison.into_inner());
    if let Some(live) = guard.as_ref() {
        return Arc::clone(live);
    }
    adopt_load_result(&mut guard, LiveModels::load_user())
}

/// 成功才写入 LIVE_CATALOG；失败返回显式错误态且不安装。
fn adopt_load_result(
    slot: &mut Option<Arc<LiveModels>>,
    result: Result<LiveModels, String>,
) -> Arc<LiveModels> {
    match result {
        Ok(live) => {
            let arc = Arc::new(live);
            *slot = Some(Arc::clone(&arc));
            arc
        }
        Err(err) => {
            tracing::warn!(
                target: "engine_provider",
                "读取 ~/.conex/models.yaml 失败，不把空 providers 当作已加载: {err}"
            );
            Arc::new(LiveModels::parse_failed(err))
        }
    }
}

/// 重新加载运行时模型目录（models.yaml 保存成功后由 `models_yaml.rs` 调用）。
/// 内容重解析 tree + 投影。解析失败保持上一份成功快照。
pub(crate) fn reload_live_catalog() {
    match LiveModels::load_user() {
        Ok(live) => install_live_models(live),
        Err(err) => tracing::warn!(
            target: "engine_provider",
            "reload_live_catalog 解析失败，保持上一份成功快照: {err}"
        ),
    }
}

/// 从 yaml 字符串重解析并安装快照（仅测试与内存灌入；生产热更走
/// [reload_live_catalog]）。失败不覆盖上一份成功快照。
#[cfg(test)]
pub(crate) fn reload_live_catalog_from_yaml_str(yaml: &str) -> Result<(), String> {
    let live = LiveModels::from_yaml_str(yaml)?;
    install_live_models(live);
    Ok(())
}

fn install_live_models(live: LiveModels) {
    let mut guard = LIVE_CATALOG
        .write()
        .unwrap_or_else(|poison| poison.into_inner());
    *guard = Some(Arc::new(live));
}

/// 内置模型目录单例（T-23：Responses 支持判定用）
///
/// catalog.json 编译期打包（include_str!，无运行时 IO）；OnceLock 保证进程内只
/// 解析一次。仅内置表（测试、预填、历史 lookup）。**热路径新代码禁止再调用**；
/// S4/S5 必须替换为 [live_catalog]。
static BUNDLED_CATALOG: OnceLock<ModelCatalog> = OnceLock::new();

/// 内置模型目录只读引用（进程内单例）。热路径唯一入口是 [live_catalog]。
pub(crate) fn bundled_catalog() -> &'static ModelCatalog {
    BUNDLED_CATALOG.get_or_init(ModelCatalog::bundled)
}

/// 生效配置 → 目录 vendor 字符串（仅测试面历史夹具使用；生产协议/思考
/// 决议已改走 [catalog_request_profile]，S7 物理删除）。
#[cfg(test)]
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

/// T3.6（M3/C5）：per-配置 max tokens 字段决议。
///
/// 出站剖面唯一决议（plans/04 §2.4）：只认 `CompatSpec.max_tokens_field`；
/// 未声明 → 协议缺省（Chat/Anthropic → `max_tokens`；Responses/Gemini →
/// `max_output_tokens`）。禁止 `is_openai_o_series` / `url.contains` 兜底。
pub(crate) fn max_tokens_field(config: &EngineProviderConfig) -> MaxTokensField {
    catalog_request_profile(config).max_tokens_field
}

/// 模型级协议路由（单一真源消费点 C4）：生效配置 → 四协议。
///
/// 数据源 = 出站剖面（[catalog_request_profile]）：`Model.protocol ≻
/// Provider.protocol ≻ openai/chat`，全部来自 live yaml；lookup 未命中 →
/// openai/chat（fail-closed）。URL / 端点字段不再参与协议决议
/// （plans/04 §2.1/§2.3）。
pub(crate) fn effective_protocol(config: &EngineProviderConfig) -> WireProtocol {
    catalog_request_profile(config).protocol
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
/// 按协议决策（四轨同轨，规范化拼装单一真源 = [build_endpoint_url]）：
/// - Anthropic → `{base}/v1/messages`（去重拼装，base 已带 /v1 不重复）；
/// - Gemini → `{base}/v1beta/models/{model}:generateContent`；
/// - Responses → `{base}/v1/responses`；
/// - Chat（兜底）→ `{base}/chat/completions`。
#[cfg(test)]
pub(crate) fn provider_url(config: &EngineProviderConfig) -> String {
    provider_url_for(config, effective_protocol(config))
}

    /// 按显式协议生成 URL（测试/解析器三件套一致性的纯决策入口）。
    ///
    /// 规范化拼装单一真源 = [build_endpoint_url]
    /// （Anthropic `/v1/messages`、Responses `/v1/responses`、Chat `/chat/completions`
    /// 的去重拼装）；Gemini 在其上补 `models/{model}:generateContent` 模型路径。
    pub(crate) fn provider_url_for(config: &EngineProviderConfig, protocol: WireProtocol) -> String {
        let base = build_endpoint_url(protocol.protocol_kind(), &config.base_url);
        match protocol {
            WireProtocol::Gemini => format!("{base}/models/{}:generateContent", config.model),
            _ => base,
        }
    }

/// Responses 轨是否生效（chat 与 responses 双态既有判定；仅测试面使用——
/// 生产协议决议已改走 [catalog_request_profile]，本函数保留为历史夹具语义）。
#[cfg(test)]
pub(crate) fn responses_endpoint_active(config: &EngineProviderConfig) -> bool {
    config.endpoint == Endpoint::Responses && responses_supported(config)
}

/// Responses API 支持判定（仅测试面使用；生产协议决议改走 live yaml）。
#[cfg(test)]
pub(crate) fn responses_supported(config: &EngineProviderConfig) -> bool {
    let vendor = catalog_vendor(config);
    if vendor == "auto" {
        return true;
    }
    bundled_catalog().supports_responses_for(vendor, &config.model)
}

/// 生效模型上下文窗口（DEEPCHECK-06 P0：子代理预算入站数据源）
///
/// 数据源 = live yaml `context_window`（[catalog_request_profile] 同源 lookup，
/// 键 `(provider_id, model)`）。目录缺失 / 窗口超出 u32 承载 → None = 不钳制
/// （不臆造窗口）。禁止 `infer_vendor` URL 表兜底（plans/04 §2.4）。
pub(crate) fn effective_context_window(config: &EngineProviderConfig) -> Option<u32> {
    let live = live_catalog();
    let spec = config
        .provider_id
        .as_deref()
        .and_then(|provider_id| live.find(provider_id, &config.model))?;
    spec.context_window
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

#[cfg(test)]
mod live_catalog_tests {
    use super::*;
    use std::sync::Mutex;

    static LIVE_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn acme_yaml() -> &'static str {
        r#"
version: 2
providers:
  acme:
    displayName: Acme
    baseUrl: "https://api.acme.test"
    protocol: "openai/chat"
    compat:
      thinkingFormat: openai
    models:
      - id: acme-think
        displayName: Acme Think
        contextWindow: 128000
        maxOutputTokens: 8192
        modalities:
          input: [text, image]
          output: [text]
        thinking:
          Low: "low"
          High: "high"
        pricing:
          currency: USD
          input: 1.0
          output: 2.0
          cacheRead: 0.1
          cacheWrite: 0.0
"#
    }

    fn install_acme() {
        reload_live_catalog_from_yaml_str(acme_yaml()).expect("acme yaml 必须解析成功");
    }

    #[test]
    fn live_catalog_find_acme_think_keeps_titlecase_thinking_and_image_input() {
        let _guard = LIVE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        install_acme();
        let live = live_catalog();
        let spec = live
            .find("acme", "acme-think")
            .expect("live_catalog().find(acme, acme-think) 必须命中");
        let thinking = spec.thinking.as_ref().expect("thinking 字典必须存在");
        assert!(
            thinking.contains_key("Low"),
            "thinking 必须保留 TitleCase 键 Low，实际键={:?}",
            thinking.keys().collect::<Vec<_>>()
        );
        assert_eq!(thinking.get("Low").map(String::as_str), Some("low"));
        let input = spec
            .modalities
            .as_ref()
            .expect("modalities 必须存在")
            .input
            .as_slice();
        assert!(
            input.iter().any(|item| item == "image"),
            "modalities.input 必须含 image，实际={input:?}"
        );
    }

    #[test]
    fn live_catalog_parse_failure_keeps_previous_snapshot() {
        let _guard = LIVE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        install_acme();
        let err = reload_live_catalog_from_yaml_str("providers: [not-a-map]");
        assert!(err.is_err(), "坏 yaml 必须失败，不得吞成空 providers");
        assert!(
            live_catalog().find("acme", "acme-think").is_some(),
            "解析失败必须保持上一份成功快照"
        );
    }

    #[test]
    fn live_catalog_empty_providers_is_honest_empty_tree() {
        let _guard = LIVE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        reload_live_catalog_from_yaml_str("version: 2\nproviders: {}\n")
            .expect("诚实空树必须解析成功");
        assert!(
            live_catalog().tree.providers.is_empty(),
            "providers: {{}} 必须是空树，不是 catalog.json"
        );
        assert!(live_catalog().find("acme", "acme-think").is_none());
    }

    #[test]
    fn live_catalog_unique_model_fills_engine_slots() {
        let _guard = LIVE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        install_acme();
        let slots = slots_for_unique_model(&live_catalog(), "acme-think");
        assert_eq!(slots.provider_id.as_deref(), Some("acme"));
        assert_eq!(slots.vendor.as_deref(), Some("acme"));
        assert_eq!(slots.protocol, Some(ProtocolKind::OpenAiChat));
        assert_eq!(slots.thinking_format, Some(ThinkingFormat::OpenAi));
        assert!(
            slots
                .thinking_map
                .as_ref()
                .is_some_and(|thinking| thinking.contains_key("Low")),
            "唯一命中必须灌入 TitleCase thinking_map"
        );

        // 与 load_provider_endpoint 相同的灌槽赋值；读回五槽以钉契约并消除 dead_code。
        let config = super::super::EngineProviderConfig {
            base_url: "https://api.acme.test".to_string(),
            api_key: "k".to_string(),
            model: "acme-think".to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: Default::default(),
            vendor: slots.vendor,
            protocol: slots.protocol,
            thinking_map: slots.thinking_map,
            thinking_format: slots.thinking_format,
            provider_id: slots.provider_id,
        };
        assert_eq!(config.provider_id.as_deref(), Some("acme"));
        assert_eq!(config.vendor.as_deref(), Some("acme"));
        assert_eq!(config.protocol, Some(ProtocolKind::OpenAiChat));
        assert_eq!(config.thinking_format, Some(ThinkingFormat::OpenAi));
        assert!(config
            .thinking_map
            .as_ref()
            .is_some_and(|thinking| thinking.contains_key("Low")));
    }

    #[test]
    fn live_catalog_multi_hit_or_miss_leaves_slots_none() {
        let _guard = LIVE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let yaml = r#"
version: 2
providers:
  acme:
    displayName: Acme
    baseUrl: "https://api.acme.test"
    models:
      - id: shared-model
        displayName: Shared A
  beta:
    displayName: Beta
    baseUrl: "https://api.beta.test"
    models:
      - id: shared-model
        displayName: Shared B
"#;
        reload_live_catalog_from_yaml_str(yaml).expect("双供应商 yaml 必须解析成功");
        let multi = slots_for_unique_model(&live_catalog(), "shared-model");
        assert!(multi.provider_id.is_none(), "多命中必须 fail-closed");
        assert!(multi.protocol.is_none());
        assert!(multi.thinking_map.is_none());
        assert!(multi.vendor.is_none());
        assert!(multi.thinking_format.is_none());

        let miss = slots_for_unique_model(&live_catalog(), "no-such-model");
        assert!(miss.provider_id.is_none(), "零命中必须 fail-closed");
        assert!(miss.protocol.is_none());
    }

    #[test]
    fn load_provider_endpoint_calls_live_catalog_without_inventing_slots() {
        let _guard = LIVE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        reload_live_catalog_from_yaml_str("version: 2\nproviders: {}\n").expect("空树");
        // 三件套缺失时返回 None；调用本身证明 live_catalog 已非 dead_code。
        let _ = super::super::load_provider_endpoint();
        assert!(slots_for_unique_model(&live_catalog(), "anything")
            .provider_id
            .is_none());
    }

    #[test]
    fn live_catalog_first_parse_failure_is_explicit_error_not_installed() {
        let _guard = LIVE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        {
            let mut slot = LIVE_CATALOG
                .write()
                .unwrap_or_else(|poison| poison.into_inner());
            *slot = None;
            let failed = adopt_load_result(&mut slot, Err("语法失败: bad".into()));
            assert_eq!(failed.parse_error.as_deref(), Some("语法失败: bad"));
            assert!(
                failed.tree.providers.is_empty(),
                "错误态 tree 为空，但靠 parse_error 区分"
            );
            assert!(slot.is_none(), "首次坏文件不得安装成 empty tree 当真源快照");
        }
        reload_live_catalog_from_yaml_str(acme_yaml()).expect("成功解析仍可安装");
        let live = live_catalog();
        assert!(live.parse_error.is_none());
        assert!(live.find("acme", "acme-think").is_some());
    }

    #[test]
    fn live_catalog_parses_yaml_missing_display_name() {
        let _guard = LIVE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let yaml = r#"
version: 2
providers:
  acme:
    models:
      - id: acme-think
        thinking:
          Low: low
"#;
        reload_live_catalog_from_yaml_str(yaml).expect("缺 displayName 必须能解析");
        let live = live_catalog();
        assert!(live.parse_error.is_none());
        assert_eq!(
            live.tree
                .find_provider("acme")
                .and_then(|p| p.display_name.clone()),
            None
        );
        assert_eq!(
            live.find("acme", "acme-think")
                .and_then(|m| m.thinking.as_ref())
                .and_then(|t| t.get("Low"))
                .map(String::as_str),
            Some("low")
        );
    }
}
