//! 通道面（SR-04 拆分 · engine.rs → engine_channels.rs）
//!
//! 承载（D-03 SR-04 四面之 channels 通道）：会话级 Summarizer 工厂
//! （[SummarizerFactory] / [ProviderSummarizer] /
//! [production_summarizer_factory]，COMPACTION-01 P0-3 闭环）+
//! 任务连续性通道板卡（[ContinuityChannelBoard] 延迟绑定四通道，审计 01
//! W1）+ 缓冲事件桥（[BufferedRunEventBridge] / [BridgeDeltaSink]，
//! B6.3/T09.1 双轨）+ timer/cron 缓冲事件 drain 转发
//! （[forward_drained_timer_events] / [forward_drained_scheduler_events]）。
//! 头钉：SR-04 · 拆分 · ≠ EL（结构拆分，不关任何 EL；仅搬移不改语义）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_provider::request::{
    build_chat_completions_request_body, ChatCompletionsRequestOptions, RequestBuildContext,
};
use agent_tools::tools::kill_subagent::{KillSubagentToolResult, SubagentKillChannel};
use agent_tools::tools::send_message::{
    MainAgentMessageChannel, MainMessageRing, SubagentInjectChannel,
};
use conex_types::events::{AgentEvent, AgentEventEnvelope};
use conex_types::tool::SystemPromptWireMode;
use crish_agent_workbench::wait_channel::ControlBusResolver;
use session_loop::provider::{DeltaSink, LiveEventSink};
use session_loop::ControlBus;

use super::engine_build::EngineHandle;
use super::engine_provider::{
    chat_provider_url, max_tokens_field, user_message, EngineProviderConfig,
};
use crate::buffer::{drop_class_of, EventBuffer};
use crate::core_event_bridge::{EmitReport, EventBridge};
use crate::timers::AgentEventSink;

/// 毒丸恢复计数（B1-5 观测化：通道面 9 处锁中毒恢复次数——板卡四通道
/// 绑定/读取 + 缓冲事件桥 buffer 锁；对齐 registry.rs / note_memory.rs
/// 「tracing::error! 成对 + 计数」样板，零新依赖）
static POISON_RECOVERIES: AtomicU64 = AtomicU64::new(0);

/// 毒丸恢复计数读取（毒化测断言面；S3 埋点消费面就绪后解除 cfg(test)）
#[cfg(test)]
pub(crate) fn channels_poison_recovery_count() -> u64 {
    POISON_RECOVERIES.load(Ordering::Relaxed)
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
    pub(crate) fn build_request_body(&self, prompt: &str) -> serde_json::Value {
        let options = ChatCompletionsRequestOptions {
            model: Some(self.config.model.clone()),
            // 非流式：一次收全响应，同步面逐字节解析
            stream: Some(false),
            max_tokens: Some(self.max_summary_tokens as u64),
            max_tokens_field: Some(max_tokens_field(&self.config)),
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
        // DEEPCHECK-05 #10 修复：摘要请求体恒 chat 形状 → URL 恒 chat-completions
        // （responses 端点配置下也禁止把 chat body 发往 /responses）
        let url = chat_provider_url(&self.config);
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
        let inner = rx.recv_timeout(SUMMARY_HTTP_RECV_TIMEOUT).map_err(|_| {
            format!(
                "摘要 HTTP 调用超时（>{:?} 无响应）",
                SUMMARY_HTTP_RECV_TIMEOUT
            )
        })?;
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
pub(crate) fn production_summarizer_factory(engine: Arc<EngineHandle>) -> SummarizerFactory {
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

// ── 任务连续性通道板卡（审计 01 W1：kill_subagent / send_message 生产
//    通道装配面）───────────────────────────────────────────────────

/// 任务连续性三通道 + 控制总线解析器的延迟绑定板卡（审计 01 W1 装配收口）。
///
/// - kill_subagent / send_message 两工具的生产通道实现在 CoreRunState
///   （活动 run 注册表 / 生命周期服务域），但 CoreRunState 在引擎构造
///   之后才存在（CoreRunState::new 内部构造 EngineHandle）——引擎装配
///   时以本板卡占位（WaitChannel 的 ControlBusResolver 与
///   BuiltinToolConfig 三通道字段），CoreRunState Arc 构造完成后经
///   [ContinuityChannelBoard::bind_*] 注入真实现（main.rs
///   finalize_continuity_channels 装配面，与 finalize_subagent_spawner
///   同批）；
/// - 未绑定（None）→ 结构化错误文案上抛（工具侧按执行失败兜底映射；
///   生产装配窗口 = 引擎构造与 finalize 之间，毫秒级）；
/// - 绑定为覆盖语义（幂等：重复 bind 以最后一次为准——进程内仅一次）。
pub(crate) struct ContinuityChannelBoard {
    /// 子代理注入解析（send_message target=subagent 与 wait_channel
    /// inject 共用；取代生产 NoopControlBusResolver）
    control_bus: Mutex<Option<Arc<dyn ControlBusResolver>>>,
    /// kill_subagent 终止通道（L3 强停 + 行归一）
    kill: Mutex<Option<Arc<dyn SubagentKillChannel>>>,
    /// send_message 子代理注入通道（L1 steer）
    inject: Mutex<Option<Arc<dyn SubagentInjectChannel>>>,
    /// send_message 主 agent 消息通道（followUp 环 + 会话留档）
    self_message: Mutex<Option<Arc<dyn MainAgentMessageChannel>>>,
}

impl std::fmt::Debug for ContinuityChannelBoard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContinuityChannelBoard")
            .finish_non_exhaustive()
    }
}

impl ContinuityChannelBoard {
    /// 新建板卡（全部插槽为空——未绑定状态）
    pub(crate) fn new() -> Self {
        Self {
            control_bus: Mutex::new(None),
            kill: Mutex::new(None),
            inject: Mutex::new(None),
            self_message: Mutex::new(None),
        }
    }

    /// 绑定控制总线解析器（CoreRunState 实现；Weak 适配切断引用环）
    pub(crate) fn bind_control_bus(&self, resolver: Arc<dyn ControlBusResolver>) {
        *self.control_bus.lock().unwrap_or_else(|e| {
            // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
            tracing::error!(
                target: "engine",
                "ContinuityChannelBoard control_bus 锁中毒，按恢复模式继续：{e}"
            );
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        }) = Some(resolver);
    }

    /// 绑定 kill_subagent 终止通道（CoreRunState 实现）
    pub(crate) fn bind_kill(&self, channel: Arc<dyn SubagentKillChannel>) {
        *self.kill.lock().unwrap_or_else(|e| {
            // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
            tracing::error!(
                target: "engine",
                "ContinuityChannelBoard kill 锁中毒，按恢复模式继续：{e}"
            );
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        }) = Some(channel);
    }

    /// 绑定 send_message 子代理注入通道（CoreRunState 实现）
    pub(crate) fn bind_inject(&self, channel: Arc<dyn SubagentInjectChannel>) {
        *self.inject.lock().unwrap_or_else(|e| {
            // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
            tracing::error!(
                target: "engine",
                "ContinuityChannelBoard inject 锁中毒，按恢复模式继续：{e}"
            );
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        }) = Some(channel);
    }

    /// 绑定 send_message 主 agent 消息通道（CoreRunState 实现）
    pub(crate) fn bind_self_message(&self, channel: Arc<dyn MainAgentMessageChannel>) {
        *self.self_message.lock().unwrap_or_else(|e| {
            // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
            tracing::error!(
                target: "engine",
                "ContinuityChannelBoard self_message 锁中毒，按恢复模式继续：{e}"
            );
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        }) = Some(channel);
    }

    /// 毒化 control_bus 锁（B1-5 毒化测注入：持锁线程内 panic → 中毒状态；
    /// 对齐 agent-tools test_support::poison_std_lock 形态）
    #[cfg(test)]
    pub(crate) fn poison_control_bus_for_test(&self) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    let _guard = self.control_bus.lock().unwrap();
                    panic!("模拟持锁 panic（毒化 control_bus 锁）");
                });
            });
        }));
    }
}

impl ControlBusResolver for ContinuityChannelBoard {
    fn control_bus(&self, subagent_id: &str) -> Option<Arc<Mutex<ControlBus>>> {
        self.control_bus
            .lock()
            .unwrap_or_else(|e| {
                // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
                tracing::error!(
                    target: "engine",
                    "ContinuityChannelBoard control_bus 锁中毒，按恢复模式继续：{e}"
                );
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .as_ref()
            .and_then(|resolver| resolver.control_bus(subagent_id))
    }
}

#[async_trait::async_trait]
impl SubagentKillChannel for ContinuityChannelBoard {
    async fn kill_subagent(
        &self,
        session_id: &str,
        subagent_id: &str,
        reason: &str,
    ) -> Result<KillSubagentToolResult, String> {
        let Some(channel) = self
            .kill
            .lock()
            .unwrap_or_else(|e| {
                // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
                tracing::error!(
                    target: "engine",
                    "ContinuityChannelBoard kill 锁中毒，按恢复模式继续：{e}"
                );
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .clone()
        else {
            return Err("kill_subagent 通道未绑定（引擎装配与 finalize 之间窗口）".to_string());
        };
        channel.kill_subagent(session_id, subagent_id, reason).await
    }
}

#[async_trait::async_trait]
impl SubagentInjectChannel for ContinuityChannelBoard {
    async fn inject(&self, subagent_id: &str, message: &str) -> Result<(), String> {
        let Some(channel) = self
            .inject
            .lock()
            .unwrap_or_else(|e| {
                // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
                tracing::error!(
                    target: "engine",
                    "ContinuityChannelBoard inject 锁中毒，按恢复模式继续：{e}"
                );
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .clone()
        else {
            return Err(
                "send_message 子代理注入通道未绑定（引擎装配与 finalize 之间窗口）".to_string(),
            );
        };
        channel.inject(subagent_id, message).await
    }
}

#[async_trait::async_trait]
impl MainAgentMessageChannel for ContinuityChannelBoard {
    async fn deliver_self(
        &self,
        session_id: &str,
        message: &str,
        ring: MainMessageRing,
    ) -> Result<String, String> {
        let Some(channel) = self
            .self_message
            .lock()
            .unwrap_or_else(|e| {
                // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
                tracing::error!(
                    target: "engine",
                    "ContinuityChannelBoard self_message 锁中毒，按恢复模式继续：{e}"
                );
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .clone()
        else {
            return Err(
                "send_message 主 agent 消息通道未绑定（引擎装配与 finalize 之间窗口）".to_string(),
            );
        };
        channel.deliver_self(session_id, message, ring).await
    }
}
// ── P4：缓冲事件 drain 转发（30 方案 §4 改动点 2）───────────────────
// 定时器 / cron 事件缓冲（AgentEventSink / SchedEventSink）到真实
// EventBridge 的转发路径：drain 取走缓冲 → 信封直发。R-22：timer/cron
// 事件仅实时轨广播、不落库（本战役定案；完整落库依赖 R-CF3 会话化
// 前置，见 execution/06-RCF3 登记）——信封 runId 注入 timer-<id> /
// cron-<id> 伪 runId（契约对齐，前端按 timerId/cronId 消费），
// sequence 不注入（无 run 序列域）。批 3 装配轮以 500ms tick 周期
// 调用（main.rs drain 任务）——事件从缓冲到真实桥延迟 ≤ 500ms；
// drain 为 Vec::take 语义，空缓冲返回 0，重复调用不重复转发。

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

/// drain 转发公共实现（缓冲事件 → 信封直发；sequence 不注入）
fn forward_drained_events(events: Vec<AgentEvent>, bridge: &EventBridge) -> usize {
    let mut forwarded = 0usize;
    for event in events {
        // R-22：伪 runId 契约对齐（文档-实现漂移修复——conex-types 信封
        // 契约约定「置空串或 timer-<id> / cron-<id> 伪 runId」，此前实现
        // 为 None 导致 wire 缺 runId 键）。timer/cron 事件仅实时轨广播、
        // 不落库（本战役定案）；完整落库依赖会话化前置（R-CF3 登记，
        // 翻转点 = 事件体 sessionId 非空 + 落库通道就绪）。
        // 注：事件体 timer_id/cron_id 已含前缀（timer-<seq>/cron-<seq>），
        // 此处按任务书字面拼接 timer-{id} / cron-{id}（对齐 F6:34 历史
        // 「保持字面登记」先例）；前端按 timerId/cronId 消费，不依赖
        // runId 值，伪 runId 仅契约面占位。
        let run_id = match &event {
            AgentEvent::TimerFired { timer_id, .. }
            | AgentEvent::TimerCancelled { timer_id, .. } => Some(format!("timer-{timer_id}")),
            AgentEvent::CronFired { cron_id, .. } => Some(format!("cron-{cron_id}")),
            _ => None,
        };
        let envelope = AgentEventEnvelope::new(event, run_id, None);
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

/// 事件序列化耗时告警阈值（S3 热点①-事件序列化；毫秒）。
///
/// 单信封 JSON 序列化常态为 µs 级；超 10ms 已属异常（超大载荷 / 设备
/// 负载异常），按阈值条件告警（对齐 EmitReport.dropped 样板：超阈值
/// 才 `tracing::warn!`，常态零日志开销）。
const SLOW_EVENT_SERIALIZE_WARN_MS: u64 = 10;

/// S3 事件序列化慢告警（条件告警：`elapsed >= SLOW_EVENT_SERIALIZE_WARN_MS`
/// 才 warn；对齐 core_event_bridge `EmitReport.dropped → tracing::warn!`
/// 样板——引擎事件面慢序列化热点，只加耗时观测不改运行语义）。
pub(crate) fn warn_slow_event_serialize(run_id: &str, event_type: &str, elapsed: Duration) {
    let elapsed_ms = elapsed.as_millis() as u64;
    if elapsed_ms >= SLOW_EVENT_SERIALIZE_WARN_MS {
        tracing::warn!(
            target: "event_bridge",
            run_id = %run_id,
            event_type = %event_type,
            serialize_ms = elapsed_ms,
            "事件序列化慢于阈值（S3 慢序列化热点）"
        );
    }
}

/// 缓冲事件桥（每 run 一个实例；B6.3 组装层）
///
/// - [Self::emit]：信封 → 序列化 → 按 runId 入缓冲（P9：入队时序列化，
///   丢帧判定只需事件类别；丢帧报告汇入 tracing，S-8）；
/// - [Self::flush]：冲刷本 run 缓冲并发射（顺序保持，载荷直接 emit）。
impl std::fmt::Debug for BufferedRunEventBridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BufferedRunEventBridge")
            .finish_non_exhaustive()
    }
}

pub(crate) struct BufferedRunEventBridge {
    /// 底层事件桥（Tauri 通道）
    bridge: EventBridge,
    /// 按 runId 的背压缓冲（丢帧类目：Delta 可丢、message-end 必达）
    buffer: Mutex<EventBuffer>,
    /// 本桥绑定的 run
    run_id: String,
    /// run 级 trace_id（S2 分布式追踪最小面：装配面注入，emit 层单点
    /// 挂到信封；None = 未装配（定时器/cron 域等无 run 上下文桥））
    trace_id: Option<String>,
}

impl BufferedRunEventBridge {
    /// 新建缓冲事件桥（run 级实例；trace_id 缺省 None，经
    /// [Self::with_trace_id] 注入）
    pub(crate) fn new(bridge: EventBridge, run_id: impl Into<String>) -> Self {
        Self {
            bridge,
            buffer: Mutex::new(EventBuffer::default()),
            run_id: run_id.into(),
            trace_id: None,
        }
    }

    /// 注入 run 级 trace_id（S2：run 装配面调用一次；本桥发射的全部
    /// 信封在 [Self::emit] 统一挂 traceId——drive outcome / approval
    /// 广播 / delta 实时轨 / 审计 sink 单点覆盖）
    ///
    /// **待接线（顺延标注）**：生产注入方 = core_run_commands.rs
    /// `run_task_impl` 装配面（`BufferedRunEventBridge::new(...).with_trace_id(Some(trace_id))`）
    /// 与 `core_get_status` 暴露（CoreStatus.traceId），**依赖 SR-02
    /// （core_run 域切分）并行域收口后接线**（2026-08-14 主控裁决顺延）。
    /// 本桥字段/builder/emit 注入面已就绪，无 trace 配置的桥零开销
    /// （None 分支直通，与接线前行为一致）。
    #[allow(dead_code)]
    pub(crate) fn with_trace_id(mut self, trace_id: Option<String>) -> Self {
        self.trace_id = trace_id;
        self
    }

    /// 入队一条信封（序列化 + 缓冲；不立即发射）
    ///
    /// S2 注入：装配了 trace_id 且信封未显式携带时，克隆信封挂 traceId
    /// 后序列化（信封显式携带者原样透传；克隆仅在注入发生时，无 trace
    /// 配置的桥零开销）。丢帧（Soft 水位优先丢 Delta 旧帧，Critical
    /// 永不丢——buffer.rs:41-58 语义）经 EmitReport 汇入 tracing 计数
    /// （S-8 / PE-04 T04.2-3）。
    ///
    /// S3 埋点（性能热点①-事件序列化）：对序列化段计时，超阈值条件告警
    /// （对齐 EmitReport.dropped 的 `if dropped > 0 { tracing::warn! }`
    /// 样板；消费 B1 计数原语——本处只加耗时面，不重复加计数）。
    pub(crate) fn emit(&self, envelope: &AgentEventEnvelope) -> EmitReport {
        let serialize_started = std::time::Instant::now();
        let payload = match (&self.trace_id, &envelope.trace_id) {
            (Some(trace_id), None) => {
                let injected = envelope.clone().with_trace_id(Some(trace_id.clone()));
                self.bridge.serialize(&injected)
            }
            _ => self.bridge.serialize(envelope),
        };
        let serialize_elapsed = serialize_started.elapsed();
        warn_slow_event_serialize(&self.run_id, envelope.type_name(), serialize_elapsed);
        let Some(payload) = payload else {
            return EmitReport::default();
        };
        let class = drop_class_of(&envelope.event);
        let mut report = EmitReport::default();
        let outcome = match self.buffer.lock() {
            Ok(mut buffer) => buffer.enqueue(&self.run_id, class, payload),
            Err(poisoned) => {
                // B1-5 观测化：缓冲锁中毒恢复，不 panic 且可继续；丢帧语义
                // 不变（EmitReport dropped 统计与下方 tracing::warn 样板不动）
                tracing::error!(
                    target: "engine",
                    "BufferedRunEventBridge buffer 锁中毒，按恢复模式继续（丢帧语义不变）：{poisoned}"
                );
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                poisoned.into_inner().enqueue(&self.run_id, class, payload)
            }
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

    /// 毒化 buffer 锁（B1-5 毒化测注入：持锁线程内 panic → 中毒状态；
    /// 对齐 agent-tools test_support::poison_std_lock 形态）
    #[cfg(test)]
    pub(crate) fn poison_buffer_for_test(&self) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    let _guard = self.buffer.lock().unwrap();
                    panic!("模拟持锁 panic（毒化 buffer 锁）");
                });
            });
        }));
    }
}

// ── BridgeLiveSink：T09.1 / DIM-01 实时双轨桥 ────────────────────────

/// 实时事件通知与增量转发桥（DIM-01 双轨的实时轨：sequence=None 实时发射）
///
/// - 承载 message-delta、TurnStart/TurnEnd、ToolStart/ToolEnd、ApprovalRequested/Resolved；
///   信封由本桥构造，**sequence=None**（不落库、无序列号，立即发射至前端 IPC）；
/// - 背压/丢帧复用缓冲桥的 Delta 类目（delta 可丢、终态必达，03 §5.3-6）；
/// - 无状态（[Send] + [Sync]），run 结束无清理需求。
pub(crate) struct BridgeLiveSink {
    /// 缓冲事件桥（emit + flush）
    bridge: Arc<BufferedRunEventBridge>,
    /// 本 run 标识（信封 runId 注入）
    run_id: String,
}

impl BridgeLiveSink {
    /// 新建实时事件桥（共享 run 级缓冲事件桥）
    pub(crate) fn new(bridge: Arc<BufferedRunEventBridge>, run_id: impl Into<String>) -> Self {
        Self {
            bridge,
            run_id: run_id.into(),
        }
    }
}

impl LiveEventSink for BridgeLiveSink {
    fn push_live(&self, event: AgentEvent) {
        // 信封：{event, runId: Some, sequence: None}（DIM-01 实时轨）
        let envelope = AgentEventEnvelope::new(event, Some(self.run_id.clone()), None);
        self.bridge.emit(&envelope);
        // 实时通道立即发射
        self.bridge.flush();
    }
}

impl DeltaSink for BridgeLiveSink {
    fn push(&self, delta: AgentEvent) {
        self.push_live(delta);
    }
}

#[allow(dead_code)]
pub(crate) type BridgeDeltaSink = BridgeLiveSink;
