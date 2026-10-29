//! run/run_core.rs（SR-02 · 拆分 · ≠ EL）
//!
//! 经 run/mod.rs 聚合接线；顶层符号 pub 化供兄弟模与门面 re-export。

use super::*;

// ── 命令返回形状（03 §3.2 A 组契约）───────────────────────────────

/// core_run_task 返回（03 §3.1：{runId, sessionId} 回执）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskResponse {
    pub run_id: String,
    pub session_id: String,
}

/// core_cancel_run 返回（{ok, runId}；pid 无进程内概念，省略）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRunResponse {
    pub ok: bool,
    pub run_id: String,
}

// ── RunProducer trait（drive_run_loop 的循环输入）──────────────────

/// run 生产接口（drive_run_loop 的 `produce` 步骤）
///
/// 当前实现 [SessionLoopProducer]（run_producer.rs）：单次 produce 即覆盖整个
/// run（含多 turn），drive_outcome 收口终态后退出；未来 goal 多轮模式
/// 在本循环续轮。
#[async_trait::async_trait]
pub trait RunProducer: Send {
    /// 生产一次 run 结果
    async fn produce(&mut self) -> RunOutcome;
}

#[async_trait::async_trait]
impl RunProducer for SessionLoopProducer {
    async fn produce(&mut self) -> RunOutcome {
        SessionLoopProducer::produce(self).await
    }
}

// ── ActiveRun：活动 run 注册表条目 ────────────────────────────────

/// 挂起原因语义分类（W3-T1：消除看门狗误杀，执行阶段租约协同）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SuspensionReason {
    /// 处于大模型 429 RateLimit 弹性退避休眠中
    RateLimitBackoff {
        retry_after_ms: Option<u64>,
        elapsed_ms: u64,
        total_budget_ms: u64,
    },
    /// 处于瞬态网络错误指数退避休眠中
    TransientNetworkBackoff { attempt: u32 },
    /// 处于三态断路器冷却等待中
    CircuitBreakerCooling { cooldown_until_ms: u64 },
}

/// 运行实例物理执行阶段（W3-T1：语义化执行阶段状态机）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionPhase {
    /// 活跃推进态：正在执行 Token 流式推理、工具调用或状态计算
    Active,
    /// 合法挂起态：正在非阻塞休眠让渡，持有有效时效租约（Lease）
    Suspended {
        until_ms: u64,
        reason: SuspensionReason,
    },
    /// 终结态：已进入收敛终态，准备释放锁
    Terminated,
}

/// 活动 run 条目（活动注册表 `active_runs: run_id → ActiveRun`）
///
/// 并发模型（AA-02）：异步路径（drive / cancel / approve）经 tokio Mutex
/// 访问 [RunHandle] 与 [EventQueue]；std Mutex（控制总线）不跨 await 持有。
pub struct ActiveRun {
    /// 会话标识
    pub session_id: String,
    /// run 标识
    pub run_id: String,
    /// run 状态机句柄（drive 收口 / cancel 三路径 / approve 状态机联动）
    pub handle: Arc<tokio::sync::Mutex<RunHandle>>,
    /// 事件队列（drive 收口 + approve-resolved 落库共用）
    pub queue: Arc<tokio::sync::Mutex<EventQueue>>,
    /// 控制总线（L2 协作停止 / L1 注入意图）
    pub control_bus: Arc<Mutex<ControlBus>>,
    /// L3 强停信号（AbortSignal，安全点协作）
    pub abort_signal: AbortSignal,
    /// 审批门
    pub approval: Arc<ApprovalGateImpl>,
    /// 本 run 的缓冲事件桥（gate 广播 / delta sink / 收口 emit 共用）
    pub bridge: Arc<BufferedRunEventBridge>,
    /// 实时 delta 是否激活（T09.1：激活时收口 message-delta 跳过不双发）
    pub delta_sink_active: bool,
    /// 驱动任务句柄（30-P1：spawn(drive_run_loop) 的 JoinHandle）。
    /// Mutex<Option> 形态——ActiveRun 构造在前、spawn 在后，句柄经
    /// [Self::set_driver] 事后登记；收口**不 await**（JoinHandle drop 即
    /// detach，tokio 语义，防挂起），句柄供可观测与未来 join
    pub driver: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// T-CF-11：本 run 是否有用户交互（用户经 L1 soft_inject 注入消息 /
    /// force_cancel 置位；收口判定「用户消息到达后的正常收场不触发续
    /// run」的依据）
    pub user_touched: AtomicBool,
    /// 子代理 run 装配配置（T-D-13：Some = 本 run 是子代理 run——收口
    /// 时经 spawner 终态处理（记账释放 / 事件发射 / steering 通知）；
    /// None = 普通 run，收口行为与现状一致）
    pub subagent: Option<crate::subagent_spawner::SubagentRunConfig>,
    /// L4（F12）：审计落库 worker 句柄（run 级；收口处 take + await
    /// 排空——保证审计底账在 run 终态前全部落库；None = 测试驱动路径
    /// 未装配）
    pub audit_persist: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 运行时权限单元（父子链实时继承；子代理不保存快照）
    pub permission: Arc<conex_agents::permission::PermissionCell>,
    /// 运行时能力单元（主 agent = All；子代理可由父级升降级）
    pub capability: Arc<conex_agents::capability::CapabilityCell>,
    /// 运行时模型覆盖（None = 跟随引擎当前配置；切换下一 turn 生效）
    pub model: Arc<conex_agents::model::ModelCell>,
    /// 工程名（cwd 末段；收口写入 usage_records 的 project_name 归属）
    pub project_name: String,
    /// 语义化物理执行阶段状态机（W3-T1：活跃 / 挂起租约 / 终结态）
    pub phase: std::sync::RwLock<ExecutionPhase>,
    /// 最近一次心跳时间戳（ms；挂起刷新 + 唤醒刷新 + 活跃推进）
    pub last_heartbeat_ms: std::sync::atomic::AtomicU64,
}

impl ActiveRun {
    /// 构造活动 run 条目（初始化为 Active 推进态，心跳置为当前时间戳）
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        session_id: String,
        run_id: String,
        handle: Arc<tokio::sync::Mutex<RunHandle>>,
        queue: Arc<tokio::sync::Mutex<EventQueue>>,
        control_bus: Arc<Mutex<ControlBus>>,
        abort_signal: AbortSignal,
        approval: Arc<ApprovalGateImpl>,
        bridge: Arc<BufferedRunEventBridge>,
        delta_sink_active: bool,
        subagent: Option<crate::subagent_spawner::SubagentRunConfig>,
        audit_persist: Option<tokio::task::JoinHandle<()>>,
        permission_mode: conex_types::PermissionMode,
        project_name: String,
    ) -> Self {
        let now = conex_shared::time::unix_millis() as u64;
        Self {
            session_id,
            run_id,
            handle,
            queue,
            control_bus,
            abort_signal,
            approval,
            bridge,
            delta_sink_active,
            driver: Mutex::new(None),
            user_touched: AtomicBool::new(false),
            subagent,
            audit_persist: Mutex::new(audit_persist),
            permission: conex_agents::permission::PermissionCell::root(permission_mode),
            capability: conex_agents::capability::CapabilityCell::root(
                conex_agents::task::SubagentCapabilityMode::All,
            ),
            model: Arc::new(conex_agents::model::ModelCell::new(None)),
            project_name,
            phase: std::sync::RwLock::new(ExecutionPhase::Active),
            last_heartbeat_ms: std::sync::atomic::AtomicU64::new(now),
        }
    }

    /// 刷新心跳时间戳（避免边界瞬态抖动与活跃态超时）
    pub fn touch_heartbeat(&self) {
        self.last_heartbeat_ms.store(
            conex_shared::time::unix_millis() as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
    }

    /// 进入挂起状态并登记时效租约（Lease）
    pub fn enter_suspended_phase(&self, duration: std::time::Duration, reason: SuspensionReason) {
        let until_ms = conex_shared::time::unix_millis() as u64 + duration.as_millis() as u64;
        let mut phase_guard = self.phase.write().unwrap_or_else(|e| e.into_inner());
        *phase_guard = ExecutionPhase::Suspended { until_ms, reason };
        // 挂起时同步刷新一次心跳时间戳，避免瞬态边界抖动
        self.touch_heartbeat();
    }

    /// 恢复为活跃推进态
    pub fn enter_active_phase(&self) {
        let mut phase_guard = self.phase.write().unwrap_or_else(|e| e.into_inner());
        *phase_guard = ExecutionPhase::Active;
        self.touch_heartbeat();
    }

    /// 查询当前挂起租约到期时间戳（若处于挂起态）
    pub fn suspended_until_ms(&self) -> Option<u64> {
        let phase_guard = self.phase.read().unwrap_or_else(|e| e.into_inner());
        match *phase_guard {
            ExecutionPhase::Suspended { until_ms, .. } => Some(until_ms),
            _ => None,
        }
    }

    /// 标记为终结态
    pub fn terminate_phase(&self) {
        let mut phase_guard = self.phase.write().unwrap_or_else(|e| e.into_inner());
        *phase_guard = ExecutionPhase::Terminated;
    }

    /// 登记驱动任务句柄（30-P1；spawn 后调用一次，重复登记覆盖——驱动
    /// 任务每 run 仅一个）
    pub fn set_driver(&self, handle: tokio::task::JoinHandle<()>) {
        *self.driver.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    }

    /// 驱动任务是否已收口（观测 / 测试轮询；不 await，语义 = tokio
    /// JoinHandle::is_finished——已收口 / 已取消均成立）
    #[cfg_attr(not(test), allow(dead_code))] // 测试断言面消费；生产供未来 join/观测（30-P1 句柄管理）
    pub fn driver_finished(&self) -> bool {
        self.driver
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(tokio::task::JoinHandle::is_finished)
            .unwrap_or(false)
    }
}

/// 活动 run 的引擎取消接口（[orchestrator::run::RunEngine] 实现：
/// L2 协作停止入控制总线，L3 强停触发 AbortSignal + 总线 force_cancel）
pub struct ActiveRunEngine {
    pub active: Arc<ActiveRun>,
}

impl RunEngine for ActiveRunEngine {
    fn request_cooperative_stop(&self, reason: &str) -> bool {
        let mut bus = self
            .active
            .control_bus
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        bus.request_cooperative_stop(Some(reason.to_string()), Some("ui".to_string()));
        true
    }

    fn abort(&self, reason: &str) {
        self.active.abort_signal.abort();
        let mut bus = self
            .active
            .control_bus
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        bus.request_force_cancel(Some(reason.to_string()), Some("ui".to_string()));
    }
}

/// 逃逸监视审计 sink（T-ESC-03 壳层适配）：security-audit 事件经本 run
/// 缓冲事件桥实时广播（信封 sequence=None 实时预览，前端审计面板实时
/// 可见；与审批门 broadcast 同构）。落库（append_event）L4（F12）已
/// 接线：同步广播外另发持久化通道，由单 worker 按发射序
/// reserve_sequence + append_event 落库（events 表审计底账；广播保实时、
/// 落库保底账，双轨并存）。
#[derive(Debug)]
pub struct BridgeAuditSink {
    /// 本 run 缓冲事件桥
    pub bridge: Arc<BufferedRunEventBridge>,
    /// run 标识（信封注入）
    pub run_id: String,
    /// 审计持久化通道（L4：worker 按发射序落库；发送失败 = worker 已
    /// 退出，落库尽力而为，广播不受影响）
    pub persist: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
}

impl BridgeAuditSink {
    /// 新建桥接审计 sink（run 级实例；persist 通道由 run 装配轮创建，
    /// worker 与 run 同生命周期）
    pub fn new(
        bridge: Arc<BufferedRunEventBridge>,
        run_id: String,
        persist: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
    ) -> Self {
        Self {
            bridge,
            run_id,
            persist,
        }
    }
}

impl SecurityAuditSink for BridgeAuditSink {
    fn emit(&self, event: &AgentEvent) {
        // L4（F12）：审计底账落库——先发持久化通道（worker 按发射序
        // reserve + append_event；通道关闭仅告警，广播已保实时轨）
        if let Err(error) = self.persist.send(event.clone()) {
            tracing::warn!(
                target: "audit",
                run_id = %self.run_id,
                error = %error,
                "审计落库通道已关闭（保留实时轨，落库尽力而为）"
            );
        }
        let envelope = AgentEventEnvelope::new(event.clone(), Some(self.run_id.clone()), None);
        self.bridge.emit(&envelope);
        self.bridge.flush();
    }
}

/// 审计落库 worker（L4：审计底账持久化——广播保实时、落库保底账）
///
/// 单 worker 串行消费 mpsc 通道：严格保持发射序 → 会话级 sequence
/// 单调不逆序；复用 [orchestrator::events::EventQueue] 的
/// `push_terminal_best_effort` 尽力语义（store 失败仅告警，审计不阻断
/// run、不标记 run 失败）。生命周期：随 run 收口（桥引用全部释放 →
/// sender drop 发出关闭信号 → 排空后退出；收口处 await 保证终态前
/// 落库完成）。
pub fn spawn_audit_persistence(
    queue: Arc<tokio::sync::Mutex<EventQueue>>,
    session_id: String,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
) -> tokio::task::JoinHandle<()> {
    crate::engine_assembly::spawn_here(async move {
        while let Some(event) = rx.recv().await {
            let sequenced = queue
                .lock()
                .await
                .push_terminal_best_effort(&session_id, event)
                .await;
            if !sequenced.persisted {
                tracing::warn!(
                    target: "audit",
                    session_id = %session_id,
                    event_type = sequenced.event.type_name(),
                    "审计事件落库失败（保留实时轨，审计底账尽力而为）"
                );
            }
        }
    })
}

// ── CoreRunState ──────────────────────────────────────────────────

/// 核心运行状态（B6.4：进程内核心的共享状态）
///
/// main.rs 接线（集成 agent）：`app.manage(Arc::new(CoreRunState::new(...)))`；
/// restore 在 manage 之前经 `run_in_runtime` 执行 [Self::run_restore]（T08.6）。
pub struct CoreRunState {
    /// 事件存储连接（run 记录 + 事件流 + pending 输入）
    pub(crate) store: Arc<dyn Store>,
    /// run 管理器（注册 + 生命周期）
    pub(crate) run_manager: RunManager,
    /// 引擎句柄（provider 配置 + 工具注册表 + engineReady；Arc 包装——
    /// 生产 Summarizer 工厂闭包需 'static 捕获以按会话读取当前生效配置）
    pub(crate) engine: Arc<EngineHandle>,
    /// 全局事件桥（Tauri 通道；每 run 经 BufferedRunEventBridge 组装缓冲）
    pub(crate) bridge: EventBridge,
    /// 活动 run 注册表（终态移出；会话内串行守卫依据）
    pub(crate) active_runs: Mutex<HashMap<String, Arc<ActiveRun>>>,
    /// 装配中会话标记（run_launch.rs 串行守卫：检查通过即在本集合插入
    /// 会话 id——检查与占用同一临界区，闭合「守卫检查锁内判定、真实
    /// 条目数百行后才 insert」的 TOCTOU 窗口；[run_launch::
    /// RunLaunchGuard] drop 无条件清理，防装配失败泄漏导致会话永久
    /// 无法再启动 run）
    pub(crate) assembling_sessions: Mutex<HashSet<String>>,
    /// 状态诊断（环形 20 条 + lastError AtomicSlot，PE-04 T04.5）
    pub(crate) diagnostics: Arc<StatusDiagnostics>,
    /// T08.8：会话级序列号预热缓存（base_sequence_for；恢复后 seed）
    pub(crate) next_sequences: Mutex<HashMap<String, u64>>,
    /// T08.6 门禁：restore 完成标记（完成前 run_task 拒绝新 run，Q24 竞态）
    pub(crate) restore_ready: AtomicBool,
    /// 快照存储（主文件 + .prev 备份，双文件模型）
    pub(crate) snapshots: Arc<dyn SnapshotStore>,
    /// 快照周期（ms；session_meta `snapshot_interval_ms` 可配，默认 60s）
    pub(crate) snapshot_interval_ms: Mutex<u64>,
    /// 最近一次快照代数（恢复成功后的首次保存以 generation+1 续接）
    pub(crate) snapshot_generation: AtomicU64,
    /// T3.5 D5（F2-11 / R2 §4 修复建议 1）：快照保存互斥锁——三触发
    /// （终态 [Self::save_snapshot_now] 调用点 / 周期 [Self::spawn_snapshot_loop]
    /// / 退出 [Self::save_snapshot_blocking]）共用 [Self::save_snapshot_now]
    /// 入口，锁内完成「generation 读-改-写 + build + 落盘 + 状态回写」全
    /// 链路。根因：无锁时两路并发保存同读 G 同写 G+1（丢失更新），且轮转
    /// remove/rename 交叉（实测并发双线程下主/备份同代数 + snapshot_rename
    /// 错误）。锁为 tokio::sync::Mutex：跨 runtime 可用（退出钩子经
    /// `tauri::async_runtime::block_on` 从独立 std::thread 汇入同一锁面），
    /// 无嵌套锁面（唯一持有点），死锁风险低（AU-03 选型确认）。
    pub(crate) snapshot_mutex: tokio::sync::Mutex<()>,
    /// 快照保存失败显式标记（P16：core_get_status.snapshot.lastError 数据源）
    pub(crate) snapshot_last_error: Mutex<Option<String>>,
    /// 会话树注册表（T08.6 第 4 点；goal 模式未激活时为空数组，快照结构不变）
    pub(crate) sessions: Mutex<Vec<SessionRecord>>,
    /// 周期快照任务运行标记（幂等防重复启动）
    pub(crate) snapshot_loop_running: AtomicBool,
    /// T5-2：孤儿 run 收割去抖表（run_id → 驱动任务已收口且仍停留
    /// activeRuns 的连续轮数；每轮 [crate::run::run_commands::
    /// reap_orphan_runs_round] 更新——driver 未收口即清零/移除，连续
    /// [ORPHAN_REAP_DEBOUNCE_ROUNDS] 轮仍停留才判定孤儿收割，防把
    /// 「刚正常收口、正在从 activeRuns 移除」误判为孤儿）。
    pub(crate) orphan_debounce: Mutex<HashMap<String, u32>>,
    /// T5-2：孤儿收割周期任务运行标记（幂等防重复启动）
    pub(crate) reaper_loop_running: AtomicBool,
    /// P3：子代理心跳落库周期任务运行标记（幂等防重复启动）
    pub(crate) heartbeat_loop_running: AtomicBool,
    /// setup 完成标记（PE-01 T01.2：main.rs setup 末尾置 true；
    /// core_get_status.initialized 数据源）
    pub(crate) initialized: AtomicBool,
    /// restore 是否已开始（restore.state = pending 数据源）
    pub(crate) restore_started: AtomicBool,
    /// restore 是否失败（restore.state = failed 数据源；失败不阻塞启动）
    pub(crate) restore_failed: AtomicBool,
    /// 恢复模式字面量（full-replay / snapshot-incremental；restore.mode 数据源）
    pub(crate) restore_mode: Mutex<Option<String>>,
    /// 快照回退说明（restore.snapshotNote 数据源；None = 未回退/无说明）
    pub(crate) restore_note: Mutex<Option<String>>,
    /// 本次恢复打断的 run 数（restore.interruptedCount 数据源）
    pub(crate) interrupted_count: Mutex<usize>,
    /// 事件流锚点（restore.lastSequence 数据源；无事件时 None）
    pub(crate) restore_last_sequence: Mutex<Option<u64>>,
    /// 最近一次快照写入时间（epoch ms；snapshot.writtenAt 数据源）
    pub(crate) snapshot_written_at: Mutex<Option<i64>>,
    /// T-29：per-session 历史缓存（P4 阶段 1-3/1-4；运行期内存态，
    /// 不落库——前端 history 为空时回退，混合路线"引擎侧缓存主"）
    pub(crate) session_history: SessionHistoryCache,
    /// T-AB-19：run 感知后台任务管理器（包壳 main.rs 注入的注册表——
    /// 工具链 adopt 的 owner_run_id 注入槽 + L3 可选联动 + 状态汇总
    /// 查询面；引擎侧注入同一包装实例，工具执行链 adopt 走装饰器）
    pub(crate) background: Arc<RunAwareBackgroundManager>,
    /// T-CF-11：跨 run steering 队列（PendingMessageQueue——定时器到期 /
    /// Cron 触发 / 子代理完成 / watchdog 兜底通知的落点；与
    /// [EngineHandle::timer_steering_queue] 同一实例，收口处非空判定 +
    /// 批量转出注入续 run）
    pub(crate) pending_queue: Arc<Mutex<PendingMessageQueue>>,
    /// 30 方案 P3：任务事件消费器（task_events.rs 消费面接线——与
    /// [Self::pending_queue] 同实例、bridge 直发 security-audit（域隔离
    /// 不经 engine audit_sink）；main.rs 装配轮经
    /// [Self::task_events] 注入 background 注册表）
    pub(crate) task_events: Arc<TaskEventConsumer>,
    /// T-CF-11：定时器活跃判定器（TimerRegistry 非空封装；None = 未接线
    /// ——收口时不因定时器续 run。生产在 [Self::new] 经
    /// [EngineHandle::timer_registry] 的 list_active 封装注入；测试可替换）
    pub(crate) timer_has_active: Mutex<Option<WakeSourceCheck>>,
    /// T-CF-11：enabled Cron 判定器（SchedulerRegistry 非空封装；None =
    /// 未接线——Cron 不参与续 run 判定，行为与接线前一致。30 方案 P7：
    /// 生产在 [Self::new] 内直接装配（engine.scheduler_registry() 非空
    /// 封装 has_active，对齐 timer_has_active 先例）；setter 保留测试
    /// 替换槽）
    pub(crate) cron_has_enabled: Mutex<Option<WakeSourceCheck>>,
    /// T-CF-11：idle 续 run 空转护栏计数（session_id → 连续无 AI 产出
    /// 的续 run 轮数；有产出清零，超 [IDLE_RESUME_MAX_EMPTY_ROUNDS] 停止）
    pub(crate) resume_empty_streak: Mutex<HashMap<String, u32>>,
    /// T-CF-11：idle 续 run 拉起器（生产 = [production_resume_launcher]
    /// 预装配——经 run_task_impl 复用装配拉起新 run；测试经
    /// set_resume_launcher 注入替身断言判定与注入载荷）
    pub(crate) resume_launcher: Mutex<Option<ResumeLauncher>>,
    /// 全局运行策略（用户裁决：重试预算/上限可配置，进配置文件不绑供应
    /// 商）。main.rs 启动时从 `<config_dir>/settings.json` 读入；测试经
    /// [Self::set_run_policy] 内存注入；None = 装配点落缺省（与策略文件
    /// 引入前行为一致）。
    pub(crate) run_policy: Mutex<Option<crate::run_policy::RunPolicy>>,
    /// D2 §3.4（C4 锁死）：跨 run 续 run 退避延迟注入点——测试直接驱动
    /// （不依赖 tokio pause）；None = 生产镜像 recovery.rs 常量
    /// （750→1500→3000，8s 封顶）。注入存在时 [Self::sleep_resume_backoff]
    /// 跳过真实睡眠（测试驱动模式）。
    pub(crate) resume_backoff: Mutex<Option<BackoffDelayFn>>,
    /// R1 撤回边界冻结护栏（统一输入流收敛战役）：会话级冻结注册表——
    /// run 事件队列（run_launch.rs 装配）与撤回命令（retraction_commands.rs）
    /// 注入**同一实例**：冻结激活/释放与写侧拒绝走同一会话级状态。
    pub(crate) retraction_freeze: std::sync::Arc<session_loop::SessionFreezeRegistry>,
    /// 子代理生产 spawner（T-D-13：SubagentSpawner 契约引擎侧实现；
    /// 同一实例经 EngineHandle 注入 run_subagent 工具 + 本状态持有——
    /// 注入面（launcher / db / wait 广播 / steering 队列）经
    /// [Self::finalize_subagent_spawner] 装配）
    pub(crate) subagent_spawner: Arc<crate::subagent_spawner::SubagentSpawnerImpl>,
    /// D3 §3.1：每会话恢复协调器（C7 权威实例；五件套装配，惰性构造——
    /// 外层 Mutex<HashMap> 为 L0 内存守卫，持锁 < 100ns；
    /// 内层统一为 Arc<tokio::sync::Mutex<RecoveryCoordinator>> 异步业务锁，支持 await）
    pub(crate) recovery_coordinators:
        Mutex<HashMap<String, Arc<tokio::sync::Mutex<RecoveryCoordinator>>>>,
    /// D3 §3.1/§3.3：每会话会话树（restore 后 from_session_record 重建；
    /// 阶梯 3 fork 的源叶子载体；coordinator 惰性构造时缺省空树）
    pub(crate) session_trees: Mutex<HashMap<String, Arc<Mutex<SessionTree>>>>,
    /// D3 §3.5：跨 run 阶梯 1 重试计数（(session_id, fingerprint) → 已
    /// 重派次数；进程内记账——重启清零是阶梯 1 既有语义，不持久化）
    pub(crate) ladder1_retries: Mutex<HashMap<(String, String), u32>>,
    /// D6 §4.2：会话级用户停止标记（会话 → 停止时刻；用户 L2/L3 停止
    /// 写入、用户新 run 装配清除——「用户显式停止永不自动续」跨 run
    /// 语义；watcher 判定与 decide_idle_resume 共享；**不落库**——重启
    /// 后用户停止历史天然消失，watcher 恢复自动行为，重启本身不是
    /// 用户停止）
    pub(crate) user_stopped: Mutex<HashMap<String, u64>>,
    /// D6 §3.2：每会话唤醒 watcher 幂等持有表（会话 → watcher 实例；
    /// run_task_impl 会话首次出现 / run_restore 成功后惰性 spawn；run
    /// 收口**不销毁**——否则 AI 休眠后 watcher 也跟着没了，回到断点 2；
    /// 进程退出随 runtime 销毁，测试面经句柄 stop）
    pub(crate) wake_watchers: Mutex<HashMap<String, Arc<crate::wake_watcher::WakeWatcher>>>,
    /// T-42：会话级摘要协调器注册表（00-plan §6.5 R-I / 评审 02 P0-2）——
    /// 与 [Self::session_history] 同生命周期（进程级单例）：摘要任务状态
    /// （JoinHandle/退避/attempts/last_outcome）挂会话级容器，run 收口不
    /// 摧毁任务，跨 run 单飞成立；完成回调经默认回调落 compression_blocks
    /// 表（两阶段写协议阶段二，orchestrator::blocks 面）。
    pub(crate) summary_coordinators: Arc<session_loop::SessionSummaryCoordinatorRegistry>,
    /// T-43：会话级 Summarizer 工厂（生产由 [Self::new] 装配；None = 无注入——
    /// 不 spawn 后台摘要任务，纯 stub awaiting 永驻）。
    pub(crate) summarizer_factory: Mutex<Option<crate::engine_channels::SummarizerFactory>>,
    /// W2-T3：子代理活动等待拓扑注册表（死锁检测闭包信号源）
    pub(crate) subagent_wait_registry: Arc<SubagentWaitRegistry>,
}

impl CoreRunState {
    /// 新建核心运行状态（store / snapshots / bridge / diagnostics 由 main.rs
    /// 接线传入；diagnostics 与 `core_get_status` 的 `State<StatusDiagnostics>`
    /// 共享同一实例，避免「写入侧与读取侧实例漂移」）
    pub fn new(
        store: Arc<dyn Store>,
        snapshots: Arc<dyn SnapshotStore>,
        bridge: EventBridge,
        diagnostics: Arc<StatusDiagnostics>,
        background_manager: Option<Arc<dyn agent_tools::background::BackgroundTaskManager>>,
    ) -> Self {
        // T-AB-19：注册表包壳为 run 感知装饰器（owner_run_id 注入 + L3
        // 可选联动 + 汇总查询面）；引擎与状态共享同一包装实例——工具执行
        // 链 adopt（agent-tools shell.rs）经引擎注入的 trait 引用走到装饰器。
        let background = Arc::new(RunAwareBackgroundManager::new(background_manager));
        // T-D-13：子代理生产 spawner 实例（注入槽为空；launcher / db /
        // wait 广播 / steering 队列经 [Self::finalize_subagent_spawner]
        // 装配——Arc 构造完成后注入，防构造期循环引用）
        let subagent_spawner = Arc::new(crate::subagent_spawner::SubagentSpawnerImpl::new());
        // W2-T3：子代理活动等待拓扑注册表（死锁检测闭包信号源）
        let subagent_wait_registry = Arc::new(SubagentWaitRegistry::new());
        // T-CF-11：idle 待命唤醒源接线——跨 run steering 队列与定时器
        // 活跃 run 判定由 CoreRunState::build_wake_watcher 扫描 active_runs
        // （实现位于 run_retry.rs）；SchedulerRegistry enabled 判定在下方经
        // engine.scheduler_registry() 直接装配（30 方案 P7）。
        let engine = Arc::new(EngineHandle::new_with_spawner(
            // 引擎侧注入包装实例（保持 Option 语义：未接线 = 引擎无
            // 后台任务通道，与接线前行为一致）
            background
                .inner
                .is_some()
                .then(|| Arc::clone(&background) as Arc<dyn BackgroundTaskManager>),
            // T-D-13：spawn 通道注入（run_subagent 工具接线；None =
            // run_subagent 返回 common.unsupported 降级）
            Some(Arc::clone(&subagent_spawner)
                as Arc<dyn agent_tools::tools::subagent::SubagentSpawner>),
            // D6 §3.1 段 2 + D4 §3.8 ②（W4 统一签名）：store 下转
            // LocalDb 连接注入——Some → timer/sched/wait 三 store 真适配
            // （重启恢复数据面）；None（InMemoryStore 测试替身）→ 内存版
            store.as_local_db(),
        ));
        // COMPACTION-01 P0-3（生产闭环）：真实 LLM 摘要器工厂装配——会话级
        // SummarizerFactory = production_summarizer_factory（返回
        // ProviderSummarizer：经 chat-completions 通道 + 当前 provider
        // 配置；provider 未就绪 → None → 纯 stub awaiting 语义保持）。
        // 工厂每次解析读取引擎当前生效配置——config_profile_apply 热更新后
        // 下一次 run 立即生效。T-43 通道生产注入点（session.start /
        // 配置加载 = CoreRunState::new，与 SessionHistoryCache 同生命周期）。
        let summarizer_factory = Some(crate::engine_channels::production_summarizer_factory(
            Arc::clone(&engine),
        ));
        let pending_queue = engine.timer_steering_queue();
        // 30 方案 P3：任务事件消费器（与 pending_queue 同实例；bridge 为
        // 本状态持有实例的克隆——security-audit 直发不经 engine audit_sink，
        // 30 文档 §9 域隔离接口约定）
        let task_events = Arc::new(TaskEventConsumer::new(
            Arc::clone(&pending_queue),
            bridge.clone(),
            String::new(), // 空串占位（任务为会话级存活，归属经 payload ownerRunId）
        ));
        let timer_registry = engine.timer_registry();
        let timer_has_active: WakeSourceCheck = Arc::new(move || {
            let registry = Arc::clone(&timer_registry);
            Box::pin(async move { !registry.list_active().await.is_empty() })
        });
        // 30 方案 P7：enabled Cron 判定器装配（对齐 timer_has_active 先例
        // ——SchedulerRegistry 非空封装：表内条目即活跃（停止/取消时已
        // 移除，sched.rs has_active 语义自洽）。None = 装配降级（引擎
        // scheduler_registry 为 None），Cron 不参与续 run 判定，行为与
        // 接线前一致（main.rs 装配轮已加 warn 提示——D-29 精神）。
        let scheduler_registry = engine.scheduler_registry();
        let cron_has_enabled: Option<WakeSourceCheck> = scheduler_registry.map(|reg| {
            let reg = Arc::clone(&reg);
            let check: WakeSourceCheck = Arc::new(move || {
                let reg = Arc::clone(&reg);
                Box::pin(async move { reg.has_active() })
            });
            check
        });
        // T-CF-11：生产续 run 拉起器预装配（trait object 叶子类型——
        // drive_run_loop 经 trait object 调用，不直接包含 run_task_impl
        // 的 opaque future，避免 auto-trait 检查递归限制；测试经
        // set_resume_launcher 覆盖替身）
        let resume_launcher = production_resume_launcher();
        // T-42：会话级摘要协调器注册表（与 session_history 同生命周期）——
        // 默认完成回调 = 落 compression_blocks 表（两阶段写协议阶段二：
        // 调度器成功后推进 summary_json/state/attempts；orchestrator
        // 同步面，回调为 FnOnce 语义直接调用；失败仅告警不阻断——块表
        // 是索引面，原文仍在事件流可回放）
        let persist_store = Arc::clone(&store);
        let summary_coordinators =
            Arc::new(session_loop::SessionSummaryCoordinatorRegistry::new(Some(
                Arc::new(move |outcome: session_loop::SummaryDispatchOutcome| {
                    let outcome_state = match outcome.state.as_str() {
                        "committed" => conex_db::BlockState::Committed,
                        "retired" => conex_db::BlockState::Retired,
                        _ => conex_db::BlockState::Awaiting,
                    };
                    if let Err(error) = orchestrator::blocks::update_compression_block_summary(
                        persist_store.as_ref(),
                        &outcome.session_id,
                        &outcome.block_id,
                        outcome_state,
                        outcome.summary_json.as_deref(),
                        outcome.attempts,
                    ) {
                        tracing::warn!(
                            target: "run",
                            session_id = %outcome.session_id,
                            block_id = %outcome.block_id,
                            error = %error,
                            "摘要任务完成回调落库失败（块表是索引面，原文在事件流可回放）"
                        );
                    }
                })
                    as Arc<dyn Fn(session_loop::SummaryDispatchOutcome) + Send + Sync>,
            )));
        Self {
            store: Arc::clone(&store),
            run_manager: RunManager::new(store),
            engine,
            bridge,
            active_runs: Mutex::new(HashMap::new()),
            assembling_sessions: Mutex::new(HashSet::new()),
            diagnostics,
            next_sequences: Mutex::new(HashMap::new()),
            restore_ready: AtomicBool::new(false),
            snapshots,
            snapshot_interval_ms: Mutex::new(DEFAULT_SNAPSHOT_INTERVAL_MS),
            snapshot_generation: AtomicU64::new(0),
            snapshot_mutex: tokio::sync::Mutex::new(()),
            snapshot_last_error: Mutex::new(None),
            sessions: Mutex::new(Vec::new()),
            snapshot_loop_running: AtomicBool::new(false),
            orphan_debounce: Mutex::new(HashMap::new()),
            reaper_loop_running: AtomicBool::new(false),
            heartbeat_loop_running: AtomicBool::new(false),
            initialized: AtomicBool::new(false),
            restore_started: AtomicBool::new(false),
            restore_failed: AtomicBool::new(false),
            restore_mode: Mutex::new(None),
            restore_note: Mutex::new(None),
            interrupted_count: Mutex::new(0),
            restore_last_sequence: Mutex::new(None),
            snapshot_written_at: Mutex::new(None),
            session_history: SessionHistoryCache::new(),
            background,
            pending_queue,
            task_events,
            timer_has_active: Mutex::new(Some(timer_has_active)),
            cron_has_enabled: Mutex::new(cron_has_enabled),
            resume_empty_streak: Mutex::new(HashMap::new()),
            resume_launcher: Mutex::new(Some(resume_launcher)),
            resume_backoff: Mutex::new(None),
            run_policy: Mutex::new(None),
            retraction_freeze: std::sync::Arc::new(session_loop::SessionFreezeRegistry::new()),
            subagent_spawner,
            recovery_coordinators: Mutex::new(HashMap::new()),
            session_trees: Mutex::new(HashMap::new()),
            ladder1_retries: Mutex::new(HashMap::new()),
            user_stopped: Mutex::new(HashMap::new()),
            wake_watchers: Mutex::new(HashMap::new()),
            summary_coordinators,
            summarizer_factory: Mutex::new(summarizer_factory),
            subagent_wait_registry,
        }
    }

    /// 获取子代理等待注册表（W2-T3 死锁检测信号源）
    pub fn subagent_wait_registry(&self) -> Arc<SubagentWaitRegistry> {
        Arc::clone(&self.subagent_wait_registry)
    }

    /// setup 完成标记（PE-01 T01.2：setup 失败 = false，不假装成功）
    pub fn initialized(&self) -> bool {
        self.initialized.load(Ordering::SeqCst)
    }

    /// 标记 setup 完成（main.rs setup 末尾调用）
    pub fn mark_initialized(&self) {
        self.initialized.store(true, Ordering::SeqCst);
    }

    /// 引擎（session-loop）就绪（provider 配置三件套齐备）
    pub fn engine_ready(&self) -> bool {
        self.engine.ready()
    }

    /// 重载引擎 provider 适配层（PS-04 T4.3 / F4 F1-01 接线：config 命令
    /// 写 store 成功后调用——重建 `HttpProviderCall`（新 key/baseUrl/model
    /// 快照）并原子交换，下一次 run 用新凭据）。
    pub fn reload_provider(&self) {
        self.engine.reload_provider();
    }

    /// 全局运行策略注入（main.rs 启动读 settings.json；测试内存注入）。
    pub fn set_run_policy(&self, policy: Option<crate::run_policy::RunPolicy>) {
        *self.run_policy.lock().unwrap_or_else(|e| e.into_inner()) = policy;
    }

    /// 全局运行策略读取（None = 未配置，装配点落缺省）。
    pub fn run_policy(&self) -> Option<crate::run_policy::RunPolicy> {
        self.run_policy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// restore 域状态（core_get_status.restore 数据源；F2 冻结形状）
    pub fn restore_status(&self) -> RestoreStatus {
        let state = if !self.restore_started.load(Ordering::SeqCst) {
            "pending"
        } else if self.restore_failed.load(Ordering::SeqCst) {
            "failed"
        } else {
            "done"
        };
        let mode = self
            .restore_mode
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
            .unwrap_or_default();
        let snapshot_note = self
            .restore_note
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let interrupted_count = self
            .interrupted_count
            .lock()
            .map(|guard| *guard)
            .unwrap_or_default();
        let last_sequence = self
            .restore_last_sequence
            .lock()
            .map(|guard| *guard)
            .unwrap_or_default();
        RestoreStatus {
            state,
            mode,
            snapshot_note,
            interrupted_count,
            last_sequence,
        }
    }

    /// 快照域状态（core_get_status.snapshot 数据源；F2 冻结形状）
    pub fn snapshot_status(&self) -> SnapshotStatus {
        let written_at = self
            .snapshot_written_at
            .lock()
            .map(|guard| *guard)
            .unwrap_or_default();
        SnapshotStatus {
            generation: self.snapshot_generation(),
            written_at,
            last_error: self.snapshot_last_error(),
        }
    }

    /// run 终态错误文案（无则 None；当前未接线，终态错误由
    /// core_get_run_snapshot.endReason 承载）
    pub fn run_error(&self, _run_id: &str) -> Option<String> {
        None
    }

    /// run usage 域（T-40 真实实现，R5-D3 轮末合并接线）
    ///
    /// 数据源 = runs 表 v5 列（T-39 `get_run_usage`，drive_run_loop 收口
    /// `save_run_usage` 写入）；经 [Self::local_db] 下转型取底层连接。
    /// 无 LocalDb（InMemoryStore 等测试替身）/ 无样本（sample_count == 0，
    /// 含 v4 迁移旧行）/ 读失败 → None——前端回退估算（contract 注释约定：
    /// usage 域未接线时 None）。
    pub fn run_usage(&self, run_id: &str) -> Option<RunUsage> {
        let db = self.local_db()?;
        let stats = match db.get_run_usage(run_id) {
            Ok(Some(stats)) => stats,
            Ok(None) => return None,
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    run_id,
                    error = %error,
                    "get_run_usage 读失败（usage 查询回退前端估算）"
                );
                return None;
            }
        };
        // plans/05 T5.2：取价 = live yaml（当前引擎生效配置的身份键精确命中）；
        // pricing None → RunUsage.cost None = 未定价
        let pricing = self.engine.provider_config().and_then(|config| {
            config.provider_id.as_deref().and_then(|provider_id| {
                crate::pricing::live_model_pricing(provider_id, &config.model)
            })
        });
        RunUsage::from_run_cache_stats(stats, pricing.as_ref())
    }

    /// T-40（R5-D3 轮末合并接线 ④）：store 下转型取 [LocalDb]——run
    /// usage 数据面（get_run_usage / save_run_usage，runs 表 v5 列）经
    /// 此访问。
    ///
    /// 实现说明：生产路径 store 恒为 [orchestrator::persist::LocalDbStore]
    /// （main.rs 接线），经 [Store::as_local_db] 返回连接克隆（Arc +1）；
    /// 非 LocalDb 实现（InMemoryStore 测试替身）保持默认 None——usage
    /// 查询回退前端估算，不阻塞其他功能。
    pub fn local_db(&self) -> Option<LocalDb> {
        self.store.as_local_db()
    }

    /// 引擎句柄（27 方案 S5/S6 装配面访问器：run 装配块取浏览器会话槽
    /// 挂 abort 桥，browser_commands 命令面取同一进程级单例）
    pub fn engine(&self) -> Arc<EngineHandle> {
        Arc::clone(&self.engine)
    }

    /// 全局事件桥（壳层 run_ipc 回收站审计直发面；事件桥本体只读共享）
    pub fn bridge(&self) -> &EventBridge {
        &self.bridge
    }

    /// run 感知后台任务管理器（壳层测试/诊断面：owner run 归属与状态汇总）
    pub fn background(&self) -> &Arc<RunAwareBackgroundManager> {
        &self.background
    }

    /// 活动 run 注册表（壳层诊断/测试面；生产变更一律经 run 装配与收口
    /// 路径，禁止外部直接增删以守会话串行不变量）
    pub fn active_runs(&self) -> &Mutex<HashMap<String, Arc<ActiveRun>>> {
        &self.active_runs
    }

    /// 撤回边界冻结注册表（retraction_commands 与 run 事件队列共享同一
    /// 会话级实例）
    pub fn retraction_freeze(&self) -> &std::sync::Arc<session_loop::SessionFreezeRegistry> {
        &self.retraction_freeze
    }

    /// T-43：替换会话级 Summarizer 工厂（None = 无注入——不 spawn 后台
    /// 摘要任务，纯 stub awaiting 永驻，与接线前行为一致）。
    /// **生产装配点已闭环（COMPACTION-01 P0-3）**：[Self::new] 直接装配
    /// crate::engine_channels::production_summarizer_factory（真实 LLM 实现
    /// ProviderSummarizer，经 chat-completions 通道）；本 setter 保留为
    /// 测试替换槽 / 显式降级面。
    #[cfg_attr(not(test), allow(dead_code))] // 生产在 new() 内直接装配；测试替换槽
    pub fn set_summarizer_factory(
        &self,
        factory: Option<crate::engine_channels::SummarizerFactory>,
    ) {
        *self
            .summarizer_factory
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = factory;
    }

    /// T-CF-11：注入 idle 续 run 拉起器（测试替身断言判定与注入载荷；
    /// None = 恢复生产路径 [production_resume_launcher] 的缺省行为）。
    /// 壳层集成测试（scripted_mock_server 等）跨 crate 注入面。
    #[cfg_attr(not(test), allow(dead_code))] // 生产在 new() 内直接装配；测试替换槽
    pub fn set_resume_launcher(&self, launcher: Option<ResumeLauncher>) {
        *self
            .resume_launcher
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = launcher;
    }

    /// D2 §3.4（C4 锁死）：注入跨 run 续 run 退避延迟函数（测试直接驱动，
    /// 不依赖 tokio pause；注入存在时退避睡眠跳过——测试驱动模式；
    /// None = 生产镜像 recovery.rs 常量）。壳层集成测试跨 crate 注入面。
    #[cfg_attr(not(test), allow(dead_code))] // 生产缺省已装配；测试替换槽
    pub fn set_resume_backoff(&self, backoff: Option<BackoffDelayFn>) {
        *self
            .resume_backoff
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = backoff;
    }

    /// T-43：按会话解析 Summarizer（工厂注入面；无工厂 / 工厂返回 None →
    /// None——不 spawn）。per-session 实例边界（04 §7.1 隔离决议：
    /// 每会话独立 Summarizer 实例，共享 provider 客户端但无共享可变状态）。
    pub fn summarizer_for(
        &self,
        session_id: &str,
    ) -> Option<Arc<dyn conex_compaction::Summarizer>> {
        self.summarizer_factory
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(|factory| factory(session_id))
    }

    /// T-44：session_meta 配置面 → [SummaryDispatchConfig]（读取 helper；
    /// 键缺失 / 解析失败回退生产缺省——None = 生产缺省参数，与轮次 4
    /// `summary_dispatch: None` 语义一致）。
    ///
    /// 可配键（对齐 04 §9.4 T17 / 00-plan §10 轮次 6）：
    /// - `compact_summary_backoff_ms`：退避基数（JSON 数组或单数值，缺省
    ///   [1000,3000,9000]）；
    /// - `compact_summary_wall_ms`：单次调用墙钟（缺省 60000ms，P1-10）。
    /// - `compact_l1_placeholder`：L1 回退开关——**V1 启动级配置**：引擎
    ///   侧（轮次 1）已删 AgentMessage 面 L1 改 stub，运行时双态切换需
    ///   引擎支持；V1 已删除
    ///   文档化、不改变行为，预留给 V2。
    pub fn summary_dispatch_config(&self, session_id: &str) -> Option<SummaryDispatchConfig> {
        let db = self.local_db()?;
        // 仅当任一配置键存在时构造（无键 = 生产缺省 None，行为不变）
        let has_key = [
            session_loop::META_KEY_SUMMARY_BACKOFF_MS,
            session_loop::META_KEY_SUMMARY_WALL_MS,
        ]
        .iter()
        .any(|key| db.get_session_meta(key).ok().flatten().is_some());
        if !has_key {
            return None;
        }
        // L1 回退开关读取（V1 启动级：不改变行为，仅登记读取；引擎动态
        // 双态支持见 V2 挂账）
        if false {
            tracing::warn!(
                target: "run",
                session_id = session_id,
                "compact_l1_placeholder=true：旧 L1 占位符回退开关为启动级配置，V1 未接线（引擎已改中性 stub），预留给 V2"
            );
        }
        Some(SummaryDispatchConfig::from_session_meta(
            |key| db.get_session_meta(key).ok().flatten(),
            session_loop::MAX_SUMMARY_ATTEMPTS,
        ))
    }

    /// COMPACTION-01 P0-1（生产闭环）：压缩策略装配——生产恒装配（LocalDb
    /// store 存在即 Some），默认 [conex_compaction::CompactionPolicy::default]
    /// （keep_recent_tokens=20000 / min_recent_turns=2 / max_summary_tokens=
    /// 1024 / tool_pair_protection=true，常量同源），并经 session_meta 键
    /// 覆盖（读取键不实现 UI；坏值回退默认 + warn，不 panic）：
    /// - `compact_summary_max_tokens`（[conex_compaction::SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS]）
    ///   → max_summary_tokens；
    /// - `compact_keep_recent_tokens` → keep_recent_tokens（预留键）；
    /// - `compact_min_recent_turns` → min_recent_turns（预留键）。
    ///
    /// 阈值键（compact_threshold_ratio / compact_critical_ratio）属双阈值
    /// 触发面（DEEPCHECK-11 P1-6 挂账），本策略面不消费。装配后预检
    /// （maybe_compact_preflight）与溢出阶梯（compression_ladder）在生产
    /// 可触发——总闸门解除焊死。
    pub fn compaction_policy_for(
        &self,
        session_id: &str,
    ) -> Option<conex_compaction::compaction::CompactionPolicy> {
        let db = self.local_db()?;
        let policy =
            compaction_policy_from_session_meta(|key| db.get_session_meta(key).ok().flatten());
        tracing::debug!(
            target: "run",
            session_id = session_id,
            keep_recent_tokens = policy.keep_recent_tokens,
            min_recent_turns = policy.min_recent_turns,
            max_summary_tokens = policy.max_summary_tokens,
            "压缩策略装配完成（P0-1：session_meta 键覆盖 / 常量默认）"
        );
        Some(policy)
    }

    /// T-42：会话级摘要协调器（跨 run 单飞容器；注册表持有——同会话
    /// 返回同一 Arc，run 收口不摧毁任务）。config 缺省 = 生产缺省退避
    /// 参数（T-44 配置面未启用时与轮次 4 语义一致）。
    pub fn summary_coordinator_for(
        &self,
        session_id: &str,
    ) -> Arc<session_loop::SessionSummaryCoordinator> {
        let config = self.summary_dispatch_config(session_id).unwrap_or_default();
        self.summary_coordinators.get_or_create(session_id, config)
    }

    /// T-AB-19：后台任务汇总（core_get_status.backgroundTasks 数据源；
    /// 活跃任务数 / 守护进程数 / 最近终态——口径见
    /// [RunAwareBackgroundManager::summary]）
    pub async fn background_tasks_summary(&self) -> BackgroundTasksSummary {
        self.background.summary().await
    }

    /// 共享 store（查询命令 / 集成接线用）
    pub fn store(&self) -> Arc<dyn Store> {
        Arc::clone(&self.store)
    }

    /// 全局事件桥（R1-11 remote-* 审计事件发射通道：CoreStateBackend
    /// 经此拿到与 run 上下文同一 [EventBridge] 实例——远程模式降级等
    /// run 创建前动作的 security-audit 事件直发，与 emit_trash_audit
    /// 先例同通道；消费方 = server/core_backend.rs）
    pub fn event_bridge(&self) -> EventBridge {
        self.bridge.clone()
    }

    /// 30 方案 P3/P6：共享 steering 队列（与引擎
    /// [EngineHandle::timer_steering_queue] 同一实例；P6（批 3 装配轮）
    /// 经此注入 workflow 队列——消除队列双实例，对齐 [Self::store]
    /// Arc::clone 模式；消费方 = main.rs 装配轮（已接线））
    pub fn steering_queue(&self) -> Arc<Mutex<PendingMessageQueue>> {
        Arc::clone(&self.pending_queue)
    }

    /// 30 方案 P3：任务事件消费器（main.rs 装配轮接线
    /// `background_tasks.set_task_event_consumer(core_state.task_events())`——
    /// 必须在 set_event_bridge 之前调用，EventBridgeSink 构造时读取快照；
    /// 消费方 = main.rs 装配轮（已接线））
    pub fn task_events(&self) -> Arc<TaskEventConsumer> {
        Arc::clone(&self.task_events)
    }

    /// 30 方案 P6/P7：Cron 调度注册表（透传引擎句柄；None = 装配降级）。
    /// 消费方：main.rs 装配轮（P6 WorkflowBackend::set_registry）+
    /// [Self::new]（P7 cron_has_enabled 判定器装配）
    pub fn scheduler_registry(&self) -> Option<Arc<crate::sched::SchedulerRegistry>> {
        self.engine.scheduler_registry()
    }

    /// 30 方案 P4：定时器事件缓冲（壳层 drain 任务 500ms tick 取走
    /// 缓冲 → crate::engine_channels::forward_drained_timer_events 转发到
    /// 事件桥；与引擎装配实例同一 Arc）
    pub fn timer_event_sink(&self) -> Arc<crate::timers::AgentEventSink> {
        self.engine.timer_event_sink()
    }

    /// 30 方案 P4：cron 事件缓冲（同 timer 的 drain 转发路径——cron-fired
    /// 单臂，cancel 走数据面 + steering 面，无 cron-cancelled 发射目标）
    pub fn scheduler_event_sink(&self) -> Arc<crate::sched::SchedEventSink> {
        self.engine.scheduler_event_sink()
    }

    /// restore 是否完成（run_task 门禁；查询命令 restore.state 数据源）
    pub fn restore_ready(&self) -> bool {
        self.restore_ready.load(Ordering::SeqCst)
    }

    // ── T-D-13：子代理 spawner 注入面装配与终态处理 ────────────────

    /// 装配 spawner 注入面（main.rs 在 Arc 构造完成后调用）：启动器
    /// （Weak 引用本状态，run 启动走 run_task_impl 同通道）、行存储
    /// （LocalDb 下转型）、wait 通道终态广播、跨 run steering 队列
    /// （主 agent 唤醒通知落点）。
    pub fn finalize_subagent_spawner(self: &Arc<Self>) {
        let launcher: Arc<dyn crate::subagent_spawner::SubagentRunLauncher> =
            Arc::new(CoreRunStateLauncher {
                state: Arc::downgrade(self),
            });
        self.subagent_spawner.init(
            Some(launcher),
            self.local_db(),
            Some(self.engine.terminal_stream()),
            Some(Arc::clone(&self.pending_queue)),
        );
    }

    /// 子代理 run 终态处理（drive_run_loop 收口调用）：终态状态映射 →
    /// spawner 统一收口（记账释放 / 行更新 / subagent-ended 发射 / wait
    /// 通道 feed / steering 通知）。
    pub async fn on_subagent_run_terminal(
        &self,
        cfg: &crate::subagent_spawner::SubagentRunConfig,
        status: conex_db::RunStatus,
    ) {
        // T-CF-13（R-CF3）：子代理终态事件到达壳层即视为一次唤醒——
        // 等待期间的关键事件源（watchdog 失联判定数据源；长等待中
        // 子代理完成事件推进 last_wakeup，防误报"无唤醒"）
        self.engine.last_wakeup().mark_wakeup();
        let state = match status {
            conex_db::RunStatus::Completed => SubagentState::Completed,
            _ => SubagentState::Failed,
        };
        self.subagent_spawner.on_subagent_terminal(cfg, state).await;
    }
}

impl CoreRunState {
    // ── D3：C7 恢复协调器装配（维度文档 D3 §3.1/§3.5）──────────────

    /// D3 §3.1：每会话恢复协调器惰性构造（幂等——同会话同实例）。
    ///
    /// 五件套（裁决 #4 完整装配一次到位，禁占位树）：
    /// - store = LocalDb（[RecoveryStore] impl 现成，recovery.rs:622）；
    /// - queue = [Self::pending_queue]（与引擎共享队列同一 Arc，
    ///   engine.timer_steering_queue 同源）；
    /// - tree = [Self::session_trees] 查 / 无则空树（fork 结构化拒绝兜底，
    ///   recovery.rs:1066-1070）；
    /// - spawner = 生产 SubagentSpawnerImpl（Arc 宽化为 trait object，
    ///   与 fork_and_reassign 调用契约一致）；
    /// - policy = 阶梯 1 跨 run 重试 max_retries=2（V3；session_meta
    ///   `recover_ladder1_max_retries` 可配，宽容解析 fail-open）。
    ///
    /// F2-27：new 的同步读（4-5 键）经专用线程执行（std::thread::scope
    /// 承接，SQLite 工作不落在 tokio worker 上）——惰性一次性构造，进程
    /// 内每会话仅一次。local_db() 为 None（测试替身 store）→ None 降级
    /// （协调器不可用，行为与接线前一致；同步 SQLite 操作沿用
    /// save_run_usage 的专用线程隔离模式）。
    pub fn coordinator_for(
        &self,
        session_id: &str,
    ) -> Option<Arc<tokio::sync::Mutex<RecoveryCoordinator>>> {
        // 1. 快速路径：读锁命中既有实例 (L0 锁立取立释)
        {
            let map = self
                .recovery_coordinators
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(existing) = map.get(session_id) {
                return Some(Arc::clone(existing));
            }
        }
        // 2. local_db() 为 None（测试替身 store）→ None 降级
        let db = self.local_db()?;
        // 3. 五件套装配（tree 与 coordinator 同批装配）
        let tree = {
            let mut trees = self.session_trees.lock().unwrap_or_else(|e| e.into_inner());
            trees.get(session_id).cloned().unwrap_or_else(|| {
                let arc = Arc::new(Mutex::new(SessionTree::new(session_id)));
                trees.insert(session_id.to_string(), Arc::clone(&arc));
                arc
            })
        };
        let store: Arc<dyn RecoveryStore> = Arc::new(db);
        let queue = Arc::clone(&self.pending_queue);
        // Arc 宽化：生产 spawner → trait object（与 fork_and_reassign 调用
        // 契约一致；显式两步断开——编译器对 Arc::clone 的 trait object
        // 目标推断不收敛，先克隆具体类型再 as 宽化）
        let concrete = Arc::clone(&self.subagent_spawner);
        let spawner: Arc<dyn agent_tools::tools::subagent::SubagentSpawner> =
            concrete as Arc<dyn agent_tools::tools::subagent::SubagentSpawner>;
        // V3：阶梯 1 跨 run 重试次数可配键（D3 自决键；宽容解析 fail-open）
        let ladder1_max_retries = store
            .get_meta(RECOVER_LADDER1_MAX_RETRIES_KEY)
            .ok()
            .flatten()
            .and_then(|raw| raw.parse::<u32>().ok())
            .unwrap_or(RECOVER_LADDER1_MAX_RETRIES_DEFAULT);
        let policy = RecoveryRetryPolicy {
            max_retries: ladder1_max_retries,
            ..Default::default()
        };
        let session_id_owned = session_id.to_string();
        // 4. RecoveryCoordinator::new 构造（读 SQLite meta 走独立线程，不占 async worker）
        let constructed = std::thread::scope(|scope| {
            scope
                .spawn(move || {
                    RecoveryCoordinator::new(session_id_owned, store, queue, tree, spawner, policy)
                })
                .join()
        })
        .unwrap_or_else(|join_error| {
            Err(RecoveryError::PersistFailed {
                message: format!("恢复协调器构造线程 join 失败：{join_error:?}"),
            })
        });
        let coord = match constructed {
            Ok(coordinator) => Arc::new(tokio::sync::Mutex::new(coordinator)),
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    session_id,
                    error = %error,
                    "恢复协调器构造失败（本会话恢复路径降级为接线前行为）"
                );
                return None;
            }
        };
        // 5. double-check 插入：并发双构造时丢弃后到者
        let mut map = self
            .recovery_coordinators
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = map.get(session_id) {
            return Some(Arc::clone(existing));
        }
        map.insert(session_id.to_string(), Arc::clone(&coord));
        Some(coord)
    }
}

impl CoreRunState {
    /// 子代理生命周期服务（T-D-09：kill_all / resume_subagent 命令面
    /// 依赖；db 与 [orchestrator::lifecycle::ForceCancelSink]（本状态实现）
    /// 装配；LocalDb 不可用（测试替身 store）→ None）。审计 01 W1：
    /// kill_subagent 工具通道（[Self::kill_subagent_via_lifecycle]）生产
    /// 消费——T-D-12 陈旧 dead_code 豁免已删除（D4 A5/T7b）
    pub fn lifecycle_service(
        self: &Arc<Self>,
    ) -> Option<orchestrator::lifecycle::SubagentLifecycleService> {
        let db = self.local_db()?;
        // Arc 宽化：CoreRunState 实现 ForceCancelSink → trait object 引用
        // （先克隆具体类型再宽化——编译器对 Arc::clone 的 trait object
        // 目标推断不收敛，显式两步断开）
        let this: Arc<CoreRunState> = Arc::clone(self);
        let control: Arc<dyn orchestrator::lifecycle::ForceCancelSink> = this;
        Some(orchestrator::lifecycle::SubagentLifecycleService::new(
            Arc::new(db),
            control,
        ))
    }
}

impl CoreRunState {
    /// 最近快照代数（查询命令 snapshot.generation 数据源）
    pub fn snapshot_generation(&self) -> u64 {
        self.snapshot_generation.load(Ordering::SeqCst)
    }

    /// 快照保存失败标记（P16：查询命令 snapshot.lastError 数据源）
    pub fn snapshot_last_error(&self) -> Option<String> {
        self.snapshot_last_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

impl CoreRunState {
    /// 会话级序列号 base（T08.8：预热命中缓存；未预热按库内 max+1 懒计算，
    /// 不重置为 1）
    pub async fn base_sequence_for(&self, session_id: &str) -> u64 {
        if let Some(next) = self
            .next_sequences
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .copied()
        {
            return next;
        }
        let max = self
            .store
            .query_events(session_id, 0, None)
            .await
            .map(|events| events.iter().map(|e| e.sequence).max().unwrap_or(0))
            .unwrap_or(0);
        let next = max + 1;
        self.next_sequences
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.to_string(), next);
        next
    }

    /// T08.8：恢复结果注入——逐会话预热序列号（库内 max(sequence)+1，
    /// 审计事件已落库口径自然含之；MAX 语义幂等）
    pub async fn seed_sequences(&self, outcome: &RestoreOutcome) {
        let sequencer = SessionSequencer::new(self.store.clone());
        for session in &outcome.sessions {
            let max = self
                .store
                .query_events(&session.session_id, 0, None)
                .await
                .map(|events| events.iter().map(|e| e.sequence).max().unwrap_or(0))
                .unwrap_or(0);
            let next = max + 1;
            if let Err(error) = sequencer.seed(&session.session_id, next).await {
                tracing::warn!(
                    target: "restore",
                    session_id = %session.session_id,
                    error = %error,
                    "seed_sequence 失败（base_sequence_for 懒计算兜底）"
                );
            }
            // 预热缓存写入（锁仅覆盖短临界区，不跨 await 持有——AA-02 并发模型）
            self.next_sequences
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session.session_id.clone(), next);
        }
    }
}

// ── T-D-13：子代理 run 启动器（Weak 引用切断 CoreRunState 类型递归）──

/// 子代理 run 启动器生产实现：经 [crate::subagent_spawner::SubagentRunLauncher]
/// trait object 调用 [run_task_impl]（core_run_task 同通道）——spawner 在
/// CoreRunState 内（engine 注入面），run 启动回调 CoreRunState，Weak 引用
/// 避免 Arc 循环强引用（进程级单例，Weak 升级失败为启动器未装配兜底）。
#[derive(Debug)]
pub struct CoreRunStateLauncher {
    /// 状态弱引用（finalize 装配时注入；主进程存活期恒可升级）
    pub state: std::sync::Weak<CoreRunState>,
}

impl CoreRunState {
    /// 活动 run 的权限单元（父链继承/运行时切换的单一访问点）。
    pub fn permission_cell_for_run(
        &self,
        run_id: &str,
    ) -> Option<Arc<conex_agents::permission::PermissionCell>> {
        self.active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(run_id)
            .map(|run| Arc::clone(&run.permission))
    }

    /// 活动 run 的能力单元（父级授权/降级的访问点）。
    pub fn capability_cell_for_run(
        &self,
        run_id: &str,
    ) -> Option<Arc<conex_agents::capability::CapabilityCell>> {
        self.active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(run_id)
            .map(|run| Arc::clone(&run.capability))
    }

    /// 主 agent 授予/收窄子代理能力（运行中即时生效，下一批次 gate 读取）。
    ///
    /// `agent_or_run` 接受 subagent_id 或 subagent_run_id；未知目标返回 NotFound。
    pub fn grant_subagent_capability(
        &self,
        session_id: &str,
        agent_or_run: &str,
        mode: conex_agents::task::SubagentCapabilityMode,
    ) -> Result<(), CoreError> {
        let cell = {
            let active = self.active_runs.lock().unwrap_or_else(|e| e.into_inner());
            active
                .get(agent_or_run)
                .filter(|run| {
                    run.subagent
                        .as_ref()
                        .is_none_or(|config| config.parent_session_id == session_id)
                })
                .or_else(|| {
                    active.values().find(|run| {
                        run.subagent.as_ref().is_some_and(|config| {
                            config.parent_session_id == session_id
                                && (config.subagent_id == agent_or_run
                                    || config.subagent_run_id == agent_or_run)
                        })
                    })
                })
                .map(|run| Arc::clone(&run.capability))
        };
        let mut found = cell.is_some();
        if let Some(cell) = cell {
            cell.set(mode);
        }
        // 持久化能力快照（跨重启保留；运行中/终态行都可更新）
        if let Some(db) = self.local_db() {
            let affected = db
                .update_session_agent_capability(session_id, agent_or_run, mode.as_str())
                .map_err(|error| CoreError::internal(format!("能力快照落库失败：{error}")))?;
            found |= affected > 0;
        }
        if !found {
            return Err(CoreError::NotFound(format!(
                "subagent not found: {agent_or_run}"
            )));
        }
        Ok(())
    }

    /// 运行时切换 run 模型（`None` = 跟随引擎默认；下一 turn 生效）。
    pub fn set_run_model(
        &self,
        run_id: &str,
        model: Option<String>,
    ) -> Result<(), CoreError> {
        let cell = self
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(run_id)
            .map(|run| Arc::clone(&run.model))
            .ok_or_else(|| CoreError::NotFound(format!("run not found: {run_id}")))?;
        match model {
            Some(model) if !model.trim().is_empty() => cell.set(model),
            _ => cell.clear(),
        }
        Ok(())
    }

    /// 按子代理 id / run id 切换模型（主 agent `switch_agent_model` 入口）。
    ///
    /// 运行中：更新 `ModelCell`（下一 turn 生效）；无论是否运行中，都同步
    /// 落库 `model_override`，供重启恢复/重派使用（`None` = 清除覆盖）。
    pub fn set_subagent_model(
        &self,
        session_id: &str,
        agent_or_run: &str,
        model: Option<String>,
    ) -> Result<(), CoreError> {
        let cell = {
            let active = self.active_runs.lock().unwrap_or_else(|e| e.into_inner());
            active
                .get(agent_or_run)
                .filter(|run| {
                    run.subagent
                        .as_ref()
                        .is_none_or(|config| config.parent_session_id == session_id)
                })
                .or_else(|| {
                    active.values().find(|run| {
                        run.subagent.as_ref().is_some_and(|config| {
                            config.parent_session_id == session_id
                                && (config.subagent_id == agent_or_run
                                    || config.subagent_run_id == agent_or_run)
                        })
                    })
                })
                .map(|run| Arc::clone(&run.model))
        };
        let mut found = cell.is_some();
        match (&cell, &model) {
            (Some(cell), Some(model)) if !model.trim().is_empty() => cell.set(model.clone()),
            (Some(cell), _) => cell.clear(),
            _ => {}
        }
        if let Some(db) = self.local_db() {
            let affected = db
                .update_session_agent_model(session_id, agent_or_run, model.as_deref())
                .map_err(|error| CoreError::internal(format!("模型覆盖落库失败：{error}")))?;
            found |= affected > 0;
        }
        if !found {
            return Err(CoreError::NotFound(format!(
                "subagent not found: {agent_or_run}"
            )));
        }
        Ok(())
    }

    /// 运行时切换 run 权限（主 agent 当前 run 生效；子代理经父链自动跟随）。
    pub fn set_run_permission_mode(
        &self,
        run_id: &str,
        mode: conex_types::PermissionMode,
    ) -> Result<(), CoreError> {
        let cell = self
            .permission_cell_for_run(run_id)
            .ok_or_else(|| CoreError::NotFound(format!("run not found: {run_id}")))?;
        cell.set(mode);
        Ok(())
    }

    /// 运行时按会话切换主 run 权限（桌面 UI 入口；子代理活单元经父链
    /// 自动同步，无需逐个广播）。无活动主 run → NotFound（UI 仅作
    /// fire-and-forget，忽略即可）。
    pub fn set_session_permission_mode(
        &self,
        session_id: &str,
        mode: conex_types::PermissionMode,
    ) -> Result<(), CoreError> {
        let cells: Vec<Arc<conex_agents::permission::PermissionCell>> = {
            let active = self.active_runs.lock().unwrap_or_else(|e| e.into_inner());
            active
                .values()
                .filter(|run| run.session_id == session_id && run.subagent.is_none())
                .map(|run| Arc::clone(&run.permission))
                .collect()
        };
        if cells.is_empty() {
            return Err(CoreError::NotFound(format!(
                "no active run for session: {session_id}"
            )));
        }
        for cell in cells {
            cell.set(mode);
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl crate::subagent_spawner::SubagentRunLauncher for CoreRunStateLauncher {
    async fn launch(&self, options: RunTaskOptions) -> Result<RunTaskResponse, CoreError> {
        let state = self.state.upgrade().ok_or_else(|| {
            CoreError::internal("子代理 run 启动失败：CoreRunState 已释放（启动器弱引用失效）")
        })?;
        run_task_impl(state, options).await
    }

    fn get_active_run_permission_mode(&self, run_id: &str) -> Option<conex_types::PermissionMode> {
        let state = self.state.upgrade()?;
        let active_runs = state.active_runs.lock().ok()?;
        active_runs
            .get(run_id)
            .map(|r| r.permission.effective())
    }
}

// ── T-D-09/T-D-13：ForceCancelSink 接线（kill_all 的引擎侧实现）────

/// L3 强停投递（[orchestrator::lifecycle::ForceCancelSink]）：按
/// subagent_run_id 定位活动 run 的控制总线，投递 L3 `request_force_cancel`
/// （reason 携带 `subagent_force_cancel:<run_id>` 可观测标识）；无该 run
/// 的运行实例（已终态 / 重启后未恢复）→ false（调用方按未终态汇总）。
impl orchestrator::lifecycle::ForceCancelSink for CoreRunState {
    fn request_force_cancel(&self, subagent_run_id: &str, reason: &str) -> bool {
        let active = self.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        let Some(run) = active.get(subagent_run_id) else {
            return false;
        };
        // std Mutex 不跨 await 持有：投递为同步调用，锁在语句内释放
        run.control_bus
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .request_subagent_force_cancel(subagent_run_id, Some(reason));
        true
    }
}

// ── 审计 01 W1：任务连续性三通道生产接线（kill_subagent / send_message
//    工具面）────────────────────────────────────────────────────────

/// 任务连续性通道的状态适配器：以 Weak 引用切断「CoreRunState → 引擎
/// → ContinuityChannelBoard → CoreRunState」强引用环（CoreRunStateLauncher
/// 先例 :4011 同款——引擎在 CoreRunState 内，板卡在引擎内，强引用即
/// 环）。进程内 CoreRunState 恒存活（main.rs app.manage），upgrade 失败
/// 仅为防御面（结构化错误上抛，不 panic）。
///
/// 四契约合一（[ControlBusResolver] / [SubagentKillChannel] /
/// [SubagentInjectChannel] / [MainAgentMessageChannel]），经
/// [CoreRunState::finalize_continuity_channels] 绑定到引擎板卡。
pub struct ContinuityStateAdapter {
    /// 本状态弱引用（恒存活；upgrade 失败 → 结构化错误）
    pub state: std::sync::Weak<CoreRunState>,
}

impl std::fmt::Debug for ContinuityStateAdapter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContinuityStateAdapter")
            .finish_non_exhaustive()
    }
}

impl CoreRunState {
    /// 按子代理 id 解析活动 run 的控制总线（send_message target=subagent
    /// 与 wait 期间 inject 共用的解析器真源）。
    ///
    /// active_runs 扫描（子代理配置 subagent_id 匹配）：活动集受
    /// 16/16/1 守卫约束（主 run 1 + 子代理 ≤16），O(n) 平凡——不引入
    /// 第二份 subagent_id → run_id 映射表（id 已在 ActiveRun.subagent
    /// 装配配置内，扫描即真源）。
    pub fn control_bus_for_subagent(&self, subagent_id: &str) -> Option<Arc<Mutex<ControlBus>>> {
        let active = self.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        active
            .values()
            .find(|run| {
                run.subagent.as_ref().map(|cfg| cfg.subagent_id.as_str()) == Some(subagent_id)
            })
            .map(|run| Arc::clone(&run.control_bus))
    }

    /// 会话主 agent run 的控制总线（send_message target=self 的 followUp/
    /// steer 环目标）：活动 run 中 subagent=None（普通 run）且会话匹配。
    /// 会话内单活动 run 串行守卫下至多命中一条；无匹配（run 已收口）→
    /// None，调用方转 PendingMessageQueue 兜底。
    pub fn main_run_bus_for_session(&self, session_id: &str) -> Option<Arc<Mutex<ControlBus>>> {
        let active = self.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        active
            .values()
            .find(|run| run.subagent.is_none() && run.session_id == session_id)
            .map(|run| Arc::clone(&run.control_bus))
    }

    /// kill_subagent 终止通道真实现：经 SubagentLifecycleService（LocalDb
    /// 下转 + 本状态 ForceCancelSink）投递 L3 强停 + 行归一 failed；
    /// 同步 SQLite 段经 spawn_blocking 包裹（F2-27，命令面同步调用面
    /// 不落在 tokio worker 上——D4 §3.9 全表）。
    pub async fn kill_subagent_via_lifecycle(
        self: &Arc<Self>,
        session_id: &str,
        subagent_id: &str,
        reason: &str,
    ) -> Result<KillSubagentToolResult, String> {
        let service = self.lifecycle_service().ok_or_else(|| {
            "kill_subagent 未接线：LocalDb 不可用（生命周期服务未装配）".to_string()
        })?;
        let (sid, aid, r) = (
            session_id.to_string(),
            subagent_id.to_string(),
            reason.to_string(),
        );
        let result = tokio::task::spawn_blocking(move || service.kill_subagent(&sid, &aid, &r))
            .await
            .map_err(|e| format!("kill_subagent 阻塞任务失败：{e}"))?
            .map_err(|e| e.to_string())?;
        Ok(KillSubagentToolResult {
            subagent_id: result.subagent_id,
            subagent_run_id: Some(result.subagent_run_id),
            outcome: match result.outcome {
                "killed" => KillOutcomeKind::Killed,
                _ => KillOutcomeKind::AlreadyTerminal,
            },
            force_cancel_delivered: result.force_cancel_delivered,
        })
    }

    /// send_message 子代理注入真实现：定位目标 run 控制总线 →
    /// `request_subagent_inject`（L1 steer 环，reason=`subagent_inject:<id>`，
    /// 不打断子代理流——与 wait 期间 inject 同通道同语义）；目标不可达
    /// → 结构化失败（不静默、不 panic）。
    pub async fn inject_to_subagent(&self, subagent_id: &str, message: &str) -> Result<(), String> {
        let Some(bus) = self.control_bus_for_subagent(subagent_id) else {
            return Err(format!(
                "目标子代理 {subagent_id} 的 run 控制总线不可达（无运行实例）"
            ));
        };
        // std Mutex 不跨 await 持有：注入为同步调用，锁在语句内释放
        bus.lock()
            .unwrap_or_else(|e| e.into_inner())
            .request_subagent_inject(subagent_id, message, Some("send_message_tool"));
        tracing::info!(
            target: "run",
            subagent_id,
            "send_message(target=subagent) 已送达目标 run 的 L1 steer 环"
        );
        Ok(())
    }

    /// send_message 主 agent 消息真实现（会话留档 + 入队一体完成）：
    ///
    /// 1. 构造 user 角色文本消息，metadata `{source:"main-agent"}`（与
    ///    用户消息区分——用户消息无 source 字段）；**不标记 user_touched**
    ///    （主 agent 自发消息不算用户交互，收口不因此抑制 idle 续 run）；
    /// 2. 当前 run 存活 → 经主 run 自己 ControlBus 入环：FollowUp →
    ///    `request_follow_up`（仅 idle promote 消费，不打断当前 run）；
    ///    Steer → `request_steer`（下一安全点注入，当前 run 继续）；
    /// 3. run 已收口（工具调用在收口后被重放等边角）→ PendingMessageQueue
    ///    入队 steering 条目（group_id=`main-agent-msg`，下一 run
    ///    decide_idle_resume 队列源消费——消息带 kind=steering（枚举
    ///    标记，来源标记以队列条目承载）。
    ///
    /// 会话留档语义：消息随 run 对话进入事件流与会话历史（运行中入环的
    /// 消息即 run 对话的一部分，收口原子替换进 SessionHistoryCache）。
    pub async fn deliver_main_agent_message(
        &self,
        session_id: &str,
        message: &str,
        ring: MainMessageRing,
    ) -> Result<String, String> {
        // 1. 构造留档消息（id 唯一、metadata 来源标记）
        let mut injected = crate::engine_provider::user_message(message, None);
        injected.id = crate::engine_provider::new_message_id("main-agent-msg");
        injected.metadata = Some(serde_json::json!({ "source": "main-agent" }));
        let message_id = injected.id.clone();
        // 2. 当前主 run 存活 → 经其控制总线入环（不打断当前 run）
        if let Some(bus) = self.main_run_bus_for_session(session_id) {
            let mut bus = bus.lock().unwrap_or_else(|e| e.into_inner());
            match ring {
                MainMessageRing::Steer => {
                    bus.request_steer(
                        injected,
                        Some("send_message_tool".to_string()),
                        Some("main-agent".to_string()),
                    );
                }
                MainMessageRing::FollowUp => {
                    bus.request_follow_up(
                        injected,
                        Some("send_message_tool".to_string()),
                        Some("main-agent".to_string()),
                    );
                }
            }
            tracing::info!(
                target: "run",
                session_id,
                ring = ring.as_str(),
                "send_message(target=self) 已入主 run 控制总线（会话留档 + 环注入）"
            );
            return Ok(message_id);
        }
        // 3. run 已收口 → PendingMessageQueue 兜底（下一 run 队列源消费）
        let entry = orchestrator::steering_queue::SteeringInputEntry {
            session_id: session_id.to_string(),
            id: message_id.clone(),
            text: message.to_string(),
            attachments: Vec::new(),
            enqueued_at: now_ms_internal(),
            group_id: Some("main-agent-msg".to_string()),
            is_steering: true,
        };
        self.pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace_or_enqueue(entry);
        tracing::info!(
            target: "run",
            session_id,
            "send_message(target=self) 已入队 PendingMessageQueue（run 已收口兜底）"
        );
        Ok(message_id)
    }

    /// 审计 01 W1：任务连续性三通道生产装配（main.rs 在 Arc 构造完成后
    /// 调用，与 [Self::finalize_subagent_spawner] 同批）——把本状态的
    /// 四契约实现（ControlBusResolver / 三通道）经 [ContinuityStateAdapter]
    /// 绑定进引擎 [crate::engine::ContinuityChannelBoard]：
    ///
    /// - WaitChannel 的 inject 面（wait_subagents 运行中注入）从生产
    ///   NoopControlBusResolver 升级为真实解析（活动 run 注册表）；
    /// - kill_subagent / send_message 两工具从「通道未绑定错误」升级为
    ///   生产可用（三决策闭环工具侧闭合）。
    pub fn finalize_continuity_channels(self: &Arc<Self>) {
        let adapter = Arc::new(ContinuityStateAdapter {
            state: Arc::downgrade(self),
        });
        let board = self.engine.continuity();
        board.bind_control_bus(Arc::clone(&adapter) as Arc<dyn ControlBusResolver>);
        board.bind_kill(Arc::clone(&adapter) as Arc<dyn SubagentKillChannel>);
        board.bind_inject(Arc::clone(&adapter) as Arc<dyn SubagentInjectChannel>);
        board.bind_capability_grant(Arc::clone(&adapter) as Arc<dyn agent_tools::tools::grant_capability::SubagentCapabilityGrantChannel>);
        board.bind_model_switch(Arc::clone(&adapter) as Arc<dyn agent_tools::tools::switch_agent_model::SubagentModelChannel>);
        board.bind_self_message(adapter as Arc<dyn MainAgentMessageChannel>);
        tracing::info!(
            target: "engine",
            "任务连续性三通道生产装配完成（kill_subagent / send_message 工具已接线；WaitChannel 控制总线解析器已升级）"
        );
    }
}

impl ControlBusResolver for ContinuityStateAdapter {
    fn control_bus(&self, subagent_id: &str) -> Option<Arc<Mutex<ControlBus>>> {
        self.state.upgrade()?.control_bus_for_subagent(subagent_id)
    }
}

#[async_trait::async_trait]
impl SubagentKillChannel for ContinuityStateAdapter {
    async fn kill_subagent(
        &self,
        session_id: &str,
        subagent_id: &str,
        reason: &str,
    ) -> Result<KillSubagentToolResult, String> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| "CoreRunState 已释放（进程内恒存活，防御面）".to_string())?;
        state
            .kill_subagent_via_lifecycle(session_id, subagent_id, reason)
            .await
    }
}

#[async_trait::async_trait]
impl SubagentInjectChannel for ContinuityStateAdapter {
    async fn inject(&self, subagent_id: &str, message: &str) -> Result<(), String> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| "CoreRunState 已释放（进程内恒存活，防御面）".to_string())?;
        state.inject_to_subagent(subagent_id, message).await
    }
}

impl agent_tools::tools::grant_capability::SubagentCapabilityGrantChannel
    for ContinuityStateAdapter
{
    fn grant(
        &self,
        session_id: &str,
        agent_or_run: &str,
        capability: conex_agents::task::SubagentCapabilityMode,
    ) -> Result<(), String> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| "CoreRunState 已释放（进程内恒存活，防御面）".to_string())?;
        state
            .grant_subagent_capability(session_id, agent_or_run, capability)
            .map_err(|error| error.to_string())
    }
}

impl agent_tools::tools::switch_agent_model::SubagentModelChannel for ContinuityStateAdapter {
    fn switch(
        &self,
        session_id: &str,
        agent_or_run: &str,
        model: Option<String>,
    ) -> Result<(), String> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| "CoreRunState 已释放（进程内恒存活，防御面）".to_string())?;
        state
            .set_subagent_model(session_id, agent_or_run, model)
            .map_err(|error| error.to_string())
    }
}

#[async_trait::async_trait]
impl MainAgentMessageChannel for ContinuityStateAdapter {
    async fn deliver_self(
        &self,
        session_id: &str,
        message: &str,
        ring: MainMessageRing,
    ) -> Result<String, String> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| "CoreRunState 已释放（进程内恒存活，防御面）".to_string())?;
        state
            .deliver_main_agent_message(session_id, message, ring)
            .await
    }
}

pub async fn write_back_cache_stats(
    state: &CoreRunState,
    session_id: &str,
    run_id: &str,
    project_name: &str,
    stats: RunCacheStats,
) {
    // USD → CNY 折算率：与 conex-db legacy 导入口径一致（仪表盘只汇总 cost_cny）
    const USD_TO_CNY_RATE: f64 = 7.25;

    let cache_config = state.engine.cache_tracking_config();
    if let Some(config) = cache_config.as_ref() {
        state
            .engine
            .update_cache_session(session_id, &stats, &config.model);
    } else {
        tracing::warn!(
            target: "run",
            run_id,
            "收口缓存统计但缓存跟踪配置缺失（跳过会话级状态写回）"
        );
    }

    let Some(db) = state.local_db() else {
        return;
    };

    // 主轨落库（03 §3.2）：run 收口即写 usage_records——覆盖桌面 UI、
    // 手机端与定时任务发起的全部 run，不依赖前端 chat-stream 回调。
    let provider_config = state.engine.provider_config();
    let model = provider_config
        .as_ref()
        .map(|config| config.model.clone())
        .or_else(|| cache_config.as_ref().map(|config| config.model.clone()))
        .unwrap_or_else(|| "default".to_string());
    let provider = provider_config
        .as_ref()
        .and_then(|config| config.provider_id.clone())
        .unwrap_or_default();
    let pricing = provider_config.as_ref().and_then(|config| {
        config.provider_id.as_deref().and_then(|provider_id| {
            crate::pricing::live_model_pricing(provider_id, &config.model)
        })
    });
    let usage_record = crate::core_query::RunUsage::from_run_cache_stats(stats, pricing.as_ref())
        .map(|usage| {
            let (cost_cny, cost_usd) = match usage.cost.as_ref() {
                Some(cost) if !cost.is_free => {
                    let amount = cost.total_as_f64();
                    match cost.currency {
                        agent_provider::pricing::Currency::Cny => (amount, 0.0),
                        agent_provider::pricing::Currency::Usd => {
                            (amount * USD_TO_CNY_RATE, amount)
                        }
                    }
                }
                _ => (0.0, 0.0),
            };
            conex_db::InsertUsageRecordInput {
                session_id: session_id.to_string(),
                run_id: Some(run_id.to_string()),
                project_name: project_name.to_string(),
                model,
                provider,
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                cache_read_tokens: usage.cache_read_tokens.unwrap_or(0),
                cache_write_tokens: usage.cache_write_tokens.unwrap_or(0),
                cost_cny,
                cost_usd,
                timestamp: conex_shared::time::unix_millis() as i64,
            }
        });

    let run_id_owned = run_id.to_string();
    let write_result = tokio::task::spawn_blocking(move || {
        let save = db.save_run_usage(&run_id_owned, stats);
        if let Some(record) = usage_record {
            // 幂等守卫：run 级最多一条（收口重入 / 重试不得重复计费）
            match db.usage_record_exists_for_run(&run_id_owned) {
                Ok(true) => {}
                Ok(false) => {
                    if let Err(failure) = db.insert_usage_record(record) {
                        tracing::warn!(
                            target: "run",
                            run_id = %run_id_owned,
                            error = %failure,
                            "usage_records 落库失败（设置 · 用量页将缺少本 run）"
                        );
                    }
                }
                Err(failure) => {
                    tracing::warn!(
                        target: "run",
                        run_id = %run_id_owned,
                        error = %failure,
                        "usage_records 幂等检查失败（跳过本 run 用量写入）"
                    );
                }
            }
        }
        save
    })
    .await;
    match write_result {
        Ok(Ok(())) => {}
        Ok(Err(failure)) => {
            tracing::warn!(
                target: "run",
                run_id,
                error = %failure,
                "save_run_usage 落库失败（usage 查询回退前端估算）"
            );
        }
        Err(join_error) => {
            tracing::warn!(
                target: "run",
                run_id,
                error = %join_error,
                "save_run_usage spawn_blocking join 失败（usage 查询回退前端估算）"
            );
        }
    }
}

/// D5 §3.9 / D1 §3.2.2：壳层事件发射统一入口（入队持久化 + 信封 emit；
/// sequence 由 EventQueue 会话级原子分配）。goal-* 与熔断观测事件
/// （runtime-intervention-required / recovery-escalated）共用本通道——
/// envelope 带 runId + sequence（前端投影消费，02-定夺 B2）。
pub async fn emit_envelope_event(
    queue: &Arc<tokio::sync::Mutex<EventQueue>>,
    bridge: &Arc<BufferedRunEventBridge>,
    run_id: &str,
    session_id: &str,
    event: AgentEvent,
) {
    let mut queue = queue.lock().await;
    if let Ok(sequenced) = queue.push(session_id, event).await {
        // NoPersist 事件（delta 等）没有真实序列号：信封不得携带占位的
        // last_reserved（前端按 type:sequence 去重会把同类型增量误吞）。
        let sequence = sequenced.persisted.then_some(sequenced.sequence);
        let envelope = AgentEventEnvelope::new(sequenced.event, Some(run_id.to_string()), sequence);
        bridge.emit(&envelope);
        bridge.flush();
    }
}

#[cfg(test)]
mod phase_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn execution_phase_transitions_and_lease_calculation() {
        let store = Arc::new(orchestrator::persist::InMemoryStore::new());
        let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
            store.clone(),
            0,
            None,
        )));
        let bus = Arc::new(Mutex::new(ControlBus::new()));
        let abort = AbortSignal::new();
        /// 记录型发射器（事件桥测试替身）
        #[derive(Default)]
        struct TestRecordingEmitter(Mutex<Vec<String>>);

        impl crate::core_event_bridge::Emitter for TestRecordingEmitter {
            fn emit(&self, _channel: &str, payload: &str) {
                self.0.lock().unwrap().push(payload.to_string());
            }
        }

        let emitter = Arc::new(TestRecordingEmitter::default());
        let bridge = Arc::new(BufferedRunEventBridge::new(
            EventBridge::new("test", emitter),
            "r1",
        ));
        let handle = Arc::new(tokio::sync::Mutex::new(RunHandle::new(
            "r1",
            "s1",
            conex_db::RunStatus::Running,
        )));
        let approval = Arc::new(ApprovalGateImpl::new(
            "r1".to_string(),
            "s1".to_string(),
            None,
            Box::new(|_| {}),
            Arc::clone(&handle),
            store,
            None,
        ));

        let active = ActiveRun::new(
            "s1".to_string(),
            "r1".to_string(),
            handle,
            queue,
            bus,
            abort,
            approval,
            bridge,
            false,
            None,
            None,
            conex_types::PermissionMode::default(),
            String::new(),
        );

        // 初始为 Active 态且无租约
        assert_eq!(active.suspended_until_ms(), None);
        let initial_heartbeat = active.last_heartbeat_ms.load(Ordering::Relaxed);
        assert!(initial_heartbeat > 0);

        // 进入 429 挂起租约
        let before_suspend = conex_shared::time::unix_millis() as u64;
        let sleep_duration = Duration::from_millis(5000);
        active.enter_suspended_phase(
            sleep_duration,
            SuspensionReason::RateLimitBackoff {
                retry_after_ms: Some(5000),
                elapsed_ms: 100,
                total_budget_ms: 60000,
            },
        );

        let until_ms = active
            .suspended_until_ms()
            .expect("处于挂起态需返回到期时间戳");
        assert!(until_ms >= before_suspend + 5000);
        assert!(active.last_heartbeat_ms.load(Ordering::Relaxed) >= before_suspend);

        // 恢复为活跃态
        active.enter_active_phase();
        assert_eq!(active.suspended_until_ms(), None);

        // 终结态
        active.terminate_phase();
        assert_eq!(*active.phase.read().unwrap(), ExecutionPhase::Terminated);
    }
}
