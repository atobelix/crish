//! Provider 装配面（SR-04 拆分 · engine.rs → engine_provider.rs）：客户端/请求构建
//! （[EngineProviderConfig] / [load_provider_endpoint] / URL 判定族 / 时间戳与消息 id
//! [connection] [timestamp]）+ 真实 provider 适配层（[HttpProviderCall]，T09.1 增量流）。
//!
//! 多模型适配战役 R3 T3.2：四协议（chat / responses / anthropic / gemini）URL/body/
//! parser 同轨，思考档位（series 级）消费接线。本文件为门面，实现域拆分如下
//! （`engine_provider/` 子模，测试旁挂 `engine_provider_tests.rs`）：
//! - [connection]：连接配置 + HTTP 客户端；[timestamp]：ISO8601 + 消息 id；
//! - [protocol]：协议路由单一真源消费 + 四态解析器选择 + 目录查询
//!   + maxTokensField 决议（T3.6/C5）；[headers]：请求头组装
//!   + 会话亲和头族 seam（T3.5/G1-e）；[thinking]：思考档位映射；[stream]：流状态机。
//! 头钉：SR-04 · 拆分 · ≠ EL（结构拆分；四协议路由/思考档位为 R3 T3.2 新增，
//! URL/body/parser 收敛于同一 [protocol::effective_protocol]）。

#[path = "engine_provider/connection.rs"]
pub(crate) mod connection;
#[path = "engine_provider/headers.rs"]
pub(crate) mod headers;
#[path = "engine_provider/protocol.rs"]
pub(crate) mod protocol;
#[path = "engine_provider/stream.rs"]
pub(crate) mod stream;
#[path = "engine_provider/thinking.rs"]
pub(crate) mod thinking;

pub(crate) use connection::*;
pub(crate) use protocol::*;
pub(crate) use stream::*;
pub(crate) use timestamp::*;

use std::collections::{BTreeMap, VecDeque};
use std::time::Duration;

use agent_provider::config::Endpoint;
use agent_provider::error::{classify_provider_error, source_from_reqwest_error};
use agent_provider::models::{
    CacheControlFormat, ProtocolKind, ThinkingFormat,
};
use agent_provider::request::{
    build_anthropic_request_body, build_chat_completions_request_body, build_gemini_request_body,
    build_responses_request_body, ensure_outbound_modalities, AnthropicRequestOptions,
    BreakpointPlan, CacheMechanism, CachePolicy, CacheRetention, ChatCompletionsRequestOptions,
    GeminiRequestOptions, RequestBuildContext, ToolDefinition as WireToolDefinition, TtlBucket,
    WireProtocol,
};
#[cfg(test)]
use agent_provider::request::ReasoningContentMode;
use agent_provider::sse::{AbortFlag, StreamDiagnosticContext, StreamReadOptions};
use agent_provider::transport::stream_frames;
use async_trait::async_trait;
use conex_types::error::ProviderErrorKind;
use conex_types::response::ClassifiedStreamError;
use conex_types::tool::SystemPromptWireMode;
use indexmap::IndexMap;
use session_loop::provider::{ProviderCall, ProviderEventStream, ProviderRequest};

#[path = "engine_provider/timestamp.rs"]
mod timestamp;

/// 首字节超时（等待流首个字节到达；None = 不设限，对齐 normalizeStreamTimeoutMs）
const DEFAULT_FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(30);
/// 流块间空闲超时
const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

// ── Provider 生效配置 ─────────────────────────────────────────────

/// 生效的 provider 配置（EngineHandle 加载；baseUrl/model/apiKey 三件套齐备
/// 即可发起调用，25-ipc-contract-audit.md:101）
///
/// S1 槽位（vendor/protocol/thinking_map/thinking_format/provider_id）由
/// [load_provider_endpoint] 从 [protocol::live_catalog] 唯一命中灌入。
/// `provider_id` 为空（None）表示引擎未就绪于 I-LOOKUP；本维只灌槽，
/// 不改 env 发请求。S4 的 `request_options` 每次 live lookup，禁止
/// `..Default::default()` 清空后再走前缀表——槽位字段保留给 S7 删除面
/// （当前仅测试面直读断言；热路径不再消费，避免当作过期副本）。
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
pub(crate) struct EngineProviderConfig {
    /// 服务端基础地址
    pub base_url: String,
    /// API key
    pub api_key: String,
    /// 模型名
    pub model: String,
    /// 端点（缺省 chat-completions，00 D3）
    pub endpoint: Endpoint,
    /// 是否流式
    pub stream: bool,
    /// 厂商私有参数透传（R2 工作台配置面恒空表；T-23/R3 后经此处注入）
    pub extra: BTreeMap<String, serde_json::Value>,
    /// yaml 供应商标识（唯一模型命中时 = providers 键；禁止前缀表猜测）
    pub vendor: Option<String>,
    /// yaml 生效协议（模型覆盖 ∨ 供应商默认）
    pub protocol: Option<ProtocolKind>,
    /// yaml 思考字典（TitleCase → wire），与 `ModelSpec.thinking` 同型
    pub thinking_map: Option<IndexMap<String, String>>,
    /// yaml `compat.thinkingFormat`
    pub thinking_format: Option<ThinkingFormat>,
    /// I-LOOKUP 键；空 = 引擎未就绪于 lookup（M13 本维不改 env 发请求）
    pub provider_id: Option<String>,
}

/// 从 config 模块的 effective_* 源加载生效配置（engine.rs:169-179 等价）
/// 源 = `crate::config::effective_*`；三件套任一缺失 → None（引擎降级未就绪）。
///
/// 槽位从 [protocol::live_catalog] 灌入：模型 id 唯一命中才填
/// provider_id/protocol/thinking_map/thinking_format/vendor；多命中或零命中
/// 全为 None（fail-closed）。
pub(crate) fn load_provider_endpoint() -> Option<EngineProviderConfig> {
    let base_url = crate::config::effective_api_base_url()?;
    let api_key = crate::config::effective_api_key()?;
    let model = crate::config::effective_model()?;
    if base_url.trim().is_empty() || api_key.trim().is_empty() || model.trim().is_empty() {
        return None;
    }
    let endpoint = Endpoint::parse(&crate::config::effective_provider_endpoint())
        .unwrap_or(Endpoint::ChatCompletions);
    let stream = crate::config::effective_provider_stream();
    let provider_id = crate::config::effective_provider_id();
    let slots = slots_for_model(
        &live_catalog(),
        provider_id.as_deref(),
        Some(&base_url),
        &model,
    );
    Some(EngineProviderConfig {
        base_url,
        api_key,
        model,
        endpoint,
        stream,
        extra: BTreeMap::new(),
        vendor: slots.vendor,
        protocol: slots.protocol,
        thinking_map: slots.thinking_map,
        thinking_format: slots.thinking_format,
        provider_id: slots.provider_id.or(provider_id),
    })
}

// ── HttpProviderCall：真实 provider 适配层 ─────────────────────────

/// chat-completions 兼容线（OpenAI 系 Included 语义——prompt_tokens 已含缓存）；
/// 未来 Anthropic Messages / Gemini 原生接线须显式传 `CacheAccounting::Excluded`。
pub(crate) struct HttpProviderCall {
    /// 共享 reqwest 客户端（连接池 / TLS 会话跨 run 复用，AA-02 S-7）
    client: reqwest::Client,
    /// 生效配置（EngineHandle 重载时重建；测试面直读断言缓存/窗口）
    pub(crate) config: EngineProviderConfig,
    /// 首字节超时
    first_byte_timeout: Option<Duration>,
    /// 流块间空闲超时
    idle_timeout: Option<Duration>,
    /// 显式注入的 AbortSignal（缺省按 request.session_id 查全局注册表）
    pub(crate) abort_signal: Option<session_loop::AbortSignal>,
}

impl HttpProviderCall {
    /// 新建适配层（共享客户端 + 生效配置）
    pub(crate) fn new(client: reqwest::Client, config: EngineProviderConfig) -> Self {
        Self {
            client,
            config,
            first_byte_timeout: Some(DEFAULT_FIRST_BYTE_TIMEOUT),
            idle_timeout: Some(DEFAULT_IDLE_TIMEOUT),
            abort_signal: None,
        }
    }

    /// 注入专用 AbortSignal（测试与独立调用场景）
    #[cfg(test)]
    pub(crate) fn with_abort_signal(mut self, signal: session_loop::AbortSignal) -> Self {
        self.abort_signal = Some(signal);
        self
    }

    /// chat-completions 请求选项（模型 / max_tokens 透传；思考字典与方言来自
    /// 出站剖面 [protocol::catalog_request_profile]（plans/04 §1.3）——每次
    /// `live_catalog().find(provider_id, model)` 现查，禁止 `..Default` 清空
    /// 后再走前缀表；缓存键只来自 yaml compat 声明，无声明 → None）。
    pub(crate) fn request_options(
        &self,
        request: &ProviderRequest<'_>,
    ) -> ChatCompletionsRequestOptions {
        let profile = protocol::catalog_request_profile(&self.config);
        let cache = cache_policy_from_profile(&profile);
        ChatCompletionsRequestOptions {
            model: Some(self.config.model.clone()),
            stream: Some(self.config.stream),
            max_tokens: request.max_tokens.map(u64::from),
            max_tokens_field: Some(profile.max_tokens_field),
            reasoning_effort: request.reasoning_effort.map(thinking::to_provider_effort),
            reasoning_content: Some(profile.reasoning_content),
            thinking_map: profile.thinking_map,
            thinking_format: profile.thinking_format,
            supports_reasoning: profile.supports_reasoning,
            compat: profile.compat,
            cache,
            ..ChatCompletionsRequestOptions::default()
        }
    }

    /// 请求体构建（DEEPCHECK-05 #10 修复：body 与 endpoint 同轨分流）
    ///
    /// responses 轨生效（[protocol::responses_endpoint_active]）→ responses
    /// wire 形状；否则 → chat-completions 形状。**仅测试面使用**——生产四轨
    /// 走 [request_body_for]（以剖面协议为准，不再回读端点启发式）。
    #[cfg(test)]
    pub(crate) fn request_body(
        &self,
        options: &ChatCompletionsRequestOptions,
        context: &RequestBuildContext<'_>,
    ) -> serde_json::Value {
        if protocol::responses_endpoint_active(&self.config) {
            build_responses_request_body(options, context)
        } else {
            build_chat_completions_request_body(options, context)
        }
    }

    /// 按 wire 协议构建请求体（四轨同轨；R3 T3.2）。anthropic → 原生
    /// AnthropicRequestOptions；gemini → GeminiRequestOptions；chat/responses →
    /// 既有 [request_options]/[request_body]。思考字典与方言来自同一剖面
    /// （plans/04 §3.1：四条出站都走 `assemble_thinking_dialect`）。
    pub(crate) fn request_body_for(
        &self,
        protocol: WireProtocol,
        request: &ProviderRequest<'_>,
    ) -> serde_json::Value {
        let context = self.build_context(request);
        let profile = protocol::catalog_request_profile(&self.config);
        match protocol {
            WireProtocol::Anthropic => {
                let options = AnthropicRequestOptions {
                    model: Some(self.config.model.clone()),
                    stream: Some(self.config.stream),
                    max_tokens: request.max_tokens.map(u64::from),
                    reasoning_effort: request.reasoning_effort.map(thinking::to_provider_effort),
                    thinking_map: profile.thinking_map,
                    thinking_format: profile.thinking_format,
                    ..Default::default()
                };
                build_anthropic_request_body(&options, &context)
            }
            WireProtocol::Gemini => {
                let options = GeminiRequestOptions {
                    model: Some(self.config.model.clone()),
                    max_output_tokens: request.max_tokens.map(u64::from),
                    reasoning_effort: request.reasoning_effort.map(thinking::to_provider_effort),
                    thinking_map: profile.thinking_map,
                    thinking_format: profile.thinking_format,
                    ..Default::default()
                };
                build_gemini_request_body(&options, &context)
            }
            WireProtocol::Chat => {
                let options = self.request_options(request);
                build_chat_completions_request_body(&options, &context)
            }
            WireProtocol::Responses => {
                let options = self.request_options(request);
                build_responses_request_body(&options, &context)
            }
        }
    }

    /// 请求构建上下文（消息 0 深拷贝借用，PE-09 T09.3 阶段 1）
    /// （pub(crate)：测试面直用请求构建上下文断言；仅可见性调整，语义不变）
    pub(crate) fn build_context<'a>(
        &self,
        request: &ProviderRequest<'a>,
    ) -> RequestBuildContext<'a> {
        RequestBuildContext {
            system_prompt: request.system_prompt.map(str::to_string),
            messages: request.messages,
            tools: request
                .tools
                .iter()
                .map(|schema| WireToolDefinition {
                    name: schema.name.clone(),
                    description: schema.description.clone(),
                    input_schema: schema.input_schema.clone(),
                })
                .collect(),
            wire_mode: SystemPromptWireMode::NativeSystemRole,
        }
    }

    /// reasoning 键存在性按剖面判定（plans/04 §1.2）：`thinking_format ==
    /// DeepSeek` → Require（工具循环轮次必须回传 `reasoning_content`，缺键 400），
    /// 其余 → Omit。判定只依赖 live yaml，禁止 `infer_reasoning_vendor` URL 猜。
    #[cfg(test)]
    pub(crate) fn reasoning_content_mode(&self) -> ReasoningContentMode {
        protocol::catalog_request_profile(&self.config).reasoning_content
    }

    /// 发送层基础请求头（chat/responses 轨）：Authorization + 亲和头；
    /// policy = request_options 产出的 `options.cache`；None → 零追加头。
    #[cfg(test)]
    pub(crate) fn request_headers(
        &self,
        policy: Option<&agent_provider::request::cache::CachePolicy>,
    ) -> Vec<(String, String)> {
        headers::request_headers_for(&self.config, WireProtocol::Chat, policy, None, None)
    }

    /// 组装完整请求头（四轨同轨；会话亲和头族 seam T3.5 注入 session_id）。
    pub(crate) fn request_headers_for(
        &self,
        protocol: WireProtocol,
        request: &ProviderRequest<'_>,
    ) -> Vec<(String, String)> {
        let policy = match protocol {
            WireProtocol::Chat | WireProtocol::Responses => self.request_options(request).cache,
            WireProtocol::Anthropic | WireProtocol::Gemini => None,
        };
        headers::request_headers_for(
            &self.config,
            protocol,
            policy.as_ref(),
            request.reasoning_effort.map(thinking::to_provider_effort),
            request.session_id.as_deref(),
        )
    }
}

/// Anthropic 轨请求选项构造器（series 级思考档位消费）。
#[async_trait]
impl ProviderCall for HttpProviderCall {
    async fn stream<'a>(
        &self,
        request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        // 1. 出站剖面 = live_catalog 单次命中（协议 / 思考字典 / 模态 / 字段名
        //    / reasoning_content 全部从这一次 lookup 长出；plans/04 §1.2）。
        let profile = protocol::catalog_request_profile(&self.config);
        let protocol = profile.protocol;

        // 2. 请求面思考档位拒绝校验（plans/04 §1.4）：TitleCase 字典白名单，
        //    不在白名单 / 无字典的显式档位 → 流前 Err（分类错误，不降级不
        //    改写）——**HTTP I/O 之前**返回。
        thinking::validate_reasoning_effort(&profile, request.reasoning_effort)?;

        // 3. 多模态出站硬拒（plans/04 §4.1 唯一挂载点）：纯文本模型带图 →
        //    HTTP 前 InvalidRequest，上游零字节。S3 入口禁图是第一道；本闸
        //    不可绕过（工具 / 脚本 / 恶意 IPC）。
        if let Err(err) =
            ensure_outbound_modalities(request.messages, profile.supports_image)
        {
            return Err(to_modality_reject(err));
        }

        // 4. 构建请求体（四轨同轨：body/URL/parser 同以 profile.protocol 为键）
        let body = self.request_body_for(protocol, request);
        let url = protocol::provider_url_for(&self.config, protocol);

        // 5. HTTP 请求（共享连接池；tokio::select! 强打断竞速）
        let abort_signal = self.abort_signal.clone().or_else(|| {
            request
                .session_id
                .as_deref()
                .and_then(get_session_abort_signal)
        });

        let mut request_builder = self.client.post(&url);
        for (name, value) in self.request_headers_for(protocol, request) {
            request_builder = request_builder.header(name, value);
        }

        let response = match &abort_signal {
            Some(signal) => {
                tokio::select! {
                    biased;
                    _ = signal.wait_aborted() => {
                        return Err(ClassifiedStreamError {
                            kind: ProviderErrorKind::Aborted,
                            message: "Request aborted by user before HTTP response headers received".to_string(),
                            retryable: false,
                            retry_after_ms: None,
                        });
                    }
                    res = request_builder.json(&body).send() => match res {
                        Ok(response) => response,
                        Err(error) => {
                            let source = source_from_reqwest_error(&error);
                            return Err(to_classified(classify_provider_error(None, None, Some(source), None)));
                        }
                    },
                }
            }
            None => match request_builder.json(&body).send().await {
                Ok(response) => response,
                Err(error) => {
                    let source = source_from_reqwest_error(&error);
                    return Err(to_classified(classify_provider_error(
                        None,
                        None,
                        Some(source),
                        None,
                    )));
                }
            },
        };

        // 非 2xx：读 body → 分类（含 Retry-After 头；流前错误，未产出事件）
        let status = response.status();
        if !status.is_success() {
            let status_code = status.as_u16();
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let body_text = response.text().await.ok();
            let classified = classify_provider_error(
                Some(status_code),
                body_text.as_deref(),
                None,
                retry_after.as_deref(),
            );
            return Err(to_classified(classified));
        }

        // 3. 增量帧流 → 逐帧解析 → 逐事件产出（T09.1.2 步骤 2：真实 AbortHandle）
        let (abort_flag, abort_handle) = AbortFlag::new();
        if let Some(signal) = &abort_signal {
            if signal.is_aborted() {
                abort_flag.abort();
            } else {
                let sig = signal.clone();
                let flag = abort_flag.clone();
                tokio::spawn(async move {
                    sig.wait_aborted().await;
                    flag.abort();
                });
            }
        }
        let read_options = StreamReadOptions {
            first_byte_timeout: self.first_byte_timeout,
            idle_timeout: self.idle_timeout,
            diagnostics: Some(StreamDiagnosticContext {
                provider_id: Some(protocol.as_str().to_string()),
                endpoint: Some(self.config.endpoint.as_str().to_string()),
                url: Some(url.clone()),
                ..StreamDiagnosticContext::default()
            }),
        };
        let frames = stream_frames(response, read_options, abort_handle);
        let state = HttpStreamState {
            frames,
            parser: http_parser_for(&self.config),
            pending: VecDeque::new(),
            finished: false,
        };
        Ok(Box::pin(futures_util::stream::unfold(
            state,
            |mut state| async move { http_stream_next(&mut state).await.map(|item| (item, state)) },
        )))
    }
}

/// 缓存策略只来自 yaml 声明（plans/04 §1.3）：`compat.cacheControlFormat:
/// anthropic` → 显式断点机制；无声明 → None（请求体不出现 cache 键）。
/// 禁止 `bundled_catalog` + base_url 猜 cache 能力（§2.4）。
fn cache_policy_from_profile(profile: &protocol::CatalogRequestProfile) -> Option<CachePolicy> {
    match profile
        .compat
        .as_ref()
        .and_then(|c| c.cache_control_format)
    {
        Some(CacheControlFormat::Anthropic) => Some(CachePolicy {
            mechanism: CacheMechanism::Explicit,
            retention: CacheRetention::Short,
            ttl: TtlBucket::FiveMinutes,
            breakpoints: Some(BreakpointPlan::default()),
            cache_key: None,
            prompt_cache_options: None,
            affinity_header: None,
        }),
        None => None,
    }
}

/// 多模态硬拒（[agent_provider::error::ProviderError::InvalidRequest]）→
/// 已分类流前错误（kind = InvalidRequest、不可重试，plans/04 §4.3）。
fn to_modality_reject(err: agent_provider::error::ProviderError) -> ClassifiedStreamError {
    let message = match err {
        agent_provider::error::ProviderError::InvalidRequest { message, .. } => message,
        other => other.to_string(),
    };
    ClassifiedStreamError {
        kind: ProviderErrorKind::InvalidRequest,
        message,
        retryable: false,
        retry_after_ms: None,
    }
}

#[cfg(test)]
#[path = "engine_provider_tests.rs"]
mod tests;
