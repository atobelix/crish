//! 会话级摘要任务协调器（T-42；00-plan §6.5 R-I / 评审 02 P0-2）
//!
//! ## 架构决策（V1 落地说明）
//!
//! 1. **挂载点**：协调器类型与注册表定义在 session-loop（与
//!    `summary_dispatch` 同 crate，直接复用任务类型与
//!    [run_summary_task] 执行体）；**注册表实例由壳层 CoreRunState 持有**
//!    （与 SessionHistoryCache 同生命周期——进程级单例，run 收口不摧毁
//!    任务，P0-2「壳层 CoreRunState 或 orchestrator 会话上下文」取前者）。
//!    run 装配时经 [SessionLoopOptions::summary_coordinator] 把会话级
//!    协调器 Arc 注入 LoopState；未注入（测试 / 纯 session-loop 用法）时
//!    回退 run 级 [SummaryDispatch]（轮次 4 语义不变）。
//! 2. **跨 run 单飞**：协调器持 `Mutex<Option<JoinHandle>>`——存活任务
//!    存在时新触发被忽略（去重）；任务句柄不绑定 LoopState / run 生命周期，
//!    Arc 被注册表持有，run 收口后任务继续运行，完成结果经回调移交
//!    （写 compression_blocks 表 + 会话元数据快照 [Self::last_outcome]）。
//! 3. **全局并发上限**（00-plan §6.4 / 风险 9）：进程内
//!    [ACTIVE_SUMMARY_TASKS] 计数，上限 [MAX_CONCURRENT_SUMMARY_TASKS]=2；
//!    超限触发直接忽略（不排队——同一会话触发幂等，后续 run / 后续压缩
//!    会再次触发；±20% jitter 退避防多会话同频）。任务完成（无论
//!    committed / retired）释放计数。
//! 4. **回调写入**：完成回调以会话元数据为目标。V1 经注册表注入
//!    「会话级默认回调」（壳层装配：orchestrator
//!    `update_compression_block_summary` 落库推进两阶段写协议阶段二）；
//!    per-trigger 回调（[SummaryOutcomeCallback]）优先于默认回调。
//!    None = 只落日志（stub awaiting 永驻语义，00-plan §6.4）。
//! 5. **临界线不 spawn / 无注入不 spawn**：与轮次 4 触发侧同语义
//!    （apply_compaction 只产出 stub 且 Summarizer 存在时调用本面）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use super::summary_dispatch::{
    emit_summary_background, run_summary_task, SummaryBackgroundSinkRef, SummaryDispatchConfig,
    SummaryDispatchOutcome, SummaryDispatchTask, SummaryOutcomeCallback,
};

/// 全局并发上限（00-plan §6.4 / 04 §7.1：多会话并发摘要 ≤ 2）
pub const MAX_CONCURRENT_SUMMARY_TASKS: usize = 2;

/// 进程内活跃摘要任务计数（全局信号量；协调器层实现——多会话共享，
/// 防打爆 provider / 混用 RetryGuardSummarizer 内部互斥，00-plan 风险 9）
static ACTIVE_SUMMARY_TASKS: AtomicUsize = AtomicUsize::new(0);

/// 测试隔离：清空全局活跃任务计数。协调器测试共享同一进程级 static
/// 计数（并行测试会互扰——任务完成前的 runtime shutdown 使 fetch_sub
/// 不执行造成泄漏），测试以「全局串行锁 + 开头 reset」保证隔离。
/// 生产路径不调用。
#[cfg(test)]
pub(crate) fn reset_active_summary_tasks_for_test() {
    ACTIVE_SUMMARY_TASKS.store(0, Ordering::SeqCst);
}

/// 会话级摘要任务状态（单飞句柄 + 配置 + 最近结果 + 默认回调）。
///
/// 生命周期 = 会话级（注册表持有 Arc；与 SessionHistoryCache 同生命周期），
/// run 收口 / LoopState drop 不摧毁任务（tokio::spawn 独立任务）。
pub struct SessionSummaryCoordinator {
    /// 会话 id（块表复合主键 (session_id, block_id) 的一半；会话元数据）
    session_id: String,
    /// 存活任务句柄（单飞去重面；任务完成后可再触发）
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 退避 / 墙钟 / 尝试上限配置（T-44 配置面注入；触发时读取）
    config: Mutex<SummaryDispatchConfig>,
    /// 最近一次完成结果（会话元数据快照；供查询 / 审计 / 前端展示挂账）
    last_outcome: Mutex<Option<SummaryDispatchOutcome>>,
    /// summary-background 事件发射器（EV-06 观测面；None = 不发射）
    background_sink: Mutex<Option<SummaryBackgroundSinkRef>>,
    /// 会话级默认完成回调（壳层注入：落 compression_blocks 表；None =
    /// 只落日志）。per-trigger 回调优先于本默认值。
    on_done: Option<Arc<dyn Fn(SummaryDispatchOutcome) + Send + Sync>>,
}

impl SessionSummaryCoordinator {
    /// 新建会话级协调器（config 为触发配置；on_done 为会话级默认回调，
    /// 通常经注册表注入）
    pub fn new(
        session_id: impl Into<String>,
        config: SummaryDispatchConfig,
        on_done: Option<Arc<dyn Fn(SummaryDispatchOutcome) + Send + Sync>>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            task: Mutex::new(None),
            config: Mutex::new(config),
            last_outcome: Mutex::new(None),
            background_sink: Mutex::new(None),
            on_done,
        }
    }

    /// 装配 summary-background 事件发射器（EV-06 观测面；None = 不发射，
    /// 行为与现状一致）。注册表 [SessionSummaryCoordinatorRegistry] 经
    /// [Self::set_background_sink] 在 get_or_create 时透传装配。
    pub fn set_background_sink(&self, sink: Option<SummaryBackgroundSinkRef>) {
        *self
            .background_sink
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = sink;
    }

    /// 会话 id（会话元数据）
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// 最近一次任务完成结果（None = 尚未完成过任务）
    pub fn last_outcome(&self) -> Option<SummaryDispatchOutcome> {
        self.last_outcome
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 当前触发配置（测试 / 配置面断言）
    pub fn config(&self) -> SummaryDispatchConfig {
        self.config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 更新触发配置（注册表 get_or_create 时调用；T-44 配置面）。
    /// 存活任务使用触发时的快照配置，不受更新影响。
    pub fn set_config(&self, config: SummaryDispatchConfig) {
        *self.config.lock().unwrap_or_else(|e| e.into_inner()) = config;
    }

    /// 会话级单飞触发：存活任务存在 → 忽略新触发（返回 false，跨 run
    /// 语义：run 收口后任务仍存活 → 下个 run 同会话触发被去重）；
    /// 无存活 → 检查全局并发上限（≤ [MAX_CONCURRENT_SUMMARY_TASKS]）→
    /// spawn 后台退避重试任务（返回 true）。
    ///
    /// `on_done`：per-trigger 完成回调（优先于会话级默认回调；None =
    /// 走默认回调 / 只落日志）。
    pub fn try_trigger(
        self: &Arc<Self>,
        task: SummaryDispatchTask,
        on_done: Option<SummaryOutcomeCallback>,
    ) -> bool {
        // D-03 EV-06 并行域最小修复（EV-04 观测接线时解除编译阻塞）：spawned
        // 事件在锁块外发射，块 id 需在锁块外声明——原声明在锁块内导致
        // spawn 成功路径编译错误（作用域越界）；仅上移声明，不碰逻辑。
        let spawned_block_id = task.block_id.clone();
        // 会话单飞：存活任务存在 → 去重（幂等触发语义）
        {
            let mut guard = self.task.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(handle) = guard.as_ref() {
                if !handle.is_finished() {
                    tracing::debug!(
                        session_id = %self.session_id,
                        block_id = %task.block_id,
                        "会话级摘要任务已存活（单飞去重，忽略新触发）"
                    );
                    return false;
                }
            }
            // 全局并发上限（00-plan §6.4）：fetch_add 前检查 + 失败回滚
            let active = ACTIVE_SUMMARY_TASKS.fetch_add(1, Ordering::AcqRel);
            if active >= MAX_CONCURRENT_SUMMARY_TASKS {
                ACTIVE_SUMMARY_TASKS.fetch_sub(1, Ordering::AcqRel);
                tracing::warn!(
                    session_id = %self.session_id,
                    block_id = %task.block_id,
                    active = active,
                    limit = MAX_CONCURRENT_SUMMARY_TASKS,
                    "全局摘要并发已达上限 → 忽略本次触发（后续 run 会再次触发）"
                );
                return false;
            }
            let config = self.config();
            // EV-06：事件发射器快照（spawned 在任务启动后发射；其余 phase
            // 由 run_summary_task 内单点发射——两调度面事件口径一致）
            let background = self
                .background_sink
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            // 完成回调解析：per-trigger 优先；否则会话级默认回调。统一包
            // 一层「会话元数据记录器」——outcome 在回调链内先写入
            // [Self::last_outcome]（快照保持最终态）再透传业务回调
            let coordinator = Arc::clone(self);
            let callback: Option<SummaryOutcomeCallback> = match on_done {
                Some(cb) => Some(Box::new(move |outcome: SummaryDispatchOutcome| {
                    coordinator.record_outcome(outcome.clone());
                    cb(outcome);
                }) as SummaryOutcomeCallback),
                None => {
                    let default = self.on_done.as_ref().map(Arc::clone);
                    Some(Box::new(move |outcome: SummaryDispatchOutcome| {
                        coordinator.record_outcome(outcome.clone());
                        if let Some(default) = &default {
                            default(outcome);
                        }
                    }) as SummaryOutcomeCallback)
                }
            };
            let handle = tokio::spawn(async move {
                run_summary_task(task, config, callback, background).await;
                // 任务终态（committed / retired 皆释放全局计数）
                ACTIVE_SUMMARY_TASKS.fetch_sub(1, Ordering::AcqRel);
            });
            *guard = Some(handle);
        }
        // EV-06：spawn 成功 → spawned（attempt=1；任务关联块 id 经
        // messageId 承载）。单飞去重 / 全局并发拒绝不发事件（临时拒绝，
        // 后续 run / 压缩会再次触发——日志已留痕，非「放弃」语义）。
        // 发射在任务锁释放后、先快照 sink 再调用（防外部 sink 重入死锁）
        let background_snapshot = self
            .background_sink
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        emit_summary_background(
            &background_snapshot,
            &self.session_id,
            "spawned",
            1,
            None,
            Some(spawned_block_id),
        );
        true
    }

    /// 写入最近完成结果（任务收尾经默认回调 / per-trigger 回调落库后，
    /// 会话元数据快照保持最终态供查询——测试断言 / 审计 / 前端挂账）
    fn record_outcome(&self, outcome: SummaryDispatchOutcome) {
        *self
            .last_outcome
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(outcome);
    }
}

/// 会话级协调器注册表（壳层 CoreRunState 持有；与 SessionHistoryCache
/// 同生命周期——进程级单例，run 收口不摧毁任务，R-I 语义）
pub struct SessionSummaryCoordinatorRegistry {
    /// session_id → 会话级协调器（get_or_create 幂等）
    sessions: Mutex<HashMap<String, Arc<SessionSummaryCoordinator>>>,
    /// summary-background 事件发射器模板（EV-06；None = 不发射）。
    /// get_or_create 时透传装配到会话协调器。
    background_sink: Mutex<Option<SummaryBackgroundSinkRef>>,
    /// 会话级默认完成回调模板（壳层注入：落 compression_blocks 表；
    /// None = 只落日志）
    on_done: Option<Arc<dyn Fn(SummaryDispatchOutcome) + Send + Sync>>,
}

impl SessionSummaryCoordinatorRegistry {
    /// 新建注册表（on_done：会话级默认完成回调模板；None = 只落日志）
    pub fn new(on_done: Option<Arc<dyn Fn(SummaryDispatchOutcome) + Send + Sync>>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            background_sink: Mutex::new(None),
            on_done,
        }
    }

    /// 装配 summary-background 事件发射器模板（EV-06 观测面；None = 不
    /// 发射）。装配后新建 / 已存在的会话协调器均在触发时透传本模板。
    pub fn set_background_sink(&self, sink: Option<SummaryBackgroundSinkRef>) {
        *self
            .background_sink
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = sink;
    }

    /// 取得（或新建）会话协调器——幂等：同会话返回同一 Arc，跨 run
    /// 单飞状态（存活任务句柄）自然延续；已存在时按最新配置刷新。
    pub fn get_or_create(
        &self,
        session_id: &str,
        config: SummaryDispatchConfig,
    ) -> Arc<SessionSummaryCoordinator> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        // EV-06：发射器模板透传（None = 不发射；装配后刷新已存在协调器）
        let background = self
            .background_sink
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(coordinator) = sessions.get(session_id) {
            coordinator.set_config(config);
            coordinator.set_background_sink(background);
            Arc::clone(coordinator)
        } else {
            let coordinator = Arc::new(SessionSummaryCoordinator::new(
                session_id,
                config,
                self.on_done.clone(),
            ));
            coordinator.set_background_sink(background);
            sessions.insert(session_id.to_string(), Arc::clone(&coordinator));
            coordinator
        }
    }

    /// 查询会话协调器（None = 该会话尚未触发过；测试断言面）
    pub fn coordinator(&self, session_id: &str) -> Option<Arc<SessionSummaryCoordinator>> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .cloned()
    }

    /// 已登记会话数（测试断言面）
    pub fn len(&self) -> usize {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    /// 是否为空（测试断言面）
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 移除会话协调器（会话删除清理；V1 壳层会话删除路径未接线，预留）
    pub fn remove(&self, session_id: &str) -> Option<Arc<SessionSummaryCoordinator>> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session_id)
    }
}

#[cfg(test)]
mod tests {
    // 测试串行锁（COORDINATOR_TEST_SERIAL_LOCK）刻意跨 await 持有——
    // 全局 ACTIVE_SUMMARY_TASKS 计数共享，必须保证整个测试体串行，
    // 计数断言才自洽（非真实代码路径的锁语义，豁免 await_holding_lock）
    #![allow(clippy::await_holding_lock)]

    use super::super::summary_dispatch::SummaryBackgroundSink;
    use super::*;
    use conex_compaction::recovery::SummaryState;
    use conex_compaction::Summarizer;
    use conex_types::events::AgentEvent;
    use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
    use std::time::Duration;

    /// 协调器测试全局串行锁：进程级 [ACTIVE_SUMMARY_TASKS] 计数由全部
    /// 协调器测试共享，并行断言互扰（见 [reset_active_summary_tasks_for_test]）；
    /// 每个测试开头取锁 + 清零，保证计数断言自洽。
    static COORDINATOR_TEST_SERIAL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 测试入口辅助：串行锁 + 全局计数清零（隔离静态计数泄漏）
    fn test_serial_guard() -> std::sync::MutexGuard<'static, ()> {
        let guard = COORDINATOR_TEST_SERIAL_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reset_active_summary_tasks_for_test();
        guard
    }

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
        session_id: &str,
        block_id: &str,
    ) -> SummaryDispatchTask {
        SummaryDispatchTask {
            session_id: session_id.to_string(),
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

    /// 记录调用（次数）+ 可配置返回
    struct RecordingSummarizer {
        calls: std::sync::Mutex<usize>,
        result: std::sync::Mutex<Result<String, String>>,
    }
    impl Summarizer for RecordingSummarizer {
        fn summarize(
            &self,
            _dropped: &[AgentMessage],
            _existing: Option<&str>,
        ) -> Result<String, String> {
            *self.calls.lock().unwrap() += 1;
            self.result.lock().unwrap().clone()
        }
    }

    /// 挂起摘要器（模拟长调用；配合短墙钟测试全局上限存活窗口）。
    /// 单次挂起 ~400ms：退避 3 次共 ~1.2s 内完成，测试 sleep 窗口可控
    struct HungSummarizer;
    impl Summarizer for HungSummarizer {
        fn summarize(
            &self,
            _dropped: &[AgentMessage],
            _existing: Option<&str>,
        ) -> Result<String, String> {
            std::thread::sleep(Duration::from_millis(400));
            Ok(valid_json("compacted-summary-1-1"))
        }
    }

    /// 会话级单飞跨 run 语义：同一协调器（注册表 get_or_create 同 Arc）
    /// 任务存活期间再次触发被去重；任务完成后可再触发（续试）
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn single_flight_across_registry_reacquire() {
        let _serial = test_serial_guard();
        let registry = SessionSummaryCoordinatorRegistry::new(None);
        let summarizer = Arc::new(RecordingSummarizer {
            calls: std::sync::Mutex::new(0),
            result: std::sync::Mutex::new(Ok(valid_json("compacted-summary-1-1"))),
        });
        // run 1：get_or_create 触发（任务存活）
        let coordinator = registry.get_or_create("s1", fast_config());
        assert!(
            coordinator.try_trigger(task_with(summarizer.clone(), "s1", "compacted-summary-1-1"), None),
            "首次触发必须 spawn"
        );
        // run 2 模拟：再次 get_or_create（同一 Arc——跨 run 单飞状态延续）
        let same = registry.get_or_create("s1", fast_config());
        assert!(Arc::ptr_eq(&coordinator, &same), "同会话必须返回同一协调器");
        assert!(
            !same.try_trigger(task_with(summarizer.clone(), "s1", "compacted-summary-1-2"), None),
            "任务存活期跨 run 触发被去重（会话级单飞）"
        );
        // 等首任务完成（退避 1ms + 调用）
        tokio::time::sleep(Duration::from_millis(200)).await;
        // 任务完成后：新触发放行（续试）
        assert!(
            same.try_trigger(task_with(summarizer.clone(), "s1", "compacted-summary-1-2"), None),
            "任务完成后可再触发"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            *summarizer.calls.lock().unwrap(),
            2,
            "跨 run 单飞：存活期去重 + 完成后放行，共 2 次真实调用"
        );
    }

    /// 全局并发上限：3 个会话同时触发（长调用卡住）→ 存活 ≤ 2；
    /// 任务完成后计数释放（新触发放行）
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn global_limit_caps_concurrent_sessions() {
        let _serial = test_serial_guard();
        let registry = SessionSummaryCoordinatorRegistry::new(None);
        let hung: Arc<dyn Summarizer> = Arc::new(HungSummarizer);
        let a = registry.get_or_create("a", fast_config());
        let b = registry.get_or_create("b", fast_config());
        let c = registry.get_or_create("c", fast_config());
        assert!(a.try_trigger(task_with(hung.clone(), "a", "b1"), None));
        assert!(b.try_trigger(task_with(hung.clone(), "b", "b1"), None));
        assert!(
            !c.try_trigger(task_with(hung.clone(), "c", "b1"), None),
            "第 3 会话触发时全局已满（≤2）→ 忽略"
        );
        // 完成后计数释放 → 会话 c 触发放行
        tokio::time::sleep(Duration::from_millis(2_000)).await;
        assert!(
            c.try_trigger(task_with(hung.clone(), "c", "b1"), None),
            "任务完成后全局计数释放 → 新触发放行"
        );
        tokio::time::sleep(Duration::from_millis(2_000)).await;
        assert_eq!(registry.len(), 3, "3 会话各自登记协调器");
        for id in ["a", "b", "c"] {
            let coord = registry.coordinator(id).expect("协调器已登记");
            assert!(
                coord.last_outcome().is_some(),
                "会话 {id} 任务必须完成（committed）"
            );
        }
    }

    /// 会话隔离：多会话任务各跑各的——结果写入各自协调器的 last_outcome，
    /// 无串扰（对齐 04 §7.1 隔离决议：per-session 实例边界）
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sessions_are_isolated_no_cross_talk() {
        let _serial = test_serial_guard();
        let registry = SessionSummaryCoordinatorRegistry::new(None);
        let good: Arc<dyn Summarizer> = Arc::new(RecordingSummarizer {
            calls: std::sync::Mutex::new(0),
            result: std::sync::Mutex::new(Ok(valid_json("compacted-summary-1-1"))),
        });
        let failing: Arc<dyn Summarizer> = Arc::new(RecordingSummarizer {
            calls: std::sync::Mutex::new(0),
            result: std::sync::Mutex::new(Err("持续失败".to_string())),
        });
        let s_a = registry.get_or_create("a", fast_config());
        let s_b = registry.get_or_create("b", fast_config());
        assert!(s_a.try_trigger(task_with(good.clone(), "a", "ca"), None));
        assert!(s_b.try_trigger(task_with(failing.clone(), "b", "cb"), None));
        tokio::time::sleep(Duration::from_millis(500)).await;
        let a_outcome = s_a.last_outcome().expect("会话 a 已完成");
        let b_outcome = s_b.last_outcome().expect("会话 b 已完成");
        assert_eq!(a_outcome.session_id, "a", "结果归属各自会话");
        assert_eq!(b_outcome.session_id, "b");
        assert_eq!(a_outcome.block_id, "ca");
        assert_eq!(b_outcome.block_id, "cb");
        assert_eq!(a_outcome.state, SummaryState::Committed, "a 成功（好摘要器）");
        assert_eq!(
            b_outcome.state,
            SummaryState::Awaiting,
            "b episode 耗尽 → 低功耗待重试（E2 F2 层 1：废除 retired 永驻，块保持 awaiting）"
        );
        assert!(a_outcome.summary_json.is_some());
        assert!(b_outcome.summary_json.is_none());
    }

    /// 完成回调：注入 fake Summarizer 后后台任务真正执行并产出 committed
    /// 结果经 per-trigger 回调透传（T-43 语义：注入后后台执行闭环）
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn committed_outcome_delivered_via_callback() {
        let _serial = test_serial_guard();
        let registry = SessionSummaryCoordinatorRegistry::new(None);
        let good: Arc<dyn Summarizer> = Arc::new(RecordingSummarizer {
            calls: std::sync::Mutex::new(0),
            result: std::sync::Mutex::new(Ok(valid_json("compacted-summary-1-1"))),
        });
        let outcomes = Arc::new(std::sync::Mutex::new(Vec::new()));
        let coordinator = registry.get_or_create("s1", fast_config());
        let cb = {
            let outcomes = outcomes.clone();
            Box::new(move |o: SummaryDispatchOutcome| {
                outcomes.lock().unwrap().push(o);
            }) as SummaryOutcomeCallback
        };
        assert!(coordinator.try_trigger(task_with(good, "s1", "compacted-summary-1-1"), Some(cb)));
        tokio::time::sleep(Duration::from_millis(300)).await;
        let done = outcomes.lock().unwrap().clone();
        assert_eq!(done.len(), 1, "回调必须恰好收到一次结果");
        assert_eq!(done[0].state, SummaryState::Committed);
        assert_eq!(done[0].block_id, "compacted-summary-1-1");
        assert!(done[0].summary_json.is_some(), "committed 携带 JSON 规范文档");
        assert!(done[0].rendered_markdown.is_some(), "committed 携带 md 渲染");
        // 会话元数据快照同步
        let snapshot = coordinator.last_outcome().expect("会话元数据快照");
        assert_eq!(snapshot.state, SummaryState::Committed);
    }

    /// 会话级默认回调（注册表注入）：无 per-trigger 回调时经默认回调落
    /// 库面（T-42 回调写入——壳层经此装配 orchestrator 块表推进）
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn registry_default_callback_receives_outcome() {
        let _serial = test_serial_guard();
        let default_outcomes = Arc::new(std::sync::Mutex::new(Vec::new()));
        let default_cb = {
            let outcomes = Arc::clone(&default_outcomes);
            Arc::new(move |o: SummaryDispatchOutcome| {
                outcomes.lock().unwrap().push(o);
            }) as Arc<dyn Fn(SummaryDispatchOutcome) + Send + Sync>
        };
        let registry = SessionSummaryCoordinatorRegistry::new(Some(default_cb));
        let good: Arc<dyn Summarizer> = Arc::new(RecordingSummarizer {
            calls: std::sync::Mutex::new(0),
            result: std::sync::Mutex::new(Ok(valid_json("compacted-summary-1-1"))),
        });
        let coordinator = registry.get_or_create("s9", fast_config());
        assert!(coordinator.try_trigger(task_with(good, "s9", "compacted-summary-1-1"), None));
        tokio::time::sleep(Duration::from_millis(300)).await;
        let done = default_outcomes.lock().unwrap().clone();
        assert_eq!(done.len(), 1, "默认回调必须收到结果");
        assert_eq!(done[0].session_id, "s9");
        assert_eq!(done[0].state, SummaryState::Committed);
    }

    // ── EV-06 summary-background 事件面（会话级协调器）───────────────

    /// 记录型 summary-background sink（测试断言面）
    struct RecordingSummarySink {
        events: std::sync::Mutex<Vec<AgentEvent>>,
    }
    impl RecordingSummarySink {
        fn new() -> Self {
            Self {
                events: std::sync::Mutex::new(Vec::new()),
            }
        }
        fn phases(&self) -> Vec<String> {
            self.events
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .filter_map(|e| match e {
                    AgentEvent::SummaryBackground { phase, .. } => Some(phase.clone()),
                    _ => None,
                })
                .collect()
        }
    }
    impl SummaryBackgroundSink for RecordingSummarySink {
        fn emit(&self, event: &AgentEvent) {
            self.events
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(event.clone());
        }
    }

    /// 会话级触发：注册表装配 sink → try_trigger 成功发射 spawned，任务内
    /// 后续 phase（attempt/success）单点发射；单飞去重拒绝时不发事件
    /// （临时拒绝，非「放弃」语义）
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn coordinator_emits_spawned_and_task_phases() {
        let _serial = test_serial_guard();
        let sink = Arc::new(RecordingSummarySink::new());
        let registry = SessionSummaryCoordinatorRegistry::new(None);
        registry.set_background_sink(Some(Arc::clone(&sink) as SummaryBackgroundSinkRef));
        let good: Arc<dyn Summarizer> = Arc::new(RecordingSummarizer {
            calls: std::sync::Mutex::new(0),
            result: std::sync::Mutex::new(Ok(valid_json("compacted-summary-1-1"))),
        });
        let coordinator = registry.get_or_create("s1", fast_config());
        // 任务存活期间再次触发被去重 → 无事件（非放弃）
        assert!(coordinator.try_trigger(task_with(good.clone(), "s1", "compacted-summary-1-1"), None));
        let phases_after_first = sink.phases();
        assert_eq!(phases_after_first.len(), 1, "存活期去重不发事件");
        assert_eq!(phases_after_first[0], "spawned", "触发成功必须发射 spawned");
        assert!(
            !coordinator.try_trigger(task_with(good.clone(), "s1", "compacted-summary-1-2"), None),
            "存活任务去重"
        );
        assert_eq!(sink.phases().len(), 1, "去重拒绝不发事件（临时拒绝非放弃）");
        // 任务完成：spawned → attempt → success 全序列
        tokio::time::sleep(Duration::from_millis(300)).await;
        let all = sink.phases();
        assert_eq!(
            all,
            vec!["spawned", "attempt", "success"],
            "会话级触发事件序列（单飞去重无额外 spawned）：{all:?}"
        );
    }
}
