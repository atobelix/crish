//! 摘要后台调度器（T-33；00-plan §6.4 R-F 异步面 / §10 轮次 4）
//!
//! 职责（触发侧在 handlers/mod.rs `apply_compaction`，T-32）：压缩产出
//! stub（同步 Summarizer 尝试失败 / 输出非 Schema V1 JSON）且 Summarizer
//! 注入存在时，在 run 内 spawn 一个后台任务：指数退避 1s/3s/9s
//! （±20% jitter）重试摘要，单次调用墙钟 [LOOP_SUMMARY_MAX_WALL_MS]
//! （≈60s）；成功 → 经注入回调上报结果（summary_json + 确定性 md 渲染），
//! 单 episode 尝试累计达 [MAX_SUMMARY_ATTEMPTS]（attempts 含同步那次）后
//! **不再 retired 永驻**（E2 F2 层 1 低功耗模式，07-实现方案 §5）：episode
//! 结束上报 awaiting（块保持待重试），停止主动退避，转**被动触发**——
//! 用户消息边界（F3）/ 新 run 装配 / 下一次压缩触发经
//! coordinator.try_trigger 重新触发；跨 episode 的累计成本由
//! [SummaryRetryGate] 护栏约束（窗口内累计尝试上限
//! [SummaryRetryGuardConfig]，默认 8 次 / 30 分钟窗口，窗口过期重置计数）。
//!
//! ## 架构决策（V1 降级登记，00-plan §6.5 / 评审 02 P0-2 / P1-10）
//!
//! 1. **run 内单飞**：本文件以 `Mutex<Option<JoinHandle>>` 实现任务级
//!    单飞——存活任务存在时新 spawn 被忽略（去重），任务完成后可再
//!    spawn（同 run 二次压缩仍可续试）。状态挂 LoopState（run 级）；
//!    **跨 run 的会话级单飞与任务存活由轮次 6 壳层容器（CoreRunState，
//!    与 SessionHistoryCache 同生命周期）承接**——本层任务只借用
//!    Summarizer Arc + 数据 + 回调，不绑定 LoopState 生命周期，run 收口
//!    不摧毁任务（tokio::spawn 独立任务，R-I 语义对齐）。同实例跨 run
//!    复用（测试续接路径）时，存活任务句柄天然阻塞新 spawn——会话级
//!    单飞语义在 loop 实例生命周期内成立。
//! 2. **表写入路径**：session-loop 生产代码不依赖 conex-db（叶子纪律，
//!    评审 02 §6.1）。compression_blocks 表的推进（summary_json /
//!    state=committed / height / attempts）由壳层经注入回调完成——V1 未
//!    接线回调时只落日志（tracing::info/warn），结果随
//!    [SummaryDispatchOutcome] 完整透传（块 id / 代数 / 状态 / attempts），
//!    轮次 6 对接写库（orchestrator persist + SessionContextMeta 单源）。
//! 3. **墙钟上限**：单次调用包 tokio::time::timeout 上限
//!    [LOOP_SUMMARY_MAX_WALL_MS]；超时按失败计数（阻塞调用经
//!    spawn_blocking 承接，不阻塞主循环 worker——Summarizer 为 Sync trait
//!    调用面，并发重入由实现方保证；RetryGuardSummarizer 内部互斥天然
//!    串行）。timeout 后旧阻塞线程可能仍在运行（无法强杀），其返回被
//!    丢弃，不再作为本尝试结果。
//! 4. **临界线不 spawn**：仅 Regular（预检）/ Overflow（溢出）触发
//!    （apply_compaction 单点广播）；临界线硬压缩（旧 Message 面）不经过
//!    本层。无 Summarizer 注入 → 不 spawn（纯 stub awaiting 永驻，
//!    00-plan §6.4「无注入不 spawn」）。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use conex_compaction::summary_document::{summary_to_markdown, validate_summary_document};
use conex_compaction::{recovery::SummaryState, Summarizer};
use conex_types::message::AgentMessage;

/// 单次摘要调用墙钟上限（毫秒；04 §5.2 / 评审 02 P1-10 对齐 ~60s 预算）
pub const LOOP_SUMMARY_MAX_WALL_MS: u64 = 60_000;
/// 退避序列（毫秒；00-plan §6.4 / 04 §5.2 用户定 1s/3s/9s）
pub const SUMMARY_BACKOFF_MS: [u64; 3] = [1_000, 3_000, 9_000];
/// 默认退避 jitter 幅度（±20%，防多会话同频，00-plan §6.4）
pub const SUMMARY_JITTER_RATIO: f64 = 0.2;
/// 单 episode 主动退避尝试上限（**含同步那次**；00-plan §6.4：默认 4 =
/// 同步 1 + 退避重试 3）。**不是「退休阈值」**——E2 F2 层 1 已废除 retired
/// 永驻语义：episode 耗尽后块保持 awaiting（低功耗待重试），跨 episode
/// 的累计成本由 [SummaryRetryGuardConfig]（默认 8 / 窗口 30min）约束。
pub const MAX_SUMMARY_ATTEMPTS: u32 = 4;

// ── T-44 session_meta 可配键（04 §9.4 T17 / 00-plan §10 轮次 6）─────────

/// session_meta 键：摘要退避基数（毫秒；JSON 数组或单个数值，缺省
/// [SUMMARY_BACKOFF_MS]——04 §5.2「compact_summary_backoff_ms JSON 数组，
/// 默认 [1000,3000,9000]」）
pub const META_KEY_SUMMARY_BACKOFF_MS: &str = "compact_summary_backoff_ms";
/// session_meta 键：L1 占位符回退开关（true=旧 L1 占位符语义；false=新
/// 中性 stub）。**V1 决策（启动级配置）**：引擎侧（轮次 1）已删 AgentMessage
/// 面 L1 改 stub（R-E），运行时双态切换需引擎支持（conex-compaction 面）；
/// V1 本键只读取+文档化、不改变行为——读取面由 [summary_l1_placeholder]
/// 提供，引擎侧动态双态预留给 V2。
pub const META_KEY_SUMMARY_L1_PLACEHOLDER: &str = "compact_l1_placeholder";
/// session_meta 键：单次摘要调用墙钟上限（毫秒，缺省 [LOOP_SUMMARY_MAX_WALL_MS]；
/// 评审 02 P1-10：单次调用墙钟 60s 预算）
pub const META_KEY_SUMMARY_WALL_MS: &str = "compact_summary_wall_ms";
/// session_meta 键：窗口内累计尝试护栏（E2 F2 层 1 / 07 §5.2，缺省
/// [DEFAULT_RETRY_GUARD_MAX_ATTEMPTS]）。**别名统一两域口径**（审计 02
/// S2 双真源风险）：键字符串与 conex-compaction RetryGuardSummarizer 域
/// （ai_summary.rs:466）共用同一常量，防两域漂移；两域语义区分——
/// RetryGuardSummarizer 的 max_attempts（<500 字符退化重试 3 次）与本层
/// 窗口累计护栏互不覆盖。
pub const META_KEY_SUMMARY_MAX_ATTEMPTS: &str =
    conex_compaction::ai_summary::SESSION_META_KEY_COMPACT_SUMMARY_MAX_ATTEMPTS;
/// session_meta 键：低功耗观察窗口（E2 F2 层 1 / 07 §5.2，缺省
/// [DEFAULT_RETRY_GUARD_WINDOW_MS]）：窗口内 0 次被动触发 → 尝试计数重置。
pub const META_KEY_SUMMARY_RETRY_WINDOW_MS: &str = "compact_summary_retry_window_ms";
/// 窗口内累计尝试护栏默认（E2 §3.1 层 1 / 07 §5.2：`compact_summary_max_attempts`
/// 默认 8，防无界成本）
pub const DEFAULT_RETRY_GUARD_MAX_ATTEMPTS: u32 = 8;
/// 低功耗观察窗口默认（E2 §3.1 层 1 / 07 §5.2：`compact_summary_retry_window_ms`
/// 默认 30 分钟 = 1_800_000ms）
pub const DEFAULT_RETRY_GUARD_WINDOW_MS: u64 = 1_800_000;

/// 解析 session_meta 键值 → [SummaryDispatchConfig]（T-44 配置读取 helper；
/// 缺省值兜底——键缺失 / 解析失败均回退生产缺省并 warn，不 panic）。
///
/// `meta`：键 → 值读取面（壳层经 `LocalDb::get_session_meta` 注入；
/// 测试注入内存表）。`backoff_ms` 值接受：
/// - JSON 数组（`[1000,3000,9000]`）→ 逐项取整（非法项丢弃，空数组回退）；
/// - 单个数值（退避基数）→ 退化为单元素序列；
/// - 其余形态 → 回退 [SUMMARY_BACKOFF_MS]。
impl SummaryDispatchConfig {
    pub fn from_session_meta(
        meta: impl Fn(&str) -> Option<String>,
        max_attempts: u32,
    ) -> Self {
        let backoff_ms = meta(META_KEY_SUMMARY_BACKOFF_MS)
            .as_deref()
            .and_then(parse_backoff_ms)
            .unwrap_or_else(|| {
                tracing::warn!(
                    key = META_KEY_SUMMARY_BACKOFF_MS,
                    "退避配置缺失/非法 → 缺省 [1000,3000,9000]"
                );
                SUMMARY_BACKOFF_MS.to_vec()
            });
        let max_wall_ms = meta(META_KEY_SUMMARY_WALL_MS)
            .as_deref()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or_else(|| {
                tracing::warn!(
                    key = META_KEY_SUMMARY_WALL_MS,
                    default = LOOP_SUMMARY_MAX_WALL_MS,
                    "墙钟配置缺失/非法 → 缺省 60000ms"
                );
                LOOP_SUMMARY_MAX_WALL_MS
            });
        Self {
            backoff_ms,
            jitter: SUMMARY_JITTER_RATIO,
            max_wall_ms,
            max_attempts,
        }
    }
}

/// 解析退避序列值（JSON 数组 / 单个数值；非法返回 None 触发缺省兜底）
fn parse_backoff_ms(raw: &str) -> Option<Vec<u64>> {
    let trimmed = raw.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        match value {
            serde_json::Value::Array(items) => {
                let parsed: Vec<u64> = items
                    .into_iter()
                    .filter_map(|item| item.as_u64().filter(|v| *v > 0))
                    .collect();
                if parsed.is_empty() { None } else { Some(parsed) }
            }
            serde_json::Value::Number(n) => n.as_u64().filter(|v| *v > 0).map(|v| vec![v]),
            _ => None,
        }
    } else if let Ok(v) = trimmed.parse::<u64>() {
        if v > 0 { Some(vec![v]) } else { None }
    } else {
        None
    }
}

/// 读取 L1 占位符回退开关（T-44；true=旧 L1 语义 / false=新 stub）。
/// **V1 决策**：启动级配置——壳层 run 装配时读一次决定路径；引擎侧
/// （conex-compaction）已删 AgentMessage 面 L1（R-E），运行时双态切换
/// 需引擎支持，V1 不接线（只文档化读取面），预留给 V2。
pub fn summary_l1_placeholder(meta: impl Fn(&str) -> Option<String>) -> bool {
    matches!(meta(META_KEY_SUMMARY_L1_PLACEHOLDER).as_deref(), Some("true" | "1"))
}

/// 摘要任务完成结果（V1 经回调透传给壳层；轮次 6 落 compression_blocks 表）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryDispatchOutcome {
    /// 会话 id（块表复合主键 (session_id, block_id) 的一半）
    pub session_id: String,
    /// 块 id（R-B：`compacted-summary-{gen}-{fold}`，与链内消息 id 同名）
    pub block_id: String,
    /// 压缩代数（R-K 单源：SessionContextMeta.last_compaction_generation）
    pub generation: u32,
    /// 成功：Schema V1 JSON 规范文档（写表 summary_json）
    pub summary_json: Option<String>,
    /// 成功：确定性 md 渲染（链文本形态，R-G 语源与文档同源）
    pub rendered_markdown: Option<String>,
    /// 终态：committed（成功）| awaiting（episode 耗尽，低功耗待重试——
    /// **非 retired 永驻**，E2 F2 层 1；块保持 awaiting，被动触发点重新
    /// 触发，窗口护栏 [SummaryRetryGate] 约束累计成本）
    pub state: SummaryState,
    /// 累计尝试次数（含同步那次；00-plan §6.4 口径）
    pub attempts: u32,
}

/// 后台任务上下文（tokio::spawn 独占；不引用 LoopState，run 收口不摧毁）
pub struct SummaryDispatchTask {
    /// 会话 id（回调上报用）
    pub session_id: String,
    /// 块 id（R-B）
    pub block_id: String,
    /// 压缩代数（R-K 单源）
    pub generation: u32,
    /// 丢弃消息（与同步尝试同源——调度器失败后重试同一批）
    pub dropped: Vec<AgentMessage>,
    /// 既有摘要文本（链尾 stub / md 渲染；与同步尝试同源）
    pub existing: Option<String>,
    /// 摘要字节预算（max_summary_tokens × 4，对齐引擎字节预算口径）
    pub max_bytes: usize,
    /// 摘要器（Arc 共享；调用隔离由 trait 边界保证，I4）
    pub summarizer: Arc<dyn Summarizer>,
}

/// 摘要调度器配置（可注入测试参数；生产缺省见 [Default]）。
/// 注：jitter 为 f64，不派生 Eq（浮点无 Eq 语义），比较以 PartialEq 为准。
#[derive(Debug, Clone, PartialEq)]
pub struct SummaryDispatchConfig {
    /// 退避序列（毫秒；测试注入快速序列 + jitter=0.0 得确定性序列）
    pub backoff_ms: Vec<u64>,
    /// jitter 幅度（0.0 ~ 0.2；0.0 = 确定性退避，测试断言用）
    pub jitter: f64,
    /// 单次调用墙钟上限（毫秒）
    pub max_wall_ms: u64,
    /// 累计尝试上限（含同步那次；默认 [MAX_SUMMARY_ATTEMPTS]）
    pub max_attempts: u32,
}

impl Default for SummaryDispatchConfig {
    fn default() -> Self {
        Self {
            backoff_ms: SUMMARY_BACKOFF_MS.to_vec(),
            jitter: SUMMARY_JITTER_RATIO,
            max_wall_ms: LOOP_SUMMARY_MAX_WALL_MS,
            max_attempts: MAX_SUMMARY_ATTEMPTS,
        }
    }
}

// ── E2 F2 层 1 低功耗模式：跨 episode 累计尝试护栏（07 §5.1/§5.2）───────

/// 低功耗护栏配置（E2 F2 层 1 两新键：`compact_summary_max_attempts` 默认 8
/// + `compact_summary_retry_window_ms` 默认 30min）。
///
/// 与 [SummaryDispatchConfig] 的区分：后者是**单 episode** 的主动退避参数
/// （backoff / 墙钟 / max_attempts=4）；本结构是**跨 episode** 的累计成本
/// 护栏——废除 retired 永驻后，被动触发（用户消息边界 F3 / 新 run / 下一
/// 次压缩）可反复重新触发摘要，累计尝试次数须有窗口护栏防无界成本。
///
/// 壳层装配：`SessionLoopOptions::compact_summary_max_attempts` /
/// `compact_summary_retry_window_ms` 字段（loop/mod.rs），经
/// [SummaryDispatch::set_retry_guard] 接线 run 级调度器；session_meta
/// 读取由 [SummaryRetryGuardConfig::from_session_meta] 提供（壳层经
/// session_meta 装配由后续批次接线，本结构为读取 helper）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SummaryRetryGuardConfig {
    /// 窗口内累计尝试上限（含同步那次；0 = 禁用摘要重试——窗口护栏拒绝
    /// 一切触发，防无界成本）
    pub max_attempts: u32,
    /// 低功耗观察窗口（毫秒）：窗口过期后尝试计数重置（窗口内 0 次被动
    /// 触发则重置计数），之后可再试
    pub retry_window_ms: u64,
}

impl Default for SummaryRetryGuardConfig {
    fn default() -> Self {
        Self {
            max_attempts: DEFAULT_RETRY_GUARD_MAX_ATTEMPTS,
            retry_window_ms: DEFAULT_RETRY_GUARD_WINDOW_MS,
        }
    }
}

impl SummaryRetryGuardConfig {
    /// 解析 session_meta 键值 → 低功耗护栏配置（T-44 配置读取 helper；
    /// 键缺失 / 解析失败均回退缺省并 warn，不 panic）。
    ///
    /// 消费键：`compact_summary_max_attempts`（u32 > 0）、
    /// `compact_summary_retry_window_ms`（u64 > 0）。
    pub fn from_session_meta(meta: impl Fn(&str) -> Option<String>) -> Self {
        let max_attempts = meta(META_KEY_SUMMARY_MAX_ATTEMPTS)
            .as_deref()
            .and_then(|raw| raw.trim().parse::<u32>().ok())
            .filter(|v| *v > 0)
            .unwrap_or_else(|| {
                tracing::warn!(
                    key = META_KEY_SUMMARY_MAX_ATTEMPTS,
                    default = DEFAULT_RETRY_GUARD_MAX_ATTEMPTS,
                    "护栏尝试上限配置缺失/非法 → 缺省 8"
                );
                DEFAULT_RETRY_GUARD_MAX_ATTEMPTS
            });
        let retry_window_ms = meta(META_KEY_SUMMARY_RETRY_WINDOW_MS)
            .as_deref()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or_else(|| {
                tracing::warn!(
                    key = META_KEY_SUMMARY_RETRY_WINDOW_MS,
                    default = DEFAULT_RETRY_GUARD_WINDOW_MS,
                    "观察窗口配置缺失/非法 → 缺省 1800000ms"
                );
                DEFAULT_RETRY_GUARD_WINDOW_MS
            });
        Self {
            max_attempts,
            retry_window_ms,
        }
    }
}

/// 低功耗尝试护栏状态机（E2 F2 层 1 / 07 §5.1）：跨 episode 累计尝试次数，
/// 窗口内达上限后拒绝新触发（停止重试）；窗口过期自动重置（窗口内 0 次
/// 被动触发 → 计数重置），之后可再试。
///
/// 语义与既有护栏正交（防死循环面）：
/// - 单飞（run 级 [SummaryDispatch::task] / 会话级 coordinator 句柄）防
///   同会话并发重复任务；
/// - 全局并发 ≤2（summary_coordinator.rs）防多会话打爆 provider；
/// - 压缩层溢出重试上限 2（stream_error.rs `compact_overflow_retries`）
///   防「压缩→仍超→再压缩」死循环——本护栏防「摘要失败→无限被动触发」
///   循环，两者互不消耗对方计数。
///
/// 时间注入面：`now_ms` 由调用方提供（生产 [crate::steering::unix_millis]），
/// 测试注入假时钟驱动窗口过期断言，零真实等待。
pub struct SummaryRetryGate {
    config: SummaryRetryGuardConfig,
    /// 当前窗口内累计尝试次数（含同步那次口径，与 episode attempts 同源）
    attempts_in_window: u32,
    /// 当前窗口起点（epoch ms；None = 窗口尚未开始）。用 Option 而非 0
    /// 哨兵——epoch 0 是合法时刻（测试假时钟从 0 起步），0 哨兵会误判
    /// 「未开始」导致窗口起点滑动错误
    window_started_at_ms: Option<u64>,
}

impl SummaryRetryGate {
    /// 新建护栏（config 装配时定；state 从零开始，窗口未开始 = None）
    pub fn new(config: SummaryRetryGuardConfig) -> Self {
        Self {
            config,
            attempts_in_window: 0,
            window_started_at_ms: None,
        }
    }

    /// 窗口过期检查：窗口已开始（Some）且自窗口起点流逝 ≥
    /// [SummaryRetryGuardConfig::retry_window_ms] → 重置计数与窗口起点
    /// （窗口内 0 次被动触发 → 计数重置语义）
    fn reset_if_window_expired(&mut self, now_ms: u64) {
        if let Some(started_at) = self.window_started_at_ms {
            if now_ms.saturating_sub(started_at) >= self.config.retry_window_ms {
                tracing::debug!(
                    attempts_in_window = self.attempts_in_window,
                    window_ms = self.config.retry_window_ms,
                    "低功耗观察窗口过期 → 尝试计数重置（可再试）"
                );
                self.attempts_in_window = 0;
                self.window_started_at_ms = None;
            }
        }
    }

    /// episode 开始检查：窗口过期先重置，随后窗口内累计尝试 < 上限 → 放行
    /// （返回 true）；达上限 → 拒绝本次触发（返回 false，不记账）。
    ///
    /// `max_attempts = 0`（配置为禁用重试）时恒拒绝。
    pub fn try_begin_episode(&mut self, now_ms: u64) -> bool {
        self.reset_if_window_expired(now_ms);
        self.attempts_in_window < self.config.max_attempts
    }

    /// episode 结束记账：把本次 episode 消耗的尝试次数累加进窗口（窗口
    /// 过期先重置；窗口未开始则以此为窗口起点）。
    ///
    /// 被拒绝的 episode（未 spawn）不记账。
    pub fn record_episode(&mut self, attempts_used: u32, now_ms: u64) {
        self.reset_if_window_expired(now_ms);
        if self.window_started_at_ms.is_none() {
            self.window_started_at_ms = Some(now_ms);
        }
        self.attempts_in_window = self.attempts_in_window.saturating_add(attempts_used);
    }

    /// 当前窗口内累计尝试次数（测试 / 观测断言面）
    pub fn attempts_in_window(&self) -> u32 {
        self.attempts_in_window
    }

    /// 护栏配置（测试 / 配置面断言）
    pub fn config(&self) -> SummaryRetryGuardConfig {
        self.config
    }
}

/// 摘要任务完成回调（V1 注入面：壳层 / 轮次 6 对接 compression_blocks
/// 表写入与事件 details 标记；None = 只落日志，stub awaiting 永驻）
pub type SummaryOutcomeCallback = Box<dyn FnOnce(SummaryDispatchOutcome) + Send>;

/// 摘要后台调度器（run 内单飞面；跨 run 会话级容器由轮次 6 壳层承接）
pub struct SummaryDispatch {
    /// 存活任务句柄（单飞去重面；完成后可再 spawn）
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 退避 / 墙钟 / 尝试上限配置
    config: SummaryDispatchConfig,
    /// 低功耗尝试护栏（E2 F2 层 1）：跨 episode 累计尝试 + 观察窗口重置。
    /// Arc<Mutex> 形态——spawn 出的任务在收尾回调里记账（run_summary_task
    /// 是独立任务，需共享句柄）。**生产主路径（会话级 coordinator）的
    /// 护栏接线由壳层批次在 SessionSummaryCoordinator 侧装配**
    /// （summary_coordinator.rs，07 §5.4 文件域；本结构为 run 级兜底面）。
    retry_gate: Arc<Mutex<SummaryRetryGate>>,
}

impl SummaryDispatch {
    pub fn new(config: SummaryDispatchConfig) -> Self {
        Self {
            task: Mutex::new(None),
            config,
            retry_gate: Arc::new(Mutex::new(SummaryRetryGate::new(
                SummaryRetryGuardConfig::default(),
            ))),
        }
    }

    /// 装配低功耗护栏配置（E2 F2 层 1；loop/mod.rs `with_options` 消费
    /// `SessionLoopOptions::compact_summary_max_attempts` /
    /// `compact_summary_retry_window_ms` 两新键注入）。F3 用户消息边界
    /// 被动触发点同样经本方法持有同一护栏实例（run 级面）。
    pub fn set_retry_guard(&self, config: SummaryRetryGuardConfig) {
        *self
            .retry_gate
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = SummaryRetryGate::new(config);
    }

    /// 单飞 spawn：存活任务存在 → 忽略新 spawn（返回 false）；否则启动
    /// 后台任务并登记句柄（返回 true）。调用方负责在 Summarizer 注入
    /// 存在时才构造任务（apply_compaction 只在 `summarizer.is_some()`
    /// 且产出 stub 时调用本方法）。
    ///
    /// E2 F2 层 1 低功耗护栏（顺序：单飞去重 → 窗口护栏）：窗口内累计
    /// 尝试达上限 → 拒绝本次触发（返回 false，不 spawn——护栏日志记录
    /// 通知面，不进对话；窗口过期重置后可再试）。任务收尾时把本次
    /// episode 的尝试次数记入窗口（经 [SummaryRetryGate::record_episode]）。
    ///
    /// `on_done`：完成回调（V1 壳层可经 [SessionLoopOptions] 注入面在
    /// 轮次 6 接线；None = 只落日志）。回调链内先记账后透传。
    pub fn try_spawn(
        &self,
        task: SummaryDispatchTask,
        on_done: Option<SummaryOutcomeCallback>,
    ) -> bool {
        let mut guard = self.task.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(handle) = guard.as_ref() {
            if !handle.is_finished() {
                tracing::debug!(
                    session_id = %task.session_id,
                    block_id = %task.block_id,
                    "摘要后台任务已存活（单飞去重，忽略新 spawn）"
                );
                return false;
            }
        }
        // E2 F2 层 1：窗口护栏——累计尝试达上限 → 拒绝（停止重试，等待
        // 窗口过期重置；被动触发点不阻塞用户消息发送，仅本次补摘要跳过）
        let now_ms = crate::steering::unix_millis() as u64;
        let mut gate = self.retry_gate.lock().unwrap_or_else(|e| e.into_inner());
        if !gate.try_begin_episode(now_ms) {
            tracing::warn!(
                session_id = %task.session_id,
                block_id = %task.block_id,
                attempts_in_window = gate.attempts_in_window(),
                guard_max = gate.config().max_attempts,
                window_ms = gate.config().retry_window_ms,
                "低功耗护栏：窗口内累计尝试已达上限 → 忽略本次摘要触发（等待窗口重置或被动触发点）"
            );
            return false;
        }
        drop(gate);
        let config = self.config.clone();
        // 收尾记账回调：任务完成（无论 committed / awaiting）先记录本次
        // episode 尝试次数进窗口，再透传业务回调（None = 只记账）
        let gate_for_cb = Arc::clone(&self.retry_gate);
        let recorder: SummaryOutcomeCallback = Box::new(move |outcome: SummaryDispatchOutcome| {
            let mut gate = gate_for_cb
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            gate.record_episode(outcome.attempts, crate::steering::unix_millis() as u64);
            drop(gate);
            if let Some(callback) = on_done {
                callback(outcome);
            }
        });
        let handle = tokio::spawn(async move {
            run_summary_task(task, config, Some(recorder)).await;
        });
        *guard = Some(handle);
        true
    }
}

/// 后台任务主体：退避重试摘要（单飞任务内循环）。
///
/// 尝试口径：同步那次已在引擎内完成（attempts 从 1 起算），退避序列
/// 每完成一次重试 attempts += 1；达到 [SummaryDispatchConfig::max_attempts]
/// 或退避序列耗尽停止（默认 4 = 同步 1 + 后台 3）。
///
/// **E2 F2 层 1（低功耗模式）**：episode 耗尽后**不再 retired 永驻**——
/// 结果状态上报 awaiting（块保持待重试），停止主动退避；后续被动触发
/// 点（用户消息边界 F3 / 新 run 装配 / 下一次压缩触发）重新触发摘要，
/// 跨 episode 累计成本由调用方持有的 [SummaryRetryGate] 护栏约束。
///
/// pub(crate)：会话级协调器（summary_coordinator.rs，T-42）复用同一执行体
/// ——run 级与会话级任务共用退避/墙钟/回调语义，行为单一事实源。
pub(crate) async fn run_summary_task(
    task: SummaryDispatchTask,
    config: SummaryDispatchConfig,
    on_done: Option<SummaryOutcomeCallback>,
) {
    let mut attempts: u32 = 1; // 含同步那次
    let mut outcome: Option<SummaryDispatchOutcome> = None;
    for delay_ms in &config.backoff_ms {
        if attempts >= config.max_attempts {
            break;
        }
        // 退避（±jitter；sleep 不阻塞主循环——任务独立于 run）
        let delay = jittered_ms(*delay_ms, config.jitter);
        tokio::time::sleep(Duration::from_millis(delay)).await;
        attempts += 1;
        match summarize_once(&task, config.max_wall_ms).await {
            Ok(json) => {
                // 合法 Schema V1 文档 → committed（R-G：JSON 规范面）；
                // 校验失败按失败尝试继续（不 byte 截断 JSON，保解析）
                match validate_summary_document(&json, task.max_bytes) {
                    Ok(doc) => {
                        outcome = Some(SummaryDispatchOutcome {
                            session_id: task.session_id.clone(),
                            block_id: task.block_id.clone(),
                            generation: task.generation,
                            summary_json: Some(json),
                            rendered_markdown: Some(summary_to_markdown(&doc)),
                            state: SummaryState::Committed,
                            attempts,
                        });
                        break;
                    }
                    Err(err) => {
                        tracing::warn!(
                            block_id = %task.block_id,
                            error = %err,
                            "摘要重试输出非 Schema V1 文档（按失败尝试计数）"
                        );
                    }
                }
            }
            Err(err) => {
                tracing::warn!(
                    block_id = %task.block_id,
                    error = %err,
                    "摘要重试失败（attempts={attempts}）"
                );
            }
        }
    }
    let outcome = match outcome {
        Some(outcome) => outcome,
        // E2 F2 层 1：episode 耗尽 → 低功耗待重试（**不 retired 永驻**）。
        // 块保持 awaiting；attempts 达 [SummaryDispatchConfig::max_attempts]
        // 作为「episode 耗尽」标记——壳层可据此发临时通知事件（E2 §7.2
        // provider-diagnostic phase=summary 投影由后续批次接线），不进对话
        None => SummaryDispatchOutcome {
            session_id: task.session_id,
            block_id: task.block_id,
            generation: task.generation,
            summary_json: None,
            rendered_markdown: None,
            state: SummaryState::Awaiting,
            attempts,
        },
    };
    tracing::info!(
        session_id = %outcome.session_id,
        block_id = %outcome.block_id,
        state = outcome.state.as_str(),
        attempts = outcome.attempts,
        "摘要后台任务结束（结果经回调移交壳层 / 只落日志）"
    );
    if let Some(callback) = on_done {
        callback(outcome);
    }
}

/// 单次摘要调用（墙钟上限内；阻塞调用经 spawn_blocking 承接——trait 为
/// 同步签名，真实实现可能涉及网络往返，不占用主循环 worker）
async fn summarize_once(
    task: &SummaryDispatchTask,
    max_wall_ms: u64,
) -> Result<String, String> {
    let summarizer = task.summarizer.clone();
    let dropped = task.dropped.clone();
    let existing = task.existing.clone();
    let call = tokio::task::spawn_blocking(move || {
        summarizer.summarize(&dropped, existing.as_deref())
    });
    match tokio::time::timeout(Duration::from_millis(max_wall_ms), call).await {
        Ok(Ok(Ok(text))) => Ok(text),
        Ok(Ok(Err(err))) => Err(err),
        Ok(Err(err)) => Err(format!("摘要任务 panic：{err}")),
        Err(_) => Err(format!("摘要调用超时（> {max_wall_ms}ms 墙钟上限）")),
    }
}

/// 退避延迟（±jitter；jitter <= 0.0 时返回 base——确定性序列供测试断言）。
/// 抖动以时间种子生成（无 rand 依赖），幅度钳制在 [0.0, 0.2] 内。
fn jittered_ms(base: u64, jitter: f64) -> u64 {
    if jitter <= 0.0 {
        return base;
    }
    let jitter = jitter.min(0.2);
    let seed = crate::steering::unix_millis();
    // [-1, 1) 伪随机（时间种子低位）
    let spread = ((seed % 2001) as f64 / 2000.0) * 2.0 - 1.0;
    let scaled = base as f64 * (1.0 + spread * jitter);
    scaled.max(1.0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::message::{AgentMessageBlock, AgentMessageRole};

    fn dropped_messages() -> Vec<AgentMessage> {
        vec![AgentMessage {
            id: "m0".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-03T10:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "被丢弃内容".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        }]
    }

    /// 合法 Schema V1 JSON 文档（R-G 新契约示例）
    fn valid_json(block_id: &str) -> String {
        serde_json::json!({
            "schemaVersion": 1,
            "blockId": block_id,
            "generation": 1,
            "droppedIds": [],
            "height": 1,
            "tier": "chunk",
            "goal": "修复构建",
            "constraints": [],
            "progress": ["编译通过"],
            "decisions": [],
            "nextSteps": ["运行测试"],
            "criticalContext": ["cargo build"],
        })
        .to_string()
    }

    fn task_with(
        summarizer: Arc<dyn Summarizer>,
        block_id: &str,
    ) -> SummaryDispatchTask {
        SummaryDispatchTask {
            session_id: "s1".to_string(),
            block_id: block_id.to_string(),
            generation: 1,
            dropped: dropped_messages(),
            existing: None,
            max_bytes: 4096,
            summarizer,
        }
    }

    fn fast_config() -> SummaryDispatchConfig {
        SummaryDispatchConfig {
            backoff_ms: vec![1, 1, 1],
            jitter: 0.0,
            max_wall_ms: 5_000,
            max_attempts: 4,
        }
    }

    /// 记录调用（次数 + 每次入参）+ 可配置返回
    struct RecordingSummarizer {
        calls: std::sync::Mutex<Vec<(Vec<String>, Option<String>)>>,
        result: std::sync::Mutex<Result<String, String>>,
    }
    impl Summarizer for RecordingSummarizer {
        fn summarize(
            &self,
            dropped: &[AgentMessage],
            existing: Option<&str>,
        ) -> Result<String, String> {
            self.calls.lock().unwrap().push((
                dropped.iter().map(|m| m.id.clone()).collect(),
                existing.map(str::to_string),
            ));
            self.result.lock().unwrap().clone()
        }
    }

    /// 单飞：存活任务存在时第二次 spawn 被忽略（去重）
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn single_flight_dedupes_live_task() {
        let summarizer = Arc::new(RecordingSummarizer {
            calls: std::sync::Mutex::new(Vec::new()),
            result: std::sync::Mutex::new(Ok(valid_json("compacted-summary-1-1"))),
        });
        let dispatch = SummaryDispatch::new(fast_config());
        // 首次 spawn 成功
        assert!(dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-1"), None));
        // 立即再 spawn（首任务仍在退避期存活）→ 去重
        assert!(!dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-2"), None));
        // 等待任务结束：只有一次真实调用（第二次 spawn 被忽略）
        tokio::time::sleep(Duration::from_millis(50)).await;
        let calls = summarizer.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1, "单飞去重：同会话存活任务只执行一次");
        assert_eq!(calls[0].0, vec!["m0".to_string()], "摘要器只收到丢弃消息");
    }

    /// 退避序列（注入快速退避 + jitter=0）：失败 ×3 重试后 committed；
    /// attempts 累计含同步那次（1 + 3 = 4）
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retries_with_backoff_then_commits() {
        let summarizer = Arc::new(RecordingSummarizer {
            calls: std::sync::Mutex::new(Vec::new()),
            result: std::sync::Mutex::new(Ok(valid_json("compacted-summary-1-1"))),
        });
        let outcomes = Arc::new(std::sync::Mutex::new(Vec::new()));
        let dispatch = SummaryDispatch::new(fast_config());
        let cb = {
            let outcomes = outcomes.clone();
            Box::new(move |o: SummaryDispatchOutcome| {
                outcomes.lock().unwrap().push(o);
            }) as SummaryOutcomeCallback
        };
        assert!(dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-1"), Some(cb)));
        // 等任务完成（退避 1ms×1 + 调用耗时）
        tokio::time::sleep(Duration::from_millis(200)).await;
        let done = outcomes.lock().unwrap().clone();
        assert_eq!(done.len(), 1, "回调必须恰好收到一次结果");
        let outcome = &done[0];
        assert_eq!(outcome.state, SummaryState::Committed);
        assert_eq!(outcome.attempts, 2, "首次重试即成功：attempts = 同步1 + 后台1");
        assert_eq!(outcome.block_id, "compacted-summary-1-1");
        // 渲染 = 确定性 md 投影（R-G 语源）
        let markdown = outcome.rendered_markdown.as_deref().expect("必须有 md 渲染");
        assert!(markdown.contains("修复构建"), "md 渲染含 goal 文本");
        let json = outcome.summary_json.as_deref().expect("必须有 JSON 规范文档");
        assert!(validate_summary_document(json, 4096).is_ok(), "回调 JSON 必须合法");
    }

    /// E2 F2 层 1（低功耗模式）：episode 耗尽（attempts = 4 = 同步 1 +
    /// 后台 3）后**不 retired**——块保持 awaiting（待重试）；随后被动触发
    /// 重新 spawn（同调度器，护栏窗口内放行）→ 摘要成功升级 committed。
    /// 对应设计测试 5.3.1「第 5 次尝试后不 retired，块保持 awaiting，
    /// 等待被动触发；触发后摘要成功升级 committed」
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retries_exhausted_awaits_then_passive_retry_commits() {
        let summarizer = Arc::new(RecordingSummarizer {
            calls: std::sync::Mutex::new(Vec::new()),
            result: std::sync::Mutex::new(Err("摘要器持续失败".to_string())),
        });
        let outcomes = Arc::new(std::sync::Mutex::new(Vec::new()));
        let dispatch = SummaryDispatch::new(fast_config());
        let cb = {
            let outcomes = outcomes.clone();
            Box::new(move |o: SummaryDispatchOutcome| {
                outcomes.lock().unwrap().push(o);
            }) as SummaryOutcomeCallback
        };
        // 第一段：episode 1 全部失败 → 耗尽待重试（不 retired）
        assert!(dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-1"), Some(cb)));
        tokio::time::sleep(Duration::from_millis(300)).await;
        let done = outcomes.lock().unwrap().clone();
        assert_eq!(done.len(), 1);
        assert_eq!(
            done[0].state,
            SummaryState::Awaiting,
            "episode 耗尽不 retired：块保持 awaiting（低功耗待重试，非永驻）"
        );
        assert_eq!(done[0].attempts, 4, "episode 耗尽：attempts = 同步1 + 退避重试3");
        assert_eq!(done[0].summary_json, None);
        let calls = summarizer.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 3, "后台只重试 3 次（上限 4 含同步）");
        // 第二段：被动触发（窗口内累计 4 < 默认护栏 8 → 放行）→ 成功。
        // 回调必须再次注入（FnOnce 不能复用，另建同源收集器）——否则第二
        // 段 outcome 只在护栏记账、不进 outcomes，断言收不到第二个结果
        *summarizer.result.lock().unwrap() = Ok(valid_json("compacted-summary-1-1"));
        let cb2 = {
            let outcomes = outcomes.clone();
            Box::new(move |o: SummaryDispatchOutcome| {
                outcomes.lock().unwrap().push(o);
            }) as SummaryOutcomeCallback
        };
        assert!(
            dispatch.try_spawn(
                task_with(summarizer.clone(), "compacted-summary-1-1"),
                Some(cb2),
            ),
            "被动触发必须放行（窗口内累计 4 < 8）"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
        let outcomes2 = outcomes.lock().unwrap().clone();
        assert_eq!(outcomes2.len(), 2, "第二段必须再次收到结果");
        assert_eq!(
            outcomes2[1].state,
            SummaryState::Committed,
            "被动触发后摘要成功升级 committed"
        );
        assert!(outcomes2[1].summary_json.is_some());
    }

    /// 非 JSON 输出 → 按失败尝试计数（R-G 新契约：输出必须合法 Schema V1）
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn invalid_json_output_counts_as_failed_attempt() {
        let summarizer = Arc::new(RecordingSummarizer {
            calls: std::sync::Mutex::new(Vec::new()),
            result: std::sync::Mutex::new(Ok("## Goal\n(none)".to_string())),
        });
        let outcomes = Arc::new(std::sync::Mutex::new(Vec::new()));
        let dispatch = SummaryDispatch::new(fast_config());
        let cb = {
            let outcomes = outcomes.clone();
            Box::new(move |o: SummaryDispatchOutcome| {
                outcomes.lock().unwrap().push(o);
            }) as SummaryOutcomeCallback
        };
        assert!(dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-1"), Some(cb)));
        tokio::time::sleep(Duration::from_millis(300)).await;
        let done = outcomes.lock().unwrap().clone();
        assert_eq!(done.len(), 1);
        assert_eq!(
            done[0].state,
            SummaryState::Awaiting,
            "非 JSON 输出全部按失败计数 → episode 耗尽待重试（不 retired）"
        );
        assert_eq!(done[0].attempts, 4);
    }

    /// 墙钟上限：调用挂起超过 max_wall_ms → 按失败尝试计数
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wall_clock_cap_times_out_hung_call() {
        struct HungSummarizer;
        impl Summarizer for HungSummarizer {
            fn summarize(
                &self,
                _dropped: &[AgentMessage],
                _existing: Option<&str>,
            ) -> Result<String, String> {
                std::thread::sleep(Duration::from_millis(2_000));
                Ok(valid_json("compacted-summary-1-1"))
            }
        }
        let outcomes = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut config = fast_config();
        config.max_wall_ms = 50; // 注入短墙钟：调用必然超时
        let dispatch = SummaryDispatch::new(config);
        let cb = {
            let outcomes = outcomes.clone();
            Box::new(move |o: SummaryDispatchOutcome| {
                outcomes.lock().unwrap().push(o);
            }) as SummaryOutcomeCallback
        };
        assert!(dispatch.try_spawn(
            task_with(Arc::new(HungSummarizer), "compacted-summary-1-1"),
            Some(cb),
        ));
        tokio::time::sleep(Duration::from_millis(400)).await;
        let done = outcomes.lock().unwrap().clone();
        assert_eq!(done.len(), 1);
        assert_eq!(
            done[0].state,
            SummaryState::Awaiting,
            "超时按失败计数 → episode 耗尽待重试（不 retired）"
        );
        assert_eq!(done[0].attempts, 4);
    }

    /// attempts 计数器语义：累计含同步那次（引擎内已尝试 1 次）
    #[test]
    fn attempts_includes_sync_attempt() {
        let config = fast_config();
        assert_eq!(config.max_attempts, 4);
        // 退避序列 3 项 = 后台至多 3 次重试 → 累计 1 + 3 = 4
        assert_eq!(config.backoff_ms.len(), 3);
        assert_eq!(config.max_attempts, config.backoff_ms.len() as u32 + 1);
    }

    /// jitter=0.0 → 确定性退避（同 base 同输出）
    #[test]
    fn jitter_zero_is_deterministic() {
        assert_eq!(jittered_ms(100, 0.0), 100);
        assert_eq!(jittered_ms(100, 0.0), 100);
        // 有 jitter 时结果在 [base×0.8, base×1.2] 内
        let jittered = jittered_ms(100, 0.2);
        assert!((80..=120).contains(&jittered), "jitter 幅度钳制 ±20%：{jittered}");
    }

    /// 单飞状态恢复：任务完成后可再 spawn（同 run 二次压缩续试）
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn single_flight_releases_after_completion() {
        let summarizer = Arc::new(RecordingSummarizer {
            calls: std::sync::Mutex::new(Vec::new()),
            result: std::sync::Mutex::new(Ok(valid_json("compacted-summary-1-1"))),
        });
        let dispatch = SummaryDispatch::new(fast_config());
        assert!(dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-1"), None));
        tokio::time::sleep(Duration::from_millis(150)).await;
        // 首任务已完成 → 新 spawn 放行
        assert!(dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-2"), None));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let calls = summarizer.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 2, "完成后单飞释放：第二次压缩可续试");
    }

    // ── T-44 session_meta 配置面 ─────────────────────────────────────

    fn meta_map<'a>(entries: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key: &str| {
            entries
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
        }
    }

    /// 缺省兜底：无键 → 生产缺省（退避 [1000,3000,9000]、墙钟 60000、
    /// jitter 0.2、attempts 上限）
    #[test]
    fn from_session_meta_defaults_on_missing_keys() {
        let config = SummaryDispatchConfig::from_session_meta(meta_map(&[]), MAX_SUMMARY_ATTEMPTS);
        assert_eq!(config.backoff_ms, SUMMARY_BACKOFF_MS.to_vec());
        assert_eq!(config.max_wall_ms, LOOP_SUMMARY_MAX_WALL_MS);
        assert!((config.jitter - SUMMARY_JITTER_RATIO).abs() < 1e-9);
        assert_eq!(config.max_attempts, MAX_SUMMARY_ATTEMPTS);
    }

    /// 自定义值：JSON 数组退避 + 自定义墙钟（T-44 三键中的两个数值键）
    #[test]
    fn from_session_meta_custom_values() {
        let meta = meta_map(&[
            (META_KEY_SUMMARY_BACKOFF_MS, "[2000,5000,15000]"),
            (META_KEY_SUMMARY_WALL_MS, "30000"),
        ]);
        let config = SummaryDispatchConfig::from_session_meta(meta, 5);
        assert_eq!(config.backoff_ms, vec![2000, 5000, 15000]);
        assert_eq!(config.max_wall_ms, 30_000);
        assert_eq!(config.max_attempts, 5, "attempts 上限由调用方注入");
    }

    /// 单个数值退避 → 单元素序列（退避基数语义，任务书 T-44）
    #[test]
    fn from_session_meta_single_backoff_value() {
        let meta = meta_map(&[(META_KEY_SUMMARY_BACKOFF_MS, "2500")]);
        let config = SummaryDispatchConfig::from_session_meta(meta, MAX_SUMMARY_ATTEMPTS);
        assert_eq!(config.backoff_ms, vec![2500]);
    }

    /// 非法值 → 缺省兜底（不 panic；坏条目丢弃 / 空数组回退）
    #[test]
    fn from_session_meta_malformed_falls_back() {
        let meta = meta_map(&[
            (META_KEY_SUMMARY_BACKOFF_MS, "not-a-number"),
            (META_KEY_SUMMARY_WALL_MS, "-1"),
        ]);
        let config = SummaryDispatchConfig::from_session_meta(meta, MAX_SUMMARY_ATTEMPTS);
        assert_eq!(config.backoff_ms, SUMMARY_BACKOFF_MS.to_vec());
        assert_eq!(config.max_wall_ms, LOOP_SUMMARY_MAX_WALL_MS);

        // 数组内非法条目丢弃，合法条目保留
        let meta = meta_map(&[(META_KEY_SUMMARY_BACKOFF_MS, "[1000,0,\"x\",3000]")]);
        let config = SummaryDispatchConfig::from_session_meta(meta, MAX_SUMMARY_ATTEMPTS);
        assert_eq!(config.backoff_ms, vec![1000, 3000]);

        // 空数组 → 回退缺省
        let meta = meta_map(&[(META_KEY_SUMMARY_BACKOFF_MS, "[]")]);
        let config = SummaryDispatchConfig::from_session_meta(meta, MAX_SUMMARY_ATTEMPTS);
        assert_eq!(config.backoff_ms, SUMMARY_BACKOFF_MS.to_vec());
    }

    /// L1 回退开关读取面（V1 启动级配置：只读取不接线，默认新 stub）
    #[test]
    fn l1_placeholder_switch_parses_meta() {
        assert!(!summary_l1_placeholder(meta_map(&[])), "缺省 = 新 stub 语义");
        assert!(!summary_l1_placeholder(meta_map(&[(META_KEY_SUMMARY_L1_PLACEHOLDER, "false")])));
        assert!(summary_l1_placeholder(meta_map(&[(META_KEY_SUMMARY_L1_PLACEHOLDER, "true")])));
        assert!(summary_l1_placeholder(meta_map(&[(META_KEY_SUMMARY_L1_PLACEHOLDER, "1")])));
    }

    // ── E2 F2 层 1 低功耗护栏（窗口累计 + 窗口过期重置）──────────────

    /// 护栏缺省值 = 设计默认（累计 8 次 / 窗口 30min，E2 §3.1 层 1）
    #[test]
    fn retry_guard_defaults_match_plan() {
        let config = SummaryRetryGuardConfig::default();
        assert_eq!(config.max_attempts, 8, "compact_summary_max_attempts 默认 8");
        assert_eq!(config.retry_window_ms, 1_800_000, "compact_summary_retry_window_ms 默认 30min");
        // 与单 episode 上限（4）区分：护栏是跨 episode 累计，不允许相等混淆
        assert_ne!(config.max_attempts, MAX_SUMMARY_ATTEMPTS);
    }

    /// 键字符串单源（审计 02 S2 双真源修复）：本层护栏键与 conex-compaction
    /// RetryGuardSummarizer 域共用同一常量，防两域漂移
    #[test]
    fn max_attempts_key_aliases_ai_summary_single_source() {
        assert_eq!(
            META_KEY_SUMMARY_MAX_ATTEMPTS,
            conex_compaction::ai_summary::SESSION_META_KEY_COMPACT_SUMMARY_MAX_ATTEMPTS,
            "compact_summary_max_attempts 键必须与 ai_summary.rs 同一常量（S2 统一口径）"
        );
    }

    /// 窗口护栏状态机：窗口内累计达上限前放行、达上限拒绝、窗口过期重置
    /// 后可再试（对应设计测试 5.3.2「累计尝试 > 8 时停止重试；窗口内 0 次
    /// 被动触发 → 计数重置」；假时钟驱动零真实等待）
    #[test]
    fn retry_gate_allows_until_window_cap_then_resets_after_expiry() {
        let mut gate = SummaryRetryGate::new(SummaryRetryGuardConfig {
            max_attempts: 3,
            retry_window_ms: 1_000,
        });
        // 窗口起点 t=0：episode 1 放行（0 < 3），记账 2 次
        assert!(gate.try_begin_episode(0), "窗口未开始必须放行");
        gate.record_episode(2, 0);
        // t=100（窗口内）：episode 2 放行（2 < 3），记账 1 次 → 累计 3 = 上限
        assert!(gate.try_begin_episode(100), "窗口内未达上限必须放行");
        gate.record_episode(1, 100);
        assert_eq!(gate.attempts_in_window(), 3);
        // t=200（窗口内）：累计 3 >= 3 → 拒绝（停止重试）
        assert!(!gate.try_begin_episode(200), "窗口内达上限必须拒绝新 episode");
        // t=999（窗口内）：仍拒绝
        assert!(!gate.try_begin_episode(999), "窗口过期前持续拒绝");
        // t=1000（窗口过期）：重置计数 → 放行（窗口内 0 次被动触发 → 重置）
        assert!(gate.try_begin_episode(1_000), "窗口过期必须重置后可再试");
        gate.record_episode(1, 1_000);
        assert_eq!(gate.attempts_in_window(), 1, "重置后从零重新累计");
        assert!(gate.try_begin_episode(1_100), "重置后窗口内再次累计");
    }

    /// 窗口过期不依赖触发：record_episode 记账前同样先重置（窗口内 0 次
    /// 被动触发 → 计数重置语义的记账面）
    #[test]
    fn retry_gate_window_expiry_resets_counter_on_record() {
        let mut gate = SummaryRetryGate::new(SummaryRetryGuardConfig {
            max_attempts: 5,
            retry_window_ms: 500,
        });
        gate.record_episode(4, 0);
        assert_eq!(gate.attempts_in_window(), 4);
        // t=600 记账：窗口已过期（600-0 >= 500）→ 先重置再记账
        gate.record_episode(2, 600);
        assert_eq!(gate.attempts_in_window(), 2, "过期窗口的旧计数必须丢弃");
        // 窗口起点随记账滑动到 600：t=1000（400ms 后）仍在窗口内 → 放行
        assert!(gate.try_begin_episode(1_000), "窗口未过期（600+500 > 1000）→ 放行");
        // t=1200（600+500 之后）：窗口过期 → 计数重置（0 < 5）→ 仍放行
        assert!(gate.try_begin_episode(1_200), "窗口过期 → 计数重置后可再试");
        assert_eq!(gate.attempts_in_window(), 0, "窗口过期重置后计数归零");
    }

    /// max_attempts=0（配置为禁用摘要重试）→ 恒拒绝（防无界成本硬闸）
    #[test]
    fn retry_gate_zero_max_blocks_all() {
        let mut gate = SummaryRetryGate::new(SummaryRetryGuardConfig {
            max_attempts: 0,
            retry_window_ms: 60_000,
        });
        assert!(!gate.try_begin_episode(0), "0 = 禁用摘要重试（恒拒绝）");
        assert!(!gate.try_begin_episode(70_000), "窗口过期也不放行（0 上限）");
    }

    /// 调度器集成：窗口护栏拒绝 spawn——episode 1 耗尽（4 次尝试）→ 护栏
    /// 累计 4；护栏上限 2 → 后续 spawn 被拒绝（try_spawn 返回 false，
    /// 不启动任务；「上限耗尽」以 outcome（awaiting + attempts=4）为事件
    /// 载荷经回调移交，临时通知面不进对话）
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn summary_dispatch_denies_spawn_when_window_cap_reached() {
        let summarizer = Arc::new(RecordingSummarizer {
            calls: std::sync::Mutex::new(Vec::new()),
            result: std::sync::Mutex::new(Err("持续失败".to_string())),
        });
        let outcomes = Arc::new(std::sync::Mutex::new(Vec::new()));
        let dispatch = SummaryDispatch::new(fast_config());
        // 护栏上限 2（窗口 60s）：episode 1 的 4 次尝试已超上限 → 后续拒绝
        dispatch.set_retry_guard(SummaryRetryGuardConfig {
            max_attempts: 2,
            retry_window_ms: 60_000,
        });
        let cb = {
            let outcomes = outcomes.clone();
            Box::new(move |o: SummaryDispatchOutcome| {
                outcomes.lock().unwrap().push(o);
            }) as SummaryOutcomeCallback
        };
        assert!(
            dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-1"), Some(cb)),
            "episode 1（累计 0 < 2）必须放行"
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
        let done = outcomes.lock().unwrap().clone();
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].state, SummaryState::Awaiting, "episode 耗尽待重试");
        assert_eq!(done[0].attempts, 4, "episode 尝试 4 次（同步 1 + 后台 3）");
        // 窗口内累计 4 >= 2 → 被动触发被护栏拒绝（不 spawn、不记账）
        assert!(
            !dispatch.try_spawn(task_with(summarizer.clone(), "compacted-summary-1-1"), None),
            "窗口内累计达护栏上限 → 拒绝（停止重试，等待窗口重置）"
        );
        let calls = summarizer.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 3, "被拒绝的触发不得产生任何摘要调用");
    }

    /// 护栏 session_meta 读取面：两新键自定义值（E2 §7.1 /
    /// 07 §5.2「from_session_meta 扩展」测试域）
    #[test]
    fn retry_guard_from_session_meta_custom_values() {
        let meta = meta_map(&[
            (META_KEY_SUMMARY_MAX_ATTEMPTS, "6"),
            (META_KEY_SUMMARY_RETRY_WINDOW_MS, "120000"),
        ]);
        let config = SummaryRetryGuardConfig::from_session_meta(meta);
        assert_eq!(config.max_attempts, 6, "compact_summary_max_attempts 自定义");
        assert_eq!(config.retry_window_ms, 120_000, "compact_summary_retry_window_ms 自定义");
    }

    /// 护栏 session_meta 读取面：键缺失 / 非法 → 缺省兜底（不 panic）
    #[test]
    fn retry_guard_from_session_meta_defaults_on_missing_or_malformed() {
        // 缺省（无键）
        let config = SummaryRetryGuardConfig::from_session_meta(meta_map(&[]));
        assert_eq!(config.max_attempts, DEFAULT_RETRY_GUARD_MAX_ATTEMPTS);
        assert_eq!(config.retry_window_ms, DEFAULT_RETRY_GUARD_WINDOW_MS);
        // 非法值（非数字 / 0）→ 缺省兜底
        let meta = meta_map(&[
            (META_KEY_SUMMARY_MAX_ATTEMPTS, "not-a-number"),
            (META_KEY_SUMMARY_RETRY_WINDOW_MS, "0"),
        ]);
        let config = SummaryRetryGuardConfig::from_session_meta(meta);
        assert_eq!(config.max_attempts, DEFAULT_RETRY_GUARD_MAX_ATTEMPTS);
        assert_eq!(config.retry_window_ms, DEFAULT_RETRY_GUARD_WINDOW_MS);
        // 单键缺失：只提供窗口键 → 尝试上限回缺省
        let meta = meta_map(&[(META_KEY_SUMMARY_RETRY_WINDOW_MS, "90000")]);
        let config = SummaryRetryGuardConfig::from_session_meta(meta);
        assert_eq!(config.max_attempts, DEFAULT_RETRY_GUARD_MAX_ATTEMPTS);
        assert_eq!(config.retry_window_ms, 90_000);
    }
}
