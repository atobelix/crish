//! 探索类文档配额计数存储（I6-M11 C5 的 session_meta 后端实现）
//!
//! agent-tools 的 explore_quota.rs 只定义契约（[ExploreDocsQuotaStore]
//! trait），本模块提供引擎侧持久化实现：配额计数经 session_meta 全局
//! KV 表读写（sessions.rs:140-171 的 get/set_session_meta），键按
//! `{session_id}:{key}` 编码隔离（explore_quota.rs:43-49 的
//! [agent_tools::explore_quota::session_meta_key_of]，对齐 revert_guard.rs
//! 的 S7 接线模式；空 session_id 退化字面键）。
//!
//! 持久化语义（04 文档 §2 C5 验收：跨 run / 跨重启配额恢复）：
//! - snapshot：读 get_session_meta 经
//!   [agent_tools::explore_quota::parse_explore_docs_consumed] 容错解析
//!   （损坏 / 缺失 → 零消耗默认，不 panic，对齐 explore_quota.rs:70-88）；
//! - consume：读改写 + set_session_meta 落库（saturating_add 防溢出回绕，
//!   并记录最近消耗者 run 标识）。
//!
//! 接线面：引擎装配时经
//! [agent_tools::context::ExploreDocsQuotaContext] 注入工具执行上下文
//! （配额 None = 主 agent 不受约束；配额由会话级共享，多 run 累计）。

use agent_tools::explore_quota::{
    ExploreDocsQuotaSnapshot, ExploreDocsQuotaStore, SESSION_META_KEY_EXPLORE_DOCS_CONSUMED,
    explore_docs_consumed_value, parse_explore_docs_consumed, session_meta_key_of,
};

use crate::LocalDb;

/// session_meta 后端的探索类文档配额存储（会话级计数，跨重启恢复）
///
/// Clone 为廉价 Arc 计数（对齐 [LocalDb] 自身语义），可跨任务共享。
#[derive(Clone)]
pub struct SessionMetaExploreDocsQuotaStore {
    /// 本地会话库（session_meta 全局 KV 表；多会话按键前缀隔离）
    db: LocalDb,
}

impl std::fmt::Debug for SessionMetaExploreDocsQuotaStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // LocalDb 不实现 Debug（内部为 Mutex<Connection>），仅满足
        // ExploreDocsQuotaStore 的 Debug bound，打印类型名即可
        // （对齐 revert_guard.rs:272-278 的参考实现写法）
        f.write_str("SessionMetaExploreDocsQuotaStore")
    }
}

impl SessionMetaExploreDocsQuotaStore {
    /// 新建存储（注入本地会话库实例）
    pub fn new(db: LocalDb) -> Self {
        Self { db }
    }
}

impl ExploreDocsQuotaStore for SessionMetaExploreDocsQuotaStore {
    fn snapshot(&self, session_id: &str) -> ExploreDocsQuotaSnapshot {
        let key = session_meta_key_of(session_id, SESSION_META_KEY_EXPLORE_DOCS_CONSUMED);
        let value = self.db.get_session_meta(&key).ok().flatten();
        parse_explore_docs_consumed(value.as_deref())
    }

    fn consume(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<ExploreDocsQuotaSnapshot, String> {
        let key = session_meta_key_of(session_id, SESSION_META_KEY_EXPLORE_DOCS_CONSUMED);
        // 读改写：当前快照 +1（saturating_add 防溢出回绕）并登记最近
        // 消耗者；落库失败返回错误文案（调用方按执行失败处理，不 panic）
        let current = self.snapshot(session_id);
        let next = ExploreDocsQuotaSnapshot {
            consumed: current.consumed.saturating_add(1),
            last_consumer_run_id: Some(run_id.to_string()),
        };
        self.db
            .set_session_meta(&key, &explore_docs_consumed_value(&next))
            .map_err(|e| format!("探索类文档配额计数落库失败：{e}"))?;
        Ok(next)
    }

    fn try_consume(
        &self,
        session_id: &str,
        run_id: &str,
        quota: u32,
    ) -> Result<ExploreDocsQuotaSnapshot, String> {
        let key = session_meta_key_of(session_id, SESSION_META_KEY_EXPLORE_DOCS_CONSUMED);
        // F3 #9：单次锁内读改写（update_session_meta）——检查与占用原子，
        // 并发调用序列化于连接互斥，无 check-then-consume 竞态窗口
        let written = self
            .db
            .update_session_meta(&key, |current| {
                let cur = parse_explore_docs_consumed(current);
                if cur.consumed >= quota {
                    // 拒绝更新：配额已用尽
                    return None;
                }
                Some(explore_docs_consumed_value(&ExploreDocsQuotaSnapshot {
                    consumed: cur.consumed.saturating_add(1),
                    last_consumer_run_id: Some(run_id.to_string()),
                }))
            })
            .map_err(|e| format!("探索类文档配额原子占用失败：{e}"))?;
        match written {
            Some(_) => Ok(self.snapshot(session_id)),
            None => Err(format!(
                "配额已用尽（consumed={}，quota={quota}）",
                self.snapshot(session_id).consumed
            )),
        }
    }

    fn release(&self, session_id: &str, _run_id: &str) {
        let key = session_meta_key_of(session_id, SESSION_META_KEY_EXPLORE_DOCS_CONSUMED);
        // 补偿：reserve 后写盘失败回滚占用（下限 0，不产生负计数）
        let _ = self.db.update_session_meta(&key, |current| {
            let cur = parse_explore_docs_consumed(current);
            Some(explore_docs_consumed_value(&ExploreDocsQuotaSnapshot {
                consumed: cur.consumed.saturating_sub(1),
                last_consumer_run_id: cur.last_consumer_run_id,
            }))
        });
    }
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时 DB 清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use agent_tools::explore_quota::{
        SESSION_META_KEY_EXPLORE_DOCS_QUOTA, session_meta_key_of,
    };

    /// 临时文件库（重启恢复用例：重建连接模拟跨进程重启）
    struct TempQuotaDb {
        path: std::path::PathBuf,
    }

    impl TempQuotaDb {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "conex-quota-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or_default()
            ));
            let _ = std::fs::create_dir_all(&dir);
            let path = dir.join("sessions.db");
            let _ = std::fs::remove_file(&path);
            Self { path }
        }
    }

    impl Drop for TempQuotaDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
            let _ = std::fs::remove_file(format!("{}-wal", self.path.display()));
            let _ = std::fs::remove_file(format!("{}-shm", self.path.display()));
            if let Some(parent) = self.path.parent() {
                let _ = std::fs::remove_dir_all(parent);
            }
        }
    }

    /// 配额往返 + 会话隔离：consume 后快照反映计数与最近消耗者；
    /// 不同会话互不干扰（键前缀隔离）
    #[test]
    fn quota_roundtrip_and_session_isolation() {
        let db = LocalDb::open_in_memory().expect("打开内存库");
        let store = SessionMetaExploreDocsQuotaStore::new(db);

        // 未消耗：零消耗默认
        assert_eq!(store.snapshot("sess-1"), ExploreDocsQuotaSnapshot::default());

        // consume：+1 并记录最近消耗者
        let snap = store.consume("sess-1", "run-researcher-1").unwrap();
        assert_eq!(snap.consumed, 1);
        assert_eq!(snap.last_consumer_run_id.as_deref(), Some("run-researcher-1"));

        // 再次消耗（同会话累计）；续跑共享同一配额
        let snap = store.consume("sess-1", "run-researcher-2").unwrap();
        assert_eq!(snap.consumed, 2, "同会话配额按会话累计");
        assert_eq!(
            snap.last_consumer_run_id.as_deref(),
            Some("run-researcher-2"),
            "最近消耗者跟随最新一次"
        );

        // 会话隔离：sess-2 不受 sess-1 影响
        assert_eq!(
            store.snapshot("sess-2"),
            ExploreDocsQuotaSnapshot::default(),
            "不同会话配额互不干扰"
        );
    }

    /// 重启恢复：消耗计数落库后重建连接（模拟进程重启），快照仍能
    /// 恢复（04 文档 §2 C5 验收：跨重启配额恢复）
    #[test]
    fn quota_survives_restart() {
        let temp = TempQuotaDb::new("restart");
        // 第一段生命周期：消耗一次
        {
            let db = LocalDb::open(&temp.path).expect("打开临时库");
            let store = SessionMetaExploreDocsQuotaStore::new(db);
            store.consume("sess-1", "run-1").unwrap();
        }
        // 重建连接（模拟重启）：配额计数与最近消耗者均恢复
        {
            let db = LocalDb::open(&temp.path).expect("重建打开临时库");
            let store = SessionMetaExploreDocsQuotaStore::new(db);
            let snap = store.snapshot("sess-1");
            assert_eq!(snap.consumed, 1, "重启后配额计数必须恢复");
            assert_eq!(
                snap.last_consumer_run_id.as_deref(),
                Some("run-1"),
                "重启后最近消耗者必须恢复"
            );
        }
    }

    /// 损坏值容错：session_meta 中既有非 JSON / 缺字段值不 panic，
    /// 按零消耗默认解析（对齐 parse_explore_docs_consumed 容错语义）
    #[test]
    fn corrupt_value_tolerated() {
        let db = LocalDb::open_in_memory().expect("打开内存库");
        let store = SessionMetaExploreDocsQuotaStore::new(db.clone());

        // 损坏 JSON：直接塞入字面键（非 JSON 文本）
        db.set_session_meta(
            &session_meta_key_of("sess-1", SESSION_META_KEY_EXPLORE_DOCS_CONSUMED),
            "not-json{{{",
        )
        .expect("写入损坏值");

        let snap = store.snapshot("sess-1");
        assert_eq!(
            snap.consumed, 0,
            "损坏值按零消耗容错（不 panic）"
        );
        assert_eq!(snap.last_consumer_run_id, None);

        // 缺字段（合法 JSON 但无 consumed 字段）同样容错
        db.set_session_meta(
            &session_meta_key_of("sess-1", SESSION_META_KEY_EXPLORE_DOCS_CONSUMED),
            "{\"other\": 1}",
        )
        .expect("写入缺字段值");
        assert_eq!(store.snapshot("sess-1").consumed, 0, "缺字段按零消耗容错");
    }

    /// 空 session_id 退化字面键：直接读写字面键（对齐 explore_quota.rs
    /// session_meta_key_of 语义；单会话引擎传空 session_id 时的接线形态）
    #[test]
    fn empty_session_id_literal_key() {
        let db = LocalDb::open_in_memory().expect("打开内存库");
        let store = SessionMetaExploreDocsQuotaStore::new(db.clone());

        store.consume("", "run-single").unwrap();
        // 字面键（无前缀）直接可读，且与带前缀键互不干扰
        let literal = db
            .get_session_meta(SESSION_META_KEY_EXPLORE_DOCS_CONSUMED)
            .expect("读取字面键");
        assert!(literal.is_some(), "空 session_id 必须退化字面键落库");
        assert_eq!(
            store.snapshot("").consumed,
            1,
            "空 session_id 快照命中字面键"
        );
        assert_eq!(
            store.snapshot("sess-other").consumed,
            0,
            "带前缀键与字面键互不干扰"
        );

        // 键编码与 agent-tools 契约一致（配额上限键一并核对）
        assert_eq!(
            session_meta_key_of("", SESSION_META_KEY_EXPLORE_DOCS_QUOTA),
            SESSION_META_KEY_EXPLORE_DOCS_QUOTA,
            "空 session_id 退化字面键（契约对齐）"
        );
    }
}
