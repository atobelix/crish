//! 落盘层：后台工具调用记录的持久化契约与实现。
//!
//! 注册表条目在每次状态迁移时把记录镜像写入本层（upsert by callId）：
//! - 进程内条目终态后只保留有界窗口（见 registry 的留存口径），更久的
//!   查询经本层回查；
//! - 冷启动合成（BG3）的原料来自本层：进程退出时未落定的记录仍以
//!   非终态存放在此，新进程据 [ToolBackgroundStore::list_unsettled]
//!   把它们合成 OutcomeUnknown 结果注入会话；
//! - 会话关闭/删除时经 [ToolBackgroundStore::remove_session] 清除。
//!
//! 实现两份：
//! - [SessionMetaToolBackgroundStore]：生产实现，基于 `conex-db`
//!   的 session_meta kv（与 agent_policy 等会话级服务同一落盘面）；
//! - [InMemoryToolBackgroundStore]：测试与未装配 DB 时的替身。

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use agent_tools::tools::tool_task::ToolTaskState;
use serde::{Deserialize, Serialize};

/// 落盘记录（注册表条目的持久镜像；字段与 tool_task 查询契约同源）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolBackgroundRecord {
    pub call_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub tool_name: String,
    pub state: ToolTaskState,
    /// 成功输出（SettledOk 时有值）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
    /// 失败错误码（SettledErr 时有值；wire tool.* 域）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    /// 失败/取消/未知文案（尽力给出）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// 执行耗时（终态且曾开始执行时有值）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub queued_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_at_ms: Option<u64>,
}

impl ToolBackgroundRecord {
    /// 是否终态记录
    pub fn is_terminal(&self) -> bool {
        self.state.is_terminal()
    }
}

/// 落盘错误（字符串化底层错误，保住注册表对存储实现的零耦合）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolBackgroundStoreError(pub String);

impl fmt::Display for ToolBackgroundStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "工具后台记录落盘失败：{}", self.0)
    }
}

impl std::error::Error for ToolBackgroundStoreError {}

/// 后台工具调用记录的持久化契约
///
/// 语义约定：
/// - [Self::put_record] 按 callId upsert，并把 callId 登记进该会话的
///   索引（供 list/remove 按会话枚举）；
/// - [Self::get_record] 按 callId 全局寻址（callId 全局唯一）；
/// - [Self::list_unsettled] 只返回指定会话的非终态记录；
/// - [Self::remove_session] 清除指定会话的全部记录与索引（记录键置
///   空墓碑——session_meta 无单键删除 API，空值读作不存在）。
pub trait ToolBackgroundStore: Send + Sync + fmt::Debug {
    /// upsert 一条记录
    fn put_record(&self, record: &ToolBackgroundRecord) -> Result<(), ToolBackgroundStoreError>;
    /// 按 callId 读取记录
    fn get_record(
        &self,
        call_id: &str,
    ) -> Result<Option<ToolBackgroundRecord>, ToolBackgroundStoreError>;
    /// 列出指定会话的未落定记录（冷启动合成原料）
    fn list_unsettled(
        &self,
        session_id: &str,
    ) -> Result<Vec<ToolBackgroundRecord>, ToolBackgroundStoreError>;
    /// 清除指定会话的全部记录
    fn remove_session(&self, session_id: &str) -> Result<(), ToolBackgroundStoreError>;
}

/// 内存实现（测试替身；索引与记录同锁维护）
#[derive(Debug, Default)]
pub struct InMemoryToolBackgroundStore {
    records: Mutex<HashMap<String, ToolBackgroundRecord>>,
    index: Mutex<HashMap<String, Vec<String>>>,
}

impl InMemoryToolBackgroundStore {
    /// 空存储
    pub fn new() -> Self {
        Self::default()
    }
}

impl ToolBackgroundStore for InMemoryToolBackgroundStore {
    fn put_record(&self, record: &ToolBackgroundRecord) -> Result<(), ToolBackgroundStoreError> {
        self.records
            .lock()
            .unwrap()
            .insert(record.call_id.clone(), record.clone());
        let mut index = self.index.lock().unwrap();
        let ids = index.entry(record.session_id.clone()).or_default();
        if !ids.iter().any(|id| id == &record.call_id) {
            ids.push(record.call_id.clone());
        }
        Ok(())
    }

    fn get_record(
        &self,
        call_id: &str,
    ) -> Result<Option<ToolBackgroundRecord>, ToolBackgroundStoreError> {
        Ok(self.records.lock().unwrap().get(call_id).cloned())
    }

    fn list_unsettled(
        &self,
        session_id: &str,
    ) -> Result<Vec<ToolBackgroundRecord>, ToolBackgroundStoreError> {
        let ids = self
            .index
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        let records = self.records.lock().unwrap();
        Ok(ids
            .iter()
            .filter_map(|id| records.get(id))
            .filter(|r| !r.is_terminal())
            .cloned()
            .collect())
    }

    fn remove_session(&self, session_id: &str) -> Result<(), ToolBackgroundStoreError> {
        let ids = self
            .index
            .lock()
            .unwrap()
            .remove(session_id)
            .unwrap_or_default();
        let mut records = self.records.lock().unwrap();
        for id in &ids {
            records.remove(id);
        }
        Ok(())
    }
}

/// 生产实现：基于 LocalDb 的 session_meta kv。
///
/// 键布局：
/// - 记录：`tool_background:record:<callId>`（callId 全局唯一，全局寻址）；
/// - 会话索引：`<sessionId>:tool_background_index`（JSON 数组 of callId，
///   经 `update_session_meta` 原子读改写登记，防并发登记丢条目）。
pub struct SessionMetaToolBackgroundStore {
    db: conex_db::LocalDb,
}

// LocalDb 未实现 Debug：手写不泄漏内部状态的 Debug（仅类型名）
impl std::fmt::Debug for SessionMetaToolBackgroundStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionMetaToolBackgroundStore")
            .finish_non_exhaustive()
    }
}

impl SessionMetaToolBackgroundStore {
    /// 以引擎 LocalDb 构造
    pub fn new(db: conex_db::LocalDb) -> Self {
        Self { db }
    }

    fn record_key(call_id: &str) -> String {
        format!("tool_background:record:{call_id}")
    }

    fn index_key(session_id: &str) -> String {
        crate::run::session_meta_key_of(session_id, "tool_background_index")
    }

    fn parse_index(raw: Option<&str>) -> Vec<String> {
        raw.and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default()
    }
}

impl ToolBackgroundStore for SessionMetaToolBackgroundStore {
    fn put_record(&self, record: &ToolBackgroundRecord) -> Result<(), ToolBackgroundStoreError> {
        let json = serde_json::to_string(record)
            .map_err(|e| ToolBackgroundStoreError(format!("记录序列化失败：{e}")))?;
        self.db
            .set_session_meta(&Self::record_key(&record.call_id), &json)
            .map_err(|e| ToolBackgroundStoreError(e.to_string()))?;
        // 索引登记（原子读改写：已在索引中则保持原值不重写）
        let call_id = record.call_id.clone();
        self.db
            .update_session_meta(&Self::index_key(&record.session_id), move |current| {
                let mut ids = Self::parse_index(current);
                if ids.iter().any(|id| id == &call_id) {
                    None
                } else {
                    ids.push(call_id);
                    serde_json::to_string(&ids).ok()
                }
            })
            .map_err(|e| ToolBackgroundStoreError(e.to_string()))?;
        Ok(())
    }

    fn get_record(
        &self,
        call_id: &str,
    ) -> Result<Option<ToolBackgroundRecord>, ToolBackgroundStoreError> {
        let raw = self
            .db
            .get_session_meta(&Self::record_key(call_id))
            .map_err(|e| ToolBackgroundStoreError(e.to_string()))?;
        match raw {
            // 空串 = remove_session 置下的墓碑，读作不存在
            None => Ok(None),
            Some(s) if s.is_empty() => Ok(None),
            Some(s) => serde_json::from_str(&s)
                .map(Some)
                .map_err(|e| ToolBackgroundStoreError(format!("记录反序列化失败：{e}"))),
        }
    }

    fn list_unsettled(
        &self,
        session_id: &str,
    ) -> Result<Vec<ToolBackgroundRecord>, ToolBackgroundStoreError> {
        let raw = self
            .db
            .get_session_meta(&Self::index_key(session_id))
            .map_err(|e| ToolBackgroundStoreError(e.to_string()))?;
        let mut out = Vec::new();
        for id in Self::parse_index(raw.as_deref()) {
            if let Some(record) = self.get_record(&id)? {
                if !record.is_terminal() {
                    out.push(record);
                }
            }
        }
        Ok(out)
    }

    fn remove_session(&self, session_id: &str) -> Result<(), ToolBackgroundStoreError> {
        let raw = self
            .db
            .get_session_meta(&Self::index_key(session_id))
            .map_err(|e| ToolBackgroundStoreError(e.to_string()))?;
        for id in Self::parse_index(raw.as_deref()) {
            // 墓碑：session_meta 无单键删除 API，置空串（get_record 读作不存在）
            self.db
                .set_session_meta(&Self::record_key(&id), "")
                .map_err(|e| ToolBackgroundStoreError(e.to_string()))?;
        }
        self.db
            .set_session_meta(&Self::index_key(session_id), "[]")
            .map_err(|e| ToolBackgroundStoreError(e.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(call_id: &str, session_id: &str, state: ToolTaskState) -> ToolBackgroundRecord {
        ToolBackgroundRecord {
            call_id: call_id.to_string(),
            session_id: session_id.to_string(),
            run_id: Some("run-1".to_string()),
            tool_name: "web_search".to_string(),
            state,
            output: None,
            error_code: None,
            error_message: None,
            duration_ms: None,
            queued_at_ms: 100,
            started_at_ms: None,
            settled_at_ms: None,
        }
    }

    fn exercise_store(store: &dyn ToolBackgroundStore) {
        // upsert + 全局回查
        store
            .put_record(&record("c1", "s1", ToolTaskState::Running))
            .unwrap();
        let got = store.get_record("c1").unwrap().unwrap();
        assert_eq!(got.state, ToolTaskState::Running);
        assert_eq!(got.session_id, "s1");

        // 同 callId 再 put = 更新而非新增
        let mut settled = record("c1", "s1", ToolTaskState::SettledOk);
        settled.output = Some(serde_json::json!({ "hits": 1 }));
        settled.duration_ms = Some(42);
        store.put_record(&settled).unwrap();
        let got = store.get_record("c1").unwrap().unwrap();
        assert_eq!(got.state, ToolTaskState::SettledOk);
        assert_eq!(got.output, Some(serde_json::json!({ "hits": 1 })));

        // 未落定枚举：只含非终态、按会话隔离
        store
            .put_record(&record("c2", "s1", ToolTaskState::Queued))
            .unwrap();
        store
            .put_record(&record("c3", "s2", ToolTaskState::Running))
            .unwrap();
        let unsettled = store.list_unsettled("s1").unwrap();
        assert_eq!(unsettled.len(), 1);
        assert_eq!(unsettled[0].call_id, "c2");

        // 查无此任务
        assert!(store.get_record("missing").unwrap().is_none());

        // 会话清除：该会话记录不可见、他会话不受影响
        store.remove_session("s1").unwrap();
        assert!(store.get_record("c1").unwrap().is_none());
        assert!(store.get_record("c2").unwrap().is_none());
        assert!(store.list_unsettled("s1").unwrap().is_empty());
        assert!(store.get_record("c3").unwrap().is_some());
    }

    #[test]
    fn in_memory_store_contract() {
        exercise_store(&InMemoryToolBackgroundStore::new());
    }

    #[test]
    fn session_meta_store_contract() {
        let db = conex_db::LocalDb::open_in_memory().expect("内存 DB");
        exercise_store(&SessionMetaToolBackgroundStore::new(db));
    }
}
