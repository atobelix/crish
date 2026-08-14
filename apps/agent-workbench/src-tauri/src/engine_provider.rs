//! Provider 装配面（SR-04 拆分 · engine.rs → engine_provider.rs）
//!
//! 承载（D-03 SR-04 四面之 provider 装配）：客户端/请求构建
//! （[ClientConnectionConfig] / [build_http_client] / [EngineProviderConfig] /
//! [load_provider_endpoint] / URL 与 Responses 判定族 / 时间戳与消息 id
//! 工具）+ 真实 provider 适配层（[HttpProviderCall]，T09.1 增量流）与
//! 增量帧流解析状态机（[HttpStreamParser] / [http_stream_next] /
//! [to_loop_event] 等）。
//! 头钉：SR-04 · 拆分 · ≠ EL（结构拆分，不关任何 EL；仅搬移不改语义）。

use std::collections::{BTreeMap, VecDeque};
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use std::time::Duration;

use agent_provider::config::Endpoint;
use agent_provider::error::{
    classify_provider_error, source_from_reqwest_error, source_from_sse_read_error,
};
use agent_provider::events::{ProviderStreamEvent as WireEvent, StreamParseError};
use agent_provider::models::{infer_vendor, ModelCatalog};
use agent_provider::parse::chat::ChatCompletionsParser;
use agent_provider::parse::responses::ResponsesParser;
use agent_provider::request::cache::{build_cache_policy, CachePolicy};
use agent_provider::request::build::affinity_http_headers;
use agent_provider::request::{
    build_chat_completions_request_body, build_responses_request_body, infer_reasoning_vendor,
    ChatCompletionsRequestOptions, MaxTokensField, ReasoningContentMode, ReasoningVendor,
    RequestBuildContext, ToolDefinition as WireToolDefinition,
};
use agent_provider::sse::{AbortFlag, SseFrame, StreamDiagnosticContext, StreamReadOptions};
use agent_provider::transport::{stream_frames, StreamFrameEvent};
use async_trait::async_trait;
use conex_types::error::ProviderErrorKind;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::response::ClassifiedStreamError;
use conex_types::tool::SystemPromptWireMode;
use futures_util::{Stream, StreamExt};
use session_loop::provider::{ProviderCall, ProviderEventStream, ProviderRequest};
use session_loop::stream::{
    ProviderStreamEvent, ProviderUsage, StopReason as LoopStopReason,
};


/// 首字节超时（等待流首个字节到达；None = 不设限，对齐 normalizeStreamTimeoutMs）
const DEFAULT_FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(30);
/// 流块间空闲超时
const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// 连接配置覆盖面（D1 §3.3 连接配置表）：None 字段 = 默认值
/// （connect_timeout 10s / tcp_keepalive 30s / h2 ping 30s+5s）；
/// 测试装配可传参覆盖（短超时 / 关 keepalive——04 §2.3 可传参面）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ClientConnectionConfig {
    /// 建连超时（默认 10s；reqwest 默认 30s 过长）
    pub connect_timeout: Option<Duration>,
    /// TCP keepalive（默认 30s；半开连接 2-3 探针周期内 RST）
    pub tcp_keepalive: Option<Duration>,
    /// HTTP/2 PING 间隔（默认 30s；h2 静默挂起对抗）
    pub http2_keep_alive_interval: Option<Duration>,
    /// HTTP/2 PING 无响应判定超时（默认 5s；须 interval>0 才生效）
    pub http2_keep_alive_timeout: Option<Duration>,
}

impl Default for ClientConnectionConfig {
    fn default() -> Self {
        Self {
            connect_timeout: None,
            tcp_keepalive: None,
            http2_keep_alive_interval: None,
            http2_keep_alive_timeout: None,
        }
    }
}

impl ClientConnectionConfig {
    /// 默认连接配置（D1 §3.3 / 04 §2.3 连接配置表）
    pub(crate) fn defaults() -> Self {
        Self {
            connect_timeout: Some(Duration::from_secs(10)),
            tcp_keepalive: Some(Duration::from_secs(30)),
            http2_keep_alive_interval: Some(Duration::from_secs(30)),
            http2_keep_alive_timeout: Some(Duration::from_secs(5)),
        }
    }

    /// 解析生效配置：None 字段 → 默认值（单测断言字段级生效面）
    pub(crate) fn resolve(options: Option<ClientConnectionConfig>) -> ClientConnectionConfig {
        let defaults = Self::defaults();
        match options {
            None => defaults,
            Some(overrides) => ClientConnectionConfig {
                connect_timeout: overrides.connect_timeout.or(defaults.connect_timeout),
                tcp_keepalive: overrides.tcp_keepalive.or(defaults.tcp_keepalive),
                http2_keep_alive_interval: overrides
                    .http2_keep_alive_interval
                    .or(defaults.http2_keep_alive_interval),
                http2_keep_alive_timeout: overrides
                    .http2_keep_alive_timeout
                    .or(defaults.http2_keep_alive_timeout),
            },
        }
    }
}

/// 生产 HTTP 客户端构造（D1 §3.3 / 04 §2.3 单点封装；engine.rs 生产
/// 装配点唯一替换——其余测试域 Client::new 保持不动，最小改动面）：
/// connect_timeout 10s / tcp_keepalive 30s / h2 ping 30s+5s；
/// **不设总 .timeout()**（流式长输出不被总超时误杀，请求级超时由
/// 双段超时承担）；pool_idle_timeout 保持默认 90s（显式注明）。
/// 测试装配经 [ClientConnectionConfig] 传参覆盖（短超时 / 关 keepalive）。
pub(crate) fn build_http_client(options: Option<ClientConnectionConfig>) -> reqwest::Client {
    let resolved = ClientConnectionConfig::resolve(options);
    // resolve 恒填充默认值（None 字段 → 默认），unwrap 不会触发；
    // 显式 expect 而非 unwrap_or——重复常量有漂移风险，报错指向 resolve
    reqwest::Client::builder()
        .connect_timeout(resolved.connect_timeout.expect("连接配置解析后恒有默认值"))
        .tcp_keepalive(resolved.tcp_keepalive.expect("连接配置解析后恒有默认值"))
        .http2_keep_alive_interval(
            resolved
                .http2_keep_alive_interval
                .expect("连接配置解析后恒有默认值"),
        )
        .http2_keep_alive_timeout(
            resolved
                .http2_keep_alive_timeout
                .expect("连接配置解析后恒有默认值"),
        )
        .build()
        .expect("reqwest 客户端构造")
}

// ── 时间戳与消息 id ───────────────────────────────────────────────

/// 当前 UTC 时间 ISO8601 字符串（毫秒精度，`2026-07-31T08:00:00.000Z`）
///
/// 无 chrono 依赖，手工换算（Howard Hinnant civil-from-days 算法，
/// 与 orchestrator / session-loop 同源）。
pub(crate) fn now_iso_utc() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let (hours, mins, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    let (year, month, day) = civil_from_days((secs / 86400) as i64);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{mins:02}:{sec:02}.{millis:03}Z")
}

/// 从 Unix 天数换算公历年月日（Howard Hinnant 算法）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// 消息 id 生成（前缀 + 毫秒时间戳 + 计数器，进程内唯一）
pub(crate) fn new_message_id(prefix: &str) -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("{prefix}-{now_ms}-{}", COUNTER.fetch_add(1, Ordering::SeqCst))
}

/// 用户消息构造（run-task 下发 prompt）
///
/// 21-log §5.2 缺口 2 修复：`client_message_id` 填 run-task 下发的 user id
/// （03 §5.3-4：message-end 稳定幂等键）。
pub(crate) fn user_message(prompt: &str, client_message_id: Option<&str>) -> AgentMessage {
    AgentMessage {
        id: new_message_id("user"),
        role: AgentMessageRole::User,
        created_at: now_iso_utc(),
        blocks: vec![AgentMessageBlock::Text {
            text: prompt.to_string(),
        }],
        metadata: None,
        client_message_id: client_message_id.map(str::to_string),
        content: None,
    }
}

// ── Provider 生效配置 ─────────────────────────────────────────────

/// 生效的 provider 配置（EngineHandle 加载；baseUrl/model/apiKey 三件套齐备
/// 即可发起调用，25-ipc-contract-audit.md:101）
#[derive(Debug, Clone)]
pub(crate) struct EngineProviderConfig {
    /// 服务端基础地址（chat-completions 端点在其下）
    pub base_url: String,
    /// API key（Authorization: Bearer）
    pub api_key: String,
    /// 模型名
    pub model: String,
    /// 端点（缺省 chat-completions，00 D3）
    pub endpoint: Endpoint,
    /// 是否流式
    pub stream: bool,
    /// 厂商私有参数透传（对齐 agent-provider `ProviderConfig.extra` 通道，
    /// P2 §3.4 建议 2：`extra.cache` 覆盖 JSON 经 build_cache_policy 的
    /// overrides 生效，键名与 P3 CacheBehavior 结构字段对齐）。R2 工作台
    /// 配置面尚无该通道，恒为空表（overrides=None，能力判定走内置保守兜底）；
    /// R3（T-23）或配置 UI 接入 P3 开关数据后经此处注入。
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// 从 config 模块的 effective_* 源加载生效配置（engine.rs:169-179 等价）
///
/// 源 = `crate::config::effective_*`（ApiConfigStore；env 覆盖在 config 层
/// 完成）；三件套任一缺失 → None（引擎降级未就绪，仅记录不 panic，
/// engine.rs:112-125 语义）。
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
    Some(EngineProviderConfig {
        base_url,
        api_key,
        model,
        endpoint,
        stream,
        // R2 无 extra 透传通道（见字段注释），P3 开关数据经此注入
        extra: BTreeMap::new(),
    })
}

// ── HttpProviderCall：真实 provider 适配层 ─────────────────────────

/// provider 请求端点路径（endpoint 缺省恒 chat-completions，00 D3）
///
/// P3 步骤 4b（T-23）：endpoint=Responses 时经模型目录判定该模型是否支持
/// Responses API（P3 §3.4.2）。DeepSeek 现状仅 v4-flash 支持 Responses、
/// v4-pro 官方计划 2026 年 8 月初加入（vendor-cache-gaps.md:95；加入后刷新
/// catalog.json 条目即可，无代码改动）。判定 = `responses_endpoint_active`：
/// - 支持 → 保持 /responses；
/// - 不支持 → 拒绝 responses 并降级回 chat-completions（P3 §3.4.2 降级策略由
///   引擎裁决：本引擎无 per-request 端点重试/诊断面，静默回退 chat-completions
///   最符合"模型不支持时必须可用"的现状语义）；
/// - 厂商未识别（baseUrl/model 均无关键字 → Auto）→ 目录无该厂商数据，
///   保留现状不降级（避免对自定义网关臆断降级）；DeepSeek 经 model 前缀
///   仍可命中判定（自建网关转发 deepseek-* 模型名同样受判）。
///
/// DEEPCHECK-05 #10 修复：URL / 请求体 / 解析器三件套必须同轨——URL 走
/// /responses 时 body 必须是 responses wire 形状（[build_responses_request_body]）、
/// 解析器必须是 [ResponsesParser]；三处判定统一收敛于 [responses_endpoint_active]，
/// 防止"URL 改了协议没改"的断层再现。
pub(crate) fn provider_url(config: &EngineProviderConfig) -> String {
    let base = config.base_url.trim_end_matches('/');
    if responses_endpoint_active(config) {
        format!("{base}/responses")
    } else {
        format!("{base}/chat/completions")
    }
}

/// Responses 轨是否生效（URL / body / parser 三件套的统一判定点）
///
/// endpoint=Responses 且模型目录确认支持时返回 true；其余（chat 端点 / 不支持
/// 的模型）一律 false → 整条请求链回落 chat-completions 轨。
pub(crate) fn responses_endpoint_active(config: &EngineProviderConfig) -> bool {
    config.endpoint == Endpoint::Responses && responses_supported(config)
}

/// 摘要专用端点路径：恒 chat-completions（DEEPCHECK-05 #10 修复）
///
/// 摘要请求体恒为 chat 形状（[ProviderSummarizer::build_request_body]），URL
/// 必须与 body 匹配——若配置了 responses 端点就走 /responses，等于把 chat body
/// 发往 responses URL，正是 DEEPCHECK-05 判定的协议断层。摘要面无 Responses
/// 解析/构造面，显式钉死 chat URL。
pub(crate) fn chat_provider_url(config: &EngineProviderConfig) -> String {
    format!("{}/chat/completions", config.base_url.trim_end_matches('/'))
}

/// 内置模型目录单例（T-23：Responses 支持判定用）
///
/// catalog.json 编译期打包（include_str!，无运行时 IO）；OnceLock 保证
/// 进程内只解析一次（bundled() 每次解析成本避免）。T-24 壳侧挂
/// `Arc<RwLock<ModelCatalog>>` 后此处可换为运行时实例，内置表即当前数据真源。
static BUNDLED_CATALOG: OnceLock<ModelCatalog> = OnceLock::new();

pub(crate) fn bundled_catalog() -> &'static ModelCatalog {
    BUNDLED_CATALOG.get_or_init(ModelCatalog::bundled)
}

/// Responses API 支持判定（P3 §3.1.5 / §3.4.2，T-18 查询接口）
///
/// vendor 未识别（Auto）→ 目录无该厂商数据，返回 true（保留现状不干预）；
/// 其余厂商按目录条目 `supports_responses` 判定，未知模型保守视为不支持
/// （对齐 catalog.rs 注释"未知模型保守为不支持"，jcode"否则视为不支持"）。
pub(crate) fn responses_supported(config: &EngineProviderConfig) -> bool {
    let Some(vendor) = responses_vendor(config) else {
        return true;
    };
    bundled_catalog().supports_responses_for(vendor, &config.model)
}

/// 生效配置 → 目录 vendor 字符串（对齐 catalog.json 条目 vendor 字段；
/// 未识别 → None）。复用 infer_reasoning_vendor 双通道（baseUrl 关键字 →
/// model 前缀，vendor.rs:277-310）；Grok/MiniMax/百炼等目录厂商不在
/// ReasoningVendor 内，一律走 None（保留现状）。
fn responses_vendor(config: &EngineProviderConfig) -> Option<&'static str> {
    match infer_reasoning_vendor(Some(&config.base_url), Some(&config.model)) {
        ReasoningVendor::Deepseek => Some("deepseek"),
        ReasoningVendor::Openai => Some("openai"),
        ReasoningVendor::Anthropic => Some("anthropic"),
        ReasoningVendor::Gemini => Some("gemini"),
        ReasoningVendor::Qwen => Some("qwen"),
        ReasoningVendor::Glm => Some("glm"),
        ReasoningVendor::Kimi => Some("kimi"),
        ReasoningVendor::Auto => None,
    }
}

/// 生效模型上下文窗口（DEEPCHECK-06 P0：子代理预算入站数据源）
///
/// engine provider 生效模型 → 内置模型目录 [ModelCatalog::context_window_for]
/// （vendor 判定复用 [infer_vendor] 双通道——baseUrl 关键字 → model 前缀，
/// 覆盖 grok / minimax / dashscope 等目录厂商，与 cache.rs 的目录键路由
/// 同源）；目录缺失（未知模型 / Auto 厂商）或窗口超出 u32 承载 → None =
/// 不钳制（与主会话前端 resolveContextWindow 的 catalog 兜底失败行为
/// 一致，不臆造窗口）。
pub(crate) fn effective_context_window(config: &EngineProviderConfig) -> Option<u32> {
    let vendor = infer_vendor(&config.base_url, &config.model);
    bundled_catalog()
        .context_window_for(vendor.as_str(), &config.model)
        .and_then(|window| u32::try_from(window).ok())
}

/// provider 调用适配层（B6.4：ProviderCall 的真实实现，T09.1 增量流）
///
/// 流式契约（PE-02 §3.1，冻结 v1）：
/// - 流前 Err：传输层 / HTTP / 非 2xx 错误（尚未产出任何事件，进重试阶梯）；
/// - 流中 Err 条目：中途读取 / 解析错误（已产出内容 → 内容保留收场，
///   由消费方按 [session_loop::stream::ConsumeBuilder] 裁决）；
/// - 每流恰好一个 Stop，Stop 后流立即结束（解析器保证）；
/// - 返回流为 `'static`：请求体在返回流之前同步序列化完毕。
///
/// usage 口径（P2 §3.3 D，T-16 交付 usage_accounting setter）：本适配层只走
/// chat-completions 兼容线（OpenAI 系 Included 语义——prompt_tokens 已含缓存），
/// 消费侧 [session_loop::stream::ConsumeBuilder] 默认 Included 即正确，无需显式
/// 传参；未来 Anthropic Messages / Gemini 原生适配层接线时必须显式传
/// `CacheAccounting::Excluded`（prompt 不含缓存口径），接线归该适配层创建处。
pub(crate) struct HttpProviderCall {
    /// 共享 reqwest 客户端（连接池 / TLS 会话跨 run 复用，AA-02 S-7）
    client: reqwest::Client,
    /// 生效配置（EngineHandle 重载时重建本适配层）
    /// （pub(crate)：SR-04 拆分后 engine_tests 为同级子模，测试面仍需
    /// 直读配置断言缓存/窗口；仅可见性调整，语义不变）
    pub(crate) config: EngineProviderConfig,
    /// 首字节超时
    first_byte_timeout: Option<Duration>,
    /// 流块间空闲超时
    idle_timeout: Option<Duration>,
}

impl HttpProviderCall {
    /// 新建适配层（共享客户端 + 生效配置）
    pub(crate) fn new(client: reqwest::Client, config: EngineProviderConfig) -> Self {
        Self {
            client,
            config,
            first_byte_timeout: Some(DEFAULT_FIRST_BYTE_TIMEOUT),
            idle_timeout: Some(DEFAULT_IDLE_TIMEOUT),
        }
    }

    /// chat-completions 请求选项（对话无关字段；模型 / max_tokens 透传）
    ///
    /// `reasoning_content` 为请求级配置（非历史字节）：按 vendor 推断的
    /// 键存在性模式，DeepSeek 恒 Require（P1 C3 唯一实现），其余厂商
    /// Omit 保持现状（P1 §3.4 C3 / P1 §3.3 B1 步骤 2.3）。
    pub(crate) fn request_options(&self, request: &ProviderRequest<'_>) -> ChatCompletionsRequestOptions {
        // 【调度者裁决】engine.rs 只调用 build_cache_policy（唯一运行时判定/消费
        // 入口，C2）：能力判定收敛在其内部——数据真源 = P3 cache_behavior_for
        // （矩阵 + catalog 模型级覆盖）；无 catalog 可用时回退内置保守兜底默认
        // （infer_cache_capability，数据值以 P3 §3.2.2 矩阵为准转录）。
        // catalog = bundled_catalog()（T-23 OnceLock 单例）；T-24 壳侧挂运行时
        // ModelCatalog 后此处可换为实例。session_id 由 SharedProvider 注入
        // （P2 步骤 4b）；overrides 走 config.extra.cache 通道（R2 恒空表 →
        // None，见 EngineProviderConfig.extra 注释）。
        let cache = build_cache_policy(
            Some(bundled_catalog()),
            Some(&self.config.base_url),
            Some(&self.config.model),
            request.session_id.as_deref(),
            self.config.extra.get("cache"),
        );
        ChatCompletionsRequestOptions {
            model: Some(self.config.model.clone()),
            stream: Some(self.config.stream),
            max_tokens: request.max_tokens.map(u64::from),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            reasoning_content: Some(self.reasoning_content_mode()),
            cache,
            ..ChatCompletionsRequestOptions::default()
        }
    }

    /// 请求体构建（DEEPCHECK-05 #10 修复：body 与 endpoint 同轨分流）
    ///
    /// responses 轨生效（[responses_endpoint_active]）→ responses wire 形状
    /// （input / instructions / max_output_tokens，无 chat 缓存字段）；否则 →
    /// chat-completions 形状（既有路径，字节与 P2 前逐字节一致）。
    pub(crate) fn request_body(
        &self,
        options: &ChatCompletionsRequestOptions,
        context: &RequestBuildContext<'_>,
    ) -> serde_json::Value {
        if responses_endpoint_active(&self.config) {
            build_responses_request_body(options, context)
        } else {
            build_chat_completions_request_body(options, context)
        }
    }

    /// 请求构建上下文（消息 0 深拷贝借用，PE-09 T09.3 阶段 1）
    /// （pub(crate)：SR-04 拆分后 engine_tests 为同级子模，测试面仍需
    /// 直用请求构建上下文断言；仅可见性调整，语义不变）
    pub(crate) fn build_context<'a>(&self, request: &ProviderRequest<'a>) -> RequestBuildContext<'a> {
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

    /// reasoning 键存在性按 vendor 推断（P1 C3 唯一实现，P3 不实现第二套）：
    /// DeepSeek 工具循环轮次必须回传 `reasoning_content`（空串兜底，缺键 400），
    /// 其余厂商 omit 保持现状。判定只依赖生效配置（base_url / model），
    /// 与请求历史无关，属稳定键。
    pub(crate) fn reasoning_content_mode(&self) -> ReasoningContentMode {
        match infer_reasoning_vendor(Some(&self.config.base_url), Some(&self.config.model)) {
            ReasoningVendor::Deepseek => ReasoningContentMode::Require,
            _ => ReasoningContentMode::Omit,
        }
    }

    /// 发送层基础请求头组装（G1 遗留 1 消费点）：Authorization 固定头 + 亲和头
    /// 追加（build.rs [affinity_http_headers] 产物）。policy = request_options
    /// 产出的 options.cache（Grok + 会话 ID → x-grok-conv-id 粘性路由头随请求
    /// 真实发出）；None / 无亲和头 → 零追加头，请求行为与现状一致。
    pub(crate) fn request_headers(&self, policy: Option<&CachePolicy>) -> Vec<(&'static str, String)> {
        let mut headers = vec![("Authorization", format!("Bearer {}", self.config.api_key))];
        headers.extend(affinity_http_headers(policy));
        headers
    }
}

#[async_trait]
impl ProviderCall for HttpProviderCall {
    async fn stream<'a>(
        &self,
        request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        // 1. 同步构建请求体（返回流 'static：请求体必须在此处序列化完毕，
        //    PE-02 §3.1.1；连接池 / endpoint 构建不变，T09.1.2 步骤 2）
        //    DEEPCHECK-05 #10 修复：body 与 URL 同轨（responses 轨 → responses wire
        //    形状；chat 轨 → chat 形状逐字节不变，回归护栏见 tests）
        let options = self.request_options(request);
        let context = self.build_context(request);
        let body = self.request_body(&options, &context);
        let url = provider_url(&self.config);

        // 2. HTTP 请求（共享连接池；传输层错误分类后上抛）
        // G1 遗留 1：亲和头合并进基础请求头（request_headers = Authorization
        // 固定头 + affinity_http_headers 追加，build.rs 消费点）——Grok
        // x-grok-conv-id 粘性路由头随请求真实发出；其余厂商零新增头。
        let mut request_builder = self.client.post(&url);
        for (name, value) in self.request_headers(options.cache.as_ref()) {
            request_builder = request_builder.header(name, value);
        }
        let response = match request_builder.json(&body).send().await {
            Ok(response) => response,
            Err(error) => {
                // 流前传输错误（reqwest 层）：分类后上抛（02 §四.1）
                let source = source_from_reqwest_error(&error);
                return Err(to_classified(classify_provider_error(
                    None,
                    None,
                    Some(source),
                    None,
                )));
            }
        };

        // 非 2xx：读 body → 分类（含 Retry-After 头；流前错误，未产出事件）
        let status = response.status();
        if !status.is_success() {
            let status_code = status.as_u16();
            // 头信息先于 body 消费读取（reqwest Response 非 Copy，
            // text() 消费 body 后再读 headers 属 use-after-move）
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

        // 3. 增量帧流 → 逐帧解析 → 逐事件产出（T09.1.2 步骤 2：unfold 状态机）
        let (_abort_flag, abort_handle) = AbortFlag::new();
        let read_options = StreamReadOptions {
            first_byte_timeout: self.first_byte_timeout,
            idle_timeout: self.idle_timeout,
            diagnostics: Some(StreamDiagnosticContext {
                provider_id: Some("openai-compatible".to_string()),
                endpoint: Some(self.config.endpoint.as_str().to_string()),
                url: Some(url.clone()),
                ..StreamDiagnosticContext::default()
            }),
        };
        let frames = stream_frames(response, read_options, abort_handle);
        let state = HttpStreamState {
            frames,
            parser: if responses_endpoint_active(&self.config) {
                HttpStreamParser::Responses(ResponsesParser::new())
            } else {
                HttpStreamParser::Chat(ChatCompletionsParser::new())
            },
            pending: VecDeque::new(),
            finished: false,
        };
        Ok(Box::pin(futures_util::stream::unfold(
            state,
            |mut state| async move { http_stream_next(&mut state).await.map(|item| (item, state)) },
        )))
    }
}

/// 增量解析状态机（T09.1：帧流 → 解析器 → 待发事件队列）
struct HttpStreamState {
    /// 底层帧流（帧 / 诊断 / 读取错误；错误后流立即结束）
    frames: Pin<Box<dyn Stream<Item = Result<StreamFrameEvent, agent_provider::sse::SseReadError<reqwest::Error>>> + Send>>,
    /// 端点解析器（DEEPCHECK-05 #10 修复：responses 轨 → ResponsesParser，
    /// 否则 ChatCompletionsParser——URL 与解析器必须同轨，防止"URL 走
    /// /responses 但按 chat 形状解析"的断层）
    parser: HttpStreamParser,
    /// 待发事件（一次读取可产出多帧事件，逐条流出）
    pending: VecDeque<ProviderStreamEvent>,
    /// 帧流已收尾（EOF 后 finish 事件已入队 / 错误终止）
    finished: bool,
}

/// 端点解析器二态（chat-completions / Responses，同一帧处理接口）
pub(crate) enum HttpStreamParser {
    Chat(ChatCompletionsParser),
    Responses(ResponsesParser),
}

impl HttpStreamParser {
    /// 逐帧解析（委派给当前轨解析器；错误语义一致：解析错误 Unknown 不可重试）
    pub(crate) fn push_frame(&mut self, frame: &SseFrame) -> Result<Vec<WireEvent>, StreamParseError> {
        match self {
            HttpStreamParser::Chat(parser) => parser.push_frame(frame),
            HttpStreamParser::Responses(parser) => parser.push_frame(frame),
        }
    }

    /// 流结束收尾（委派；每流恰好一个 stop，由解析器保证）
    pub(crate) fn finish(&mut self) -> Result<Vec<WireEvent>, StreamParseError> {
        match self {
            HttpStreamParser::Chat(parser) => parser.finish(),
            HttpStreamParser::Responses(parser) => parser.finish(),
        }
    }
}

/// 产出下一条流条目（Ok 事件 / Err 已分类错误；None = 流结束）
///
/// 顺序（T09.1.2 步骤 2）：
/// - 帧到达 → `parser.push_frame` → 该帧触发的事件逐条产出；
/// - 诊断条目 → provider-diagnostic 事件；
/// - EOF → `parser.finish()` → 剩余事件（flush pending + 唯一 stop）；
/// - 读取错误 → 分类后以 Err 条目终止流（02 §六.2 绝不静默结束）；
/// - 解析错误 → Unknown / 不可重试分类（:339-346 保持）。
async fn http_stream_next(state: &mut HttpStreamState) -> Option<Result<ProviderStreamEvent, ClassifiedStreamError>> {
    loop {
        // 待发事件优先逐条流出
        if let Some(event) = state.pending.pop_front() {
            return Some(Ok(event));
        }
        if state.finished {
            return None;
        }
        match state.frames.next().await {
            // EOF：flush pending → 唯一 stop（解析器 finish）
            None => match state.parser.finish() {
                Ok(events) => {
                    state.pending.extend(events.into_iter().map(to_loop_event));
                    state.finished = true;
                }
                Err(error) => {
                    state.finished = true;
                    return Some(Err(classify_stream_parse(&error)));
                }
            },
            Some(Ok(StreamFrameEvent::Frame(frame))) => match state.parser.push_frame(&frame) {
                Ok(events) => {
                    state.pending.extend(events.into_iter().map(to_loop_event));
                }
                Err(error) => {
                    // 解析错误：Unknown / 不可重试（T09.1.2 步骤 2）
                    state.finished = true;
                    return Some(Err(classify_stream_parse(&error)));
                }
            },
            Some(Ok(StreamFrameEvent::Diagnostic(diagnostic))) => {
                state
                    .pending
                    .push_back(ProviderStreamEvent::ProviderDiagnostic { diagnostic });
            }
            Some(Err(read_error)) => {
                // 读取错误（超时 / abort / 传输 / 分帧）：分类后 Err 条目终止
                state.finished = true;
                let source = source_from_sse_read_error(&read_error);
                let classified = classify_provider_error(None, None, Some(source), None);
                return Some(Err(to_classified(classified)));
            }
        }
    }
}

/// 分类错误 → 已分类流错误（02 §4.2 分类表产物）
pub(crate) fn to_classified(provider_error: agent_provider::error::ProviderError) -> ClassifiedStreamError {
    ClassifiedStreamError {
        kind: provider_error.kind(),
        message: provider_error.to_string(),
        retryable: provider_error.is_retryable(),
        retry_after_ms: provider_error.retry_after().map(|d| d.as_millis() as u64),
    }
}

/// 解析错误分类：Unknown / 不可重试（T09.1.2 步骤 2，:339-346 语义保持）
pub(crate) fn classify_stream_parse(_error: &StreamParseError) -> ClassifiedStreamError {
    ClassifiedStreamError {
        kind: ProviderErrorKind::Unknown,
        message: _error.to_string(),
        retryable: false,
        retry_after_ms: None,
    }
}

/// agent-provider 低级事件 → session-loop 消费事件（形状一致，逐字段转换；
/// session-loop 不直接依赖 agent-provider，B3.4 第 5 点）
pub(crate) fn to_loop_event(event: WireEvent) -> ProviderStreamEvent {
    match event {
        WireEvent::TextDelta { text } => ProviderStreamEvent::TextDelta { text },
        WireEvent::ThoughtDelta { text, redacted } => {
            ProviderStreamEvent::ThoughtDelta { text, redacted }
        }
        WireEvent::ToolCall { id, tool_name, input } => {
            ProviderStreamEvent::ToolCall { id, tool_name, input }
        }
        WireEvent::ProviderDiagnostic { diagnostic } => {
            ProviderStreamEvent::ProviderDiagnostic { diagnostic }
        }
        // M14：model 请求生命周期观测事件（before-request / after-response）——
        // 消费面在 agent-provider 请求层观测器（I8 钩子桥 model.*），
        // 不进入会话循环事件流（会话层无对应变体，观测语义在请求层闭环）
        WireEvent::BeforeRequest { .. } | WireEvent::AfterResponse { .. } => {
            tracing::debug!(target: "provider", "model 请求生命周期观测事件不进入会话循环");
            unreachable!("HttpProviderCall 不产出 before/after-response 流内事件");
        }
        WireEvent::Stop { reason, error, usage } => ProviderStreamEvent::Stop {
            reason: match reason {
                agent_provider::events::StopReason::Stop => LoopStopReason::Stop,
                agent_provider::events::StopReason::ToolCall => LoopStopReason::ToolCall,
                agent_provider::events::StopReason::Length => LoopStopReason::Length,
                agent_provider::events::StopReason::Error => LoopStopReason::Error,
            },
            error,
            // D7 §3.7 兼容：WireEvent::Stop 无分类字段（agent-provider 未
            // 升级）→ error_kind=None，只标 providerError 不伪造（与
            // session-loop stream.rs 的向后兼容语义一致）
            error_kind: None,
            usage: usage.map(|usage| ProviderUsage {
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                total_tokens: usage.total_tokens,
                cache_read_tokens: usage.cache_read_tokens,
                cache_write_tokens: usage.cache_write_tokens,
                // P2 步骤 1（T-10/T-16）：cacheMissTokens 逐字段透传（E0063 补齐；
                // 其余协议族 miss 由 cache_breakdown 按口径推导）
                cache_miss_tokens: usage.cache_miss_tokens,
                reasoning_tokens: usage.reasoning_tokens,
            }),
        },
    }
}
