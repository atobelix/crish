//! [`StoreNoteBackend`]：真实 store + DocSession 管线实现 `NoteBackend`。
//!
//! # SD-29 再切（构造 + trait 接线）
//! 本文件为 **门面：公开构造 + `NoteBackend` trait 接线**；长实现分模：
//! - [`crate::store_backend_apply`]：`apply_block_ops` / `apply_collab_ops_json` /
//!   query / `document_to_md` / detect·import·export（**SD-29**）
//! - [`crate::store_plan_ops`]：`plan_block_ops_to_collab`（plan→collab；SD-06，不重做）
//! - [`crate::store_hydrate`]：`ensure_session` / hydrate 冷热投影（SD-06，不重做）
//! - [`crate::store_apply_md`]：`apply_md_fragment` 真路径 + lossy（SD-06，不重做）
//! - [`crate::store_outline`]：大纲 DFS / 投影表（SD-06，不重做）
//! - [`store_backend_tests`]：集成测旁挂（`#[cfg(test)]`）
//!
//! # hydrate 投影（与 query 分轨）
//! - [`Self::hydrate_document_from_session`]：`load_doc` → **`DocSession::hydrate`**
//!   → CDCS 树 DFS 投影（`hydrate_path=doc-session`）
//! - `query_blocks`：派生索引读路径（`hydrate_path=query-blocks` 若被映射为打开投影）
//! - **≠** 产品「打开完成」（G-HYD 全条件）；**≠ EL-04 / EL-01**
//!
//! # 诚实边界
//! - **≠ EL-05**；**≠ A-AGT 满表**；**≠ W6-E**
//! - SD-29 **仅结构再切**，不抬关任何 EL / A-AGT；**≠** 整包重做 SD-06
//! - **G-HYD-5 / LR-H4-B**：`intents` HashMap **仅进程内**；杀进程 / 重开 db **可双插**；
//!   **≠** 落盘；**≠** 用 `send_intent_idempotent_*` 关 A-SURF-06 / EL

use agent_tools::note_backend::{
    NoteApplyMdRequest, NoteApplyMdResult, NoteBackend, NoteBackendError, NoteBatchTokens,
    NoteBlockBatchRequest, NoteBlockBatchResult, NoteOutline, NoteQueryBlocksParams,
    NoteQueryBlocksResult,
};
use async_trait::async_trait;
use conex_doc_collab::{DocSession, Origin};
use conex_workspace_store::{SharedWorkspaceStore, StoreError};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub use crate::store_backend_apply::ApplyCollabOpsOutcome;

/// 毒丸恢复计数（B1-1 观测化：本文件 sessions 索引锁 / per-doc 锁中毒恢复次数；
/// 对齐 registry.rs「tracing::error! 成对 + 计数」样板，零新依赖）
static POISON_RECOVERIES: AtomicU64 = AtomicU64::new(0);

/// 毒丸恢复计数读取（毒化测断言用；S3 埋点消费面就绪后解除 cfg(test)）
#[cfg(test)]
pub(crate) fn poison_recovery_count() -> u64 {
    POISON_RECOVERIES.load(Ordering::Relaxed)
}

/// S3 长锁等待告警阈值（毫秒）：per-doc 锁等待常态为 µs 级；
/// 超 10ms 视为争抢异常（B3 细锁后多 doc 互不串行，等待只来自同 doc 争抢）。
pub(crate) const SLOW_LOCK_WAIT_WARN_MS: u64 = 10;

/// S3 全文序列化告警阈值（毫秒）：`document_to_md` 全树转 MD 常态为 ms 级；
/// 超 100ms 视为异常（超大文档 / 设备负载异常）。
pub(crate) const SLOW_FULLTEXT_SERIALIZE_WARN_MS: u64 = 100;

/// S3 长锁等待 / 全文序列化探针（性能热点②-长锁等待 + ①-全文序列化）。
///
/// 使用形态（**锁内零新增**）：
/// ```text
/// let mut probe = SlowPathProbe::start(doc_id);  // 获取点前发起计时（锁外）
/// let session = arc.lock()...;                   // 既有获取（锁形态变化不失效）
/// probe.finish_lock();                           // acquire 返回后立即结束（仅时钟读）
/// ```
/// 阈值告警在守卫析构（锁释放后）由 [Drop] 发出——告警/日志路径**不在**锁内
/// 执行（对齐 REV-02「计数路径不在热路径锁内执行」人工核验项）；计时起点
/// 声明先于守卫 → 析构晚于守卫（Rust 局部变量逆序析构），保证告警在锁释放后。
pub(crate) struct SlowPathProbe<'a> {
    doc_id: &'a str,
    started: std::time::Instant,
    lock_wait: Option<Duration>,
    serialize_wait: Option<Duration>,
}

impl<'a> SlowPathProbe<'a> {
    /// 获取点前发起计时（锁外）。
    pub(crate) fn start(doc_id: &'a str) -> Self {
        Self {
            doc_id,
            started: std::time::Instant::now(),
            lock_wait: None,
            serialize_wait: None,
        }
    }

    /// acquire 返回后立即调用：结束锁等待计时（锁内零新增——仅一次时钟读）。
    pub(crate) fn finish_lock(&mut self) {
        self.lock_wait = Some(self.started.elapsed());
    }

    /// 记录全文序列化耗时（序列化本身是锁内既有工作；此处仅记录时钟读，
    /// 告警经 [Drop] 在锁释放后发出）。
    pub(crate) fn record_serialize(&mut self, elapsed: Duration) {
        self.serialize_wait = Some(elapsed);
    }
}

impl Drop for SlowPathProbe<'_> {
    fn drop(&mut self) {
        if let Some(wait) = self.lock_wait {
            let ms = wait.as_millis() as u64;
            if ms >= SLOW_LOCK_WAIT_WARN_MS {
                tracing::warn!(
                    target: "conex_note_runtime",
                    doc_id = %self.doc_id,
                    lock_wait_ms = ms,
                    "store per-doc 锁等待慢于阈值（S3 长锁等待热点）"
                );
            }
        }
        if let Some(wait) = self.serialize_wait {
            let ms = wait.as_millis() as u64;
            if ms >= SLOW_FULLTEXT_SERIALIZE_WARN_MS {
                tracing::warn!(
                    target: "conex_note_runtime",
                    doc_id = %self.doc_id,
                    serialize_ms = ms,
                    "全文序列化慢于阈值（S3 慢序列化热点）"
                );
            }
        }
    }
}

/// 真实笔记后端：SharedWorkspaceStore + 进程内 DocSession 表 + intent 幂等。
///
/// # 不变量
/// - 写路径仅 `apply_md_fragment` / [`Self::apply_block_ops`] /
///   [`Self::apply_collab_ops_json`]（CONN-B3 collab wire）→ Ops → `commit_ops`
///   （权威 updates + 投影索引）；**禁止** fs.write 当权威
/// - 读路径即时投影 / session 树 / `document_to_md`；**不**读 MD mirror 文件
/// - 同 `intent_id` 二次调用返回首次结果（`idempotent=true`, `inserted=0`）——**仅本进程**
/// - batch token：内嵌 [`NoteBatchTokens`]（与 Memory 后端同语义）
/// - **W4-A**：`ApplyReport.lossy` → [`NoteApplyMdResult::lossy`]（工具 result 可观测；
///   **禁止**只写 ops 丢 lossy）。**≠ EL-05 / ≠ A-AGT 满表**。
/// - **W4-F 余量**：`apply_block_ops` 真路径（dryRun 零写 / 原子 commit /
///   `force_execution_unknown` 不半写）。**≠ EL-05**；**≠ W6-E**；**≠ A-AGT 全表**。
pub struct StoreNoteBackend {
    pub(crate) store: SharedWorkspaceStore,
    /// 进程内打开的文档会话索引（**B3 per-doc 分片锁**：map 锁只保护索引
    /// get/insert 短临界；每条目为 doc 独立 `Mutex<DocSession>`，apply/outline/
    /// get_md 持 doc 锁长临界——多 doc 并发读写互不串行；锁条目数上界 =
    /// 打开的 doc 数，不随调用次数增长）。
    pub(crate) sessions: Mutex<HashMap<String, Arc<Mutex<DocSession>>>>,
    /// intent_id → 首次 apply 结果（send_to_note 幂等；**仅进程内**，不随 workspace.db 复活）
    pub(crate) intents: Mutex<HashMap<String, NoteApplyMdResult>>,
    pub(crate) batch_tokens: NoteBatchTokens,
}

impl std::fmt::Debug for StoreNoteBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let n_sessions = self.sessions.lock().map(|m| m.len()).unwrap_or(0);
        let n_intents = self.intents.lock().map(|m| m.len()).unwrap_or(0);
        f.debug_struct("StoreNoteBackend")
            .field("path", &self.store.path())
            .field("open_sessions", &n_sessions)
            .field("intent_cache", &n_intents)
            .finish()
    }
}

impl StoreNoteBackend {
    /// 打开（或创建）workspace.db。
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        Ok(Self::from_store(SharedWorkspaceStore::open(path)?))
    }

    /// 从已有共享 store 构造。
    pub fn from_store(store: SharedWorkspaceStore) -> Self {
        Self {
            store,
            sessions: Mutex::new(HashMap::new()),
            intents: Mutex::new(HashMap::new()),
            batch_tokens: NoteBatchTokens::new(),
        }
    }

    /// 自定义 batch TTL（测试）。
    pub fn with_batch_ttl(mut self, ttl: Duration) -> Self {
        self.batch_tokens = NoteBatchTokens::with_ttl(ttl);
        self
    }

    /// 暴露 batch token 管理（测试 / 会话装配）。
    pub fn batch_tokens(&self) -> &NoteBatchTokens {
        &self.batch_tokens
    }

    /// 底层 store 句柄。
    pub fn store(&self) -> &SharedWorkspaceStore {
        &self.store
    }

    /// 同步校验 batch token（apply_md / apply_block_ops 共用）。
    pub(crate) fn validate_batch_token_sync(
        &self,
        batch_id: Option<&str>,
    ) -> Result<(), NoteBackendError> {
        match batch_id {
            None => Ok(()),
            Some(id) => self.batch_tokens.validate(id),
        }
    }
}

// ── 跨模块错误 / Origin 映射（pub(crate)）──────────────────────────

/// StoreError → NoteBackendError。
pub(crate) fn map_store_err(e: StoreError) -> NoteBackendError {
    NoteBackendError::ApplyFailed(format!("store: {e}"))
}

/// CommitPipelineError → NoteBackendError。
pub(crate) fn map_commit_err(e: conex_workspace_store::CommitPipelineError) -> NoteBackendError {
    use conex_workspace_store::CommitPipelineError;
    match e {
        CommitPipelineError::Apply(ae) => {
            let s = ae.to_string();
            if s.contains("not found") {
                NoteBackendError::NotFound(s)
            } else if s.contains("id") && s.to_lowercase().contains("conflict") {
                NoteBackendError::IdConflict(s)
            } else if s.to_lowercase().contains("conflict") {
                // CT-01：CAS 陈旧写（PersistError::Conflict Display 含稳定 "conflict"）
                // → note.persist_conflict。置于 IdConflict 臂之后：先命中 id_conflict 的场景不变。
                NoteBackendError::Conflict(s)
            } else {
                NoteBackendError::ApplyFailed(s)
            }
        }
        CommitPipelineError::Store(se) => map_store_err(se),
    }
}

/// 从 apply_md 请求取 Origin。
pub(crate) fn origin_from_req(req: &NoteApplyMdRequest) -> Origin {
    origin_from_str(req.origin.as_deref())
}

/// origin 字符串 → collab Origin。
pub(crate) fn origin_from_str(origin: Option<&str>) -> Origin {
    match origin.map(str::trim) {
        Some("agent") | Some("Agent") => Origin::Agent,
        Some("remote") | Some("Remote") => Origin::Remote,
        Some("system") | Some("System") => Origin::System,
        _ => Origin::User,
    }
}

// ── NoteBackend trait 接线（长实现见 store_backend_apply / 兄弟模）──

#[async_trait]
impl NoteBackend for StoreNoteBackend {
    async fn query_blocks(
        &self,
        params: NoteQueryBlocksParams,
    ) -> Result<NoteQueryBlocksResult, NoteBackendError> {
        self.query_blocks_inner(params)
    }

    async fn document_outline(
        &self,
        doc_id: &str,
        max_depth: Option<u32>,
    ) -> Result<NoteOutline, NoteBackendError> {
        if doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let max_depth = max_depth.unwrap_or(6).clamp(1, 16);

        // 优先 session 树（文档序 DFS）；否则投影表（map 锁短临界取句柄，
        // doc 锁持读——B3：不同 doc 的 outline 互不串行）
        {
            let arc = self
                .sessions
                .lock()
                .unwrap_or_else(|e| {
                    // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                    tracing::error!(target: "conex_note_runtime", "sessions 索引锁中毒，按恢复模式继续：{e}");
                    POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                    e.into_inner()
                })
                .get(doc_id)
                .cloned();
            if let Some(arc) = arc {
                // S3 埋点：获取点前发起计时（锁外），acquire 返回后立即结束；告警锁外析构
                let mut probe = SlowPathProbe::start(doc_id);
                let session = arc.lock().unwrap_or_else(|e| {
                    // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                    tracing::error!(target: "conex_note_runtime", "sessions per-doc 锁中毒，按恢复模式继续：{e}");
                    POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                    e.into_inner()
                });
                probe.finish_lock();
                let outline = Self::build_outline_from_session(&session, max_depth);
                drop(session);
                return Ok(outline);
            }
        }
        self.build_outline_from_store(doc_id, max_depth)
    }

    async fn get_md(&self, doc_id: &str) -> Result<String, NoteBackendError> {
        // 即时 S：委托同步 `document_to_md`（禁止 mirror）
        self.document_to_md(doc_id)
    }

    async fn apply_md_fragment(
        &self,
        req: NoteApplyMdRequest,
    ) -> Result<NoteApplyMdResult, NoteBackendError> {
        self.apply_md_fragment_inner(req).await
    }

    async fn validate_batch_token(&self, batch_id: Option<&str>) -> Result<(), NoteBackendError> {
        self.validate_batch_token_sync(batch_id)
    }

    /// W4-F 余量：Store 真路径批 apply 块 ops（非默认 trait 拒写）。
    ///
    /// - dryRun：规划 preview，**零写**（不 `commit_ops`）
    /// - 实写：`plan` → 单次 `commit_ops`（原子；失败零半树）
    /// - `force_execution_unknown`：commit 前失败 → `note.execution_unknown`
    ///
    /// **≠ EL-05**；**≠ W6-E**；**≠ A-AGT 全表关闭**。
    async fn apply_block_ops(
        &self,
        req: NoteBlockBatchRequest,
    ) -> Result<NoteBlockBatchResult, NoteBackendError> {
        self.apply_block_ops_inner(req)
    }
}

// hydrate / apply_md / outline / apply 方法由兄弟模块 `impl StoreNoteBackend` 提供。
// 强制链接：本 crate 内 `mod store_*` 已在 lib.rs 声明。

#[cfg(test)]
#[path = "store_backend_tests.rs"]
mod tests;
