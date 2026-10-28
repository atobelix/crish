//! run/run_launch.rs（SR-02 · 拆分 · ≠ EL）
//!
//! 经 run/mod.rs 聚合接线；顶层符号 pub 化供兄弟模与门面 re-export。

use super::*;
use crate::core_error::CoreError;

///
/// - runtime-error 事件（持久化，03 §2.4 四源失败收口）；
/// - run 标记 failed（event-store-write-failed 语义，不假装可回放）；
/// - 终态事件尽力发出（run-terminal 唯一终态，03 §5.2-2）；
/// - lastError 写入（T04.5-1：finalize_failed 写入点）。
pub async fn finalize_failed(state: &Arc<CoreRunState>, active: &ActiveRun, message: &str) {
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
                timestamp: crate::engine_provider::now_iso_utc(),
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
    state
        .subagent_spawner
        .clear_current_run(&active.session_id, &run_id);
    if let Some(cfg) = active.subagent.clone() {
        state
            .on_subagent_run_terminal(&cfg, conex_db::RunStatus::Failed)
            .await;
    }
    notify_scheduled_run_failed(state, active, message);
    state.save_snapshot_now().await;
}

// ── 定时任务真实 Agent 运行终态回写钩子（Phase 2）──────────────────────

/// 定时任务运行终态回调载荷
#[derive(Debug, Clone)]
pub struct ScheduledRunTerminalOutcome {
    pub workflow_id: String,
    pub run_id: String,
    pub session_id: String,
    pub status: String,
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    pub duration_ms: u64,
    pub output_summary: Option<String>,
    pub error: Option<String>,
}

/// 定时任务终态回调函数类型
pub type ScheduledTerminalHook = Arc<dyn Fn(ScheduledRunTerminalOutcome) + Send + Sync + 'static>;

struct ScheduledRunHookEntry {
    workflow_id: String,
    started_at_ms: u64,
    hook: ScheduledTerminalHook,
}

fn scheduled_run_hooks() -> &'static Mutex<HashMap<String, ScheduledRunHookEntry>> {
    static HOOKS: std::sync::OnceLock<Mutex<HashMap<String, ScheduledRunHookEntry>>> =
        std::sync::OnceLock::new();
    HOOKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn scheduled_now_ms() -> u64 {
    crate::engine_assembly::unix_millis_now()
}

/// 注册指定 run_id 的定时任务终态回写钩子（在 run_task_impl 启动前登记）
pub fn register_scheduled_run_hook(
    run_id: String,
    workflow_id: String,
    started_at_ms: u64,
    hook: ScheduledTerminalHook,
) {
    scheduled_run_hooks()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            run_id,
            ScheduledRunHookEntry {
                workflow_id,
                started_at_ms,
                hook,
            },
        );
}

/// 取出并注销指定 run_id 的定时任务终态钩子（保证幂等单次触发）
pub fn take_scheduled_run_hook(run_id: &str) -> Option<(String, u64, ScheduledTerminalHook)> {
    scheduled_run_hooks()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(run_id)
        .map(|entry| (entry.workflow_id, entry.started_at_ms, entry.hook))
}

/// 从会话历史消息中提取最后一条 Assistant 回复摘要（截断至最多 300 字符）
pub fn extract_scheduled_output_summary(messages: &[HistoryMessage]) -> Option<String> {
    let last_text = messages
        .iter()
        .rev()
        .filter(|m| m.sender == "assistant")
        .find_map(|m| m.text.as_deref().map(str::trim).filter(|t| !t.is_empty()))?;
    const MAX_SUMMARY_CHARS: usize = 300;
    let char_count = last_text.chars().count();
    if char_count <= MAX_SUMMARY_CHARS {
        Some(last_text.to_string())
    } else {
        let truncated: String = last_text.chars().take(MAX_SUMMARY_CHARS).collect();
        Some(format!("{truncated}..."))
    }
}

/// 失败收口路径触发定时任务终态回写（finalize_failed / finalize_orphan_run 共用）
fn notify_scheduled_run_failed(state: &Arc<CoreRunState>, active: &ActiveRun, message: &str) {
    let Some((workflow_id, started_at_ms, hook)) = take_scheduled_run_hook(&active.run_id) else {
        return;
    };
    let finished_at_ms = scheduled_now_ms();
    let duration_ms = finished_at_ms.saturating_sub(started_at_ms);
    let output_summary = state
        .session_history
        .get(&active.session_id)
        .and_then(|msgs| extract_scheduled_output_summary(&msgs));
    hook(ScheduledRunTerminalOutcome {
        workflow_id,
        run_id: active.run_id.clone(),
        session_id: active.session_id.clone(),
        status: "failed".to_string(),
        started_at_ms,
        finished_at_ms,
        duration_ms,
        output_summary,
        error: Some(message.to_string()),
    });
}

/// drive_run_loop 正常收口后触发定时任务终态回写（若已由 finalize_failed 消费则自动跳过）
async fn notify_scheduled_run_terminal_after_drive(state: &Arc<CoreRunState>, active: &ActiveRun) {
    let Some((workflow_id, started_at_ms, hook)) = take_scheduled_run_hook(&active.run_id) else {
        return;
    };
    let run_status = active.handle.lock().await.status.clone();
    let status_str = match run_status {
        conex_db::RunStatus::Completed => "completed",
        conex_db::RunStatus::Cancelled => "cancelled",
        _ => "failed",
    };
    let finished_at_ms = scheduled_now_ms();
    let duration_ms = finished_at_ms.saturating_sub(started_at_ms);
    let output_summary = state
        .session_history
        .get(&active.session_id)
        .and_then(|msgs| extract_scheduled_output_summary(&msgs));
    let error = match status_str {
        "completed" => None,
        "cancelled" => Some("定时任务运行已取消".to_string()),
        _ => state
            .diagnostics
            .last_error()
            .map(|e| e.message)
            .or_else(|| Some("定时任务运行失败".to_string())),
    };
    hook(ScheduledRunTerminalOutcome {
        workflow_id,
        run_id: active.run_id.clone(),
        session_id: active.session_id.clone(),
        status: status_str.to_string(),
        started_at_ms,
        finished_at_ms,
        duration_ms,
        output_summary,
        error,
    });
}

/// 错误文案 → CrishErrorPayload（lastError 槽载荷；77 码显式兜底）
pub fn crish_payload_from_message(message: &str) -> CrishErrorPayload {
    CrishError::new(codes::COMMON_UNKNOWN, message.to_string()).to_error_payload(0)
}

// ── T5-2：孤儿 run 收割触发点 ─────────────────────────────────────

/// 孤儿 run 收割终态文案（锁定标记；与 drive 错误分支的「错误原文」
/// 可区分——前端/诊断据此识别「任务被中断，无终态收口」）。
pub const ORPHAN_REAP_MESSAGE: &str = "<panic> 任务已中断，无终态收口";

/// T5-2：孤儿 run 收割触发点——复用 [finalize_failed] 兜底收口
/// （runtime-error 持久化 + lastError 写入 + run-terminal(failed)
/// 终态事件 + 移出 activeRuns + 排空审计 worker + 快照）。
///
/// 触发时机由收割周期任务（run_commands.rs [reap_orphan_runs_round]）
/// 判定：`ActiveRun::driver.is_finished()` 连续 M 轮仍停留 activeRuns
/// （drive_run_loop 未走正常收口即退出——produce 内 panic 冒泡到 tokio
/// 任务边界被兜住、任务被 abort 等）→ 本触发点补写终态，防卡死/孤儿
/// 条目占用。**语义铁律**：终态记为 failed（非 cancelled），与 R1
/// 「kill_all 事件层 cancelled 为准」不重叠；去抖见收割轮。
pub async fn finalize_orphan_run(state: &Arc<CoreRunState>, active: &Arc<ActiveRun>) {
    finalize_failed(state, active, ORPHAN_REAP_MESSAGE).await;
}

/// 活动 run 查找（命令入口共用）
pub fn active_run(state: &CoreRunState, run_id: &str) -> Result<Arc<ActiveRun>, CoreError> {
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(run_id)
        .cloned()
        .ok_or_else(|| CoreError::NotFound(format!("run 不存在或已终态：{run_id}")))
}

/// 运行工作区根解析（共用 helper，与 loop 装配块 with_options 解析链
/// 同源：workspace_root → cwd → 当前目录；壳层 workspace_root 恒 None，
/// 等效 cwd → current_dir）。
pub fn resolve_run_workspace_root(cwd: Option<&str>) -> PathBuf {
    cwd.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// I1-β：run-task 思考档位入站解析（wire 值 → [ReasoningEffort]）。
///
/// 宽容 fail-open：未知 / 空值 → None（引擎默认档位，不阻断 run）——
/// 与 [SessionLoopOptions::reasoning_effort] 的「None = 提供方默认」语义
/// 一致，向后兼容（旧前端未发字段时行为与现状逐字节一致）。
pub fn parse_reasoning_effort(wire: &str) -> Option<session_loop::ReasoningEffort> {
    match wire.trim().to_ascii_lowercase().as_str() {
        "off" | "none" | "disabled" | "false" | "0" => Some(session_loop::ReasoningEffort::Off),
        "auto" => Some(session_loop::ReasoningEffort::Auto),
        "minimal" => Some(session_loop::ReasoningEffort::Minimal),
        "low" => Some(session_loop::ReasoningEffort::Low),
        "medium" => Some(session_loop::ReasoningEffort::Medium),
        "high" => Some(session_loop::ReasoningEffort::High),
        "xhigh" | "x-high" => Some(session_loop::ReasoningEffort::Xhigh),
        "max" => Some(session_loop::ReasoningEffort::Max),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // 测试面聚合：run 域平面（生产路径已显式 import，测试保留一站式可见）
    use crate::run::*;
    use session_loop::ReasoningEffort;

    /// I1-β：档位 wire 解析——全档位命中 + 大小写/空白宽容 + 未知值
    /// fail-open None（引擎默认，不阻断 run）
    #[test]
    fn reasoning_effort_parse_covers_all_levels_and_fails_open() {
        assert_eq!(parse_reasoning_effort("off"), Some(ReasoningEffort::Off));
        assert_eq!(parse_reasoning_effort("none"), Some(ReasoningEffort::Off));
        assert_eq!(
            parse_reasoning_effort("disabled"),
            Some(ReasoningEffort::Off)
        );
        assert_eq!(parse_reasoning_effort("auto"), Some(ReasoningEffort::Auto));
        assert_eq!(
            parse_reasoning_effort("minimal"),
            Some(ReasoningEffort::Minimal)
        );
        assert_eq!(parse_reasoning_effort("low"), Some(ReasoningEffort::Low));
        assert_eq!(
            parse_reasoning_effort("medium"),
            Some(ReasoningEffort::Medium)
        );
        assert_eq!(parse_reasoning_effort("high"), Some(ReasoningEffort::High));
        assert_eq!(
            parse_reasoning_effort("xhigh"),
            Some(ReasoningEffort::Xhigh)
        );
        assert_eq!(
            parse_reasoning_effort("x-high"),
            Some(ReasoningEffort::Xhigh)
        );
        assert_eq!(parse_reasoning_effort("max"), Some(ReasoningEffort::Max));
        // 大小写 / 空白宽容
        assert_eq!(
            parse_reasoning_effort("  High "),
            Some(ReasoningEffort::High)
        );
        assert_eq!(
            parse_reasoning_effort(" Disabled "),
            Some(ReasoningEffort::Off)
        );
        // 未知 / 空 → None（引擎默认档位，不阻断 run，向后兼容）
        assert_eq!(parse_reasoning_effort("ultra"), None);
        assert_eq!(parse_reasoning_effort(""), None);
        assert_eq!(parse_reasoning_effort("  "), None);
    }

    // ── 会话串行守卫 TOCTOU 闭合（acquire_launch_slot / RunLaunchGuard
    //    语义锚定）──────────────────────────────────────────────────

    use orchestrator::persist::InMemoryStore;
    use orchestrator::restore::SnapshotFileStore;

    /// 记录型发射器（事件桥测试替身；对齐 run_commands tests）
    #[derive(Default)]
    struct RecordingEmitter(std::sync::Mutex<Vec<String>>);

    impl crate::core_event_bridge::Emitter for RecordingEmitter {
        fn emit(&self, _channel: &str, payload: &str) {
            self.0.lock().unwrap().push(payload.to_string());
        }
    }

    /// 测试用 CoreRunState（InMemoryStore + 独立快照文件 + 记录桥；
    /// 对齐 run_commands tests::test_state）
    fn launch_guard_test_state() -> Arc<CoreRunState> {
        launch_guard_test_state_with_store(Arc::new(InMemoryStore::new()))
    }

    fn launch_guard_test_state_with_store(
        store: Arc<dyn orchestrator::persist::Store>,
    ) -> Arc<CoreRunState> {
        let emitter = Arc::new(RecordingEmitter::default());
        let bridge = EventBridge::new(
            "workbench-run-event",
            Arc::clone(&emitter) as Arc<dyn crate::core_event_bridge::Emitter>,
        );
        let snapshots: Arc<dyn SnapshotStore> =
            Arc::new(SnapshotFileStore::new(std::env::temp_dir().join(format!(
                "conex_launch_guard_{}_{}_snapshot.json",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ))));
        Arc::new(CoreRunState::new(
            store,
            snapshots,
            bridge,
            Arc::new(StatusDiagnostics::new()),
            None,
        ))
    }

    /// 占位存在期间（装配中）同会话第二次启动被拒——TOCTOU 闭合的同步
    /// 语义锚点（检查与占用同临界区；并发 core_run_task 的第二次调用
    /// 在此拒绝路径拦截）；其他会话不受影响
    #[test]
    fn launch_slot_rejects_second_acquire_while_assembling() {
        let state = launch_guard_test_state();
        let _guard = acquire_launch_slot(&state, "sess-a").expect("首次占用应通过");
        let second = acquire_launch_slot(&state, "sess-a");
        assert!(
            second.is_err(),
            "launching 占位存在期间同会话第二次启动必须被拒（TOCTOU 闭合语义）"
        );
        assert!(
            state.assembling_sessions.lock().unwrap().contains("sess-a"),
            "被拒请求不得清除既有占位"
        );
        let _other = acquire_launch_slot(&state, "sess-b").expect("其他会话不受占位影响");
    }

    /// 守卫 drop 无条件释放占位——覆盖全部早退 Err 分支 / panic 展开，
    /// 防装配失败泄漏导致会话永久无法再启动 run
    #[test]
    fn launch_guard_drop_releases_session_slot() {
        let state = launch_guard_test_state();
        {
            let _guard = acquire_launch_slot(&state, "sess-a").expect("首次占用应通过");
            // 模拟早退路径：guard 在此 drop
        }
        assert!(
            !state.assembling_sessions.lock().unwrap().contains("sess-a"),
            "守卫 drop 必须无条件清理占位"
        );
        let again = acquire_launch_slot(&state, "sess-a");
        assert!(again.is_ok(), "占位清理后同会话必须可再次启动");
    }

    /// 活动 run 已在 active_runs 时同会话启动被拒（既有串行守卫语义，
    /// 重构不回归）；拒绝路径不残留装配期占位
    #[tokio::test]
    async fn launch_slot_rejects_when_active_run_present() {
        let state = launch_guard_test_state();
        let handle = Arc::new(tokio::sync::Mutex::new(
            state
                .run_manager
                .start_run("sess-a", "run-1")
                .await
                .expect("start_run"),
        ));
        let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
            state.store.clone(),
            0,
            None,
        )));
        let bridge = Arc::new(BufferedRunEventBridge::new(
            state.bridge.clone(),
            "run-1".to_string(),
        ));
        let broadcast_bridge = Arc::clone(&bridge);
        let broadcast = Box::new(move |event: AgentEvent| {
            let envelope = AgentEventEnvelope::new(event, Some("run-1".to_string()), None);
            broadcast_bridge.emit(&envelope);
            broadcast_bridge.flush();
        });
        let approval = Arc::new(ApprovalGateImpl::new(
            "run-1".to_string(),
            "sess-a".to_string(),
            None,
            broadcast,
            Arc::clone(&handle),
            state.store.clone(),
            None,
        ));
        let active = Arc::new(ActiveRun {
            session_id: "sess-a".to_string(),
            run_id: "run-1".to_string(),
            handle,
            queue,
            control_bus: Arc::new(Mutex::new(ControlBus::new())),
            abort_signal: AbortSignal::new(),
            approval,
            bridge,
            delta_sink_active: true,
            driver: Mutex::new(None),
            user_touched: AtomicBool::new(false),
            subagent: None,
            audit_persist: Mutex::new(None),
            permission: conex_agents::permission::PermissionCell::root(
                conex_types::PermissionMode::default(),
            ),
            capability: conex_agents::capability::CapabilityCell::root(
                conex_agents::task::SubagentCapabilityMode::All,
            ),
            model: Arc::new(conex_agents::model::ModelCell::new(None)),
            project_name: String::new(),
            phase: std::sync::RwLock::new(ExecutionPhase::Active),
            last_heartbeat_ms: std::sync::atomic::AtomicU64::new(
                conex_shared::time::unix_millis() as u64
            ),
        });
        state
            .active_runs
            .lock()
            .unwrap()
            .insert("run-1".to_string(), Arc::clone(&active));

        let attempt = acquire_launch_slot(&state, "sess-a");
        assert!(
            attempt.is_err(),
            "active_runs 已有同会话活动 run 时启动必须被拒（既有守卫语义）"
        );
        assert!(
            !state.assembling_sessions.lock().unwrap().contains("sess-a"),
            "拒绝路径不得残留装配期占位"
        );
    }

    /// provider 快照缺失时必须在启动装配任何可观察副作用前拒绝：
    /// 不建 watcher、不清用户停止标记，也不覆盖既有 goal_state。
    #[tokio::test]
    async fn missing_provider_is_rejected_before_launch_side_effects() {
        let db = conex_db::LocalDb::open_in_memory().expect("内存数据库");
        let previous_goal = GoalState::new("保留中的目标", 7, 3).to_json();
        db.set_session_meta(orchestrator::goal_state::GOAL_STATE_KEY, &previous_goal)
            .expect("预置既有 goal_state");
        let store: Arc<dyn orchestrator::persist::Store> =
            Arc::new(orchestrator::persist::LocalDbStore::new(db.clone()));
        let state = launch_guard_test_state_with_store(store);
        state.restore_ready.store(true, Ordering::SeqCst);
        // 模拟就绪标记与 provider 快照不一致的瞬间，确保 provider 快照
        // 自身在装配副作用前完成校验。
        *state
            .engine
            .provider
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        state.engine.ready.store(true, Ordering::SeqCst);
        state.set_user_stopped("sess-missing-provider");

        let options = serde_json::from_value(serde_json::json!({
            "runId": "run-missing-provider",
            "sessionId": "sess-missing-provider",
            "prompt": "启动应被拒绝",
            "mode": "goal",
            "visibleGoal": "不得覆盖的目标"
        }))
        .expect("构造 run options");
        match run_task_impl(Arc::clone(&state), options).await {
            Err(CoreError::Internal(detail)) => assert!(
                detail.contains("provider 配置缺失"),
                "应由 provider 快照缺失拒绝，实际 detail={detail}"
            ),
            other => panic!("provider 快照缺失时应返回 Internal，实际结果={other:?}"),
        }

        assert!(
            !state
                .wake_watchers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .contains_key("sess-missing-provider"),
            "provider 缺失时不得创建 wake watcher"
        );
        assert!(
            state.is_user_stopped("sess-missing-provider"),
            "provider 缺失时不得清除 user_stopped"
        );
        let goal_after = db
            .get_session_meta(orchestrator::goal_state::GOAL_STATE_KEY)
            .expect("读取 goal_state")
            .expect("既有 goal_state 仍存在");
        assert_eq!(
            goal_after, previous_goal,
            "provider 缺失时不得覆盖既有 goal_state"
        );
    }

    // ── 权限模式解析（三态 SSOT + 历史别名安全回落）──────────────

    #[test]
    fn permission_mode_parse_covers_three_modes_and_legacy_aliases() {
        // 三态原名
        assert_eq!(
            parse_permission_mode_opt(Some("ask")),
            Some(PermissionMode::Ask)
        );
        assert_eq!(
            parse_permission_mode_opt(Some("smart")),
            Some(PermissionMode::Smart)
        );
        assert_eq!(
            parse_permission_mode_opt(Some("full")),
            Some(PermissionMode::Full)
        );
        // 大小写 / 空白宽容
        assert_eq!(
            parse_permission_mode_opt(Some("  FULL-Access ")),
            Some(PermissionMode::Full)
        );
        // 历史 full 语义别名
        for alias in ["full_access", "yolo", "danger", "allow"] {
            assert_eq!(
                parse_permission_mode_opt(Some(alias)),
                Some(PermissionMode::Full),
                "{alias} 应归一到 full"
            );
        }
        // 历史只读/分析语义一律回落 Ask（绝不升级为可写的 smart/full）
        for alias in [
            "plan",
            "deep",
            "confirm",
            "readonly",
            "read-only",
            "safe",
            "cautious",
            "analysis",
        ] {
            assert_eq!(
                parse_permission_mode_opt(Some(alias)),
                Some(PermissionMode::Ask),
                "{alias} 应安全回落 ask"
            );
        }
        // auto → smart
        assert_eq!(
            parse_permission_mode_opt(Some("auto")),
            Some(PermissionMode::Smart)
        );
        // 未知 / 空 / 缺省 → None（调用方决定继承或默认，不得悄悄覆盖）
        assert_eq!(parse_permission_mode_opt(Some("ultra")), None);
        assert_eq!(parse_permission_mode_opt(Some("   ")), None);
        assert_eq!(parse_permission_mode_opt(None), None);
        // 便捷入口：未知/缺省 → 默认 smart
        assert_eq!(parse_permission_mode(None), PermissionMode::default());
        assert_eq!(
            parse_permission_mode(Some("ultra")),
            PermissionMode::default()
        );
    }

    #[test]
    fn permission_mode_session_meta_key_is_session_scoped() {
        assert_eq!(
            session_meta_key_of("sess-1", "permission_mode"),
            "sess-1:permission_mode"
        );
        // 空会话 id 回落全局键（兼容既有单会话读取面）
        assert_eq!(
            session_meta_key_of("", "permission_mode"),
            "permission_mode"
        );
        // 不同会话的键互不相同（模式继承不得串会话）
        assert_ne!(
            session_meta_key_of("sess-a", "permission_mode"),
            session_meta_key_of("sess-b", "permission_mode")
        );
    }
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
    /// I1-β：思考档位入站（`defaultThinkingLevel` → `ReasoningEffort`
    /// 映射后的 wire 值，minimal/low/medium/high/xhigh/max；None = 未
    /// 下发，引擎按提供方默认档位，wire 与现状逐字节一致）。装配进
    /// [SessionLoopOptions::reasoning_effort]（build_request 读档位下发）。
    /// serde camelCase 由结构体级 rename_all 覆盖（`reasoningEffort`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// I1-α②（扩展点 A）：context-state 感知注入文本（前端 provider-profiles
    /// 状态切换产生器生成的快照文本：「当前已切换到模型 X / 权限 Y / 思考档位 Z」；None = 无状态切换告知）。
    /// 装配：run_task_impl 收到后与 prompt 融合成合体信封当次生效，0 额外 Turn，绝不入跨 run 队列。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_state: Option<String>,
    /// 多模态 content 桥（plans/04 §4.2）：OpenAI 形 parts（`type: image_url`
    /// 等），写入用户消息 `metadata.contentParts`。None = 纯文本 run。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<serde_json::Value>,
    /// 是否带图（`content` 仅在 `hasImages == true` 时进入消息元数据，
    /// 避免纯文本 parts 重复载荷）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_images: Option<bool>,
    /// 最大轮次预算（None = 未传，按会话持久化 meta / 模式自适应解析；0 = 无限预算）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
}

// ── 会话串行守卫 TOCTOU 闭合（装配期会话占用，RAII）────────────────
//
// 此前守卫在 active_runs 锁内扫描后即释放锁，真实 active_runs.insert
// 在数百行装配（start_run 落库 / spawn_blocking / 审批门装配等多个
// await 点）之后——同会话并发 core_run_task（前端双击 / 重试风暴）
// 可双双通过检查、各自 spawn drive_run_loop，违反会话内串行不变量。
// 闭合方式：检查与占用插入同一临界区（[acquire_launch_slot] 占用
// `assembling_sessions`），真实条目入 active_runs 前同会话第二次启动
// 一律拒绝；占用凭证由 [RunLaunchGuard] 持有，drop 无条件清理。

/// 启动装配期会话占用守卫（RAII）：
///
/// - 构造：[acquire_launch_slot] 在 `assembling_sessions` 临界区内
///   完成占用插入后返回本守卫；
/// - drop：无条件从 `assembling_sessions` 移除会话标记——覆盖
///   run_task_impl 全部早退 Err 分支（provider 缺失 / 子代理工具集
///   裁剪失败 / start_run 落库失败 / 写路径白名单解析失败）与 panic
///   展开，防装配失败泄漏导致会话永久无法再启动 run；
/// - 成功路径：真实 active_runs.insert 先于守卫释放，此后并发启动由
///   active_runs 扫描拒绝（守卫移除不产生守卫空窗——注册表条目已
///   承载串行语义）；占位非活动 run，不参与 reaper / 终态钩子扫描
///   （reaper 只扫 active_runs 的 driver is_finished）。
struct RunLaunchGuard {
    state: Arc<CoreRunState>,
    session_id: String,
}

impl Drop for RunLaunchGuard {
    fn drop(&mut self) {
        self.state
            .assembling_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.session_id);
    }
}

/// 会话串行守卫（同会话同时只允许一个活动 run）+ 装配期占用获取。
///
/// 单临界区完成「活动 run 扫描 + 占用插入」：持 `assembling_sessions`
/// 锁期间嵌套读 `active_runs`（仅此一处双锁，无其他逆序获取点，无
/// 死锁面）。占用插入失败（同会话已在装配中）或活动 run 已存在 →
/// 拒绝（InvalidInput，文案与既有守卫一致）。
fn acquire_launch_slot(
    state: &Arc<CoreRunState>,
    session_id: &str,
) -> Result<RunLaunchGuard, CoreError> {
    let mut assembling = state
        .assembling_sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
    if active.values().any(|run| run.session_id == session_id)
        || !assembling.insert(session_id.to_string())
    {
        return Err(CoreError::invalid_input(format!(
            "会话 {session_id} 已有活动 run（串行守卫）"
        )));
    }
    Ok(RunLaunchGuard {
        state: Arc::clone(state),
        session_id: session_id.to_string(),
    })
}

/// estop 桥装配判定（31 评审 F2 / 30 评审 H-2 邻接）：**仅主 run 装配**——
/// 子代理 run 不 reset_estop、不挂 watcher。故障链：子代理 run 被取消
/// （L3/超时/kill_all）→ watcher 触发 cancel_estop → 急停旗置位 → 主 run
/// 本 run 剩余全部 browser_* 命令被 EmergencyStop 拒绝且同 run 无复位点
/// （浏览器操作整段失效，直到下一 run 启动）。browser_* 工具已按 27 §3
/// 从子代理注册面剔除（F1，readonly.rs filter_registry_for_task_type），
/// 子代理无 estop 消费方，装配即纯风险。
pub fn assemble_browser_estop(
    subagent_config: &Option<crate::subagent_spawner::SubagentRunConfig>,
) -> bool {
    subagent_config.is_none()
}

/// D6 决策 1：用户发起 run 判定（自动续 run 模式不写不清 user_stopped——
/// idle-resume / recovery-retry / content-resume / goal-continue 为引擎
/// 自主行为；其余（None / task / goal 等用户下发模式）视为用户新 run，
/// 装配时清除停止标记恢复自动行为）
pub fn is_user_initiated_mode(mode: Option<&str>) -> bool {
    !matches!(
        mode,
        Some("idle-resume" | "recovery-retry" | "content-resume" | "goal-continue" | "scheduled")
    )
}

/// 强类型权限模式解析（别名映射唯一真理源 = [PermissionMode::parse_alias]；
/// 未知/空 → None，便于调用方区分「未指定」与「显式选择」）
pub fn parse_permission_mode_opt(raw: Option<&str>) -> Option<PermissionMode> {
    PermissionMode::parse_alias(raw)
}

/// 强类型权限模式解析（未知/空 → 默认 Smart）
pub fn parse_permission_mode(raw: Option<&str>) -> PermissionMode {
    PermissionMode::parse_alias_or_default(raw)
}

/// 解析 run 的 max_turns 轮次预算：
/// 1. 显式请求参数最高优先（Some(0) 代表无限预算模式）；
/// 2. 会话元数据 session_meta 中持久化的 max_turns；
/// 3. 自主/连续模式（goal、scheduled、idle-resume 等）缺省为 0（无限预算）；
/// 4. 常规模式兜底为 MAX_TURNS_DEFAULT（512 轮）。
pub fn resolve_max_turns(
    requested: Option<u32>,
    session_id: &str,
    mode: Option<&str>,
    state: &CoreRunState,
) -> u32 {
    if let Some(turns) = requested {
        return turns;
    }
    if let Some(db) = state.local_db() {
        let key = session_meta_key_of(session_id, META_KEY_MAX_TURNS);
        if let Some(turns) = db
            .get_session_meta(&key)
            .ok()
            .flatten()
            .or_else(|| db.get_session_meta(META_KEY_MAX_TURNS).ok().flatten())
            .and_then(|val| val.trim().parse::<u32>().ok())
        {
            return turns;
        }
    }
    match mode {
        Some("goal" | "scheduled" | "idle-resume" | "content-resume" | "goal-continue") => 0,
        _ => MAX_TURNS_DEFAULT,
    }
}

/// run 任务命令体（core_run_task 与 T-CF-11 idle 续 run 共用装配路径；
/// 测试可直调，不依赖 Tauri runtime——对齐 background.rs「契约体」模式）。
/// owned Arc 参数：future 内不持有引用，保证 Send（spawn 任务内可 await）。
pub async fn run_task_impl(
    state: Arc<CoreRunState>,
    options: RunTaskOptions,
) -> Result<RunTaskResponse, CoreError> {
    let state = Arc::clone(&state);
    // 参数校验（S-15：trim + 显式 InvalidInput）
    let run_id = options.run_id.trim().to_string();
    let session_id = options.session_id.trim().to_string();
    let prompt = options.prompt;
    let mode = options.mode;
    // INT-02 全局沙箱目录兜底：若 mode == "scheduled" 且未配置 cwd 或 cwd 为空串，自动解析并创建 scheduled-tasks-sandbox
    let cwd = if mode.as_deref() == Some("scheduled") {
        crate::workflow::resolve_effective_workflow_cwd(options.cwd.as_deref(), None)
    } else {
        options.cwd
    };
    // 工程名归属（usage_records.project_name）：cwd 末段；缺省空串
    let project_name = cwd
        .as_deref()
        .and_then(|path| std::path::Path::new(path).file_name())
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    // 会话策略装载：把持久化的 AgentPolicy 同步到 spawner（重启/补丁后生效）
    if let Some(service) = state.engine.agent_policy_service() {
        service.install(&session_id);
    }
    let parent_run_id = options.parent_run_id.clone();
    let requested_max_turns = options.max_turns;
    let max_turns = resolve_max_turns(requested_max_turns, &session_id, mode.as_deref(), &state);
    let permission_mode = options.permission_mode;

    // 强类型权限模式解析（消除字符串浅比较与别名穿透脆弱性）：
    // 1. 若显式下发 permission_mode，使用 parse_permission_mode 解析；
    //    对于主 run（parent_run_id 为 None），将其持久化到 session_meta 中保持跨 run 继承；
    // 2. 若未下发，尝试从 session_meta 事实源中读取之前持久化的权限模式；
    // 3. 兜底回退至系统默认权限模式（PermissionMode::default()）。
    let effective_permission_mode: PermissionMode = match permission_mode.as_deref() {
        Some(raw) => {
            let mode = parse_permission_mode(Some(raw));
            if parent_run_id.is_none() {
                if let Some(db) = state.local_db() {
                    let key = session_meta_key_of(&session_id, "permission_mode");
                    let _ = db.set_session_meta(&key, mode.as_str());
                }
            }
            mode
        }
        None => state
            .local_db()
            .and_then(|db| {
                let key = session_meta_key_of(&session_id, "permission_mode");
                db.get_session_meta(&key)
                    .ok()
                    .flatten()
                    .or_else(|| db.get_session_meta("permission_mode").ok().flatten())
            })
            .map(|s| parse_permission_mode(Some(&s)))
            .unwrap_or_default(),
    };
    let client_message_id = options.client_message_id;
    let assistant_client_message_id = options.assistant_client_message_id;
    let system_prompt = options.system_prompt;
    let history = options.history;
    let context_window = options.context_window;
    // plans/04 §4.2：多模态 content 桥（hasImages 时把 OpenAI 形 parts 写入
    // 用户消息 metadata.contentParts；先于下方 SessionLoopOptions 遮蔽取出）
    let content_parts = options.content.filter(|_| options.has_images == Some(true));
    // T-D-13：子代理 run 装配配置（None = 普通 run，装配行为与现状一致）
    let subagent_config = options.subagent_config;

    // P0：运行时权限单元——子代理挂到父链，父权限变更下一批次自动生效；
    // 子代理显式请求只作为 ceiling（只可收窄，不可放宽）。
    let permission_cell = match (
        subagent_config.as_ref(),
        parent_run_id
            .as_deref()
            .and_then(|parent| state.permission_cell_for_run(parent)),
    ) {
        (Some(config), Some(parent_cell)) => conex_agents::permission::PermissionCell::child(
            parent_cell,
            config
                .permission_mode
                .as_deref()
                .and_then(|raw| parse_permission_mode_opt(Some(raw))),
        ),
        _ => conex_agents::permission::PermissionCell::root(effective_permission_mode),
    };

    // P0：运行时能力单元——主 agent = All（不 gate）；子代理按 task_type 默认
    // 或显式 capability，挂到父能力链（父降级时子自动收窄）。
    let capability_cell = match subagent_config.as_ref() {
        Some(config) => {
            let requested = config
                .capability_mode
                .as_deref()
                .and_then(conex_agents::task::SubagentCapabilityMode::parse)
                .or_else(|| {
                    config
                        .task_type
                        .as_deref()
                        .and_then(conex_agents::task::TaskType::parse)
                        .map(|task| task.default_capability())
                })
                .unwrap_or(conex_agents::task::SubagentCapabilityMode::ReadOnly);
            match parent_run_id
                .as_deref()
                .and_then(|parent| state.capability_cell_for_run(parent))
            {
                Some(parent_cell) => {
                    conex_agents::capability::CapabilityCell::child(parent_cell, requested)
                }
                None => conex_agents::capability::CapabilityCell::root(requested),
            }
        }
        None => conex_agents::capability::CapabilityCell::root(
            conex_agents::task::SubagentCapabilityMode::All,
        ),
    };
    // D5 §3.1：goal 模式三字段（mode=="goal" 装配输入；None 缺省由
    // [GoalState::with_defaults] 落引擎缺省 12/2，D5 §3.1 缺省规则）
    let visible_goal = options.visible_goal;
    let max_rounds = options.max_rounds;
    let max_stalled_rounds = options.max_stalled_rounds;
    // I1-β：思考档位入站（wire 值 → [ReasoningEffort]；None / 非法值 →
    // 引擎默认，宽容 fail-open，不阻断 run）
    let reasoning_effort = options
        .reasoning_effort
        .as_deref()
        .and_then(parse_reasoning_effort);
    // I1-α②：context-state 感知注入文本（前端状态切换产生器下发；
    // None = 无切换告知）
    let context_state = options.context_state;

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
    // 固定本次启动所用 provider 快照，并在 watcher / user_stopped /
    // goal_state 等装配副作用之前验证。配置热重载可替换引擎当前 provider，
    // 后续本次 run 全程使用此处取得的同一实例；模型覆盖经 SwitchingProvider
    // 每次调用前解析（下一 turn 生效，不打断在途请求）。
    let Some(base_provider) = state.engine.provider() else {
        return Err(CoreError::internal("engine not ready（provider 配置缺失）"));
    };
    let model_cell = Arc::new(conex_agents::model::ModelCell::new(
        subagent_config
            .as_ref()
            .and_then(|config| config.model_override.clone()),
    ));
    let provider: Arc<dyn session_loop::provider::ProviderCall> =
        Arc::new(crate::engine_handle::SwitchingProvider::new(
            state.engine(),
            Arc::clone(&model_cell),
            base_provider,
        ));
    // 会话内串行守卫（同会话同时只允许一个活动 run）+ 装配期占用
    //（TOCTOU 闭合：检查与占用同一临界区；守卫 drop 无条件清理全部
    // 早退路径，成功 insert 后显式释放——见下方 active_runs.insert）
    let _launch_guard = acquire_launch_slot(&state, &session_id)?;
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
    // 工具注册表（engine 生效配置）
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
            .map_err(|error| CoreError::internal(format!("子代理工具集裁剪失败：{error}")))?;
            let filtered = agent_tools::readonly::filter_registry(&filtered, |name| {
                name != agent_tools::tools::subagent::SUBAGENT_SPAWNER_TOOL_NAME
                    && name != agent_tools::tools::kill_subagent::SUBAGENT_KILL_TOOL_NAME
                    && name != agent_tools::tools::send_message::SEND_MESSAGE_TOOL_NAME
                    && name != agent_tools::tools::configure_agents::CONFIGURE_AGENTS_TOOL_NAME
                    && name != agent_tools::tools::grant_capability::GRANT_CAPABILITY_TOOL_NAME
                    && name
                        != agent_tools::tools::switch_agent_model::SWITCH_AGENT_MODEL_TOOL_NAME
            })
            .map_err(|error| CoreError::internal(format!("子代理工具集剔除失败：{error}")))?;
            // 能力档裁剪（纵深防御；运行中升降级由执行面 gate 承担）
            let filtered = agent_tools::readonly::filter_registry_for_capability(
                &filtered,
                capability_cell.effective(),
            )
            .map_err(|error| CoreError::internal(format!("子代理能力裁剪失败：{error}")))?;
            Arc::new(filtered)
        }
        None => base_registry,
    };

    // 确保 session 行存在（自愈补建，避免 FK 报错；对齐 session_commands::self_heal_then_save_body）
    if let Some(db) = state.local_db() {
        let sid = session_id.clone();
        let _ = tokio::task::spawn_blocking(move || db.insert_session(&sid, "")).await;
    }

    // 注册 run（queued → initializing → running，落库）
    let handle = state
        .run_manager
        .start_run(&session_id, &run_id)
        .await
        .map_err(crate::core_error::map_run_err)?;
    let handle_shared = Arc::new(tokio::sync::Mutex::new(handle));

    // 事件队列（base = 预热/懒计算 max+1，T08.8：不重置为 1）。
    // R1（统一输入流收敛战役）：挂载会话级撤回冻结护栏——与撤回命令
    // （retraction_commands.rs）共享 state.retraction_freeze 同一实例，
    // 冻结激活期写侧拒绝 `> frozen_seq` 非撤离写入
    let base = state.base_sequence_for(&session_id).await;
    let queue = Arc::new(tokio::sync::Mutex::new(
        EventQueue::new(state.store.clone(), base, Some(run_id.clone()))
            .with_freeze_registry(Arc::clone(&state.retraction_freeze)),
    ));

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
    // W2-T3（02-approval §五 / 01-improvements §六）：死锁检测拓扑闭环接线
    // 注入死锁检测闭包：当主 agent 正在阻塞等待该子代理时，0ms 识别死锁，
    // 路由由 Arbiter::MainAgent 升维为 Arbiter::User 或策略放行，彻底消除 120s 假死
    let wait_registry = Arc::clone(&state.subagent_wait_registry);
    let p_id = parent_run_id.clone();
    let deadlock_detector: Box<dyn Fn(&str) -> bool + Send + Sync> =
        Box::new(move |subagent_run_id: &str| {
            if let Some(parent) = &p_id {
                wait_registry.is_parent_waiting_subagent(parent, subagent_run_id)
            } else {
                false
            }
        });
    let approval_gate = Arc::new(
        ApprovalGateImpl::new(
            run_id.clone(),
            session_id.clone(),
            // T-D-14：父 run 归属（子代理 run 由 spawner 携带；None = 主 agent）
            parent_run_id.clone(),
            broadcast,
            Arc::clone(&handle_shared),
            state.store.clone(),
            cwd.clone(),
        )
        .with_deadlock_detector(deadlock_detector),
    );

    // 权限架构收敛（00-总方案 §6.2）：ApprovalGateImpl 作为基础设施常态就绪装配，
    // 彻底消除 approval: None 死局分支；是否唤起审批由中心裁决中心（call_verdict）按模式判定
    let approval: Option<Arc<dyn ApprovalGate>> =
        Some(Arc::clone(&approval_gate) as Arc<dyn ApprovalGate>);

    // T09.1 / DIM-01 实时双轨：BridgeLiveSink 注入 SessionLoopProducer 与 SessionLoopOptions
    let live_sink: Arc<BridgeLiveSink> =
        Arc::new(BridgeLiveSink::new(Arc::clone(&bridge), run_id.clone()));
    let delta_sink: Arc<dyn DeltaSink> = Arc::clone(&live_sink) as Arc<dyn DeltaSink>;

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
    let audit_worker =
        spawn_audit_persistence(Arc::clone(&queue), session_id.clone(), audit_persist_rx);
    let bridge_audit_sink = Arc::new(BridgeAuditSink::new(
        Arc::clone(&bridge),
        run_id.clone(),
        audit_persist_tx,
    ));
    let run_root = resolve_run_workspace_root(cwd.as_deref());
    let control_bus = Arc::new(Mutex::new(ControlBus::new()));
    let shared_registry = Arc::new(WritePathRegistry::new(session_id.clone(), &run_root));
    let abort_signal = AbortSignal::new();
    // 壳域 watcher 接线（browser estop 复位 + watcher / computer 停止
    // watcher）经装配钩子注入——本 crate 不感知 browser/computer 槽
    if let Some(hooks) = crate::engine_assembly::run_launch_hooks() {
        hooks.on_run_assembled(&session_id, subagent_config.is_some(), abort_signal.clone());
    }

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
    let (subagent_write_registry, subagent_quota, subagent_injector) = match &subagent_config {
        None => (subagent_write_registry, subagent_quota, subagent_injector),
        Some(config) => {
            // 工作区根解析链（与 loop 装配块同源，经共用 helper
            // resolve_run_workspace_root——单一真源，杜绝双处漂移复发；
            // 壳层 workspace_root 恒 None，等效 cwd → current_dir）
            let root = resolve_run_workspace_root(cwd.as_deref());
            // 写路径沙箱装配
            let write_registry = match &config.allowed_write_paths {
                Some(paths) => {
                    let policy =
                        WritePathPolicy::from_entries(&root, paths.clone()).map_err(|error| {
                            CoreError::internal(format!("写路径白名单解析失败：{error}"))
                        })?;
                    Some(Arc::new(
                        WritePathRegistry::new(session_id.clone(), &root).with_write_policy(policy),
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
                Some("design") | Some("review") => {
                    state.local_db().map(|db| ExploreDocsQuotaContext {
                        session_id: session_id.clone(),
                        run_id: run_id.clone(),
                        granted: true,
                        quota: 1,
                        store: Some(Arc::new(conex_db::SessionMetaExploreDocsQuotaStore::new(
                            db,
                        ))),
                    })
                }
                _ => None,
            };
            // 提示词注入段装配（M1 挂载形状：title + content → push）
            let mut injector = ContextInjector::new();
            // T-D-03：子代理角色约束（主 Agent run 装配点不调用——
            // 「主 Agent run 不含本段」断言的关键差异点）
            crate::context_injection::push_subagent_role_constraint(&mut injector);
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

            // T-D-14：权限申请指引段（默认权限 + 申请纪律——
            // 「申请由主 agent 审批」；漏挂会导致子代理越权或静默放弃）
            let (perm_title, perm_content) =
                agent_tools::subagent_inject::permission_relay_injection(
                    config.task_type.as_deref(),
                    None,
                );
            injector.push(ContextInjection::new(
                ContextInjectionKind::System,
                perm_title,
                perm_content,
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

    // ── D1 §3.1.4/§3.2.3：退避与熔断配置装配 ──
    // 优先级（用户裁决：重试预算/上限用户可配置，进配置文件不绑供应商）：
    // 1. 会话级键 `provider_retry_backoff_ms`（既有 per-session 覆盖）；
    // 2. 全局运行策略文件 `settings.json` 的 runPolicy 段（config::run_policy）；
    // 3. 缺省：750ms 指数退避 / 8s 封顶 / 180s 总预算、10 次上限（文件
    //    引入前的行为，保持不变）。
    // - provider_fail_streak：`provider_fail_streak` 键 count → 熔断闸
    //   C1 输入（transient_retry 入口 >= 阈值直接 fatal）。熔断计数落
    //   键在收口 [Self::update_provider_fail_streak]（唯一写方），本装配
    //   点只读注入——天然跨 run（D1 §3.2.3 装配时序）。
    let run_policy = state.run_policy();
    let retry_backoff = state.retry_backoff_config(&session_id).or_else(|| {
        run_policy.as_ref().and_then(|policy| {
            policy
                .retry_backoff
                .as_ref()
                .map(|backoff| session_loop::r#loop::RetryBackoffConfig {
                    base_ms: backoff.base_ms,
                    max_ms: backoff.max_ms,
                    total_budget_ms: backoff.total_budget_ms,
                })
        })
    });
    let provider_fail_streak = state.provider_fail_streak_count(&session_id).await;

    let options = {
        let mut o = SessionLoopOptions::default();
        o.tool_exec.cwd = cwd.clone();
        o.tool_exec.assistant_client_message_id = assistant_client_message_id.clone();
        o.assembly.system_prompt =
            assemble_system_prompt_with_stages(&state, &session_id, system_prompt);
        o.assembly.context_budget = context_budget;
        o.retry.retry_backoff = retry_backoff.or(Some(session_loop::r#loop::RetryBackoffConfig {
            base_ms: None,
            max_ms: None,
            total_budget_ms: Some(180_000),
        }));
        o.retry.transient_retry_limit = run_policy
            .as_ref()
            .and_then(|policy| policy.transient_retry_limit)
            .unwrap_or(10);
        o.retry.provider_fail_streak = provider_fail_streak;
        o.tool_exec.tool_middleware = vec![Arc::new(BackupMiddleware::with_defaults(None))];
        o.assembly.parent_run_id = parent_run_id.clone();
        o.assembly.write_claims = subagent_write_registry
            .clone()
            .or_else(|| Some(Arc::clone(&shared_registry)));
        o.assembly.explore_docs_quota = subagent_quota.clone();
        o.compaction.compaction_policy = state.compaction_policy_for(&session_id);
        o.compaction.summarizer = state.summarizer_for(&session_id);
        o.summary.summary_dispatch = state.summary_dispatch_config(&session_id);
        o.summary.summary_coordinator = Some(state.summary_coordinator_for(&session_id));
        o.assembly.note_backend = crate::engine_assembly::note_backend();
        o.hooks.live_sink =
            Some(Arc::clone(&live_sink) as Arc<dyn session_loop::provider::LiveEventSink>);
        o.hooks.background = Some(Arc::clone(&state.background)
            as Arc<dyn agent_tools::background::BackgroundTaskManager>);
        o.hooks.log_root = Some(state.background.log_root());
        o.hooks.reasoning_effort = reasoning_effort;
        o
    };
    let tool_options = ToolBatchOptions {
        // 权威枚举 + 活单元（活单元优先；父变更下一批生效）
        permission_mode: Some(effective_permission_mode),
        permission_cell: Some(Arc::clone(&permission_cell)),
        capability_cell: subagent_config
            .is_some()
            .then(|| Arc::clone(&capability_cell)),
        // U-OUT-RS / T-D1-D（N6）：生产装配显式 Some——禁止仅靠
        // `..Default::default()` 隐式继承（旧路径 None）；常量来自 D0
        // conex-shared::perf_budget::TOOL_OUTPUT_BUDGET_BYTES_DEFAULT（64KiB
        // 事件载荷预算）。测试注入 None 仍合法（工具级 200KB 覆盖保留）。
        output_budget_bytes: Some(conex_shared::perf_budget::TOOL_OUTPUT_BUDGET_BYTES_DEFAULT),
        task_type: subagent_config.as_ref().and_then(|c| c.task_type.clone()),
        ..ToolBatchOptions::default()
    };
    // 用户消息（clientMessageId 透传，03 §5.3-4；多模态 content 桥——
    // plans/04 §4.2：hasImages 时把 OpenAI 形 parts 写入 metadata.contentParts）
    // 上下文信封融合：当 context_state 存在时，与 prompt 合体，当次生效，0 额外 Turn，严禁入 pending_queue！
    let effective_prompt = match (
        prompt.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        context_state
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    ) {
        (Some(p), Some(cs)) => {
            if p.contains("[用户输入]") && p.contains("[系统环境上下文]") {
                p.to_string()
            } else {
                format!("[用户输入]\n{}\n\n[系统环境上下文]\n{}", p, cs)
            }
        }
        (Some(p), None) => p.to_string(),
        (None, Some(cs)) => format!("[系统环境上下文]\n{}", cs),
        (None, None) => String::new(),
    };
    let message = crate::engine_provider::user_message_with_content(
        &effective_prompt,
        client_message_id.as_deref(),
        content_parts,
    );

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
    let initial_conversation: Option<Vec<Arc<AgentMessage>>> =
        assembled_history
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
        max_turns,
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
        user_touched: AtomicBool::new(false),
        // 30-P1：spawn 句柄经 set_driver 事后登记（构造在前、spawn 在后）
        driver: Mutex::new(None),
        // T-D-13：子代理 run 装配配置随活动 run 登记（收口终态处理依据）
        subagent: subagent_config.clone(),
        // L4（F12）：审计落库 worker 句柄（收口处 take + await 排空）
        audit_persist: Mutex::new(Some(audit_worker)),
        permission: Arc::clone(&permission_cell),
        capability: Arc::clone(&capability_cell),
        model: Arc::clone(&model_cell),
        project_name: project_name.clone(),
        phase: std::sync::RwLock::new(crate::run::run_core::ExecutionPhase::Active),
        last_heartbeat_ms: std::sync::atomic::AtomicU64::new(
            conex_shared::time::unix_millis() as u64
        ),
    });
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(run_id.clone(), Arc::clone(&active));
    // 真实条目已入 active_runs（串行守卫自此由注册表扫描承载），装配期
    // 占用即刻释放；此后无早退路径（? 分支已全部收口于 insert 之前）
    drop(_launch_guard);
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
    let driver_state = Arc::clone(&state);
    let driver_active = Arc::clone(&active);
    let driver = crate::engine_assembly::spawn_here(async move {
        drive_run_loop(
            Arc::clone(&driver_state),
            Arc::clone(&driver_active),
            Box::new(producer),
        )
        .await;
        notify_scheduled_run_terminal_after_drive(&driver_state, &driver_active).await;
    });
    active.set_driver(driver);

    tracing::info!(
        target: "run",
        session_id = %session_id,
        run_id = %run_id,
        mode = %mode.as_deref().unwrap_or("task"),
        permission_mode = %effective_permission_mode.as_str(),
        max_turns = max_turns,
        "core_run_task 已发起"
    );
    Ok(RunTaskResponse { run_id, session_id })
}

// ── 命令：core_run_control ────────────────────────────────────────

/// run 控制（03 §3.2 A 组：L0-L3 全枚举）
///
/// run 控制命令体（core_run_control 壳层薄壳与测试共用的实现；
/// run_id/level/message/reason/payload 五参控制面）：
///
/// - `continue`（L0）：不入队（ControlBus 语义），no-op 返回 Ok；
/// - `soft_inject` / `steer` / `follow_up`（L1）：消息注入对应环，
///   不打断流（文本取 `message` 或 `payload.text`；环由 payload.kind
///   或 level 决定）；
/// - `cooperative_stop`（L2）：协作停止，等安全点收场（stopped，D1）；
/// - `force_cancel`（L3）：AbortSignal 强停 + 总线 force_cancel
///   （aborted 收场）。
pub async fn run_control_impl(
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
            let injected = crate::engine_provider::user_message(&text, None);
            // T-CF-11：用户经 L1 注入消息 → 标记用户交互（收口判定
            // 「用户消息到达后的正常收场不触发续 run」）
            active.user_touched.store(true, Ordering::SeqCst);
            let mut bus = active.control_bus.lock().unwrap_or_else(|e| e.into_inner());
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
            let mut bus = active.control_bus.lock().unwrap_or_else(|e| e.into_inner());
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
                let mut bus = active.control_bus.lock().unwrap_or_else(|e| e.into_inner());
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
                state
                    .background
                    .graceful_stop_tasks_for_run(&active.run_id)
                    .await;
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

/// F4 命令体（core_compact_now 壳层薄壳与测试共用的实现）
pub async fn compact_now_impl(
    state: &Arc<CoreRunState>,
    session_id: &str,
    target_tokens: Option<u64>,
) -> Result<CompactNowResult, CoreError> {
    // 1. 会话存在性（内存注册表 session_trees / sessions + DB sessions 表
    //    三面检查——冷启动无内存注册表时以 DB 为权威）
    let session_exists = {
        let trees = state
            .session_trees
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let in_trees = trees.contains_key(session_id);
        let in_sessions = {
            let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions
                .iter()
                .any(|record| record.session_id == session_id)
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
        .and_then(|config| crate::engine_provider::protocol::effective_context_window(&config))
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
    //    纯丢弃式 stub，E2 F1）。D10-A：引擎不再裸调 summarizer——经
    //    preview + 同步 summarize 预计算后传入 precomputed（手动压缩命令
    //    为同步上下文；async run loop 主路径经 summarize_via_blocking）。
    let engine = conex_compaction::CompactionEngine::new(budget as usize);
    let summarize_precomputed = engine
        .preview_compaction(&conversation, &policy)
        .map(|preview| summarizer.summarize(&preview.dropped, preview.existing.as_deref()));
    let plan = engine.compact_agent_messages_with_stub_policy(
        &conversation,
        budget as usize,
        &policy,
        StubPolicy::LlmRequired,
        summarize_precomputed,
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
    let now_iso = crate::engine_provider::now_iso_utc();
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
    let summary_state = if plan.summary_is_llm {
        "committed"
    } else {
        "awaiting"
    };
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
                .then(|| {
                    format!(
                        "compacted-summary-{}-{}",
                        plan.generation, plan.fold_chain_prev
                    )
                })
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
/// 与全局事件桥信封广播；run_id 缺省 None，前端按会话域消费）。返回事件
/// 序列号（块表落库锚点）；失败 → None（事件仅尽力而为，不阻断命令）
pub async fn push_emit_idle_event(
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
pub fn session_message_to_history(message: conex_types::SessionMessage) -> HistoryMessage {
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
/// 取消 run 直调体（core_cancel_run 壳层薄壳与 R1-04 REST 写面共用——
/// L2 协作 / L3 强制；reason 缺省 "cancelled-by-user"）。
pub async fn cancel_run_impl(
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

/// Tier-2 会话级中止实现（前端级联取消总线 VULN-05；workbench_abort_run
/// 壳层薄壳与 R1-04 REST 面共用）：按 sessionId 定位活动 run，
/// 触发 L3 强停（AbortSignal + 控制总线 force_cancel，与 [ActiveRunEngine::abort] 同语义）。
/// 无匹配活动 run → Ok(false)（幂等，run 已收口场景静默成功）。
pub async fn abort_session_run_impl(
    state: &CoreRunState,
    session_id: &str,
) -> Result<bool, CoreError> {
    let sid = session_id.trim();
    if sid.is_empty() {
        return Ok(false);
    }
    let target = {
        let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        active
            .values()
            .find(|run| run.session_id == sid)
            .map(Arc::clone)
    };
    let Some(run) = target else {
        return Ok(false);
    };
    run.abort_signal.abort();
    {
        let mut bus = run.control_bus.lock().unwrap_or_else(|e| e.into_inner());
        bus.request_force_cancel(Some("ui abort".to_string()), Some("ui".to_string()));
    }
    tracing::info!(target: "run", session_id = %sid, "abort_session_run_impl：已投递 L3 强停（Ui abort）");
    Ok(true)
}
