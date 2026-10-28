//! 协作子代理单行定点写与生命周期状态操作（11-T3 单行定点写收束）。
//!
//! 引擎侧并发写一律走单行 API：
//! - [LocalDb::upsert_session_agent]（spawn 落库，ON CONFLICT DO UPDATE 防级联清 messages）
//! - [LocalDb::update_session_agent_status]（kill_all / resume / 启动失败兜底）
//! - [LocalDb::update_session_agent_path]（恢复域路径写面）

use super::{DbFailure, DbFailureKind, LocalDb};
use conex_types::SessionAgent;

impl LocalDb {
    /// 单行更新 status / ended_at（kill_all 用）。只动目标行，不碰 messages。
    ///
    /// 缺行静默成功（返回受影响行数 0，不报错——与 save 面宽容语义一致）；
    /// 返回 1 = 目标行已更新。调用方按返回值自行判定 NotFound。
    ///
    /// ended_at 语义：仅当原值为 NULL 才写入（SQL:
    /// `ended_at = COALESCE(ended_at, ?4)`），保持「已结束行不覆盖」语义
    /// （对齐 lifecycle.rs 既有 is_none 判定）。
    pub fn update_session_agent_status(
        &self,
        session_id: &str,
        subagent_run_id: &str,
        status: &str,
        ended_at: Option<i64>,
    ) -> Result<usize, DbFailure> {
        let session_id = session_id.to_string();
        let subagent_run_id = subagent_run_id.to_string();
        let status = status.to_string();
        self.write_blocking(move |conn| {
            conn.execute(
                "UPDATE session_agents
                 SET status = ?3, ended_at = COALESCE(ended_at, ?4)
                 WHERE session_id = ?1 AND subagent_run_id = ?2",
                rusqlite::params![session_id, subagent_run_id, status, ended_at],
            )
            .map_err(|e| DbFailure {
                message: format!("update_session_agent_status: {e}"),
                kind: DbFailureKind::Other("update_session_agent_status".to_string()),
            })
        })
    }

    /// 单行更新 subagent_path_json（set_subagent_path 用）。
    ///
    /// 缺行静默成功（返回受影响行数 0）；返回 1 = 目标行已更新。
    /// 调用方（recovery）自行按返回值判定 NotFound。
    pub fn update_session_agent_path(
        &self,
        session_id: &str,
        subagent_run_id: &str,
        path_json: &str,
    ) -> Result<usize, DbFailure> {
        let session_id = session_id.to_string();
        let subagent_run_id = subagent_run_id.to_string();
        let path_json = path_json.to_string();
        self.write_blocking(move |conn| {
            conn.execute(
                "UPDATE session_agents
                 SET subagent_path_json = ?3
                 WHERE session_id = ?1 AND subagent_run_id = ?2",
                rusqlite::params![session_id, subagent_run_id, path_json],
            )
            .map_err(|e| DbFailure {
                message: format!("update_session_agent_path: {e}"),
                kind: DbFailureKind::Other("update_session_agent_path".to_string()),
            })
        })
    }

    /// 加载全部 status='running' 的子代理行（P3 启动对账用；不含消息）。
    ///
    /// 与 [LocalDb::load_running_session_agents] 的差异：返回完整行，供
    /// 对账时读取父会话 / agent_id / 子会话 id / 模型能力快照；消息面
    /// 不加载（对账只需元数据，避免冷启动 N+1 查询）。
    pub fn load_running_session_agent_rows(&self) -> Result<Vec<SessionAgent>, DbFailure> {
        self.read(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT agent_id, subagent_run_id, parent_session_id, parent_run_id,
                            parent_tool_call_id, description, mode, status, summary,
                            started_at, ended_at, depth, subagent_path_json,
                            task_type, display_label, allowed_write_paths_json,
                            sub_session_id, capability_mode, model_override,
                            resumable, last_heartbeat_ms
                     FROM session_agents
                     WHERE status = 'running'
                     ORDER BY started_at ASC, agent_id ASC",
                )
                .map_err(|e| self.latch_error("load_running_agent_rows_prepare", e))?;
            let rows = stmt
                .query_map([], super::agents::map_agent_row)
                .map_err(|e| self.latch_error("load_running_agent_rows_map", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| self.latch_error("load_running_agent_rows_collect", e))?;
            Ok(rows)
        })
    }

    /// 心跳落库（P3）：仅刷新 running 行的 last_heartbeat_ms。
    ///
    /// 条件写（`last_heartbeat_ms <= now - min_interval_ms`）在 SQL 内完成，
    /// 调用方无需在内存记账；重复 tick 不产生无意义写入。返回 1 = 已刷新。
    pub fn touch_session_agent_heartbeat(
        &self,
        session_id: &str,
        subagent_run_id: &str,
        now_ms: i64,
        min_interval_ms: u64,
    ) -> Result<usize, DbFailure> {
        let session_id = session_id.to_string();
        let subagent_run_id = subagent_run_id.to_string();
        let min_interval_ms = min_interval_ms.min(i64::MAX as u64) as i64;
        self.write_blocking(move |conn| {
            conn.execute(
                "UPDATE session_agents
                 SET last_heartbeat_ms = ?3
                 WHERE session_id = ?1 AND subagent_run_id = ?2
                   AND status = 'running'
                   AND (last_heartbeat_ms IS NULL
                        OR last_heartbeat_ms <= ?3 - ?4)",
                rusqlite::params![session_id, subagent_run_id, now_ms, min_interval_ms],
            )
            .map_err(|e| DbFailure {
                message: format!("touch_session_agent_heartbeat: {e}"),
                kind: DbFailureKind::Other("touch_session_agent_heartbeat".to_string()),
            })
        })
    }

    /// 启动对账：把残留 running 行标记为中断可恢复（P3）。
    ///
    /// `status` 只能落 DB CHECK 集内的终态字面量（failed/stopped）；
    /// `resumable=1` 供主 agent/前端识别可恢复；summary 仅在原值为
    /// NULL 时写入（保留子代理已有总结）。返回受影响行数（0 = 行已
    /// 终态/消失，对账幂等）。
    pub fn mark_session_agent_interrupted(
        &self,
        session_id: &str,
        subagent_run_id: &str,
        ended_at: i64,
        summary: &str,
    ) -> Result<usize, DbFailure> {
        let session_id = session_id.to_string();
        let subagent_run_id = subagent_run_id.to_string();
        let summary = summary.to_string();
        self.write_blocking(move |conn| {
            conn.execute(
                "UPDATE session_agents
                 SET status = 'failed',
                     ended_at = COALESCE(ended_at, ?3),
                     resumable = 1,
                     last_heartbeat_ms = COALESCE(last_heartbeat_ms, ?3),
                     summary = COALESCE(summary, ?4)
                 WHERE session_id = ?1 AND subagent_run_id = ?2
                   AND status = 'running'",
                rusqlite::params![session_id, subagent_run_id, ended_at, summary],
            )
            .map_err(|e| DbFailure {
                message: format!("mark_session_agent_interrupted: {e}"),
                kind: DbFailureKind::Other("mark_session_agent_interrupted".to_string()),
            })
        })
    }

    /// 按 agent_id / run_id 更新模型覆盖（P2/P3：主 agent 对运行中或
    /// 已终态子代理设定模型，跨重启保留）。
    ///
    /// 作用域限定父会话（session_id），避免跨会话同名 agent 误改；返回
    /// 受影响行数（0 = 目标不存在）。
    pub fn update_session_agent_model(
        &self,
        session_id: &str,
        agent_or_run: &str,
        model: Option<&str>,
    ) -> Result<usize, DbFailure> {
        let session_id = session_id.to_string();
        let agent_or_run = agent_or_run.to_string();
        let model = model.map(str::to_string);
        self.write_blocking(move |conn| {
            conn.execute(
                "UPDATE session_agents
                 SET model_override = ?3
                 WHERE session_id = ?1
                   AND (agent_id = ?2 OR subagent_run_id = ?2)",
                rusqlite::params![session_id, agent_or_run, model],
            )
            .map_err(|e| DbFailure {
                message: format!("update_session_agent_model: {e}"),
                kind: DbFailureKind::Other("update_session_agent_model".to_string()),
            })
        })
    }

    /// 按 agent_id / run_id 更新能力档快照（P3：授权结果跨重启保留）。
    pub fn update_session_agent_capability(
        &self,
        session_id: &str,
        agent_or_run: &str,
        capability: &str,
    ) -> Result<usize, DbFailure> {
        let session_id = session_id.to_string();
        let agent_or_run = agent_or_run.to_string();
        let capability = capability.to_string();
        self.write_blocking(move |conn| {
            conn.execute(
                "UPDATE session_agents
                 SET capability_mode = ?3
                 WHERE session_id = ?1
                   AND (agent_id = ?2 OR subagent_run_id = ?2)",
                rusqlite::params![session_id, agent_or_run, capability],
            )
            .map_err(|e| DbFailure {
                message: format!("update_session_agent_capability: {e}"),
                kind: DbFailureKind::Other("update_session_agent_capability".to_string()),
            })
        })
    }

    /// 单行 upsert（spawn 落库用）。全 22 列 `INSERT ... ON CONFLICT(session_id,
    /// agent_id) DO UPDATE SET`（v6 三列 task_type / display_label /
    /// allowed_write_paths_json + v9 sub_session_id 随行），字段集与
    /// [LocalDb::save_session_agents] 列清单严格一致（map_agent_row 双向核对）。
    ///
    /// 关键：**禁止 INSERT OR REPLACE**——REPLACE 语义 = DELETE + INSERT，
    /// PK 冲突会删除旧行并触发 session_agent_messages 的 FK 级联清空该 agent
    /// 全部消息；ON CONFLICT DO UPDATE 保留旧行与 messages。
    pub fn upsert_session_agent(&self, row: &SessionAgent) -> Result<(), DbFailure> {
        let row = row.clone();
        self.write_blocking(move |conn| {
            conn.execute(
                "INSERT INTO session_agents (
                    session_id, agent_id, subagent_run_id, parent_session_id, parent_run_id,
                    parent_tool_call_id, description, mode, status, summary,
                    started_at, ended_at, depth, subagent_path_json,
                    task_type, display_label, allowed_write_paths_json,
                    sub_session_id, capability_mode, model_override, resumable,
                    last_heartbeat_ms
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
                ON CONFLICT(session_id, agent_id) DO UPDATE SET
                    subagent_run_id = excluded.subagent_run_id,
                    parent_session_id = excluded.parent_session_id,
                    parent_run_id = excluded.parent_run_id,
                    parent_tool_call_id = excluded.parent_tool_call_id,
                    description = excluded.description,
                    mode = excluded.mode,
                    status = excluded.status,
                    summary = excluded.summary,
                    started_at = excluded.started_at,
                    ended_at = excluded.ended_at,
                    depth = excluded.depth,
                    subagent_path_json = excluded.subagent_path_json,
                    task_type = excluded.task_type,
                    display_label = excluded.display_label,
                    allowed_write_paths_json = excluded.allowed_write_paths_json,
                    sub_session_id = excluded.sub_session_id,
                    capability_mode = excluded.capability_mode,
                    model_override = excluded.model_override,
                    resumable = excluded.resumable,
                    last_heartbeat_ms = excluded.last_heartbeat_ms",
                rusqlite::params![
                    row.parent_session_id,
                    row.id,
                    row.subagent_run_id,
                    row.parent_session_id,
                    row.parent_run_id,
                    row.parent_tool_call_id,
                    row.description,
                    row.mode,
                    row.status,
                    row.summary,
                    row.started_at,
                    row.ended_at,
                    row.depth,
                    row.subagent_path_json,
                    row.task_type,
                    row.display_label,
                    row.allowed_write_paths_json,
                    row.sub_session_id.clone().unwrap_or_default(),
                    row.capability_mode,
                    row.model_override,
                    row.resumable,
                    row.last_heartbeat_ms,
                ],
            )
            .map_err(|e| DbFailure {
                message: format!("upsert_session_agent: {e}"),
                kind: DbFailureKind::Other("upsert_session_agent".to_string()),
            })?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::{SessionIndexEntry, SessionMessage};
    use std::sync::Arc;

    fn session_entry(id: &str) -> SessionIndexEntry {
        SessionIndexEntry {
            id: id.to_string(),
            title: format!("Title {id}"),
            folder: "常规会话".to_string(),
            is_pinned: false,
            is_archived: false,
            branch_parent_id: None,
            timestamp: "2026-08-06T00:00:00Z".to_string(),
            updated_at: 1000,
            message_count: 0,
            pinned_message_ids: None,
            engine_cursor: None,
            engine_last_run_id: None,
            hydrated_from_engine: None,
        }
    }

    fn agent(
        id: &str,
        run_id: &str,
        status: &str,
        session_id: &str,
        ended_at: Option<i64>,
        path: Option<&str>,
        messages: Vec<SessionMessage>,
    ) -> SessionAgent {
        SessionAgent {
            id: id.to_string(),
            subagent_run_id: run_id.to_string(),
            parent_session_id: session_id.to_string(),
            parent_run_id: format!("prun-{run_id}"),
            parent_tool_call_id: None,
            description: String::new(),
            mode: String::new(),
            status: status.to_string(),
            summary: None,
            messages,
            started_at: 100,
            ended_at,
            depth: Some(1),
            subagent_path_json: path.map(str::to_string),
            task_type: Some(format!("task-{id}")),
            display_label: Some(format!("标签-{id}")),
            allowed_write_paths_json: Some(r#"["docs/notes"]"#.to_string()),
            sub_session_id: None,
            capability_mode: None,
            model_override: None,
            resumable: false,
            last_heartbeat_ms: None,
        }
    }

    fn msg(id: &str, sender: &str, ts: i64) -> SessionMessage {
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

    fn seed_two_rows(db: &LocalDb, session_id: &str) {
        db.upsert_session_entry(&session_entry(session_id)).unwrap();
        db.save_session_agents(
            session_id,
            &[
                agent(
                    "a1",
                    "run-1",
                    "running",
                    session_id,
                    None,
                    None,
                    vec![msg("m1", "user", 1)],
                ),
                agent(
                    "a2",
                    "run-2",
                    "completed",
                    session_id,
                    Some(200),
                    Some(r#"["root"]"#),
                    vec![msg("m2", "assistant", 2)],
                ),
            ],
        )
        .unwrap();
    }

    fn seed_running_rows(db: &LocalDb, session_id: &str) {
        db.upsert_session_entry(&session_entry(session_id)).unwrap();
        db.save_session_agents(
            session_id,
            &[
                agent(
                    "a1",
                    "run-1",
                    "running",
                    session_id,
                    None,
                    None,
                    vec![msg("m1", "user", 1)],
                ),
                agent(
                    "a2",
                    "run-2",
                    "running",
                    session_id,
                    None,
                    None,
                    vec![msg("m2", "assistant", 2)],
                ),
            ],
        )
        .unwrap();
    }

    /// PERSIST-02 P1-3：归一循环端到端——load_running →
    /// update_session_agent_status（failed + ended_at）→ 行进入终态
    /// （restore 崩溃归一的写面等价于 kill_all 逐行语义）
    #[test]
    fn running_rows_can_be_normalized_via_update_status() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_running_rows(&db, "s1");

        let running = db.load_running_session_agents().unwrap();
        assert_eq!(running.len(), 2);
        for (session_id, run_id) in &running {
            db.update_session_agent_status(session_id, run_id, "failed", Some(999))
                .unwrap();
        }

        let rows = db.load_session_agents("s1").unwrap();
        assert!(rows.iter().all(|r| r.status == "failed"), "全部归一 failed");
        assert!(
            rows.iter().all(|r| r.ended_at == Some(999)),
            "ended_at 落库"
        );
        assert!(
            db.load_running_session_agents().unwrap().is_empty(),
            "归一后无 running 残留（幂等，重复 restore 不再命中）"
        );
        // messages 原样保留（单行定点写，级联不触发）
        assert!(rows.iter().all(|r| r.messages.len() == 1));
    }

    /// 更新目标行 status/ended_at；非目标行与 messages 字节原样
    #[test]
    fn update_status_updates_only_target_row() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_two_rows(&db, "s1");

        let affected = db
            .update_session_agent_status("s1", "run-1", "failed", Some(999))
            .unwrap();
        assert_eq!(affected, 1, "目标行应恰好更新一行");

        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(rows.len(), 2);
        let a1 = rows.iter().find(|a| a.id == "a1").unwrap();
        assert_eq!(a1.status, "failed");
        assert_eq!(a1.ended_at, Some(999));
        assert_eq!(a1.messages.len(), 1, "messages 原样保留");
        assert_eq!(a1.messages[0].id, "m1");
        // 非目标行不动
        let a2 = rows.iter().find(|a| a.id == "a2").unwrap();
        assert_eq!(a2.status, "completed", "非目标行 status 原样");
        assert_eq!(a2.ended_at, Some(200), "非目标行 ended_at 原样");
        assert_eq!(a2.subagent_path_json.as_deref(), Some(r#"["root"]"#));
        assert_eq!(a2.messages[0].id, "m2", "非目标行 messages 原样");
    }

    /// COALESCE 语义：已 ended 行的 ended_at 不被覆盖
    #[test]
    fn update_status_keeps_existing_ended_at() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_two_rows(&db, "s1");

        // 目标行已 ended（Some(200)）：新 ended_at 不应覆盖
        let affected = db
            .update_session_agent_status("s1", "run-2", "failed", Some(999))
            .unwrap();
        assert_eq!(affected, 1);
        let rows = db.load_session_agents("s1").unwrap();
        let a2 = rows.iter().find(|a| a.id == "a2").unwrap();
        assert_eq!(a2.status, "failed");
        assert_eq!(
            a2.ended_at,
            Some(200),
            "已 ended 行 ended_at 保留（COALESCE）"
        );

        // ended_at=None 也不覆盖既有值
        let affected = db
            .update_session_agent_status("s1", "run-2", "failed", None)
            .unwrap();
        assert_eq!(affected, 1);
        let rows = db.load_session_agents("s1").unwrap();
        let a2 = rows.iter().find(|a| a.id == "a2").unwrap();
        assert_eq!(a2.ended_at, Some(200), "None 不覆盖既有 ended_at");
    }

    /// 缺行静默成功：affected = 0，不报错
    #[test]
    fn update_status_missing_row_returns_zero() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_two_rows(&db, "s1");

        let affected = db
            .update_session_agent_status("s1", "no-such-run", "failed", Some(1))
            .unwrap();
        assert_eq!(affected, 0, "缺行静默成功（affected=0）");
        assert!(db.get_failure().is_none(), "缺行不落失败闩");
    }

    /// 只更新路径列：其余字段（status/ended_at/messages）字节原样
    #[test]
    fn update_path_updates_only_path_column() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_two_rows(&db, "s1");

        let affected = db
            .update_session_agent_path("s1", "run-1", r#"["root","leaf-1"]"#)
            .unwrap();
        assert_eq!(affected, 1);

        let rows = db.load_session_agents("s1").unwrap();
        let a1 = rows.iter().find(|a| a.id == "a1").unwrap();
        assert_eq!(
            a1.subagent_path_json.as_deref(),
            Some(r#"["root","leaf-1"]"#)
        );
        assert_eq!(a1.status, "running", "路径更新不动 status");
        assert_eq!(a1.ended_at, None);
        assert_eq!(a1.messages[0].id, "m1", "路径更新不动 messages");
        // 非目标行路径原样
        let a2 = rows.iter().find(|a| a.id == "a2").unwrap();
        assert_eq!(a2.subagent_path_json.as_deref(), Some(r#"["root"]"#));
    }

    /// 缺行静默成功：affected = 0（recovery 按 0 判定 NotFound）
    #[test]
    fn update_path_missing_row_returns_zero() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_two_rows(&db, "s1");

        let affected = db
            .update_session_agent_path("s1", "no-such-run", "[]")
            .unwrap();
        assert_eq!(affected, 0);
        assert!(db.get_failure().is_none(), "缺行不落失败闩");
    }

    /// upsert：插入新行；同 PK 二次 upsert 覆盖列值但 messages 保留
    /// （级联不触发）；v6 三列随行；幂等
    #[test]
    fn upsert_inserts_and_updates_preserving_messages() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&session_entry("s1")).unwrap();
        let row = agent(
            "a1",
            "run-1",
            "running",
            "s1",
            None,
            None,
            vec![msg("m1", "user", 1)],
        );
        // 首写经 save（消息随行）；后续引擎写一律走 upsert
        db.save_session_agents("s1", std::slice::from_ref(&row))
            .unwrap();

        // 同 PK 二次 upsert：列值更新（status → completed、路径写入），
        // 行数不变、messages 保留（ON CONFLICT DO UPDATE 不触发级联）
        let mut updated = row.clone();
        updated.status = "completed".to_string();
        updated.ended_at = Some(500);
        updated.subagent_path_json = Some(r#"["root","leaf-1"]"#.to_string());
        updated.task_type = Some("analysis".to_string());
        db.upsert_session_agent(&updated).unwrap();

        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(rows.len(), 1, "同 PK upsert 不新增行");
        assert_eq!(rows[0].status, "completed", "列值被覆盖");
        assert_eq!(rows[0].ended_at, Some(500));
        assert_eq!(
            rows[0].subagent_path_json.as_deref(),
            Some(r#"["root","leaf-1"]"#)
        );
        assert_eq!(rows[0].task_type.as_deref(), Some("analysis"));
        assert_eq!(rows[0].messages.len(), 1, "messages 保留（级联未触发）");
        assert_eq!(rows[0].messages[0].id, "m1");

        // v6 三列随行（display_label / 写路径白名单读回）
        assert_eq!(rows[0].display_label.as_deref(), Some("标签-a1"));
        assert_eq!(
            rows[0].allowed_write_paths_json.as_deref(),
            Some(r#"["docs/notes"]"#)
        );

        // 幂等：再次 upsert 同 PK 仍单行
        db.upsert_session_agent(&updated).unwrap();
        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(rows.len(), 1, "幂等：行数不变");

        // 新 PK：插入新行
        let new_row = agent("a2", "run-2", "running", "s1", None, None, Vec::new());
        db.upsert_session_agent(&new_row).unwrap();
        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(rows.len(), 2, "不同 PK 插入新行");
    }

    /// ON CONFLICT 显式防 REPLACE 回归：多消息行 upsert 后消息全量保留
    #[test]
    fn upsert_does_not_cascade_clear_messages() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&session_entry("s1")).unwrap();
        let row = agent(
            "a1",
            "run-1",
            "running",
            "s1",
            None,
            None,
            vec![msg("m1", "user", 1), msg("m2", "assistant", 2)],
        );
        db.save_session_agents("s1", std::slice::from_ref(&row))
            .unwrap();

        // 同 PK upsert（等价 INSERT OR REPLACE 的触发面：PK 冲突）
        let mut updated = row.clone();
        updated.status = "failed".to_string();
        db.upsert_session_agent(&updated).unwrap();

        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(
            rows[0].messages.len(),
            2,
            "级联清空不触发（禁止 REPLACE 回归）"
        );
        assert_eq!(rows[0].messages[0].id, "m1");
        assert_eq!(rows[0].messages[1].id, "m2");
    }

    /// 交错场景不丢行（N05 根因回归）：kill_all 写面（查询面 → 逐行
    /// update_session_agent_status）与并发 spawn（upsert）交错时，
    /// spawn 新行必须保留——旧全量先删后插会把新行整批删掉
    #[test]
    fn kill_spawn_interleave_keeps_all_rows() {
        let db = Arc::new(LocalDb::open_in_memory().unwrap());
        seed_running_rows(&db, "s1");

        // 确定性交错：kill 侧先取目标快照（查询面），spawn 侧在其
        // 写面前 upsert 新行（屏障保证落点 = 「kill 中 spawn」）
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let kill_db = db.clone();
        let barrier_kill = barrier.clone();
        let kill_thread = std::thread::spawn(move || {
            let targets = kill_db
                .load_session_agents_by_parent_status("s1", "running")
                .unwrap();
            barrier_kill.wait();
            for target in &targets {
                kill_db
                    .update_session_agent_status("s1", &target.subagent_run_id, "failed", Some(999))
                    .unwrap();
            }
        });
        let spawn_db = db.clone();
        let barrier_spawn = barrier.clone();
        let spawn_thread = std::thread::spawn(move || {
            barrier_spawn.wait();
            let new_row = agent("a3", "run-3", "running", "s1", None, None, Vec::new());
            spawn_db.upsert_session_agent(&new_row).unwrap();
        });
        kill_thread.join().unwrap();
        spawn_thread.join().unwrap();

        // 行数 = 两方行数之和（3）：spawn 新行不再被整批删除
        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(rows.len(), 3, "kill 中 spawn 不丢行");
        let by_id = |id: &str| rows.iter().find(|a| a.id == id).unwrap();
        assert_eq!(by_id("a1").status, "failed", "目标行归一 failed");
        assert_eq!(by_id("a2").status, "failed");
        assert_eq!(by_id("a3").status, "running", "并发 spawn 行未被误删未改");
        assert_eq!(by_id("a3").subagent_run_id, "run-3");
        assert_eq!(by_id("a3").depth, Some(1));
    }

    /// 先 spawn 后 kill：既有行与 spawn 行并存，目标行归一
    #[test]
    fn spawn_then_kill_keeps_all_rows() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_running_rows(&db, "s1");

        // 先 spawn（upsert 新行）
        let new_row = agent("a3", "run-3", "running", "s1", None, None, Vec::new());
        db.upsert_session_agent(&new_row).unwrap();

        // 后 kill（对目标行逐条单行更新：a3 已是 running，一并命中）
        let targets = db
            .load_session_agents_by_parent_status("s1", "running")
            .unwrap();
        assert_eq!(targets.len(), 3, "目标 = 三个 running 行（含 spawn 行）");
        for target in &targets {
            db.update_session_agent_status("s1", &target.subagent_run_id, "failed", Some(999))
                .unwrap();
        }

        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(rows.len(), 3, "spawn 行保留（不丢行）");
        let by_id = |id: &str| rows.iter().find(|a| a.id == id).unwrap();
        assert_eq!(by_id("a1").status, "failed");
        assert_eq!(by_id("a2").status, "failed");
        assert_eq!(by_id("a3").status, "failed", "spawn 行同样被归一");
        assert_eq!(by_id("a1").messages[0].id, "m1", "目标行 messages 原样");
    }

    /// D-02 LK-04 v9 列读写 roundtrip：save/load 与 upsert/load 双面均不丢
    /// sub_session_id（map_agent_row 位置索引 17 适配）；None → 落库空串，
    /// 读回归一 None（无子会话映射语义）；查询扩展面（kill_all 过滤面）
    /// 同样带回该列
    #[test]
    fn sub_session_id_roundtrip_via_save_and_upsert() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&session_entry("s1")).unwrap();

        // save 面：带子会话 id 的行随行落库、读回一致
        let mut row = agent("a1", "run-1", "running", "s1", None, None, Vec::new());
        row.sub_session_id = Some("sub-sess-1-1".to_string());
        db.save_session_agents("s1", std::slice::from_ref(&row))
            .unwrap();
        let loaded = db.load_session_agents("s1").unwrap();
        assert_eq!(
            loaded[0].sub_session_id.as_deref(),
            Some("sub-sess-1-1"),
            "save/load roundtrip 不丢 sub_session_id"
        );

        // upsert 面：ON CONFLICT DO UPDATE 覆盖列值同样读回一致
        let mut updated = row.clone();
        updated.sub_session_id = Some("sub-sess-1-2".to_string());
        db.upsert_session_agent(&updated).unwrap();
        let loaded = db.load_session_agents("s1").unwrap();
        assert_eq!(
            loaded[0].sub_session_id.as_deref(),
            Some("sub-sess-1-2"),
            "upsert/load roundtrip 不丢 sub_session_id"
        );

        // 查询扩展面（kill_all 过滤面）：按父会话 + 状态过滤同样带回该列
        let by_status = db
            .load_session_agents_by_parent_status("s1", "running")
            .unwrap();
        assert_eq!(
            by_status[0].sub_session_id.as_deref(),
            Some("sub-sess-1-2"),
            "查询扩展面带回 sub_session_id"
        );

        // None → 落库空串（NOT NULL DEFAULT '' 兜底），读回归一 None
        let mut bare = agent("a2", "run-2", "running", "s1", None, None, Vec::new());
        bare.sub_session_id = None;
        db.upsert_session_agent(&bare).unwrap();
        let loaded = db.load_session_agents("s1").unwrap();
        let a2 = loaded.iter().find(|a| a.id == "a2").unwrap();
        assert_eq!(
            a2.sub_session_id, None,
            "None 落库空串读回归一 None（无子会话映射）"
        );
    }

    /// P3：能力/模型/可恢复/心跳四列 save/upsert/查询扩展三面 roundtrip
    #[test]
    fn lifecycle_columns_roundtrip_all_read_paths() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&session_entry("s1")).unwrap();
        let mut row = agent("a1", "run-1", "running", "s1", None, None, Vec::new());
        row.capability_mode = Some("read-only".to_string());
        row.model_override = Some("claude-sonnet".to_string());
        row.resumable = true;
        row.last_heartbeat_ms = Some(12_345);
        db.save_session_agents("s1", std::slice::from_ref(&row))
            .unwrap();

        let loaded = &db.load_session_agents("s1").unwrap()[0];
        assert_eq!(loaded.capability_mode.as_deref(), Some("read-only"));
        assert_eq!(loaded.model_override.as_deref(), Some("claude-sonnet"));
        assert!(loaded.resumable);
        assert_eq!(loaded.last_heartbeat_ms, Some(12_345));

        // upsert 覆盖四列
        let mut updated = row.clone();
        updated.capability_mode = Some("all".to_string());
        updated.model_override = None;
        updated.resumable = false;
        updated.last_heartbeat_ms = Some(99_999);
        db.upsert_session_agent(&updated).unwrap();
        let loaded = &db.load_session_agents("s1").unwrap()[0];
        assert_eq!(loaded.capability_mode.as_deref(), Some("all"));
        assert_eq!(loaded.model_override, None);
        assert!(!loaded.resumable);
        assert_eq!(loaded.last_heartbeat_ms, Some(99_999));

        // 查询扩展面（kill_all 过滤）同样带回四列
        let by_status = db
            .load_session_agents_by_parent_status("s1", "running")
            .unwrap();
        assert_eq!(by_status[0].capability_mode.as_deref(), Some("all"));
        assert_eq!(by_status[0].last_heartbeat_ms, Some(99_999));

        // 启动对账轻量读面（全库 running 行）同样带回
        let running = db.load_running_session_agent_rows().unwrap();
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].id, "a1");
        assert_eq!(running[0].model_override, None);
    }

    /// P3 心跳条件写：仅 running 行、仅到达最小间隔才刷新；重复 tick 零写
    #[test]
    fn heartbeat_refreshes_only_when_stale_and_running() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_running_rows(&db, "s1");

        // 首写（last_heartbeat_ms NULL）→ 命中
        assert_eq!(
            db.touch_session_agent_heartbeat("s1", "run-1", 10_000, 5_000)
                .unwrap(),
            1
        );
        // 同刻重复 → 未达间隔，零写
        assert_eq!(
            db.touch_session_agent_heartbeat("s1", "run-1", 10_000, 5_000)
                .unwrap(),
            0
        );
        // 未达间隔 → 零写
        assert_eq!(
            db.touch_session_agent_heartbeat("s1", "run-1", 14_999, 5_000)
                .unwrap(),
            0
        );
        // 到达间隔 → 刷新
        assert_eq!(
            db.touch_session_agent_heartbeat("s1", "run-1", 15_000, 5_000)
                .unwrap(),
            1
        );
        let rows = db.load_session_agents("s1").unwrap();
        let a1 = rows.iter().find(|a| a.id == "a1").unwrap();
        assert_eq!(a1.last_heartbeat_ms, Some(15_000));

        // 终态行不再接受心跳
        db.update_session_agent_status("s1", "run-1", "completed", Some(20_000))
            .unwrap();
        assert_eq!(
            db.touch_session_agent_heartbeat("s1", "run-1", 30_000, 0)
                .unwrap(),
            0,
            "非 running 行心跳零写"
        );
    }

    /// P3 启动对账写面：running → failed + resumable=1 + ended_at/心跳补齐；
    /// 二次对账幂等（0 行影响），终态行不被改写
    #[test]
    fn mark_interrupted_sets_resumable_and_is_idempotent() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_running_rows(&db, "s1");

        assert_eq!(
            db.mark_session_agent_interrupted(
                "s1",
                "run-1",
                50_000,
                "应用重启中断（可恢复）"
            )
            .unwrap(),
            1
        );
        let rows = db.load_session_agents("s1").unwrap();
        let a1 = rows.iter().find(|a| a.id == "a1").unwrap();
        assert_eq!(a1.status, "failed");
        assert!(a1.resumable, "中断对账必须置可恢复");
        assert_eq!(a1.ended_at, Some(50_000));
        assert_eq!(a1.last_heartbeat_ms, Some(50_000), "旧行心跳以中断时刻兜底");
        assert_eq!(a1.summary.as_deref(), Some("应用重启中断（可恢复）"));
        // 同批其他 running 行不受影响（单行定点写）
        let a2 = rows.iter().find(|a| a.id == "a2").unwrap();
        assert_eq!(a2.status, "running");
        assert!(!a2.resumable);

        // 幂等：目标行已终态 → 0 行影响，字段不再变化
        assert_eq!(
            db.mark_session_agent_interrupted("s1", "run-1", 60_000, "重复")
                .unwrap(),
            0
        );
        let rows = db.load_session_agents("s1").unwrap();
        let a1 = rows.iter().find(|a| a.id == "a1").unwrap();
        assert_eq!(a1.ended_at, Some(50_000), "重复对账不覆盖 ended_at");
        assert_eq!(a1.summary.as_deref(), Some("应用重启中断（可恢复）"));
        assert!(db.load_running_session_agent_rows().unwrap().len() == 1);
    }
}
