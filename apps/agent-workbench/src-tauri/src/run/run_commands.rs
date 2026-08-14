//! run/run_commands.rs（SR-02 · 拆分 · ≠ EL）
//!
//! 经 run/mod.rs 聚合接线；顶层符号 pub(crate) 化供兄弟模与门面 re-export。
use super::*;
use tauri::Manager as _;
// ── T-AB-19：run 感知后台任务管理器（owner_run_id 注入装饰器）────

/// run 感知后台任务管理器（T-AB-19 装饰器，包壳 [BackgroundTaskManager]）
///
/// 职责（方案 §7.4 T-AB-19 第 1/3 点）：
/// - **owner_run_id 注入**：工具执行链的 adopt 调用点（agent-tools
///   shell.rs:1088）构造请求时 `owner_run_id` 恒 None——本装饰器在请求
///   进入注册表前注入「当前 run 上下文」的 runId（审计与过滤用，不级联
///   杀）；请求已显式携带（非 None）时透传不改写；
/// - **L3 可选联动**：`graceful_stop_tasks_for_run`——对指定 run 的普通
///   任务（is_daemon=false）发起优雅终止（两阶段 kill）；默认不联动，
///   仅 `core_run_control` L3 force 且配置项开启时调用；
/// - **状态汇总查询面**：`summary`——core_get_status.backgroundTasks 数据源。
///
/// 上下文约定：run 开始（[core_run_task]）→ `set_current_run(run_id)`；
/// run 终态（[drive_run_loop] 收口 / [finalize_failed]）→
/// `clear_current_run(run_id)`（仅清匹配者）。**不清理注册表、不级联杀
/// 任务**——任务属会话级，registry 生命周期独立于 run（T-AB-12 只读
/// 契约升级为显式收口契约，run_end_* 测试锚定）。
///
/// 诚实边界：引擎与注册表均为进程内单例，装饰器维护「最近启动的 run」
/// 单一上下文槽；多会话并发 run 时以最近启动者为准（owner_run_id 是
/// 审计元数据粒度，不参与生命周期决策，误差不产生行为差异）。
#[derive(Debug)]
pub(crate) struct RunAwareBackgroundManager {
    /// 被包壳的注册表（None = 未接线，测试环境；adopt/list 等返回
    /// 工具未接线错误，生产路径恒 Some）
    pub(crate) inner: Option<Arc<dyn BackgroundTaskManager>>,
    /// 当前 run 上下文（owner_run_id 注入槽；std Mutex 不跨 await 持有）
    pub(crate) current_run_id: Mutex<Option<String>>,
}

impl RunAwareBackgroundManager {
    /// 新建装饰器（包壳 main.rs 注入的注册表）
    pub(crate) fn new(inner: Option<Arc<dyn BackgroundTaskManager>>) -> Self {
        Self {
            inner,
            current_run_id: Mutex::new(None),
        }
    }

    /// run 启动：登记当前 run 上下文（[core_run_task] spawn 前调用）
    pub(crate) fn set_current_run(&self, run_id: &str) {
        *self
            .current_run_id
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(run_id.to_string());
    }

    /// run 终态：释放当前 run 上下文（仅清匹配者——多会话并发 run 时
    /// 较晚启动者占槽，较早结束者不清，避免误伤仍在运行的 run）
    pub(crate) fn clear_current_run(&self, run_id: &str) {
        let mut slot = self
            .current_run_id
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if slot.as_deref() == Some(run_id) {
            *slot = None;
        }
    }

    /// 后台任务汇总（core_get_status.backgroundTasks 数据源）
    ///
    /// 口径说明（与前端状态栏 / 诊断面板展示对齐）：
    /// - `active_count`：活跃（Running）任务数——不含终态与已归档条目；
    /// - `daemon_count`：活跃守护进程数（is_daemon=true 且 Running）——
    ///   与 activeCount 同口径（「守护进程仍在运行」语义）；
    /// - `last_finished`：最近终态（全量口径取 finished_at_ms 最大；
    ///   尚无终态任务时 None）。
    ///
    /// 未接线（注册表缺失）或查询失败 → 全零缺省（展示型数据，前端
    /// 显示「无任务」而非报错）。
    pub(crate) async fn summary(&self) -> BackgroundTasksSummary {
        let Some(manager) = &self.inner else {
            return BackgroundTasksSummary::default();
        };
        match manager.list(true).await {
            Ok(tasks) => {
                let mut last_finished: Option<(u64, String, String)> = None;
                for info in &tasks {
                    if info.status == TaskState::Running {
                        continue;
                    }
                    if let Some(finished_at) = info.finished_at_ms {
                        if last_finished
                            .as_ref()
                            .is_none_or(|(max_at, _, _)| finished_at > *max_at)
                        {
                            last_finished = Some((
                                finished_at,
                                info.task_id.clone(),
                                task_state_wire_name(info.status).to_string(),
                            ));
                        }
                    }
                }
                BackgroundTasksSummary {
                    active_count: tasks
                        .iter()
                        .filter(|info| info.status == TaskState::Running)
                        .count(),
                    daemon_count: tasks
                        .iter()
                        .filter(|info| info.is_daemon && info.status == TaskState::Running)
                        .count(),
                    last_finished: last_finished.map(|(finished_at, task_id, status)| {
                        crate::core_query_commands::LastTaskTerminal {
                            task_id,
                            status,
                            finished_at_ms: finished_at as i64,
                        }
                    }),
                }
            }
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    error = %error,
                    "后台任务汇总查询失败（返回全零缺省）"
                );
                BackgroundTasksSummary::default()
            }
        }
    }

    /// T-AB-19 可选接线：对指定 run 的普通任务（is_daemon=false）发起
    /// 优雅终止（注册表两阶段 kill：优雅 → 5s → 强制）。
    ///
    /// 默认不联动：仅 `core_run_control` L3 force 且配置项
    /// `CONEX_RUN_CONTROL_L3_TASK_CANCEL` 开启时调用（职责单一，避免
    /// 误杀，对齐方案 REQ 4.3）。守护任务（is_daemon=true）与其它 run
    /// 的任务一律不碰。best-effort：单任务失败仅告警，不中断整批。
    pub(crate) async fn graceful_stop_tasks_for_run(&self, run_id: &str) {
        let Some(manager) = &self.inner else {
            return;
        };
        let tasks = match manager.list(false).await {
            Ok(tasks) => tasks,
            Err(error) => {
                tracing::warn!(
                    target: "run",
                    run_id,
                    error = %error,
                    "L3 联动：任务查询失败（跳过联动，run 强停不受影响）"
                );
                return;
            }
        };
        for info in tasks
            .iter()
            .filter(|info| info.owner_run_id.as_deref() == Some(run_id) && !info.is_daemon)
        {
            match manager.kill(&info.task_id).await {
                Ok(result) => {
                    tracing::info!(
                        target: "run",
                        run_id,
                        task_id = %info.task_id,
                        kill = ?result,
                        "L3 联动：当前 run 的普通任务已发起优雅终止"
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        target: "run",
                        run_id,
                        task_id = %info.task_id,
                        error = %error,
                        "L3 联动：任务终止失败（best-effort 继续）"
                    );
                }
            }
        }
    }
}

/// T-AB-19 配置项（默认关闭）：L3 force 取消时是否对「当前 run 的普通
/// 任务（is_daemon=false）」发起优雅终止（两阶段 kill）。
///
/// 配置面现状：通用设置存储（config store）尚无布尔项，暂以环境变量
/// `CONEX_RUN_CONTROL_L3_TASK_CANCEL=1` 开启（进程级配置项，登记于
/// T-AB-19 交付说明；接入设置面板后改读设置项，默认值保持 false）。
pub(crate) fn l3_force_cancel_tasks_enabled() -> bool {
    matches!(
        std::env::var("CONEX_RUN_CONTROL_L3_TASK_CANCEL").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

/// 任务状态 wire 名（TaskState kebab-case 序列化名；汇总面用）
pub(crate) fn task_state_wire_name(state: TaskState) -> &'static str {
    match state {
        TaskState::Running => "running",
        TaskState::Completed => "completed",
        TaskState::Failed => "failed",
        TaskState::Killed => "killed",
    }
}

#[async_trait::async_trait]
impl BackgroundTaskManager for RunAwareBackgroundManager {
    /// adopt：注入 owner_run_id（工具链恒 None → 当前 run 上下文；
    /// 显式携带时透传不改写），其余原样转发注册表。
    async fn adopt(&self, mut req: BackgroundAdoptRequest) -> Result<BackgroundTaskRef, ToolError> {
        if req.owner_run_id.is_none() {
            req.owner_run_id = self
                .current_run_id
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
        }
        match &self.inner {
            Some(manager) => manager.adopt(req).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn list(&self, include_finished: bool) -> Result<Vec<BackgroundTaskInfo>, ToolError> {
        match &self.inner {
            Some(manager) => manager.list(include_finished).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn status(&self, task_id: &str) -> Result<agent_tools::background::BackgroundTaskStatus, ToolError> {
        match &self.inner {
            Some(manager) => manager.status(task_id).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn read_log(
        &self,
        task_id: &str,
        start_line: Option<u64>,
        max_lines: u64,
    ) -> Result<agent_tools::background::LogSlice, ToolError> {
        match &self.inner {
            Some(manager) => manager.read_log(task_id, start_line, max_lines).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn send_input(
        &self,
        task_id: &str,
        text: &str,
        append_newline: bool,
    ) -> Result<(), ToolError> {
        match &self.inner {
            Some(manager) => manager.send_input(task_id, text, append_newline).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }

    async fn kill(&self, task_id: &str) -> Result<agent_tools::background::KillResult, ToolError> {
        match &self.inner {
            Some(manager) => manager.kill(task_id).await,
            None => Err(ToolError::new(
                codes::TOOL_NOT_FOUND,
                "后台任务注册表未接线（RunAwareBackgroundManager）",
            )),
        }
    }
}

// ── R1-04 REST 写面：只读查询直调体（服务网关 CoreStateBackend 接入；
//    不依赖 Tauri runtime——与既有 *_impl 契约体同范式）──────────────

/// 会话事件分页直调体（与 core_read_session_events 同一语义：store 游标
/// 分页 + 信封解析；after_sequence 开区间，max_events 缺省 200 夹紧 1000）
///
/// DM-07：limit 下推（page_size + 1 判 has_more，SQL 层 LIMIT，修复
/// O(n) 全量读出 + 全量 serde）——has_more 以 SQL 返回**原始行数**判断
/// （corrupt 行被 parse_envelopes 跳过不缩小「其后仍有行」的判断，游标
/// 推进只依赖页内有效事件的全局 sequence）。
pub(crate) async fn read_session_events_impl(
    state: &CoreRunState,
    session_id: &str,
    after_sequence: Option<u64>,
    max_events: Option<u64>,
) -> Result<crate::core_query_commands::EventPage, CoreError> {
    if session_id.trim().is_empty() {
        return Err(CoreError::invalid_input("session_id 不能为空"));
    }
    let page_size = normalize_remote_page_size(max_events);
    let after = after_sequence.unwrap_or(0);
    let store = state.store();
    let events = store
        .query_events(session_id, after, Some(page_size as u64 + 1))
        .await
        .map_err(crate::core_error::map_store_err)?;
    let (page_items, stats) = crate::core_query_commands::parse_envelopes(&events);
    crate::core_query_commands::warn_parse_stats("read_session_events", session_id, &stats);
    let page = paginate_remote(page_items, page_size).0;
    let has_more = events.len() > page_size;
    let next_after_sequence = page.last().map(|(seq, _)| *seq).unwrap_or(after);
    Ok(crate::core_query_commands::EventPage {
        events: page.into_iter().map(|(_, value)| value).collect(),
        next_after_sequence,
        has_more,
    })
}

/// run 事件分页直调体（与 core_read_run_events 同一语义：SQL 按 run_id
/// 列过滤的会话事件子集；sessionId 缺省从 run 记录反查）。
///
/// DM-07：改调 Store::query_events_by_run——SQL 层过滤替代「全量读 +
/// 内存 runId 过滤」（G-03/G-01 关闭，走 idx_events_run 索引）；返回该
/// run 全链**含终态后 tail**（同 runId 收尾事件列级归属，R-06）；goal-*
/// 轮次域因落库 run_id=NULL 自然不命中（SQL WHERE run_id=?）；游标取
/// 页末**全局** sequence（SQL 层过滤后页内末事件即本 run 事件流位置，
/// 修复「过滤后取页末游标跳过其它 run 事件」旧语义）；limit = page_size
/// + 1 判 has_more（n+1 语义，has_more 以原始行数判断，与
/// read_session_events_impl 同口径）。
pub(crate) async fn read_run_events_impl(
    state: &CoreRunState,
    run_id: &str,
    session_id: Option<&str>,
    after_sequence: Option<u64>,
    max_events: Option<u64>,
) -> Result<crate::core_query_commands::EventPage, CoreError> {
    if run_id.trim().is_empty() {
        return Err(CoreError::invalid_input("run_id 不能为空"));
    }
    let page_size = normalize_remote_page_size(max_events);
    let after = after_sequence.unwrap_or(0);
    let store = state.store();
    // 未提供 sessionId：从 run 记录反查（与 core_read_run_events 同语义）
    let session_id = match session_id {
        Some(id) if !id.trim().is_empty() => id.trim().to_string(),
        _ => {
            let runs = store
                .query_runs()
                .await
                .map_err(crate::core_error::map_store_err)?;
            runs.into_iter()
                .find(|run| run.run_id == run_id)
                .map(|run| run.session_id)
                .ok_or_else(|| CoreError::NotFound(format!("run not found: {run_id}")))?
        }
    };
    let events = store
        .query_events_by_run(&session_id, run_id, after, Some(page_size as u64 + 1))
        .await
        .map_err(crate::core_error::map_store_err)?;
    let (page_items, stats) = crate::core_query_commands::parse_envelopes(&events);
    crate::core_query_commands::warn_parse_stats("read_run_events", &session_id, &stats);
    let page = paginate_remote(page_items, page_size).0;
    let has_more = events.len() > page_size;
    let next_after_sequence = page.last().map(|(seq, _)| *seq).unwrap_or(after);
    Ok(crate::core_query_commands::EventPage {
        events: page.into_iter().map(|(_, value)| value).collect(),
        next_after_sequence,
        has_more,
    })
}

/// run 快照直调体（与 core_get_run_snapshot 同一语义：store run 记录 +
/// usage 缓存；sessionId 提供时校验与 run 记录一致）
pub(crate) async fn get_run_snapshot_impl(
    state: &CoreRunState,
    run_id: &str,
    session_id: Option<&str>,
) -> Result<crate::core_query_commands::RunSnapshotResponse, CoreError> {
    if run_id.trim().is_empty() {
        return Err(CoreError::invalid_input("run_id 不能为空"));
    }
    let store = state.store();
    let runs = store
        .query_runs()
        .await
        .map_err(crate::core_error::map_store_err)?;
    let run = runs
        .into_iter()
        .find(|run| run.run_id == run_id)
        .ok_or_else(|| CoreError::NotFound(format!("run not found: {run_id}")))?;
    if let Some(session_id) = session_id {
        if !session_id.is_empty() && session_id != run.session_id {
            return Err(CoreError::InvalidInput(format!(
                "session_id mismatch: run {run_id} belongs to session {}, got {session_id}",
                run.session_id
            )));
        }
    }
    Ok(crate::core_query_commands::RunSnapshotResponse {
        snapshot: crate::core_query_commands::RunSnapshot {
            run_id: run.run_id.clone(),
            session_id: run.session_id.clone(),
            status: run.status.as_str().to_string(),
            cursor: run.cursor.max(0) as u64,
            created_at: run.created_at,
            updated_at: run.updated_at,
            end_reason: run.end_reason.clone(),
            error: state.run_error(run_id),
            usage: state.run_usage(run_id),
        },
    })
}

/// 会话列表直调体（LocalDb 索引直读；includeLastMessage 预览属 F5 增量
/// 面，R1-04 直调面不实现——缺省语义不变）
pub(crate) fn list_sessions_impl(
    state: &CoreRunState,
) -> Result<Vec<conex_types::SessionIndexEntry>, CoreError> {
    let Some(db) = state.local_db() else {
        return Ok(Vec::new());
    };
    db.list_sessions().map_err(map_db_failure)
}

/// 子代理 DAG 概览直调体（M6 C08 行投影：完整消息树不下发（D6 §3.3
/// N8），仅 flowDeclaration / flowState 原样 + agents 行投影
/// （agentId/status/description/summary/depth）；depth = 1——agents 表
/// 仅子代理行，主 agent 不在其中）
pub(crate) fn get_flow_snapshot_impl(
    state: &CoreRunState,
    session_id: &str,
) -> Result<serde_json::Value, CoreError> {
    if session_id.trim().is_empty() {
        return Err(CoreError::invalid_input("session_id 不能为空"));
    }
    let Some(db) = state.local_db() else {
        return Err(CoreError::NotFound(format!("会话不存在：{session_id}")));
    };
    let declaration = db
        .get_session_meta(orchestrator::flow_graph::FLOW_DECLARATION_KEY)
        .map_err(map_db_failure)?;
    let flow_state = db
        .get_session_meta(orchestrator::flow_graph::FLOW_STATE_KEY)
        .map_err(map_db_failure)?;
    let agents = db.load_session_agents(session_id).map_err(map_db_failure)?;
    let agents: Vec<serde_json::Value> = agents
        .into_iter()
        .map(|agent| {
            serde_json::json!({
                "agentId": agent.id,
                "status": agent.status,
                "description": agent.description,
                "summary": agent.summary,
                "depth": 1_u8,
            })
        })
        .collect();
    let parse_meta = |raw: Option<String>| {
        raw.and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    };
    Ok(serde_json::json!({
        "flowDeclaration": parse_meta(declaration),
        "flowState": parse_meta(flow_state),
        "agents": agents,
    }))
}

/// 页大小归一（缺省 200、夹紧 [1, 1000]，与
/// core_query_commands::normalize_max_events 同口径）
pub(crate) fn normalize_remote_page_size(max_events: Option<u64>) -> usize {
    max_events
        .unwrap_or(crate::core_query_commands::DEFAULT_PAGE_SIZE)
        .clamp(1, crate::core_query_commands::MAX_PAGE_SIZE) as usize
}

/// 纯分页（与 core_query_commands::paginate 同语义：全量切前 max 条）
pub(crate) fn paginate_remote<T>(all: Vec<T>, max: usize) -> (Vec<T>, bool) {
    if all.len() <= max {
        return (all, false);
    }
    let page = all.into_iter().take(max).collect::<Vec<_>>();
    (page, true)
}

// ── R1-04 REST 写面：设置域直调体（M6 C28/C29 的 REST T1 形态）──────

/// 设置脱敏快照直调体（M6 C28：config_get 直透——apiKey 恒空串 + last4
/// 脱敏由 config 层保证；keys 子集过滤在服务层完成）
pub(crate) fn settings_get_impl() -> Result<serde_json::Value, CoreError> {
    crate::config::config_get()
}

/// 非敏感配置更新直调体（Z0 §9.3 R1-04「配置非敏感更新」：与
/// config_update 同语义——baseUrl / model 两键可写（config store setter
/// pub(crate) 直调面），写成功后重载引擎 provider（下一次 run 用新值）。
/// credentialMode / endpoint / stream 属 config 模块私有写面，R1-04
/// **显式拒绝**（fail-closed：不静默忽略，避免「请求成功但未生效」）。
pub(crate) fn settings_update_impl(
    state: &CoreRunState,
    base_url: Option<String>,
    model: Option<String>,
    credential_mode: Option<String>,
    endpoint: Option<String>,
    stream: Option<bool>,
) -> Result<serde_json::Value, CoreError> {
    if credential_mode.is_some() || endpoint.is_some() || stream.is_some() {
        return Err(CoreError::invalid_input(
            "credentialMode / endpoint / stream 不在 REST 非敏感配置更新面（仅 baseUrl / model）",
        ));
    }
    crate::config::with_store_mut(|store| {
        if let Some(url) = base_url {
            store.set_base_url(url)?;
        }
        if let Some(m) = model {
            store.set_model(m)?;
        }
        Ok(())
    })?;
    // 与 config_update 同语义：store 写成功后重载引擎 provider
    state.reload_provider();
    crate::config::config_get()
}

// ── R1-04 REST 写面：run 发起装配辅助（桌面侧生成 id，M6 C24）──────

/// 生成 run id（桌面生成：对齐前端 `run-<base36 时间戳>-<base36 随机>`
/// 命名风格；随机段经 CSPRNG getrandom）
pub(crate) fn generate_run_id() -> String {
    let mut random = [0u8; 4];
    let _ = getrandom::getrandom(&mut random);
    format!(
        "run-{}-{}",
        base36(now_ms_internal()),
        base36(u32::from_le_bytes(random) as u64)
    )
}

/// 生成会话 id（sessionId 缺省时桌面新建会话，对齐前端 `sess-<时间戳>`
/// 命名风格）
pub(crate) fn generate_session_id() -> String {
    format!("sess-{}", base36(now_ms_internal()))
}

/// 当前 epoch ms（模块内 id 生成用；与 crate::server::now_ms 同源）
pub(crate) fn now_ms_internal() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// base36 编码（0-9a-z；对齐前端 `Date.now().toString(36)` 风格）
pub(crate) fn base36(value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut buffer = [0u8; 16];
    let mut i = 16;
    let mut v = value;
    while v > 0 {
        i -= 1;
        buffer[i] = DIGITS[(v % 36) as usize];
        v /= 36;
    }
    String::from_utf8(buffer[i..].to_vec()).expect("base36 恒为 ASCII")
}

/// 后台任务列表直调面（R1-04；未接线 → 空列表，与 summary 全零缺省
/// 同口径；TOOL_NOT_FOUND → NotFound，其余 → internal）
pub(crate) async fn list_background_tasks_impl(
    state: &CoreRunState,
) -> Result<Vec<serde_json::Value>, CoreError> {
    let tasks = state.background_manager().list_tasks().await?;
    Ok(tasks
        .into_iter()
        .map(|info| {
            serde_json::json!({
                "taskId": info.task_id,
                "command": info.command,
                "cwd": info.cwd,
                "status": serde_json::to_value(info.status).unwrap_or_default(),
                "isDaemon": info.is_daemon,
                "startedAt": info.started_at_ms,
                "exitCode": info.exit_code,
                "lineCount": info.line_count,
            })
        })
        .collect())
}

/// 任务输出补取直调面（R1-04 / M6 C07：after_line 偏移分页——read_log
/// 行范围语义；next_after_line / has_more 由 LogSlice 首末行推导）
pub(crate) async fn get_task_output_impl(
    state: &CoreRunState,
    task_id: &str,
    max_lines: Option<u32>,
    after_line: Option<u64>,
) -> Result<conex_types::device::commands::TaskOutputResult, CoreError> {
    let max_lines = max_lines.unwrap_or(200).clamp(1, 1000);
    let slice = state
        .background_manager()
        .read_task_log(task_id, after_line, max_lines as u64)
        .await?;
    let start = slice.start_line;
    let end = slice.end_line;
    let has_more = slice.truncated || end < slice.total_lines;
    Ok(conex_types::device::commands::TaskOutputResult {
        lines: slice.lines,
        truncated: slice.truncated,
        line_count: slice.total_lines,
        next_after_line: Some(if end >= start { end + 1 } else { start }),
        has_more: Some(has_more),
    })
}

// ── R1-04 REST 写面：CoreRunState 访问器 ────────────────────────────

impl CoreRunState {
    /// 状态诊断访问器（get_status 直调面——与 main.rs managed 的
    /// StatusDiagnostics 为同一实例，避免写入侧与读取侧漂移）
    pub(crate) fn status_diagnostics(&self) -> Arc<StatusDiagnostics> {
        Arc::clone(&self.diagnostics)
    }

    /// 后台任务管理器访问器（list_background_tasks / get_task_output
    /// 直调面）
    pub(crate) fn background_manager(&self) -> Arc<RunAwareBackgroundManager> {
        Arc::clone(&self.background)
    }
}

impl RunAwareBackgroundManager {
    /// 任务列表直调面（R1-04；未接线 → 空列表，与 summary 全零缺省同
    /// 口径；TOOL_NOT_FOUND → NotFound，其余 → internal）
    pub(crate) async fn list_tasks(&self) -> Result<Vec<BackgroundTaskInfo>, CoreError> {
        let Some(manager) = &self.inner else {
            return Ok(Vec::new());
        };
        manager.list(true).await.map_err(map_tool_error)
    }

    /// 任务日志直调面（R1-04：read_log 行范围语义；start_line=None 读
    /// 尾部 max_lines 行；未知任务 → NotFound）
    pub(crate) async fn read_task_log(
        &self,
        task_id: &str,
        start_line: Option<u64>,
        max_lines: u64,
    ) -> Result<LogSlice, CoreError> {
        let Some(manager) = &self.inner else {
            return Err(CoreError::NotFound(format!("任务不存在：{task_id}")));
        };
        manager
            .read_log(task_id, start_line, max_lines)
            .await
            .map_err(map_tool_error)
    }
}

/// 工具错误 → CoreError（TOOL_NOT_FOUND → NotFound，其余 → internal；
/// 与 background.rs tool_err_to_core 同语义）
pub(crate) fn map_tool_error(error: agent_tools::definition::ToolError) -> CoreError {
    if error.code() == codes::TOOL_NOT_FOUND {
        CoreError::NotFound(error.to_string())
    } else {
        CoreError::Internal(error.to_string())
    }
}

// ── trash 命令（I2-S5：误删恢复入口，引擎命令面）────────────────────

/// 回收站根注入配置（main.rs `app.manage`；对齐 `BuiltinToolConfig.trash_root`
/// 语义：`None` = 未注入 → 执行期回退活动工作区 `.crish-trash`，与
/// delete_file / delete_dir 工具的兜底一致——保证恢复面板与删除工具
/// 落入同一回收站根，恢复才找得到条目）。
#[derive(Debug, Clone, Default)]
pub struct TrashRootConfig {
    /// 回收站根（数据目录或显式配置根；None = 走工作区兜底）
    pub root: Option<PathBuf>,
}

/// 兜底回收站目录名（对齐 agent-tools delete.rs 的 DEFAULT_TRASH_DIR_NAME）
pub(crate) const DEFAULT_TRASH_DIR_NAME: &str = ".crish-trash";

/// 解析回收站根：
/// 1. 托管状态注入优先（main.rs 配置注入点，数据目录或显式根）；
/// 2. 未注入 → 活动工作区 `.crish-trash`（S3 执行期兜底语义）；
///
/// 工作区注册表不可用 → 结构化错误（不静默退化）。
/// pub(crate)：供 fs_commands/delete.rs（UI 删除命令）复用，保证
/// UI 删除与 AI 删除落入同一回收站根（S11 G2 删除接管收敛）。
pub(crate) fn trash_root_for(app: &tauri::AppHandle) -> Result<PathBuf, CoreError> {
    if let Some(config) = app.try_state::<TrashRootConfig>() {
        if let Some(root) = &config.root {
            return Ok(root.clone());
        }
    }
    let guard = crate::workspace::resolve_guard(app, "").map_err(|e| {
        CoreError::Internal(format!(
            "无法解析回收站根（工作区注册表不可用）：{}: {}",
            e.code, e.message
        ))
    })?;
    Ok(guard.root().join(DEFAULT_TRASH_DIR_NAME))
}

/// 回收站错误 → CoreError 映射（按文案归类，对齐 03 §5.3 协议）
pub(crate) fn map_trash_err(err: &anyhow::Error) -> CoreError {
    let msg = err.to_string();
    if msg.contains("不存在") || msg.contains("缺失") {
        CoreError::NotFound(msg)
    } else if msg.contains("非法条目") || msg.contains("拒绝覆盖") || msg.contains("校验失败") {
        CoreError::InvalidInput(msg)
    } else {
        CoreError::Io(msg)
    }
}

/// trash_list 返回（条目清单 + 回收站根；无条目时 entries 为空数组）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashListResponse {
    pub entries: Vec<conex_fs::trash::TrashEntry>,
    pub trash_root: String,
}

/// 列出回收站条目（误删恢复入口；数据源 = 回收站登记扫描，
/// 条目含路径 / 删除时间 / 类型 / 大小 / 校验和）
#[tauri::command]
pub(crate) fn trash_list(app: tauri::AppHandle) -> Result<TrashListResponse, CoreError> {
    let root = trash_root_for(&app)?;
    trash_list_at(&root)
}

/// 纯函数核心（测试直测）：按回收站根列出条目
pub(crate) fn trash_list_at(root: &std::path::Path) -> Result<TrashListResponse, CoreError> {
    let service = conex_fs::trash::TrashService::new(root);
    Ok(TrashListResponse {
        entries: service.list(),
        trash_root: root.to_string_lossy().into_owned(),
    })
}

/// trash_restore 返回（恢复成功的目标路径）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashRestoreResponse {
    pub ok: bool,
    pub original_path: String,
}

/// 按条目 id 恢复到原路径（校验 checksum 防篡改；原路径已存在拒绝覆盖；
/// 恢复失败返回结构化错误，条目保留在回收站）
#[tauri::command]
pub(crate) fn trash_restore(
    app: tauri::AppHandle,
    entry_id: String,
    session_id: Option<String>,
    state: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<TrashRestoreResponse, CoreError> {
    let root = trash_root_for(&app)?;
    // I2-S8：恢复前取条目大小（恢复成功后条目已从清单移除，必须先行）
    let size = conex_fs::trash::TrashService::new(&root)
        .list()
        .into_iter()
        .find(|e| e.id == entry_id.trim())
        .map(|e| e.size)
        .unwrap_or(0);
    let response = trash_restore_at(&root, &entry_id)?;
    // I2-S8：恢复动作审计（decision=restored；经事件桥发前端事件流，
    // sessionId 由调用方（S5 恢复面板接线）携带，缺失时仅落审计日志）
    emit_trash_audit(
        &state.bridge,
        session_id.as_deref(),
        SecurityAuditOperation::TrashRestore,
        SecurityAuditDecision::Restored,
        &response.original_path,
        size,
    );
    Ok(response)
}

/// 纯函数核心（测试直测）：按条目 id 恢复到原路径
pub(crate) fn trash_restore_at(
    root: &std::path::Path,
    entry_id: &str,
) -> Result<TrashRestoreResponse, CoreError> {
    let service = conex_fs::trash::TrashService::new(root);
    let restored = service
        .restore(entry_id.trim())
        .map_err(|e| map_trash_err(&e))?;
    Ok(TrashRestoreResponse {
        ok: true,
        original_path: restored.to_string_lossy().into_owned(),
    })
}

/// trash_purge 返回（已彻底清除的条目 id）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashPurgeResponse {
    pub ok: bool,
    pub entry_id: String,
}

/// 彻底清除条目（显式用户调用，不可恢复）
#[tauri::command]
pub(crate) fn trash_purge(
    app: tauri::AppHandle,
    entry_id: String,
    session_id: Option<String>,
    state: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<TrashPurgeResponse, CoreError> {
    let root = trash_root_for(&app)?;
    // I2-S8：清除前取条目原路径与大小（清除成功后条目已从清单移除）
    let entry = conex_fs::trash::TrashService::new(&root)
        .list()
        .into_iter()
        .find(|e| e.id == entry_id.trim());
    let (original_path, size) = entry
        .as_ref()
        .map(|e| (e.original_path.to_string_lossy().into_owned(), e.size))
        .unwrap_or_else(|| (entry_id.to_string(), 0));
    let response = trash_purge_at(&root, &entry_id)?;
    // I2-S8：清除动作审计（decision=purged；经事件桥发前端事件流）
    emit_trash_audit(
        &state.bridge,
        session_id.as_deref(),
        SecurityAuditOperation::TrashPurge,
        SecurityAuditDecision::Purged,
        &original_path,
        size,
    );
    Ok(response)
}

/// 纯函数核心（测试直测）：彻底清除条目（显式用户调用，不可恢复）
pub(crate) fn trash_purge_at(
    root: &std::path::Path,
    entry_id: &str,
) -> Result<TrashPurgeResponse, CoreError> {
    let service = conex_fs::trash::TrashService::new(root);
    service
        .purge(entry_id.trim())
        .map_err(|e| map_trash_err(&e))?;
    Ok(TrashPurgeResponse {
        ok: true,
        entry_id: entry_id.to_string(),
    })
}

/// 回收站恢复/清除动作的审计发射（I2-S8）
///
/// 发射形态：`security-audit` 信封（runId/sequence 为 None——用户级引擎
/// 命令不属 run 上下文，前端对缺失 runId 的信封放行不过滤）；`session_id`
/// 由调用方携带（S5 恢复面板接线后传入），缺失时跳过 wire-out 仅落
/// 结构化审计日志。事件落库（EventQueue append_event）属 run 上下文
/// 数据面，本命令面无会话序列上下文，登记为 I3 遗留（见方案 §2 S8）。
pub(crate) fn emit_trash_audit(
    bridge: &EventBridge,
    session_id: Option<&str>,
    operation: SecurityAuditOperation,
    decision: SecurityAuditDecision,
    original_path: &str,
    size_bytes: u64,
) -> EmitReport {
    let Some(session_id) = session_id else {
        tracing::info!(
            target: "security.audit",
            kind = "trash-command",
            operation = ?operation,
            decision = ?decision,
            path = original_path,
            "回收站命令审计（未携带会话上下文，跳过事件发射）"
        );
        return EmitReport::default();
    };
    let event = AgentEvent::SecurityAudit {
        session_id: session_id.to_string(),
        timestamp: now_iso_utc(),
        operation,
        targets: vec![original_path.to_string()],
        impact: ImpactAssessment {
            file_count: 1,
            total_size_bytes: size_bytes,
            directory_count: 0,
            cross_directory: false,
            flagged: false,
        },
        decision,
        permission_mode: None,
        tool_call_id: None,
    };
    let envelope = AgentEventEnvelope::new(event, None, None);
    tracing::info!(
        target: "security.audit",
        kind = "trash-command",
        session_id,
        operation = ?operation,
        decision = ?decision,
        path = original_path,
        "回收站命令审计：已发前端事件流"
    );
    bridge.emit_envelope(&envelope)
}

/// 当前 UTC 时间 ISO8601 字符串（毫秒精度；复用既有 civil_from_days
/// 换算，与 orchestrator / session-loop 同源）
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

