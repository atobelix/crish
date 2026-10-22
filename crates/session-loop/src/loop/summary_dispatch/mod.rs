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
//!
//! ## C1c 裁决（抽象纪律审计点 · 详案-C1-核心循环瘦身.md C1c 段 / 00-核心逻辑模型草案.md §7）
//!
//! **SummaryRetryTracker 缝面：登记，不封装 struct。** 摘要待重试跟踪 =
//! 待重试快照（`PendingSummaryRetry`，定义于 compaction_dispatch.rs，随
//! 后台任务同一入参源记录）+ 被动触发判定（`maybe_retry_pending_summary`，
//! 用户消息边界消费；判定「对话中仍存在该块 stub 消息」为待重试）——
//! 当前为**唯一实现**，生命周期语义与 [SummaryDispatch] 对齐（run 起始
//! 不复位，跨 run 待重试延续，与 summary_coordinator 任务存活语义一致）。
//! 按接口两实现法则，**登记缝面形态、具体类型直连**：快照 + 触发在
//! 压缩触发侧（compaction_dispatch.rs）同文件高内聚，封装为 struct 属
//! 纯搬运（行数/字段零收益、触发点调用面变宽）；未来出现第二个生命周期/
//! 实现（如会话级重试注册表）时再封装为 `SummaryRetryTracker`。

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

mod config;
mod dispatch;
mod retry_gate;
mod run;

pub use config::{SummaryDispatchConfig, SummaryRetryGuardConfig};
pub(crate) use dispatch::emit_summary_background;
pub use dispatch::{
    SummaryBackgroundSink, SummaryBackgroundSinkRef, SummaryDispatch, SummaryDispatchOutcome,
    SummaryDispatchTask, SummaryOutcomeCallback,
};
pub use retry_gate::SummaryRetryGate;
pub(crate) use run::{run_summary_task, summarize_via_blocking, summarize_via_blocking_with_abort};

#[cfg(test)]
mod tests;
