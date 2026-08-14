//! 事件存储连接抽象（任务书 B4.2）
//!
//! [Store] trait 把 run 记录与事件流的落库统一为连接抽象，方法签名对齐
//! conex-db 的 insert_run / update_run_status / append_event / query_events
//! （04 §1.3 复用），提供两种实现：
//! - [InMemoryStore]：测试用内存实现，可注入追加延迟（慢 store）与故障
//!   （写失败 latch 语义），供 B4.2 验收用例使用；
//! - [LocalDbStore]：conex-db 的 SQLite 实现（生产路径，同步调用包在
//!   async 边界内）。
//!
//! 持久化失败语义（05 §2.8 / 05 §3.4）：append_event 失败 → run 标记
//! failed(event-store-write-failed)，不假装可回放（由 [crate::events]
//! 的 drive 流程消费）。

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use conex_db::{DbFailure, DbFailureKind, LocalDb, PendingInput, RunStatus, StoredRun};
use conex_types::{codes, CrishError};

use crate::now_ms;

/// 存储层错误（kind 为操作名，message 为详情；cause 保留底层 DbFailure
/// 上下文，T06.5.8：From<StoreError> for CrishError 时 cause 链不丢失）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError {
    /// 操作名（append_event / insert_run / update_run_status / ...）
    pub kind: String,
    /// 错误详情
    pub message: String,
    /// 底层数据库失败（None = InMemoryStore 等无底层来源）
    pub cause: Option<Box<DbFailure>>,
}

impl StoreError {
    /// 构造存储错误
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
            cause: None,
        }
    }

    /// 构造存储错误并保留底层 DbFailure（cause 链，T06.5.8）
    pub fn with_cause(
        kind: impl Into<String>,
        message: impl Into<String>,
        cause: DbFailure,
    ) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
            cause: Some(Box::new(cause)),
        }
    }

    /// 映射到 CrishError（T06.5.8：kind → 77 码；未知 kind 兜底
    /// store.write_failed 且原 kind 入 metadata 不丢失；cause 链保留 DbFailure）
    pub fn to_crish(&self) -> CrishError {
        let code = store_error_code(&self.kind).unwrap_or(codes::STORE_WRITE_FAILED);
        let mut crish = CrishError::new(code, format!("store.{}: {}", self.kind, self.message));
        // 未知 kind 兜底：原 kind 入 metadata.kind（T06.5.8 验收）
        if store_error_code(&self.kind).is_none() {
            crish = crish.with_metadata(serde_json::json!({ "kind": self.kind }));
        }
        if let Some(cause) = &self.cause {
            crish = crish.with_cause(CrishError::from(cause.as_ref().clone()));
        }
        crish
    }
}
/// StoreError kind → 77 码映射表（T06.5.8；未知 kind 返回 None 由调用方兜底）
fn store_error_code(kind: &str) -> Option<&'static str> {
    match kind {
        // 锁竞争 / 锁中毒 → store.write_failed（Transient, retryable）
        "lock" => Some(codes::STORE_WRITE_FAILED),
        // run 记录写路径 → event_store.append_failed
        "append_event" | "insert_run" | "update_run_status" | "touch_session"
        | "serialize_event" | "reserve_sequence" | "seed_sequence" => {
            Some(codes::EVENT_STORE_APPEND_FAILED)
        }
        // 读路径 → event_store.read_failed
        "query_events" | "query_events_by_run" | "query_runs" | "load_pending_inputs" => {
            Some(codes::EVENT_STORE_READ_FAILED)
        }
        // 待处理输入写路径 → store.write_failed
        "save_pending_input" | "delete_pending_input" => Some(codes::STORE_WRITE_FAILED),
        _ => None,
    }
}

impl From<StoreError> for CrishError {
    fn from(err: StoreError) -> Self {
        err.to_crish()
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for StoreError {}

/// 存储操作结果
pub type StoreResult<T> = Result<T, StoreError>;

/// 已持久化的事件行（query_events / query_events_by_run 返回）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedEvent {
    /// 会话标识
    pub session_id: String,
    /// 连续序列号（会话内唯一）
    pub sequence: u64,
    /// 事件类型（顶层 type）
    pub event_type: String,
    /// 事件 JSON 载荷
    pub payload: String,
    /// run 归属（列级权威，随 SELECT 列集带出；None = 会话域事件）
    pub run_id: Option<String>,
    /// 落库时间（毫秒精度，随 SELECT 列集带出；仅展示不作排序键，
    /// 排序唯一依据 = sequence）
    pub created_at: String,
}

/// 事件存储连接抽象（run 记录 + 事件流）
///
/// 方法签名对齐 conex-db：insert_run / update_run_status / append_event /
/// query_events（04 §1.3 的 run 表与 events 表）。
#[async_trait]
pub trait Store: Send + Sync {
    /// 插入一条 run（初始状态由调用方给定）
    async fn insert_run(
        &self,
        run_id: &str,
        session_id: &str,
        status: RunStatus,
        end_reason: Option<&str>,
        cursor: i64,
    ) -> StoreResult<()>;

    /// 更新 run 状态（end_reason 为 None 时保留已有值；cursor 为 Some 时
    /// 写入、None 时保持——中间态转移不写游标，终态写点携带最后事件
    /// sequence，T08.4）
    async fn update_run_status(
        &self,
        run_id: &str,
        status: RunStatus,
        end_reason: Option<&str>,
        cursor: Option<i64>,
    ) -> StoreResult<()>;

    /// 会话级 sequence 原子取号（T08.12 Q23：store 端单语句自增，会话内
    /// 全局单调、跨 run 不重置；防「读 max+1 再插」的 TOCTOU 窗口）
    async fn reserve_sequence(&self, session_id: &str) -> StoreResult<u64>;

    /// 会话级 sequence 计数器预热校准（T08.8：恢复后按库内
    /// max(sequence)+1 对齐初值；MAX 语义幂等，与取号路径的隐式对齐互为兜底）
    async fn seed_sequence(&self, session_id: &str, next_sequence: u64) -> StoreResult<()>;

    /// 追加一条持久化事件（会话内 sequence 唯一；run_id = run 归属，
    /// None = 会话域事件，如空闲态）
    async fn append_event(
        &self,
        session_id: &str,
        sequence: u64,
        event_type: &str,
        payload: &str,
        run_id: Option<&str>,
    ) -> StoreResult<()>;

    /// 查询会话内 after_sequence 之后的事件（按 sequence 升序）。
    ///
    /// `limit` 为 SQL 层 LIMIT 下推（None = 无限制，兼容旧调用面）。
    async fn query_events(
        &self,
        session_id: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> StoreResult<Vec<PersistedEvent>>;

    /// 按 run 归属过滤查询会话内事件（DM-07 按 run 读取用；LocalDb 面
    /// SQL 下推走 idx_events_run 索引，InMemory 面内存过滤等价）。
    ///
    /// `after_sequence` 开区间（> after）；`limit` 直下推；run_id 为
    /// NULL 的会话域事件恒不命中。
    async fn query_events_by_run(
        &self,
        session_id: &str,
        run_id: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> StoreResult<Vec<PersistedEvent>>;

    /// 查询全部 run 记录（重启恢复扫描用，B4.3；按创建时间升序）
    async fn query_runs(&self) -> StoreResult<Vec<StoredRun>>;

    /// 保存一条待处理输入（run_id 为 None 表示不绑定具体 run，
    /// 如 after-current-run 模式）
    async fn save_pending_input(
        &self,
        id: &str,
        session_id: &str,
        run_id: Option<&str>,
        payload: &str,
    ) -> StoreResult<()>;

    /// 加载某会话的全部待处理输入（FIFO：创建时间升序，含 id 决胜）
    async fn load_pending_inputs(&self, session_id: &str) -> StoreResult<Vec<PendingInput>>;

    /// 删除一条待处理输入（返回是否实际删除了行）
    async fn delete_pending_input(&self, id: &str) -> StoreResult<bool>;

    /// 下转型访问器：返回底层 [LocalDb] 连接（T-40：CoreRunState 消费
    /// `get_run_usage` / `save_run_usage` 的 run usage 数据面，runs 表
    /// v5 列）。
    ///
    /// 默认返回 None（非破坏性）——[InMemoryStore] 等测试替身无 SQLite
    /// 连接；[LocalDbStore] 覆写为克隆连接（Arc +1）。
    fn as_local_db(&self) -> Option<LocalDb> {
        None
    }

    /// 刷新会话 `updated_at`（F-005 touch 接线，R2 §3 结构性缺位修复）。
    ///
    /// 由 run 生命周期落库点（启动 / 非终态状态迁移）调用，使孤儿清理
    /// 宽限期（`updated_at < grace_cutoff`）随 run 活动重新起算——引擎侧
    /// 会话不再依赖前端 350ms persist 顺带刷新，宽限期语义在生产域生效。
    ///
    /// 默认 no-op（对齐 [Self::as_local_db] 的「可选能力默认空实现」
    /// 模式）：[InMemoryStore] 等测试替身无 sessions 表，无需刷新；
    /// [LocalDbStore] 覆写为真实单语句 UPDATE（sessions.rs touch_session）。
    async fn touch_session(&self, session_id: &str) -> StoreResult<()> {
        let _ = session_id;
        Ok(())
    }
}

/// 会话级 sequence 分配器（T08.12 Q23）
///
/// 委托 store 端原子计数器（conex-db `reserve_sequence` 单语句自增）：
/// - **会话内全局单调、跨 run 不重置**（每个会话一行计数）；
/// - 配合 append 的 UNIQUE(session_id, sequence) 约束形成 **TOCTOU 守卫**
///   ——彻底替代「读 max+1 再插」的两步窗口；
/// - 首次取号自动按库内 `max(sequence)+1` 对齐（旧数据/未预热兜底），
///   与 [SessionSequencer::seed]（T08.8 恢复预热）互为兜底。
#[derive(Clone)]
pub struct SessionSequencer {
    store: Arc<dyn Store>,
}

impl SessionSequencer {
    /// 新建分配器（共享 store 连接）
    pub fn new(store: Arc<dyn Store>) -> Self {
        Self { store }
    }

    /// 共享 store
    pub fn store(&self) -> &dyn Store {
        self.store.as_ref()
    }

    /// 原子取号：会话内下一个 sequence（从 1 或库内 max+1 续接）
    pub async fn reserve(&self, session_id: &str) -> StoreResult<u64> {
        self.store.reserve_sequence(session_id).await
    }

    /// 预热校准（T08.8 seed）：恢复完成后按库内 max(sequence)+1 对齐初值；
    /// MAX 语义（只抬高不回退），重复预热幂等
    pub async fn seed(&self, session_id: &str, next_sequence: u64) -> StoreResult<()> {
        self.store.seed_sequence(session_id, next_sequence).await
    }
}

/// 把 conex-db 的失败转为存储层错误（cause 链保留 DbFailure，T06.5.8）。
///
/// kind 语义保持操作名（append_event → event_store.append_failed 等）；
/// 锁竞争/锁中毒保留 "lock"（→ store.write_failed），与旧行为一致；
/// 底层分类（Lock/Io/Corrupt…）随 cause 链进入 CrishError。
fn db_err(operation: &str, failure: DbFailure) -> StoreError {
    let kind = if failure.kind == DbFailureKind::Lock {
        "lock".to_string()
    } else {
        operation.to_string()
    };
    let message = failure.message.clone();
    StoreError::with_cause(kind, message, failure)
}

/// 把 conex-db 的 [conex_db::StoredEvent] 行映射为 [PersistedEvent]
/// （随 SELECT 列集带出 run_id / created_at，读面列权威，DM-03）。
fn map_stored_events(rows: Vec<conex_db::StoredEvent>) -> Vec<PersistedEvent> {
    rows.into_iter()
        .map(|row| PersistedEvent {
            session_id: row.session_id,
            sequence: row.sequence as u64,
            event_type: row.event_type,
            payload: row.payload,
            run_id: row.run_id,
            created_at: row.created_at,
        })
        .collect()
}

/// 内存实现（测试用）
///
/// - [Self::set_append_delay] 模拟慢 store（持久化事件追加耗时，验证
///   delta 不阻塞 drive loop）；
/// - [Self::fail_next_append] / [Self::fail_all_appends] 注入持久化故障
///   （写失败 latch：一旦失败持续失败，与 conex-db 的 failure latch 同构）。
#[derive(Debug, Clone)]
pub struct InMemoryStore {
    inner: Arc<Mutex<InMemoryInner>>,
}

#[derive(Debug, Default)]
struct InMemoryInner {
    runs: Vec<StoredRun>,
    events: Vec<PersistedEvent>,
    pending_inputs: Vec<PendingInput>,
    /// 会话 → 最近一次已分配 sequence（T08.12：会话级原子计数器的本地镜像）
    sequence_counters: HashMap<String, u64>,
    append_delay: Duration,
    fail_all_message: Option<String>,
    next_failures: Vec<String>,
}

impl InMemoryStore {
    /// 新建空的内存存储
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(InMemoryInner::default())),
        }
    }

    /// 注入持久化事件追加延迟（模拟慢 store；仅测试用）
    pub fn set_append_delay(&self, delay: Duration) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.append_delay = delay;
        }
    }

    /// 注入一次追加失败（每次 append 消费一条；耗尽后恢复正常）
    pub fn fail_next_append(&self, message: impl Into<String>) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.next_failures.push(message.into());
        }
    }

    /// 注入持续追加失败（模拟 store 彻底损坏，写失败 latch）
    pub fn fail_all_appends(&self, message: impl Into<String>) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.fail_all_message = Some(message.into());
        }
    }

    /// 当前全部 run 记录快照（断言用）
    pub fn runs(&self) -> Vec<StoredRun> {
        self.inner
            .lock()
            .map(|guard| guard.runs.clone())
            .unwrap_or_default()
    }

    /// 当前已落库事件快照（断言用）
    pub fn events(&self) -> Vec<PersistedEvent> {
        self.inner
            .lock()
            .map(|guard| guard.events.clone())
            .unwrap_or_default()
    }

    /// 直接注入待处理输入（测试用，可指定 created_at 精确控制 FIFO 顺序）
    pub fn seed_pending_inputs(&self, inputs: Vec<PendingInput>) {
        if let Ok(mut guard) = self.inner.lock() {
            for input in inputs {
                guard.pending_inputs.retain(|p| p.id != input.id);
                guard.pending_inputs.push(input);
            }
        }
    }
}

impl Default for InMemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Store for InMemoryStore {
    async fn insert_run(
        &self,
        run_id: &str,
        session_id: &str,
        status: RunStatus,
        end_reason: Option<&str>,
        cursor: i64,
    ) -> StoreResult<()> {
        let now = now_ms();
        let run = StoredRun {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            status,
            end_reason: end_reason.map(str::to_string),
            cursor,
            created_at: now,
            updated_at: now,
        };
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        guard.runs.retain(|r| r.run_id != run_id);
        guard.runs.push(run);
        Ok(())
    }

    async fn update_run_status(
        &self,
        run_id: &str,
        status: RunStatus,
        end_reason: Option<&str>,
        cursor: Option<i64>,
    ) -> StoreResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let run = guard
            .runs
            .iter_mut()
            .find(|r| r.run_id == run_id)
            .ok_or_else(|| StoreError::new("update_run_status", format!("run 不存在: {run_id}")))?;
        run.status = status;
        if end_reason.is_some() {
            run.end_reason = end_reason.map(str::to_string);
        }
        if cursor.is_some() {
            run.cursor = cursor.unwrap_or_default();
        }
        run.updated_at = now_ms();
        Ok(())
    }

    async fn reserve_sequence(&self, session_id: &str) -> StoreResult<u64> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        // store 彻底损坏（写失败 latch）时取号同样失败
        if let Some(message) = &guard.fail_all_message {
            return Err(StoreError::new("reserve_sequence", message.clone()));
        }
        // 首次取号：以已落库 max(sequence) 对齐（T08.12 隐式预热，Q24/Q23 兜底）
        let max_persisted = guard
            .events
            .iter()
            .filter(|e| e.session_id == session_id)
            .map(|e| e.sequence)
            .max()
            .unwrap_or(0);
        let counter = guard
            .sequence_counters
            .entry(session_id.to_string())
            .and_modify(|v| *v = (*v).max(max_persisted))
            .or_insert(max_persisted);
        *counter += 1;
        Ok(*counter)
    }

    async fn seed_sequence(&self, session_id: &str, next_sequence: u64) -> StoreResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let counter = guard
            .sequence_counters
            .entry(session_id.to_string())
            .or_insert(0);
        // MAX 语义：只抬高不回退（与 conex-db seed_sequence 一致）
        *counter = (*counter).max(next_sequence.saturating_sub(1));
        Ok(())
    }

    async fn append_event(
        &self,
        session_id: &str,
        sequence: u64,
        event_type: &str,
        payload: &str,
        run_id: Option<&str>,
    ) -> StoreResult<()> {
        // 模拟慢 store 的持久化耗时（delta 路径不会走到这里）
        let delay = self
            .inner
            .lock()
            .map(|guard| guard.append_delay)
            .unwrap_or_default();
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }

        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        if let Some(message) = &guard.fail_all_message {
            return Err(StoreError::new("append_event", message.clone()));
        }
        if !guard.next_failures.is_empty() {
            return Err(StoreError::new(
                "append_event",
                guard.next_failures.remove(0),
            ));
        }
        // 对齐 events 表的 UNIQUE(session_id, sequence) 约束
        if guard
            .events
            .iter()
            .any(|e| e.session_id == session_id && e.sequence == sequence)
        {
            return Err(StoreError::new(
                "append_event",
                format!("sequence 重复: {sequence}"),
            ));
        }
        guard.events.push(PersistedEvent {
            session_id: session_id.to_string(),
            sequence,
            event_type: event_type.to_string(),
            payload: payload.to_string(),
            run_id: run_id.map(str::to_string),
            created_at: now_ms().to_string(),
        });
        Ok(())
    }

    async fn query_events(
        &self,
        session_id: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> StoreResult<Vec<PersistedEvent>> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let mut events: Vec<PersistedEvent> = guard
            .events
            .iter()
            .filter(|e| e.session_id == session_id && e.sequence > after_sequence)
            .cloned()
            .collect();
        events.sort_by_key(|e| e.sequence);
        if let Some(limit) = limit {
            events.truncate(limit as usize);
        }
        Ok(events)
    }

    async fn query_events_by_run(
        &self,
        session_id: &str,
        run_id: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> StoreResult<Vec<PersistedEvent>> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let mut events: Vec<PersistedEvent> = guard
            .events
            .iter()
            .filter(|e| {
                e.session_id == session_id
                    && e.run_id.as_deref() == Some(run_id)
                    && e.sequence > after_sequence
            })
            .cloned()
            .collect();
        events.sort_by_key(|e| e.sequence);
        if let Some(limit) = limit {
            events.truncate(limit as usize);
        }
        Ok(events)
    }

    async fn query_runs(&self) -> StoreResult<Vec<StoredRun>> {
        self.inner
            .lock()
            .map(|guard| guard.runs.clone())
            .map_err(|e| StoreError::new("lock", e.to_string()))
    }

    async fn save_pending_input(
        &self,
        id: &str,
        session_id: &str,
        run_id: Option<&str>,
        payload: &str,
    ) -> StoreResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let input = PendingInput {
            id: id.to_string(),
            session_id: session_id.to_string(),
            run_id: run_id.map(str::to_string),
            payload: payload.to_string(),
            created_at: now_ms(),
        };
        guard.pending_inputs.retain(|p| p.id != id);
        guard.pending_inputs.push(input);
        Ok(())
    }

    async fn load_pending_inputs(&self, session_id: &str) -> StoreResult<Vec<PendingInput>> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let mut inputs: Vec<PendingInput> = guard
            .pending_inputs
            .iter()
            .filter(|p| p.session_id == session_id)
            .cloned()
            .collect();
        // FIFO：创建时间升序，含 id 决胜（对齐 conex-db load_pending_inputs）
        inputs.sort_by_key(|p| (p.created_at, p.id.clone()));
        Ok(inputs)
    }

    async fn delete_pending_input(&self, id: &str) -> StoreResult<bool> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let before = guard.pending_inputs.len();
        guard.pending_inputs.retain(|p| p.id != id);
        Ok(guard.pending_inputs.len() != before)
    }
}

/// 在 tokio 阻塞线程池上执行一次同步 DB 调用（T08.5 / AA-07 P05 消除）。
///
/// 要点（与 session_commands.rs:76-79 既有模式一致）：
/// - 锁（`Mutex<Connection>`）只存在于 spawn_blocking 闭包内，await 边界
///   外无锁（AA-01 正面发现 3：不占用 tokio worker 线程）；
/// - join 失败（闭包 panic）归为对应操作名错误，不 panic 上抛；
/// - restore.rs 的恢复流程经 [Store] trait 调用自动受益。
async fn blocking_db_call<T, F>(operation: &str, f: F) -> StoreResult<T>
where
    F: FnOnce() -> Result<T, DbFailure> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| StoreError::new(operation, format!("spawn_blocking join 失败: {e}")))?
        .map_err(|failure| db_err(operation, failure))
}

/// conex-db 的 SQLite 实现（生产路径）
///
/// T08.5：8 个 trait 方法全部经 [blocking_db_call] 包 spawn_blocking，
/// 消除同步直调对 tokio worker 的阻塞（P05）。
#[derive(Clone)]
pub struct LocalDbStore {
    db: LocalDb,
    /// 追加延迟注入（仅测试：模拟慢盘，T08.5 并发验证；毫秒。
    /// Arc 包裹：AtomicU64 无 Clone，派生 Clone 需共享引用）
    #[cfg(test)]
    append_delay: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl LocalDbStore {
    /// 包装既有 LocalDb 连接（共享连接由调用方持有）
    pub fn new(db: LocalDb) -> Self {
        Self {
            db,
            #[cfg(test)]
            append_delay: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    /// 注入追加延迟（仅测试用——慢盘模拟：延迟在 spawn_blocking 闭包内
    /// 执行，占用阻塞线程池而非 tokio worker）
    #[cfg(test)]
    pub fn set_append_delay(&self, delay: std::time::Duration) {
        self.append_delay.store(
            delay.as_millis() as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
    }
}

#[async_trait]
impl Store for LocalDbStore {
    /// T-40：下转型返回底层 [LocalDb]（Clone = Arc +1）——run usage
    /// 数据面（get_run_usage / save_run_usage，runs 表 v5 列）经此访问。
    fn as_local_db(&self) -> Option<LocalDb> {
        Some(self.db.clone())
    }

    async fn insert_run(
        &self,
        run_id: &str,
        session_id: &str,
        status: RunStatus,
        end_reason: Option<&str>,
        cursor: i64,
    ) -> StoreResult<()> {
        let db = self.db.clone();
        let run_id = run_id.to_string();
        let session_id = session_id.to_string();
        let end_reason = end_reason.map(str::to_string);
        blocking_db_call("insert_run", move || {
            db.insert_run(&run_id, &session_id, status, end_reason.as_deref(), cursor)
        })
        .await
    }

    async fn update_run_status(
        &self,
        run_id: &str,
        status: RunStatus,
        end_reason: Option<&str>,
        cursor: Option<i64>,
    ) -> StoreResult<()> {
        let db = self.db.clone();
        let run_id = run_id.to_string();
        let end_reason = end_reason.map(str::to_string);
        blocking_db_call("update_run_status", move || {
            db.update_run_status(&run_id, status, end_reason.as_deref(), cursor)
        })
        .await
    }

    async fn reserve_sequence(&self, session_id: &str) -> StoreResult<u64> {
        let db = self.db.clone();
        let session_id = session_id.to_string();
        blocking_db_call("reserve_sequence", move || db.reserve_sequence(&session_id))
            .await
            .map(|seq| seq as u64)
    }

    async fn seed_sequence(&self, session_id: &str, next_sequence: u64) -> StoreResult<()> {
        let db = self.db.clone();
        let session_id = session_id.to_string();
        blocking_db_call("seed_sequence", move || {
            db.seed_sequence(&session_id, next_sequence as i64)
        })
        .await
    }

    async fn append_event(
        &self,
        session_id: &str,
        sequence: u64,
        event_type: &str,
        payload: &str,
        run_id: Option<&str>,
    ) -> StoreResult<()> {
        let db = self.db.clone();
        #[cfg(test)]
        let append_delay_ms = self.append_delay.load(std::sync::atomic::Ordering::Relaxed);
        let session_id = session_id.to_string();
        let event_type = event_type.to_string();
        let payload = payload.to_string();
        let run_id = run_id.map(str::to_string);
        blocking_db_call("append_event", move || {
            #[cfg(test)]
            if append_delay_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(append_delay_ms));
            }
            db.append_event(
                &session_id,
                sequence as i64,
                &event_type,
                &payload,
                run_id.as_deref(),
            )
        })
        .await
    }

    async fn query_events(
        &self,
        session_id: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> StoreResult<Vec<PersistedEvent>> {
        let db = self.db.clone();
        let session_id = session_id.to_string();
        let rows = blocking_db_call("query_events", move || {
            db.query_events(
                &session_id,
                after_sequence as i64,
                limit.map(|limit| limit as i64),
            )
        })
        .await?;
        Ok(map_stored_events(rows))
    }

    async fn query_events_by_run(
        &self,
        session_id: &str,
        run_id: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> StoreResult<Vec<PersistedEvent>> {
        let db = self.db.clone();
        let session_id = session_id.to_string();
        let run_id = run_id.to_string();
        let rows = blocking_db_call("query_events_by_run", move || {
            db.query_events_by_run(
                &session_id,
                &run_id,
                after_sequence as i64,
                limit.map(|limit| limit as i64),
            )
        })
        .await?;
        Ok(map_stored_events(rows))
    }

    async fn query_runs(&self) -> StoreResult<Vec<StoredRun>> {
        let db = self.db.clone();
        blocking_db_call("query_runs", move || db.query_all_runs()).await
    }

    async fn save_pending_input(
        &self,
        id: &str,
        session_id: &str,
        run_id: Option<&str>,
        payload: &str,
    ) -> StoreResult<()> {
        let db = self.db.clone();
        let id = id.to_string();
        let session_id = session_id.to_string();
        let run_id = run_id.map(str::to_string);
        let payload = payload.to_string();
        blocking_db_call("save_pending_input", move || {
            db.save_pending_input(&id, &session_id, run_id.as_deref(), &payload)
        })
        .await
    }

    async fn load_pending_inputs(&self, session_id: &str) -> StoreResult<Vec<PendingInput>> {
        let db = self.db.clone();
        let session_id = session_id.to_string();
        blocking_db_call("load_pending_inputs", move || {
            db.load_pending_inputs(&session_id)
        })
        .await
    }

    async fn delete_pending_input(&self, id: &str) -> StoreResult<bool> {
        let db = self.db.clone();
        let id = id.to_string();
        blocking_db_call("delete_pending_input", move || db.delete_pending_input(&id)).await
    }

    async fn touch_session(&self, session_id: &str) -> StoreResult<()> {
        let db = self.db.clone();
        let session_id = session_id.to_string();
        // F-005：单语句 UPDATE sessions SET updated_at=… WHERE id=?（最小面，
        // 无事务、无读改写——与前端 350ms persist 的 upsert 无竞态面）
        blocking_db_call("touch_session", move || db.touch_session(&session_id)).await
    }
}

// ── EV-12 输入留痕：session-loop PendingInputStore 适配 ────────────────
//
// session-loop 不直接持 DB 连接——经本适配把 `Store` 的 pending_inputs
// 数据面暴露给 `AgentSessionLoop`（enqueue 写点 / 消费删点 fail-open，
// spawn_blocking 纪律由 Store 实现侧承担，与 save_run_usage 同）。

#[async_trait]
impl session_loop::input::PendingInputStore for LocalDbStore {
    async fn save_pending_input(
        &self,
        id: &str,
        session_id: &str,
        run_id: Option<&str>,
        payload: &str,
    ) -> Result<(), String> {
        <Self as Store>::save_pending_input(self, id, session_id, run_id, payload)
            .await
            .map_err(|e| e.message)
    }

    async fn delete_pending_input(&self, id: &str) -> Result<bool, String> {
        <Self as Store>::delete_pending_input(self, id)
            .await
            .map_err(|e| e.message)
    }
}

#[async_trait]
impl session_loop::input::PendingInputStore for InMemoryStore {
    async fn save_pending_input(
        &self,
        id: &str,
        session_id: &str,
        run_id: Option<&str>,
        payload: &str,
    ) -> Result<(), String> {
        <Self as Store>::save_pending_input(self, id, session_id, run_id, payload)
            .await
            .map_err(|e| e.message)
    }

    async fn delete_pending_input(&self, id: &str) -> Result<bool, String> {
        <Self as Store>::delete_pending_input(self, id)
            .await
            .map_err(|e| e.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::CrishErrorCategory;

    /// T-40：下转型访问器——LocalDbStore 返回底层连接（run usage 数据面），
    /// InMemoryStore 保持默认 None（无 SQLite 连接）
    #[test]
    fn as_local_db_downcasts_local_db_store_only() {
        let db = LocalDb::open_in_memory().unwrap();
        let local: Arc<dyn Store> = Arc::new(LocalDbStore::new(db));
        assert!(local.as_local_db().is_some(), "LocalDbStore 必须可下转");

        let memory: Arc<dyn Store> = Arc::new(InMemoryStore::new());
        assert!(
            memory.as_local_db().is_none(),
            "InMemoryStore 无 SQLite 连接（默认 None）"
        );
    }

    #[test]
    fn in_memory_store_run_roundtrip() {
        let store = InMemoryStore::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            store
                .insert_run("r1", "s1", RunStatus::Queued, None, 0)
                .await
                .unwrap();
            store
                .update_run_status("r1", RunStatus::Running, None, None)
                .await
                .unwrap();
            // T08.4：终态写点携带 cursor（最后事件 sequence）；None 保持
            store
                .update_run_status("r1", RunStatus::Completed, Some("stop"), Some(4))
                .await
                .unwrap();
            store
                .update_run_status("r1", RunStatus::Failed, None, None)
                .await
                .unwrap();

            let runs = store.runs();
            assert_eq!(runs.len(), 1);
            assert_eq!(runs[0].status, RunStatus::Failed);
            assert_eq!(runs[0].end_reason.as_deref(), Some("stop"));
            assert_eq!(runs[0].cursor, 4, "终态 cursor 落库（T08.4）");
        });
    }

    /// T08.12：InMemoryStore 会话级取号——连续、会话独立、seed 校准、
    /// 首次取号对齐已落库 max（Q23/Q24 兜底）
    #[test]
    fn in_memory_store_session_sequencer_roundtrip() {
        let store = InMemoryStore::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            for expected in 1..=5 {
                assert_eq!(store.reserve_sequence("s1").await.unwrap(), expected);
            }
            // 会话独立
            assert_eq!(store.reserve_sequence("s2").await.unwrap(), 1);
            // seed 预热：抬高到 max+1（MAX 语义幂等）
            store.seed_sequence("s1", 10).await.unwrap();
            assert_eq!(store.reserve_sequence("s1").await.unwrap(), 10);
            // 已落库事件（未预热）：首次取号按 max+1 对齐
            store.append_event("s3", 42, "a", "{}", None).await.unwrap();
            assert_eq!(store.reserve_sequence("s3").await.unwrap(), 43);
            // store 彻底损坏：取号同样失败（写失败 latch）
            store.fail_all_appends("disk is read-only");
            let err = store.reserve_sequence("s3").await.unwrap_err();
            assert_eq!(err.kind, "reserve_sequence");
            assert!(err.message.contains("disk is read-only"));
        });
    }

    #[test]
    fn in_memory_store_append_duplicate_sequence_fails() {
        let store = InMemoryStore::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            store
                .append_event("s1", 1, "agent-start", "{}", None)
                .await
                .unwrap();
            let err = store
                .append_event("s1", 1, "agent-end", "{}", None)
                .await
                .unwrap_err();
            assert_eq!(err.kind, "append_event");
            assert!(err.message.contains("sequence"));
        });
    }

    #[test]
    fn in_memory_store_failure_latch_and_query() {
        let store = InMemoryStore::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            store.append_event("s1", 1, "a", "{}", None).await.unwrap();
            store.fail_all_appends("disk is read-only");
            let err = store
                .append_event("s1", 2, "b", "{}", None)
                .await
                .unwrap_err();
            assert_eq!(err.message, "disk is read-only");

            let stored = store.events();
            assert_eq!(stored.len(), 1, "失败的追加不应写入");

            // 一次性故障：消费一条后恢复正常（无 fail_all 干扰）
            let single = InMemoryStore::new();
            single.fail_next_append("一次故障");
            let err2 = single
                .append_event("s1", 1, "c", "{}", None)
                .await
                .unwrap_err();
            assert_eq!(err2.message, "一次故障");
            single.append_event("s1", 1, "c", "{}", None).await.unwrap();

            let stored2 = store.query_events("s1", 0, None).await.unwrap();
            assert_eq!(stored2.len(), 1, "fail_all 下所有追加都失败");
        });
    }

    /// DM-03：InMemoryStore query_events limit 内存切片语义——与 SQL 层
    /// LIMIT 等价（排序后截断）。
    #[test]
    fn in_memory_store_query_events_limit_slices() {
        let store = InMemoryStore::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            for seq in 1..=5u64 {
                store
                    .append_event("s1", seq, "a", "{}", None)
                    .await
                    .unwrap();
            }
            let limited = store.query_events("s1", 0, Some(3)).await.unwrap();
            assert_eq!(limited.len(), 3, "limit 生效");
            assert_eq!(limited[0].sequence, 1);
            assert_eq!(limited[2].sequence, 3);
            let unlimited = store.query_events("s1", 0, None).await.unwrap();
            assert_eq!(unlimited.len(), 5, "None 等价无限制");
        });
    }

    /// DM-03：InMemoryStore query_events_by_run——按 run 归属内存过滤等价
    /// （run_id 匹配 + after 开区间 + limit）。
    #[test]
    fn in_memory_store_query_events_by_run_filters() {
        let store = InMemoryStore::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            store
                .append_event("s1", 1, "agent-start", "{}", Some("r1"))
                .await
                .unwrap();
            store
                .append_event("s1", 2, "agent-start", "{}", Some("r2"))
                .await
                .unwrap();
            store
                .append_event("s1", 3, "agent-end", "{}", Some("r1"))
                .await
                .unwrap();
            store
                .append_event("s1", 4, "idle", "{}", None)
                .await
                .unwrap();

            // 交错 run 只返本 run，按 sequence 升序
            let r1 = store
                .query_events_by_run("s1", "r1", 0, None)
                .await
                .unwrap();
            assert_eq!(r1.len(), 2, "只返 r1 事件");
            assert_eq!(r1[0].sequence, 1);
            assert_eq!(r1[1].sequence, 3);
            assert_eq!(r1[1].event_type, "agent-end");
            // after 开区间（> after）
            let r1_after = store
                .query_events_by_run("s1", "r1", 1, None)
                .await
                .unwrap();
            assert_eq!(r1_after.len(), 1);
            assert_eq!(r1_after[0].sequence, 3);
            // limit 生效
            let r1_limited = store
                .query_events_by_run("s1", "r1", 0, Some(1))
                .await
                .unwrap();
            assert_eq!(r1_limited.len(), 1);
            assert_eq!(r1_limited[0].sequence, 1);
            // 不存在的 run → 空
            assert!(store
                .query_events_by_run("s1", "nope", 0, None)
                .await
                .unwrap()
                .is_empty());
            // run_id=NULL 会话域事件不命中 by_run，但按会话查询命中
            let all = store.query_events("s1", 0, None).await.unwrap();
            assert_eq!(all.len(), 4, "会话查询含 NULL run_id 行");
        });
    }

    /// DM-03：InMemoryStore run_id 写入回读 roundtrip（PersistedEvent.run_id）。
    #[test]
    fn in_memory_store_append_event_run_id_roundtrip() {
        let store = InMemoryStore::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            store
                .append_event("s1", 1, "agent-start", "{}", Some("r1"))
                .await
                .unwrap();
            store
                .append_event("s1", 2, "idle", "{}", None)
                .await
                .unwrap();
            let events = store.query_events("s1", 0, None).await.unwrap();
            assert_eq!(events[0].run_id.as_deref(), Some("r1"));
            assert_eq!(events[1].run_id, None);
        });
    }

    /// DM-03：LocalDbStore query_events_by_run 端到端（SQLite 层过滤，
    /// 依赖 DM-01 v9 run_id 列）。
    #[tokio::test]
    async fn local_db_store_query_events_by_run_roundtrip() {
        let db = LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "s1").unwrap();
        let store = LocalDbStore::new(db);
        store
            .append_event("s1", 1, "agent-start", "{}", Some("r1"))
            .await
            .unwrap();
        store
            .append_event("s1", 2, "agent-start", "{}", Some("r2"))
            .await
            .unwrap();
        store
            .append_event("s1", 3, "agent-end", "{}", Some("r1"))
            .await
            .unwrap();
        store
            .append_event("s1", 4, "idle", "{}", None)
            .await
            .unwrap();

        // SQL 层过滤：交错 run 只返本 run，按 sequence 升序
        let r1 = store
            .query_events_by_run("s1", "r1", 0, None)
            .await
            .unwrap();
        assert_eq!(r1.len(), 2);
        assert_eq!(r1[0].sequence, 1);
        assert_eq!(r1[1].sequence, 3);
        assert_eq!(r1[1].run_id.as_deref(), Some("r1"), "读面携带 run_id 列");
        // limit 下推生效
        let limited = store
            .query_events_by_run("s1", "r1", 0, Some(1))
            .await
            .unwrap();
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].sequence, 1);
        // 会话查询含全部（含 NULL run_id 行），run_id 随行带出
        let all = store.query_events("s1", 0, None).await.unwrap();
        assert_eq!(all.len(), 4);
        assert_eq!(all[3].run_id, None);
        assert!(
            !all[0].created_at.is_empty(),
            "created_at 随 SELECT 列集带出"
        );
    }

    #[test]
    fn local_db_store_roundtrip() {
        let db = LocalDb::open_in_memory().unwrap();
        let store = LocalDbStore::new(db);
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            // v4 起 runs/events 带 FK：先建会话（T08.7 语义）
            let db = store.db.clone();
            db.insert_session("s1", "s1").unwrap();
            store
                .insert_run("r1", "s1", RunStatus::Queued, None, 0)
                .await
                .unwrap();
            store
                .update_run_status("r1", RunStatus::Running, None, None)
                .await
                .unwrap();
            store
                .append_event("s1", 1, "agent-start", "{}", None)
                .await
                .unwrap();
            store
                .append_event("s1", 2, "agent-end", "{}", None)
                .await
                .unwrap();
            // T08.4：终态写点携带 cursor
            store
                .update_run_status("r1", RunStatus::Completed, Some("stop"), Some(2))
                .await
                .unwrap();

            let events = store.query_events("s1", 0, None).await.unwrap();
            assert_eq!(events.len(), 2);
            assert_eq!(events[0].sequence, 1);
            assert_eq!(events[1].event_type, "agent-end");

            let run = store.db.get_run("r1").unwrap().expect("run 应已落库");
            assert_eq!(run.status, RunStatus::Completed);
            assert_eq!(run.cursor, 2, "终态 cursor 落库（T08.4）");
            // T08.12：LocalDb 路径取号与 seed 校准
            for expected in 1..=3 {
                assert_eq!(store.reserve_sequence("s2").await.unwrap(), expected);
            }
            store.seed_sequence("s2", 10).await.unwrap();
            assert_eq!(store.reserve_sequence("s2").await.unwrap(), 10);
        });
    }

    /// T08.5：LocalDbStore 并发验证——共享连接（单 Mutex）多路并发
    /// append/query 无死锁，且计时任务在 DB 操作进行期间持续运行
    /// （tokio worker 不被占用）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn local_db_store_concurrent_ops_and_ticker_do_not_deadlock() {
        let db = LocalDb::open_in_memory().unwrap();
        // T08.7：events 带 FK 约束——先建会话行（s1），否则 append 失败
        db.insert_session("s1", "s1").unwrap();
        let store = LocalDbStore::new(db);

        // 8 路并发：每路 20 条事件 + 一次查询（共享同一把 Mutex<Connection>）
        let mut handles = Vec::new();
        for i in 0..8u64 {
            let store = store.clone();
            handles.push(tokio::spawn(async move {
                for seq in 1..=20u64 {
                    store
                        .append_event("s1", i * 100 + seq, "agent-start", "{}", None)
                        .await
                        .unwrap();
                }
                // 并发期间查询：至少能看到自己的 20 条（无死锁即可，
                // 总数由任务全部完成后的一次权威查询断言）
                let events = store.query_events("s1", 0, None).await.unwrap();
                assert!(events.len() >= 20, "并发查询应至少读到本路事件");
            }));
        }
        // 计时任务：DB 操作期间应持续运行（不饿死 worker）
        let ticker = tokio::spawn(async {
            let mut ticks = 0;
            while ticks < 5 {
                tokio::time::sleep(Duration::from_millis(5)).await;
                ticks += 1;
            }
            ticks
        });
        for handle in handles {
            handle.await.unwrap();
        }
        // 全部完成后权威断言：160 条事件、序列号唯一
        let events = store.query_events("s1", 0, None).await.unwrap();
        assert_eq!(events.len(), 160, "8 路 × 20 条事件全部落库且无重复");
        let mut sequences: Vec<u64> = events.iter().map(|e| e.sequence).collect();
        sequences.sort_unstable();
        sequences.dedup();
        assert_eq!(sequences.len(), 160, "序列号应全部唯一（UNIQUE 约束语义）");
        assert_eq!(
            ticker.await.unwrap(),
            5,
            "计时任务全程运行（worker 未被阻塞）"
        );
    }

    /// T08.5：慢盘模拟——append 注入 150ms 阻塞延迟（在 spawn_blocking
    /// 闭包内执行，占用阻塞线程池），单 worker runtime 下计时任务不被
    /// 饿死。若退化为同步直调，worker 被占满，计时任务只能等延迟结束。
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn local_db_store_slow_append_does_not_block_worker() {
        let db = LocalDb::open_in_memory().unwrap();
        // T08.7：events 带 FK 约束——先建会话行（s1），否则 append 失败
        db.insert_session("s1", "s1").unwrap();
        let store = LocalDbStore::new(db);
        store.set_append_delay(Duration::from_millis(400));

        let slow = store.clone();
        let append = tokio::spawn(async move {
            slow.append_event("s1", 1, "agent-start", "{}", None)
                .await
                .unwrap();
        });
        // 计时任务：10ms × 5 ≈ 50ms，应在 400ms 慢盘调用期间完成。
        // 阈值 200ms：Windows 定时器粒度 ~15.6ms（5 拍最坏 ~80ms，余量充足）；
        // 若退化为同步直调，worker 被占满，计时任务只能等 400ms 延迟结束。
        let ticker = tokio::spawn(async {
            let t0 = std::time::Instant::now();
            for _ in 0..5 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            t0.elapsed()
        });
        let (append_res, ticker_elapsed) = tokio::join!(append, ticker);
        append_res.unwrap();
        let ticker_elapsed = ticker_elapsed.expect("计时任务不应被 join 失败");
        assert!(
            ticker_elapsed.as_millis() < 200,
            "计时任务应在慢盘调用期间完成（spawn_blocking 未饿死 worker），实际 {}ms",
            ticker_elapsed.as_millis()
        );
        // 慢盘 append 本身也正确落库
        let events = store.query_events("s1", 0, None).await.unwrap();
        assert_eq!(events.len(), 1);
    }

    /// T06.5.8 映射矩阵：StoreError kind → 77 码逐条断言
    #[test]
    fn store_error_to_crish_error_mapping_matrix() {
        let cases: &[(&str, &str)] = &[
            // 锁 → store.write_failed（Transient, retryable）
            ("lock", codes::STORE_WRITE_FAILED),
            // run 记录写路径 → event_store.append_failed
            ("append_event", codes::EVENT_STORE_APPEND_FAILED),
            ("insert_run", codes::EVENT_STORE_APPEND_FAILED),
            ("update_run_status", codes::EVENT_STORE_APPEND_FAILED),
            ("touch_session", codes::EVENT_STORE_APPEND_FAILED),
            ("serialize_event", codes::EVENT_STORE_APPEND_FAILED),
            ("reserve_sequence", codes::EVENT_STORE_APPEND_FAILED),
            ("seed_sequence", codes::EVENT_STORE_APPEND_FAILED),
            // 读路径 → event_store.read_failed
            ("query_events", codes::EVENT_STORE_READ_FAILED),
            ("query_events_by_run", codes::EVENT_STORE_READ_FAILED),
            ("query_runs", codes::EVENT_STORE_READ_FAILED),
            ("load_pending_inputs", codes::EVENT_STORE_READ_FAILED),
            // 待处理输入写路径 → store.write_failed
            ("save_pending_input", codes::STORE_WRITE_FAILED),
            ("delete_pending_input", codes::STORE_WRITE_FAILED),
        ];
        for (kind, expected_code) in cases {
            let err = StoreError::new(*kind, "模拟失败");
            let crish = err.to_crish();
            assert_eq!(crish.code, *expected_code, "kind={kind} 映射码");
            assert!(
                crish.message.contains("模拟失败"),
                "kind={kind} message 人读保留"
            );
            assert!(crish.metadata.is_none(), "kind={kind} 已知映射无 metadata");
        }
    }

    /// T06.5.8：未知 kind 兜底 store.write_failed，原 kind 入 metadata 不丢失
    #[test]
    fn store_error_unknown_kind_falls_back_with_metadata() {
        let err = StoreError::new("future_operation", "模拟失败");
        let crish = err.to_crish();
        assert_eq!(crish.code, codes::STORE_WRITE_FAILED);
        assert_eq!(crish.category, CrishErrorCategory::Transient);
        assert!(crish.retryable);
        assert_eq!(
            crish.metadata.as_ref().and_then(|m| m.get("kind")),
            Some(&serde_json::json!("future_operation")),
            "未知 kind 入 metadata.kind 不丢失"
        );
    }

    /// T06.5.8：cause 链——StoreError 携带 DbFailure 时 From 转换保留
    /// 底层 77 码（event_store.append_failed ← store.write_failed）
    #[test]
    fn store_error_to_crish_error_preserves_cause_chain() {
        let db_failure = DbFailure {
            message: "append_event: disk io 错误".to_string(),
            kind: DbFailureKind::Io,
        };
        let err = StoreError::with_cause("append_event", db_failure.message.clone(), db_failure);
        let crish: CrishError = err.into();
        assert_eq!(crish.code, codes::EVENT_STORE_APPEND_FAILED);
        // cause 链保留 DbFailure 分类码
        let cause = crish.cause.as_deref().expect("cause 链必须保留");
        assert_eq!(cause.code, codes::STORE_WRITE_FAILED);
        assert_eq!(cause.category, CrishErrorCategory::Transient);
        assert!(cause.message.contains("disk io 错误"));
        assert_eq!(
            cause.metadata.as_ref().and_then(|m| m.get("dbKind")),
            Some(&serde_json::json!("io"))
        );
    }

    /// T06.5.8：锁竞争经 db_err 保留 "lock" kind（→ store.write_failed），
    /// 与旧行为一致且 cause 链携带 Lock 分类
    #[test]
    fn db_err_lock_preserves_lock_kind() {
        let db_failure = DbFailure {
            message: "lock poisoned".to_string(),
            kind: DbFailureKind::Lock,
        };
        let err = db_err("append_event", db_failure);
        assert_eq!(err.kind, "lock");
        let crish = err.to_crish();
        assert_eq!(crish.code, codes::STORE_WRITE_FAILED);
        assert!(crish.retryable);
    }
}
