//! WorkflowStore 契约 + session_meta / 内存两实现（`sched_*` 键）。

use std::sync::Mutex;

use conex_db::LocalDb;

use crate::workflow::model::{prune_runs, StoredWorkflow, WorkflowRunRecord};
use crate::workflow::schedule::{validate_cron_expression, WorkflowScheduleWire};

/// 索引键（cronId 列表；conex-db 暂无 session_meta 键扫描 API，
/// 命令面自持索引保证 sched_<cronId> 可枚举；A5 若扩展列表 API 可切换）
const SESSION_META_INDEX_KEY: &str = "sched_index";
/// 运行历史键（`sched_runs`，命令层近似真源；事件面接线后替换）
const SESSION_META_RUNS_KEY: &str = "sched_runs";

/// 测试面：索引键（workflow::tests 断言自愈回写用）
#[cfg(test)]
pub(crate) const SESSION_META_INDEX_KEY_FOR_TEST: &str = SESSION_META_INDEX_KEY;

// ── 存储适配（sched_* 键读写；重启恢复数据源）───────────────────────

/// workflow 持久化适配（conex-db session_meta `sched_*` 键）
pub trait WorkflowStore: Send + Sync {
    /// 读取全部 workflow 声明
    fn load_all(&self) -> Vec<StoredWorkflow>;
    /// 保存声明（幂等 upsert；cronId 冲突即覆盖）
    fn save(&self, workflow: &StoredWorkflow);
    /// 删除声明（不存在静默成功）
    fn remove(&self, cron_id: &str);
    /// 读取运行历史
    fn load_runs(&self) -> Vec<WorkflowRunRecord>;
    /// 保存运行历史（全量覆盖；当前条目量小，全量读写足够）
    fn save_runs(&self, runs: &[WorkflowRunRecord]);

    /// 追加或更新单条运行记录（自动滚动淘汰）
    fn append_or_update_run(&self, record: WorkflowRunRecord) {
        let mut runs = self.load_runs();
        if let Some(pos) = runs
            .iter()
            .position(|r| r.workflow_id == record.workflow_id && r.run_id == record.run_id)
        {
            runs[pos] = record;
        } else {
            runs.push(record);
        }
        let pruned = prune_runs(runs);
        self.save_runs(&pruned);
    }

    /// 标记单条运行记录完成/终态（Upsert 语义：未找到已有记录时原地创建终态记录，杜绝静默丢失）
    #[allow(clippy::too_many_arguments)]
    fn update_run_finish(
        &self,
        workflow_id: &str,
        run_id: &str,
        status: &str,
        finished_at_ms: u64,
        duration_ms: u64,
        error: Option<String>,
        output_summary: Option<String>,
    ) {
        let mut runs = self.load_runs();
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
            runs.push(WorkflowRunRecord {
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
        let pruned = prune_runs(runs);
        self.save_runs(&pruned);
    }

    /// 孤儿运行收割：扫描所有运行记录，将处于在途态的孤儿记录自动收割为 interrupted 并持久化
    fn reap_orphan_running_runs(&self) -> usize {
        let mut runs = self.load_runs();
        let mut reaped_count = 0;
        for run in &mut runs {
            if matches!(
                run.status.as_str(),
                "running" | "queued" | "pending" | "in_progress" | "accepted" | "started"
            ) {
                run.status = "interrupted".to_string();
                run.duration_ms = None;
                run.error = Some("应用重启或异常终止，历史在途记录已被系统自愈收割".to_string());
                reaped_count += 1;
            }
        }
        if reaped_count > 0 {
            let pruned = prune_runs(runs);
            self.save_runs(&pruned);
        }
        reaped_count
    }

    /// 检查指定目标会话是否存在（INT-04 僵尸会话自愈校验用；默认 true 兼容无会话表纯内存测试）
    fn session_exists(&self, _session_id: &str) -> bool {
        true
    }
}

/// session_meta 真适配（LocalDb `sched_<cronId>` 键 + `sched_index` 索引 +
/// `sched_runs` 键）。
///
/// 注：conex-db 当前仅有 get/set_session_meta（无键扫描 / 删除 API），
/// 故以 `sched_index` 索引键承载可枚举性；删除仅摘索引（孤儿键残留在
/// 表内但不可见）。A5 若为 SchedulerRegistry 扩展 conex-db 键扫描 API，
/// 本适配可切换为原生扫描（键形状 sched_<cronId> 已冻结）。
#[derive(Clone)]
pub struct SessionMetaWorkflowStore {
    db: LocalDb,
}

impl SessionMetaWorkflowStore {
    pub fn new(db: LocalDb) -> Self {
        Self { db }
    }
}

/// 对读取到的 StoredWorkflow 执行启发式自愈（Heuristic Rehydration）：
/// 若 schedule 为 Manual 但 expression 为有效 5 字段 cron，自愈为 WorkflowScheduleWire::Cron 并返回 true 表示发生自愈
fn heuristic_rehydrate_workflow(wf: &mut StoredWorkflow) -> bool {
    if wf.schedule == WorkflowScheduleWire::Manual && !wf.expression.trim().is_empty() {
        if let Ok(normalized) = validate_cron_expression(&wf.expression) {
            tracing::info!(
                target: "workflow",
                cron_id = %wf.cron_id,
                expression = %normalized,
                "历史任务调度配置启发式自愈：Manual -> Cron"
            );
            wf.schedule = WorkflowScheduleWire::Cron {
                expression: normalized,
            };
            return true;
        }
    }
    false
}

impl WorkflowStore for SessionMetaWorkflowStore {
    fn load_all(&self) -> Vec<StoredWorkflow> {
        let mut index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();

        // 统一索引真源：兼容合并存量历史索引数据（sched_ids）
        if let Some(legacy_raw) = self.db.get_session_meta("sched_ids").ok().flatten() {
            if let Ok(legacy_ids) = serde_json::from_str::<Vec<String>>(&legacy_raw) {
                let mut appended = false;
                for id in legacy_ids {
                    if !index.contains(&id) {
                        index.push(id);
                        appended = true;
                    }
                }
                if appended {
                    if let Ok(json) = serde_json::to_string(&index) {
                        let _ = self.db.set_session_meta(SESSION_META_INDEX_KEY, &json);
                    }
                }
            }
        }

        let mut results = Vec::new();
        for cron_id in index {
            if let Some(raw) = self
                .db
                .get_session_meta(&store_key(&cron_id))
                .ok()
                .flatten()
            {
                if let Ok(mut wf) = serde_json::from_str::<StoredWorkflow>(&raw) {
                    if heuristic_rehydrate_workflow(&mut wf) {
                        // 自愈后立即持久化回写，杜绝未来降级丢失
                        self.save(&wf);
                    }
                    results.push(wf);
                }
            }
        }
        results
    }

    fn save(&self, workflow: &StoredWorkflow) {
        let key = store_key(&workflow.cron_id);
        // Safe Field Merge: 读取已有 session_meta JSON 进行安全增量合并，
        // 保证调度字段与扩展业务字段双向互不冲刷覆盖
        let mut base_val = self
            .db
            .get_session_meta(&key)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .unwrap_or_else(|| serde_json::json!({}));

        if let Ok(new_val) = serde_json::to_value(workflow) {
            if let (Some(base_map), Some(new_map)) = (base_val.as_object_mut(), new_val.as_object())
            {
                for (k, v) in new_map {
                    base_map.insert(k.clone(), v.clone());
                }
            } else {
                base_val = new_val;
            }
            if let Ok(merged_json) = serde_json::to_string(&base_val) {
                let _ = self.db.set_session_meta(&key, &merged_json);
            }
        }

        // 索引追加到唯一真源 sched_index（已存在则不动，保持创建顺序稳定）
        let mut index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        if !index.iter().any(|id| id == &workflow.cron_id) {
            index.push(workflow.cron_id.clone());
            if let Ok(json) = serde_json::to_string(&index) {
                let _ = self.db.set_session_meta(SESSION_META_INDEX_KEY, &json);
            }
        }
    }

    fn remove(&self, cron_id: &str) {
        // 摘索引（键值残留在表内，不可见；见结构体注记）
        if let Some(json) = self
            .db
            .get_session_meta(SESSION_META_INDEX_KEY)
            .ok()
            .flatten()
        {
            if let Ok(mut index) = serde_json::from_str::<Vec<String>>(&json) {
                index.retain(|id| id != cron_id);
                if let Ok(out) = serde_json::to_string(&index) {
                    let _ = self.db.set_session_meta(SESSION_META_INDEX_KEY, &out);
                }
            }
        }
    }

    fn load_runs(&self) -> Vec<WorkflowRunRecord> {
        self.db
            .get_session_meta(SESSION_META_RUNS_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    fn save_runs(&self, runs: &[WorkflowRunRecord]) {
        if let Ok(json) = serde_json::to_string(runs) {
            let _ = self.db.set_session_meta(SESSION_META_RUNS_KEY, &json);
        }
    }

    fn session_exists(&self, session_id: &str) -> bool {
        self.db
            .list_sessions()
            .map(|list| list.iter().any(|s| s.id == session_id))
            .unwrap_or(false)
    }
}

/// 内存适配（测试专用；生产走 SessionMetaWorkflowStore）
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Default)]
pub struct MemoryWorkflowStore {
    map: Mutex<Vec<(String, StoredWorkflow)>>,
    runs: Mutex<Vec<WorkflowRunRecord>>,
    existing_sessions: Mutex<Option<std::collections::HashSet<String>>>,
}

impl MemoryWorkflowStore {
    /// 设置测试环境中存在的会话列表（供 INT-04 僵尸会话自愈测试使用）
    #[cfg(test)]
    pub fn set_existing_sessions(&self, sessions: Vec<String>) {
        *self
            .existing_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(sessions.into_iter().collect());
    }
}

impl WorkflowStore for MemoryWorkflowStore {
    fn load_all(&self) -> Vec<StoredWorkflow> {
        let mut list: Vec<StoredWorkflow> = self
            .map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(_, w)| w.clone())
            .collect();
        let mut rehydrated = Vec::new();
        for wf in &mut list {
            if heuristic_rehydrate_workflow(wf) {
                rehydrated.push(wf.clone());
            }
        }
        if !rehydrated.is_empty() {
            let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
            for h in rehydrated {
                if let Some((_, slot)) = map.iter_mut().find(|(id, _)| id == &h.cron_id) {
                    *slot = h;
                }
            }
        }
        list
    }

    fn save(&self, workflow: &StoredWorkflow) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        match map.iter_mut().find(|(id, _)| id == &workflow.cron_id) {
            Some((_, slot)) => {
                // 内存版 Safe Field Merge：以 JSON Value 合并模拟无损覆盖
                if let (Ok(old_val), Ok(new_val)) =
                    (serde_json::to_value(&*slot), serde_json::to_value(workflow))
                {
                    if let (Some(mut base_map), Some(new_map)) =
                        (old_val.as_object().cloned(), new_val.as_object())
                    {
                        for (k, v) in new_map {
                            base_map.insert(k.clone(), v.clone());
                        }
                        if let Ok(merged) = serde_json::from_value::<StoredWorkflow>(
                            serde_json::Value::Object(base_map),
                        ) {
                            *slot = merged;
                            return;
                        }
                    }
                }
                *slot = workflow.clone();
            }
            None => map.push((workflow.cron_id.clone(), workflow.clone())),
        }
    }

    fn remove(&self, cron_id: &str) {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(id, _)| id != cron_id);
    }

    fn load_runs(&self) -> Vec<WorkflowRunRecord> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn save_runs(&self, runs: &[WorkflowRunRecord]) {
        *self.runs.lock().unwrap_or_else(|e| e.into_inner()) = runs.to_vec();
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
}

/// 持久化键（`sched_` 前缀 + cronId）
fn store_key(cron_id: &str) -> String {
    format!("sched_{cron_id}")
}
