//! 引擎装配层（B6.4：EngineHandle / HttpProviderCall / SessionLoopProducer /
//! BufferedRunEventBridge / DeltaSink 桥，PE-09 T09.1 增量流）
//!
//! 模块职责（B6.4 第 3 点：main.rs setup 重写的引擎面）：
//! - [EngineHandle]：provider 生效配置（baseUrl/model/apiKey 三件套，
//!   25-ipc-contract-audit.md:101）+ 工具注册表 + `engineReady`；
//! - [HttpProviderCall]：[session_loop::provider::ProviderCall] 的真实适配层
//!   ——chat-completions 请求体同步构建（返回流前完成序列化，PE-02 §3.1.1），
//!   增量帧流逐帧解析、逐事件产出（T09.1.2 步骤 2，unfold 状态机）；
//! - [SessionLoopProducer]：每 run 重建 [AgentSessionLoop]（PE-09 §4：
//!   真实接线跨 run 重建语义），装配 options / approval / delta_sink；
//! - [BufferedRunEventBridge]：[crate::core_event_bridge::EventBridge] +
//!   [crate::buffer::EventBuffer] 背压组装（入队时序列化，flush 直接发射，
//!   AA-06 P9）；
//! - [BridgeDeltaSink]：T09.1 实时轨 [session_loop::DeltaSink] 桥——信封
//!   `{event, runId: Some, sequence: None}` → 缓冲 → 立即 flush（丢帧由
//!   buffer 的 Delta 类目兜底，message-end 必达）。
//!
//! TODO(集成 agent)：main.rs 声明 `mod engine` 等本批模块并完成接线
//! （本文件不声明 mod）。

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use agent_provider::config::Endpoint;
use agent_provider::error::{
    classify_provider_error, source_from_reqwest_error, source_from_sse_read_error,
};
use agent_provider::models::{
    cache_ttl_for_provider_model, infer_vendor, CacheTtl, ModelCatalog,
};
use agent_provider::events::{ProviderStreamEvent as WireEvent, StreamParseError};
use agent_provider::parse::chat::ChatCompletionsParser;
use agent_provider::request::cache::{build_cache_policy, CachePolicy};
use agent_provider::request::build::affinity_http_headers;
use agent_provider::request::{
    build_chat_completions_request_body, infer_reasoning_vendor, ChatCompletionsRequestOptions,
    MaxTokensField, ReasoningContentMode, ReasoningVendor, RequestBuildContext,
    ToolDefinition as WireToolDefinition,
};
use agent_provider::sse::{AbortFlag, StreamDiagnosticContext, StreamReadOptions};
use agent_provider::transport::{stream_frames, StreamFrameEvent};
use agent_tools::audit::{AuditSink, SecurityAuditSink};
use agent_tools::background::BackgroundTaskManager;
use agent_tools::definition::{ToolDefinition, ToolError};
use agent_tools::mcp::{register_plugin_server, McpClientBridge, McpServerConfig};
use agent_tools::registry::ToolRegistry;
use agent_tools::tools::set_timer::TimerChannel;
use agent_tools::tools::wait_subagents::{DispatchDeclaration, SubagentWaitChannel};
// R-CF3 装配收口（T-CF-10）：wait 通道契约与适配器经库目标引入
// （wait_channel.rs 是库模块，bin 目标自动依赖同包 lib）
use crish_agent_workbench::wait_channel::{
    ControlBusResolver, EventStreamBroadcast, MemoryAgentSource, MemoryWaitStore,
    NoopControlBusResolver, SubagentStatusSource, WaitChannel, WaitStore,
};
use async_trait::async_trait;
use conex_types::denied_stats::DeniedStats;
use conex_types::error::ProviderErrorKind;
use conex_types::events::{
    AgentEvent, AgentEventEnvelope, MissAttribution, RunCacheStats, SecurityAuditDecision,
};
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::response::ClassifiedStreamError;
use conex_types::tool::SystemPromptWireMode;
use conex_telemetry::cache::WARN_MISSED_TOKENS;
use futures_util::{Stream, StreamExt};
use orchestrator::PendingMessageQueue;
use session_loop::provider::{
    DeltaSink, ProviderCall, ProviderEventStream, ProviderRequest,
};
use session_loop::stream::{
    ProviderStreamEvent, ProviderUsage, StopReason as LoopStopReason,
};
use session_loop::{
    AbortSignal, AgentSessionLoop, ApprovalGate, CacheTrackingConfig, ControlBus, RunOutcome,
    SessionLoopOptions, ToolBatchOptions,
};

use crate::buffer::{drop_class_of, EventBuffer};
use crate::core_event_bridge::{EmitReport, EventBridge};
use crate::fs_commands::skills::RustSkill;
use crate::timers::{AgentEventSink, MemoryTimerStore, QueuePendingSink, TimerRegistry};
use crate::watchdog::{LastWakeupTracker, Watchdog, WatchdogOptions};

/// 首字节超时（等待流首个字节到达；None = 不设限，对齐 normalizeStreamTimeoutMs）
const DEFAULT_FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(30);
/// 流块间空闲超时
const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

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

/// chat-completions 请求的端点路径（endpoint 缺省恒 chat-completions，00 D3）
///
/// P3 步骤 4b（T-23）：endpoint=Responses 时经模型目录判定该模型是否支持
/// Responses API（P3 §3.4.2）。DeepSeek 现状仅 v4-flash 支持 Responses、
/// v4-pro 官方计划 2026 年 8 月初加入（vendor-cache-gaps.md:95；加入后刷新
/// catalog.json 条目即可，无代码改动）。判定 = `supports_responses_for`：
/// - 支持 → 保持 /responses；
/// - 不支持 → 拒绝 responses 并降级回 chat-completions（P3 §3.4.2 降级策略由
///   引擎裁决：本引擎无 per-request 端点重试/诊断面，静默回退 chat-completions
///   最符合"模型不支持时必须可用"的现状语义）；
/// - 厂商未识别（baseUrl/model 均无关键字 → Auto）→ 目录无该厂商数据，
///   保留现状不降级（避免对自定义网关臆断降级）；DeepSeek 经 model 前缀
///   仍可命中判定（自建网关转发 deepseek-* 模型名同样受判）。
fn provider_url(config: &EngineProviderConfig) -> String {
    let base = config.base_url.trim_end_matches('/');
    match config.endpoint {
        Endpoint::Responses if !responses_supported(config) => {
            format!("{base}/chat/completions")
        }
        Endpoint::Responses => format!("{base}/responses"),
        _ => format!("{base}/chat/completions"),
    }
}

/// 内置模型目录单例（T-23：Responses 支持判定用）
///
/// catalog.json 编译期打包（include_str!，无运行时 IO）；OnceLock 保证
/// 进程内只解析一次（bundled() 每次解析成本避免）。T-24 壳侧挂
/// `Arc<RwLock<ModelCatalog>>` 后此处可换为运行时实例，内置表即当前数据真源。
static BUNDLED_CATALOG: OnceLock<ModelCatalog> = OnceLock::new();

fn bundled_catalog() -> &'static ModelCatalog {
    BUNDLED_CATALOG.get_or_init(ModelCatalog::bundled)
}

/// Responses API 支持判定（P3 §3.1.5 / §3.4.2，T-18 查询接口）
///
/// vendor 未识别（Auto）→ 目录无该厂商数据，返回 true（保留现状不干预）；
/// 其余厂商按目录条目 `supports_responses` 判定，未知模型保守视为不支持
/// （对齐 catalog.rs 注释"未知模型保守为不支持"，jcode"否则视为不支持"）。
fn responses_supported(config: &EngineProviderConfig) -> bool {
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
    config: EngineProviderConfig,
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
    fn request_options(&self, request: &ProviderRequest<'_>) -> ChatCompletionsRequestOptions {
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

    /// 请求构建上下文（消息 0 深拷贝借用，PE-09 T09.3 阶段 1）
    fn build_context<'a>(&self, request: &ProviderRequest<'a>) -> RequestBuildContext<'a> {
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
    fn reasoning_content_mode(&self) -> ReasoningContentMode {
        match infer_reasoning_vendor(Some(&self.config.base_url), Some(&self.config.model)) {
            ReasoningVendor::Deepseek => ReasoningContentMode::Require,
            _ => ReasoningContentMode::Omit,
        }
    }

    /// 发送层基础请求头组装（G1 遗留 1 消费点）：Authorization 固定头 + 亲和头
    /// 追加（build.rs [affinity_http_headers] 产物）。policy = request_options
    /// 产出的 options.cache（Grok + 会话 ID → x-grok-conv-id 粘性路由头随请求
    /// 真实发出）；None / 无亲和头 → 零追加头，请求行为与现状一致。
    fn request_headers(&self, policy: Option<&CachePolicy>) -> Vec<(&'static str, String)> {
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
        let options = self.request_options(request);
        let context = self.build_context(request);
        let body = build_chat_completions_request_body(&options, &context);
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
            parser: ChatCompletionsParser::new(),
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
    /// chat-completions 逐帧解析器
    parser: ChatCompletionsParser,
    /// 待发事件（一次读取可产出多帧事件，逐条流出）
    pending: VecDeque<ProviderStreamEvent>,
    /// 帧流已收尾（EOF 后 finish 事件已入队 / 错误终止）
    finished: bool,
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
fn to_classified(provider_error: agent_provider::error::ProviderError) -> ClassifiedStreamError {
    ClassifiedStreamError {
        kind: provider_error.kind(),
        message: provider_error.to_string(),
        retryable: provider_error.is_retryable(),
        retry_after_ms: provider_error.retry_after().map(|d| d.as_millis() as u64),
    }
}

/// 解析错误分类：Unknown / 不可重试（T09.1.2 步骤 2，:339-346 语义保持）
fn classify_stream_parse(_error: &StreamParseError) -> ClassifiedStreamError {
    ClassifiedStreamError {
        kind: ProviderErrorKind::Unknown,
        message: _error.to_string(),
        retryable: false,
        retry_after_ms: None,
    }
}

/// agent-provider 低级事件 → session-loop 消费事件（形状一致，逐字段转换；
/// session-loop 不直接依赖 agent-provider，B3.4 第 5 点）
fn to_loop_event(event: WireEvent) -> ProviderStreamEvent {
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

// ── EngineHandle ──────────────────────────────────────────────────

// ── 15-T-6（裁决 D9）：路由型审计 sink ────────────────────────────

/// 路由型审计 sink（15-T-6 接线，裁决 D9）：run 级桥注册表 +
/// G10 denied 计数
///
/// - 工具级审计（shell/delete 等工具经 `BuiltinToolConfig.audit_sink`
///   发射的 security-audit，现状走 NoopAuditSink 静默丢弃）按
///   session_id 路由到该会话当前活动 run 的审计桥（[BridgeAuditSink]
///   → 缓冲事件桥 → 前端审计面板 per-run 面实时可见，34-T7 口径；
///   L4（F12）已补落库面——桥内持久化通道 → events 表审计底账）；
/// - **域隔离边界**（30 §9 最终口径）：任务域审计（10-P3
///   TaskAuditAccumulator → EventBridge 直发，operation=command-exec）
///   **不经本 sink**——本 sink 只承接工具面审计，两路均以
///   security-audit 事件形态经 run 桥到达前端，无重复无遗漏；
/// - 计数面（G10）：denied 决策同步计入共享 [DeniedStats]（与
///   agent-tools `CountingAuditSink` :94-105 同构语义），月度报告
///   经 [DeniedStats::summary] 拉取。
#[derive(Debug)]
pub(crate) struct RoutingAuditSink {
    /// session_id → 该会话当前活动 run 的审计桥（run 启动注册、收口注销）
    routes: Mutex<HashMap<String, AuditSink>>,
    /// G10 denied 计数（引擎级共享实例）
    stats: Arc<DeniedStats>,
}

impl RoutingAuditSink {
    /// 新建路由注册表（共享统计实例）
    pub(crate) fn new(stats: Arc<DeniedStats>) -> Self {
        Self {
            routes: Mutex::new(HashMap::new()),
            stats,
        }
    }

    /// run 启动注册；同 session 多 run 并发 → 后注册者覆盖（新 run 覆盖
    /// 旧 run，与事件收口旁路点口径一致——会话内串行守卫下同 session
    /// 同时仅一个活动 run，覆盖为防御性语义）
    pub(crate) fn register(&self, session_id: &str, sink: AuditSink) {
        self.routes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.to_string(), sink);
    }

    /// run 收口强制注销（防 session 泄漏）；重复注销幂等
    pub(crate) fn unregister(&self, session_id: &str) {
        self.routes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session_id);
    }

    /// 已注册路由数（测试断言面：收口注销无残留）
    #[cfg_attr(not(test), allow(dead_code))] // 测试断言面消费
    pub(crate) fn route_count(&self) -> usize {
        self.routes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }
}

impl SecurityAuditSink for RoutingAuditSink {
    fn emit(&self, event: &AgentEvent) {
        let AgentEvent::SecurityAudit {
            session_id,
            decision,
            ..
        } = event
        else {
            return;
        };
        // G10：denied 决策同步计数（与 CountingAuditSink 同构语义，
        // 其余决策转发不计数）
        if *decision == SecurityAuditDecision::Denied {
            self.stats.record_security_audit_denied();
        }
        // 锁内仅取路由句柄克隆，不持锁跨 emit 调用（sink 可能重入）
        let sink = self
            .routes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .cloned();
        match sink {
            Some(sink) => sink.emit(event),
            None => {
                // 无活动 run / 未注册 → tracing 兜底（Noop 语义不 panic）
                tracing::debug!(
                    target: "audit",
                    session_id,
                    "审计事件无活动 run 路由，tracing 兜底"
                );
            }
        }
    }
}

/// T-CF-10/13 共享适配桥：WaitChannel 的 dispatch 声明存储
/// （wait_channel.rs 库目标 [MemoryWaitStore]）同时作为 A7 watchdog 的
/// 声明读取源——同一实例双 trait 注入（[WaitStore] ↔ [crate::watchdog::DispatchStore]），
/// wait 落库即 watchdog 可读，重启恢复数据面统一（watchdog.rs 的
/// MemoryDispatchStore 为测试面独立实现，生产装配统一走本桥）。
impl crate::watchdog::DispatchStore for MemoryWaitStore {
    fn load_declarations(&self) -> Vec<DispatchDeclaration> {
        WaitStore::load_all(self)
    }
}

/// 会话级 Summarizer 工厂（T-43，00-plan §10 轮次 6 / 04 §9.4 T16；评审
/// 01 P1-2「补壳层/接线任务」）
///
/// - **注入通道**：按会话创建 [conex_compaction::Summarizer] 实例——每
///   会话独立实例边界（04 §7.1 隔离决议：per-session 实例，共享 provider
///   客户端但无共享可变状态；RetryGuardSummarizer 内部互斥仅存在
///   per-session 形态，杜绝并发摘要串行化与 last 串扰）；
/// - **无注入 → None**：不 spawn 后台摘要任务（纯 stub awaiting 永驻，
///   00-plan §6.4「无注入不 spawn」），与接线前行为一致；
/// - **真实 provider 实现属产品功能**：本轮只打通通道（CoreRunState 持
///   有 + run 装配消费），不强制真实 provider 调用实现——生产侧由壳层
///   在 session.start / 配置加载时经 set_summarizer_factory 注入。
pub type SummarizerFactory =
    Box<dyn Fn(&str) -> Option<Arc<dyn conex_compaction::Summarizer>> + Send + Sync>;

/// 摘要请求超时（秒；单次摘要调用总预算，对齐后台墙钟
/// [session_loop::LOOP_SUMMARY_MAX_WALL_MS] ≈ 60s 的同步面口径）
const SUMMARY_HTTP_TIMEOUT: Duration = Duration::from_secs(60);
/// 摘要请求线程存活兜底（recv 等待预算 = 请求超时 + 30s 余量，
/// 线程内 reqwest 自带超时保证 ≤60s 终止，不会悬挂）
const SUMMARY_HTTP_RECV_TIMEOUT: Duration = Duration::from_secs(90);

/// 生产 LLM 摘要器（COMPACTION-01 P0-3 闭环：真实 provider 调用，
/// 经 chat-completions 通道，模型用当前 provider 配置）。
///
/// ## C14 缓存隔离（摘要请求独立前缀域）
///
/// - **单条 user 消息**：摘要提示词（含既有摘要 + 丢弃消息渲染）整体作为
///   唯一 user 消息发出，无 system 消息——不继承主对话任何前缀；
/// - **无 tools**：请求体不含 `tools` / `tool_choice` 字段；
/// - **无缓存断点**：`cache: None`——请求体不含 `prompt_cache_key` /
///   `prompt_cache_retention` / `prompt_cache_options`，消息上无
///   `cache_control` 断点（build_chat_completions_request_body 的
///   compactObject 语义：None 一律省略）；
/// - **无会话亲和键**：不携带 session_id，HTTP 头仅 Authorization——
///   无 x-grok-conv-id 等粘性路由头（affinity_http_headers 依赖
///   CachePolicy，本实现恒 None → 零追加头）。
///
/// ## 同步 trait 面内的异步执行
///
/// [conex_compaction::Summarizer] 为同步签名；真实调用需异步 HTTP。
/// 实现经「专用 std 线程 + 独立 current_thread runtime」承接：在全新线程
/// 内构建独立 tokio runtime 并 block_on 异步 reqwest 调用——不嵌套在
/// 调用方 runtime 上（同步预检路径在 tokio 主循环线程内调用也不 panic、
/// 不占用主 runtime worker；后台路径原样经 spawn_blocking 承接）。线程
/// 内 reqwest 自带 [SUMMARY_HTTP_TIMEOUT] 兜底，最坏 ≤60s 自终止。
///
/// 失败降级：任何错误（传输 / 非 2xx / 响应缺 content）返回 Err——调用方
/// （引擎同步面 / 后台调度）按契约回退 L1 占位符（中性 stub），不阻塞
/// 主对话。
pub(crate) struct ProviderSummarizer {
    /// 共享 reqwest 客户端（与引擎同实例，连接池复用——AA-02 S-7）
    client: reqwest::Client,
    /// 生效 provider 配置快照（工厂解析时刻的当前配置；reload 后下一次
    /// run 经 factory 重新解析获得新快照）
    config: EngineProviderConfig,
    /// 摘要输出 token 预算（默认 [conex_compaction::MAX_SUMMARY_TOKENS_DEFAULT]）
    max_summary_tokens: usize,
}

impl ProviderSummarizer {
    pub(crate) fn new(
        client: reqwest::Client,
        config: EngineProviderConfig,
        max_summary_tokens: usize,
    ) -> Self {
        Self {
            client,
            config,
            max_summary_tokens,
        }
    }

    /// 构建摘要请求体（纯函数，测试断言 C14 隔离面：单条 user 消息 /
    /// 无 tools / 无缓存参数）
    fn build_request_body(&self, prompt: &str) -> serde_json::Value {
        let options = ChatCompletionsRequestOptions {
            model: Some(self.config.model.clone()),
            // 非流式：一次收全响应，同步面逐字节解析
            stream: Some(false),
            max_tokens: Some(self.max_summary_tokens as u64),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            // C14：None = 完全不参与缓存（无 prompt_cache_key / 断点 /
            // 会话亲和键），请求体不含任何 cache 键
            cache: None,
            ..ChatCompletionsRequestOptions::default()
        };
        let message = user_message(prompt, None);
        let message_arc = Arc::new(message);
        let context = RequestBuildContext {
            system_prompt: None,
            messages: std::slice::from_ref(&message_arc),
            tools: Vec::new(),
            wire_mode: SystemPromptWireMode::NativeSystemRole,
        };
        build_chat_completions_request_body(&options, &context)
    }
}

impl conex_compaction::Summarizer for ProviderSummarizer {
    fn summarize(
        &self,
        dropped: &[conex_types::message::AgentMessage],
        existing: Option<&str>,
    ) -> Result<String, String> {
        // 提示词 = 引擎侧单源（ai_summary::build_summarize_prompt，Schema V1
        // JSON 输出契约，P1-C 对齐后不再是五字段孤儿）
        let prompt = conex_compaction::ai_summary::build_summarize_prompt(dropped, existing);
        let body = self.build_request_body(&prompt);
        let url = provider_url(&self.config);
        let api_key = self.config.api_key.clone();
        let client = self.client.clone();
        // 专用线程 + 独立 current_thread runtime（见类型注释：不嵌套调用方
        // runtime；线程内 reqwest 超时兜底，最坏 ≤60s 自终止）
        let (tx, rx) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("conex-summary-http".to_string())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = tx.send(Err(format!("摘要运行时构建失败：{error}")));
                        return;
                    }
                };
                let result = runtime.block_on(async move {
                    let response = client
                        .post(&url)
                        .header("Authorization", format!("Bearer {api_key}"))
                        .timeout(SUMMARY_HTTP_TIMEOUT)
                        .json(&body)
                        .send()
                        .await
                        .map_err(|error| format!("摘要请求失败：{error}"))?;
                    let status = response.status();
                    let text = response
                        .text()
                        .await
                        .map_err(|error| format!("摘要响应读取失败：{error}"))?;
                    if !status.is_success() {
                        let excerpt: String = text.chars().take(200).collect();
                        return Err(format!("摘要 HTTP {status}：{excerpt}"));
                    }
                    summary_content_from_response(&text).ok_or_else(|| {
                        "摘要响应缺少 choices[0].message.content（非空文本）".to_string()
                    })
                });
                let _ = tx.send(result);
            })
            .map_err(|error| format!("摘要请求线程启动失败：{error}"))?;
        // recv 超时兜底（线程内 reqwest 超时保证 ≤60s 自终止；超时返回后
        // 句柄 drop 分离线程，不 join 阻塞）
        let inner = rx
            .recv_timeout(SUMMARY_HTTP_RECV_TIMEOUT)
            .map_err(|_| format!("摘要 HTTP 调用超时（>{:?} 无响应）", SUMMARY_HTTP_RECV_TIMEOUT))?;
        let _ = thread;
        inner
    }
}

/// 从 chat-completions 非流响应提取正文（`choices[0].message.content`；
/// 缺失 / 空串 / 非法 JSON → None → 调用方降级 L1 占位符）
fn summary_content_from_response(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let content = value
        .get("choices")?
        .as_array()?
        .first()?
        .get("message")?
        .get("content")?
        .as_str()?;
    let content = content.trim();
    if content.is_empty() {
        None
    } else {
        Some(content.to_string())
    }
}

/// 生产 Summarizer 工厂（COMPACTION-01 P0-3 闭环：factory 返回真实 LLM
/// 实现 [ProviderSummarizer]——替代测试面 fake 注入）。
///
/// - 按会话解析（per-session 实例边界，04 §7.1 隔离决议）：每次解析读取
///   引擎**当前**生效 provider 配置 + 共享连接池客户端——`config_profile_apply`
///   热更新后下一次 run 立即生效（与 [EngineHandle::reload_provider] 同源）；
/// - provider 未就绪（三件套缺失）→ None（不注入，纯 stub awaiting 语义
///   保持，与接线前一致）；
/// - 摘要输出预算默认 [conex_compaction::MAX_SUMMARY_TOKENS_DEFAULT]（1024，
///   与 CompactionPolicy 默认同源；session_meta 覆盖经 policy 面生效，引擎
///   侧字节预算校验兜底）。
pub(crate) fn production_summarizer_factory(
    engine: Arc<EngineHandle>,
) -> SummarizerFactory {
    Box::new(move |_session_id: &str| {
        let config = engine.provider_config()?;
        let client = engine.http_client();
        Some(Arc::new(ProviderSummarizer::new(
            client,
            config,
            conex_compaction::MAX_SUMMARY_TOKENS_DEFAULT,
        )) as Arc<dyn conex_compaction::Summarizer>)
    })
}

/// 引擎句柄（B6.4：provider 生效配置 + 工具注册表 + engineReady）
///
/// - `ready()`：provider 配置三件套（baseUrl/model/apiKey）齐备即可发起
///   调用；加载失败仅降级未就绪（engine.rs:112-125），不 panic；
/// - 工具注册表：内置工具（fs/shell/search/diff，B5.2）注册失败仅告警
///   （工具执行器按 tool.not_found 兜底）；
/// - 跨会话并发安全：provider 只读共享（Mutex<Option<Arc<dyn ProviderCall>>>），
///   std Mutex 不跨 await 持有（AA-02 并发模型注记）。
pub(crate) struct EngineHandle {
    /// 共享 reqwest 客户端（连接池 / TLS 会话跨 run 复用；provider 重载时
    /// 重建适配层但复用同一客户端——AA-02 S-7 连接池语义保持）
    http_client: reqwest::Client,
    /// 生效的 provider 适配层（None = 配置缺失降级未就绪）
    provider: Mutex<Option<Arc<dyn ProviderCall>>>,
    /// 工具注册表（只读共享）
    tool_registry: Arc<ToolRegistry>,
    /// MCP 客户端桥（E5：插件 mcpServers 受管服务器 + 工具并入运行集；
    /// 生命周期随 run 启停由上层驱动——session.start 启动 / session.end
    /// 关闭，见 [Self::register_plugin_mcp_server]）
    mcp_bridge: Arc<McpClientBridge>,
    /// engineReady（配置齐备即 true）
    ready: AtomicBool,
    /// 未就绪原因（ready=false 时的诊断文案，PE-04 T04.5 联动）
    ready_reason: Mutex<Option<String>>,
    /// 生效 provider 配置快照（P5 S5 / T-40：缓存测量装配数据源；
    /// None = 未就绪）
    provider_config: Mutex<Option<EngineProviderConfig>>,
    /// 会话级缓存测量状态（T-40：跨 run 冷缓存预警 + 模型切换检测数据源；
    /// 内存态，跨重启由 runs 表 v5 列兜底——warm_until_ms 落库，T-39）
    cache_sessions: Mutex<HashMap<String, SessionCacheState>>,
    /// 定时器注册表（G5 T-CF-06/07：register/cancel/到期 steering 注入/
    /// 早退钩子；TimerChannel 契约实现，经 BuiltinToolConfig.timer_channel
    /// 注入 set_timer / cancel_timer 工具——engine.rs:617 装配处扩展）
    timer_registry: Arc<TimerRegistry>,
    /// 定时器 steering 落点（PendingMessageQueue 适配的底层队列；
    /// 到期条目落在真实队列，R-CF3 idle 续 run 装配收口消费——经
    /// [Self::timer_steering_queue] 访问器被 CoreRunState::new 消费，
    /// 陈旧 allow 已核销）
    timer_steering_queue: Arc<Mutex<PendingMessageQueue>>,
    /// 子代理等待通道（T-CF-10：SubagentWaitChannel 契约实现；经
    /// BuiltinToolConfig.subagent_wait_channel 注入 wait_subagents 工具）
    wait_channel: Arc<dyn SubagentWaitChannel>,
    /// dispatch 声明存储（WaitChannel 落库 / A7 watchdog 读取的共享
    /// 实例；conex-db session_meta 真适配接线见 wait_channel.rs 模块头
    /// 注记——与 TimerStore 同一接线缺口）
    dispatch_store: Arc<MemoryWaitStore>,
    /// subagent-ended 事件流广播（EventQueue 旁路适配：wait_for_terminal
    /// 的订阅面；经 [Self::terminal_stream] 访问器被 CoreRunState
    /// finalize_subagent_spawner 消费，陈旧 allow 已核销）
    terminal_stream: Arc<EventStreamBroadcast>,
    /// 最近事件唤醒跟踪（watchdog 失联判定数据源；事件收口处已接线：
    /// 壳层 drive_run_loop 事件 emit 循环与子代理终态收口调用
    /// mark_wakeup（R-CF3 核销），任何事件到达即更新）
    last_wakeup: Arc<LastWakeupTracker>,
    /// Cron 调度注册表（T-CF-09 A5 提供；None = 未装配降级，workflow
    /// 命令面经 main.rs（A9）消费——30 方案 P6/P7 后经
    /// [Self::scheduler_registry] 访问器被装配轮消费，allow 已核销）
    scheduler_registry: Option<Arc<crate::sched::SchedulerRegistry>>,
    /// 定时器事件缓冲（T-CF-06 装配产物；P4 drain 转发接线：经
    /// [Self::timer_event_sink] 暴露给 [forward_drained_timer_events] 与
    /// 批 3 main.rs drain 任务周期消费——事件不再终老于缓冲，A10 N-05）
    timer_event_sink: Arc<AgentEventSink>,
    /// cron 事件缓冲（T-CF-09 装配产物；同 timer 的 drain 转发路径——
    /// cron-fired 单臂，conex-types 仅 CronFired 变体，无 cron-cancelled）
    scheduler_event_sink: Arc<crate::sched::SchedEventSink>,
    /// 路由型审计 sink（15-T-6 裁决 D9）：工具级 security-audit 事件经
    /// run 级桥注册表送达前端审计面板（run 启动注册 / 收口注销由
    /// CoreRunState 驱动）；G10 denied 计数共享实例。任务域审计
    /// （10-P3）EventBridge 直发、不经本 sink（30 §9 域隔离）
    audit_sink: Arc<RoutingAuditSink>,
    // T-D-13 精简：spawner 字段冗余（全仓无读取方，A8 D3）——实际
    // spawner 由 CoreRunState::finalize_subagent_spawner 自管，构造参数
    // 保留经 BuiltinToolConfig.subagent_spawner 注入 run_subagent 工具
}

impl EngineHandle {
    /// 初始化引擎（加载生效配置 + 内置工具注册；失败仅降级未就绪）。
    ///
    /// T-D-13：spawn 通道未注入（None）——run_subagent 返回
    /// common.unsupported 降级；生产装配走 [Self::new_with_spawner]。
    pub(crate) fn new(background_manager: Option<Arc<dyn BackgroundTaskManager>>) -> Self {
        Self::new_with_spawner(background_manager, None)
    }

    /// 初始化引擎并注入子代理 spawn 通道（T-D-13 生产装配点：CoreRunState
    /// 创建 spawner 实例后传入，经 BuiltinToolConfig.subagent_spawner 接线
    /// run_subagent 工具）
    pub(crate) fn new_with_spawner(
        background_manager: Option<Arc<dyn BackgroundTaskManager>>,
        subagent_spawner: Option<Arc<dyn agent_tools::tools::subagent::SubagentSpawner>>,
    ) -> Self {
        let client = Arc::new(reqwest::Client::new());

        // G5 T-CF-06/07：TimerRegistry 装配（pending sink = 真实
        // PendingMessageQueue、event sink = 缓冲适配、store = 内存适配；
        // conex-db session_meta 与 EventBridge 真适配接线在 R-CF3 装配
        // 收口，见 timers.rs 头部注记）
        let timer_steering_queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        // P4（30 方案 §4）：事件缓冲实例由引擎持有（经
        // [Self::timer_event_sink] 访问器暴露给 drain 转发 helper 与
        // 批 3 main.rs drain 任务；TimerRegistry 注入同一 Arc——
        // 缓冲 → 转发同实例，不出现第二份无人消费的缓冲）
        let timer_event_sink = Arc::new(AgentEventSink::new());
        // 显式 trait 化（先 clone 出 Arc<AgentEventSink> 再经赋值 unsize
        // 强转——Arc::clone 泛型推断无法经引用反向强转）
        let timer_event_sink_trait: Arc<dyn crate::timers::EventSink> =
            timer_event_sink.clone();
        let timer_registry = Arc::new(TimerRegistry::new(
            Arc::new(QueuePendingSink::new(Arc::clone(&timer_steering_queue))),
            timer_event_sink_trait,
            MemoryTimerStore::shared(),
        ));
        // 启动恢复：扫描已持久化声明，重建未到期定时器 / 补发已到期未
        // 注入（内存 store 下为空集；conex-db 真适配接线后此处即重启
        // 恢复入口——T-CF-06 §4）。try_current 守卫：纯同步构造上下文
        // （无 tokio runtime 的测试/装配路径）跳过，不 panic。
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn({
                let registry = Arc::clone(&timer_registry);
                async move {
                    registry.restore().await;
                }
            });
        } else {
            tracing::debug!(
                target: "engine",
                "TimerRegistry 启动恢复跳过：当前上下文无 tokio runtime"
            );
        }

        // ── T-CF-10：WaitChannel 装配（SubagentWaitChannel 契约实现）──
        // dispatch 声明存储与 A7 watchdog 共享（同一实例双 trait 注入，
        // 桥接 impl 见文件头部「T-CF-10/13 共享适配桥」段）；终态事件流
        // 广播为事件收口旁路点的订阅面（wait 通道不直接持有 EventQueue）
        let dispatch_store = Arc::new(MemoryWaitStore::new());
        let terminal_stream = Arc::new(EventStreamBroadcast::new());
        let wait_channel = Arc::new(WaitChannel::new(
            Arc::clone(&dispatch_store) as Arc<dyn WaitStore>,
            Arc::new(MemoryAgentSource::new()) as Arc<dyn SubagentStatusSource>,
            Arc::clone(&terminal_stream),
            Arc::new(NoopControlBusResolver) as Arc<dyn ControlBusResolver>,
        ));

        // ── T-CF-13：Watchdog 装配（A7 提供 pub(crate) 构造器与 spawn）──
        // 最近事件唤醒跟踪（事件收口处 mark_wakeup 已接线：壳层事件
        // emit 循环与子代理终态收口驱动，R-CF3 核销）
        let last_wakeup = Arc::new(LastWakeupTracker::new());
        // 引擎级无会话归属：空串占位；会话级 watchdog 由 T-CF-11（A8）
        // idle 续 run 收口按会话 spawn（watchdog.rs 头部注记）。
        // active_timer_probe：TimerRegistry 无同步计数接口（timers.rs
        // 本轮只读），缺省 0 不抑制兜底——同步计数接线登记遗留问题
        let watchdog = Arc::new(Watchdog::new(
            String::new(),
            Arc::clone(&timer_steering_queue),
            Arc::clone(&dispatch_store) as Arc<dyn crate::watchdog::DispatchStore>,
            Arc::clone(&last_wakeup),
            Arc::new(|| 0),
            WatchdogOptions::default(),
        ));
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            crate::watchdog::spawn(&runtime, Arc::clone(&watchdog));
        } else {
            tracing::debug!(
                target: "engine",
                "Watchdog 装配跳过：当前上下文无 tokio runtime"
            );
        }

        // ── T-CF-09：SchedulerRegistry 装配（A5 提供 pub(crate) 构造器）──
        // 已按 A5 落盘签名对齐（pending/events/store/launcher 四适配；
        // launcher 未接线 → is_daemon 触发降级 steering 注入，防丢唤醒）。
        // P4：事件缓冲实例由引擎持有（同 timer_event_sink 模式，经
        // [Self::scheduler_event_sink] 暴露给 drain 转发路径）
        let scheduler_event_sink = Arc::new(crate::sched::SchedEventSink::new());
        let scheduler_registry = assemble_scheduler_registry(
            &timer_steering_queue,
            Arc::clone(&scheduler_event_sink),
        );

        // ── 15-T-6（裁决 D9）：路由型 audit_sink 装配 ──────────────
        // G10 denied 计数实例（引擎级共享；workbench 侧零 DeniedStats
        // 使用点实证——本装配即接线点）+ run 级桥注册表。工具级审计
        // （shell/delete 的 security-audit，现状 NoopAuditSink 静默丢弃）
        // 经 BuiltinToolConfig.audit_sink 注入本 sink，run 启动注册 /
        // 收口注销由 CoreRunState 驱动（core_run_commands.rs run 装配
        // 块）。域隔离：任务域审计（10-P3 TaskAuditAccumulator →
        // EventBridge 直发）不经本 sink（30 §9 最终口径）。
        let audit_sink = Arc::new(RoutingAuditSink::new(Arc::new(DeniedStats::new())));

        // 内置工具注册（B5.2：fs / shell / search / diff；F1 R-AB1：
        // BuiltinToolConfig 注入后台任务管理器，经 ToolContext.background
        // 透传给 shell 工具——adopt 通道就位；G5 T-CF-05/06：timer_channel
        // 注入 TimerRegistry 契约，set_timer / cancel_timer 工具消费；
        // T-CF-10：subagent_wait_channel 注入 WaitChannel 契约，
        // wait_subagents 工具消费）
        let mut registry = ToolRegistry::new();
        let config = agent_tools::tools::BuiltinToolConfig {
            background_manager,
            timer_channel: Some(Arc::clone(&timer_registry) as Arc<dyn TimerChannel>),
            // 装配收口（T-CF-10）：BuiltinToolConfig 全字段显式注入后改走
            // register_builtin_tools_with_config（现状默认注册处）；未装配
            // 字段保持 Default（None 语义，工具返回 common.unsupported 降级）
            subagent_wait_channel: Some(
                Arc::clone(&wait_channel) as Arc<dyn SubagentWaitChannel>
            ),
            // T-D-13：子代理 spawn 通道注入（None = run_subagent 返回
            // common.unsupported；生产装配点 = CoreRunState 构造 spawner 后
            // 经 new_with_spawner 传入）
            subagent_spawner: subagent_spawner.clone(),
            // 15-T-6（裁决 D9）：路由型审计 sink 注入（shell/delete 工具
            // security-audit 发射点接线；现状 None = NoopAuditSink 静默
            // 丢弃，接线后经 run 桥到达前端审计面板）
            audit_sink: Some(Arc::clone(&audit_sink) as AuditSink),
            ..agent_tools::tools::BuiltinToolConfig::default()
        };
        if let Err(error) =
            agent_tools::tools::register_builtin_tools_with_config(&mut registry, config)
        {
            tracing::warn!(
                target: "engine",
                error = %error,
                "内置工具注册失败（工具按 tool.not_found 兜底）"
            );
        }
        let tool_registry = Arc::new(registry);
        // E5：MCP 客户端桥初始化（stdio 服务器管理 + 工具适配；插件
        // mcpServers 经 register_plugin_mcp_server 注册为受管服务器）
        let mcp_bridge = Arc::new(McpClientBridge::new());

        // provider 生效配置加载（三件套齐备才就绪）
        let (provider, ready, ready_reason, provider_config) = match load_provider_endpoint() {
            Some(config) => {
                let provider: Arc<dyn ProviderCall> =
                    Arc::new(HttpProviderCall::new((*client).clone(), config.clone()));
                (Some(provider), true, None, Some(config))
            }
            None => {
                tracing::warn!(
                    target: "engine",
                    "engine not ready: provider 配置缺失（baseUrl/model/apiKey 三件套）"
                );
                (
                    None,
                    false,
                    Some("provider 配置缺失（baseUrl/model/apiKey）".to_string()),
                    None,
                )
            }
        };

        Self {
            http_client: (*client).clone(),
            provider: Mutex::new(provider),
            tool_registry,
            mcp_bridge,
            ready: AtomicBool::new(ready),
            ready_reason: Mutex::new(ready_reason),
            provider_config: Mutex::new(provider_config),
            cache_sessions: Mutex::new(HashMap::new()),
            timer_registry,
            timer_steering_queue,
            wait_channel,
            dispatch_store,
            terminal_stream,
            last_wakeup,
            scheduler_registry,
            timer_event_sink,
            scheduler_event_sink,
            audit_sink,
        }
    }

    /// 测试面：注入 provider 适配层与生效配置并置就绪（T-D-13 端到端测试
    /// 用——run_task_impl 完整装配不依赖磁盘 config，CI 确定性；经
    /// [Self::cache_tracking_config] 同步生效——默认模型继承断言数据源）
    #[cfg(test)]
    pub(crate) fn inject_provider_for_test(
        &self,
        provider: Arc<dyn ProviderCall>,
        config: EngineProviderConfig,
    ) {
        *self.provider.lock().unwrap_or_else(|e| e.into_inner()) = Some(provider);
        *self.provider_config.lock().unwrap_or_else(|e| e.into_inner()) = Some(config);
        self.ready.store(true, Ordering::SeqCst);
        *self.ready_reason.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// engineReady（provider 配置齐备即可发起调用）
    pub(crate) fn ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    /// 未就绪原因（ready=false 时的诊断文案）
    pub(crate) fn ready_reason(&self) -> Option<String> {
        self.ready_reason
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 生效的 provider 适配层（None = 未就绪）
    pub(crate) fn provider(&self) -> Option<Arc<dyn ProviderCall>> {
        self.provider
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 共享 reqwest 客户端克隆（ProviderSummarizer 复用连接池——AA-02 S-7；
    /// provider 重载重建适配层但复用同一客户端，摘要面同源）
    pub(crate) fn http_client(&self) -> reqwest::Client {
        self.http_client.clone()
    }

    /// 重建 provider 适配层并原子交换（F4 F1-01 修复，PS-04 T4.3 接线点：
    /// `config_profile_apply` / `config_update` 写 store 成功后调用，下一次
    /// run 立即使用新凭据——key/baseUrl/model 热更新）。
    ///
    /// 根因注记：`HttpProviderCall` 持有构造时 `EngineProviderConfig` 快照
    /// （:285-291），旧实现只在引擎构造时加载一次（:927-945），运行期改配置
    /// 后 `provider()` 取回的仍是旧适配层（F4 F1-01）。本方法从 store 重新
    /// `load_provider_endpoint()` → 重建适配层（复用共享连接池客户端）→ Mutex
    /// 短临界区原子交换 provider + provider_config + ready/ready_reason；
    /// 全程无 await（模式对齐 `inject_provider_for_test` :975-985）。
    /// 重建失败（三件套缺失，如 apiKey 清空）→ provider=None + ready=false +
    /// ready_reason 文案，与构造时降级语义一致。
    pub(crate) fn reload_provider(&self) {
        let (provider, ready, ready_reason, provider_config) = match load_provider_endpoint() {
            Some(config) => {
                let provider: Arc<dyn ProviderCall> =
                    Arc::new(HttpProviderCall::new(self.http_client.clone(), config.clone()));
                (Some(provider), true, None, Some(config))
            }
            None => {
                tracing::warn!(
                    target: "engine",
                    "engine not ready: provider 配置缺失（baseUrl/model/apiKey 三件套，apply 后重载）"
                );
                (
                    None,
                    false,
                    Some("provider 配置缺失（baseUrl/model/apiKey）".to_string()),
                    None,
                )
            }
        };
        *self.provider.lock().unwrap_or_else(|e| e.into_inner()) = provider;
        *self.provider_config.lock().unwrap_or_else(|e| e.into_inner()) = provider_config;
        self.ready.store(ready, Ordering::SeqCst);
        *self.ready_reason.lock().unwrap_or_else(|e| e.into_inner()) = ready_reason;
    }

    /// 工具注册表（只读共享）
    pub(crate) fn tool_registry(&self) -> Arc<ToolRegistry> {
        Arc::clone(&self.tool_registry)
    }

    /// MCP 客户端桥（E5；上层 run 启停驱动用——session.start 启动 /
    /// session.end `stop_all` 关闭）
    #[allow(dead_code)] // E5 接线：core_run_commands 装配 run 启停时消费
    pub(crate) fn mcp_bridge(&self) -> Arc<McpClientBridge> {
        Arc::clone(&self.mcp_bridge)
    }

    /// 定时器注册表（T-CF-06 装配产物；TimerChannel 契约经
    /// BuiltinToolConfig.timer_channel 注入工具注册；消费方 =
    /// CoreRunState::new 装配 timer_has_active 判定器，已接线）
    pub(crate) fn timer_registry(&self) -> Arc<TimerRegistry> {
        Arc::clone(&self.timer_registry)
    }

    /// 路由型审计 sink（15-T-6 装配产物；消费方 = CoreRunState run
    /// 启动注册 / 收口注销，已接线）
    pub(crate) fn audit_sink(&self) -> Arc<RoutingAuditSink> {
        Arc::clone(&self.audit_sink)
    }

    /// 定时器 steering 队列（到期条目落点；R-CF3 idle 续 run 消费——
    /// CoreRunState::new 经本访问器取共享队列，已接线）
    pub(crate) fn timer_steering_queue(&self) -> Arc<Mutex<PendingMessageQueue>> {
        Arc::clone(&self.timer_steering_queue)
    }

    /// 子代理等待通道（T-CF-10 装配产物；SubagentWaitChannel 契约面，
    /// 与注入 wait_subagents 工具的是同一实例）
    #[cfg_attr(not(test), allow(dead_code))] // 测试断言面消费；生产经工具注册表消费
    pub(crate) fn wait_channel(&self) -> Arc<dyn SubagentWaitChannel> {
        Arc::clone(&self.wait_channel)
    }

    /// dispatch 声明存储（T-CF-10/13 共享实例；wait 落库 / watchdog 读取
    /// / 测试断言读面）
    #[cfg_attr(not(test), allow(dead_code))] // 测试断言面消费
    pub(crate) fn dispatch_store(&self) -> Arc<MemoryWaitStore> {
        Arc::clone(&self.dispatch_store)
    }

    /// 终态事件流广播（T-CF-10：事件收口旁路点 feed 接线用——任何
    /// subagent-ended 事件到达即灌入广播，wait 订阅者同步消费；消费方 =
    /// CoreRunState finalize_subagent_spawner，已接线）
    pub(crate) fn terminal_stream(&self) -> Arc<EventStreamBroadcast> {
        Arc::clone(&self.terminal_stream)
    }

    /// 最近事件唤醒跟踪（T-CF-13：事件收口处 mark_wakeup 接线消费方 =
    /// core_run_commands drive_run_loop 事件 emit 循环与子代理终态收口，
    /// 已接线）
    pub(crate) fn last_wakeup(&self) -> Arc<LastWakeupTracker> {
        Arc::clone(&self.last_wakeup)
    }

    /// Cron 调度注册表（T-CF-09 装配产物；None = 未装配降级；
    /// 消费方：CoreRunState::new（P7 cron_has_enabled 判定器装配）+
    /// main.rs 装配轮（P6 WorkflowBackend::set_registry），已接线）
    pub(crate) fn scheduler_registry(&self) -> Option<Arc<crate::sched::SchedulerRegistry>> {
        self.scheduler_registry.clone()
    }

    /// 定时器事件缓冲（T-CF-06 装配产物；P4 drain 转发路径的入口——
    /// [forward_drained_timer_events] 与本测试面消费，main.rs
    /// drain 任务经本访问器周期取走缓冲转发到 EventBridge，已接线）
    pub(crate) fn timer_event_sink(&self) -> Arc<crate::timers::AgentEventSink> {
        Arc::clone(&self.timer_event_sink)
    }

    /// cron 事件缓冲（T-CF-09 装配产物；drain 转发路径同 timer——
    /// cron-fired 单臂，conex-types 仅 CronFired 变体，cancel 走
    /// 数据面 + steering 面，无 cron-cancelled 发射目标；main.rs
    /// drain 任务经本访问器消费，已接线）
    pub(crate) fn scheduler_event_sink(&self) -> Arc<crate::sched::SchedEventSink> {
        Arc::clone(&self.scheduler_event_sink)
    }

    /// 注册插件 MCP server（E5 内容 1）：PluginMcpDeclaration（stdio
    /// command/args/env）→ 受管服务器（spawn + 握手 + 枚举）→ 工具并入
    /// ToolRegistry 运行集（`mcp_<server>__<tool>` 命名，供
    /// `list_definitions` 消费——与 E4 on_definition 共享构建点）。
    ///
    /// 启动失败 → mcp.* 错误上抛（调用方承接为插件级错误进
    /// runtime-error，不阻塞 run）；服务器生命周期随 run 启停由上层
    /// 驱动（本方法只注册并入，启停经 [Self::mcp_bridge]）。
    #[allow(dead_code)] // E5 接线：core_run_commands 装配插件 mcpServers 时消费
    pub(crate) async fn register_plugin_mcp_server(
        &self,
        config: McpServerConfig,
    ) -> Result<Vec<ToolDefinition>, ToolError> {
        register_plugin_server(&self.mcp_bridge, &self.tool_registry, &config).await
    }

    // ── E5 内容 3：C10 注入读取面（skills.rs RustSkill → 注入段）──────

    /// C10 Skills 注入段：RustSkill 扫描结果 → `## Skill 定义` 注入段。
    ///
    /// 每次上下文构建重新读取（不与会话历史共享压缩预算——注入段经
    /// [ContextInjector::render] 汇入 system_prompt 面，压缩只作用于
    /// 会话对话）；渲染确定：同一技能集合两次构建字节一致（C10 字节级
    /// 一致断言）。技能条目格式：
    /// `- <name>（系统）（<scope>）：<description>\n<content>`
    #[allow(dead_code)] // E5 接线：core_run_commands 装配 ContextInjector 时消费
    pub(crate) fn skill_context_injection(skills: &[RustSkill]) -> ContextInjection {
        let content = skills
            .iter()
            .map(|skill| {
                format!(
                    "- {}{}（{}）：{}\n{}",
                    skill.name(),
                    if skill.is_system() { "（系统）" } else { "" },
                    skill.scope(),
                    skill.description(),
                    skill.content()
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        ContextInjection::new(ContextInjectionKind::Skills, "Skill 定义", content)
    }

    /// C10 MCP 工具声明注入段：已并入注册表的 MCP 工具定义 →
    /// `## MCP 工具声明` 注入段（与 E4 on_definition 共享
    /// `list_definitions` 构建点；渲染确定，可字节级断言）。
    #[allow(dead_code)] // E5 接线：core_run_commands 装配 ContextInjector 时消费
    pub(crate) fn mcp_context_injection(defs: &[ToolDefinition]) -> ContextInjection {
        let content = defs
            .iter()
            .map(|def| format!("- {}：{}", def.name, def.description))
            .collect::<Vec<_>>()
            .join("\n");
        ContextInjection::new(ContextInjectionKind::Mcp, "MCP 工具声明", content)
    }

    // ── P5 S5 / T-40：缓存测量装配（轮末合并接线点）──────────────

    /// 生效 provider 配置（缓存测量装配数据源；None = 未就绪）。
    /// 注：core_run_commands 装配 SessionLoopProducer 时经
    /// [Self::cache_tracking_config] 消费本值——T-40 轮末合并接线。
    #[allow(dead_code)] // T-40 轮末合并接线：core_run_commands 装配 producer 时消费（A8 §1.2 登记面），接线后移除
    pub(crate) fn provider_config(&self) -> Option<EngineProviderConfig> {
        self.provider_config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 解析缓存跟踪配置（P5 S5 / T-40）：provider / model 取生效配置、
    /// TTL 走 P3 `cache_ttl_for_provider_model` 路由表（T-21）——未知厂商 /
    /// 无 TTL 数据 → ttl_seconds = 0（P5 §3.4.4「TTL 查询失败不提示」，
    /// 不阻塞其他功能）。
    #[allow(dead_code)] // T-40 轮末合并：core_run_task 装配 producer 时消费
    pub(crate) fn cache_tracking_config(&self) -> Option<CacheTrackingConfig> {
        let config = self.provider_config()?;
        Some(build_cache_tracking_config(&config))
    }

    /// 会话缓存测量状态（上一 run 快照；core_run_task 装配 producer 时
    /// 经 [SessionLoopProducer::with_cache_session] 注入，T-40）
    #[allow(dead_code)] // T-40 轮末合并接线
    pub(crate) fn cache_session(&self, session_id: &str) -> SessionCacheState {
        self.cache_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .cloned()
            .unwrap_or_default()
    }

    /// 收口写回会话缓存状态（drive_run_loop 在 produce 后调用，
    /// T-40 轮末合并接线；供下一 run 冷缓存预警 / 模型切换检测）
    #[allow(dead_code)] // T-40 轮末合并接线：drive_run_loop 收口写回会话缓存状态（A8 §1.2 登记面），接线后移除
    pub(crate) fn update_cache_session(
        &self,
        session_id: &str,
        stats: &RunCacheStats,
        model: &str,
    ) {
        let mut sessions = self
            .cache_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let state = sessions.entry(session_id.to_string()).or_default();
        state.last_stats = Some(*stats);
        state.last_model = Some(model.to_string());
    }
}

impl Default for EngineHandle {
    fn default() -> Self {
        Self::new(None)
    }
}

/// T-CF-09：Cron 调度注册表装配（A5 提供 pub(crate) 构造器与 restore；
/// 已按 A5 落盘签名对齐：pending / events / store / launcher 四适配——
/// pending 落真实 PendingMessageQueue（与定时器同队列）、events 用 sched
/// 的事件槽（缓冲 + 日志，EventBridge 真适配后续轮）、store 用 sched 的
/// 内存版（`sched_<id>` 键形状已冻结，conex-db 真适配与 TimerStore 同一
/// 接线缺口）。
///
/// is_daemon 独立 run 拉起点（[crate::sched::DaemonRunLauncher]）暂不
/// 接线：RunProducer 的 prompt 注入适配在 A8 域（T-CF-11 core_run_commands），
/// 未接线时 daemon 触发降级为 steering 注入（sched.rs 防丢唤醒语义）。
///
/// 装配失败降级（None 保持 unsupported 语义，不阻塞引擎启动）。
/// event sink 由引擎持有（P4：缓冲实例经 [EngineHandle::scheduler_event_sink]
/// 暴露，drain 转发路径与 TimerRegistry 侧同模式）。
fn assemble_scheduler_registry(
    timer_steering_queue: &Arc<Mutex<PendingMessageQueue>>,
    scheduler_event_sink: Arc<crate::sched::SchedEventSink>,
) -> Option<Arc<crate::sched::SchedulerRegistry>> {
    let registry = Arc::new(crate::sched::SchedulerRegistry::new(
        Arc::new(crate::sched::QueuePendingSink::new(Arc::clone(timer_steering_queue))),
        scheduler_event_sink,
        crate::sched::MemorySchedStore::shared(),
        None,
    ));
    // 启动恢复：扫描已持久化声明重建 cron sleep（与 TimerRegistry::restore
    // 同模式；try_current 守卫：纯同步构造上下文跳过，不 panic）
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        let registry = Arc::clone(&registry);
        runtime.spawn(async move {
            registry.restore().await;
        });
    } else {
        tracing::debug!(
            target: "engine",
            "SchedulerRegistry 启动恢复跳过：当前上下文无 tokio runtime"
        );
    }
    Some(registry)
}

// ── P4：缓冲事件 drain 转发（30 方案 §4 改动点 2）───────────────────
// 定时器 / cron 事件缓冲（AgentEventSink / SchedEventSink）到真实
// EventBridge 的转发路径：drain 取走缓冲 → 信封直发（runId/sequence
// 不注入，对齐 EventBridgeSink 先例 background.rs:2145——timer/cron
// 事件无 run 归属，前端按 timerId/cronId 消费）。批 3 装配轮以 500ms
// tick 周期调用（main.rs drain 任务）——事件从缓冲到真实桥延迟
// ≤ 500ms；drain 为 Vec::take 语义，空缓冲返回 0，重复调用不重复转发。

/// 缓冲定时器事件 → 信封直发；返回实际发射条数
/// （[EventBridge::emit_envelope] 序列化失败条目不计数；生产消费方 =
/// main.rs drain 任务 500ms tick，已接线）
pub(crate) fn forward_drained_timer_events(sink: &AgentEventSink, bridge: &EventBridge) -> usize {
    forward_drained_events(sink.drain(), bridge)
}

/// 缓冲 cron 事件 → 信封直发（cron-fired 单臂：conex-types 契约仅
/// CronFired 变体，无 cron-cancelled 发射目标；cancel 走数据面 + steering
/// 面）；返回实际发射条数，周期与延迟语义同 [forward_drained_timer_events]。
pub(crate) fn forward_drained_scheduler_events(
    sink: &crate::sched::SchedEventSink,
    bridge: &EventBridge,
) -> usize {
    forward_drained_events(sink.drain(), bridge)
}

/// drain 转发公共实现（缓冲事件 → 信封直发；runId/sequence 不注入）
fn forward_drained_events(events: Vec<AgentEvent>, bridge: &EventBridge) -> usize {
    let mut forwarded = 0usize;
    for event in events {
        let envelope = AgentEventEnvelope::new(event, None, None);
        forwarded += bridge.emit_envelope(&envelope).emitted;
    }
    if forwarded > 0 {
        tracing::debug!(
            target: "engine",
            forwarded,
            "timer/cron 缓冲事件已转发到事件桥"
        );
    }
    forwarded
}

// ── BufferedRunEventBridge：缓冲 + 序列化 + 发射组装 ───────────────

/// 缓冲事件桥（每 run 一个实例；B6.3 组装层）
///
/// - [Self::emit]：信封 → 序列化 → 按 runId 入缓冲（P9：入队时序列化，
///   丢帧判定只需事件类别；丢帧报告汇入 tracing，S-8）；
/// - [Self::flush]：冲刷本 run 缓冲并发射（顺序保持，载荷直接 emit）。
impl std::fmt::Debug for BufferedRunEventBridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BufferedRunEventBridge").finish_non_exhaustive()
    }
}

pub(crate) struct BufferedRunEventBridge {
    /// 底层事件桥（Tauri 通道）
    bridge: EventBridge,
    /// 按 runId 的背压缓冲（丢帧类目：Delta 可丢、message-end 必达）
    buffer: Mutex<EventBuffer>,
    /// 本桥绑定的 run
    run_id: String,
}

impl BufferedRunEventBridge {
    /// 新建缓冲事件桥（run 级实例）
    pub(crate) fn new(bridge: EventBridge, run_id: impl Into<String>) -> Self {
        Self {
            bridge,
            buffer: Mutex::new(EventBuffer::default()),
            run_id: run_id.into(),
        }
    }

    /// 入队一条信封（序列化 + 缓冲；不立即发射）
    ///
    /// 丢帧（Soft 水位优先丢 Delta 旧帧，Critical 永不丢——buffer.rs:41-58
    /// 语义）经 EmitReport 汇入 tracing 计数（S-8 / PE-04 T04.2-3）。
    pub(crate) fn emit(&self, envelope: &AgentEventEnvelope) -> EmitReport {
        let Some(payload) = self.bridge.serialize(envelope) else {
            return EmitReport::default();
        };
        let class = drop_class_of(&envelope.event);
        let mut report = EmitReport::default();
        let outcome = match self.buffer.lock() {
            Ok(mut buffer) => buffer.enqueue(&self.run_id, class, payload),
            Err(poisoned) => poisoned
                .into_inner()
                .enqueue(&self.run_id, class, payload),
        };
        report.buffered = usize::from(outcome.buffered);
        report.dropped = outcome.dropped;
        if outcome.dropped > 0 {
            tracing::warn!(
                target: "event_bridge",
                run_id = %self.run_id,
                dropped = outcome.dropped,
                "事件缓冲丢帧（Delta 类目可丢，message-end 必达）"
            );
        }
        report
    }

    /// 冲刷本 run 的缓冲并发射（按入队序；返回发射报告）
    pub(crate) fn flush(&self) -> EmitReport {
        let payloads = self
            .buffer
            .lock()
            .map(|mut buffer| buffer.drain(&self.run_id))
            .unwrap_or_default();
        let mut report = EmitReport::default();
        for payload in payloads {
            report.add(self.bridge.emit_payload(&payload));
        }
        report
    }
}

// ── BridgeDeltaSink：T09.1 实时轨桥 ────────────────────────────────

/// 实时 delta 转发桥（T09.1 双轨的实时轨：sequence=None 实时发射）
///
/// - 只承载 message-delta（text/thought 增量）；信封由本桥构造，
///   **sequence=None**（不落库、无序列号，前端按 messageId 累加，
///   PE-09 §0.3 契约点 3）；
/// - 背压/丢帧复用缓冲桥的 Delta 类目（delta 可丢、message-end 必达，
///   03 §5.3-6）；
/// - 无状态（[Send] + [Sync]），run 结束无清理需求。
pub(crate) struct BridgeDeltaSink {
    /// 缓冲事件桥（emit + flush）
    bridge: Arc<BufferedRunEventBridge>,
    /// 本 run 标识（信封 runId 注入）
    run_id: String,
}

impl BridgeDeltaSink {
    /// 新建实时 delta 桥（共享 run 级缓冲事件桥）
    pub(crate) fn new(bridge: Arc<BufferedRunEventBridge>, run_id: impl Into<String>) -> Self {
        Self {
            bridge,
            run_id: run_id.into(),
        }
    }
}

impl DeltaSink for BridgeDeltaSink {
    fn push(&self, delta: AgentEvent) {
        // 信封：{event, runId: Some, sequence: None}（T09.1 实时轨）
        let envelope = AgentEventEnvelope::new(delta, Some(self.run_id.clone()), None);
        self.bridge.emit(&envelope);
        // 实时通道立即发射（丢帧由 buffer 的 Delta 类目兜底，不丢 message-end）
        self.bridge.flush();
    }
}

// ── P5 S5 / T-40：缓存测量引擎侧装配 ──────────────────────────────

/// 会话级缓存测量状态（engine 层跨 run 维护；T-40）
///
/// 跨 run 持久化边界（对齐 cache_tracker.rs 模块注释「基线经
/// [CacheStatsTracker::baseline] 交还调用方（engine 层跨 run 持久化归
/// T-40）」）：
/// - 本状态只保留**可观测标量**（warm_until_ms / input_total / model），
///   不保留请求签名哈希——签名基线在 loop 内每 run 重建（T-36 现状），
///   跨 run 签名续接（detect 的 min(prev,cur) 基线）属 session-loop 侧
///   待接线项，见轮末汇总物声明；本层不做假签名；
/// - 冷缓存预警 = 上一 run warm_until_ms 过期判定（与前端 tick 路径同
///   口径，P5 §3.4.4）；模型切换 = 上一 run model ≠ 当前 model
///   （P5 §3.4.5 归因数据源）。
#[derive(Debug, Clone, Default)]
pub(crate) struct SessionCacheState {
    /// 最近一次 run 的缓存统计（warm_until_ms 过期判定 + 重发量估算）
    pub last_stats: Option<RunCacheStats>,
    /// 最近一次 run 的模型标识（模型切换检测）
    pub last_model: Option<String>,
}

/// 装配缓存跟踪配置（T-40：provider / model 取生效配置、TTL 走 P3
/// `cache_ttl_for_provider_model` 路由表，T-21）；未知厂商 / 无 TTL 数据
/// → ttl_seconds = 0（P5 §3.4.4「TTL 查询失败不提示」，不阻塞其他功能）。
fn build_cache_tracking_config(config: &EngineProviderConfig) -> CacheTrackingConfig {
    let vendor = infer_vendor(&config.base_url, &config.model);
    let ttl_seconds = cache_ttl_for_provider_model(Some(bundled_catalog()), vendor, &config.model)
        .map(CacheTtl::seconds)
        .unwrap_or(0);
    CacheTrackingConfig {
        provider: vendor.as_str().to_string(),
        model: config.model.clone(),
        ttl_seconds,
    }
}

/// 当前 UTC 毫秒时间戳（epoch ms；冷缓存预警判定用）
fn unix_millis_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// 冷缓存预警事件（P5 §3.4.4 请求启动路径，辅助路径）：上一 run 温暖截止
/// 已过期 → Some（等价 tracker.cold_cache_check 的可观测面）。
///
/// 实现说明：跨 run 签名基线续接在 session-loop 侧尚未接线（T-36 只做
/// run 内跨 turn 基线），本层以 `RunCacheStats.warm_until_ms`（= 完成时刻 +
/// TTL × 1000，tracker.finish 口径）过期判定——与前端 warmUntilMs tick
/// 路径同口径，TTL 未知（0）或无温暖截止 → None（P5 §3.4.4 不提示）。
fn cold_cache_warning_event(
    session_id: &str,
    config: &CacheTrackingConfig,
    last: &RunCacheStats,
    now_ms: u64,
) -> Option<AgentEvent> {
    if config.ttl_seconds == 0 {
        return None;
    }
    let warm_until_ms = last.warm_until_ms?;
    if now_ms <= warm_until_ms {
        // 尚未过期（恰好等于截止仍温暖，与 tracker.is_cold 同语义）
        return None;
    }
    // 完成时刻 = 温暖截止 - TTL（warm = completed_at + ttl × 1000 反解）
    let completed_at_ms = warm_until_ms.saturating_sub(config.ttl_seconds.saturating_mul(1000));
    let idle_ms = now_ms.saturating_sub(completed_at_ms);
    // 预估重发量 = 上次请求 input_total（C9 恒等式：miss + read + write）
    let resend_estimate_tokens = last
        .cache_miss_tokens
        .saturating_add(last.cache_read_tokens)
        .saturating_add(last.cache_write_tokens);
    Some(AgentEvent::ColdCacheWarning {
        session_id: session_id.to_string(),
        timestamp: now_iso_utc(),
        ttl_seconds: config.ttl_seconds,
        idle_ms,
        resend_estimate_tokens,
    })
}

/// 缓存浪费预警事件（P5 §3.4.2 阈值：`missed_tokens ≥ 20_000` 才打扰；
/// cost 阈值需 P3 价格数据 → None，不估算）。
///
/// 实现说明：run 级聚合无法还原逐 miss 归因与空闲时长 → attribution
/// Unknown / idle_ms 0 / missed_cost_usd None（诚实兜底，宁缺勿误报——
/// 浪费量本身是实测值非估算）；逐 miss 归因的 in-loop 发射（streaming.rs
/// `consume_cache_usage` 处，T-36 注释「发射归 T-40」但该文件不在本任务
/// 文件域）见轮末汇总物声明，合并后本函数降级为兜底路径。
fn waste_alert_event(
    session_id: &str,
    stats: &RunCacheStats,
    model_changed: bool,
) -> Option<AgentEvent> {
    if stats.missed_tokens < WARN_MISSED_TOKENS {
        return None;
    }
    Some(AgentEvent::CacheWasteAlert {
        session_id: session_id.to_string(),
        timestamp: now_iso_utc(),
        attribution: MissAttribution::Unknown,
        missed_tokens: stats.missed_tokens,
        idle_ms: 0,
        model_changed,
        missed_cost_usd: None,
    })
}

/// 模型切换检测（P5 §3.4.5）：上一 run model ≠ 当前 model → true；
/// 无上一 run 基线（首次 run）→ false（首轮归因 Cold，不算切换）。
fn model_switched(last: Option<&str>, current: Option<&str>) -> bool {
    match (last, current) {
        (Some(last), Some(current)) => last != current,
        _ => false,
    }
}

// ── M1：Tool Context 注入通道（C10 地基；build_context 立通道）──────

/// 注入段类型（注入顺序契约：M11 重注入断言以此为准；顺序变化视为协议变更）
///
/// 冻结顺序（调度者 I4-M1 指令，文档化于
/// `docs/multi-agent-repair/improvement/02-多Agent调度实现方案.md` M1）：
///
/// `system → skills → mcp → agent 定义`：
/// - [ContextInjectionKind::System]：系统提示词基础段（run-task 下发的
///   systemPrompt），先于一切注入段；
/// - [ContextInjectionKind::Skills]：skill 定义；
/// - [ContextInjectionKind::Mcp]：MCP 工具声明；
/// - [ContextInjectionKind::AgentDefinition]：agent 定义。
///
/// 注：04 文档 C10 第 4 条原稿顺序为「agent 定义 → skill → MCP」，
/// 本次按 I4-M1 调度指令落盘为「skills → mcp → agent 定义」（偏差见
/// M1 轮报告；enum 声明序 = 排序序 = 协议序，三者一致由快照断言锁定）。
///
/// 非测试构建静音：M1 只立通道，生产消费面仅 [ContextInjector::render]
/// （produce 装配）；变体/构造面由 M4（started_at）/M5（检查点摘要）/
/// M11（系统上下文重注入）与测试消费，轮末接线后移除 allow。
#[allow(dead_code)] // M1/M4/M5/M11 挂载消费（本域测试先行断言，A8 §1.2 登记面），接线后移除
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum ContextInjectionKind {
    /// 系统提示词基础段（systemPrompt；先于一切）
    System,
    /// skill 定义段
    Skills,
    /// MCP 工具声明段
    Mcp,
    /// agent 定义段
    AgentDefinition,
}

/// 注入顺序常量（冻结契约；[ContextInjector::render] 按此顺序拼接，
/// 与 [ContextInjectionKind] 声明序/排序序一致——排序即协议，
/// M11 重注入断言以此为契约）。
#[allow(dead_code)] // M11 重注入断言消费（本域测试先行断言，见轮末接线）
pub(crate) const CONTEXT_INJECTION_ORDER: [ContextInjectionKind; 4] = [
    ContextInjectionKind::System,
    ContextInjectionKind::Skills,
    ContextInjectionKind::Mcp,
    ContextInjectionKind::AgentDefinition,
];

/// 一段注入内容（M1：只承载「类型 + 标题 + 正文」，不持有任何业务逻辑；
/// M4（started_at）/ M5（检查点摘要）/ M11（配额凭证 + 系统上下文重注入）
/// 只读经 [ContextInjector::push] 挂载）。
///
/// 动态字段（时间戳类）必须显式标记 `@dynamic`（M1 约定 2：C2 的
/// started_at、恢复注入的检查点摘要）——带 `@dynamic` 的内容不在
/// C10 字节级一致断言范围内。
#[derive(Debug, Clone)]
pub(crate) struct ContextInjection {
    /// 注入段类型（决定拼接顺序）
    pub kind: ContextInjectionKind,
    /// 节标题（渲染为 `## {title}`）
    pub title: String,
    /// 正文
    pub content: String,
}

impl ContextInjection {
    /// 新建注入段
    #[allow(dead_code)] // M4/M5/M11 挂载消费（本域测试先行断言，见轮末接线）
    pub(crate) fn new(
        kind: ContextInjectionKind,
        title: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            title: title.into(),
            content: content.into(),
        }
    }
}

/// ContextInjector 装配点（M1：build_context 立通道；C10/C2/C1/C5 全部
/// 提示词层能力的统一入口）
///
/// - **注入顺序冻结**：注入段按 [CONTEXT_INJECTION_ORDER] 顺序拼接——
///   构造方乱序 [Self::push] 也会在 [Self::render] 时按契约顺序重排
///   （同类型保持 push 序，sort 稳定）；
/// - **独立于压缩预算**：注入段经 [Self::render] 汇入 `system_prompt`
///   面（wire 上归类 system 角色），压缩只作用于会话对话
///   （conex-compaction system 保留语义：system 消息恒保留、system_prompt
///   字段不在压缩输入内）——注入段结构上不进压缩预算；
/// - **默认行为不变**：无注入段时 [Self::render] 原样返回基础段
///   （None → None），与现状逐字节一致；
/// - 不持有业务逻辑：挂载点 = 只读注入项注册表（M1 内容 3）。
#[derive(Debug, Clone)]
pub(crate) struct ContextInjector {
    injections: Vec<ContextInjection>,
    /// C10 禁用开关（M11）：false = 渲染时忽略全部注入段
    enabled: bool,
}

impl Default for ContextInjector {
    /// 默认：无注入段 + 注入启用（C10 默认开）
    fn default() -> Self {
        Self {
            injections: Vec::new(),
            enabled: true,
        }
    }
}

impl ContextInjector {
    /// 新建空注入器（无注入段 = 默认行为）
    #[allow(dead_code)] // M4/M5/M11 挂载消费（本域测试先行断言，见轮末接线）
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// 是否启用注入（默认开；C10 禁用开关）
    #[allow(dead_code)] // M11 消费（本域测试先行断言，A8 §1.2 登记面），接线后移除
    pub(crate) fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// 追加注入段（render 时按冻结顺序重排；同类型保持追加序）
    #[allow(dead_code)] // M4/M5/M11 挂载消费（本域测试先行断言，见轮末接线）
    pub(crate) fn push(&mut self, injection: ContextInjection) -> &mut Self {
        self.injections.push(injection);
        self
    }

    /// 是否无任何注入段
    #[allow(dead_code)] // M11 消费（本域测试先行断言，见轮末接线）
    pub(crate) fn is_empty(&self) -> bool {
        self.injections.is_empty()
    }

    /// 注入段类型序列（按冻结顺序；顺序契约断言入口，M11 复用）
    #[allow(dead_code)] // M11 重注入断言消费（本域测试先行断言，见轮末接线）
    pub(crate) fn kinds(&self) -> Vec<ContextInjectionKind> {
        let mut kinds: Vec<ContextInjectionKind> =
            self.injections.iter().map(|injection| injection.kind).collect();
        kinds.sort();
        kinds
    }

    /// 拼接基础系统段与注入段（M1 内容 1：先系统段、再 skill 段、再
    /// MCP 段、再 agent 定义段）：
    ///
    /// - 无注入段 → 基础段原样返回（None → None，默认行为与现状一致）；
    /// - 有注入段 → 基础段（System 段）置首，其后按冻结顺序逐段拼接，
    ///   每段渲染为 `## {title}\n{content}`，段间 `\n\n` 分隔；
    /// - 输出确定（同一配置两次构建字节一致，可快照断言；
    ///   `@dynamic` 字段不在一致性范围）。
    pub(crate) fn render(&self, base: Option<String>) -> Option<String> {
        if self.injections.is_empty() || !self.enabled {
            return base;
        }
        let mut ordered = self.injections.clone();
        ordered.sort_by_key(|injection| injection.kind);
        let mut parts: Vec<String> = Vec::new();
        if let Some(base) = base.filter(|text| !text.is_empty()) {
            parts.push(base);
        }
        for injection in ordered {
            if !parts.is_empty() {
                parts.push("\n\n".to_string());
            }
            parts.push(format!("## {}\n{}", injection.title, injection.content));
        }
        Some(parts.concat())
    }

    /// C10 字节级一致断言（M11）：两次渲染（如压缩前后重建）非动态段
    /// 必须逐字节一致；`@dynamic` 标记段（时间戳类）豁免。
    /// 返回：非动态段的字节级指纹（FNV-1a 64），可用于跨构建比对。
    #[allow(dead_code)] // M11 重注入断言消费（轮末接线后移除）
    pub(crate) fn static_fingerprint(&self) -> u64 {
        let mut ordered = self.injections.clone();
        ordered.sort_by_key(|injection| injection.kind);
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for injection in ordered {
            if injection.content.contains("@dynamic") {
                continue;
            }
            for byte in injection.title.bytes().chain(injection.content.bytes()) {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x1000_0000_01b3);
            }
        }
        hash
    }

    /// C10 禁用开关（M11）：关 = 渲染时忽略全部注入段（仅基础段透传）。
    #[allow(dead_code)] // M12 联测接线消费（重注入开关接线后移除）
    pub(crate) fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// C10 注入上限（M11）：注入段总体积上限（字节），超限按优先级截断
    /// （核心段保留、扩展段截断），绝不整体丢弃。
    /// 返回截断后的注入段数（日志/审计用）。
    #[allow(dead_code)] // M12 联测接线消费（注入上限配置接线后移除）
    pub(crate) fn truncate_to_budget(&mut self, budget_bytes: usize) -> usize {
        if self.enabled {
            self.injections.retain(|injection| {
                // 动态段（@dynamic）不参与体积预算（时间戳类极小，保留）
                !injection.content.contains("@dynamic")
            });
        }
        let mut retained = Vec::new();
        let mut used = 0usize;
        let mut dropped = 0usize;
        let mut ordered = std::mem::take(&mut self.injections);
        ordered.sort_by_key(|injection| injection.kind);
        for injection in ordered {
            let size = injection.title.len() + injection.content.len() + 8;
            if used + size > budget_bytes {
                dropped += 1;
                continue;
            }
            used += size;
            retained.push(injection);
        }
        self.injections = retained;
        dropped
    }
}

// ── T-D-03：子代理角色约束注入段（F4 R-D1；spawn 装配路径 F11 T-D-13 接入）──

/// 子代理角色约束注入段标题（T-D-03 冻结文案：测试断言锚点；
/// [ContextInjector::render] 渲染为 `## 子代理角色约束`）
#[allow(dead_code)] // F11 T-D-13 接线：spawn 装配路径消费（本文件测试先行断言）
pub(crate) const SUBAGENT_ROLE_CONSTRAINT_TITLE: &str = "子代理角色约束";

/// 子代理角色约束注入段正文（T-D-03 冻结文案：测试断言全文匹配）。
///
/// 静态文本，不含 `@dynamic` 字段，纳入 C10 字节级一致断言范围；冻结
/// 文案如需调整，必须同步更新测试断言与 T-D-02 的结构化错误文案
/// （两者表述一致，防模型混淆）。
#[allow(dead_code)] // F11 T-D-13 接线：spawn 装配路径消费（本文件测试先行断言）
pub(crate) const SUBAGENT_ROLE_CONSTRAINT_CONTENT: &str = "你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配。\
     如需并行子任务、拆解或汇报，请通过消息/上报通道向主 Agent 提出，由主 Agent 统一派发。";

/// T-D-03：向 [ContextInjector] 追加「子代理角色约束」注入段（System 段）。
///
/// 仅**子代理 run** 的装配路径调用本函数（主 Agent run 的装配点不调用）
/// ——这是「主 Agent run 不含本段」测试断言的关键差异点。
///
/// 与 C2 started_at 注入同通道同机制（`subagent_inject.rs:13-16` 挂载
/// 先例）：[ContextInjection] 是只读注册项，静态文本经
/// [ContextInjector::push] 挂载；System 按 [CONTEXT_INJECTION_ORDER]
/// 在首段位（位于基础系统段之后、Skills 段之前），与其他 System 注入段
/// 保持 push 序（[ContextInjector::render] 稳定排序语义）。
///
/// 当前生产 spawn 装配路径未落定（T-D-13 在 F11/R-D3）——本函数即
/// T-D-13 的接入约定：T-D-13 启动子代理 run、装配 ContextInjector 时
/// 调用 `push_subagent_role_constraint(&mut injector)` 挂载本段。
#[allow(dead_code)] // F11 T-D-13 接线：spawn 装配路径消费（本文件测试先行断言）
pub(crate) fn push_subagent_role_constraint(injector: &mut ContextInjector) {
    injector.push(ContextInjection::new(
        ContextInjectionKind::System,
        SUBAGENT_ROLE_CONSTRAINT_TITLE,
        SUBAGENT_ROLE_CONSTRAINT_CONTENT,
    ));
}

// ── SessionLoopProducer ───────────────────────────────────────────

/// Arc 包装的 ProviderCall（[AgentSessionLoop] 按 `Box<dyn ProviderCall>`
/// 接收；生产者跨 run 共享 provider，需经本包装再装箱）
struct SharedProvider {
    /// 真实 provider 适配层（共享复用，跨 run 不重建）
    inner: Arc<dyn ProviderCall>,
    /// 会话 ID（P2 步骤 4b：ProviderRequest.session_id 的注入源；值与循环内
    /// AgentSessionContext.session_id 一致——两者同源于 run-task 下发的
    /// sessionId）
    session_id: String,
}

#[async_trait]
impl ProviderCall for SharedProvider {
    async fn stream<'a>(
        &self,
        request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        // P2 步骤 4b：把会话 ID 注入 ProviderRequest.session_id（prompt_cache_key
        // 的键来源；会话内所有请求共享同键，同轮工具循环 + 跨轮，P2 §3.3 B）。
        // 请求为不可变借用，克隆后改写：messages/system_prompt 仍是借用复制
        // （0 深拷贝），仅 session_id 属主字符串每轮克隆一次（量级与
        // build_request 的工具 schema to_vec 相当，可忽略）。适配层
        // request_options 据此派生缓存键（Key 机制厂商）。
        let mut request = request.clone();
        request.session_id = Some(self.session_id.clone());
        self.inner.stream(&request).await
    }
}

/// run 生产者（engine.rs:436-462；每 run 重建 [AgentSessionLoop]——真实接线
/// 跨 run 重建语义，PE-09 §4）
pub(crate) struct SessionLoopProducer {
    /// 会话标识
    session_id: String,
    /// run 标识
    run_id: String,
    /// max-turns 预算
    max_turns: u32,
    /// provider 适配层（Arc 共享，跨 run 复用）
    provider: Arc<dyn ProviderCall>,
    /// 工具注册表
    tool_registry: Arc<ToolRegistry>,
    /// 循环配置（恢复阶梯 / 幂等 / assistant clientMessageId 等）
    options: SessionLoopOptions,
    /// 工具批量执行选项（超时 / 失败策略 / 审批开关）
    tool_options: ToolBatchOptions,
    /// 审批门（permissionMode 非 full-access 时注入）
    approval: Option<Arc<dyn ApprovalGate>>,
    /// 实时 delta 转发（T09.1；None = 不启用，收口流 message-delta 兜底）
    delta_sink: Option<Arc<dyn DeltaSink>>,
    /// 预置初始对话（P4 T-30 水合：SessionHistoryCache 缓存 / 前端 history
    /// 水合产物；None = 现状单消息 run，向后兼容）
    initial_conversation: Option<Vec<Arc<AgentMessage>>>,
    /// 本次 run 的用户消息
    user_message: AgentMessage,
    /// 缓存跟踪配置（P5 S5 / T-40：None = 不启用测量，行为与现状一致；
    /// Some = produce 装配进 SessionLoopOptions，LoopState 构造 tracker）
    cache_tracking: Option<CacheTrackingConfig>,
    /// 上一 run 的会话缓存状态（T-40：冷缓存预警 + 模型切换检测数据源；
    /// 由 EngineHandle 按会话维护，core_run_task 装配时经
    /// [Self::with_cache_session] 注入）
    cache_session: SessionCacheState,
    /// 上下文注入通道（M1：C10 地基；None = 无注入，options.system_prompt
    /// 原样透传——默认行为与现状一致。注入段经 [ContextInjector::render]
    /// 汇入 system_prompt 面，独立于压缩预算）
    context_injector: Option<ContextInjector>,
    /// 外部控制总线（30-P1 run 控制面：None = loop 自建实例，现状行为；
    /// Some = produce 装配时经 with_control_bus 注入——壳层 ActiveRun
    /// 与内核共享同一总线，运行中 run 有真实外部终止路径）
    control_bus: Option<Arc<Mutex<ControlBus>>>,
    /// 外部 abort 信号（30-P1：None = loop 自建信号；Some = produce 装配
    /// 时经 with_abort_signal 注入——壳层 ActiveRun 与内核共享同一触发面，
    /// L3 强停 / kill_all 经同一信号生效）
    abort_signal: Option<AbortSignal>,
}

impl SessionLoopProducer {
    /// 新建 run 生产者（permissionMode 与 clientMessageId 已由 core_run_task
    /// 归一为循环选项与用户消息）
    #[allow(clippy::too_many_arguments)] // 参数为 run 装配上下文聚合注入（provider/工具注册表/循环选项/批量选项/审批门/delta 流/水合对话/用户消息），各参数来源独立，收缩将退化为全局态或拆分 struct 而收益低
    pub(crate) fn new(
        session_id: String,
        run_id: String,
        max_turns: u32,
        provider: Arc<dyn ProviderCall>,
        tool_registry: Arc<ToolRegistry>,
        options: SessionLoopOptions,
        tool_options: ToolBatchOptions,
        approval: Option<Arc<dyn ApprovalGate>>,
        delta_sink: Option<Arc<dyn DeltaSink>>,
        initial_conversation: Option<Vec<Arc<AgentMessage>>>,
        user_message: AgentMessage,
    ) -> Self {
        Self {
            session_id,
            run_id,
            max_turns,
            provider,
            tool_registry,
            options,
            tool_options,
            approval,
            delta_sink,
            initial_conversation,
            user_message,
            // P5 S5 / T-40：缓存测量缺省关闭（未配置 = 现状行为）
            cache_tracking: None,
            cache_session: SessionCacheState::default(),
            // M1：注入通道缺省关闭（未装配 = 现状行为，system_prompt 原样透传）
            context_injector: None,
            // 30-P1：run 控制面缺省关闭（未装配 = loop 自建总线/信号，现状行为）
            control_bus: None,
            abort_signal: None,
        }
    }

    /// 启用缓存测量（P5 S5 / T-40）：装配 [CacheTrackingConfig]
    /// （provider / model / TTL；None = 保持现状不测量）。
    #[allow(dead_code)] // T-40 轮末合并：core_run_task 装配 producer 时调用
    pub(crate) fn with_cache_tracking(mut self, config: Option<CacheTrackingConfig>) -> Self {
        self.cache_tracking = config;
        self
    }

    /// 注入上一 run 的会话缓存状态（T-40：冷缓存预警 + 模型切换检测
    /// 数据源；EngineHandle::cache_session 产出）
    #[allow(dead_code)] // T-40 轮末合并：core_run_task 装配 producer 时调用
    pub(crate) fn with_cache_session(mut self, session: SessionCacheState) -> Self {
        self.cache_session = session;
        self
    }

    /// M1：装配上下文注入通道（[ContextInjector]；None = 无注入，保持
    /// 现状行为）。produce 时把注入段渲染进 system_prompt 面——注入段
    /// 归类 system 角色，独立于压缩预算（压缩只作用于会话对话）。
    #[allow(dead_code)] // M4/M5/M11 经此挂载（本文件测试先行断言）
    pub(crate) fn with_context_injector(mut self, injector: Option<ContextInjector>) -> Self {
        self.context_injector = injector;
        self
    }

    /// 30-P1：装配外部控制总线（run 控制面接线）——produce 在
    /// `with_options` 之后、`run()` 之前注入 loop（builder 顺序契约：
    /// 必须 run() 前，check_control 读字段引用）；壳层 ActiveRun 与
    /// loop 共享同一实例，core_run_control 的 L1/L2/L3 意图真实可达。
    pub(crate) fn with_control_bus(mut self, bus: Arc<Mutex<ControlBus>>) -> Self {
        self.control_bus = Some(bus);
        self
    }

    /// 30-P1：装配外部 abort 信号（L3 强停触发面）——produce 在
    /// `with_options` 之后、`run()` 之前注入 loop；壳层 ActiveRun 与
    /// loop 共享同一实例（AbortSignal 克隆共享 [AtomicBool]）。
    pub(crate) fn with_abort_signal(mut self, signal: AbortSignal) -> Self {
        self.abort_signal = Some(signal);
        self
    }

    /// 生产一次 run 结果（构造 [AgentSessionLoop] 并运行；每 run 重建）
    ///
    /// T-30 水合分支（P4 §3.2.3 混合路线）：`initial_conversation` 非空时
    /// 以 [AgentSessionLoop::with_initial_conversation_arc] 零拷贝预置对话
    /// （引擎缓存 = 权威增量 / 前端 history = 冷启动兜底，P4 阶段 1-3），
    /// `run()` 追加新用户消息——历史回流 LLM 是跨轮前缀缓存命中的基础；
    /// 为空时走现状单消息路径（向后兼容）。
    ///
    /// T-40 缓存测量接线（P5 S5，只测不改）：
    /// - run 启动前：冷缓存预警（上一 run warm_until_ms 过期 → 实时轨发
    ///   cold-cache-warning 一次）+ 模型切换检测（记录，in-loop 归因接线
    ///   见轮末汇总物声明）+ 装配 CacheTrackingConfig（LoopState 构造
    ///   tracker，T-36 capture_signature / record_usage / finish 已在
    ///   loop 内接线）；
    /// - run 收口：`cache-stats-updated` 入收口轨（outcome.events →
    ///   drive_outcome → 既有缓冲桥，与 ContextCompressionStart/End 同轨）；
    ///   `cache-waste-alert` 按阈值经实时轨 DeltaSink 发出。
    pub(crate) async fn produce(&mut self) -> RunOutcome {
        // ── T-40：run 启动前缓存测量装配 ────────────────────────
        // 冷缓存预警（P5 §3.4.4 请求启动路径）：实时轨 DeltaSink 发一次
        // （此时前端 tick 未必在看该会话；空闲期提示由前端 warmUntilMs
        // tick 驱动，T-48）
        self.emit_cold_cache_warning_if_cold();
        // 模型切换检测（P5 §3.4.5）：上一 run model ≠ 当前 model → 记录
        // （tracker.on_model_switch 的 in-loop 接线见轮末汇总物声明——
        // engine 无法触达 LoopState.cache_tracker，会话级跨 run 信号经
        // CacheTrackingConfig 透传由合并轮实现）
        let model_switched = self.detect_model_switch();
        if model_switched {
            tracing::info!(
                target: "engine",
                session_id = %self.session_id,
                previous_model = ?self.cache_session.last_model,
                current_model = ?self.current_model(),
                "缓存测量：检测到模型切换（miss 仍计数，归因 model-switch）"
            );
        }
        // 装配 CacheTrackingConfig（T-36 消费：LoopState 构造 /
        // run 起始 build_tracker 重建 tracker——fresh run 语义）
        self.options.cache_tracking = self.cache_tracking.clone();

        // ── M1：上下文注入通道（C10 地基；build_context 立通道）────
        // 注入段渲染进 system_prompt 面（wire 归类 system 角色）——独立于
        // 压缩预算：压缩只作用于会话对话（conex-compaction system 保留
        // 语义），注入段结构上不进压缩输入。无注入段（None / 空注入器）
        // 时 render 原样返回 → 与现状字节一致。
        if let Some(injector) = &self.context_injector {
            self.options.system_prompt = injector.render(self.options.system_prompt.take());
        }

        let mut session_loop = AgentSessionLoop::new(
            self.session_id.as_str(),
            self.run_id.as_str(),
            self.max_turns,
            Box::new(SharedProvider {
                inner: Arc::clone(&self.provider),
                session_id: self.session_id.clone(),
            }),
            Arc::clone(&self.tool_registry),
        );
        session_loop = session_loop
            .with_options(self.options.clone())
            .with_tool_options(self.tool_options.clone());
        // 30-P1：run 控制面装配（with_options 之后、run() 之前——builder
        // 顺序契约）——壳层与 loop 同源：同一控制总线 + 同一 abort 信号
        // 实例（A4-H2 断头路消除：check_control 安全点真实消费外部意图）
        if let Some(bus) = &self.control_bus {
            session_loop = session_loop.with_control_bus(Arc::clone(bus));
        }
        if let Some(signal) = &self.abort_signal {
            session_loop = session_loop.with_abort_signal(signal.clone());
        }
        if let Some(approval) = &self.approval {
            session_loop = session_loop.with_approval(Arc::clone(approval));
        }
        if let Some(delta_sink) = &self.delta_sink {
            session_loop = session_loop.with_delta_sink(Arc::clone(delta_sink));
        }
        // 水合分支：预置对话经 with_initial_conversation_arc 一次性填充
        // （Arc 克隆便宜，0 深拷贝；P1 append-only 不变量：之后 loop 只追加）
        if let Some(initial_conversation) = &self.initial_conversation {
            if !initial_conversation.is_empty() {
                session_loop =
                    session_loop.with_initial_conversation_arc(initial_conversation.clone());
            }
        }
        let mut outcome = session_loop.run(self.user_message.clone()).await;

        // ── T-40：run 收口（P5 S5 §3.2 数据流）─────────────────
        // cache-stats-updated 入收口轨（复用既有事件桥——outcome.events
        // 由 drive_run_loop 统一入队 + 信封注入 runId/sequence 发射，
        // 与 ContextCompressionStart/End 同一发射方式；P5 §3.1.3
        // 「run 收口经收口轨发一次」）
        if let Some(stats) = &outcome.cache_stats {
            outcome.events.push(AgentEvent::CacheStatsUpdated {
                session_id: self.session_id.clone(),
                timestamp: now_iso_utc(),
                stats: *stats,
            });
        }
        // cache-waste-alert（实时轨，P5 §3.4.2 阈值）：run 级累计浪费
        // 超阈值才打扰（低于阈值只计入 run 聚合）；归因在 run 级聚合不可
        // 还原 → Unknown（诚实兜底，逐 miss 归因发射见轮末汇总物声明）
        if let Some(stats) = &outcome.cache_stats {
            if let Some(alert) = waste_alert_event(&self.session_id, stats, model_switched) {
                if let Some(sink) = &self.delta_sink {
                    sink.push(alert);
                }
            }
        }
        outcome
    }

    /// 当前模型标识（缓存测量装配 / 模型切换检测用；未启用测量 → None）
    fn current_model(&self) -> Option<&str> {
        self.cache_tracking.as_ref().map(|config| config.model.as_str())
    }

    /// 模型切换检测（上一 run model ≠ 当前 model）
    fn detect_model_switch(&self) -> bool {
        model_switched(self.cache_session.last_model.as_deref(), self.current_model())
    }

    /// 冷缓存预警（run 启动前；实时轨 DeltaSink 发一次）
    fn emit_cold_cache_warning_if_cold(&self) {
        let Some(sink) = &self.delta_sink else { return };
        let Some(config) = &self.cache_tracking else { return };
        let Some(last) = &self.cache_session.last_stats else { return };
        if let Some(event) = cold_cache_warning_event(&self.session_id, config, last, unix_millis_now()) {
            sink.push(event);
        }
    }
}

// ── 测试 ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use agent_provider::request::cache::{CacheKey, CacheMechanism};
    use conex_compaction::Summarizer;
    use conex_types::ContextBudget;
    use session_loop::provider::ProviderStreamItem;
    use session_loop::TestProvider;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// ISO8601 时间戳形状（毫秒精度 + Z 后缀）
    #[test]
    fn now_iso_utc_formats_iso8601() {
        let value = now_iso_utc();
        assert!(value.ends_with('Z'), "应带 Z 后缀：{value}");
        assert!(value.len() >= 24, "应含毫秒精度：{value}");
        let (date, rest) = value.split_once('T').expect("T 分隔");
        let parts: Vec<&str> = date.split('-').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].len(), 4);
        assert!(rest.ends_with(".000Z") || rest.contains('.'), "毫秒精度：{value}");
    }

    /// 消息 id 前缀 + 唯一
    #[test]
    fn message_ids_are_unique_per_prefix() {
        let a = new_message_id("user");
        let b = new_message_id("user");
        assert!(a.starts_with("user-"));
        assert_ne!(a, b);
    }

    /// 用户消息构造：clientMessageId 透传（21-log §5.2 缺口 2 修复）
    #[test]
    fn user_message_carries_client_message_id() {
        let message = user_message("你好", Some("user-msg-1"));
        assert_eq!(message.client_message_id.as_deref(), Some("user-msg-1"));
        assert_eq!(message.role, AgentMessageRole::User);
        let text = message.blocks.iter().find_map(|block| match block {
            AgentMessageBlock::Text { text } => Some(text.as_str()),
            _ => None,
        });
        assert_eq!(text, Some("你好"));
        // None 不标注（向后兼容）
        assert!(user_message("hi", None).client_message_id.is_none());
    }

    /// 端点路径：chat-completions（00 D3）/ responses
    #[test]
    fn provider_url_respects_endpoint() {
        let base = EngineProviderConfig {
            base_url: "https://api.example.com/v1/".to_string(),
            api_key: "k".to_string(),
            model: "m".to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: BTreeMap::new(),
        };
        assert_eq!(provider_url(&base), "https://api.example.com/v1/chat/completions");
        let responses = EngineProviderConfig {
            endpoint: Endpoint::Responses,
            ..base
        };
        assert_eq!(provider_url(&responses), "https://api.example.com/v1/responses");
    }

    /// 低级事件 → session-loop 事件转换（形状逐字段一致）
    #[test]
    fn wire_event_converts_to_loop_event() {
        let wire = WireEvent::Stop {
            reason: agent_provider::events::StopReason::Length,
            error: None,
            usage: Some(agent_provider::events::ProviderUsage {
                prompt_tokens: Some(1),
                completion_tokens: Some(2),
                total_tokens: Some(3),
                cache_read_tokens: None,
                cache_write_tokens: None,
                cache_miss_tokens: Some(7),
                reasoning_tokens: None,
            }),
        };
        match to_loop_event(wire) {
            ProviderStreamEvent::Stop {
                reason,
                usage,
                error,
            } => {
                assert_eq!(reason, LoopStopReason::Length);
                assert!(error.is_none());
                let usage = usage.expect("usage 透传");
                assert_eq!(usage.total_tokens, Some(3));
                // P2：cacheMissTokens 逐字段透传（E0063 补齐）
                assert_eq!(usage.cache_miss_tokens, Some(7));
            }
            other => panic!("期望 Stop，得到 {other:?}"),
        }
    }

    /// 分类错误：ProviderError → ClassifiedStreamError（kind/retryable 透传）
    #[test]
    fn classified_error_preserves_kind_and_retryable() {
        let error = agent_provider::error::ProviderError::Server {
            status: Some(503),
        };
        let classified = to_classified(error);
        assert_eq!(classified.kind, ProviderErrorKind::ServerError);
        assert!(classified.retryable);
        assert!(classified.retry_after_ms.is_none());
    }

    /// 解析错误分类：Unknown / 不可重试（T09.1.2 步骤 2）
    #[test]
    fn parse_error_classifies_unknown_not_retryable() {
        let error = StreamParseError::EventAfterStop;
        let classified = classify_stream_parse(&error);
        assert_eq!(classified.kind, ProviderErrorKind::Unknown);
        assert!(!classified.retryable);
    }

    // ── P1：system prompt 透传 + 请求体稳定性（T-06，P1 阶段 2 步骤 2.3 /
    //     阶段 4 步骤 4.3）──────────────────────────────────────────────

    /// 构造测试用适配层（chat-completions 端点）
    fn test_provider_call(model: &str) -> HttpProviderCall {
        let client = reqwest::Client::new();
        let config = EngineProviderConfig {
            base_url: "https://api.example.com/v1/".to_string(),
            api_key: "k".to_string(),
            model: model.to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: BTreeMap::new(),
        };
        HttpProviderCall::new(client, config)
    }

    /// 构造单条 user 消息的会话（验证 system 前置与请求体字节稳定）
    fn single_user_request<'a>(
        messages: &'a Vec<Arc<AgentMessage>>,
        system_prompt: Option<&'a str>,
    ) -> ProviderRequest<'a> {
        ProviderRequest {
            messages,
            tools: Vec::new(),
            max_tokens: Some(4096),
            system_prompt,
            session_id: None,
        }
    }

    /// build_context 透传 system_prompt；相同设置下两次构建请求体字节一致
    ///
    /// 断言（P1 §5.1 验收 4/10 + §5.3 路径 3）：
    /// - system_prompt 到达请求构建上下文（不再硬编码 None）；
    /// - system 消息始终是 messages[0]（静态前缀前置纪律）；
    /// - 同进程两次构建请求体 to_string 字节相等（前缀稳定性）。
    #[test]
    fn build_context_passes_system_prompt_and_is_stable() {
        let call = test_provider_call("deepseek-chat");

        let user = AgentMessage {
            id: "user-1".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-03T00:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "你好".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        };
        let messages = vec![Arc::new(user)];
        let request = single_user_request(&messages, Some("你是助手，使用中文回答。"));

        // 透传正确：system_prompt 到达构建上下文（P-04 修复点）
        let context_a = call.build_context(&request);
        let context_b = call.build_context(&request);
        assert_eq!(
            context_a.system_prompt.as_deref(),
            Some("你是助手，使用中文回答。")
        );

        // 稳定性：相同设置下两次构建请求体字节一致（同进程对比）
        let options = call.request_options(&request);
        let body_a = build_chat_completions_request_body(&options, &context_a);
        let body_b = build_chat_completions_request_body(&options, &context_b);
        assert_eq!(body_a.to_string(), body_b.to_string());

        // system 消息始终是 messages[0]（静态前缀前置，P1 §5.3 路径 3）
        let wire_messages = body_a
            .get("messages")
            .and_then(serde_json::Value::as_array)
            .expect("请求体应含 messages 数组");
        let first = wire_messages.first().expect("至少一条消息");
        assert_eq!(first["role"], "system");
        assert_eq!(first["content"], "你是助手，使用中文回答。");
    }

    /// reasoning_content 模式按 vendor 判定（P1 C3 唯一实现）：
    /// DeepSeek → Require（键存在性，空串兜底）；其余厂商 → Omit
    #[test]
    fn reasoning_content_mode_follows_vendor() {
        let deepseek = test_provider_call("deepseek-chat");
        assert_eq!(
            deepseek.reasoning_content_mode(),
            ReasoningContentMode::Require
        );

        let openai = test_provider_call("gpt-4o");
        assert_eq!(openai.reasoning_content_mode(), ReasoningContentMode::Omit);

        // base_url 含 deepseek 关键字同样判定（infer_reasoning_vendor 双通道）
        let mut config = EngineProviderConfig {
            base_url: "https://deepseek.example.com/v1/".to_string(),
            api_key: "k".to_string(),
            model: "random-model".to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: BTreeMap::new(),
        };
        let call = HttpProviderCall::new(reqwest::Client::new(), config.clone());
        assert_eq!(call.reasoning_content_mode(), ReasoningContentMode::Require);

        // 未知厂商 → Auto → Omit（现状保持）
        config.base_url = "https://unknown.example.com/v1/".to_string();
        config.model = "custom-model".to_string();
        let call = HttpProviderCall::new(reqwest::Client::new(), config);
        assert_eq!(call.reasoning_content_mode(), ReasoningContentMode::Omit);
    }

    // ── P2：build_cache_policy 接线 + session_id 注入（T-17，P2 步骤 4b）────

    /// 构造单条 user 消息 + 会话 ID 的请求（cache 接线断言用）
    fn session_request<'a>(
        messages: &'a Vec<Arc<AgentMessage>>,
        session_id: Option<&'a str>,
    ) -> ProviderRequest<'a> {
        ProviderRequest {
            messages,
            tools: Vec::new(),
            max_tokens: Some(4096),
            system_prompt: None,
            session_id: session_id.map(str::to_string),
        }
    }

    /// request_options 组装 cache：engine.rs 只调用 build_cache_policy（C2 唯一
    /// 运行时判定/消费入口），能力判定收敛在其内部（catalog = bundled_catalog()
    /// 真源路径，T-23 单例；无 catalog 时兜底内置保守表）
    ///
    /// 断言（P2 §5.1/§5.3）：
    /// - DeepSeek：build_cache_policy 归 None → 请求体不含任何 cache 键
    ///   （省略行为测试钉死，对齐 deepseek-reasonix-cache-analysis.md:111-112）；
    /// - Key 机制（gpt-4o）+ 会话 ID → 注入 prompt_cache_key（码点钳 64）；
    /// - Key 机制无会话 ID → 不注入（无键无路由对象）；
    /// - 未知/本地厂商 → 保守全关。
    #[test]
    fn request_options_wires_build_cache_policy() {
        let user = AgentMessage {
            id: "user-1".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-03T00:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "你好".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        };
        let messages = vec![Arc::new(user)];
        let request = session_request(&messages, Some("ses-abc"));

        // DeepSeek：省略整个 cache 参数组（机制 Auto + omit 恒 true）
        let deepseek = test_provider_call("deepseek-v4");
        assert!(deepseek.request_options(&request).cache.is_none());
        let body = build_chat_completions_request_body(
            &deepseek.request_options(&request),
            &deepseek.build_context(&request),
        );
        assert!(body.get("prompt_cache_key").is_none());
        assert!(body.get("prompt_cache_retention").is_none());
        assert!(body.get("prompt_cache_options").is_none());

        // Key 机制（gpt-4o）+ 会话 ID → 注入缓存策略与 wire 键
        let openai = test_provider_call("gpt-4o");
        let options = openai.request_options(&request);
        let policy = options.cache.clone().expect("Key 机制应注入缓存策略");
        assert_eq!(policy.mechanism, CacheMechanism::Key);
        assert_eq!(policy.cache_key, Some(CacheKey("ses-abc".to_string())));
        let body = build_chat_completions_request_body(&options, &openai.build_context(&request));
        assert_eq!(body["prompt_cache_key"], "ses-abc");

        // Key 机制无会话 ID → 无键可发，整体不注入（session_id? 短路）
        let no_session = session_request(&messages, None);
        assert!(openai.request_options(&no_session).cache.is_none());

        // 未知/本地厂商（base_url 无关键字 + model 前缀未命中）→ 保守全关
        let ollama = test_provider_call("llama-3.1");
        assert!(ollama.request_options(&request).cache.is_none());
    }

    /// G1 遗留 1：发送层基础请求头合并亲和头（affinity_http_headers 消费点）。
    /// Grok + 会话 ID → x-grok-conv-id 出现（值 = 会话 ID，与 cache_key 同源
    /// 前 64 码点）；其他厂商（OpenAI / DeepSeek / 未知）与无会话 → 不出现；
    /// Authorization 恒在（既有固定头不受影响）。
    #[test]
    fn request_headers_merges_affinity_header() {
        let user = AgentMessage {
            id: "user-1".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-03T00:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "你好".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        };
        let messages = vec![Arc::new(user)];
        let request = session_request(&messages, Some("ses-abc"));

        // Grok（catalog 真源路径）：x-grok-conv-id 随基础请求头出现
        let grok = test_provider_call("grok-4.5");
        let options = grok.request_options(&request);
        let headers = grok.request_headers(options.cache.as_ref());
        assert!(headers.iter().any(|(name, _)| name == &"Authorization"));
        assert!(
            headers
                .iter()
                .any(|(name, value)| name == &"x-grok-conv-id" && value == "ses-abc"),
            "Grok 应注入 x-grok-conv-id"
        );

        // 无会话 ID → 无亲和头（仅 Authorization）
        let no_session = session_request(&messages, None);
        let headers = grok.request_headers(grok.request_options(&no_session).cache.as_ref());
        assert!(headers.iter().any(|(name, _)| name == &"Authorization"));
        assert!(!headers.iter().any(|(name, _)| name == &"x-grok-conv-id"));

        // 其他厂商（OpenAI / DeepSeek / 未知）：亲和头不出现
        for model in ["gpt-4o", "deepseek-v4", "llama-3.1"] {
            let call = test_provider_call(model);
            let headers = call.request_headers(call.request_options(&request).cache.as_ref());
            assert!(
                !headers.iter().any(|(name, _)| name == &"x-grok-conv-id"),
                "{model} 不应注入 x-grok-conv-id"
            );
        }
    }

    /// 捕获请求的测试 provider（session_id 注入断言用）
    struct CaptureProvider {
        captured: Arc<Mutex<Option<String>>>,
    }

    #[async_trait]
    impl ProviderCall for CaptureProvider {
        async fn stream<'a>(
            &self,
            request: &ProviderRequest<'a>,
        ) -> Result<ProviderEventStream, ClassifiedStreamError> {
            *self
                .captured
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = request.session_id.clone();
            let stream: ProviderEventStream =
                Box::pin(futures_util::stream::empty::<ProviderStreamItem>());
            Ok(stream)
        }
    }

    /// SharedProvider::stream 把会话 ID 注入 ProviderRequest.session_id
    /// （P2 步骤 4b：prompt_cache_key 键来源；值 = AgentSessionContext.session_id
    /// 同源——两者同源于 run-task 下发的 sessionId）
    #[tokio::test]
    async fn shared_provider_injects_session_id() {
        let captured = Arc::new(Mutex::new(None));
        let shared = SharedProvider {
            inner: Arc::new(CaptureProvider {
                captured: Arc::clone(&captured),
            }),
            session_id: "ses-42".to_string(),
        };
        let messages = Vec::<Arc<AgentMessage>>::new();
        let request = session_request(&messages, None);
        let stream = shared.stream(&request).await.expect("空流应成功");
        drop(stream);
        assert_eq!(
            captured
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_deref(),
            Some("ses-42"),
            "会话 ID 应注入 ProviderRequest.session_id"
        );
    }

    // ── P3：provider_url 接入 supports_responses_for（T-23，P3 步骤 4b / §3.4.2）──

    /// 构造测试用配置（Responses 支持判定用；base_url 含 deepseek 关键字，
    /// 经 infer_reasoning_vendor 双通道判定厂商）
    fn responses_config(model: &str, endpoint: Endpoint) -> EngineProviderConfig {
        EngineProviderConfig {
            base_url: "https://api.deepseek.com/v1/".to_string(),
            api_key: "k".to_string(),
            model: model.to_string(),
            endpoint,
            stream: true,
            extra: BTreeMap::new(),
        }
    }

    /// provider_url 按目录 supports_responses 判定端点（P3 ⑤ 验收 3）：
    /// - deepseek-v4-flash → 允许 responses（/responses）；
    /// - 版本后缀 deepseek-v4-flash-0731（官方版本号）经 lookup 多级兜底同样允许；
    /// - deepseek-v4-pro → 不支持 → 拒绝 responses 并降级 chat-completions；
    /// - deepseek 前缀内未收录模型 → 保守视为不支持 → 同样降级；
    /// - 未知厂商（baseUrl/model 无关键字）→ 保留现状走 /responses（不臆断）；
    /// - chat-completions 端点不受判定影响（原路径保持）。
    #[test]
    fn provider_url_gates_responses_by_catalog_support() {
        // v4-flash：目录 supportsResponses=true → 保持 /responses
        let flash = responses_config("deepseek-v4-flash", Endpoint::Responses);
        assert_eq!(
            provider_url(&flash),
            "https://api.deepseek.com/v1/responses",
            "v4-flash 应允许 responses 端点"
        );

        // 版本后缀兜底：DeepSeek-V4-Flash-0731 命中内置 v4-flash 条目
        let flash_0731 = responses_config("deepseek-v4-flash-0731", Endpoint::Responses);
        assert_eq!(
            provider_url(&flash_0731),
            "https://api.deepseek.com/v1/responses",
            "版本后缀模型应经 lookup 兜底命中 v4-flash"
        );

        // v4-pro：官方尚未支持 Responses（2026 年 8 月初加入）→ 降级 chat-completions
        let pro = responses_config("deepseek-v4-pro", Endpoint::Responses);
        assert_eq!(
            provider_url(&pro),
            "https://api.deepseek.com/v1/chat/completions",
            "v4-pro 应拒绝 responses 并降级 chat-completions"
        );

        // deepseek 前缀内未收录模型 → 保守视为不支持 → 降级
        let unknown = responses_config("deepseek-custom", Endpoint::Responses);
        assert_eq!(
            provider_url(&unknown),
            "https://api.deepseek.com/v1/chat/completions",
            "未收录模型应保守降级"
        );

        // 未知厂商（无关键字网关）→ 目录无数据 → 保留现状走 /responses
        let gateway = EngineProviderConfig {
            base_url: "https://gw.example.com/v1/".to_string(),
            api_key: "k".to_string(),
            model: "m".to_string(),
            endpoint: Endpoint::Responses,
            stream: true,
            extra: BTreeMap::new(),
        };
        assert_eq!(
            provider_url(&gateway),
            "https://gw.example.com/v1/responses",
            "未知厂商不应臆断降级"
        );

        // chat-completions 端点恒不受判定影响
        let chat = responses_config("deepseek-v4-pro", Endpoint::ChatCompletions);
        assert_eq!(
            provider_url(&chat),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    /// responses_supported 辅助函数语义（目录查询面）：
    /// v4-flash → true；v4-pro → false；版本后缀兜底 → true；
    /// 未收录模型 → false（保守）；未知厂商（Auto）→ true（保留现状）。
    #[test]
    fn responses_supported_follows_catalog_entry() {
        assert!(responses_supported(&responses_config(
            "deepseek-v4-flash",
            Endpoint::Responses
        )));
        assert!(responses_supported(&responses_config(
            "deepseek-v4-flash-0731",
            Endpoint::Responses
        )));
        assert!(!responses_supported(&responses_config(
            "deepseek-v4-pro",
            Endpoint::Responses
        )));
        assert!(!responses_supported(&responses_config(
            "deepseek-custom",
            Endpoint::Responses
        )));

        // 未知厂商：base_url/model 均无关键字 → Auto → 保留现状（不降级）
        let gateway = EngineProviderConfig {
            base_url: "https://gw.example.com/v1/".to_string(),
            api_key: "k".to_string(),
            model: "m".to_string(),
            endpoint: Endpoint::Responses,
            stream: true,
            extra: BTreeMap::new(),
        };
        assert!(responses_supported(&gateway));
    }

    // ── T-30：produce 水合分支 + 预算透传（P4 阶段 1-3/1-4，§3.2.1/§3.2.3）──

    /// 构造测试用 producer（initial_conversation / options 可注入；
    /// provider 为脚本化替身，供请求快照断言）
    fn test_producer(
        initial_conversation: Option<Vec<Arc<AgentMessage>>>,
        options: SessionLoopOptions,
    ) -> (SessionLoopProducer, Arc<TestProvider>) {
        let provider = Arc::new(TestProvider::text_reply("收到"));
        let provider_call: Arc<dyn ProviderCall> = Arc::clone(&provider) as Arc<dyn ProviderCall>;
        let producer = SessionLoopProducer::new(
            "ses-t30".to_string(),
            "run-t30".to_string(),
            8,
            provider_call,
            Arc::new(ToolRegistry::new()),
            options,
            ToolBatchOptions::default(),
            None,
            None,
            initial_conversation,
            user_message("第二轮提问", Some("user-t30")),
        );
        (producer, provider)
    }

    /// T-30：produce 水合分支——预置对话经 with_initial_conversation_arc
    /// 零拷贝续接（Arc 身份不变），run 追加新用户消息与助手回复；
    /// 收口 outcome.messages 携带完整续接序列（SessionHistoryCache 的
    /// 原子替换数据源，P4 阶段 1-4）。
    /// 载荷注记（T-36 对齐）：预置首条为 user（水合协议形状——跳过
    /// system 后的首条必须为 user，assistant/tool 开头 provider 400
    /// 风险；assert_conversation_head_tail 调试断言强制）
    #[tokio::test]
    async fn produce_hydrates_initial_conversation() {
        let initial_text = AgentMessage {
            id: "user-1".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-03T00:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "首轮提问".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        };
        let initial: Vec<Arc<AgentMessage>> = vec![Arc::new(initial_text)];
        let (mut producer, provider) =
            test_producer(Some(initial.clone()), SessionLoopOptions::default());

        let outcome = producer.produce().await;

        // 请求链：预置对话 + 新用户消息（水合分支生效，历史回流 LLM）
        let sent = provider.request_message_arcs(0);
        assert_eq!(
            sent.len(),
            initial.len() + 1,
            "请求应含预置对话 + 新用户消息"
        );
        assert!(
            Arc::ptr_eq(&initial[0], &sent[0]),
            "预置消息零拷贝续接（Arc 身份不变）"
        );
        assert_eq!(sent[0].role, AgentMessageRole::User);
        let last = sent.last().expect("至少一条消息");
        assert_eq!(last.role, AgentMessageRole::User, "尾部应为新用户消息");
        let text = last
            .blocks
            .iter()
            .find_map(|block| match block {
                AgentMessageBlock::Text { text } => Some(text.as_str()),
                _ => None,
            });
        assert_eq!(text, Some("第二轮提问"));

        // 收口：outcome = 预置 + 用户 + 助手回复（缓存原子替换的数据源）
        assert_eq!(outcome.messages.len(), initial.len() + 2);
        assert!(
            Arc::ptr_eq(&initial[0], &outcome.messages[0]),
            "收口续接保留预置消息 Arc 身份"
        );
        assert_eq!(
            outcome.messages.last().map(|m| m.role),
            Some(AgentMessageRole::Assistant)
        );
    }

    /// T-30：initial_conversation 为空（None / 空 Vec）→ 现状单消息路径
    /// （向后兼容：请求只含本次用户消息，不产生空预置）
    #[tokio::test]
    async fn produce_without_initial_conversation_stays_single_message() {
        let (mut producer, provider) = test_producer(None, SessionLoopOptions::default());
        let outcome = producer.produce().await;
        let sent = provider.request_message_arcs(0);
        assert_eq!(sent.len(), 1, "无预置时请求只含本次用户消息");
        assert_eq!(sent[0].role, AgentMessageRole::User);
        assert_eq!(outcome.messages.len(), 2, "用户 + 助手回复");

        // Some(空 Vec) 同样走单消息路径（空预置不产生水合调用）
        let (mut producer_empty, provider_empty) =
            test_producer(Some(Vec::new()), SessionLoopOptions::default());
        producer_empty.produce().await;
        assert_eq!(provider_empty.request_message_arcs(0).len(), 1);
    }

    /// T-30：context_budget 透传（core_run_commands 构造点 → options →
    /// 预算层）——窗口收紧到 12288 时 max_tokens 被钳到默认 8192 之下
    /// （clamp = min(requested, window - estimate - safety)，估算 > 0）
    #[tokio::test]
    async fn produce_applies_context_budget_clamp() {
        let options = SessionLoopOptions {
            context_budget: Some(ContextBudget {
                context_window: 12_288,
                ..ContextBudget::default()
            }),
            ..SessionLoopOptions::default()
        };
        let (mut producer, provider) = test_producer(None, options);
        producer.produce().await;
        let max_tokens = provider
            .request_max_tokens(0)
            .expect("请求应携带 max_tokens");
        assert!(
            max_tokens < session_loop::r#loop::DEFAULT_MAX_TOKENS,
            "预算钳制应把 max_tokens 收到默认 8192 之下（实际 {max_tokens}）"
        );
        assert!(max_tokens >= 1, "钳制下限 MIN_MAX_TOKENS = 1");
    }

    // ── COMPACTION-01 P0-3：生产 Summarizer（ProviderSummarizer）──────

    fn summary_config(base_url: String, model: &str) -> EngineProviderConfig {
        EngineProviderConfig {
            base_url,
            api_key: "sk-summary".to_string(),
            model: model.to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: false,
            extra: BTreeMap::new(),
        }
    }

    fn dropped_summary_messages() -> Vec<conex_types::message::AgentMessage> {
        vec![
            AgentMessage {
                id: "u-drop".to_string(),
                role: AgentMessageRole::User,
                created_at: "2026-08-09T10:00:00.000Z".to_string(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "实现压缩模块".to_string(),
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            },
            AgentMessage {
                id: "a-drop".to_string(),
                role: AgentMessageRole::Assistant,
                created_at: "2026-08-09T10:00:01.000Z".to_string(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "已完成（read_file src/lib.rs）".to_string(),
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            },
        ]
    }

    /// C14 隔离面（请求体纯函数断言）：摘要请求 = 单条 user 消息、
    /// 无 system、无 tools、无任何缓存键 / 断点（prompt_cache_key /
    /// prompt_cache_retention / prompt_cache_options / cache_control）、
    /// 无会话亲和参数；模型 / 非流式 / max_tokens 预算正确透传。
    #[test]
    fn provider_summarizer_request_body_is_c14_isolated() {
        let summarizer = ProviderSummarizer::new(
            reqwest::Client::new(),
            summary_config("https://x.example/v1".to_string(), "model-a"),
            conex_compaction::MAX_SUMMARY_TOKENS_DEFAULT,
        );
        let body = summarizer.build_request_body("摘要提示词内容");
        let messages = body["messages"].as_array().expect("messages 必须为数组");
        assert_eq!(messages.len(), 1, "摘要请求必须是单条消息（独立前缀域）");
        assert_eq!(
            messages[0]["role"], "user",
            "唯一消息必须是 user（无 system 注入）"
        );
        assert!(
            messages[0]["content"]
                .as_str()
                .map(|s| s.contains("摘要提示词内容"))
                .unwrap_or(false),
            "提示词经单条 user 消息 content 发出"
        );
        assert!(body.get("tools").is_none(), "摘要请求不得携带 tools");
        assert!(body.get("tool_choice").is_none(), "摘要请求不得携带 tool_choice");
        assert!(body.get("system").is_none(), "摘要请求不得携带 system 消息");
        // C14：无缓存断点 / 无会话亲和键（cache: None → 整个 cache 参数组不出现）
        for key in [
            "prompt_cache_key",
            "prompt_cache_retention",
            "prompt_cache_options",
        ] {
            assert!(body.get(key).is_none(), "请求体不得含缓存键 {key}");
        }
        assert!(
            messages[0].get("cache_control").is_none(),
            "消息不得含 cache_control 断点"
        );
        // 模型 / 预算 / 非流式
        assert_eq!(body["model"], "model-a");
        assert_eq!(body["stream"], false);
        assert_eq!(body["max_tokens"], 1024);
    }

    /// 本地 mock 服务器（COMPACTION-01 P0-3 测试）：捕获请求体 JSON +
    /// 按脚本逐连接返回 canned HTTP 响应
    struct SummaryMockServer {
        addr: std::net::SocketAddr,
        captured: Arc<Mutex<Vec<serde_json::Value>>>,
    }

    impl SummaryMockServer {
        async fn start(respond: Vec<(u16, String)>) -> Arc<Self> {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind summary mock server");
            let addr = listener.local_addr().expect("local addr");
            let captured: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
            let server = Arc::new(Self {
                addr,
                captured: Arc::clone(&captured),
            });
            tokio::spawn(async move {
                for (status, body) in respond {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let captured = Arc::clone(&captured);
                    tokio::spawn(async move {
                        // 读请求（头 + Content-Length 体）
                        let mut buf = Vec::new();
                        let mut chunk = [0u8; 4096];
                        let head_end = loop {
                            if let Some(pos) =
                                buf.windows(4).position(|window| window == b"\r\n\r\n")
                            {
                                break pos + 4;
                            }
                            let n = socket.read(&mut chunk).await.unwrap_or(0);
                            if n == 0 {
                                return;
                            }
                            buf.extend_from_slice(&chunk[..n]);
                        };
                        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
                        let content_length = head
                            .lines()
                            .find_map(|line| line.split_once(':'))
                            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        let mut req_body = buf[head_end..].to_vec();
                        while req_body.len() < content_length {
                            let n = socket.read(&mut chunk).await.unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            req_body.extend_from_slice(&chunk[..n]);
                        }
                        if let Ok(json) =
                            serde_json::from_slice::<serde_json::Value>(&req_body)
                        {
                            captured
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .push(json);
                        }
                        let response = format!(
                            "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = socket.write_all(response.as_bytes()).await;
                    });
                }
            });
            server
        }

        fn base_url(&self) -> String {
            format!("http://{}/v1", self.addr)
        }

        fn captured(&self) -> Vec<serde_json::Value> {
            self.captured
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        }
    }

    /// 真实调用形状（wire 断言）：成功路径——单 user 消息 / 无 tools /
    /// 无缓存参数 / 无会话亲和头；响应 content 原样返回（Schema V1 JSON
    /// 字符串），供引擎校验渲染。
    ///
    /// 注：summarize 为同步阻塞调用（专用线程 + 独立 runtime），测试用
    /// multi_thread 运行时保证 listener 与调用并发。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn provider_summarizer_success_extracts_content_via_chat_completions() {
        let summary_json = serde_json::json!({
            "schemaVersion": 1,
            "blockId": "summary",
            "generation": 1,
            "droppedIds": ["u-drop", "a-drop"],
            "height": 1,
            "tier": "chunk",
            "goal": "实现压缩模块",
            "constraints": [],
            "progress": ["完成切割点保护"],
            "decisions": [],
            "nextSteps": ["补充测试"],
            "criticalContext": ["src/lib.rs"],
        })
        .to_string();
        let server = SummaryMockServer::start(vec![(
            200,
            serde_json::json!({
                "choices": [{"message": {"role": "assistant", "content": summary_json}}]
            })
            .to_string(),
        )])
        .await;
        let summarizer = ProviderSummarizer::new(
            reqwest::Client::new(),
            summary_config(server.base_url(), "model-a"),
            conex_compaction::MAX_SUMMARY_TOKENS_DEFAULT,
        );
        let result = summarizer.summarize(&dropped_summary_messages(), None);
        assert_eq!(result.as_deref(), Ok(summary_json.as_str()), "成功路径返回 content");
        // wire 断言（C14 隔离面）
        let captured = server.captured();
        assert_eq!(captured.len(), 1, "应恰好捕获 1 个摘要请求");
        let req = &captured[0];
        assert_eq!(req["model"], "model-a", "摘要请求用当前 provider 模型");
        assert_eq!(req["stream"], false, "摘要请求非流式");
        assert_eq!(req["max_tokens"], 1024, "摘要输出预算 = 1024");
        let messages = req["messages"].as_array().expect("messages 数组");
        assert_eq!(messages.len(), 1, "单条 user 消息（独立前缀域）");
        assert_eq!(messages[0]["role"], "user");
        let content = messages[0]["content"].as_str().expect("content 为字符串");
        assert!(content.contains("实现压缩模块"), "丢弃消息渲染进提示词");
        assert!(content.contains("src/lib.rs"), "工具调用细节进提示词");
        assert!(req.get("tools").is_none(), "无 tools");
        assert!(req.get("prompt_cache_key").is_none(), "无会话亲和缓存键");
        assert!(req.get("prompt_cache_retention").is_none(), "无缓存保留键");
        assert!(req.get("prompt_cache_options").is_none(), "无缓存选项键");
        assert!(messages[0].get("cache_control").is_none(), "无消息级断点");
    }

    /// 失败降级 L1：非 2xx → Err（调用方按契约回退中性 stub，不阻塞主对话）
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn provider_summarizer_http_error_degrades_to_err() {
        let server = SummaryMockServer::start(vec![(500, "{\"error\":\"boom\"}".to_string())])
            .await;
        let summarizer = ProviderSummarizer::new(
            reqwest::Client::new(),
            summary_config(server.base_url(), "model-a"),
            1024,
        );
        let result = summarizer.summarize(&dropped_summary_messages(), None);
        let err = result.expect_err("HTTP 500 必须返回 Err（降级 L1 占位符）");
        assert!(err.contains("500"), "错误文案应携带状态码：{err}");
    }

    /// 失败降级 L1：2xx 但响应缺 content（空 / 缺字段）→ Err
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn provider_summarizer_missing_content_degrades_to_err() {
        let server = SummaryMockServer::start(vec![(
            200,
            serde_json::json!({ "choices": [{"message": {"role": "assistant", "content": null}}] })
                .to_string(),
        )])
        .await;
        let summarizer = ProviderSummarizer::new(
            reqwest::Client::new(),
            summary_config(server.base_url(), "model-a"),
            1024,
        );
        let result = summarizer.summarize(&dropped_summary_messages(), None);
        assert!(
            result.is_err(),
            "响应缺 content 必须返回 Err（降级 L1 占位符）"
        );
    }

    /// 生产工厂：provider 未就绪 → None（不注入，纯 stub awaiting 语义）；
    /// 就绪 → 返回真实 ProviderSummarizer（模型 = 当前生效配置）
    #[test]
    fn production_factory_returns_real_summarizer_from_engine_config() {
        use crate::core_run_commands::{isolate_config_store, CONFIG_TEST_LOCK};
        let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "conex-config-test-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create config dir");
        isolate_config_store(&dir);

        let engine = Arc::new(EngineHandle::new(None));
        let factory = production_summarizer_factory(Arc::clone(&engine));
        assert!(
            factory("s1").is_none(),
            "provider 未就绪（无配置）→ 不注入，保持 stub 语义"
        );
        let provider: Arc<dyn ProviderCall> = Arc::new(HttpProviderCall::new(
            reqwest::Client::new(),
            summary_config("https://x.example/v1".to_string(), "model-prod"),
        ));
        engine.inject_provider_for_test(provider, summary_config(
            "https://x.example/v1".to_string(),
            "model-prod",
        ));
        let summarizer = factory("s1").expect("配置就绪后工厂必须返回真实实现");
        // 实例边界：同工厂两次解析为独立实例（per-session 隔离决议）
        let second = factory("s2").expect("再次解析成功");
        assert!(
            !Arc::ptr_eq(&summarizer, &second),
            "每会话独立实例（04 §7.1 隔离决议）"
        );
    }

    // ── P5 S5 / T-40：缓存测量装配与事件（engine 接线段）────────────

    /// 携带 usage 的停止事件（ProviderUsage camelCase 标量面；与
    /// session-loop T-36 测试同形状）
    fn stop_with_usage(
        prompt: u64,
        completion: u64,
        read: u64,
        write: u64,
        miss: Option<u64>,
    ) -> ProviderStreamEvent {
        ProviderStreamEvent::Stop {
            reason: LoopStopReason::Stop,
            error: None,
            usage: Some(ProviderUsage {
                prompt_tokens: Some(prompt),
                completion_tokens: Some(completion),
                total_tokens: Some(prompt.saturating_add(completion)),
                cache_read_tokens: Some(read),
                cache_write_tokens: Some(write),
                cache_miss_tokens: miss,
                reasoning_tokens: None,
            }),
        }
    }

    /// 捕获实时轨事件的测试 sink（ColdCacheWarning / CacheWasteAlert 断言）
    struct CaptureDeltaSink {
        events: Arc<Mutex<Vec<AgentEvent>>>,
    }

    impl DeltaSink for CaptureDeltaSink {
        fn push(&self, delta: AgentEvent) {
            self.events
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(delta);
        }
    }

    /// 测试用 run 级缓存统计（字段齐全，避免逐字段构造样板）
    fn sample_stats(warm_until_ms: Option<u64>, missed_tokens: u64) -> RunCacheStats {
        RunCacheStats {
            prompt_tokens: 10_000,
            completion_tokens: 100,
            total_tokens: 10_100,
            cache_read_tokens: 9_000,
            cache_write_tokens: 500,
            cache_miss_tokens: 500,
            sample_count: 1,
            hit_ratio: Some(0.9),
            write_ratio: Some(0.05),
            missed_tokens,
            warm_until_ms,
        }
    }

    /// T-40：装配缓存跟踪配置——provider / model 取生效配置、TTL 走
    /// P3 路由表（DeepSeek 300s）；未知厂商 → ttl 0（不提示不阻塞）
    #[test]
    fn cache_tracking_config_resolves_provider_model_ttl() {
        let deepseek = responses_config("deepseek-v4-flash", Endpoint::ChatCompletions);
        let config = build_cache_tracking_config(&deepseek);
        assert_eq!(config.provider, "deepseek");
        assert_eq!(config.model, "deepseek-v4-flash");
        assert_eq!(config.ttl_seconds, 300, "DeepSeek 自动前缀缓存 TTL 300s");

        // 未知厂商（无关键字网关）→ 保守全关（TTL 0 = 不提示不阻塞）
        let gateway = EngineProviderConfig {
            base_url: "https://gw.example.com/v1/".to_string(),
            api_key: "k".to_string(),
            model: "custom-model".to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: BTreeMap::new(),
        };
        let config = build_cache_tracking_config(&gateway);
        assert_eq!(config.provider, "auto");
        assert_eq!(config.ttl_seconds, 0);
    }

    /// T-40：冷缓存预警——温暖截止过期判定（完成时刻反解 idle、
    /// 重发量 = 上次 input_total，C9 恒等式）；TTL 未知 / 未过期 /
    /// 无截止 → 不预警
    #[test]
    fn cold_cache_warning_fires_after_warm_until() {
        let config = CacheTrackingConfig {
            provider: "deepseek".to_string(),
            model: "deepseek-v4-flash".to_string(),
            ttl_seconds: 60,
        };
        // 上一 run：完成 1000ms、warm = 1000 + 60_000 = 61_000
        let last = sample_stats(Some(61_000), 0);
        assert!(
            cold_cache_warning_event("s1", &config, &last, 60_000).is_none(),
            "未过期不预警"
        );
        assert!(
            cold_cache_warning_event("s1", &config, &last, 61_000).is_none(),
            "恰好等于截止仍温暖"
        );
        let event = cold_cache_warning_event("s1", &config, &last, 121_001)
            .expect("超 TTL 必须预警");
        match event {
            AgentEvent::ColdCacheWarning {
                session_id,
                ttl_seconds,
                idle_ms,
                resend_estimate_tokens,
                ..
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(ttl_seconds, 60);
                // idle = now - completed = 121_001 - 1_000
                assert_eq!(idle_ms, 120_001);
                // 重发量 = 上次 input_total = 500 + 9000 + 500
                assert_eq!(resend_estimate_tokens, 10_000);
            }
            other => panic!("期望 ColdCacheWarning，得到 {other:?}"),
        }
        // TTL 未知（0）→ 不预警（P5 §3.4.4：TTL 查询失败不提示）
        let no_ttl = CacheTrackingConfig {
            ttl_seconds: 0,
            ..config.clone()
        };
        assert!(cold_cache_warning_event("s1", &no_ttl, &last, 121_001).is_none());
        // 无温暖截止 → 不预警
        let mut no_warm = last;
        no_warm.warm_until_ms = None;
        assert!(cold_cache_warning_event("s1", &config, &no_warm, 121_001).is_none());
    }

    /// T-40：浪费预警阈值（≥ 20_000 才打扰，pi 口径）——低于阈值只计入
    /// run 聚合；触发时 attribution 诚实兜底 Unknown + wire 形状
    #[test]
    fn waste_alert_emitted_above_threshold_with_honest_attribution() {
        let below = sample_stats(Some(61_000), WARN_MISSED_TOKENS - 1);
        assert!(
            waste_alert_event("s1", &below, false).is_none(),
            "低于阈值不打扰"
        );
        let over = sample_stats(Some(61_000), WARN_MISSED_TOKENS);
        let event = waste_alert_event("s1", &over, true).expect("达到阈值必须预警");
        match event {
            AgentEvent::CacheWasteAlert {
                ref session_id,
                attribution,
                missed_tokens,
                model_changed,
                missed_cost_usd,
                ..
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(attribution, MissAttribution::Unknown);
                assert_eq!(missed_tokens, WARN_MISSED_TOKENS);
                assert!(model_changed);
                assert!(missed_cost_usd.is_none(), "无 P3 价格数据 → None");
            }
            other => panic!("期望 CacheWasteAlert，得到 {other:?}"),
        }
        // wire 形状：kebab-case attribution + camelCase 字段
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["type"], "cache-waste-alert");
        assert_eq!(value["attribution"], "unknown");
        assert_eq!(value["missedTokens"], WARN_MISSED_TOKENS);
        assert!(value.get("missed_tokens").is_none(), "不得出现 snake_case");
    }

    /// T-40：模型切换检测——上一 run model ≠ 当前 model；无上一 run
    /// 基线（首次 run）不算切换（首轮归因 Cold）
    #[test]
    fn model_switch_detection_compares_last_and_current() {
        assert!(model_switched(Some("gpt-4o"), Some("deepseek-v4-flash")));
        assert!(!model_switched(Some("deepseek-v4-flash"), Some("deepseek-v4-flash")));
        assert!(
            !model_switched(None, Some("deepseek-v4-flash")),
            "无上一 run 基线 → 不算切换"
        );
        assert!(!model_switched(Some("deepseek-v4-flash"), None));
        assert!(!model_switched(None, None));
    }

    /// T-40 集成：启用缓存测量后 produce 收口——RunOutcome.cache_stats
    /// 携带 run 级聚合 + cache-stats-updated 事件入收口轨
    #[tokio::test]
    async fn produce_emits_cache_stats_updated_when_tracking_enabled() {
        let provider = Arc::new(TestProvider::new(vec![
            ProviderStreamEvent::text("你好"),
            stop_with_usage(1_000, 50, 800, 100, None),
        ]));
        let provider_call: Arc<dyn ProviderCall> = Arc::clone(&provider) as Arc<dyn ProviderCall>;
        let mut producer = SessionLoopProducer::new(
            "ses-t40".to_string(),
            "run-t40".to_string(),
            8,
            provider_call,
            Arc::new(ToolRegistry::new()),
            SessionLoopOptions::default(),
            ToolBatchOptions::default(),
            None,
            None,
            None,
            user_message("第一轮", Some("user-t40")),
        )
        .with_cache_tracking(Some(CacheTrackingConfig {
            provider: "deepseek".to_string(),
            model: "deepseek-v4-flash".to_string(),
            ttl_seconds: 300,
        }));

        let outcome = producer.produce().await;

        let stats = outcome.cache_stats.expect("启用测量后收口必须携带缓存统计");
        assert_eq!(stats.sample_count, 1);
        assert_eq!(stats.cache_read_tokens, 800);
        // Included：miss = prompt - read - write
        assert_eq!(stats.cache_miss_tokens, 100);
        // cache-stats-updated 入收口轨（与 agent-end 同轨）
        let updated = outcome
            .events
            .iter()
            .rev()
            .find_map(|event| match event {
                AgentEvent::CacheStatsUpdated { session_id, stats, .. } => {
                    Some((session_id.as_str(), *stats))
                }
                _ => None,
            })
            .expect("收口事件应含 cache-stats-updated");
        assert_eq!(updated.0, "ses-t40");
        assert_eq!(updated.1.cache_read_tokens, 800);
    }

    /// T-40 向后兼容：未配置缓存测量 → cache_stats None、无
    /// cache-stats-updated 事件（行为与现状一致）
    #[tokio::test]
    async fn produce_without_cache_tracking_keeps_legacy_behavior() {
        let provider = Arc::new(TestProvider::new(vec![
            ProviderStreamEvent::text("hi"),
            stop_with_usage(100, 10, 0, 0, None),
        ]));
        let provider_call: Arc<dyn ProviderCall> = Arc::clone(&provider) as Arc<dyn ProviderCall>;
        let mut producer = SessionLoopProducer::new(
            "ses-legacy".to_string(),
            "run-legacy".to_string(),
            8,
            provider_call,
            Arc::new(ToolRegistry::new()),
            SessionLoopOptions::default(),
            ToolBatchOptions::default(),
            None,
            None,
            None,
            user_message("hi", None),
        );
        let outcome = producer.produce().await;
        assert!(outcome.cache_stats.is_none(), "未配置 → cache_stats 为 None");
        assert!(
            outcome
                .events
                .iter()
                .all(|e| !matches!(e, AgentEvent::CacheStatsUpdated { .. })),
            "未配置 → 不发射 cache-stats-updated"
        );
    }

    /// T-40 集成：上一 run warm_until_ms 已过期 → produce 启动前经
    /// 实时轨 DeltaSink 发射 cold-cache-warning 一次（重发量 = 上次
    /// input_total）
    #[tokio::test]
    async fn produce_emits_cold_cache_warning_when_previous_run_cold() {
        let now = unix_millis_now();
        // 上一 run：温暖截止 = now - 1（刚过期）；TTL 60s
        let last = sample_stats(Some(now.saturating_sub(1)), 0);
        let sink_events: Arc<Mutex<Vec<AgentEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: Arc<dyn DeltaSink> = Arc::new(CaptureDeltaSink {
            events: Arc::clone(&sink_events),
        });
        let provider = Arc::new(TestProvider::new(vec![
            ProviderStreamEvent::text("hi"),
            stop_with_usage(100, 10, 0, 0, None),
        ]));
        let provider_call: Arc<dyn ProviderCall> = Arc::clone(&provider) as Arc<dyn ProviderCall>;
        let mut producer = SessionLoopProducer::new(
            "ses-cold".to_string(),
            "run-cold".to_string(),
            8,
            provider_call,
            Arc::new(ToolRegistry::new()),
            SessionLoopOptions::default(),
            ToolBatchOptions::default(),
            None,
            Some(sink),
            None,
            user_message("hi", None),
        )
        .with_cache_tracking(Some(CacheTrackingConfig {
            provider: "deepseek".to_string(),
            model: "deepseek-v4-flash".to_string(),
            ttl_seconds: 60,
        }))
        .with_cache_session(SessionCacheState {
            last_stats: Some(last),
            last_model: Some("deepseek-v4-flash".to_string()),
        });

        producer.produce().await;

        let captured = sink_events.lock().unwrap_or_else(|e| e.into_inner());
        let warning = captured
            .iter()
            .find_map(|event| match event {
                AgentEvent::ColdCacheWarning {
                    ttl_seconds,
                    resend_estimate_tokens,
                    ..
                } => Some((*ttl_seconds, *resend_estimate_tokens)),
                _ => None,
            })
            .expect("实时轨应收到 cold-cache-warning");
        assert_eq!(warning.0, 60);
        // 重发量 = 上次 input_total = 9000 + 500 + 500（C9 恒等式）
        assert_eq!(warning.1, 10_000);
    }

    /// T-40：cache-stats-updated 事件 wire 形状（camelCase 全字段）
    #[test]
    fn cache_stats_updated_event_serializes_camel_case() {
        let event = AgentEvent::CacheStatsUpdated {
            session_id: "s1".to_string(),
            timestamp: now_iso_utc(),
            stats: sample_stats(Some(61_000), 0),
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["type"], "cache-stats-updated");
        assert_eq!(value["sessionId"], "s1");
        let stats = &value["stats"];
        assert_eq!(stats["promptTokens"], 10_000);
        assert_eq!(stats["completionTokens"], 100);
        assert_eq!(stats["totalTokens"], 10_100);
        assert_eq!(stats["cacheReadTokens"], 9_000);
        assert_eq!(stats["cacheWriteTokens"], 500);
        assert_eq!(stats["cacheMissTokens"], 500);
        assert_eq!(stats["sampleCount"], 1);
        assert_eq!(stats["hitRatio"], 0.9);
        assert_eq!(stats["writeRatio"], 0.05);
        assert_eq!(stats["missedTokens"], 0);
        assert_eq!(stats["warmUntilMs"], 61_000);
        assert!(
            value.get("cache_read_tokens").is_none(),
            "不得出现 snake_case 键"
        );
    }

    // ── M1：Tool Context 注入通道（C10 地基；build_context 立通道）────

    /// M1 注入顺序契约（冻结快照）：`system → skills → mcp → agent 定义`
    ///
    /// 断言（02 M1 内容 4 + 任务书内容 2）：顺序常量与枚举声明序/排序序
    /// 三方一致——排序即协议，M11 重注入断言以此为契约；顺序变化必须
    /// 同时改三处并被本快照捕获。
    #[test]
    fn injection_order_contract_is_frozen() {
        assert_eq!(
            CONTEXT_INJECTION_ORDER,
            [
                ContextInjectionKind::System,
                ContextInjectionKind::Skills,
                ContextInjectionKind::Mcp,
                ContextInjectionKind::AgentDefinition,
            ],
            "注入顺序契约：system → skills → mcp → agent 定义（变化视为协议变更）"
        );
        // 常量已按 enum Ord 升序（声明序 = 排序序 = 协议序）
        let mut sorted = CONTEXT_INJECTION_ORDER.to_vec();
        sorted.sort();
        assert_eq!(sorted, CONTEXT_INJECTION_ORDER);
    }

    /// M1 注入点存在且可注入（mock）：push 累积、空判定、kinds 按契约序
    #[test]
    fn injector_push_accumulates_and_kinds_follow_contract() {
        let mut injector = ContextInjector::new();
        assert!(injector.is_empty());
        assert_eq!(injector.kinds(), Vec::<ContextInjectionKind>::new());

        // 乱序 push：agent 定义 → skills → mcp
        injector
            .push(ContextInjection::new(
                ContextInjectionKind::AgentDefinition,
                "Agent 定义",
                "agent-body",
            ))
            .push(ContextInjection::new(
                ContextInjectionKind::Skills,
                "Skill 定义",
                "skill-body",
            ))
            .push(ContextInjection::new(
                ContextInjectionKind::Mcp,
                "MCP 工具声明",
                "mcp-body",
            ));
        assert!(!injector.is_empty());
        assert_eq!(
            injector.kinds(),
            vec![
                ContextInjectionKind::Skills,
                ContextInjectionKind::Mcp,
                ContextInjectionKind::AgentDefinition,
            ],
            "kinds() 必须按冻结顺序返回（skills → mcp → agent 定义）"
        );
    }

    /// M1 顺序契约 + 快照：乱序 push 后 render 仍按冻结顺序拼接
    /// （system 段 → skill 段 → MCP 段 → agent 定义段），且同一配置
    /// 两次构建字节一致（动态字段以 `@dynamic` 标记豁免，不在断言范围）
    #[test]
    fn injector_render_respects_frozen_order_and_is_byte_stable() {
        let mut injector = ContextInjector::new();
        injector
            .push(ContextInjection::new(
                ContextInjectionKind::AgentDefinition,
                "Agent 定义",
                "agent-body",
            ))
            .push(ContextInjection::new(
                ContextInjectionKind::Mcp,
                "MCP 工具声明",
                "mcp-body",
            ))
            .push(ContextInjection::new(
                ContextInjectionKind::Skills,
                "Skill 定义",
                "skill-body",
            ));

        let rendered = injector
            .render(Some("基础系统提示".to_string()))
            .expect("有注入段时必然产出");
        // 顺序：基础段 → Skills → MCP → Agent 定义（契约断言）
        let skill = rendered.find("## Skill 定义").expect("skill 段存在");
        let mcp = rendered.find("## MCP 工具声明").expect("MCP 段存在");
        let agent = rendered.find("## Agent 定义").expect("agent 段存在");
        assert!(rendered.starts_with("基础系统提示"), "system 段必须置首");
        assert!(skill < mcp, "skill 段先于 MCP 段（契约）");
        assert!(mcp < agent, "MCP 段先于 agent 定义段（契约）");
        // 每段渲染为 `## {title}\n{content}`，段间 \n\n 分隔
        assert!(rendered.contains("## Skill 定义\nskill-body"));
        assert!(rendered.contains("## MCP 工具声明\nmcp-body"));
        assert!(rendered.contains("## Agent 定义\nagent-body"));

        // 快照：两次构建 system 段字节一致（M1 内容 4）
        let second = injector
            .render(Some("基础系统提示".to_string()))
            .expect("有注入段时必然产出");
        assert_eq!(rendered, second, "同一配置两次构建 system 段字节必须一致");
    }

    /// M1 默认行为回归：无注入段时 render 原样返回基础段
    /// （None → None；Some → 原样透传，含空串——空值归一属装配点
    /// build_system_prompt 职责，注入通道不做二次规范化），与现状
    /// 逐字节一致
    #[test]
    fn injector_render_without_injections_preserves_base() {
        let injector = ContextInjector::new();
        assert_eq!(injector.render(None), None, "无注入且无基础段 → None（现状）");
        assert_eq!(
            injector.render(Some("基础系统提示".to_string())),
            Some("基础系统提示".to_string()),
            "无注入时基础段原样透传（现状）"
        );
        // 原样透传：空串基础段不归一（归一化在装配点 build_system_prompt）
        assert_eq!(injector.render(Some(String::new())), Some(String::new()));
    }

    /// M1 集成：produce 装配注入通道后，渲染结果经 system_prompt 面送达
    /// provider（注入点存在且可注入），且对话消息不含 system 角色——
    /// 注入段归类 system 角色、结构上不进压缩输入（独立于压缩预算）
    #[tokio::test]
    async fn produce_with_injector_sends_rendered_system_prompt_as_system_role() {
        let mut injector = ContextInjector::new();
        injector
            .push(ContextInjection::new(
                ContextInjectionKind::AgentDefinition,
                "Agent 定义",
                "agent-body",
            ))
            .push(ContextInjection::new(
                ContextInjectionKind::Skills,
                "Skill 定义",
                "skill-body",
            ))
            .push(ContextInjection::new(
                ContextInjectionKind::Mcp,
                "MCP 工具声明",
                "mcp-body",
            ));
        let (producer, provider) = test_producer(None, SessionLoopOptions::default());
        let mut producer = producer.with_context_injector(Some(injector));
        producer.produce().await;

        // 注入段经 system_prompt 面送达（非对话消息）
        let sent_system = provider
            .request_system_prompt(0)
            .expect("注入后请求必须携带 system prompt");
        let skill = sent_system.find("## Skill 定义").expect("skill 段存在");
        let mcp = sent_system.find("## MCP 工具声明").expect("MCP 段存在");
        let agent = sent_system.find("## Agent 定义").expect("agent 段存在");
        assert!(skill < mcp, "skill 段先于 MCP 段（契约）");
        assert!(mcp < agent, "MCP 段先于 agent 定义段（契约）");
        assert!(sent_system.contains("## Agent 定义\nagent-body"));

        // 对话消息不含 system 角色：注入段归类 system 角色（system_prompt
        // 面），压缩只作用于会话对话 → 注入段不进压缩预算
        let sent_messages = provider.request_message_arcs(0);
        assert!(
            sent_messages
                .iter()
                .all(|m| m.role != AgentMessageRole::System),
            "注入段不得混入会话消息（system 角色面 = system_prompt）"
        );
    }

    /// M1 默认行为回归（produce 级）：未装配注入通道时 system_prompt
    /// 原样透传（None → None；已有基础段 → 不变），与现状一致
    #[tokio::test]
    async fn produce_without_injector_keeps_default_system_prompt_behavior() {
        // 无注入且无基础段：请求不携带 system prompt（P1 阶段 2 现状）
        let (mut producer, provider) = test_producer(None, SessionLoopOptions::default());
        producer.produce().await;
        assert!(
            provider.request_system_prompt(0).is_none(),
            "无注入无基础段 → system_prompt 保持 None（现状）"
        );

        // 无注入但 options 已带基础段：原样透传（不被注入通道改写）
        let options = SessionLoopOptions {
            system_prompt: Some("基础系统提示".to_string()),
            ..SessionLoopOptions::default()
        };
        let (mut producer_base, provider_base) = test_producer(None, options);
        producer_base.produce().await;
        assert_eq!(
            provider_base.request_system_prompt(0).as_deref(),
            Some("基础系统提示"),
            "无注入 → 基础段原样透传（现状）"
        );
    }

    // ── T-D-03：子代理角色约束注入（F4 R-D1；spawn 装配路径 F11 T-D-13 接入）──

    /// T-D-03 冻结文案（测试断言锚点）：段标题/正文/类型三者与任务书一致；
    /// 段类型 = System（按 [CONTEXT_INJECTION_ORDER] 首段位）；静态文本
    /// 不含 `@dynamic` 标记，纳入 C10 字节级一致断言范围
    #[test]
    fn subagent_role_constraint_frozen_text_is_exact() {
        assert_eq!(SUBAGENT_ROLE_CONSTRAINT_TITLE, "子代理角色约束");
        assert_eq!(
            SUBAGENT_ROLE_CONSTRAINT_CONTENT,
            "你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配。如需并行子任务、拆解或汇报，请通过消息/上报通道向主 Agent 提出，由主 Agent 统一派发。"
        );
        assert!(
            !SUBAGENT_ROLE_CONSTRAINT_CONTENT.contains("@dynamic"),
            "静态文本不得带动态字段标记"
        );
        let mut injector = ContextInjector::new();
        push_subagent_role_constraint(&mut injector);
        assert_eq!(
            injector.kinds(),
            vec![ContextInjectionKind::System],
            "段类型 = System（按 CONTEXT_INJECTION_ORDER 首段位）"
        );
    }

    /// T-D-03 渲染契约（render 拼接顺序回归）：基础系统段置首、角色约束段
    /// 紧随其后（System 首段位，位于 Skills 段之前）；两次构建字节一致
    /// （C10 快照断言面）
    #[test]
    fn subagent_role_constraint_renders_after_base_before_skills() {
        let mut injector = ContextInjector::new();
        // 子代理装配面：角色约束段 + Skills 段（验证 System 首段位）
        push_subagent_role_constraint(&mut injector);
        injector.push(ContextInjection::new(
            ContextInjectionKind::Skills,
            "Skill 定义",
            "skill-body",
        ));
        let rendered = injector
            .render(Some("基础系统提示".to_string()))
            .expect("有注入段时必然产出");
        assert!(rendered.starts_with("基础系统提示"), "基础系统段必须置首");
        let constraint = rendered
            .find("## 子代理角色约束")
            .expect("角色约束段存在");
        let skills = rendered.find("## Skill 定义").expect("skill 段存在");
        assert!(constraint < skills, "System 段位于 Skills 段之前（首段位）");
        // 段渲染形状：`## {title}\n{content}`，段间 \n\n 分隔
        let section = format!("## {SUBAGENT_ROLE_CONSTRAINT_TITLE}\n{SUBAGENT_ROLE_CONSTRAINT_CONTENT}");
        assert!(rendered.contains(&section), "角色约束段渲染为 `## 标题\n正文`");
        // C10 字节级一致：同一配置两次构建逐字节一致
        let second = injector
            .render(Some("基础系统提示".to_string()))
            .expect("有注入段时必然产出");
        assert_eq!(rendered, second, "静态注入段两次构建必须逐字节一致");
    }

    /// T-D-03 produce 级（子代理 run 装配面）：经 request_system_prompt 取
    /// system_prompt，断言含冻结文案全文；注入段归类 system 角色、不进
    /// 会话对话（独立于压缩预算）
    #[tokio::test]
    async fn subagent_run_system_prompt_contains_frozen_constraint() {
        let mut injector = ContextInjector::new();
        push_subagent_role_constraint(&mut injector);
        let (producer, provider) = test_producer(None, SessionLoopOptions::default());
        let mut producer = producer.with_context_injector(Some(injector));
        producer.produce().await;

        let sent_system = provider
            .request_system_prompt(0)
            .expect("注入后请求必须携带 system prompt");
        assert!(
            sent_system.contains("你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配"),
            "system_prompt 必须含冻结文案前半句"
        );
        assert!(
            sent_system.contains("如需并行子任务、拆解或汇报，请通过消息/上报通道向主 Agent 提出，由主 Agent 统一派发。"),
            "system_prompt 必须含冻结文案后半句"
        );
        assert!(sent_system.contains("## 子代理角色约束"), "段标题渲染可见");
        // 注入段归类 system 角色，不进会话对话（独立于压缩预算）
        let sent_messages = provider.request_message_arcs(0);
        assert!(
            sent_messages
                .iter()
                .all(|m| m.role != AgentMessageRole::System),
            "注入段不得混入会话消息（system 角色面 = system_prompt）"
        );
    }

    /// T-D-03 主 Agent run 差异断言：主 Agent 装配点不调用
    /// push_subagent_role_constraint → system_prompt 不含本段
    /// （即便装配了其他注入段，角色约束段也不出现）
    #[tokio::test]
    async fn main_agent_run_excludes_subagent_role_constraint() {
        // 主 Agent 装配面：仅常规注入段（Skills），无角色约束段
        let mut injector = ContextInjector::new();
        injector.push(EngineHandle::skill_context_injection(&[sample_skill(
            "code-review",
            "代码评审",
            "按正确性优先评审。",
        )]));
        let (producer, provider) = test_producer(None, SessionLoopOptions::default());
        let mut producer = producer.with_context_injector(Some(injector));
        producer.produce().await;

        let sent_system = provider
            .request_system_prompt(0)
            .expect("有注入段时请求必带 system prompt");
        assert!(
            !sent_system.contains("子代理角色约束"),
            "主 Agent run 不得含角色约束段标题"
        );
        assert!(
            !sent_system.contains("你没有创建子 Agent 的能力"),
            "主 Agent run 不得含冻结文案"
        );
    }

    // ── E5：MCP 接入 + C10 注入读取面（03 方案 E5 内容 1/3）────────────

    /// 构造测试用 RustSkill（C10 注入断言用）
    fn sample_skill(name: &str, description: &str, content: &str) -> RustSkill {
        RustSkill {
            file_path: format!("C:\\skills\\{name}\\SKILL.md"),
            base_dir: format!("C:\\skills\\{name}"),
            content: content.to_string(),
            raw: format!("---\nname: {name}\n---\n{content}"),
            scope: "project".to_string(),
            system: false,
            name: name.to_string(),
            description: description.to_string(),
            tags: Vec::new(),
            applies_to: Vec::new(),
            disable_model_invocation: false,
            file_activation: None,
        }
    }

    /// C10 Skills 注入段：RustSkill 读取面 → 注入段渲染确定（同一配置
    /// 两次构建 system 段字节一致），条目含技能名/描述/正文
    #[test]
    fn skill_injection_is_byte_stable_and_contains_skills() {
        let skills = vec![
            sample_skill("code-review", "代码评审", "按正确性优先评审。"),
            sample_skill("conex-committer", "提交规范", "按仓库风格提交。"),
        ];
        let injection = EngineHandle::skill_context_injection(&skills);
        assert_eq!(injection.kind, ContextInjectionKind::Skills);
        let mut injector = ContextInjector::new();
        injector.push(injection);
        let rendered = injector
            .render(Some("基础系统提示".to_string()))
            .expect("有注入段时必然产出");
        // 渲染确定：两次构建字节一致（C10 断言）
        let second = injector
            .render(Some("基础系统提示".to_string()))
            .expect("有注入段时必然产出");
        assert_eq!(rendered, second, "同一技能集合两次构建 system 段必须字节一致");
        // 读取面内容可见
        assert!(rendered.contains("## Skill 定义"));
        assert!(rendered.contains("- code-review（project）：代码评审"));
        assert!(rendered.contains("按正确性优先评审。"));
        assert!(rendered.contains("- conex-committer（project）：提交规范"));
        // system 标记技能带（系统）标注
        let mut sys = sample_skill("sys-skill", "系统技能", "系统正文");
        sys.system = true;
        let inj = EngineHandle::skill_context_injection(&[sys]);
        let mut injector_sys = ContextInjector::new();
        injector_sys.push(inj);
        let render = injector_sys.render(None).expect("必产出");
        assert!(render.contains("- sys-skill（系统）（project）：系统技能"));
    }

    /// C10 MCP 工具声明注入段：定义列表 → 注入段渲染确定，条目含
    /// `mcp_<server>__<tool>` 命名工具
    #[test]
    fn mcp_injection_is_byte_stable_and_lists_tools() {
        let defs = vec![
            ToolDefinition {
                name: "mcp_files__read".to_string(),
                description: "读文件".to_string(),
                input_schema: serde_json::json!({ "type": "object" }),
                dangerous: false,
                fatal_on_error: false,
            },
            ToolDefinition {
                name: "mcp_files__write".to_string(),
                description: "写文件".to_string(),
                input_schema: serde_json::json!({ "type": "object" }),
                dangerous: true,
                fatal_on_error: false,
            },
        ];
        let injection = EngineHandle::mcp_context_injection(&defs);
        assert_eq!(injection.kind, ContextInjectionKind::Mcp);
        let mut injector = ContextInjector::new();
        injector.push(injection);
        let rendered = injector.render(None).expect("有注入段时必然产出");
        let second = injector.render(None).expect("有注入段时必然产出");
        assert_eq!(rendered, second, "同一 MCP 工具集两次构建必须字节一致");
        assert!(rendered.contains("## MCP 工具声明"));
        assert!(rendered.contains("- mcp_files__read：读文件"));
        assert!(rendered.contains("- mcp_files__write：写文件"));
    }

    /// C10 注入集成（produce 级）：skill 注入段经 system_prompt 面送达
    /// provider（M1 注入点 + M11 输出消费），对话消息不含 system 角色
    #[tokio::test]
    async fn produce_with_skill_injection_sends_skill_segment() {
        let skills = vec![sample_skill("code-review", "代码评审", "按正确性优先评审。")];
        let mut injector = ContextInjector::new();
        injector
            .push(EngineHandle::skill_context_injection(&skills))
            .push(EngineHandle::mcp_context_injection(&[ToolDefinition {
                name: "mcp_files__read".to_string(),
                description: "读文件".to_string(),
                input_schema: serde_json::json!({ "type": "object" }),
                dangerous: false,
                fatal_on_error: false,
            }]));
        let (producer, provider) = test_producer(None, SessionLoopOptions::default());
        let mut producer = producer.with_context_injector(Some(injector));
        producer.produce().await;

        let sent_system = provider
            .request_system_prompt(0)
            .expect("注入后请求必须携带 system prompt");
        assert!(sent_system.contains("## Skill 定义"));
        assert!(sent_system.contains("code-review"));
        // 注入顺序契约：skills 段先于 MCP 段
        let skill = sent_system.find("## Skill 定义").expect("skill 段存在");
        let mcp = sent_system.find("## MCP 工具声明").expect("MCP 段存在");
        assert!(skill < mcp, "skill 段先于 MCP 段（M1 冻结顺序）");
        // 注入段归类 system 角色，不进会话对话（独立于压缩预算）
        let sent_messages = provider.request_message_arcs(0);
        assert!(
            sent_messages
                .iter()
                .all(|m| m.role != AgentMessageRole::System),
            "注入段不得混入会话消息（system 角色面 = system_prompt）"
        );
    }

    /// 定位 agent-tools 测试夹具二进制（mcp-fake-server）：workspace 测试
    /// 构建时与测试可执行同目录产出；独立构建本 crate 测试时可能缺失
    fn locate_mcp_fake_server() -> Option<std::path::PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        let name = if cfg!(windows) {
            "mcp-fake-server.exe"
        } else {
            "mcp-fake-server"
        };
        let candidate = dir.join(name);
        candidate.exists().then_some(candidate)
    }

    /// 引擎集成：插件 mcpServers 声明 → 服务器启动 → 工具并入注册表
    /// （mcp_<server>__<tool> 命名），注册后可执行往返；启动失败 =
    /// mcp.* 错误上抛且注册表不污染
    #[tokio::test]
    async fn register_plugin_mcp_server_integration() {
        let engine = EngineHandle::new(None);

        // 错误路径：非法命令 → mcp.connection_failed，注册表无残留
        let bad = McpServerConfig::new("missing", "definitely-not-a-real-command-xyz");
        let err = engine.register_plugin_mcp_server(bad).await.unwrap_err();
        assert_eq!(err.code(), "mcp.connection_failed");
        let listed: Vec<String> = engine
            .tool_registry()
            .list_definitions()
            .iter()
            .map(|d| d.name.clone())
            .collect();
        assert!(
            !listed.iter().any(|n| n.starts_with("mcp_missing")),
            "启动失败不得污染注册表"
        );

        // 成功路径：依赖 agent-tools 测试夹具（workspace 全量测试时存在；
        // 单独构建本 crate 时跳过并记录）
        let Some(fake) = locate_mcp_fake_server() else {
            tracing::warn!(
                "mcp-fake-server 夹具未构建（需 workspace 全量构建），跳过引擎级 MCP 成功路径断言"
            );
            return;
        };
        let config = McpServerConfig::new("fake", fake.to_string_lossy().to_string());
        let defs = engine.register_plugin_mcp_server(config).await.unwrap();
        let names: Vec<String> = defs.iter().map(|d| d.name.clone()).collect();
        assert!(
            names.contains(&"mcp_fake__echo".to_string()),
            "MCP 工具应并入：{names:?}"
        );
        let listed: Vec<String> = engine
            .tool_registry()
            .list_definitions()
            .iter()
            .map(|d| d.name.clone())
            .collect();
        assert!(
            listed.contains(&"mcp_fake__echo".to_string()),
            "list_definitions 应可见并入的 MCP 工具"
        );
        // 幂等：重复注册不报错、不重复并入
        engine
            .register_plugin_mcp_server(McpServerConfig::new("fake", fake.to_string_lossy().to_string()))
            .await
            .unwrap();
        let count = engine
            .tool_registry()
            .list_definitions()
            .iter()
            .filter(|d| d.name.starts_with("mcp_fake__"))
            .count();
        assert_eq!(count, 4, "重复注册不得重复并入");
        // 生命周期收口
        engine.mcp_bridge().stop_all().await;
    }
}

/// T-CF-06 装配测试：EngineHandle 的 TimerRegistry 接线面。
///
/// 独立模块（不与上方既有 tests 模块共享上下文），聚焦
/// `engine_injects_timer_channel` 一项验收断言。
#[cfg(test)]
mod timer_wiring_tests {
    use super::*;
    use conex_types::timer::TimerCondition;

    /// EngineHandle::new 后 set_timer / cancel_timer 工具已注册且
    /// TimerChannel 已接线：register / cancel / list_active 不再返回
    /// unsupported；到期 steering 条目落在引擎持有的真实
    /// PendingMessageQueue（group_id = timer-<id>）。
    #[tokio::test]
    async fn engine_injects_timer_channel() {
        let engine = EngineHandle::new(None);
        // 工具注册面（T-CF-05 登记；通道为 None 时工具才返回 unsupported）
        let names: Vec<String> = engine
            .tool_registry()
            .list_definitions()
            .iter()
            .map(|d| d.name.clone())
            .collect();
        assert!(
            names.iter().any(|n| n == "set_timer"),
            "set_timer 应已注册：{names:?}"
        );
        assert!(
            names.iter().any(|n| n == "cancel_timer"),
            "cancel_timer 应已注册：{names:?}"
        );
        // 契约接线：经 TimerChannel 注册/取消/活跃列表（TimerRegistry 实现）
        let channel: Arc<dyn TimerChannel> = engine.timer_registry();
        let handle = channel
            .register(1, "装配检查".to_string(), TimerCondition::Never)
            .await
            .expect("timer_channel 已接线，register 不应 unsupported");
        assert_eq!(handle.timer_id, "timer-0");
        let active = channel.list_active().await.expect("list_active 应可用");
        assert_eq!(active.len(), 1, "活跃列表应含刚注册的定时器");
        let cancelled = channel
            .cancel(&handle.timer_id)
            .await
            .expect("cancel 应可用");
        assert!(cancelled);
        assert!(
            channel.list_active().await.expect("list_active 应可用").is_empty(),
            "取消后活跃列表应为空"
        );
        // 真实 PendingMessageQueue 落点：注册新定时器到期 → 队列出现
        // group_id=timer-<id> 条目、text 含 prompt（生产装配全链路）
        let handle_b = channel
            .register(1, "装配链路检查".to_string(), TimerCondition::Never)
            .await
            .expect("注册应成功");
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        let queue = engine.timer_steering_queue();
        let mut queue = queue.lock().unwrap_or_else(|e| e.into_inner());
        let entries = queue.dequeue_all();
        assert_eq!(entries.len(), 1, "到期应恰好注入一条 steering 条目");
        assert_eq!(
            entries[0].group_id.as_deref().map(str::to_string),
            Some(format!("timer-{}", handle_b.timer_id)),
            "group_id 应为 timer-<id>"
        );
        assert!(
            entries[0].text.contains("装配链路检查"),
            "条目文本应含 prompt：{}",
            entries[0].text
        );
        assert!(entries[0].is_steering, "条目应带 steering 保护位");
    }
}

/// T-CF-10 装配测试：EngineHandle 的 WaitChannel 接线面。
///
/// 独立模块（不与上方既有 tests 模块共享上下文），聚焦
/// `engine_registers_wait_channel` 等验收断言。
#[cfg(test)]
mod wait_wiring_tests {
    use super::*;
    use agent_tools::context::create_mock_tool_context;
    use agent_tools::tools::wait_subagents::WaitMode;
    use conex_types::events::SubagentEndStatus;

    /// EngineHandle::new 后 wait_subagents 工具已注册且 WaitChannel 已
    /// 接线：parallel-work 非阻塞快照不再返回 unsupported；声明经工具
    /// 落库到引擎共享 dispatch 存储（与 watchdog 同一数据面）。
    #[tokio::test]
    async fn engine_registers_wait_channel() {
        let engine = EngineHandle::new(None);
        // 工具注册面（T-CF-10：通道为 None 时工具才返回 unsupported）
        let names: Vec<String> = engine
            .tool_registry()
            .list_definitions()
            .iter()
            .map(|d| d.name.clone())
            .collect();
        assert!(
            names.iter().any(|n| n == "wait_subagents"),
            "wait_subagents 应已注册：{names:?}"
        );
        // 端到端：parallel-work（非阻塞快照路径）不再返回 unsupported
        let tool = engine
            .tool_registry()
            .get("wait_subagents")
            .expect("wait_subagents 已注册");
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "subagentIds": ["sa-1", "sa-2"],
                    "mode": "parallel-work"
                }),
            )
            .await
            .expect("WaitChannel 已接线，parallel-work 不应返回 unsupported");
        assert_eq!(out["mode"], "parallel-work");
        assert_eq!(out["allTerminal"], false);
        assert_eq!(out["agents"][0]["subagentId"], "sa-1");
        assert_eq!(out["agents"][0]["status"], "running");
        // 声明已落库：引擎共享 dispatch 存储（watchdog 读同一数据面）
        let loaded = engine.dispatch_store().load_all();
        assert_eq!(loaded.len(), 1, "工具执行应持久化调度声明");
        assert_eq!(loaded[0].mode, WaitMode::ParallelWork);
        assert_eq!(
            loaded[0].subagent_ids,
            vec!["sa-1".to_string(), "sa-2".to_string()]
        );
        // 等待通道契约面可用（与工具注入同一实例）
        let snapshot = engine
            .wait_channel()
            .snapshot(&["sa-1".to_string()])
            .await
            .expect("snapshot 应可用");
        assert_eq!(snapshot[0].subagent_id, "sa-1");
    }

    /// 引擎级事件驱动等待全链路：wait_subagents await-all 等待期间，
    /// 终态事件经引擎持有的广播实例 feed（EventQueue 旁路适配的接线
    /// 面）→ 提前返回；返回后订阅断流。
    #[tokio::test]
    async fn engine_wait_channel_wakeup_via_terminal_stream() {
        let engine = EngineHandle::new(None);
        let tool = engine
            .tool_registry()
            .get("wait_subagents")
            .expect("wait_subagents 已注册");
        let ctx = create_mock_tool_context();
        let wait_task = tokio::spawn({
            let tool = tool;
            let ctx = ctx;
            async move {
                tool.execute(
                    &ctx,
                    serde_json::json!({
                        "subagentIds": ["sa-1"],
                        "mode": "await-all",
                        "timeoutMs": 60_000
                    }),
                )
                .await
            }
        });
        // 等待订阅建立（wait_for_terminal 与 feed 之间的同步点）
        let stream = engine.terminal_stream();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while tokio::time::Instant::now() < deadline {
            if stream.subscriber_count() > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            stream.subscriber_count() > 0,
            "wait 期间应已订阅终态事件流"
        );
        // feed subagent-ended（事件收口旁路点接线面的同构调用）
        stream.feed(&AgentEvent::SubagentEnded {
            session_id: "mock-session".to_string(),
            subagent_id: "sa-1".to_string(),
            subagent_run_id: "run-sa-1".to_string(),
            status: SubagentEndStatus::Completed,
            summary: Some("完成".to_string()),
            ended_at: now_iso_utc(),
        });
        let out = tokio::time::timeout(Duration::from_secs(5), wait_task)
            .await
            .expect("工具应在超时窗口内返回")
            .expect("tokio 任务 join 失败（工具执行任务 panic）")
            .expect("工具执行不应报错");
        assert_eq!(out["allTerminal"], true);
        assert_eq!(out["agents"][0]["status"], "completed");
        assert_eq!(
            stream.subscriber_count(),
            0,
            "wait 返回后订阅应断流（mpsc drop）"
        );
    }

    /// 装配降级：watchdog 与 wait 通道的共享 dispatch 存储桥接——
    /// wait 落库后 watchdog 可读（同一实例双 trait 注入断言）
    #[tokio::test]
    async fn engine_dispatch_store_bridges_to_watchdog() {
        let engine = EngineHandle::new(None);
        let declaration = DispatchDeclaration {
            mode: WaitMode::AwaitAll,
            wait_ms: None,
            subagent_ids: vec!["sa-1".to_string()],
            dispatched_at_ms: 1_000,
        };
        engine
            .wait_channel()
            .persist_declaration(&declaration)
            .await
            .expect("声明落库应成功");
        // 桥接读面：watchdog 的 DispatchStore 看到同一数据
        let store = engine.dispatch_store();
        let as_watchdog: Arc<dyn crate::watchdog::DispatchStore> = store;
        let declarations = as_watchdog.load_declarations();
        assert_eq!(declarations.len(), 1);
        assert_eq!(declarations[0].subagent_ids, vec!["sa-1".to_string()]);
        // 唤醒跟踪面可用（watchdog 失联判定数据源）
        engine.last_wakeup().mark_wakeup_at(2_000);
        assert_eq!(engine.last_wakeup().last_wakeup_ms(), Some(2_000));
    }
}

/// P4（30 方案 §4）事件缓冲 drain 转发测试：timer/cron 缓冲 → 真实
/// EventBridge 的信封直发形状，与访问器到达生产装配实例的断言面。
///
/// 独立模块（不与上方既有 tests 模块共享上下文）。生产 sink（引擎装配
/// 实例）与测试收集器实例隔离：EngineHandle::new 每用例新建，无污染。
#[cfg(test)]
mod event_drain_tests {
    use super::*;
    use crate::core_event_bridge::Emitter;
    use crate::sched::{CronEvent, EventSink as SchedEventSinkTrait};
    use crate::timers::{EventSink as TimerEventSinkTrait, TimerEvent};
    use conex_types::events::SecurityAuditOperation;
    use conex_types::timer::TimerCondition;

    /// 测试发射器：记录 (channel, payload) 序列（对齐 core_event_bridge
    /// 测试先例 RecordingEmitter）
    #[derive(Default)]
    struct RecordingEmitter {
        calls: Mutex<Vec<(String, String)>>,
    }

    impl RecordingEmitter {
        fn calls(&self) -> Vec<(String, String)> {
            self.calls.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
    }

    impl Emitter for RecordingEmitter {
        fn emit(&self, channel: &str, payload: &str) {
            self.calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((channel.to_string(), payload.to_string()));
        }
    }

    /// 构造记录桥（通道名恒 workbench-run-event）
    fn recording_bridge() -> (EventBridge, Arc<RecordingEmitter>) {
        let emitter = Arc::new(RecordingEmitter::default());
        let bridge = EventBridge::new(
            "workbench-run-event",
            Arc::clone(&emitter) as Arc<dyn Emitter>,
        );
        (bridge, emitter)
    }

    /// 定时器缓冲事件 → forward helper → 信封形状断言：runId/sequence
    /// 不注入（None）、事件体字段级断言（timerId/prompt/firedAtMs 与
    /// timer-cancelled 的 reason/cancelledAtMs）；二次转发空缓冲返回 0
    /// （Vec::take 语义，不重复转发）。
    #[test]
    fn drain_forward_emits_envelopes_without_runid() {
        let sink = AgentEventSink::new();
        TimerEventSinkTrait::emit(
            &sink,
            TimerEvent::Fired {
                timer_id: "timer-0".to_string(),
                prompt: "检查编译结果".to_string(),
                fired_at_ms: 1_700_000_000_123,
            },
        );
        TimerEventSinkTrait::emit(
            &sink,
            TimerEvent::Cancelled {
                timer_id: "timer-1".to_string(),
                reason: crate::timers::TimerCancelReason::EarlyExit,
                cancelled_at_ms: 1_700_000_000_456,
            },
        );
        let (bridge, emitter) = recording_bridge();
        let forwarded = forward_drained_timer_events(&sink, &bridge);
        assert_eq!(forwarded, 2, "两条缓冲事件应全部转发");
        let calls = emitter.calls();
        assert_eq!(calls.len(), 2);
        for (channel, _) in &calls {
            assert_eq!(channel, "workbench-run-event");
        }
        // 信封顶层形状：type 正确、无 runId/sequence、schemaVersion=1
        let first: serde_json::Value =
            serde_json::from_str(&calls[0].1).expect("载荷应为合法 JSON");
        assert_eq!(first["type"], "timer-fired");
        assert!(first.get("runId").is_none(), "timer 事件不得注入 runId");
        assert!(first.get("sequence").is_none(), "timer 事件不得注入 sequence");
        assert_eq!(first["schemaVersion"], 1);
        assert_eq!(first["sessionId"], "");
        assert_eq!(first["timerId"], "timer-0");
        assert_eq!(first["prompt"], "检查编译结果");
        assert_eq!(first["firedAtMs"], 1_700_000_000_123_u64);
        let second: serde_json::Value =
            serde_json::from_str(&calls[1].1).expect("载荷应为合法 JSON");
        assert_eq!(second["type"], "timer-cancelled");
        assert_eq!(second["timerId"], "timer-1");
        assert_eq!(second["reason"], "early-exit");
        assert_eq!(second["cancelledAtMs"], 1_700_000_000_456_u64);
        // 二次转发空缓冲 → 0（drain 已取走，不重复转发）
        assert_eq!(
            forward_drained_timer_events(&sink, &bridge),
            0,
            "空缓冲转发应返回 0"
        );
    }

    /// cron 缓冲事件 → forward helper → 信封形状断言（cron-fired 单臂：
    /// conex-types 仅 CronFired 变体，字段 cronId/prompt/expression/
    /// iteration/firedAtMs 字段级断言；runId/sequence 不注入）。
    #[test]
    fn drain_forward_scheduler_emits_envelopes_without_runid() {
        let sink = crate::sched::SchedEventSink::new();
        SchedEventSinkTrait::emit(
            &sink,
            CronEvent::Fired {
                cron_id: "cron-0".to_string(),
                prompt: "每日备份".to_string(),
                expression: "0 3 * * *".to_string(),
                iteration: 3,
                fired_at_ms: 1_700_000_000_789,
            },
        );
        let (bridge, emitter) = recording_bridge();
        let forwarded = forward_drained_scheduler_events(&sink, &bridge);
        assert_eq!(forwarded, 1, "一条缓冲事件应全部转发");
        let calls = emitter.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "workbench-run-event");
        let payload: serde_json::Value =
            serde_json::from_str(&calls[0].1).expect("载荷应为合法 JSON");
        assert_eq!(payload["type"], "cron-fired");
        assert!(payload.get("runId").is_none(), "cron 事件不得注入 runId");
        assert!(payload.get("sequence").is_none(), "cron 事件不得注入 sequence");
        assert_eq!(payload["schemaVersion"], 1);
        assert_eq!(payload["cronId"], "cron-0");
        assert_eq!(payload["prompt"], "每日备份");
        assert_eq!(payload["expression"], "0 3 * * *");
        assert_eq!(payload["iteration"], 3);
        assert_eq!(payload["firedAtMs"], 1_700_000_000_789_u64);
        // 二次转发空缓冲 → 0
        assert_eq!(
            forward_drained_scheduler_events(&sink, &bridge),
            0,
            "空缓冲转发应返回 0"
        );
    }

    /// 访问器到达生产装配实例：EngineHandle::new 装配的缓冲与
    /// TimerRegistry/SchedulerRegistry 注入的是同一 Arc——定时器到期 →
    /// 缓冲出现 TimerFired；cron 触发 → 缓冲出现 CronFired；drain 转发
    /// 后真实桥收到信封（与 :690 装配点同一实例的功能性证明）。
    #[tokio::test]
    async fn engine_accessors_reach_production_sinks() {
        let engine = EngineHandle::new(None);
        // 访问器稳定实例（两次取回同一 Arc）
        assert!(Arc::ptr_eq(
            &engine.timer_event_sink(),
            &engine.timer_event_sink()
        ));
        assert!(Arc::ptr_eq(
            &engine.scheduler_event_sink(),
            &engine.scheduler_event_sink()
        ));
        // 定时器面：注册 1 秒定时器 → 到期 → 生产缓冲出现 TimerFired
        // （与 TimerRegistry 注入同一缓冲实例的功能性证明）
        let channel: Arc<dyn TimerChannel> = engine.timer_registry();
        let handle = channel
            .register(1, "drain 装配检查".to_string(), TimerCondition::Never)
            .await
            .expect("timer_channel 已接线，register 不应 unsupported");
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let timer_events = engine.timer_event_sink().drain();
        assert!(
            timer_events.iter().any(|e| matches!(
                e,
                AgentEvent::TimerFired { ref timer_id, ref prompt, .. }
                    if timer_id == &handle.timer_id && prompt == "drain 装配检查"
            )),
            "到期事件应到达生产缓冲：{timer_events:?}"
        );
        channel.cancel(&handle.timer_id).await.ok();
        // cron 面：注入短触发延迟（测试钩子）→ 注册 → 触发 → 生产缓冲
        // 出现 CronFired（与 SchedulerRegistry 注入同一缓冲实例）
        let registry = engine.scheduler_registry().expect("装配后应为 Some");
        registry.set_fire_override_ms(40);
        let cron_id = registry
            .register(crate::sched::CronTaskInput {
                expression: "* * * * *".to_string(),
                prompt: "drain cron 检查".to_string(),
                max_iterations: Some(1),
                is_daemon: false,
            })
            .await
            .expect("cron 注册应成功");
        tokio::time::sleep(Duration::from_millis(300)).await;
        // 转发路径端到端：经访问器取走生产缓冲 → 真实桥信封（runId
        // 不注入）；payload 字段级断言即「同一缓冲实例」的功能性证明
        let (bridge, emitter) = recording_bridge();
        let forwarded = forward_drained_scheduler_events(&engine.scheduler_event_sink(), &bridge);
        assert_eq!(forwarded, 1, "cron 触发事件应经访问器转发到真实桥");
        let payload: serde_json::Value =
            serde_json::from_str(&emitter.calls()[0].1).expect("载荷应为合法 JSON");
        assert_eq!(payload["type"], "cron-fired");
        assert_eq!(payload["cronId"], cron_id);
        assert_eq!(payload["prompt"], "drain cron 检查");
        assert_eq!(payload["iteration"], 1);
        assert!(payload.get("runId").is_none(), "cron 事件不得注入 runId");
        // drain 已取走 → 缓冲为空（Vec::take 语义，不重复转发）
        assert!(
            engine.scheduler_event_sink().drain().is_empty(),
            "转发后生产缓冲应为空"
        );
        // 清理：max_iterations=1 已自停（enabled=false 落库），无残留声明
    }

    // ── 15-T-6（裁决 D9）：RoutingAuditSink 路由分发 / G10 计数 ───

    /// 测试用 security-audit 事件（决策参数化；形状对齐
    /// agent-tools audit.rs security_audit_event 构造器）
    fn routing_test_audit_event(session_id: &str, decision: SecurityAuditDecision) -> AgentEvent {
        agent_tools::audit::security_audit_event(
            session_id,
            SecurityAuditOperation::Delete,
            vec!["a.txt".to_string()],
            conex_types::impact::ImpactAssessment {
                file_count: 1,
                total_size_bytes: 0,
                directory_count: 0,
                cross_directory: false,
                flagged: false,
            },
            decision,
            None,
        )
    }

    /// 路由分发（多 session）：各会话审计事件仅达自己的 run 桥；未注册
    /// 会话 tracing 兜底不 panic 不送达
    #[test]
    fn routing_audit_sink_dispatches_per_session() {
        let sink = RoutingAuditSink::new(Arc::new(DeniedStats::new()));
        let s1 = Arc::new(agent_tools::audit::RecordingAuditSink::new());
        let s2 = Arc::new(agent_tools::audit::RecordingAuditSink::new());
        sink.register("s1", Arc::clone(&s1) as AuditSink);
        sink.register("s2", Arc::clone(&s2) as AuditSink);
        assert_eq!(sink.route_count(), 2);
        sink.emit(&routing_test_audit_event("s1", SecurityAuditDecision::Blocked));
        sink.emit(&routing_test_audit_event("s2", SecurityAuditDecision::Blocked));
        // 各会话事件仅达自己的 run 桥
        assert_eq!(s1.emitted().len(), 1);
        assert_eq!(s2.emitted().len(), 1);
        // 未注册会话 → tracing 兜底（不 panic、不送达）
        sink.emit(&routing_test_audit_event("ghost", SecurityAuditDecision::Blocked));
        assert_eq!(s1.emitted().len(), 1);
        assert_eq!(s2.emitted().len(), 1);
    }

    /// G10 denied 计数：仅 denied 决策计数（引擎级共享统计），全部事件
    /// 原样转发
    #[test]
    fn routing_audit_sink_counts_denied_globally() {
        let stats = Arc::new(DeniedStats::new());
        let sink = RoutingAuditSink::new(Arc::clone(&stats));
        let s1 = Arc::new(agent_tools::audit::RecordingAuditSink::new());
        sink.register("s1", Arc::clone(&s1) as AuditSink);
        sink.emit(&routing_test_audit_event("s1", SecurityAuditDecision::Denied));
        sink.emit(&routing_test_audit_event("s1", SecurityAuditDecision::Redirected));
        sink.emit(&routing_test_audit_event("s1", SecurityAuditDecision::Denied));
        // 仅 denied 计数（G10），全部事件转发
        assert_eq!(stats.summary().security_audit_denied, 2);
        assert_eq!(s1.emitted().len(), 3);
    }

    /// 收口注销：unregister 后路由不再送达；重复注销幂等；注册表无残留
    #[test]
    fn routing_audit_sink_unregister_is_idempotent() {
        let sink = RoutingAuditSink::new(Arc::new(DeniedStats::new()));
        let s1 = Arc::new(agent_tools::audit::RecordingAuditSink::new());
        sink.register("s1", Arc::clone(&s1) as AuditSink);
        assert_eq!(sink.route_count(), 1);
        sink.unregister("s1");
        sink.unregister("s1");
        assert_eq!(sink.route_count(), 0, "重复注销幂等，注册表无残留");
        sink.emit(&routing_test_audit_event("s1", SecurityAuditDecision::Blocked));
        assert!(s1.emitted().is_empty(), "注销后事件不再送达（tracing 兜底）");
    }

    /// 同 session 多 run 并发注册 → 后注册者覆盖（新 run 覆盖旧 run，
    /// 与事件收口旁路点口径一致）
    #[test]
    fn routing_audit_sink_later_register_overwrites() {
        let sink = RoutingAuditSink::new(Arc::new(DeniedStats::new()));
        let old = Arc::new(agent_tools::audit::RecordingAuditSink::new());
        let new = Arc::new(agent_tools::audit::RecordingAuditSink::new());
        sink.register("s1", Arc::clone(&old) as AuditSink);
        sink.register("s1", Arc::clone(&new) as AuditSink);
        sink.emit(&routing_test_audit_event("s1", SecurityAuditDecision::Blocked));
        assert!(old.emitted().is_empty(), "旧 run 桥应被新 run 覆盖");
        assert_eq!(new.emitted().len(), 1);
    }

    /// 引擎装配面：BuiltinToolConfig.audit_sink 注入的与访问器取回的是
    /// 同一实例（路由 sink 经工具注册表接线到引擎共享统计）
    #[test]
    fn engine_audit_sink_accessor_reaches_shared_instance() {
        let engine = EngineHandle::new(None);
        assert!(Arc::ptr_eq(&engine.audit_sink(), &engine.audit_sink()));
    }

    // ── PS-04 T4.3（F4 F1-01）：reload_provider 热更新 ──

    /// T4.3-R1：注入旧配置 A → `reload_provider()` → provider_config 的
    /// model/key/baseUrl 必须变为新值（换 key/模型后下一次 run 用新凭据；
    /// 修复前 provider 只在构造时加载一次，改配置后不生效）。
    #[test]
    fn reload_provider_rebuilds_provider_config_from_store() {
        use crate::core_run_commands::{isolate_config_store, CONFIG_TEST_LOCK};
        let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "conex-config-test-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create config dir");
        isolate_config_store(&dir);

        // 旧配置 A（引擎构造时快照）
        crate::config::with_store_mut(|store| {
            store.set_api_key("sk-a".to_string())?;
            store.set_base_url("https://a.example/v1".to_string())?;
            store.set_model("model-a".to_string())?;
            Ok(())
        })
        .expect("store A");
        let engine = EngineHandle::new(None);
        let before = engine.provider_config().expect("构造后就绪");
        assert_eq!(before.api_key, "sk-a");
        assert_eq!(before.model, "model-a");
        assert!(engine.ready());

        // 改 store 为新配置 B → 重载 → 生效配置必须刷新
        crate::config::with_store_mut(|store| {
            store.set_api_key("sk-b".to_string())?;
            store.set_base_url("https://b.example/v1".to_string())?;
            store.set_model("model-b".to_string())?;
            Ok(())
        })
        .expect("store B");
        engine.reload_provider();
        let after = engine.provider_config().expect("重载后就绪");
        assert_eq!(after.api_key, "sk-b", "key 必须热更新");
        assert_eq!(after.base_url, "https://b.example/v1", "baseUrl 必须热更新");
        assert_eq!(after.model, "model-b", "model 必须热更新");
        assert!(engine.ready(), "重载后就绪");
        assert!(engine.provider().is_some(), "重载后 provider 可调用");
    }

    /// T4.3-R1 契约延伸：三件套清空（api_key=空串）后 reload_provider →
    /// 引擎降级未就绪（ready=false / provider=None / provider_config=None）；
    /// 重填后恢复。与构造时降级语义一致（F4 F1-01 修复建议 4）。
    #[test]
    fn reload_provider_degrades_when_key_cleared_then_recovers() {
        use crate::core_run_commands::{isolate_config_store, CONFIG_TEST_LOCK};
        let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "conex-config-test-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create config dir");
        isolate_config_store(&dir);

        crate::config::with_store_mut(|store| {
            store.set_api_key("sk-a".to_string())?;
            store.set_base_url("https://a.example/v1".to_string())?;
            store.set_model("model-a".to_string())?;
            Ok(())
        })
        .expect("store A");
        let engine = EngineHandle::new(None);
        assert!(engine.ready());

        // 清空 key（空串）→ 重载 → 降级未就绪（不得再用旧 key 发请求）
        crate::config::with_store_mut(|store| {
            store.set_api_key(String::new())?;
            Ok(())
        })
        .expect("clear key");
        engine.reload_provider();
        assert!(!engine.ready(), "清 key 后未就绪");
        assert!(engine.provider().is_none(), "清 key 后 provider=None");
        assert!(engine.provider_config().is_none(), "清 key 后 provider_config=None");
        assert!(engine.ready_reason().is_some(), "未就绪原因可诊断");

        // 重填 → 恢复
        crate::config::with_store_mut(|store| {
            store.set_api_key("sk-c".to_string())?;
            Ok(())
        })
        .expect("refill key");
        engine.reload_provider();
        assert!(engine.ready(), "重填后恢复就绪");
        assert_eq!(
            engine.provider_config().expect("重填后就绪").api_key,
            "sk-c"
        );
    }
}
