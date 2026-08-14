//! run/run_launch.rs（SR-02 · 拆分 · ≠ EL）
//!
//! 经 run/mod.rs 聚合接线；顶层符号 pub(crate) 化供兄弟模与门面 re-export。
use super::*;
///
/// - runtime-error 事件（持久化，03 §2.4 四源失败收口）；
/// - run 标记 failed（event-store-write-failed 语义，不假装可回放）；
/// - 终态事件尽力发出（run-terminal 唯一终态，03 §5.2-2）；
/// - lastError 写入（T04.5-1：finalize_failed 写入点）。
pub(crate) async fn finalize_failed(state: &Arc<CoreRunState>, active: &ActiveRun, message: &str) {
    // T-ESC-03：失败收口兜底停止监视 + flush（drive 错误分支已收口
    // 时此处幂等跳过——句柄经 take 已取出）
    let escape_handle = active
        .escape_watch
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(mut handle) = escape_handle {
        handle.shutdown().await;
    }

    let session_id = active.session_id.clone();
    let run_id = active.run_id.clone();
    let mut run = active.handle.lock().await;
    let mut queue = active.queue.lock().await;

    // runtime-error 事件（持久化）
    let _ = queue
        .push(
            &session_id,
            AgentEvent::RuntimeError {
                session_id: session_id.clone(),
                timestamp: crate::engine::now_iso_utc(),
                error: message.to_string(),
                retryable: None,
            },
        )
        .await;

    // run 标记 failed（不假装可回放）
    if let Err(error) = run.fail_event_store(queue.store(), message).await {
        tracing::error!(
            target: "run",
            error = %error,
            "finalize_failed：fail_event_store 失败"
        );
    }

    // 终态事件尽力发出（唯一终态事件）
    let terminal = build_run_terminal(&run, RunTerminalStatus::Failed, Some(message.to_string()));
    let sequenced = queue.push_terminal_best_effort(&session_id, terminal).await;
    let envelope = AgentEventEnvelope::new(
        sequenced.event,
        Some(run_id.clone()),
        Some(sequenced.sequence),
    );
    active.bridge.emit(&envelope);
    active.bridge.flush();

    // lastError（T04.5-1 写入点）
    state
        .diagnostics
        .set_last_error(crish_payload_from_message(message));

    drop(queue);
    drop(run);
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&run_id);
    // 15-T-6（裁决 D9）：失败收口同样注销工具级审计路由（防泄漏；
    // drive 错误分支未走 drive_run_loop 正常收口，本处兜底——重复
    // 注销幂等）
    state.engine.audit_sink().unregister(&session_id);
    // L4（F12）：失败收口同样排空审计落库 worker（注销即释放桥引用
    // 发出通道关闭信号；await 保证失败收口前审计底账完整落库；
    // None = 测试驱动路径未装配）。先 take 出句柄再 await：
    // std Mutex 锁不跨 await 持有（AA-02）
    let audit_worker = active
        .audit_persist
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(handle) = audit_worker {
        let _ = handle.await;
    }
    // T-AB-19 失败收口显式接线（与成功收口同一契约）：不清理后台任务
    // 注册表、不级联杀任务——任务属会话级；仅释放「当前 run」上下文。
    state.background.clear_current_run(&run_id);
    // T-D-13：spawner 侧 run 上下文释放 + 子代理终态收口（防御性失败
    // 路径同样归一 failed——记账释放 / 行更新 / 事件发射 / 通知面）
    state.subagent_spawner.clear_current_run(&active.session_id, &run_id);
    if let Some(cfg) = active.subagent.clone() {
        state
            .on_subagent_run_terminal(&cfg, conex_db::RunStatus::Failed)
            .await;
    }
    state.save_snapshot_now().await;
}

/// 错误文案 → CrishErrorPayload（lastError 槽载荷；77 码显式兜底）
pub(crate) fn crish_payload_from_message(message: &str) -> CrishErrorPayload {
    CrishError::new(codes::COMMON_UNKNOWN, message.to_string()).to_error_payload(0)
}

/// 活动 run 查找（命令入口共用）
pub(crate) fn active_run(state: &CoreRunState, run_id: &str) -> Result<Arc<ActiveRun>, CoreError> {
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(run_id)
        .cloned()
        .ok_or_else(|| CoreError::NotFound(format!("run 不存在或已终态：{run_id}")))
}

/// 逃逸监视根解析（30-P5 共用 helper，与 loop 装配块 with_options 解析链
/// 同源：workspace_root → cwd → 当前目录；壳层 workspace_root 恒 None，
/// 等效 cwd → current_dir）。
///
/// run 装配面的三处根解析共用本函数（单一真源，杜绝双处漂移复发——
/// 00 风险 2）：逃逸监视 spawn 根 / 共享写路径注册表根 / 子代理沙箱根。
/// None（无 cwd）时监视不启动、注册表以 current_dir 为根、run 装配不
/// panic（E2E-3 无 cwd 分支）。
pub(crate) fn resolve_escape_watch_root(cwd: Option<&str>) -> PathBuf {
    cwd.map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

// ── 命令：core_run_task ───────────────────────────────────────────

/// 发起一次 run（03 §3.2 A 组；返回 {runId, sessionId} 回执）
///
/// 流程：门禁（restore 完成 + engine 就绪 + 会话内串行）→ start_run →
/// EventQueue（base = 预热/懒计算 max+1，T08.8）→ 装配
/// （approval 门 / BridgeDeltaSink / SessionLoopProducer）→ spawn
/// [drive_run_loop]。system_prompt 入站经 build_system_prompt 规范化一次
/// （P1 B1：trim + 空值 → None），全链透传原始。
///
/// T-29（P4 阶段 1-3/1-4）：新增 `history`（前端 store 已完成消息，
/// 冷启动水合兜底）与 `context_window`（生效模型窗口元数据，P3 目录
/// 接线前由前端下发；T-33 预算钳制消费）。混合路线（P4 §3.2.3）：
/// 前端 history 为空/未传时回退引擎侧 SessionHistoryCache（缓存主，
/// run 收口写入的权威增量）；两者皆空 = 现状单消息 run（向后兼容）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskOptions {
    pub run_id: String,
    pub session_id: String,
    pub prompt: Option<String>,
    pub mode: Option<String>,
    pub cwd: Option<String>,
    pub permission_mode: Option<String>,
    pub client_message_id: Option<String>,
    pub assistant_client_message_id: Option<String>,
    pub system_prompt: Option<String>,
    pub history: Option<Vec<HistoryMessage>>,
    pub context_window: Option<u32>,
    /// 父 run 归属（T-D-14 权限传递层，F11 T-D-13 spawner 装配时携带）：
    /// None = 主 agent run / 无父 run（审批裁决者 = 用户，现状不变）；
    /// Some = 子代理 run 的父 run id（审批请求路由给主 agent 裁决）
    pub parent_run_id: Option<String>,
    /// 子代理 run 装配配置（T-D-13：仅引擎内部 spawner 构造；IPC 命令面
    /// 不携带——serde 缺省 None = 普通 run，装配行为与现状一致）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_config: Option<crate::subagent_spawner::SubagentRunConfig>,
    /// D5 §3.1：goal 模式三字段（serde camelCase 由结构体级
    /// rename_all 覆盖；缺省 None 向前兼容——旧前端未发字段行为与现状
    /// 一致；serde 先例 = subagent_config）。激活装配在 run_task_impl
    /// mode=="goal" 分支（缺省 max_rounds 12 / max_stalled_rounds 2）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_goal: Option<String>,
    /// D5 §3.1：goal 轮次上限（None → 引擎缺省 DEFAULT_GOAL_MAX_ROUNDS=12）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<u32>,
    /// D5 §3.1：goal 连续空转上限（None → 引擎缺省 2）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_stalled_rounds: Option<u32>,
}

#[tauri::command]
pub(crate) async fn core_run_task(
    state: tauri::State<'_, Arc<CoreRunState>>,
    options: RunTaskOptions,
) -> Result<RunTaskResponse, CoreError> {
    run_task_impl(Arc::clone(state.inner()), options).await
}

/// estop 桥装配判定（31 评审 F2 / 30 评审 H-2 邻接）：**仅主 run 装配**——
/// 子代理 run 不 reset_estop、不挂 watcher。故障链：子代理 run 被取消
/// （L3/超时/kill_all）→ watcher 触发 cancel_estop → 急停旗置位 → 主 run
/// 本 run 剩余全部 browser_* 命令被 EmergencyStop 拒绝且同 run 无复位点
/// （浏览器操作整段失效，直到下一 run 启动）。browser_* 工具已按 27 §3
/// 从子代理注册面剔除（F1，readonly.rs filter_registry_for_task_type），
/// 子代理无 estop 消费方，装配即纯风险。
pub(crate) fn assemble_browser_estop(
    subagent_config: &Option<crate::subagent_spawner::SubagentRunConfig>,
) -> bool {
    subagent_config.is_none()
}

/// D6 决策 1：用户发起 run 判定（自动续 run 模式不写不清 user_stopped——
/// idle-resume / recovery-retry / content-resume / goal-continue 为引擎
/// 自主行为；其余（None / task / goal 等用户下发模式）视为用户新 run，
/// 装配时清除停止标记恢复自动行为）
pub(crate) fn is_user_initiated_mode(mode: Option<&str>) -> bool {
    !matches!(
        mode,
        Some("idle-resume" | "recovery-retry" | "content-resume" | "goal-continue")
    )
}

/// run 任务命令体（core_run_task 与 T-CF-11 idle 续 run 共用装配路径；
/// 测试可直调，不依赖 Tauri runtime——对齐 background.rs「契约体」模式）。
/// owned Arc 参数：future 内不持有引用，保证 Send（spawn 任务内可 await）。
pub(crate) async fn run_task_impl(
    state: Arc<CoreRunState>,
    options: RunTaskOptions,
) -> Result<RunTaskResponse, CoreError> {
    let state = Arc::clone(&state);
    // 参数校验（S-15：trim + 显式 InvalidInput）
    let run_id = options.run_id.trim().to_string();
    let session_id = options.session_id.trim().to_string();
    let prompt = options.prompt;
    let mode = options.mode;
    let cwd = options.cwd;
    let permission_mode = options.permission_mode;
    let client_message_id = options.client_message_id;
    let assistant_client_message_id = options.assistant_client_message_id;
    let system_prompt = options.system_prompt;
    let history = options.history;
    let context_window = options.context_window;
    // T-D-13：子代理 run 装配配置（None = 普通 run，装配行为与现状一致）
    let subagent_config = options.subagent_config;
    // T-D-14：父 run 归属（审批裁决者路由 + spawner 侧 run 注册表——先于
    // SessionLoopOptions 遮蔽取出，避免「options 已被 move」借用错误）
    let parent_run_id = options.parent_run_id.clone();
    // D5 §3.1：goal 模式三字段（mode=="goal" 装配输入；None 缺省由
    // [GoalState::with_defaults] 落引擎缺省 12/2，D5 §3.1 缺省规则）
    let visible_goal = options.visible_goal;
    let max_rounds = options.max_rounds;
    let max_stalled_rounds = options.max_stalled_rounds;

    if run_id.is_empty() || session_id.is_empty() {
        return Err(CoreError::invalid_input("runId / sessionId 不能为空"));
    }
    // T08.6 门禁：restore 完成前拒绝新 run（Q24 竞态：杜绝「新 run 先算
    // base、restore 后写审计事件」）
    if !state.restore_ready() {
        return Err(CoreError::internal("restore in progress：等待重启恢复完成"));
    }
    // engine 未就绪（provider 配置缺失）拒绝发起
    if !state.engine.ready() {
        let reason = state
            .engine
            .ready_reason()
            .unwrap_or_else(|| "engine not ready".to_string());
        return Err(CoreError::internal(reason));
    }
    // 会话内串行守卫（同会话同时只允许一个活动 run）
    {
        let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        if active.values().any(|run| run.session_id == session_id) {
            return Err(CoreError::invalid_input(format!(
                "会话 {session_id} 已有活动 run（串行守卫）"
            )));
        }
    }
    // D6 §3.2 spawn 点 2：会话首次出现惰性 spawn watcher（幂等——已
    // 存在跳过；防重入靠本串行守卫兜底，验收 A5）。子代理 run 不
    // spawn：子代理会话无 watcher 拉起语义（收口即终态），且共享队列
    // 会让 sub-sess-* 会话 watcher 误消费主会话条目（D6 §6 风险 7）
    if subagent_config.is_none() {
        state.ensure_wake_watcher(&session_id);
    }
    // D6 决策 1：用户发起的普通 run 装配 → 清除会话级 user_stopped
    // （用户新 run = 显式授权恢复自动行为；idle-resume / 恢复类 / 子
    // 代理 run 不写不清——停止语义跨 run 存活直到用户介入）
    if subagent_config.is_none() && is_user_initiated_mode(mode.as_deref()) {
        state.clear_user_stopped(&session_id);
    }
    // D5 §3.1/§3.8：goal 模式装配分支（mode=="goal" 且 visible_goal
    // 非空才装配）。写面 = 本装配点 + 收口 RoundAssessment（唯一写方）：
    // - 新 /goal 覆盖旧 goal_state（round 计数归零、新
    //   max_rounds/max_stalled_rounds，D5 §3.8 覆盖语义）；
    // - 缺省规则：max_rounds None → 12、max_stalled_rounds None → 2
    //   （[GoalState::with_defaults]，D5 §3.1）；
    // - 其余 mode（含 goal-continue 续轮 run）不创建不清理——普通 run
    //   保留挂起 goal_state（goal 是会话级长期意图），续轮由收口推进
    //   不覆盖（D5 §3.8 模式切换）。
    let goal_started: Option<(String, u32)> = if mode.as_deref() == Some("goal") {
        if let Some(goal_text) = visible_goal.filter(|goal| !goal.trim().is_empty()) {
            let goal_state = GoalState::with_defaults(goal_text, max_rounds, max_stalled_rounds);
            let started = (goal_state.goal.clone(), goal_state.max_rounds);
            state.save_goal_state(&session_id, &goal_state).await;
            tracing::info!(
                target: "run",
                session_id = %session_id,
                run_id = %run_id,
                goal = %goal_state.goal,
                max_rounds = goal_state.max_rounds,
                "goal 模式装配：goal_state 键已初始化（新 /goal 覆盖语义）"
            );
            Some(started)
        } else {
            None
        }
    } else {
        None
    };
    // provider / 工具注册表（engine 生效配置）
    let Some(provider) = state.engine.provider() else {
        return Err(CoreError::internal("engine not ready（provider 配置缺失）"));
    };
    // T-D-13：子代理 run 的工具注册表按 task_type 默认权限集裁剪
    // （filter_registry_for_task_type，T-D-08 fail-closed 白名单）+ 剔除
    // run_subagent（T-D-02 工具面防护：子代理无派发能力，防浪费非安全
    // 边界；守卫层 NestingDenied 兜底）+ 剔除 kill_subagent / send_message
    // （D4 §3.3/§3.10 + E3：仅主 agent 工具集——子代理无关闭/消息注入
    // 能力，防「子代理伪装主 agent」；剔除决策权威位在引擎装配点，
    // filter_out_subagent_spawner 本体与锁定测试零改动）。普通 run 保持
    // 引擎共享注册表。
    let base_registry = state.engine.tool_registry();
    let tool_registry = match &subagent_config {
        Some(config) => {
            let task_type_wire = config.task_type.as_deref().unwrap_or("analysis");
            let filtered = agent_tools::readonly::filter_registry_for_task_type(
                &base_registry,
                task_type_wire,
            )
            .map_err(|error| {
                CoreError::internal(format!("子代理工具集裁剪失败：{error}"))
            })?;
            let filtered = agent_tools::readonly::filter_registry(&filtered, |name| {
                name != agent_tools::tools::subagent::SUBAGENT_SPAWNER_TOOL_NAME
                    && name != agent_tools::tools::kill_subagent::SUBAGENT_KILL_TOOL_NAME
                    && name != agent_tools::tools::send_message::SEND_MESSAGE_TOOL_NAME
            })
            .map_err(|error| {
                CoreError::internal(format!("子代理工具集剔除失败：{error}"))
            })?;
            Arc::new(filtered)
        }
        None => base_registry,
    };

    // 注册 run（queued → initializing → running，落库）
    let handle = state
        .run_manager
        .start_run(&session_id, &run_id)
        .await
        .map_err(crate::core_error::map_run_err)?;
    let handle_shared = Arc::new(tokio::sync::Mutex::new(handle));

    // 事件队列（base = 预热/懒计算 max+1，T08.8：不重置为 1）
    let base = state.base_sequence_for(&session_id).await;
    let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
        state.store.clone(),
        base,
        Some(run_id.clone()),
    )));

    // 本 run 的缓冲事件桥（gate 广播 / delta sink / 收口 emit 共用）
    let bridge = Arc::new(BufferedRunEventBridge::new(
        state.bridge.clone(),
        run_id.clone(),
    ));

    // 审批门广播（approval-requested 实时预览：信封 sequence=None）
    let broadcast_bridge = Arc::clone(&bridge);
    let broadcast_run_id = run_id.clone();
    let broadcast = Box::new(move |event: AgentEvent| {
        let envelope = AgentEventEnvelope::new(event, Some(broadcast_run_id.clone()), None);
        broadcast_bridge.emit(&envelope);
        broadcast_bridge.flush();
    });
    // 死锁检测器（F9-05）待接：with_deadlock_detector 的 detector 需要
    // 「主 agent 正在 wait 该子代理」信号源——引擎侧尚无 orchestrator 子
    // 代理跟踪器的 await 态标记（approval_router.rs:41-45 自述的 F11
    // T-D-13 引擎接线未落地）。缺省 None = 恒走纯超时兜底（120s Expired），
    // 行为与现状一致；信号源落地后在此注入。
    let approval_gate = Arc::new(ApprovalGateImpl::new(
        run_id.clone(),
        session_id.clone(),
        // T-D-14：父 run 归属（子代理 run 由 spawner 携带；None = 主 agent）
        parent_run_id.clone(),
        broadcast,
        Arc::clone(&handle_shared),
        state.store.clone(),
        cwd.clone(),
    ));

    // permissionMode：full-access 不启用审批；其余（ask / plan）启用
    let approval_enabled = permission_mode.as_deref() != Some("full-access");
    let approval: Option<Arc<dyn ApprovalGate>> = if approval_enabled {
        Some(Arc::clone(&approval_gate) as Arc<dyn ApprovalGate>)
    } else {
        None
    };

    // T09.1 实时 delta 双轨：BridgeDeltaSink 注入 SessionLoopProducer
    // （core_run_commands.rs:667-716 装配，PE-09 T09.1.2 步骤 4）
    let delta_sink: Arc<dyn DeltaSink> = Arc::new(BridgeDeltaSink::new(
        Arc::clone(&bridge),
        run_id.clone(),
    ));

    // ── T-29 context_window 入站（P4 §3.3.2）──────────────────────
    // 生效模型窗口 → ContextBudget（reserve/safety 取默认）；经
    // SessionLoopOptions.context_budget 透传（T-30 装配，T-33 预算层
    // 消费钳制与预检）。DEEPCHECK-06 P0：子代理 run 的窗口入站由引擎
    // 按生效模型 catalog 解析（spawner 路径前端参数不可达，context_window
    // 恒 None——resolve_context_budget 的 subagent 兜底臂，与主会话前端
    // resolveContextWindow 的 catalog 兜底同源）。
    let context_budget = resolve_context_budget(context_window, &subagent_config, &state.engine);
    if let Some(budget) = context_budget {
        tracing::debug!(
            target: "run",
            session_id = %session_id,
            context_window = budget.context_window,
            reserve_tokens = budget.reserve_tokens,
            "context_window 入站（T-33 预算钳制消费）"
        );
    }

    // 循环选项（cwd / assistant clientMessageId / 幂等；21-log §5.2 回补）
    // P1 B1：systemPrompt 入站规范化一次（trim + 空值 → None），全链透传原始
    // P4 T-30：context_budget 装配进 options（预算钳制 + 预检压缩消费入口）

    // ── T-ESC-03 P3 装配面：逃逸监视启动钩子（run 开始）──────────
    // 监视根 = cwd（工作目录，run 驱动的工作区根）；watcher.start →
    // 消费任务 spawn（聚合 → 审计发射 + 主 agent 注入，REQ §3.5.1），
    // 句柄绑定 ActiveRun 随 run 收口（shutdown = stop + flush 剩余）。
    // 监视启动失败仅告警不阻断 run（监视是追踪面，REQ §3.6 不阻断）。
    //
    // 30-P5 时序更正（A4-H1 / C-36 假闭环消除）：判定器在本装配点直接
    // 注入（spawn_escape_watch 的 config 是值传递，装配后即就位，不再
    // 依赖 loop 侧 with_options 的配置副本）——detector 与 write_claims
    // 同一 registry 实例（双端注入成对，评审清单项）：
    // - 工具执行面声明写路径（options.write_claims 注入共享注册表）→
    //   声明覆盖静默（审计不误报）；
    // - 声明释放 / 未声明写入 → 上报（未声明写审计）。
    //
    // 15-T-6（裁决 D9）：run 级审计桥实例（工具级审计路由与逃逸监视
    // 共用——同一 run 缓冲事件桥双注入，无重复广播；注册语句见下方
    // 装配块）。L4（F12）：审计底账落库接线——持久化通道 + 单 worker
    // （按发射序 reserve + append_event 落库 events 表；句柄随
    // ActiveRun 收口 await 排空，终态前落库完成）
    let (audit_persist_tx, audit_persist_rx) = tokio::sync::mpsc::unbounded_channel();
    let audit_worker = spawn_audit_persistence(
        Arc::clone(&queue),
        session_id.clone(),
        audit_persist_rx,
    );
    let bridge_audit_sink = Arc::new(BridgeAuditSink::new(
        Arc::clone(&bridge),
        run_id.clone(),
        audit_persist_tx,
    ));
    let escape_root = resolve_escape_watch_root(cwd.as_deref());
    let control_bus = Arc::new(Mutex::new(ControlBus::new()));
    // 30-P5：共享写路径注册表（会话级，与逃逸监视根同源）——工具执行
    // 面与逃逸判定器读同一实例；loop 侧 with_options 解析链
    // （options.write_claims 优先）保持同源
    let shared_registry = Arc::new(WritePathRegistry::new(session_id.clone(), &escape_root));
    // 30-P1：每 run 新建 abort 信号（M3 契约「每 run 重建 loop + 新信号」——
    // AbortSignal 共享 AtomicBool 不可复位，跨 run 泄漏语义禁止复用；
    // 同一实例注入 ActiveRun 与 loop，L3 强停 / kill_all 经同一触发面）。
    // AbortSignal::reset 不实现（Notify 无法复位，跨 run 泄漏语义登记
    // A4-M3 邻接，以「每 run 新信号」契约兜底）
    let abort_signal = AbortSignal::new();
    // ── 27 方案 S5：browser estop 桥（M-2，run 级 abort → CDP 发送层取消）──
    // 三层信号联动（27 §1.3 表）：run 级 AbortSignal（L3 强停/用户取消）
    // → 浏览器会话槽 estop 令牌（发送层在途命令逐 id 取消 +
    // CdpError::Cancelled）+ 急停旗（新命令拒绝）。每 run 先 reset_estop
    // 换新周期——新 run 不继承上一 run 的取消态（防跨 run 毒化会话）；
    // 急停旗随下一启动周期复位（browser/mod.rs BrowserSlot::reset_estop）。
    // 并发 run 共享同一 estop 周期（最后复位者生效）：多 run 并发操作
    // 同一浏览器实例登记遗留（27 §6 P1 会话归属迁移）。
    // 31 评审 F2（P1）：装配判定见 [assemble_browser_estop]——仅主 run
    // （subagent_config = None）装配；子代理 run 不装配（杜绝「子代理
    // abort → cancel 主 run estop」故障链）。
    if assemble_browser_estop(&subagent_config) {
        let browser_slot = state.engine.browser_slot();
        browser_slot.reset_estop();
        crate::browser::spawn_browser_estop_watcher(browser_slot, abort_signal.clone());
    }
    let (escape_watch, escape_config) = if let Some(dir) = cwd.clone() {
        let root = PathBuf::from(dir);
        let config = EscapeWatchConfig::new(
            root.clone(),
            session_id.clone(),
            run_id.clone(),
            // 15-T-6：与工具级审计路由共用同一 run 级桥（同一
            // BridgeAuditSink 实例双注入，无重复广播）
            Arc::clone(&bridge_audit_sink) as AuditSink,
        )
        .with_injector(Arc::new(ControlBusInjector::new(Arc::clone(&control_bus))))
        // 30-P5：判定器在 spawn 前注入（与 write_claims 同一 registry
        // 实例——声明写静默 / 未声明上报；消除 detector 恒 None 的
        // C-36 假闭环）
        .with_detector(Arc::new(RegistryBackedDetector::new(Arc::clone(
            &shared_registry,
        ))));
        match spawn_escape_watch(root, config.clone()) {
            Ok(handle) => {
                tracing::info!(
                    target: "run",
                    run_id = %run_id,
                    "逃逸监视已启动（T-ESC-03）"
                );
                (Some(handle), Some(config))
            }
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    run_id = %run_id,
                    error = %error,
                    "逃逸监视启动失败（仅告警，run 继续）"
                );
                (None, None)
            }
        }
    } else {
        (None, None)
    };

    // ── 15-T-6（裁决 D9）：工具级审计路由注册（run 级桥）──────────
    // 工具级 security-audit（shell/delete 经 BuiltinToolConfig.audit_sink
    // 发射，接线前 NoopAuditSink 静默丢弃）经路由 sink 送达本 run 缓冲
    // 事件桥（信封注入 run_id → 前端审计面板 per-run 面实时可见，34-T7
    // 口径；L4（F12）已补落库面——审计底账经持久化 worker 写入 events
    // 表，见 [spawn_audit_persistence]）。与逃逸监视共用同一
    // BridgeAuditSink 实例（同一 run 桥双注入，无重复广播）。
    // **域隔离边界**（30 §9 最终口径）：任务域审计（10-P3
    // TaskAuditAccumulator → EventBridge 直发，operation=command-exec）
    // **不经本路由 sink**——本卡只承接工具级审计，两路均以
    // security-audit 事件形态经 run 桥到达前端，无重复无遗漏。
    // 收口注销在 drive_run_loop / finalize_failed 强制执行（防泄漏）。
    state
        .engine
        .audit_sink()
        .register(&session_id, Arc::clone(&bridge_audit_sink) as AuditSink);

    // ── T-D-13：子代理 run 装配块（默认权限集 / 提示词注入 / 配额）──
    // 普通 run（subagent_config = None）全部保持现状（None 不装配）。
    // - 写路径沙箱（T-D-08）：显式 allowed_write_paths → WritePathPolicy
    //   注册（Allowed 优先）；无显式字段且 implementation → 工作区根沙箱；
    //   其余类型工具面/配额面闭合，不注册策略（不强制越权检查）；
    // - 权限申请上下文（T-D-14）：design/review 装配配额凭证
    //   （granted=true quota=1，session_meta 后端）；
    // - 提示词注入（ContextInjector）：T-D-03 角色约束段 + C2 started_at
    //   段 + git 回退指引段 + T-D-14 权限申请指引段 + 产出目录段
    //   （主控已定产出目录时）。
    let subagent_injector: Option<ContextInjector> = None;
    let subagent_write_registry: Option<Arc<WritePathRegistry>> = None;
    let subagent_quota: Option<ExploreDocsQuotaContext> = None;
    let (subagent_write_registry, subagent_quota, subagent_injector) =
        match &subagent_config {
            None => (subagent_write_registry, subagent_quota, subagent_injector),            Some(config) => {
                // 工作区根解析链（30-P5：与 loop 装配块同源，经共用 helper
                // resolve_escape_watch_root——单一真源，杜绝双处漂移复发；
                // 壳层 workspace_root 恒 None，等效 cwd → current_dir）
                let root = resolve_escape_watch_root(cwd.as_deref());
                // 写路径沙箱装配
                let write_registry = match &config.allowed_write_paths {
                    Some(paths) => {
                        let policy = WritePathPolicy::from_entries(&root, paths.clone())
                            .map_err(|error| {
                                CoreError::internal(format!("写路径白名单解析失败：{error}"))
                            })?;
                        Some(Arc::new(
                            WritePathRegistry::new(session_id.clone(), &root)
                                .with_write_policy(policy),
                        ))
                    }
                    None => match config.task_type.as_deref() {
                        // implementation 默认 = 工作区根沙箱（Allowed 白名单）
                        Some("implementation") => Some(Arc::new(
                            WritePathRegistry::new(session_id.clone(), &root)
                                .with_write_policy(WritePathPolicy::Allowed(vec![root.clone()])),
                        )),
                        // 其余类型：工具面（只读/仅 shell）+ 配额面闭合，
                        // 不注册策略（越权检查不强制）
                        _ => None,
                    },
                };
                // 权限申请上下文（design/review 配额凭证；T-D-14）
                let quota = match config.task_type.as_deref() {
                    Some("design") | Some("review") => state.local_db().map(|db| {
                        ExploreDocsQuotaContext {
                            session_id: session_id.clone(),
                            run_id: run_id.clone(),
                            granted: true,
                            quota: 1,
                            store: Some(Arc::new(
                                conex_db::SessionMetaExploreDocsQuotaStore::new(db),
                            )),
                        }
                    }),
                    _ => None,
                };
                // 提示词注入段装配（M1 挂载形状：title + content → push）
                let mut injector = ContextInjector::new();
                // T-D-03：子代理角色约束（主 Agent run 装配点不调用——
                // 「主 Agent run 不含本段」断言的关键差异点）
                crate::engine::push_subagent_role_constraint(&mut injector);
                // C2：started_at 段 + git 回退谨慎指引（started_at 与落库同源）
                for (title, content) in agent_tools::subagent_inject::subagent_session_injections(
                    Some(config.started_at_ms),
                    agent_tools::subagent_inject::DEFAULT_REF_AGE_THRESHOLD_HOURS,
                ) {
                    injector.push(ContextInjection::new(
                        ContextInjectionKind::System,
                        title,
                        content,
                    ));
                }
                // T-D-14：权限申请指引段（任务类型 + 一句话边界参数化）
                let boundary = config
                    .task_type
                    .as_deref()
                    .and_then(agent_tools::tools::subagent::TaskType::parse)
                    .map(|t| t.boundary_summary());
                let (title, content) =
                    agent_tools::subagent_inject::permission_relay_injection(
                        config.task_type.as_deref(),
                        boundary,
                    );
                injector.push(ContextInjection::new(
                    ContextInjectionKind::System,
                    title,
                    content,
                ));
                // 产出目录段（主控已定产出目录时注入）
                if let Some(dir) = &config.output_dir {
                    let (title, content) = agent_tools::subagent_inject::output_dir_injection(dir);
                    injector.push(ContextInjection::new(
                        ContextInjectionKind::System,
                        title,
                        content,
                    ));
                }
                (write_registry, quota, Some(injector))
            }
        };

    // ── D1 §3.1.4/§3.2.3：退避与熔断配置装配（读 session_meta 键；
    //    None = 向后兼容：立即重试 / 不启用熔断闸）──
    // - retry_backoff：`provider_retry_backoff_ms` 键 → 内核退避
    //   （750ms×2^(n-1)/8s 封顶/60s 预算/Retry-After 放行）生产生效；
    // - provider_fail_streak：`provider_fail_streak` 键 count → 熔断闸
    //   C1 输入（transient_retry 入口 >= 阈值直接 fatal）。熔断计数落
    //   键在收口 [Self::update_provider_fail_streak]（唯一写方），本装配
    //   点只读注入——天然跨 run（D1 §3.2.3 装配时序）。
    let retry_backoff = state.retry_backoff_config(&session_id);
    let provider_fail_streak = state.provider_fail_streak_count(&session_id).await;

    let options = SessionLoopOptions {
        cwd: cwd.clone(),
        assistant_client_message_id: assistant_client_message_id.clone(),
        // P1 B1：systemPrompt 入站规范化一次 + E2 F5 阶段总结段注入
        // （build_system_prompt 输出后拼接「阶段总结：N 条」段——零对话
        // 污染、天然跨 run 携带，E2 §6.3 主选；无总结时行为与接线前一致）
        system_prompt: assemble_system_prompt_with_stages(&state, &session_id, system_prompt),
        context_budget,
        // D1 §3.1.4（R6）：瞬态重试退避配置（session_meta 键注入；
        // None = 现状立即重试向后兼容）
        retry_backoff,
        // D1 §3.2.3：会话级熔断计数当前值（transient_retry 入口闸 C1
        // 输入；None = 不启用闸）
        provider_fail_streak,
        // T-ESC-03：逃逸监视配置透传（装配上下文，LoopState 不消费）
        escape_watch: escape_config,
        // T-EG-05（F7）：写前自动备份中间件装配（S10b）——备份根经
        // with_defaults(None) 执行期回退工作区 `.crish-trash`，与 UI 删除
        // 命令（trash_root_for 未注入时兜底，core_run_commands.rs:2356）及
        // 工具侧 BuiltinToolConfig.trash_root（引擎装配处亦为 None）同源，
        // 保证恢复面板与写前快照落入同一回收站根；中间件链经
        // options.tool_middleware → loop/mod.rs:343 with_middleware 同步到
        // 工具执行器（消费侧循环装配由 F7 T-EG-06 负责，本处只做 options
        // 侧构造）。
        tool_middleware: vec![Arc::new(BackupMiddleware::with_defaults(None))],
        // T-D-14 权限传递层：父 run 归属透传执行器（审批请求来源判定与
        // 裁决者路由依据；None = 主 agent run，现状行为）
        parent_run_id: parent_run_id.clone(),
        // T-D-13：子代理 run 的写路径沙箱注册表（with_write_policy 装配；
        // 子代理沙箱优先，策略注册逻辑不动）；普通 run 由 None 变
        // Some(shared_registry)——30-P5：与逃逸判定器同一实例（双端注入
        // 成对：工具声明写不误报未声明）
        write_claims: subagent_write_registry
            .clone()
            .or_else(|| Some(Arc::clone(&shared_registry))),
        // T-D-13：子代理 run 的配额上下文（design/review 凭证；None =
        // 主 agent 不受配额约束，现状行为）
        explore_docs_quota: subagent_quota.clone(),
        // COMPACTION-01 P0-1（生产闭环）：压缩策略装配——默认 20000/2/1024
        // （conex-compaction 常量）经 session_meta 键覆盖（compact_summary_
        // max_tokens 等，读取键不实现 UI）；装配后预检压缩在生产可触发
        // （此前走 ..Default::default() 回落到 None，预检/溢出恒不触发）
        compaction_policy: state.compaction_policy_for(&session_id),
        // T-42/T-43/T-44（记忆韧性轮次 6）：摘要后台面三线装配——
        // - summarizer：会话级 Summarizer 工厂解析（生产工厂 = 真实 LLM
        //   实现 ProviderSummarizer，COMPACTION-01 P0-3 闭环；无注入 →
        //   None → 不 spawn，纯 stub awaiting 永驻，与接线前行为一致）；
        // - summary_dispatch：session_meta 配置面（compact_summary_backoff_ms
        //   / compact_summary_wall_ms；无键 = None = 生产缺省退避参数）；
        // - summary_coordinator：会话级协调器（跨 run 单飞 + 全局并发
        //   上限 ≤2 + 任务跨 run 存活；默认回调落 compression_blocks 表）
        summarizer: state.summarizer_for(&session_id),
        summary_dispatch: state.summary_dispatch_config(&session_id),
        summary_coordinator: Some(state.summary_coordinator_for(&session_id)),
        // Round7：笔记后端真注入（与 engine produce 双保险；同源
        // note_runtime 进程句柄 / app_dir()/workspace.db）
        note_backend: crate::note_runtime::try_backend(),
        ..SessionLoopOptions::default()
    };
    let tool_options = ToolBatchOptions {
        approval_enabled,
        // R4 T10：permission_mode 显式下传时按 dangerous 标记三态判定
        // （ask 问询 / plan 拒绝写类 / full-access 放行）；None = 既有语义
        permission_mode: permission_mode
            .as_deref()
            .map(|mode| PermissionMode::from_engine_str(Some(mode))),
        ..ToolBatchOptions::default()
    };
    // 用户消息（clientMessageId 透传，03 §5.3-4）
    let message =
        crate::engine::user_message(&prompt.unwrap_or_default(), client_message_id.as_deref());

    // ── T-29/T-30 历史参数装配（P4 §3.2.3 混合路线）───────────────
    // 前端 history（store 已完成消息）为冷启动水合兜底；为空/未传时回退
    // SessionHistoryCache（引擎侧缓存主，run 收口写入的权威增量）。
    // 产出 initial_conversation（Vec<Arc<AgentMessage>>）：前端载荷走
    // T-28 hydrate_history（过滤 + 尾部 user 截断），缓存走保真水合
    // （工具结果配对不拆散）。已由 T-30 物理接线：经
    // SessionLoopProducer::initial_conversation 字段传入 produce，
    // 由 with_initial_conversation_arc 零拷贝水合。
    let assembled_history =
        resolve_history_source(&history, state.session_history.get(&session_id));
    let initial_conversation: Option<Vec<Arc<AgentMessage>>> = assembled_history
        .as_ref()
        .map(|(source, payload)| match source {
            HistorySource::Frontend => hydrate_history(payload.clone()),
            HistorySource::Cache => cached_history_to_conversation(payload.clone()),
        });
    tracing::debug!(
        target: "run",
        session_id = %session_id,
        source = ?assembled_history.as_ref().map(|(source, _)| source),
        hydrated = initial_conversation.as_ref().map(Vec::len).unwrap_or(0),
        "历史装配完成（前端水合兜底 / 引擎缓存主）"
    );

    let producer = SessionLoopProducer::new(
        session_id.clone(),
        run_id.clone(),
        MAX_TURNS_DEFAULT,
        provider,
        tool_registry,
        options,
        tool_options,
        approval,
        Some(delta_sink),
        initial_conversation,
        message,
    )
    // T-40（P5 S5 §3.2，R5-D3 轮末合并接线 ①）：缓存测量装配——
    // with_cache_tracking：tracking 配置（provider / model / TTL，
    // engine 侧 cache_tracking_config 产出；None = 不测量，行为与现状
    // 一致）；with_cache_session：上一 run 会话缓存状态（冷缓存预警 +
    // 模型切换检测数据源，engine 侧 cache_session 按会话维护）
    .with_cache_tracking(state.engine.cache_tracking_config())
    .with_cache_session(state.engine.cache_session(&session_id))
    // T-D-13：子代理 run 的上下文注入通道（角色约束 / started_at /
    // 权限申请指引 / 产出目录段；None = 无注入，system_prompt 原样透传）
    .with_context_injector(subagent_injector)
    // 30-P1：run 控制面接线——壳层与 loop 同源（同一控制总线 + 同一
    // abort 信号实例；check_control 安全点消费，运行中 run 有真实外部
    // 终止路径：core_run_control → 总线 → run 终止，L3 ≤ 下一安全点
    // 收场）。builder 顺序契约：with_* 在 run() 前（produce 内装配，
    // loop/mod.rs with_control_bus 注释）
    .with_control_bus(Arc::clone(&control_bus))
    .with_abort_signal(abort_signal.clone());

    // T-AB-19：登记当前 run 上下文（owner_run_id 注入槽）——须在 spawn
    // drive_run_loop 之前，保证 run 内工具执行链 adopt 时已可见；run
    // 终态（drive_run_loop 收口 / finalize_failed）经 clear_current_run 释放。
    state.background.set_current_run(&run_id);
    // T-D-13：spawner 侧 run 上下文登记（深度记账 + 当前活动 run 定位——
    // 子代理 spawn 时按发起会话解析父 run；收口经 clear 释放）
    state
        .subagent_spawner
        .register_run(&run_id, &session_id, parent_run_id.clone());
    state.subagent_spawner.set_current_run(&session_id, &run_id);

    // 注册活动 run 并 spawn 驱动循环
    let active = Arc::new(ActiveRun {
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        handle: handle_shared,
        queue,
        control_bus: Arc::clone(&control_bus),
        // 30-P1：与 loop 共享同一信号实例（克隆即同一触发面；L3 强停
        // 经 ActiveRun.abort_signal 或 run_control_impl 任一入口生效）
        abort_signal: abort_signal.clone(),
        approval: approval_gate,
        bridge,
        delta_sink_active: true,
        escape_watch: Mutex::new(escape_watch),
        user_touched: AtomicBool::new(false),
        // 30-P1：spawn 句柄经 set_driver 事后登记（构造在前、spawn 在后）
        driver: Mutex::new(None),
        // T-D-13：子代理 run 装配配置随活动 run 登记（收口终态处理依据）
        subagent: subagent_config.clone(),
        // L4（F12）：审计落库 worker 句柄（收口处 take + await 排空）
        audit_persist: Mutex::new(Some(audit_worker)),
    });
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(run_id.clone(), Arc::clone(&active));
    // D5 §3.9：goal-round-started（mode=goal 装配轮 run 启动时发射；
    // round 从 1 计；载荷 goal/round/maxRounds 对齐 OrchestratorGoalRunState
    // 子集；envelope 通道，run 串行上下文）
    if let Some((goal, max_rounds)) = &goal_started {
        emit_envelope_event(
            &active.queue,
            &active.bridge,
            &active.run_id,
            &session_id,
            AgentEvent::GoalRoundStarted {
                round: 1,
                max_rounds: *max_rounds,
                goal: goal.clone(),
            },
        )
        .await;
    }

    // 30-P1 改动点 4：JoinHandle 管理——spawn 句柄存入 ActiveRun（驱动
    // 任务持同一 active 实例）；收口不 await（JoinHandle drop 即 detach，
    // tokio 语义，防挂起）；句柄供可观测与未来 join（测试经
    // driver_finished 轮询断言）
    let driver = tauri::async_runtime::spawn(drive_run_loop(
        state,
        Arc::clone(&active),
        Box::new(producer),
    ));
    active.set_driver(driver);

    tracing::info!(
        target: "run",
        session_id = %session_id,
        run_id = %run_id,
        mode = %mode.as_deref().unwrap_or("task"),
        permission_mode = %permission_mode.as_deref().unwrap_or("ask"),
        "core_run_task 已发起"
    );
    Ok(RunTaskResponse { run_id, session_id })
}

// ── 命令：core_run_control ────────────────────────────────────────

/// run 控制（03 §3.2 A 组：L0-L3 全枚举）
///
/// - `continue`（L0）：不入队（ControlBus 语义），no-op 返回 Ok；
/// - `soft_inject` / `steer` / `follow_up`（L1）：消息注入对应环，
///   不打断流（文本取 `message` 或 `payload.text`；环由 payload.kind
///   或 level 决定）；
/// - `cooperative_stop`（L2）：协作停止，等安全点收场（stopped，D1）；
/// - `force_cancel`（L3）：AbortSignal 强停 + 总线 force_cancel
///   （aborted 收场）。
#[tauri::command]
pub(crate) async fn core_run_control(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    level: String,
    message: Option<String>,
    reason: Option<String>,
    payload: Option<serde_json::Value>,
) -> Result<(), CoreError> {
    run_control_impl(state.inner(), run_id.trim(), &level, message, reason, payload).await
}

/// run 控制命令体（测试直调，不依赖 Tauri runtime；对齐 background.rs
/// 「契约体」模式）
pub(crate) async fn run_control_impl(
    state: &Arc<CoreRunState>,
    run_id: &str,
    level: &str,
    message: Option<String>,
    reason: Option<String>,
    payload: Option<serde_json::Value>,
) -> Result<(), CoreError> {
    let active = active_run(state, run_id)?;
    match level {
        // L0：继续当前 run（不入队）
        "continue" => Ok(()),
        // L1：软注入（不打断流；消息入 steer / followUp 环）
        "soft_inject" | "steer" | "follow_up" => {
            let text = message
                .or_else(|| {
                    payload
                        .as_ref()
                        .and_then(|p| p.get("text"))
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                })
                .ok_or_else(|| {
                    CoreError::invalid_input("soft_inject 需要 message / payload.text")
                })?;
            // payload.kind 优先决定环（runControlClient.ts: follow_up /
            // soft_inject / steer 变体）
            let follow_up = payload
                .as_ref()
                .and_then(|p| p.get("kind"))
                .and_then(serde_json::Value::as_str)
                .map(|kind| kind == "follow_up")
                .unwrap_or(level == "follow_up");
            let injected = crate::engine::user_message(&text, None);
            // T-CF-11：用户经 L1 注入消息 → 标记用户交互（收口判定
            // 「用户消息到达后的正常收场不触发续 run」）
            active.user_touched.store(true, Ordering::SeqCst);
            let mut bus = active
                .control_bus
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if follow_up {
                bus.request_follow_up(injected, reason, Some("ui".to_string()));
            } else {
                bus.request_steer(injected, reason, Some("ui".to_string()));
            }
            Ok(())
        }
        // L2：协作停止（等安全点，不 hard abort）
        "cooperative_stop" => {
            // D6 决策 1：用户显式停止 → 会话级 user_stopped 标记（跨 run
            // 语义——watcher 与收口判定不再自动续，直到用户新 run 清除；
            // L2 不置 run 级 user_touched，会话级标记兜底 error 收场竞态）
            state.set_user_stopped(&active.session_id);
            let mut bus = active
                .control_bus
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            bus.request_cooperative_stop(
                Some(reason.unwrap_or_else(|| "ui-stop".to_string())),
                Some("ui".to_string()),
            );
            Ok(())
        }
        // L3：强停（可立即中断；AbortSignal + 总线）
        "force_cancel" => {
            // T-CF-11：用户显式取消 → 标记用户交互（收口不续 run 双保险）
            active.user_touched.store(true, Ordering::SeqCst);
            // D6 决策 1：会话级 user_stopped 标记（跨 run 语义——残留
            // 队列条目（已到期定时器等）不得自动拉起 run，直到用户新 run）
            state.set_user_stopped(&active.session_id);
            active.abort_signal.abort();
            {
                let mut bus = active
                    .control_bus
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                bus.request_force_cancel(
                    Some(reason.unwrap_or_else(|| "ui-force-cancel".to_string())),
                    Some("ui".to_string()),
                );
            }
            // T-AB-19 L0-L3 控制总线对接：L2 / L3 **不触碰任务**——任务属
            // 会话级，run 控制只作用于 run 本身（职责单一，避免误杀，对齐
            // 方案 REQ 4.3；l3_force_cancel_keeps_tasks 测试锚定）。可选联动
            // 默认关闭（配置项 CONEX_RUN_CONTROL_L3_TASK_CANCEL，见
            // [l3_force_cancel_tasks_enabled]）：开启时 L3 force 对「当前
            // run 的普通任务（is_daemon=false）」发起优雅终止（两阶段 kill，
            // best-effort，不阻断强停）。
            if l3_force_cancel_tasks_enabled() {
                state.background.graceful_stop_tasks_for_run(&active.run_id).await;
            }
            Ok(())
        }
        other => Err(CoreError::invalid_input(format!("未知 level：{other}"))),
    }
}

// ── E2 F4（07 §3 卡 C）：手动压缩命令 core_compact_now ─────────────
//
// slash /compact（别名 /压缩 /compress，可选目标 token 数）→ 本命令。
// 链路（E2 §5.2）：会话存在性 → 活动 run 检查（busy 拒绝，不打断活动
// 流）→ 对话源（SessionHistoryCache 优先 / DB body 兜底）→ Summarizer
// 检查（F1 L1：无 → 结构化错误「LLM 摘要不可用，未压缩」）→
// CompactionEngine（StubPolicy::LlmRequired——摘要不可用不降级 stub）→
// 应用（缓存对话替换 + context-compression-start/end 事件 + 块表落库）
// → CompactNowResult。manual 不受 max_auto_compactions_per_run 限制
// （用户显式意志，00 规范红线 2「手动路径不受限」对称语义）。

/// F4：手动压缩结果（slash /compact 返回载荷；camelCase wire）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactNowResult {
    /// 压缩前 token 数（启发式口径）
    pub tokens_before: u64,
    /// 压缩后 token 数（启发式口径）
    pub tokens_after: u64,
    /// 被压缩（丢弃并进入摘要）的消息条数
    pub dropped: usize,
    /// 摘要状态（committed = LLM 摘要成功 / awaiting = 后台重试中）
    pub summary_state: String,
}

/// F4：手动压缩命令（daemon IPC；registered 面经 command_manifest 双端
/// 三处翻转 + main.rs make_handlers! 注册，registered = 注册面不变量）
#[tauri::command]
pub(crate) async fn core_compact_now(
    state: tauri::State<'_, Arc<CoreRunState>>,
    session_id: String,
    target_tokens: Option<u64>,
) -> Result<CompactNowResult, CoreError> {
    compact_now_impl(&state, session_id.trim(), target_tokens).await
}

/// F4 命令体（测试直调，不依赖 Tauri runtime；对齐 run_control_impl
/// 「契约体」模式）
pub(crate) async fn compact_now_impl(
    state: &Arc<CoreRunState>,
    session_id: &str,
    target_tokens: Option<u64>,
) -> Result<CompactNowResult, CoreError> {
    // 1. 会话存在性（内存注册表 session_trees / sessions + DB sessions 表
    //    三面检查——冷启动无内存注册表时以 DB 为权威）
    let session_exists = {
        let trees = state.session_trees.lock().unwrap_or_else(|e| e.into_inner());
        let in_trees = trees.contains_key(session_id);
        let in_sessions = {
            let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions.iter().any(|record| record.session_id == session_id)
        };
        let in_db = state
            .local_db()
            .and_then(|db| db.list_sessions().ok())
            .map(|entries| entries.iter().any(|entry| entry.id == session_id))
            .unwrap_or(false);
        in_trees || in_sessions || in_db
    };
    if !session_exists {
        return Err(CoreError::NotFound(format!("会话 {session_id} 不存在")));
    }
    // 2. 活动 run 检查（busy → 拒绝，不打断活动流；用户可待 idle 后再试）
    {
        let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        if active.values().any(|run| run.session_id == session_id) {
            return Err(CoreError::InvalidInput(format!(
                "会话 {session_id} 正在运行中，压缩命令等待空闲后执行（不打断活动流）"
            )));
        }
    }
    // 3. 预算：显式 target_tokens 或 window - reserve（预检同口径）；
    //    下限 = reserve + keep_recent（护栏：目标过小必裁掉保留段原文，
    //    语义等价不可行 → InvalidInput，E2 §5.3 护栏）。参数校验前置
    //    （对话加载之前，与 run_control_impl 的入参先验纪律一致）
    let policy = state.compaction_policy_for(session_id).unwrap_or_default();
    let window = state
        .engine
        .provider_config()
        .and_then(|config| crate::engine::effective_context_window(&config))
        .map(u64::from)
        .unwrap_or(u64::from(ContextBudget::default().context_window));
    let reserve = u64::from(ContextBudget::default().reserve_tokens);
    let keep_recent = policy.keep_recent_tokens as u64;
    let budget = match target_tokens {
        Some(target) => target,
        None => window.saturating_sub(reserve),
    };
    if budget < reserve + keep_recent {
        return Err(CoreError::InvalidInput(format!(
            "目标 token 数 {budget} 低于下限 {reserve}（reserve）+ {keep_recent}（keep_recent）"
        )));
    }
    // 4. 对话源：SessionHistoryCache 优先（引擎权威增量）；DB body 兜底
    //    （重启后冷启动——SessionMessage 与 HistoryMessage 字段一一对应，
    //    转换后走缓存同款保真水合 cached_history_to_conversation）
    let conversation = if let Some(cached) = state.session_history.get(session_id) {
        cached_history_to_conversation(cached)
    } else {
        let Some(db) = state.local_db() else {
            return Err(CoreError::Internal(
                "LocalDb 不可用，无法加载会话对话".to_string(),
            ));
        };
        let body = db
            .load_session_body(session_id)
            .map_err(|error| CoreError::Io(format!("store.load_session_body: {error}")))?;
        let history: Vec<HistoryMessage> =
            body.into_iter().map(session_message_to_history).collect();
        cached_history_to_conversation(history)
    };
    if conversation.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "会话 {session_id} 无对话内容可压缩"
        )));
    }
    // 5. Summarizer 检查（F1 L1：无 Summarizer → 不压缩、结构化错误）
    let Some(summarizer) = state.summarizer_for(session_id) else {
        return Err(CoreError::InvalidInput(
            "LLM 摘要不可用，未压缩（请配置 provider 后重试）".to_string(),
        ));
    };
    // 6. 压缩（LlmRequired：无 Summarizer / 摘要失败 → 放弃压缩，禁止
    //    纯丢弃式 stub，E2 F1）
    let engine = conex_compaction::CompactionEngine::new(budget as usize);
    let plan = engine.compact_agent_messages_with_stub_policy(
        &conversation,
        budget as usize,
        &policy,
        Some(summarizer.as_ref()),
        StubPolicy::LlmRequired,
    );
    if plan.llm_unavailable {
        return Err(CoreError::InvalidInput(
            "LLM 摘要不可用，未压缩（摘要生成失败，对话保持原样）".to_string(),
        ));
    }
    if plan.dropped_ids.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "无合法切割点，未压缩（对话过短或无 Tool 配对保护冲突，tokens_before={}）",
            plan.tokens_before
        )));
    }
    // 7. 应用：缓存对话替换（下次 run 装配即用压缩后序列）+ 事件 + 块表
    let replaced: Vec<HistoryMessage> = plan
        .messages
        .iter()
        .map(|message| to_history_message(message.as_ref()))
        .collect();
    state.session_history.store(session_id, replaced);
    let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
        state.store.clone(),
        state.base_sequence_for(session_id).await,
        None,
    )));
    let bridge = state.event_bridge();
    let now_iso = crate::engine::now_iso_utc();
    // Start 事件（触发原因 + 压缩前 token；会话级队列入队持久化 + 全局
    // 事件桥信封广播——非 run 上下文 run_id 缺省 None）
    push_emit_idle_event(
        &queue,
        &bridge,
        session_id,
        AgentEvent::ContextCompressionStart {
            session_id: session_id.to_string(),
            timestamp: now_iso.clone(),
            reason: "manual".to_string(),
            tokens_before: plan.tokens_before,
        },
    )
    .await;
    // End 事件（record 载荷 = CompactionPlan 字段；details 携带块语义键，
    // orchestrator::blocks 消费落块表，blocks.rs:96-137）
    let summary_state = if plan.summary_is_llm { "committed" } else { "awaiting" };
    let block_id = format!("compacted-summary-{}-{}", plan.generation, plan.fold_index);
    let record = ContextCompressionRecord {
        id: block_id.clone(),
        trigger: ContextCompressionTrigger::Manual,
        reason: Some(ContextCompressionReason::Manual),
        policy: None,
        summary: plan.summary.clone(),
        first_kept_message_id: plan.first_kept_message_id.clone(),
        compressed_message_ids: plan.dropped_ids.clone(),
        kept_message_ids: plan.kept_ids.clone(),
        tokens_before: plan.tokens_before,
        tokens_after: plan.tokens_after,
        threshold_tokens: Some(budget),
        created_at: now_iso.clone(),
        handoff: None,
        cache_boundary: None,
        details: Some(compaction_block_details(
            &block_id,
            plan.generation,
            (plan.fold_chain_prev > 0)
                .then(|| format!("compacted-summary-{}-{}", plan.generation, plan.fold_chain_prev))
                .as_deref(),
            iso8601_to_epoch_millis(&now_iso),
            summary_state,
        )),
    };
    let end_event = AgentEvent::ContextCompressionEnd {
        session_id: session_id.to_string(),
        timestamp: now_iso,
        result: Some(record),
        aborted: false,
        error: None,
    };
    let sequence = push_emit_idle_event(&queue, &bridge, session_id, end_event.clone()).await;
    // 块表落库（与 drive 路径同源 persist_compression_block；失败仅告警
    // ——块表是索引面，原文在事件流可回放）
    if let Some(sequence) = sequence {
        if let Err(error) = orchestrator::blocks::persist_compression_block(
            state.store.as_ref(),
            session_id,
            &end_event,
            sequence,
        )
        .await
        {
            tracing::warn!(
                target: "run",
                session_id,
                error = %error,
                "手动压缩块表落库失败（索引面，原文在事件流可回放）"
            );
        }
    }
    tracing::info!(
        target: "run",
        session_id,
        tokens_before = plan.tokens_before,
        tokens_after = plan.tokens_after,
        dropped = plan.dropped_ids.len(),
        "手动压缩完成（slash /compact）"
    );
    Ok(CompactNowResult {
        tokens_before: plan.tokens_before,
        tokens_after: plan.tokens_after,
        dropped: plan.dropped_ids.len(),
        summary_state: summary_state.to_string(),
    })
}

/// F4：空闲态事件发射（无活动 run 上下文——会话级 EventQueue 入队持久化
/// + 全局事件桥信封广播；run_id 缺省 None，前端按会话域消费）。返回事件
/// 序列号（块表落库锚点）；失败 → None（事件仅尽力而为，不阻断命令）
pub(crate) async fn push_emit_idle_event(
    queue: &Arc<tokio::sync::Mutex<EventQueue>>,
    bridge: &crate::core_event_bridge::EventBridge,
    session_id: &str,
    event: AgentEvent,
) -> Option<u64> {
    let mut queue = queue.lock().await;
    let sequenced = queue.push(session_id, event).await.ok()?;
    let envelope = AgentEventEnvelope::new(sequenced.event, None, Some(sequenced.sequence));
    bridge.emit_envelope(&envelope);
    Some(sequenced.sequence)
}

/// F4：DB body（SessionMessage）→ HistoryMessage（字段一一对应；再经
/// cached_history_to_conversation 保真水合为对话——与缓存路径同源）
pub(crate) fn session_message_to_history(message: conex_types::SessionMessage) -> HistoryMessage {
    HistoryMessage {
        id: message.id,
        sender: message.sender,
        text: message.text,
        thinking: message.thinking,
        blocks_json: message.blocks_json,
        tool_calls_json: message.tool_calls_json,
        tool_call_results_json: message.tool_call_results_json,
        status: message.status,
        timestamp: message.timestamp,
    }
}

// ── 命令：core_cancel_run ─────────────────────────────────────────

/// 取消 run（过渡双线（03 §4.2）：IPC 模式经 run-control 单线为主，
/// 本命令保留双线兼容——L2 协作 / L3 强制，模式回落走 RunEngine 语义）
///
/// T-AB-19 显式接线：取消**不清理后台任务注册表、不级联杀任务**——
/// 任务属会话级（registry 生命周期独立于 run）；run 终态（aborted /
/// cancelled）统一由 drive_run_loop 收口（含 owner_run_id 上下文释放），
/// 本命令只请求取消，不做任何任务域操作。
#[tauri::command]
pub(crate) async fn core_cancel_run(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    mode: Option<String>,
) -> Result<CancelRunResponse, CoreError> {
    cancel_run_impl(state.inner(), &run_id, mode.as_deref(), None).await
}

/// 取消 run 直调体（R1-04 REST 写面：与 core_cancel_run 同一语义——
/// L2 协作 / L3 强制；不依赖 Tauri runtime）。reason 缺省
/// "cancelled-by-user"（与 IPC 命令面行为一致）。
pub(crate) async fn cancel_run_impl(
    state: &CoreRunState,
    run_id: &str,
    mode: Option<&str>,
    reason: Option<&str>,
) -> Result<CancelRunResponse, CoreError> {
    let active = active_run(state, run_id.trim())?;
    let cancel_mode = match mode {
        Some("cooperative") => CancelMode::Cooperative,
        _ => CancelMode::Force,
    };
    let engine = ActiveRunEngine {
        active: Arc::clone(&active),
    };
    let mut handle = active.handle.lock().await;
    let path = handle
        .cancel_run(
            cancel_mode,
            Some(&engine),
            reason.unwrap_or("cancelled-by-user"),
            state.store.as_ref(),
        )
        .await
        .map_err(crate::core_error::map_run_err)?;
    drop(handle);
    tracing::info!(
        target: "run",
        run_id = %active.run_id,
        path = ?path,
        "cancel_run_impl（终态由 drive_run_loop 收口）：后台任务注册表未清理、任务不级联杀（T-AB-19 契约）"
    );
    Ok(CancelRunResponse {
        ok: true,
        run_id: active.run_id.clone(),
    })
}

