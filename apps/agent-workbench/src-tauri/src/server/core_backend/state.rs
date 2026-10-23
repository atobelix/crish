use std::sync::Arc;

use conex_search::fuzzy::FuzzyMatcher;
use conex_search::search::{search_files, search_files_parallel};
use conex_types::device::{
    ApproveParams, DenyParams, DeviceErrorCode, FileSearchHit, PermissionMode, RunTaskParams,
    RunTaskResult, SearchFilesParams, SearchFilesResult,
};

use crate::core_commands::SharedSearchState;
use crate::core_run_commands::{
    find_run_by_pending_tool_call, generate_run_id, generate_session_id, list_active_runs_impl,
    list_pending_approval_summaries_impl, run_task_impl, CoreRunState, RunTaskOptions,
};
use crate::server::ServerError;

use super::{apply_remote_mode, emit_remote_mode_downgrade_audit};

/// C21 远程面 query 上限（注册表契约 1-256；桌面命令面 core_search_files
/// 为 1024——两承载面各自口径，R2-07 总则「注册表为准」）
const SEARCH_QUERY_MAX_LEN_REMOTE: usize = 256;

/// C21 搜索并行阈值（对齐 core_commands::SEARCH_PARALLEL_THRESHOLD=1000——
/// 大索引走并行匹配，小索引走顺序匹配，同引擎口径）
const SEARCH_PARALLEL_THRESHOLD: usize = 1000;

/// 命令后端（R1-04 注入 ServerState；持有引擎核心状态与只读面就绪标记）
pub struct CoreStateBackend {
    /// 引擎核心运行状态（store / 引擎 / 活动 run 注册表）
    core: Arc<CoreRunState>,
    /// 搜索索引就绪（装配面注入 SharedSearchState 事实；缺省 false =
    /// 未接线诚实降级，与骨架期能力位口径一致）
    pub(super) search_index_ready: bool,
    /// 压缩能力接线标记（同上）
    pub(super) compaction_ready: bool,
    /// C21 搜索索引（与命令面 SharedSearchState 同一实例；None = 未接线，
    /// search_files 返回 cmd.engine_not_ready 诚实降级）
    pub(super) search_state: Option<Arc<SharedSearchState>>,
    /// C21 搜索索引根（索引构建时的 canonical 工作区根；relPath 剥离
    /// 依据——与 search_state 配套注入）
    search_root: Option<String>,
}

impl CoreStateBackend {
    /// 新建后端（只读面就绪标记缺省 false；装配方可经 builder 注入）
    // R1-04 备注：main.rs 装配面注入消费（R1-04 主任务）——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn new(core: Arc<CoreRunState>) -> Self {
        Self {
            core,
            search_index_ready: false,
            compaction_ready: false,
            search_state: None,
            search_root: None,
        }
    }

    /// 注入搜索索引就绪事实（SharedSearchState 文件数 > 0 推断）
    // R1-04 备注：装配面消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_search_index_ready(mut self, ready: bool) -> Self {
        self.search_index_ready = ready;
        self
    }

    /// 注入压缩能力接线标记（SharedCompactionState）
    // R1-04 备注：装配面消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_compaction_ready(mut self, ready: bool) -> Self {
        self.compaction_ready = ready;
        self
    }

    /// 注入 C21 搜索索引（R2-12c：main.rs 装配面将命令面同实例
    /// SharedSearchState 注入——与 search_index_ready 同源事实；
    /// 未注入时 search_files 返回 cmd.engine_not_ready 诚实降级）
    // R2-12c 备注：main.rs 装配面消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_search_state(mut self, state: Arc<SharedSearchState>) -> Self {
        self.search_state = Some(state);
        self
    }

    /// 注入 C21 搜索索引根（R2-12c：索引构建时的 canonical 工作区根；
    /// relPath 剥离依据——与 with_search_state 配套注入）
    pub fn with_search_root(mut self, root: impl Into<String>) -> Self {
        self.search_root = Some(root.into());
        self
    }

    /// 全局事件桥（R1-11：remote-* 审计事件发射通道；main.rs 装配面经此
    /// 挂接 ServerState.audit_bridge——router 白名单拒绝分支（remote-source-
    /// attempt）与 run 装配面（remote-mode-downgrade）共用同一桥实例）
    #[cfg(test)]
    pub(crate) fn event_bridge(&self) -> EventBridge {
        self.core.event_bridge()
    }

    pub(super) fn core(&self) -> &Arc<CoreRunState> {
        &self.core
    }

    /// CoreError → ServerError（单一真源映射，M6 §6.2.3）
    pub(super) fn map_core(error: conex_types::CoreError) -> ServerError {
        ServerError::from_core_error(&error)
    }

    /// 索引绝对路径 → 注册表 relPath：剥离搜索根前缀（若已注入），
    /// 统一 `/` 分隔符（跨端契约；未注入根时回传索引原路径——装配面
    /// 应与 with_search_state 配套注入 with_search_root）
    pub(super) fn rel_path_for(&self, path: &str) -> String {
        let normalized = path.replace('\\', "/");
        if let Some(root) = &self.search_root {
            let root_replaced = root.replace('\\', "/");
            let root_norm = root_replaced.trim_end_matches('/');
            if let Some(stripped) = normalized.strip_prefix(root_norm) {
                // 目录边界锚定：剥离后须为空或以 `/` 开头——防
                // "C:/proj" 误剥 "C:/projects/x.rs"（字符串前缀 ≠ 目录前缀）
                if stripped.is_empty() || stripped.starts_with('/') {
                    return stripped.trim_start_matches('/').to_string();
                }
            }
        }
        normalized
    }

    /// C01 状态查询：build_status 纯函数组装（M6 C01 裁剪口径——
    /// logDir 不下发；diagnostics / lastError 与 GUI 共享同一
    /// StatusDiagnostics 实例）
    pub(super) async fn execute_get_status(&self) -> Result<serde_json::Value, ServerError> {
        use crate::core_query_commands::{build_status, DiagnosticEntry, LastErrorEntry};
        let diagnostics = self.core.status_diagnostics();
        // providerStatus 三态如实（统一配置解析单轨；与 core_query_commands 同源）
        let provider_status = crate::core_query_commands::provider_status_from_config();
        // 日志目录与 core_get_status 同源（app_dir()/logs）
        let log_dir = crate::host_paths::app_dir()
            .map(|dir| dir.join("logs").to_string_lossy().to_string())
            .unwrap_or_default();
        let status = build_status(
            self.core.initialized(),
            env!("CARGO_PKG_VERSION").to_string(),
            self.core.engine_ready(),
            self.search_index_ready,
            self.core.local_db().is_some(),
            self.compaction_ready,
            provider_status,
            conex_telemetry::current_level(),
            log_dir,
            diagnostics
                .entries()
                .into_iter()
                .map(|entry| DiagnosticEntry {
                    ts: entry.updated_at,
                    level: entry.subsystem,
                    message: entry.message.unwrap_or_default(),
                })
                .collect(),
            diagnostics.last_error().map(|payload| LastErrorEntry {
                kind: payload.code,
                detail: payload.message,
                ts: payload.timestamp,
            }),
            self.core.restore_status(),
            self.core.snapshot_status(),
            self.core.background_tasks_summary().await,
            // P-7（R2-07 D-02 收尾）：activeRuns / pendingApprovals 摘要
            // 注入——活动 run 注册表 + 审批门 pending 集合（复用 C13
            // 对账公共方法，M6 §4.1.1 摘要形状）
            list_active_runs_impl(&self.core).await,
            list_pending_approval_summaries_impl(&self.core),
            // T5-1b：崩溃台账读出面（与 GUI core_get_status 同源——
            // conex-telemetry 进程内崩溃标记，/v1/status 同步下发）
            conex_telemetry::last_crash_marker().map(|marker| {
                crate::core_query_commands::LastCrashInfo {
                    file_name: marker.file_name,
                    timestamp_ms: marker.timestamp_ms,
                }
            }),
        );
        serde_json::to_value(status)
            .map_err(|e| ServerError::internal(format!("状态序列化失败：{e}")))
    }

    /// C24 发起 run（runId 桌面生成；sessionId 缺省 = 新建会话并落索引，
    /// M6 C24；clientMessageId 幂等由 run_task_impl 既有语义保证）
    pub(super) async fn execute_run_task(
        &self,
        params: RunTaskParams,
    ) -> Result<RunTaskResult, ServerError> {
        let prompt = params.prompt.trim();
        if prompt.is_empty() {
            return Err(ServerError::protocol(
                conex_types::device::DeviceErrorCode::CmdInvalid,
                "prompt 不能为空",
            ));
        }
        if params.prompt.len() > 262_144 {
            return Err(ServerError::protocol(
                conex_types::device::DeviceErrorCode::CmdInvalid,
                "prompt 超过 256 KiB 上限（超限走流上传 promptRef，M6 §8.1）",
            ));
        }
        // 会话归属：显式 sessionId → 沿用；缺省 → 新建会话（标题 = prompt
        // 前缀，对齐桌面 commitDraftIfNeeded 语义）
        let session_id = match params.session_id.as_deref() {
            Some(id) if !id.trim().is_empty() => id.trim().to_string(),
            _ => {
                let id = generate_session_id();
                if let Some(db) = self.core.local_db() {
                    let title = prompt.chars().take(30).collect::<String>();
                    let title = if title.is_empty() {
                        "新会话".to_string()
                    } else {
                        title
                    };
                    db.insert_session(&id, &title)
                        .map_err(|e| ServerError::io(format!("新建会话落库失败：{e}")))?;
                }
                id
            }
        };
        // R1-10 T-08：远程 run 权限模式装配——full-access 恒降级 ask
        // （远程不存在 full-access，D5 §4.6.1 / TH-12 直接缓解）；降级发
        // remote-mode-downgrade 审计标记。history 为既有 HistoryMessage
        // 镜像（移动端一般省略，桌面 SessionHistoryCache 兜底）
        let (mode_clamped, mode_downgraded) = apply_remote_mode(params.permission_mode);
        let permission_mode = mode_clamped.map(|mode| match mode {
            PermissionMode::Ask => "ask".to_string(),
            PermissionMode::Plan => "plan".to_string(),
            PermissionMode::FullAccess => "full-access".to_string(),
        });
        if mode_downgraded {
            emit_remote_mode_downgrade_audit(Some(&self.core.event_bridge()), "", &session_id);
        }
        let history = params
            .history
            .map(|values| {
                values
                    .into_iter()
                    .filter_map(|value| {
                        serde_json::from_value::<conex_types::HistoryMessage>(value).ok()
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|list| !list.is_empty());
        let options = RunTaskOptions {
            run_id: generate_run_id(),
            session_id,
            prompt: Some(params.prompt),
            mode: params.mode,
            cwd: params.cwd,
            permission_mode,
            client_message_id: params.client_message_id,
            assistant_client_message_id: None,
            system_prompt: None,
            history,
            context_window: None,
            parent_run_id: None,
            subagent_config: None,
            // D5 §3.1：goal 三字段（远程 run 命令缺省 None，与旧命令面一致）
            visible_goal: None,
            max_rounds: None,
            max_stalled_rounds: None,
            // I1-β：远程 run 思考档位缺省 None（引擎默认；远程命令面无
            // 前端档位通道，行为与现状一致）
            reasoning_effort: None,
            // I1-α②：远程 run 不携带 context-state（状态切换告知仅
            // 桌面前端用户提交边界下发）
            context_state: None,
            // plans/04 §4.2：远程 run 不携带多模态 content（无桌面附件通道）
            content: None,
            has_images: None,
        };
        let response = run_task_impl(Arc::clone(&self.core), options)
            .await
            .map_err(Self::map_core)?;
        Ok(RunTaskResult {
            run_id: response.run_id,
            session_id: response.session_id,
        })
    }

    /// C21 递归文件名搜索（对齐注册表 SearchFilesParams/Result；复用
    /// 引擎 core_search_files 的搜索逻辑——同一搜索索引
    /// （SharedSearchState）+ conex-search 模糊匹配 + 并行阈值，远程
    /// 面差异：query 1-256（注册表契约）、maxResults 缺省 100 钳制
    /// 100（注册表钳制）、root 相对路径按组件边界过滤、relPath 相对
    /// 搜索根输出）
    pub(super) async fn execute_search_files(
        &self,
        params: SearchFilesParams,
    ) -> Result<SearchFilesResult, ServerError> {
        let query = params.query.trim().to_string();
        if query.is_empty() {
            return Err(ServerError::protocol(
                DeviceErrorCode::CmdInvalid,
                "query 不能为空（注册表 1-256）",
            ));
        }
        if query.chars().count() > SEARCH_QUERY_MAX_LEN_REMOTE {
            return Err(ServerError::protocol(
                DeviceErrorCode::CmdInvalid,
                format!("query 超过 {SEARCH_QUERY_MAX_LEN_REMOTE} 字符上限（注册表契约）"),
            ));
        }
        let root = params
            .root
            .map(|root| root.trim().to_string())
            .filter(|root| !root.is_empty());
        if let Some(root) = &root {
            if is_absolute_path(root) {
                return Err(ServerError::protocol(
                    DeviceErrorCode::CmdInvalid,
                    "root 必须为相对路径（F4 §7.2：手机端不传绝对路径）",
                ));
            }
        }
        let state = self.search_state.as_ref().ok_or_else(|| {
            ServerError::protocol(
                DeviceErrorCode::CmdEngineNotReady,
                "搜索索引未接线（装配面注入 SharedSearchState 后可用）",
            )
        })?;
        let files = state
            .files
            .read()
            .map_err(|e| ServerError::internal(format!("search index lock: {e}")))?
            .clone();
        let limit = params.max_results.unwrap_or(100).clamp(1, 100) as usize;
        let hits = tokio::task::spawn_blocking(move || {
            let matcher = FuzzyMatcher::new(false);
            let mut hits = if files.len() >= SEARCH_PARALLEL_THRESHOLD {
                search_files_parallel(&query, &files, limit, &matcher)
            } else {
                search_files(&query, &files, limit, &matcher)
            };
            if let Some(root) = &root {
                hits.retain(|hit| hit_path_within_root(&hit.path, root));
            }
            hits
        })
        .await
        .map_err(|e| ServerError::internal(format!("search task failed: {e}")))?;
        let results = hits
            .into_iter()
            .map(|hit| FileSearchHit {
                rel_path: self.rel_path_for(&hit.path),
                // 搜索索引只存路径（无 kind/size 元数据）——注册表
                // optional 字段缺省合法（少发送可选字段即合法）
                kind: None,
                size: None,
            })
            .collect();
        Ok(SearchFilesResult { results })
    }
}

/// 路径是否绝对路径（Unix `/` / Windows `\` 开头或盘符 `C:\` / `C:/`；
/// F4 §7.2：手机端只传相对路径，绝对路径请求按 cmd.invalid 拒绝）
pub(super) fn is_absolute_path(path: &str) -> bool {
    if path.starts_with('/') || path.starts_with('\\') {
        return true;
    }
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// C21 root 组件序列匹配（索引路径为绝对路径、root 为相对路径——按
/// 完整组件序列匹配，目录边界锚定防前缀误匹配；搜索索引仅覆盖工作区，
/// 无跨根误报）
pub(super) fn hit_path_within_root(hit_path: &str, root: &str) -> bool {
    let root_replaced = root.replace('\\', "/");
    let root_norm = root_replaced.trim_matches('/');
    if root_norm.is_empty() {
        return true;
    }
    let hit_norm = hit_path.replace('\\', "/");
    hit_norm.starts_with(&format!("{root_norm}/"))
        || hit_norm.contains(&format!("/{root_norm}/"))
        || hit_norm.ends_with(&format!("/{root_norm}"))
}

/// 审批 run 归属解析（M6 C11：runId 提供 → 沿用；缺失 → 按待审批
/// 集合反查；两者皆无 → cmd.approval_mismatch 409——与 resolve 冲突
/// 语义一致，避免伪造审批请求落入 404 的歧义）
pub(super) fn resolve_approval_run_id(
    core: &CoreRunState,
    params: &ApproveParams,
) -> Result<String, ServerError> {
    match params.run_id.as_deref() {
        Some(run_id) if !run_id.trim().is_empty() => Ok(run_id.trim().to_string()),
        _ => find_run_by_pending_tool_call(core, &params.tool_call_id).ok_or_else(|| {
            ServerError::protocol(
                conex_types::device::DeviceErrorCode::CmdApprovalMismatch,
                format!("tool_call_id 不在待审批集合：{}", params.tool_call_id),
            )
        }),
    }
}

/// deny 的 run 归属解析（与 [resolve_approval_run_id] 同语义）
pub(super) fn resolve_deny_run_id(
    core: &CoreRunState,
    params: &DenyParams,
) -> Result<String, ServerError> {
    match params.run_id.as_deref() {
        Some(run_id) if !run_id.trim().is_empty() => Ok(run_id.trim().to_string()),
        _ => find_run_by_pending_tool_call(core, &params.tool_call_id).ok_or_else(|| {
            ServerError::protocol(
                conex_types::device::DeviceErrorCode::CmdApprovalMismatch,
                format!("tool_call_id 不在待审批集合：{}", params.tool_call_id),
            )
        }),
    }
}
