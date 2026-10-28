//! Cron 调度存储适配器（内存与 LocalDb session_meta 持久化；T-CF-09 / T-CF-12）

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use conex_db::LocalDb;

use super::types::{
    CronTask, CronTaskStatus, LEGACY_SESSION_META_SCHED_INDEX_KEY, SESSION_META_SCHED_INDEX_KEY,
    SESSION_META_SCHED_KEY_PREFIX,
};

/// session_meta 持久化适配（conex-db `sched_*` 键读写）
pub trait SchedStore: Send + Sync {
    /// 读取全部声明（重启恢复扫描用）
    fn load_all(&self) -> Vec<CronTask>;
    /// 保存声明（安全合并，保留非调度业务字段）
    fn save(&self, task: &CronTask);
    /// 删除声明
    #[cfg_attr(not(test), allow(dead_code))]
    fn remove(&self, cron_id: &str);
    /// 追加运行记录（到期触发时记录）
    fn append_run(&self, _record: &crate::workflow::WorkflowRunRecord) {}
    /// 标记单条运行记录终态（完成 / 失败 / 取消）
    #[allow(clippy::too_many_arguments)]
    fn finish_run(
        &self,
        _workflow_id: &str,
        _run_id: &str,
        _status: &str,
        _finished_at_ms: u64,
        _duration_ms: u64,
        _error: Option<String>,
        _output_summary: Option<String>,
    ) {
    }
    /// 读取任务扩展元数据：(cwd, target_session_id)
    fn load_task_ext_meta(&self, _cron_id: &str) -> (Option<String>, Option<String>) {
        (None, None)
    }
    /// 检查目标会话是否存在（INT-04 僵尸会话自愈校验用）
    fn session_exists(&self, _session_id: &str) -> bool {
        true
    }
    /// 清除失效的目标会话绑定（INT-04 自愈降级回写用）
    fn clear_target_session_id(&self, _cron_id: &str) {}
}

/// 持久化键（`sched_` 前缀 + cron id）
pub fn store_key(cron_id: &str) -> String {
    format!("{SESSION_META_SCHED_KEY_PREFIX}{cron_id}")
}

pub fn extract_ext_meta_from_json(raw: &str) -> (Option<String>, Option<String>) {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(raw) else {
        return (None, None);
    };
    let cwd = val
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let target_sid = val
        .get("targetSessionId")
        .or_else(|| val.get("target_session_id"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    (cwd, target_sid)
}

/// 安全字段合并：保留所有非调度业务字段（name, schedule, cwd, targetSessionId 等），
/// 仅覆盖更新调度运行态字段，彻底消灭双写抹杀。
pub fn safe_merge_task_json(existing_json: Option<&str>, task: &CronTask) -> Option<String> {
    let mut map: serde_json::Map<String, serde_json::Value> = match existing_json {
        Some(raw) => serde_json::from_str(raw).unwrap_or_default(),
        None => serde_json::Map::new(),
    };

    map.insert("cronId".to_string(), serde_json::json!(task.cron_id));
    map.insert("expression".to_string(), serde_json::json!(task.expression));
    map.insert("prompt".to_string(), serde_json::json!(task.prompt));
    map.insert(
        "maxIterations".to_string(),
        serde_json::json!(task.max_iterations),
    );
    map.insert("isDaemon".to_string(), serde_json::json!(task.is_daemon));
    map.insert(
        "nextFireAtMs".to_string(),
        serde_json::json!(task.next_fire_at_ms),
    );
    map.insert(
        "firedCount".to_string(),
        serde_json::json!(task.fired_count),
    );
    map.insert("status".to_string(), serde_json::json!(task.status));
    map.insert("enabled".to_string(), serde_json::json!(task.enabled));

    if let Some(ref target_sid) = task.target_session_id {
        map.insert("targetSessionId".to_string(), serde_json::json!(target_sid));
    }
    if !map.contains_key("createdAtMs") {
        map.insert(
            "createdAtMs".to_string(),
            serde_json::json!(task.created_at_ms),
        );
    }
    map.insert(
        "updatedAtMs".to_string(),
        serde_json::json!(task.updated_at_ms),
    );

    serde_json::to_string(&map).ok()
}

/// 内存持久化适配（测试 + 引擎默认装配）
#[derive(Default)]
pub struct MemorySchedStore {
    /// sched_<cron_id> → CronTask JSON
    map: Mutex<HashMap<String, String>>,
    /// 运行历史记录（供调度器测试断言 running → completed/failed 流转）
    runs: Mutex<Vec<crate::workflow::WorkflowRunRecord>>,
    /// 测试用已知有效会话集合（None = 默认全部存在；Some = 仅集合内会话存在，供 INT-04 测试）
    existing_sessions: Mutex<Option<std::collections::HashSet<String>>>,
}

impl MemorySchedStore {
    /// 共享实例（重启恢复测试中两个注册表共用同一存储）
    pub fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 读取内存中记录的运行历史（测试断言用）
    #[cfg(test)]
    pub fn load_runs(&self) -> Vec<crate::workflow::WorkflowRunRecord> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 设置测试环境中存在的会话列表（供 INT-04 僵尸会话自愈测试使用）
    #[cfg(test)]
    pub fn set_existing_sessions(&self, sessions: Vec<String>) {
        *self
            .existing_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(sessions.into_iter().collect());
    }
}

impl SchedStore for MemorySchedStore {
    fn load_all(&self) -> Vec<CronTask> {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter_map(|json| {
                let mut t: CronTask = serde_json::from_str(json).ok()?;
                // 存量数据校准：如果历史只有 enabled: false 且 status 未存，校准为 Cancelled
                if !t.enabled && t.status == CronTaskStatus::Active {
                    t.status = CronTaskStatus::Cancelled;
                }
                Some(t)
            })
            .collect()
    }

    fn save(&self, task: &CronTask) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let key = store_key(&task.cron_id);
        let existing = map.get(&key).map(|s| s.as_str());
        if let Some(merged_json) = safe_merge_task_json(existing, task) {
            map.insert(key, merged_json);
        } else if let Ok(json) = serde_json::to_string(task) {
            map.insert(key, json);
        }
    }

    fn remove(&self, cron_id: &str) {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&store_key(cron_id));
    }

    fn append_run(&self, record: &crate::workflow::WorkflowRunRecord) {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pos) = runs
            .iter()
            .position(|r| r.workflow_id == record.workflow_id && r.run_id == record.run_id)
        {
            runs[pos] = record.clone();
        } else {
            runs.push(record.clone());
        }
    }

    fn finish_run(
        &self,
        workflow_id: &str,
        run_id: &str,
        status: &str,
        finished_at_ms: u64,
        duration_ms: u64,
        error: Option<String>,
        output_summary: Option<String>,
    ) {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(run) = runs
            .iter_mut()
            .find(|r| r.workflow_id == workflow_id && r.run_id == run_id)
        {
            run.status = status.to_string();
            run.finished_at_ms = Some(finished_at_ms);
            run.duration_ms = Some(duration_ms);
            run.error = error;
            run.output_summary = output_summary;
        } else {
            let started_at_ms = finished_at_ms.saturating_sub(duration_ms);
            runs.push(crate::workflow::WorkflowRunRecord {
                workflow_id: workflow_id.to_string(),
                run_id: run_id.to_string(),
                session_id: None,
                trigger_kind: "cron".to_string(),
                scheduled_for_ms: started_at_ms,
                started_at_ms,
                finished_at_ms: Some(finished_at_ms),
                duration_ms: Some(duration_ms),
                status: status.to_string(),
                prompt: String::new(),
                error,
                output_summary,
            });
        }
    }

    fn load_task_ext_meta(&self, cron_id: &str) -> (Option<String>, Option<String>) {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&store_key(cron_id))
            .map(|raw| extract_ext_meta_from_json(raw))
            .unwrap_or((None, None))
    }

    fn session_exists(&self, session_id: &str) -> bool {
        match self
            .existing_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            Some(set) => set.contains(session_id),
            None => true,
        }
    }

    fn clear_target_session_id(&self, cron_id: &str) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let key = store_key(cron_id);
        if let Some(raw) = map.get(&key) {
            if let Ok(mut obj) =
                serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(raw)
            {
                obj.remove("targetSessionId");
                obj.remove("target_session_id");
                if let Ok(updated) = serde_json::to_string(&obj) {
                    map.insert(key, updated);
                }
            }
        }
    }
}

/// LocalDb session_meta 真适配（键 `sched_<cron_id>` + 统一索引 `sched_index`）。
#[derive(Clone)]
pub struct LocalDbSchedStore {
    db: LocalDb,
}

impl LocalDbSchedStore {
    /// 新建真适配（db 由装配点提供）
    pub fn new(db: LocalDb) -> Self {
        Self { db }
    }
}

impl SchedStore for LocalDbSchedStore {
    fn load_all(&self) -> Vec<CronTask> {
        // 读取 sched_index 索引
        let mut index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_SCHED_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();

        // 兼容合并存量 sched_ids 中的 ID
        let legacy_index: Vec<String> = self
            .db
            .get_session_meta(LEGACY_SESSION_META_SCHED_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();

        let mut changed = false;
        for id in legacy_index {
            if !index.contains(&id) {
                index.push(id);
                changed = true;
            }
        }
        if changed {
            if let Ok(json) = serde_json::to_string(&index) {
                let _ = self
                    .db
                    .set_session_meta(SESSION_META_SCHED_INDEX_KEY, &json);
            }
        }

        index
            .into_iter()
            .filter_map(|cron_id| {
                self.db
                    .get_session_meta(&store_key(&cron_id))
                    .ok()
                    .flatten()
                    .and_then(|json| {
                        let mut t: CronTask = serde_json::from_str(&json).ok()?;
                        if !t.enabled && t.status == CronTaskStatus::Active {
                            t.status = CronTaskStatus::Cancelled;
                        }
                        Some(t)
                    })
            })
            .collect()
    }

    fn save(&self, task: &CronTask) {
        // 落实 Safe Field Merge：在 save 时使用 LocalDb::update_session_meta 保留非调度业务字段
        let task_clone = task.clone();
        let _ = self
            .db
            .update_session_meta(&store_key(&task.cron_id), move |curr| {
                safe_merge_task_json(curr, &task_clone)
            });

        // 索引幂等原子追加
        let cron_id = task.cron_id.clone();
        let _ = self
            .db
            .update_session_meta(SESSION_META_SCHED_INDEX_KEY, move |curr| {
                let mut index: Vec<String> = curr
                    .and_then(|raw| serde_json::from_str(raw).ok())
                    .unwrap_or_default();
                if !index.contains(&cron_id) {
                    index.push(cron_id);
                }
                serde_json::to_string(&index).ok()
            });
    }

    fn remove(&self, cron_id: &str) {
        let key = store_key(cron_id);
        let _ = self.db.write_blocking(move |conn| {
            let _ = conn.execute(
                "DELETE FROM session_meta WHERE key = ?1",
                rusqlite::params![key],
            );
            Ok(())
        });

        let cron_id_str = cron_id.to_string();
        let _ = self
            .db
            .update_session_meta(SESSION_META_SCHED_INDEX_KEY, move |curr| {
                let mut index: Vec<String> = curr
                    .and_then(|raw| serde_json::from_str(raw).ok())
                    .unwrap_or_default();
                index.retain(|id| id != &cron_id_str);
                serde_json::to_string(&index).ok()
            });
    }

    fn append_run(&self, record: &crate::workflow::WorkflowRunRecord) {
        use crate::workflow::WorkflowStore;
        let store = crate::workflow::SessionMetaWorkflowStore::new(self.db.clone());
        store.append_or_update_run(record.clone());
    }

    fn finish_run(
        &self,
        workflow_id: &str,
        run_id: &str,
        status: &str,
        finished_at_ms: u64,
        duration_ms: u64,
        error: Option<String>,
        output_summary: Option<String>,
    ) {
        use crate::workflow::WorkflowStore;
        let store = crate::workflow::SessionMetaWorkflowStore::new(self.db.clone());
        store.update_run_finish(
            workflow_id,
            run_id,
            status,
            finished_at_ms,
            duration_ms,
            error,
            output_summary,
        );
    }

    fn load_task_ext_meta(&self, cron_id: &str) -> (Option<String>, Option<String>) {
        self.db
            .get_session_meta(&store_key(cron_id))
            .ok()
            .flatten()
            .map(|raw| extract_ext_meta_from_json(&raw))
            .unwrap_or((None, None))
    }

    fn session_exists(&self, session_id: &str) -> bool {
        self.db
            .list_sessions()
            .map(|list| list.iter().any(|s| s.id == session_id))
            .unwrap_or(false)
    }

    fn clear_target_session_id(&self, cron_id: &str) {
        let _ = self.db.update_session_meta(&store_key(cron_id), |curr| {
            let mut obj: serde_json::Map<String, serde_json::Value> = curr
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or_default();
            obj.remove("targetSessionId");
            obj.remove("target_session_id");
            serde_json::to_string(&obj).ok()
        });
    }
}
