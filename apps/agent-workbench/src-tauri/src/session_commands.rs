//! Stream B + PE-08：Tauri 命令层 —— 会话 SQLite 持久化入口
//!
//! 本模块提供 13 个 `#[tauri::command]`，包装 `conex_db::LocalDb` 的会话存储方法，
//! 对齐 `crish-desktop/src/api/session-persistence/sessionRustDb.ts` 的调用面。
//! CPU/IO 密集操作统一走 `tokio::task::spawn_blocking`，避免阻塞 Tauri 命令线程。
//! 命令错误统一为 `CoreError`（serde tagged enum，`{kind, detail}`），JS 侧可按
//! `error.kind` 分类处理（77 码显式映射经 `conex_types::core_error_code` 展开）。
//!
//! PE-08 冻结签名：
//! - F3（T08.1）：`upsert_session_entry(entry: SessionIndexEntry)`（对象签名，
//!   session 族第 12 个命令）；`save_session_body` 执行前自愈补建会话行
//!   （`INSERT OR IGNORE`，FK 写路径兜底，不改变「索引先行」语义）；
//! - F4（T08.2）：`cleanup_orphan_sessions(active_ids, confirm_empty)` ——
//!   空 keepIds 默认拒绝（`InvalidInput: cleanup_orphan_empty_keep`），
//!   `confirm_empty = true` 才允许显式清空（仅测试 / 显式用户清空入口）。
//!
//! F11b（T-D-12）：`get_flow_snapshot(session_id)` —— DAG 只读查询命令
//! （读 `flow_declaration` + `flow_state` + `session_agents` 按 subagent_run_id
//! 拼装节点状态，返回冻结载荷形状；只读通用面，无任何写入）。

use std::collections::HashMap;
use std::sync::Arc;

use agent_tools::tools::subagent::SubagentState;
use conex_db::{DbFailure, LocalDb};
use conex_types::{CoreError, ImportStats, SessionAgent, SessionIndexEntry, SessionMessage};
use orchestrator::flow_graph::{
    FailStrategy, FlowDeclaration, FlowNodeRuntime, FlowNodeState, FLOW_DECLARATION_KEY,
    FLOW_ON_FAILED_KEY, FLOW_STATE_KEY,
};
use tauri::State;

/// SharedDb 包装 LocalDb，注入到 Tauri 的 State 系统。
///
/// 设计：
/// - `LocalDb` 内部已是 `Arc<Mutex<Connection>>`，Clone 廉价；此处再包一层 Arc
///   是为了让 `SharedDb` 自身 Clone 廉价（State<'_, SharedDb> 拿到的是引用，无需 Clone）。
/// - `db_ready()` 暴露给 `core_get_status`，让 `db_ready` 字段反映真实状态而非硬编码。
/// - `local_db()` 返回 `LocalDb` clone（Arc 引用计数 +1），供 `spawn_blocking` 闭包拥有数据。
#[derive(Clone)]
pub struct SharedDb {
    db: Arc<LocalDb>,
    ready: Arc<std::sync::atomic::AtomicBool>,
}

impl SharedDb {
    pub fn new(db: LocalDb) -> Self {
        Self {
            db: Arc::new(db),
            ready: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        }
    }

    /// 数据库是否已就绪（setup 完成且无 fatal failure）。
    pub fn db_ready(&self) -> bool {
        self.ready.load(std::sync::atomic::Ordering::Relaxed)
            && self.db.get_failure().is_none()
    }

    /// 获取 `LocalDb` clone（Arc +1），供异步任务拥有数据副本。
    ///
    /// 注意：方法名不能取 `inner`，否则会被 `tauri::State::inner()` 遮蔽
    /// （`db_state.inner().local_db()` 返回 `&SharedDb` 而非 `LocalDb`）。
    pub fn local_db(&self) -> LocalDb {
        (*self.db).clone()
    }

    /// 标记数据库就绪状态。
    /// 文件 DB 打开失败并降级为内存 DB 时，调用 `set_ready(false)`
    /// 让 `core_get_status` 的 `db_ready` 字段反映真实状态。
    pub fn set_ready(&self, ready: bool) {
        self.ready
            .store(ready, std::sync::atomic::Ordering::Relaxed);
    }
}

/// 把 `DbFailure` 映射为统一 IPC 错误协议 `CoreError`。
/// kind 携带操作名（lock / *_prepare / *_commit 等），拼接进消息便于诊断；
/// 需要 77 码时经 `conex_types::core_error_code` 显式展开（IPC 面仍为 CoreError）。
fn map_db_err(e: DbFailure) -> CoreError {
    CoreError::Internal(format!("{}: {}", e.kind, e.message))
}

/// 校验 session_id 非空。
fn require_session_id(session_id: &str) -> Result<(), CoreError> {
    if session_id.trim().is_empty() {
        return Err(CoreError::invalid_input("session_id must not be empty"));
    }
    Ok(())
}

/// F4 冻结（T08.2）：空 keepIds 默认拒绝——防止 boot 窗口 / 未 hydrate 场景
/// 触发全库清空（AA-07 P02）；`confirm_empty = true` 仅测试 / 显式清空入口使用。
fn guard_cleanup_keep(active_ids: &[String], confirm_empty: bool) -> Result<(), CoreError> {
    if active_ids.is_empty() && !confirm_empty {
        return Err(CoreError::InvalidInput(
            "cleanup_orphan_empty_keep".to_string(),
        ));
    }
    Ok(())
}

/// 自愈写正文（T08.1）：先 `INSERT OR IGNORE` 补建会话行（空标题），再全量替换正文。
/// 等价于「`INSERT OR IGNORE INTO sessions (id, title) VALUES (?1, '')` 再写正文」，
/// 避免 FK 失败；upsert 主路径失败时的兜底，不改变「索引先行」语义。
fn self_heal_then_save_body(
    db: &LocalDb,
    session_id: &str,
    messages: &[SessionMessage],
) -> Result<(), DbFailure> {
    db.insert_session(session_id, "")?;
    db.save_session_body(session_id, messages)
}

#[tauri::command]
pub async fn list_sessions(db_state: State<'_, SharedDb>) -> Result<Vec<SessionIndexEntry>, CoreError> {
    let db = db_state.inner().local_db();
    let entries = tokio::task::spawn_blocking(move || db.list_sessions())
        .await
        .map_err(|e| CoreError::Internal(format!("list_sessions join: {e}")))?
        .map_err(map_db_err)?;
    Ok(entries)
}

#[tauri::command]
pub async fn load_session_body(
    session_id: String,
    db_state: State<'_, SharedDb>,
) -> Result<Vec<SessionMessage>, CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    let messages = tokio::task::spawn_blocking(move || db.load_session_body(&session_id))
        .await
        .map_err(|e| CoreError::Internal(format!("load_session_body join: {e}")))?
        .map_err(map_db_err)?;
    Ok(messages)
}

#[tauri::command]
pub async fn save_session_body(
    session_id: String,
    messages: Vec<SessionMessage>,
    db_state: State<'_, SharedDb>,
) -> Result<(), CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || self_heal_then_save_body(&db, &session_id, &messages))
        .await
        .map_err(|e| CoreError::Internal(format!("save_session_body join: {e}")))?
        .map_err(map_db_err)?;
    Ok(())
}

/// delete_session 返回（G03 T-EG-12：清理通知载荷 = 清理结果 + 回收站位置）。
///
/// 前端可据 `notice` 展示清理结果，据 `trashRoot` 引导用户到回收站恢复。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionResult {
    /// 是否清理了产出目录（false = 无产出目录或越界被安全跳过）
    pub cleaned: bool,
    /// 已移入回收站的产出目录清单（绝对路径）
    pub trashed_dirs: Vec<String>,
    /// 回收站根位置（误删恢复入口，与删除工具同源）
    pub trash_root: String,
    /// 通知文案（清理结果 + 回收站位置，供前端展示）
    pub notice: String,
}

/// delete_session 的 spawn_blocking 段（可测）：删除前读取产出元数据
/// （`{session_id}:output_dir` / `{session_id}:output_root`，G01/G03 键），
/// 再删除会话行——meta 必须先读后删，否则行消失后无法定位产出目录。
///
/// T-F 06 退役登记：仅随 delete_session 使用（测试直调保留），与命令一同
/// 保留待存储架构裁决后恢复。
#[allow(dead_code)]
fn delete_session_and_read_meta(
    db: &LocalDb,
    session_id: &str,
) -> Result<(Option<String>, Option<String>), DbFailure> {
    let dir_key = crate::outputs_config::session_meta_key_of(
        session_id,
        crate::outputs_config::SESSION_META_KEY_OUTPUT_DIR,
    );
    let root_key = crate::outputs_config::session_meta_key_of(
        session_id,
        crate::outputs_config::SESSION_META_KEY_OUTPUT_ROOT,
    );
    let dir = db.get_session_meta(&dir_key)?;
    let root = db.get_session_meta(&root_key)?;
    db.delete_session(session_id)?;
    Ok((dir, root))
}

/// T-F 06（通信契约）退役登记：命令注册与 manifest 已退役（前端删除走
/// IndexedDB 本地面，Rust LocalDb 面待存储架构裁决后决定是否恢复；changelog
/// 33 可查）。函数保留待恢复。
#[allow(dead_code)]
#[tauri::command]
pub async fn delete_session(
    session_id: String,
    app: tauri::AppHandle,
    db_state: State<'_, SharedDb>,
) -> Result<DeleteSessionResult, CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    // 删除前读产出 meta → 删除会话行（spawn_blocking 内，避免阻塞命令线程）
    let meta_session_id = session_id.clone();
    let meta = tokio::task::spawn_blocking(move || {
        delete_session_and_read_meta(&db, &meta_session_id)
    })
        .await
        .map_err(|e| CoreError::Internal(format!("delete_session join: {e}")))?
        .map_err(map_db_err)?;
    // 产出目录清理（G03 T-EG-12 完整链路：删除 → 进回收站（trash 接管）→
    // 通知用户；越界安全红线由清理侧裁决）
    let cleanup = crate::outputs_config::cleanup_session_outputs(
        &app,
        &session_id,
        meta.0.as_deref(),
        meta.1.as_deref(),
    )?;
    Ok(DeleteSessionResult {
        cleaned: cleanup.cleaned,
        trashed_dirs: cleanup.trashed_dirs,
        trash_root: cleanup.trash_root,
        notice: cleanup.notice,
    })
}

#[tauri::command]
pub async fn load_session_agents(
    session_id: String,
    db_state: State<'_, SharedDb>,
) -> Result<Vec<SessionAgent>, CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    let agents = tokio::task::spawn_blocking(move || db.load_session_agents(&session_id))
        .await
        .map_err(|e| CoreError::Internal(format!("load_session_agents join: {e}")))?
        .map_err(map_db_err)?;
    Ok(agents)
}

#[tauri::command]
pub async fn save_session_agents(
    session_id: String,
    agents: Vec<SessionAgent>,
    db_state: State<'_, SharedDb>,
) -> Result<(), CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || db.save_session_agents(&session_id, &agents))
        .await
        .map_err(|e| CoreError::Internal(format!("save_session_agents join: {e}")))?
        .map_err(map_db_err)?;
    Ok(())
}

#[tauri::command]
pub async fn get_session_meta(
    key: String,
    db_state: State<'_, SharedDb>,
) -> Result<Option<String>, CoreError> {
    if key.trim().is_empty() {
        return Err(CoreError::invalid_input("key must not be empty"));
    }
    let db = db_state.inner().local_db();
    let value = tokio::task::spawn_blocking(move || db.get_session_meta(&key))
        .await
        .map_err(|e| CoreError::Internal(format!("get_session_meta join: {e}")))?
        .map_err(map_db_err)?;
    Ok(value)
}

#[tauri::command]
pub async fn set_session_meta(
    key: String,
    value: String,
    db_state: State<'_, SharedDb>,
) -> Result<(), CoreError> {
    if key.trim().is_empty() {
        return Err(CoreError::invalid_input("key must not be empty"));
    }
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || db.set_session_meta(&key, &value))
        .await
        .map_err(|e| CoreError::Internal(format!("set_session_meta join: {e}")))?
        .map_err(map_db_err)?;
    Ok(())
}

/// 清理不在 keepIds 中的会话（孤儿清理，F4 冻结签名）。
///
/// - `active_ids` 非空：删除不在集合内的孤儿行，返回删除行数；
/// - `active_ids` 为空且 `confirm_empty = false`：**不执行任何 DELETE**，返回
///   `Err(InvalidInput, "cleanup_orphan_empty_keep")`（前端可见，防 P02 全库清空）；
/// - `active_ids` 为空且 `confirm_empty = true`：显式清空（仅测试 / 显式清空入口）。
///
/// 宽限期（`ORPHAN_GRACE_MS`，session_meta `orphan_grace_ms` 可配）与
/// `confirm_empty` 的库层实现由 conex-db 侧承接（PE-08 T08.2 产出）。
#[tauri::command]
pub async fn cleanup_orphan_sessions(
    active_ids: Vec<String>,
    confirm_empty: Option<bool>,
    db_state: State<'_, SharedDb>,
) -> Result<usize, CoreError> {
    guard_cleanup_keep(&active_ids, confirm_empty.unwrap_or(false))?;
    let db = db_state.inner().local_db();
    let deleted = tokio::task::spawn_blocking(move || db.cleanup_orphan_sessions(&active_ids))
        .await
        .map_err(|e| CoreError::Internal(format!("cleanup_orphan_sessions join: {e}")))?
        .map_err(map_db_err)?;
    Ok(deleted)
}

#[tauri::command]
pub async fn import_from_localstorage(
    index_json: String,
    bodies: HashMap<String, String>,
    agents: HashMap<String, String>,
    active_session_id: Option<String>,
    folder_order: Vec<String>,
    db_state: State<'_, SharedDb>,
) -> Result<ImportStats, CoreError> {
    let db = db_state.inner().local_db();
    let stats = tokio::task::spawn_blocking(move || {
        db.import_from_localstorage(
            &index_json,
            bodies,
            agents,
            active_session_id.as_deref(),
            &folder_order,
        )
    })
    .await
    .map_err(|e| CoreError::Internal(format!("import_from_localstorage join: {e}")))?
    .map_err(map_db_err)?;
    Ok(stats)
}

/// T-F 06（通信契约）退役登记：命令注册与 manifest 已退役（无消费意图；
/// 如需会话列表按活跃排序再恢复；changelog 33 可查）。函数保留待恢复。
#[allow(dead_code)]
#[tauri::command]
pub async fn touch_session(
    session_id: String,
    db_state: State<'_, SharedDb>,
) -> Result<(), CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || db.touch_session(&session_id))
        .await
        .map_err(|e| CoreError::Internal(format!("touch_session join: {e}")))?
        .map_err(map_db_err)?;
    Ok(())
}

/// 幂等写入会话索引条目（F3 冻结签名，session 族第 12 个命令）。
///
/// 语义 = `ON CONFLICT(id) DO UPDATE`：只更新索引列，不级联删除消息 /
/// agents（`upsert_does_not_cascade_delete_messages` 先例锚定）。
#[tauri::command]
pub async fn upsert_session_entry(
    entry: SessionIndexEntry,
    db_state: State<'_, SharedDb>,
) -> Result<(), CoreError> {
    require_session_id(&entry.id)?;
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || db.upsert_session_entry(&entry))
        .await
        .map_err(|e| CoreError::Internal(format!("upsert_session_entry join: {e}")))?
        .map_err(map_db_err)?;
    Ok(())
}

// ── F11b（T-D-12）：DAG 只读快照查询 ────────────────────────────────

/// 流程 DAG 快照（get_flow_snapshot 返回值）。
///
/// 载荷形状由主调度冻结（`{ nodes: [{ id, task, dependsOn, parallel,
/// isComposite, state, subagentRunId }] }`），DAG-2 前端按同形状消费——
/// 见 docs/feature-gap-analysis/调研-可视化与扩展点.md §2.5。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSnapshot {
    /// 节点列表（声明序 = 同层串行顺序）
    pub nodes: Vec<FlowSnapshotNode>,
}

/// 单节点快照（字段对齐冻结形状；camelCase，对齐 flow_graph serde 命名）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSnapshotNode {
    /// 节点 id（会话内唯一，依赖边端点）
    pub id: String,
    /// 任务目标（spawn 子 agent 的 prompt）
    pub task: String,
    /// 前置节点 id 列表（空 = 无前置，可首批启动；恒输出数组对齐冻结形状）
    pub depends_on: Vec<String>,
    /// 是否允许与无依赖关系的同级节点并发（false = 与同级串行）
    pub parallel: bool,
    /// 综合节点标记（gate / verify / critique 类，合成唤醒）
    pub is_composite: bool,
    /// 节点状态（pending/running/completed/failed/blocked，对齐 FlowNodeState）
    pub state: String,
    /// 关联的子代理 run id（None = 未启动；挂接外部 run 也落此字段）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_run_id: Option<String>,
}

/// 从持久化数据拼装 DAG 快照（只读，T-D-12 引擎侧核心组装逻辑）。
///
/// 数据源：
/// - `flow_declaration` 键：编排声明（节点 / 依赖 / parallel / is_composite）；
/// - `flow_state` 键：节点 → run 映射（[FlowNodeRuntime] JSON 数组）；
/// - `session_agents` 行：按 `subagent_run_id` 拼装节点状态
///   （`SubagentState::from_db_status` → `FlowNodeState::from_subagent`，
///   与 FlowScheduler::load 同口径）。
///
/// 派生语义（只读镜像 FlowScheduler 恢复面，flow_graph.rs:1346-1380）：
/// - 无编排声明（键缺失）→ 空 nodes（空态，不报错）；
/// - 未启动节点（无 run 映射）→ pending；
/// - run 映射存在但 session_agents 无行 → failed（fail-open，数据不一致兜底）；
/// - Block 传播到不动点：待启动节点任一前置为 blocked，或前置 failed 且其
///   生效策略为 Block → 本节点 blocked（镜像 propagate_block，
///   flow_graph.rs:1476-1512；生效策略 = 节点级 on_failed ?? 会话级
///   flow_on_failed，键缺失默认 Block；解析失败宽容取 Block）。
fn build_flow_snapshot(
    declaration_raw: Option<String>,
    state_raw: Option<String>,
    on_failed_raw: Option<String>,
    agents: &[SessionAgent],
) -> Result<FlowSnapshot, CoreError> {
    // 空态：无 flow 声明 → 空 nodes（前端空态判定直接命中）
    let Some(declaration_raw) = declaration_raw else {
        return Ok(FlowSnapshot { nodes: Vec::new() });
    };
    let declaration: FlowDeclaration = serde_json::from_str(&declaration_raw).map_err(|e| {
        CoreError::Internal(format!("flow_declaration 解析失败：{e}"))
    })?;
    // 运行时状态：节点 id → FlowNodeRuntime（run 映射 / 唤醒标记）
    let runtime: HashMap<String, FlowNodeRuntime> = match state_raw {
        Some(state_raw) => {
            let entries: Vec<FlowNodeRuntime> = serde_json::from_str(&state_raw).map_err(|e| {
                CoreError::Internal(format!("flow_state 解析失败：{e}"))
            })?;
            entries
                .into_iter()
                .map(|rt| (rt.node_id.clone(), rt))
                .collect()
        }
        None => HashMap::new(),
    };
    // 会话级默认失败策略（缺失 = Block，对齐 read_meta_strategy 默认值）
    let session_strategy = on_failed_raw
        .as_deref()
        .and_then(FailStrategy::parse)
        .unwrap_or(FailStrategy::Block);
    let rows: HashMap<&str, &SessionAgent> = agents
        .iter()
        .map(|r| (r.subagent_run_id.as_str(), r))
        .collect();
    // 节点级生效策略（节点级覆盖 ?? 会话级默认，对齐 effective_strategy）
    let node_strategy = |id: &str| {
        declaration
            .tasks
            .iter()
            .find(|n| n.id == id)
            .and_then(|n| n.on_failed)
            .unwrap_or(session_strategy)
    };

    // 1. 基础状态：按 run 映射 + session_agents 行拼装（镜像 load 步骤 4）
    let mut states: HashMap<String, FlowNodeState> = HashMap::new();
    for node in &declaration.tasks {
        let state = match runtime
            .get(&node.id)
            .and_then(|rt| rt.subagent_run_id.as_deref())
        {
            Some(run_id) => match rows.get(run_id) {
                Some(row) => {
                    FlowNodeState::from_subagent(SubagentState::from_db_status(&row.status))
                }
                // 数据不一致：run 记录缺失 → 按失败处理（fail-open）
                None => FlowNodeState::Failed,
            },
            None => FlowNodeState::Pending,
        };
        states.insert(node.id.clone(), state);
    }

    // 2. Block 传播到不动点（只读派生，镜像 propagate_block；依赖环已在
    //    声明校验拒绝，无需防循环）
    loop {
        let mut changed = false;
        for node in &declaration.tasks {
            if states.get(&node.id).copied() != Some(FlowNodeState::Pending) {
                continue;
            }
            let blocker = node.depends_on.iter().any(|dep| match states.get(dep) {
                Some(FlowNodeState::Blocked) => true,
                Some(FlowNodeState::Failed) => node_strategy(dep) == FailStrategy::Block,
                _ => false,
            });
            if blocker {
                states.insert(node.id.clone(), FlowNodeState::Blocked);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    // 3. 组装冻结形状（声明序输出）
    let nodes = declaration
        .tasks
        .iter()
        .map(|n| FlowSnapshotNode {
            id: n.id.clone(),
            task: n.task.clone(),
            depends_on: n.depends_on.clone(),
            parallel: n.parallel,
            is_composite: n.is_composite,
            state: states
                .get(&n.id)
                .copied()
                .unwrap_or(FlowNodeState::Pending)
                .as_str()
                .to_string(),
            subagent_run_id: runtime
                .get(&n.id)
                .and_then(|rt| rt.subagent_run_id.clone()),
        })
        .collect();
    Ok(FlowSnapshot { nodes })
}

/// get_flow_snapshot：DAG 只读查询命令（T-D-12 引擎侧，F11b）。
///
/// 读 `flow_declaration` + `flow_state` + `session_agents`（按 subagent_run_id
/// 拼装节点状态），返回冻结载荷形状 `{ nodes: [...] }`（见 [FlowSnapshot]）。
/// 只读通用面：不新增任何写入（编排权仍在主 Agent）；命令保留无害——
/// `flow_dag_visible` 开关（默认关）关闭时前端不调用本命令。
#[tauri::command]
pub async fn get_flow_snapshot(
    session_id: String,
    db_state: State<'_, SharedDb>,
) -> Result<FlowSnapshot, CoreError> {
    require_session_id(&session_id)?;
    let db = db_state.inner().local_db();
    let snapshot = tokio::task::spawn_blocking(move || -> Result<FlowSnapshot, CoreError> {
        let declaration = db.get_session_meta(FLOW_DECLARATION_KEY).map_err(map_db_err)?;
        let state = db.get_session_meta(FLOW_STATE_KEY).map_err(map_db_err)?;
        let on_failed = db.get_session_meta(FLOW_ON_FAILED_KEY).map_err(map_db_err)?;
        let agents = db.load_session_agents(&session_id).map_err(map_db_err)?;
        build_flow_snapshot(declaration, state, on_failed, &agents)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("get_flow_snapshot join: {e}")))??;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：本模块含会话删除清理链路测试（临时目录清理 /
    // 临时文件写入，非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use orchestrator::flow_graph::FlowNode;

    fn sample_entry(id: &str) -> SessionIndexEntry {
        SessionIndexEntry {
            id: id.to_string(),
            title: format!("Title {id}"),
            folder: "常规会话".to_string(),
            is_pinned: false,
            is_archived: false,
            branch_parent_id: None,
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            updated_at: 1000,
            message_count: 0,
            pinned_message_ids: None,
            engine_cursor: None,
            engine_last_run_id: None,
            hydrated_from_engine: None,
        }
    }

    fn sample_message(id: &str, sender: &str, ts: i64) -> SessionMessage {
        SessionMessage {
            id: id.to_string(),
            sender: sender.to_string(),
            text: Some(format!("text-{id}")),
            thinking: None,
            timestamp: ts,
            status: Some("completed".to_string()),
            stream_text_offset: None,
            thinking_time: None,
            tool_calls_json: None,
            blocks_json: None,
            tool_call_results_json: None,
            usage: None,
        }
    }

    #[test]
    fn shared_db_reports_ready() {
        let db = LocalDb::open_in_memory().unwrap();
        let shared = SharedDb::new(db);
        assert!(shared.db_ready());
    }

    #[test]
    fn shared_db_inner_clones() {
        let db = LocalDb::open_in_memory().unwrap();
        let shared = SharedDb::new(db);
        let _clone = shared.local_db();
        // 原始 SharedDb 仍可用
        assert!(shared.db_ready());
    }

    #[test]
    fn require_session_id_rejects_empty() {
        assert!(require_session_id("").is_err());
        assert!(require_session_id("   ").is_err());
        assert!(require_session_id("s1").is_ok());
    }

    #[test]
    fn map_db_err_preserves_message() {
        let e = DbFailure {
            message: "locked".to_string(),
            // kind 现为 DbFailureKind 枚举（R6 收敛）；Display 仍输出操作名
            kind: conex_db::DbFailureKind::Lock,
        };
        let core = map_db_err(e);
        match core {
            CoreError::Internal(msg) => assert!(msg.contains("locked")),
            other => panic!("expected Internal, got {other:?}"),
        }
    }

    // ── F4：空 keepIds 默认拒绝（PE-08 T08.2）──

    #[test]
    fn cleanup_guard_rejects_empty_keep_without_confirm() {
        let err = guard_cleanup_keep(&[], false).expect_err("must reject");
        match err {
            CoreError::InvalidInput(detail) => assert_eq!(detail, "cleanup_orphan_empty_keep"),
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn cleanup_guard_allows_explicit_empty_confirm() {
        guard_cleanup_keep(&[], true).expect("explicit confirm allows clear");
        guard_cleanup_keep(&["s1".to_string()], false).expect("non-empty keep is allowed");
    }

    // ── T08.1：save_session_body 自愈补建会话行 ──

    #[test]
    fn save_session_body_self_heals_missing_session_row() {
        let db = LocalDb::open_in_memory().unwrap();
        let messages = [
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
        ];

        // 全新内存库：无索引行，自愈后正文可写入（不再 FK 失败）。
        self_heal_then_save_body(&db, "s1", &messages).expect("self-heal save");

        let body = db.load_session_body("s1").unwrap();
        assert_eq!(body.len(), 2);
        let list = db.list_sessions().unwrap();
        assert_eq!(list[0].id, "s1");
        // 触发器维护 message_count。
        assert_eq!(list[0].message_count, 2);
    }

    #[test]
    fn save_session_body_self_heal_keeps_existing_row() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();

        let messages = [sample_message("m1", "user", 1)];
        self_heal_then_save_body(&db, "s1", &messages).expect("save with existing row");

        // 既有索引行不被覆盖（INSERT OR IGNORE 幂等）。
        let list = db.list_sessions().unwrap();
        assert_eq!(list[0].title, "Title s1");
    }

    // ── F3：upsert_session_entry 命令层校验 ──

    #[test]
    fn upsert_requires_non_empty_entry_id() {
        let mut entry = sample_entry("s1");
        entry.id = "   ".to_string();
        assert!(require_session_id(&entry.id).is_err());
    }

    #[test]
    fn upsert_does_not_cascade_delete_messages() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        db.save_session_body(
            "s1",
            &[
                sample_message("m1", "user", 1),
                sample_message("m2", "assistant", 2),
            ],
        )
        .unwrap();

        // 再次 upsert 同一会话，不应丢失消息。
        let mut entry = sample_entry("s1");
        entry.title = "Updated Title".to_string();
        db.upsert_session_entry(&entry).unwrap();

        let body = db.load_session_body("s1").unwrap();
        assert_eq!(body.len(), 2);
        let list = db.list_sessions().unwrap();
        assert_eq!(list[0].title, "Updated Title");
        assert_eq!(list[0].message_count, 2);
    }

    #[test]
    fn end_to_end_via_shared_db() {
        // 验证 SharedDb.local_db() 与 LocalDb 行为一致
        let db = LocalDb::open_in_memory().unwrap();
        let shared = SharedDb::new(db);
        let inner = shared.local_db();

        inner.upsert_session_entry(&sample_entry("s1")).unwrap();
        inner
            .save_session_body(
                "s1",
                &[
                    sample_message("m1", "user", 1),
                    sample_message("m2", "assistant", 2),
                ],
            )
            .unwrap();

        let body = inner.load_session_body("s1").unwrap();
        assert_eq!(body.len(), 2);

        let list = inner.list_sessions().unwrap();
        assert_eq!(list[0].message_count, 2);
    }

    // ── G03 T-EG-12：会话删除清理完整链路 ──

    /// 测试用临时目录（独立命名，drop 自动清理）
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(prefix: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
            let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "conex_sess_del_{prefix}_{}_{seq}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// delete_session_and_read_meta：删除前读产出 meta，删除后会话行消失
    #[test]
    fn delete_session_reads_output_meta_before_delete() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        let out_dir_key = crate::outputs_config::session_meta_key_of(
            "s1",
            crate::outputs_config::SESSION_META_KEY_OUTPUT_DIR,
        );
        let out_root_key = crate::outputs_config::session_meta_key_of(
            "s1",
            crate::outputs_config::SESSION_META_KEY_OUTPUT_ROOT,
        );
        db.set_session_meta(&out_dir_key, "/tmp/conex/x/2026-08-05-s1")
            .unwrap();
        db.set_session_meta(&out_root_key, ".agent-outputs").unwrap();

        let (dir, root) = delete_session_and_read_meta(&db, "s1").unwrap();
        assert_eq!(dir.as_deref(), Some("/tmp/conex/x/2026-08-05-s1"));
        assert_eq!(root.as_deref(), Some(".agent-outputs"));
        assert!(db.list_sessions().unwrap().is_empty(), "会话行应已删除");
        // 库层现状：session_meta 为独立 KV 表（schema.rs:250 无 FK 级联），
        // 会话删除后键残留——清理链已消费键值，首次 resolve 覆盖写，无害；
        // 补 delete_session_meta / 级联清理列为遗留（conex-db 域）。
        assert!(
            db.get_session_meta(&out_dir_key).unwrap().is_some(),
            "当前库层保留 session_meta 键（见注释说明）"
        );
    }

    /// 完整链路（T-EG-12 验收）：删除会话 → 产出目录进回收站（trash 注册
    /// 断言）→ 清理通知发出（notice 含结果与回收站位置）
    #[test]
    fn delete_session_cleanup_full_chain_trashes_outputs_and_notifies() {
        // 场景：内存库会话 s1 + 工作区产出目录（G01 落键精确命中）
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        let ws = TempDir::new("ws");
        let trash = TempDir::new("trash");
        let out_dir = ws.0.join(".agent-outputs/2026-08-05-s1");
        std::fs::create_dir_all(out_dir.join("sub")).unwrap();
        std::fs::write(out_dir.join("sub/a.md"), "产出文档").unwrap();
        let out_dir_key = crate::outputs_config::session_meta_key_of(
            "s1",
            crate::outputs_config::SESSION_META_KEY_OUTPUT_DIR,
        );
        db.set_session_meta(&out_dir_key, out_dir.to_str().unwrap())
            .unwrap();

        // ① 删除会话（spawn_blocking 段直测）
        let (dir, root) = delete_session_and_read_meta(&db, "s1").unwrap();
        assert_eq!(dir.as_deref(), Some(out_dir.to_str().unwrap()));
        assert!(root.is_none());
        assert!(db.list_sessions().unwrap().is_empty());

        // ② 产出目录清理（trash 接管：conex-fs trash，不直接 remove）
        let result = crate::outputs_config::cleanup_session_outputs_at(
            trash.path(),
            ws.path(),
            "s1",
            dir.as_deref(),
            root.as_deref(),
            None,
            false,
        );
        assert!(result.cleaned, "notice: {}", result.notice);
        assert_eq!(result.trashed_dirs, vec![out_dir.to_string_lossy().into_owned()]);
        assert!(!out_dir.exists(), "产出目录应已移入回收站");

        // ③ trash 注册断言：条目可见、原路径正确、类型为目录
        let service = conex_fs::trash::TrashService::new(trash.path());
        let entries = service.list();
        assert_eq!(entries.len(), 1, "回收站登记应有且仅有一条");
        assert_eq!(entries[0].original_path, out_dir);
        assert_eq!(entries[0].kind, conex_fs::trash::TrashKind::Dir);

        // ④ 清理通知发出：结果 + 回收站位置
        assert!(result.notice.contains("移入回收站"));
        assert!(result.notice.contains("回收站位置"));
        assert!(result.trash_root.contains("trash"), "回收站位置应指向 trash 根：{}", result.trash_root);
    }

    /// 无产出目录的会话删除：清理为干净 no-op，通知说明无需清理
    #[test]
    fn delete_session_cleanup_no_outputs_noop_notice() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        let ws = TempDir::new("ws");
        let trash = TempDir::new("trash");

        let (dir, root) = delete_session_and_read_meta(&db, "s1").unwrap();
        assert!(dir.is_none() && root.is_none());

        let result = crate::outputs_config::cleanup_session_outputs_at(
            trash.path(),
            ws.path(),
            "s1",
            dir.as_deref(),
            root.as_deref(),
            None,
            false,
        );
        assert!(!result.cleaned);
        assert!(result.notice.contains("未发现会话产出目录"));
        assert!(result.notice.contains("回收站位置"));
        assert!(
            conex_fs::trash::TrashService::new(trash.path()).list().is_empty()
        );
    }

    // ── F11b（T-D-12）：get_flow_snapshot 只读快照查询 ──

    /// 测试用编排声明（与 persist_declaration 同形状写库：camelCase JSON）
    fn write_declaration(db: &LocalDb, tasks: Vec<FlowNode>) {
        let decl = FlowDeclaration {
            tasks,
            planner_run_id: Some("run-main".into()),
        };
        let json = serde_json::to_string(&decl).unwrap();
        db.set_session_meta(FLOW_DECLARATION_KEY, &json).unwrap();
    }

    /// 测试用 flow_state（与 persist_runtime 同形状写库：FlowNodeRuntime 数组）
    fn write_flow_state(db: &LocalDb, runtimes: Vec<FlowNodeRuntime>) {
        let json = serde_json::to_string(&runtimes).unwrap();
        db.set_session_meta(FLOW_STATE_KEY, &json).unwrap();
    }

    /// 测试用 session_agents 行（仅 status / subagent_run_id 参与拼装）
    fn sample_agent(run_id: &str, status: &str) -> SessionAgent {
        SessionAgent {
            id: format!("a-{run_id}"),
            subagent_run_id: run_id.to_string(),
            parent_session_id: "s1".to_string(),
            parent_run_id: "run-main".to_string(),
            parent_tool_call_id: None,
            description: String::new(),
            mode: "analysis".to_string(),
            status: status.to_string(),
            summary: None,
            messages: Vec::new(),
            started_at: 100,
            ended_at: None,
            depth: Some(0),
            subagent_path_json: None,
            task_type: Some("analysis".to_string()),
            display_label: None,
            allowed_write_paths_json: None,
            sub_session_id: None,
        }
    }

    /// 直接从库读取原始 flow 键（模拟命令侧读取面）
    fn read_raw_flow(db: &LocalDb) -> (Option<String>, Option<String>, Option<String>, Vec<SessionAgent>) {
        (
            db.get_session_meta(FLOW_DECLARATION_KEY).unwrap(),
            db.get_session_meta(FLOW_STATE_KEY).unwrap(),
            db.get_session_meta(FLOW_ON_FAILED_KEY).unwrap(),
            db.load_session_agents("s1").unwrap(),
        )
    }

    /// 空态：无 flow 声明 → 返回空 nodes（不报错）
    #[test]
    fn flow_snapshot_empty_nodes_without_declaration() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        // 无任何 flow_* 键（也未写 flow_state / 无子代理行）
        let (decl, state, on_failed, agents) = read_raw_flow(&db);
        let snap = build_flow_snapshot(decl, state, on_failed, &agents).unwrap();
        assert!(snap.nodes.is_empty(), "空态应返回空 nodes");
    }

    /// 节点状态与 flow_state + session_agents 拼装一致（含状态映射 +
    /// stopped 归一 failed + run 缺失行 fail-open；未知 DB 值宽容归一 failed
    /// 由 DB CHECK 约束挡在写面之外，agent-tools 侧已测）
    #[test]
    fn flow_snapshot_matches_persisted_states() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        write_declaration(
            &db,
            vec![
                FlowNode {
                    id: "t1".into(),
                    task: "分析内核".into(),
                    depends_on: vec![],
                    parallel: true,
                    on_failed: None,
                    is_composite: false,
                },
                FlowNode {
                    id: "t2".into(),
                    task: "实现组件".into(),
                    depends_on: vec!["t1".into()],
                    parallel: false,
                    on_failed: None,
                    is_composite: false,
                },
                FlowNode {
                    id: "t3".into(),
                    task: "评审验收".into(),
                    depends_on: vec!["t1".into(), "t2".into()],
                    parallel: false,
                    on_failed: None,
                    is_composite: true,
                },
                FlowNode {
                    id: "t4".into(),
                    task: "安全审计".into(),
                    depends_on: vec!["t2".into()],
                    parallel: true,
                    on_failed: None,
                    is_composite: false,
                },
            ],
        );
        write_flow_state(
            &db,
            vec![
                FlowNodeRuntime {
                    node_id: "t1".into(),
                    subagent_run_id: Some("run-1".into()),
                    subagent_id: Some("a-run-1".into()),
                    subagent_session_id: None,
                    wakeup_sent: false,
                },
                FlowNodeRuntime {
                    node_id: "t2".into(),
                    subagent_run_id: Some("run-2".into()),
                    subagent_id: Some("a-run-2".into()),
                    subagent_session_id: None,
                    wakeup_sent: false,
                },
                FlowNodeRuntime {
                    node_id: "t3".into(),
                    subagent_run_id: Some("run-3".into()),
                    subagent_id: Some("a-run-3".into()),
                    subagent_session_id: None,
                    wakeup_sent: false,
                },
                // t4：run 映射存在但 session_agents 无行 → fail-open 按失败处理
                FlowNodeRuntime {
                    node_id: "t4".into(),
                    subagent_run_id: Some("run-4".into()),
                    subagent_id: None,
                    subagent_session_id: None,
                    wakeup_sent: false,
                },
            ],
        );
        db.save_session_agents(
            "s1",
            &[
                sample_agent("run-1", "completed"),
                sample_agent("run-2", "running"),
                // stopped 归一 failed（读回宽容，subagent.rs:458-465）
                sample_agent("run-3", "stopped"),
            ],
        )
        .unwrap();

        let (decl, state, on_failed, agents) = read_raw_flow(&db);
        let snap = build_flow_snapshot(decl, state, on_failed, &agents).unwrap();
        assert_eq!(snap.nodes.len(), 4, "节点数 = 声明任务数");
        let by_id: HashMap<&str, &FlowSnapshotNode> = snap
            .nodes
            .iter()
            .map(|n| (n.id.as_str(), n))
            .collect();
        // 状态与持久化数据一致（flow_state + session_agents 拼装）
        assert_eq!(by_id["t1"].state, "completed");
        assert_eq!(by_id["t1"].subagent_run_id.as_deref(), Some("run-1"));
        assert_eq!(by_id["t2"].state, "running");
        assert_eq!(by_id["t2"].subagent_run_id.as_deref(), Some("run-2"));
        assert_eq!(by_id["t3"].state, "failed", "stopped 归一 failed");
        assert_eq!(by_id["t4"].state, "failed", "run 记录缺失 fail-open");
        assert_eq!(by_id["t4"].subagent_run_id.as_deref(), Some("run-4"));
        // 声明字段透传（含依赖边）
        assert_eq!(by_id["t1"].depends_on, Vec::<String>::new());
        assert_eq!(by_id["t3"].depends_on, vec!["t1".to_string(), "t2".to_string()]);
        assert!(by_id["t1"].parallel);
        assert!(by_id["t3"].is_composite);
        assert!(!by_id["t2"].is_composite);
        assert_eq!(by_id["t3"].task, "评审验收");
    }

    /// Block 传播：前置 failed（生效策略 Block）→ 后置 blocked（含传递阻塞）
    #[test]
    fn flow_snapshot_propagates_blocked_transitively() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        write_declaration(
            &db,
            vec![
                FlowNode {
                    id: "a".into(),
                    task: "任务 A".into(),
                    depends_on: vec![],
                    parallel: true,
                    on_failed: None,
                    is_composite: false,
                },
                FlowNode {
                    id: "b".into(),
                    task: "任务 B".into(),
                    depends_on: vec!["a".into()],
                    parallel: true,
                    on_failed: None,
                    is_composite: false,
                },
                FlowNode {
                    id: "c".into(),
                    task: "任务 C".into(),
                    depends_on: vec!["b".into()],
                    parallel: false,
                    on_failed: None,
                    is_composite: false,
                },
            ],
        );
        write_flow_state(
            &db,
            vec![FlowNodeRuntime {
                node_id: "a".into(),
                subagent_run_id: Some("run-a".into()),
                subagent_id: Some("a-run-a".into()),
                subagent_session_id: None,
                wakeup_sent: false,
            }],
        );
        db.save_session_agents("s1", &[sample_agent("run-a", "failed")])
            .unwrap();

        // 无 flow_on_failed 键 → 会话级默认 Block：b、c 传递阻塞
        let (decl, state, on_failed, agents) = read_raw_flow(&db);
        let snap = build_flow_snapshot(decl, state, on_failed, &agents).unwrap();
        let by_id: HashMap<&str, &FlowSnapshotNode> = snap
            .nodes
            .iter()
            .map(|n| (n.id.as_str(), n))
            .collect();
        assert_eq!(by_id["a"].state, "failed");
        assert_eq!(by_id["b"].state, "blocked");
        assert_eq!(by_id["c"].state, "blocked", "Block 传递阻塞");
        assert!(by_id["b"].subagent_run_id.is_none(), "阻塞节点不会被 spawn");
    }

    /// 失败策略放宽：flow_on_failed = skip → 前置 failed 不阻塞后置（保持 pending）
    #[test]
    fn flow_snapshot_skip_strategy_does_not_block() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        write_declaration(
            &db,
            vec![
                FlowNode {
                    id: "a".into(),
                    task: "任务 A".into(),
                    depends_on: vec![],
                    parallel: true,
                    on_failed: None,
                    is_composite: false,
                },
                FlowNode {
                    id: "b".into(),
                    task: "任务 B".into(),
                    depends_on: vec!["a".into()],
                    parallel: false,
                    on_failed: None,
                    is_composite: false,
                },
            ],
        );
        write_flow_state(
            &db,
            vec![FlowNodeRuntime {
                node_id: "a".into(),
                subagent_run_id: Some("run-a".into()),
                subagent_id: Some("a-run-a".into()),
                subagent_session_id: None,
                wakeup_sent: false,
            }],
        );
        db.save_session_agents("s1", &[sample_agent("run-a", "failed")])
            .unwrap();
        db.set_session_meta(FLOW_ON_FAILED_KEY, "skip").unwrap();

        let (decl, state, on_failed, agents) = read_raw_flow(&db);
        let snap = build_flow_snapshot(decl, state, on_failed, &agents).unwrap();
        let by_id: HashMap<&str, &FlowSnapshotNode> = snap
            .nodes
            .iter()
            .map(|n| (n.id.as_str(), n))
            .collect();
        assert_eq!(by_id["a"].state, "failed");
        assert_eq!(by_id["b"].state, "pending", "Skip 策略：失败视为满足，不阻塞");
    }

    /// 节点级策略覆盖：失败节点的节点级 on_failed 放宽（Report）→ 其依赖者
    /// 不被阻塞（生效策略取**失败节点**的覆盖 ?? 会话级默认，对齐 effective_strategy）
    #[test]
    fn flow_snapshot_node_level_strategy_override() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        write_declaration(
            &db,
            vec![
                FlowNode {
                    id: "a".into(),
                    task: "任务 A".into(),
                    depends_on: vec![],
                    parallel: true,
                    on_failed: Some(FailStrategy::Report),
                    is_composite: false,
                },
                FlowNode {
                    id: "b".into(),
                    task: "任务 B".into(),
                    depends_on: vec!["a".into()],
                    parallel: false,
                    on_failed: None,
                    is_composite: false,
                },
                FlowNode {
                    id: "d".into(),
                    task: "任务 D".into(),
                    depends_on: vec![],
                    parallel: true,
                    on_failed: None,
                    is_composite: false,
                },
                FlowNode {
                    id: "c".into(),
                    task: "任务 C".into(),
                    depends_on: vec!["d".into()],
                    parallel: false,
                    on_failed: None,
                    is_composite: false,
                },
            ],
        );
        write_flow_state(
            &db,
            vec![
                FlowNodeRuntime {
                    node_id: "a".into(),
                    subagent_run_id: Some("run-a".into()),
                    subagent_id: Some("a-run-a".into()),
                    subagent_session_id: None,
                    wakeup_sent: false,
                },
                FlowNodeRuntime {
                    node_id: "d".into(),
                    subagent_run_id: Some("run-d".into()),
                    subagent_id: Some("a-run-d".into()),
                    subagent_session_id: None,
                    wakeup_sent: false,
                },
            ],
        );
        db.save_session_agents(
            "s1",
            &[sample_agent("run-a", "failed"), sample_agent("run-d", "failed")],
        )
        .unwrap();

        let (decl, state, on_failed, agents) = read_raw_flow(&db);
        let snap = build_flow_snapshot(decl, state, on_failed, &agents).unwrap();
        let by_id: HashMap<&str, &FlowSnapshotNode> = snap
            .nodes
            .iter()
            .map(|n| (n.id.as_str(), n))
            .collect();
        assert_eq!(by_id["a"].state, "failed");
        assert_eq!(by_id["b"].state, "pending", "失败节点 a 的 Report 覆盖会话级 Block");
        assert_eq!(by_id["d"].state, "failed");
        assert_eq!(by_id["c"].state, "blocked", "失败节点 d 未覆盖 → 按会话级 Block 阻塞");
    }

    /// 损坏 JSON 显式报错（与 FlowScheduler::load 的解析失败语义一致）
    #[test]
    fn flow_snapshot_parse_failure_errors() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        db.set_session_meta(FLOW_DECLARATION_KEY, "{corrupt").unwrap();
        let (decl, state, on_failed, agents) = read_raw_flow(&db);
        let err = build_flow_snapshot(decl, state, on_failed, &agents).expect_err("损坏 JSON 应报错");
        match err {
            CoreError::Internal(msg) => assert!(msg.contains("flow_declaration 解析失败")),
            other => panic!("expected Internal, got {other:?}"),
        }
    }

    /// 序列化形状：冻结载荷形状逐键断言（camelCase；subagentRunId 缺省省略；
    /// dependsOn 恒输出数组）
    #[test]
    fn flow_snapshot_serializes_frozen_camel_case_shape() {
        let snap = FlowSnapshot {
            nodes: vec![
                FlowSnapshotNode {
                    id: "t1".into(),
                    task: "分析".into(),
                    depends_on: vec![],
                    parallel: true,
                    is_composite: false,
                    state: "completed".into(),
                    subagent_run_id: Some("run-1".into()),
                },
                FlowSnapshotNode {
                    id: "t3".into(),
                    task: "评审".into(),
                    depends_on: vec!["t1".into(), "t2".into()],
                    parallel: false,
                    is_composite: true,
                    state: "pending".into(),
                    subagent_run_id: None,
                },
            ],
        };
        let json = serde_json::to_value(&snap).unwrap();
        assert!(json.get("nodes").is_some(), "根键 nodes（冻结形状）");
        let n0 = &json["nodes"][0];
        assert_eq!(n0["id"], "t1");
        assert_eq!(n0["task"], "分析");
        assert_eq!(n0["dependsOn"], serde_json::json!([]), "空依赖恒输出数组");
        assert_eq!(n0["parallel"], true);
        assert_eq!(n0["isComposite"], false);
        assert_eq!(n0["state"], "completed");
        assert_eq!(n0["subagentRunId"], "run-1");
        let n1 = &json["nodes"][1];
        assert_eq!(n1["dependsOn"], serde_json::json!(["t1", "t2"]));
        assert!(n1.get("subagentRunId").is_none(), "未启动节点省略 subagentRunId");
        // 不得出现 snake_case 键
        assert!(n0.get("depends_on").is_none());
        assert!(n0.get("is_composite").is_none());
        assert!(n0.get("subagent_run_id").is_none());
    }
}
