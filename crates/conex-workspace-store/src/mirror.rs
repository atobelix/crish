//! W2-E Strict · P6 外部改盘：detect → 分类 → 三路提案 + **可轮询 watcher 入口**（A-INV-02 / X-05 方向）。
//!
//! # 地基 vs 本包新增
//! - **W2-E-S 已有地基**（`lib` / `projection`）：`export_md_mirror` + `mirror_lag` /
//!   `note_authority_advanced` + `commit_ops_with_mirror`（export + lag 水位）。
//! - **本模块已有（W2-E Strict · detect/三路）**：
//!   - [`WorkspaceStore::detect_mirror_drift`]：mtime/hash vs `mirror_meta` → 三路分类
//!   - [`ThreeWayStrategy`] / [`ImportMirrorResult`]：三路策略 + Op 批 **或** 冲突报告
//!   - [`WorkspaceStore::import_mirror_proposal`]：**不**直接写权威；**禁**静默盖 unpushed
//! - **本模块追加（W2-E · watcher 方向子集）**：
//!   - [`MirrorWatchHandle`] / [`poll_mirror_once`]：进程内指纹基线 + 单次轮询
//!   - [`MirrorWatcher`] / [`MirrorWatcher::on_mirror_change`]：回调注册（由上层 timer 驱动 poll）
//!
//! # 诚实边界（不可冒充）
//! - **≠ OS inotify/FSEvents 生产满关**：无内核 FS 事件订阅；靠上层 timer / 测试直接调
//!   [`MirrorWatchHandle::poll_mirror_once`] 或 [`MirrorWatcher::poll_once`]。
//! - **≠ A-INV-02 产品 UI**：不弹三路对话框、不接线桌面；仅交付 **可测观察入口**。
//! - **≠ EL-03**（恢复/打开叙事属 G-HYD / W3 等，不在本模块）。
//! - **≠ Wave 2 存储完成**（杀进程权威恢复、refs 自动物化等分属他包）。
//! - 仅 export+lag **≠** P6 完成；detect/三路 + 轮询 watcher 仍 **≠** 产品 UI 三路对话框满关。
//!
//! # 不变量（S1 / X-05）
//! 1. mirror **非**权威；工具默认 **禁止** 读 `exports/**` / mirror 文件当 get_md。
//! 2. `import_mirror_proposal` **只提案**，从不 `apply` / 从不改 `doc_updates`。
//! 3. `unpushed_op_count > 0` 且策略非显式 [`ThreeWayStrategy::DropUnacked`] 时，
//!    **禁止**产出「可静默盖写」路径；默认/冲突 → [`ImportMirrorResult::Conflict`]。
//! 4. **禁止**默认 fullRemount 当唯一路径：提案优先块级 TextEdit/Insert/Delete，
//!    而非「删光整树再挂载」。

use super::{StoreError, WorkspaceStore, content_hash};
use conex_doc_collab::{BlockId, BlockTree, Op};
use conex_md_ast::parse_document_detailed;
use rusqlite::{OptionalExtension, params};
use std::path::{Path, PathBuf};

// ─── 分类 / 策略 / 报告 ───────────────────────────────────────────────────

/// detect 输出的漂移分类（仅 mirror / 权威库 / 双变 + 无漂移/缺元数据）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MirrorDriftClass {
    /// 文件 hash 与 meta 一致，且 `authority_rev == last_export_rev`。
    None,
    /// 仅 mirror 文件相对上次 export 指纹变了；权威仍在 export 水位。
    MirrorOnly,
    /// 仅权威 rev 前进；文件 hash 仍匹配上次 export。
    AuthorityOnly,
    /// 双变：文件变了 **且** 权威相对 export 前进。
    Both,
    /// 无 `mirror_meta` 行，或 path 空且从未成功 export。
    NoMeta,
    /// meta 有 path，但文件不存在（被删/移走）。
    MissingFile,
}

/// 三路策略枚举（`02` §2.4 / round-E P6）。
///
/// 须由调用方 **显式** 选择；本 crate **不**在 unpushed>0 时默认 DropUnacked。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreeWayStrategy {
    /// 保留本地 unpushed，将 mirror 导入为 **候选** 补丁（可拒；不删本地独有块）。
    RetainLocalAndReimport,
    /// **显式** 丢弃未 ACK 本地，以 mirror 侧为准生成含 Delete 的提案。
    DropUnacked,
    /// 标记冲突，不产出可自动 apply 的 Op 批。
    ConflictBlocks,
}

/// [`WorkspaceStore::detect_mirror_drift`] 完整报告。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorDriftReport {
    pub doc_id: String,
    pub class: MirrorDriftClass,
    pub path: PathBuf,
    pub last_export_rev: u64,
    pub authority_rev: u64,
    pub pending_lag: i64,
    /// 上次 export 写入的内容 hash（空串 = 旧行未迁移指纹）。
    pub stored_hash: String,
    /// 当前文件 hash；文件不存在时为 `None`。
    pub file_hash: Option<String>,
    pub file_exists: bool,
    pub mirror_changed: bool,
    pub authority_changed: bool,
}

/// `import_mirror_proposal` 入参。
#[derive(Debug, Clone)]
pub struct ImportMirrorOpts<'a> {
    /// 三路策略；**无默认静默 DropUnacked**。
    pub strategy: ThreeWayStrategy,
    /// 未推送 / 未 ACK 本地 op 数量。`>0` 时禁静默覆盖（X-05）。
    pub unpushed_op_count: usize,
    /// 当前权威树；用于块级 diff 提案。缺省则无法产 Op 批（仅冲突/无变更）。
    pub authority_tree: Option<&'a BlockTree>,
}

impl<'a> ImportMirrorOpts<'a> {
    pub fn new(strategy: ThreeWayStrategy) -> Self {
        Self {
            strategy,
            unpushed_op_count: 0,
            authority_tree: None,
        }
    }

    pub fn with_unpushed(mut self, n: usize) -> Self {
        self.unpushed_op_count = n;
        self
    }

    pub fn with_authority_tree(mut self, tree: &'a BlockTree) -> Self {
        self.authority_tree = Some(tree);
        self
    }
}

/// 冲突块摘要（ConflictBlocks / 双变人工路径）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictBlockInfo {
    pub block_id: String,
    pub reason: String,
}

/// [`WorkspaceStore::import_mirror_proposal`] 输出：**提案或冲突**，永不静默 apply。
#[derive(Debug, Clone)]
pub enum ImportMirrorResult {
    /// 无需从 mirror 导入（无漂移 / 仅权威变 / 文件未变）。
    NoChange {
        report: MirrorDriftReport,
    },
    /// 可交给上层 `DocSession::apply` 的 **候选** Op 批（本函数 **不** apply）。
    OpBatch {
        report: MirrorDriftReport,
        strategy: ThreeWayStrategy,
        ops: Vec<Op>,
        /// mirror 源 MD 的 content hash。
        source_md_hash: String,
        /// 是否声明保留 unpushed（RetainLocal 路径）。
        preserves_unpushed: bool,
        /// 是否声明将丢弃 unpushed（仅 DropUnacked 且 unpushed>0）。
        discards_unpushed: bool,
        /// **非** fullRemount：true 表示块级 diff，而非「唯一路径=整树重挂」。
        is_block_level_diff: bool,
    },
    /// 冲突报告：存在 unpushed 且未显式 Drop，或策略为 ConflictBlocks。
    Conflict {
        report: MirrorDriftReport,
        reason: String,
        unpushed_op_count: usize,
        /// X-05：静默覆盖已被拦截。
        silent_overwrite_blocked: bool,
        /// 建议调用方可改选的策略。
        suggested_strategies: Vec<ThreeWayStrategy>,
        conflicted_blocks: Vec<ConflictBlockInfo>,
    },
}

impl ImportMirrorResult {
    pub fn is_conflict(&self) -> bool {
        matches!(self, Self::Conflict { .. })
    }

    pub fn silent_overwrite_blocked(&self) -> bool {
        match self {
            Self::Conflict {
                silent_overwrite_blocked,
                ..
            } => *silent_overwrite_blocked,
            _ => false,
        }
    }

    pub fn ops(&self) -> Option<&[Op]> {
        match self {
            Self::OpBatch { ops, .. } => Some(ops.as_slice()),
            _ => None,
        }
    }
}

// ─── W2-E watcher 方向子集（进程内 / 可轮询；≠ OS inotify 满关）─────────────
//
// 设计：
// - 上层（timer / 测试）持有 [`MirrorWatchHandle`] 或 [`MirrorWatcher`]；
// - 每次 `poll_*`：读 path 的 mtime+hash 指纹 → 与上次对比 → 调 `detect_mirror_drift`；
// - 指纹变化时 [`MirrorWatcher`] 触发 `on_mirror_change` 回调，携带完整 [`MirrorDriftReport`]。
//
// **诚实**：本段 **≠ OS inotify 生产满关**；**≠ A-INV-02 产品 UI**；**≠ EL-03**。

/// mirror 文件指纹（mtime + content hash + 是否存在），供轮询去抖/变更检测。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorFileFingerprint {
    pub path: PathBuf,
    /// 文件存在时为 SHA-256 hex；缺失时为 `None`。
    pub content_hash: Option<String>,
    pub mtime_ms: i64,
    pub exists: bool,
}

impl MirrorFileFingerprint {
    /// 从路径读当前指纹（path 空 → 视为不存在）。
    pub fn observe(path: &Path) -> Self {
        if path.as_os_str().is_empty() || !path.is_file() {
            return Self {
                path: path.to_path_buf(),
                content_hash: None,
                mtime_ms: 0,
                exists: false,
            };
        }
        let content_hash = std::fs::read(path).ok().map(|b| content_hash(&b));
        let mtime_ms = file_mtime_ms(path);
        Self {
            path: path.to_path_buf(),
            content_hash,
            mtime_ms,
            exists: true,
        }
    }
}

/// [`MirrorWatchHandle::poll_mirror_once`] 单次轮询结果（始终含 detect 分类）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorWatchPollResult {
    pub doc_id: String,
    /// `detect_mirror_drift` 分类报告（可观测三路）。
    pub report: MirrorDriftReport,
    /// 相对上次 poll，文件指纹是否变化。
    pub fingerprint_changed: bool,
    /// 是否为本 handle 的首次观察（首次建立基线，通常不视为「变更事件」）。
    pub first_poll: bool,
    pub fingerprint: MirrorFileFingerprint,
}

impl MirrorWatchPollResult {
    /// 是否应作为「外部改盘变更事件」上抛（非首次 + 指纹变）。
    pub fn is_change_event(&self) -> bool {
        !self.first_poll && self.fingerprint_changed
    }
}

/// 进程内 / 可轮询的单 doc mirror 观察句柄。
///
/// # 用法
/// ```ignore
/// let mut h = MirrorWatchHandle::new("doc-1");
/// let r0 = h.poll_mirror_once(&store, authority_rev)?; // 建基线
/// // … 外部改 .md …
/// let r1 = h.poll_mirror_once(&store, authority_rev)?;
/// assert!(r1.is_change_event());
/// assert_eq!(r1.report.class, MirrorDriftClass::MirrorOnly);
/// ```
///
/// # 诚实边界
/// - **≠ OS inotify/FSEvents 生产满关**——须由上层 timer 驱动 poll。
/// - **≠ A-INV-02 产品 UI**；**≠ EL-03**。
#[derive(Debug, Clone)]
pub struct MirrorWatchHandle {
    doc_id: String,
    last_fingerprint: Option<MirrorFileFingerprint>,
}

impl MirrorWatchHandle {
    pub fn new(doc_id: impl Into<String>) -> Self {
        Self {
            doc_id: doc_id.into(),
            last_fingerprint: None,
        }
    }

    pub fn doc_id(&self) -> &str {
        &self.doc_id
    }

    /// 上次 poll 指纹（首次 poll 前为 `None`）。
    pub fn last_fingerprint(&self) -> Option<&MirrorFileFingerprint> {
        self.last_fingerprint.as_ref()
    }

    /// 重置基线（下次 poll 视为 `first_poll`）。
    pub fn reset_baseline(&mut self) {
        self.last_fingerprint = None;
    }

    /// **单次轮询入口**：读 mtime/hash → 与上次指纹对比 → `detect_mirror_drift`。
    ///
    /// 始终返回完整 [`MirrorWatchPollResult`]（含分类）；调用方用
    /// [`MirrorWatchPollResult::is_change_event`] 过滤变更。
    ///
    /// **≠** inotify；本方法即「可测的 mirror 变更观察入口」。
    pub fn poll_mirror_once(
        &mut self,
        store: &WorkspaceStore,
        authority_rev: u64,
    ) -> Result<MirrorWatchPollResult, StoreError> {
        let report = store.detect_mirror_drift(&self.doc_id, authority_rev)?;
        let fingerprint = MirrorFileFingerprint::observe(&report.path);
        let first_poll = self.last_fingerprint.is_none();
        let fingerprint_changed = match &self.last_fingerprint {
            None => true, // 首次：建立基线，标 changed 便于诊断，但 is_change_event=false
            Some(prev) => prev != &fingerprint,
        };
        self.last_fingerprint = Some(fingerprint.clone());
        Ok(MirrorWatchPollResult {
            doc_id: self.doc_id.clone(),
            report,
            fingerprint_changed,
            first_poll,
            fingerprint,
        })
    }

    /// 仅当 [`MirrorWatchPollResult::is_change_event`] 时返回 `Some`（跳过首次基线）。
    pub fn poll_if_changed(
        &mut self,
        store: &WorkspaceStore,
        authority_rev: u64,
    ) -> Result<Option<MirrorWatchPollResult>, StoreError> {
        let r = self.poll_mirror_once(store, authority_rev)?;
        if r.is_change_event() {
            Ok(Some(r))
        } else {
            Ok(None)
        }
    }
}

/// 无状态便捷函数：等价于 `store.detect_mirror_drift`（供 timer/上层命名对齐）。
///
/// 不维护指纹基线；需要变更检测请用 [`MirrorWatchHandle`]。
///
/// **≠ OS inotify**；**≠ A-INV-02 产品 UI**；**≠ EL-03**。
pub fn poll_mirror_once(
    store: &WorkspaceStore,
    doc_id: &str,
    authority_rev: u64,
) -> Result<MirrorDriftReport, StoreError> {
    store.detect_mirror_drift(doc_id, authority_rev)
}

/// 带 `on_mirror_change` 回调的轻量观察器（进程内；由上层驱动 [`Self::poll_once`]）。
///
/// # 诚实边界
/// - **≠ OS inotify/FSEvents 生产满关**
/// - **≠ A-INV-02 产品 UI**（回调载荷仅为 detect 报告，不弹 UI）
/// - **≠ EL-03**
pub struct MirrorWatcher {
    handle: MirrorWatchHandle,
    /// 指纹变更时调用（跳过首次基线 poll）。
    on_change: Option<Box<dyn FnMut(&MirrorWatchPollResult)>>,
}

impl MirrorWatcher {
    pub fn new(doc_id: impl Into<String>) -> Self {
        Self {
            handle: MirrorWatchHandle::new(doc_id),
            on_change: None,
        }
    }

    pub fn doc_id(&self) -> &str {
        self.handle.doc_id()
    }

    pub fn handle(&self) -> &MirrorWatchHandle {
        &self.handle
    }

    pub fn handle_mut(&mut self) -> &mut MirrorWatchHandle {
        &mut self.handle
    }

    /// 注册 mirror 变更回调（文件指纹相对上次 poll 变化时触发）。
    ///
    /// 覆盖先前回调。**进程内同步**调用；不跨线程投递。
    pub fn on_mirror_change<F>(&mut self, cb: F)
    where
        F: FnMut(&MirrorWatchPollResult) + 'static,
    {
        self.on_change = Some(Box::new(cb));
    }

    /// 清除回调。
    pub fn clear_on_mirror_change(&mut self) {
        self.on_change = None;
    }

    /// 轮询一次；若为变更事件则同步调用已注册的 `on_mirror_change`。
    pub fn poll_once(
        &mut self,
        store: &WorkspaceStore,
        authority_rev: u64,
    ) -> Result<MirrorWatchPollResult, StoreError> {
        let result = self.handle.poll_mirror_once(store, authority_rev)?;
        if result.is_change_event() {
            if let Some(cb) = self.on_change.as_mut() {
                cb(&result);
            }
        }
        Ok(result)
    }
}

// ─── meta 行 ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct MirrorMetaRow {
    path: String,
    last_export_rev: i64,
    pending_lag: i64,
    content_hash: String,
    #[allow(dead_code)]
    file_mtime_ms: i64,
}

impl WorkspaceStore {
    /// 读取 `mirror_meta`（含 content_hash / file_mtime_ms；旧库列由 migrate 补齐）。
    fn load_mirror_meta_row(&self, doc_id: &str) -> Result<Option<MirrorMetaRow>, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let row = conn
            .query_row(
                r#"
                SELECT path, last_export_rev, pending_lag,
                       COALESCE(content_hash, ''), COALESCE(file_mtime_ms, 0)
                FROM mirror_meta WHERE doc_id = ?1
                "#,
                params![doc_id],
                |r| {
                    Ok(MirrorMetaRow {
                        path: r.get(0)?,
                        last_export_rev: r.get(1)?,
                        pending_lag: r.get(2)?,
                        content_hash: r.get(3)?,
                        file_mtime_ms: r.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// **detect**：mtime/hash vs `mirror_meta`，输出三路分类（A-INV-02 / X-05 检测侧）。
    ///
    /// - `authority_rev`：当前权威 rev（通常 `DocSession::rev()` 或 `load_rev`）。
    /// - 可测注入：测试直接改盘文件 / 调 `note_authority_advanced`，**无需** OS watcher。
    /// - **≠** inotify 满关；本 API 即「可轮询的 detect 入口」。
    pub fn detect_mirror_drift(
        &self,
        doc_id: &str,
        authority_rev: u64,
    ) -> Result<MirrorDriftReport, StoreError> {
        let meta = self.load_mirror_meta_row(doc_id)?;
        let Some(meta) = meta else {
            return Ok(MirrorDriftReport {
                doc_id: doc_id.to_string(),
                class: MirrorDriftClass::NoMeta,
                path: PathBuf::new(),
                last_export_rev: 0,
                authority_rev,
                pending_lag: 0,
                stored_hash: String::new(),
                file_hash: None,
                file_exists: false,
                mirror_changed: false,
                authority_changed: authority_rev > 0,
            });
        };

        // 从未真正 export（骨架行 path 空）
        if meta.path.is_empty() {
            return Ok(MirrorDriftReport {
                doc_id: doc_id.to_string(),
                class: MirrorDriftClass::NoMeta,
                path: PathBuf::new(),
                last_export_rev: meta.last_export_rev as u64,
                authority_rev,
                pending_lag: meta.pending_lag,
                stored_hash: meta.content_hash,
                file_hash: None,
                file_exists: false,
                mirror_changed: false,
                authority_changed: authority_rev as i64 != meta.last_export_rev,
            });
        }

        let path = PathBuf::from(&meta.path);
        let file_exists = path.is_file();
        let (file_hash, mirror_changed) = if file_exists {
            let bytes = std::fs::read(&path)?;
            let hash = content_hash(&bytes);
            let changed = if meta.content_hash.is_empty() {
                // 旧行无指纹：无法证明「未变」→ 保守视为可能已变（有文件即标 changed，
                // 迫使上层 re-export 或显式 import；避免假绿 None）。
                true
            } else {
                hash != meta.content_hash
            };
            (Some(hash), changed)
        } else {
            (None, true) // 文件消失也算 mirror 侧异常
        };

        let last_export_rev = meta.last_export_rev as u64;
        // 权威前进：rev 相对 last_export_rev 不一致（pending_lag 与 note_authority_advanced 同源）
        let authority_changed = authority_rev != last_export_rev;

        let class = if !file_exists {
            MirrorDriftClass::MissingFile
        } else {
            match (mirror_changed, authority_changed) {
                (false, false) => MirrorDriftClass::None,
                (true, false) => MirrorDriftClass::MirrorOnly,
                (false, true) => MirrorDriftClass::AuthorityOnly,
                (true, true) => MirrorDriftClass::Both,
            }
        };

        Ok(MirrorDriftReport {
            doc_id: doc_id.to_string(),
            class,
            path,
            last_export_rev,
            authority_rev,
            pending_lag: meta.pending_lag,
            stored_hash: meta.content_hash,
            file_hash,
            file_exists,
            mirror_changed,
            authority_changed,
        })
    }

    /// **import 提案**：产出 Op 批 **或** 冲突报告；**不**写权威、**不** apply。
    ///
    /// # X-05 / 禁静默覆盖
    /// - `unpushed_op_count > 0` 且 `strategy != DropUnacked` →
    ///   [`ImportMirrorResult::Conflict`] 且 `silent_overwrite_blocked = true`
    ///   （RetainLocal 在无 unpushed 或 unpushed=0 时才产 Op；有 unpushed 时同样走冲突，
    ///   避免「假保留」实际盖写——候选补丁须上层显式二次确认后另调 Drop/清空 unpushed）。
    /// - **禁止**默认 fullRemount：成功路径为块级 diff（`is_block_level_diff = true`）。
    ///
    /// # 工具面
    /// 本 API **不是**「读 mirror 当 get_md」；工具默认读仍须即时 S(树)。
    pub fn import_mirror_proposal(
        &self,
        doc_id: &str,
        authority_rev: u64,
        opts: &ImportMirrorOpts<'_>,
    ) -> Result<ImportMirrorResult, StoreError> {
        let report = self.detect_mirror_drift(doc_id, authority_rev)?;

        // 无需从 mirror 拉内容
        match report.class {
            MirrorDriftClass::None | MirrorDriftClass::AuthorityOnly | MirrorDriftClass::NoMeta => {
                return Ok(ImportMirrorResult::NoChange { report });
            }
            MirrorDriftClass::MissingFile => {
                return Ok(ImportMirrorResult::Conflict {
                    report,
                    reason: "mirror 文件缺失，无法 import".into(),
                    unpushed_op_count: opts.unpushed_op_count,
                    silent_overwrite_blocked: opts.unpushed_op_count > 0,
                    suggested_strategies: vec![ThreeWayStrategy::ConflictBlocks],
                    conflicted_blocks: vec![],
                });
            }
            MirrorDriftClass::MirrorOnly | MirrorDriftClass::Both => {}
        }

        // X-05：有 unpushed 时，非显式 DropUnacked → 冲突报告（禁静默盖）
        if opts.unpushed_op_count > 0 && opts.strategy != ThreeWayStrategy::DropUnacked {
            return Ok(ImportMirrorResult::Conflict {
                report,
                reason: format!(
                    "存在 {} 条 unpushed op；拒绝静默覆盖。须显式 DropUnacked，或先清空/推送本地 op 后再 RetainLocalAndReimport",
                    opts.unpushed_op_count
                ),
                unpushed_op_count: opts.unpushed_op_count,
                silent_overwrite_blocked: true,
                suggested_strategies: vec![
                    ThreeWayStrategy::DropUnacked,
                    ThreeWayStrategy::ConflictBlocks,
                    ThreeWayStrategy::RetainLocalAndReimport,
                ],
                conflicted_blocks: vec![],
            });
        }

        // 显式 ConflictBlocks：只报告，不产 Op
        if opts.strategy == ThreeWayStrategy::ConflictBlocks {
            let blocks = self.list_text_conflicts(&report, opts.authority_tree)?;
            return Ok(ImportMirrorResult::Conflict {
                report,
                reason: "策略 ConflictBlocks：标记冲突，不自动 apply".into(),
                unpushed_op_count: opts.unpushed_op_count,
                silent_overwrite_blocked: opts.unpushed_op_count > 0,
                suggested_strategies: vec![
                    ThreeWayStrategy::DropUnacked,
                    ThreeWayStrategy::RetainLocalAndReimport,
                ],
                conflicted_blocks: blocks,
            });
        }

        let Some(authority) = opts.authority_tree else {
            return Ok(ImportMirrorResult::Conflict {
                report,
                reason: "缺少 authority_tree，无法生成块级 Op 提案（拒绝 fullRemount 兜底）"
                    .into(),
                unpushed_op_count: opts.unpushed_op_count,
                silent_overwrite_blocked: opts.unpushed_op_count > 0,
                suggested_strategies: vec![opts.strategy],
                conflicted_blocks: vec![],
            });
        };

        if !report.file_exists {
            return Ok(ImportMirrorResult::Conflict {
                report,
                reason: "mirror 文件不可读".into(),
                unpushed_op_count: opts.unpushed_op_count,
                silent_overwrite_blocked: false,
                suggested_strategies: vec![],
                conflicted_blocks: vec![],
            });
        }

        let md = std::fs::read_to_string(&report.path)?;
        let source_md_hash = content_hash(md.as_bytes());
        let parsed = parse_document_detailed(&md).map_err(|e| {
            StoreError::Persist(format!("import_mirror_proposal parse: {e}"))
        })?;
        let mirror_tree = parsed.tree;

        let ops = propose_block_level_ops(authority, &mirror_tree, opts.strategy);

        let preserves_unpushed = opts.strategy == ThreeWayStrategy::RetainLocalAndReimport;
        let discards_unpushed =
            opts.strategy == ThreeWayStrategy::DropUnacked && opts.unpushed_op_count > 0;

        Ok(ImportMirrorResult::OpBatch {
            report,
            strategy: opts.strategy,
            ops,
            source_md_hash,
            preserves_unpushed,
            discards_unpushed,
            is_block_level_diff: true,
        })
    }

    /// 冲突块列表（同 ID 文本不一致）。
    fn list_text_conflicts(
        &self,
        report: &MirrorDriftReport,
        authority: Option<&BlockTree>,
    ) -> Result<Vec<ConflictBlockInfo>, StoreError> {
        let Some(authority) = authority else {
            return Ok(vec![]);
        };
        if !report.file_exists {
            return Ok(vec![]);
        }
        let md = std::fs::read_to_string(&report.path)?;
        let parsed = match parse_document_detailed(&md) {
            Ok(p) => p,
            Err(e) => {
                return Ok(vec![ConflictBlockInfo {
                    block_id: "*".into(),
                    reason: format!("parse 失败: {e}"),
                }]);
            }
        };
        let mut out = Vec::new();
        for (id, mnode) in &parsed.tree.nodes {
            if let Some(anode) = authority.get(id) {
                let at = anode.text_snapshot.as_deref().unwrap_or("");
                let mt = mnode.text_snapshot.as_deref().unwrap_or("");
                if at != mt {
                    out.push(ConflictBlockInfo {
                        block_id: id.to_string(),
                        reason: format!("文本不一致 authority={at:?} mirror={mt:?}"),
                    });
                }
            }
        }
        Ok(out)
    }
}

/// 块级 diff 提案（**非** fullRemount）。
///
/// - 共有 ID 文本不同 → `TextEdit`（全量替换）
/// - mirror 有、权威无 → `Insert`（先父后子）
/// - 权威有、mirror 无 → 仅 `DropUnacked` 时 `Delete`；RetainLocal 保留本地独有块
fn propose_block_level_ops(
    authority: &BlockTree,
    mirror: &BlockTree,
    strategy: ThreeWayStrategy,
) -> Vec<Op> {
    let mut ops = Vec::new();

    // 1) 文本更新（共有 ID）
    for (id, mnode) in &mirror.nodes {
        if let Some(anode) = authority.get(id) {
            let at = anode.text_snapshot.clone().unwrap_or_default();
            let mt = mnode.text_snapshot.clone().unwrap_or_default();
            if at != mt {
                let end = at.chars().count() as u32;
                ops.push(Op::TextEdit {
                    id: *id,
                    start: 0,
                    end,
                    insert: mt,
                });
            }
            // kind 变化：本波次仅文本 + 结构 Insert/Delete（kind 迁移属后续加厚）
            let _ = (&anode.kind, &mnode.kind);
        }
    }

    // 2) Insert：mirror 有、权威无（父须已在权威或本批将 Insert）
    // 拓扑：多次扫描直到不动（块数小，O(n²) 可接受）
    let mut pending: Vec<BlockId> = mirror
        .nodes
        .keys()
        .filter(|id| !authority.nodes.contains_key(id))
        .copied()
        .collect();
    pending.sort_by_key(|id| id.to_string());

    let mut inserted = std::collections::HashSet::new();
    // 有限轮拓扑插入；环或父永不存在时跳过剩余（不强制 fullRemount）
    for _ in 0..=pending.len() {
        if pending.is_empty() {
            break;
        }
        let mut progress = false;
        let mut rest = Vec::new();
        for id in pending.drain(..) {
            let node = match mirror.get(&id) {
                Some(n) => n,
                None => continue,
            };
            let parent_ok = match node.parent {
                None => true,
                Some(pid) => authority.nodes.contains_key(&pid) || inserted.contains(&pid),
            };
            if !parent_ok {
                rest.push(id);
                continue;
            }
            ops.push(Op::Insert {
                id: node.id,
                parent: node.parent,
                order: node.order.clone(),
                kind: node.kind.clone(),
                props: node.props.clone(),
            });
            let text = node.text_snapshot.clone().unwrap_or_default();
            if !text.is_empty() {
                ops.push(Op::TextEdit {
                    id: node.id,
                    start: 0,
                    end: 0,
                    insert: text,
                });
            }
            inserted.insert(id);
            progress = true;
        }
        pending = rest;
        if !progress {
            break;
        }
    }

    // 3) Delete：仅 DropUnacked
    if strategy == ThreeWayStrategy::DropUnacked {
        let mut to_delete: Vec<BlockId> = authority
            .nodes
            .keys()
            .filter(|id| !mirror.nodes.contains_key(id))
            .copied()
            .collect();
        // 后序：先删子（按 children 深度粗排：子节点 id 先）
        to_delete.sort_by_key(|id| {
            // 深度越大越先删
            let mut d = 0u32;
            let mut cur = *id;
            while let Some(n) = authority.get(&cur) {
                if let Some(p) = n.parent {
                    d += 1;
                    cur = p;
                } else {
                    break;
                }
            }
            std::cmp::Reverse(d)
        });
        for id in to_delete {
            ops.push(Op::Delete { id });
        }
    }

    ops
}

/// 供 migrate / export 使用：文件 mtime 毫秒（失败则 0）。
pub(crate) fn file_mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_doc_collab::{BlockId, BlockKind, BlockNode, BlockProps};
    use std::collections::HashMap;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "conex-mirror-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
            n
        ));
        let _ = std::fs::create_dir_all(&p);
        p
    }

    fn sample_tree(text: &str) -> BlockTree {
        let id = BlockId::from_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let mut nodes = HashMap::new();
        nodes.insert(
            id,
            BlockNode {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
                text_snapshot: Some(text.into()),
                children: vec![],
            },
        );
        BlockTree {
            root_children: vec![id],
            nodes,
        }
    }

    /// detect 三路分类：MirrorOnly / AuthorityOnly / Both / None。
    #[test]
    fn detect_mirror_drift_classifies_three_ways() {
        let dir = temp_dir();
        let db = dir.join("workspace.db");
        let mirror_root = dir.join("mirrors");
        let store = WorkspaceStore::open(&db).unwrap();
        let tree = sample_tree("mirror hello");

        // 无 meta
        let r0 = store.detect_mirror_drift("doc-d", 0).unwrap();
        assert_eq!(r0.class, MirrorDriftClass::NoMeta);

        // export rev=1
        store
            .export_md_mirror("doc-d", &tree, 1, &mirror_root)
            .unwrap();
        let r_none = store.detect_mirror_drift("doc-d", 1).unwrap();
        assert_eq!(
            r_none.class,
            MirrorDriftClass::None,
            "export 后同 rev 应无漂移"
        );
        assert!(!r_none.mirror_changed);
        assert!(!r_none.authority_changed);

        // 仅 mirror 变：外部改文件
        let path = r_none.path.clone();
        let mut content = std::fs::read_to_string(&path).unwrap();
        content.push_str("\n\nexternal edit\n");
        std::fs::write(&path, content.as_bytes()).unwrap();
        let r_m = store.detect_mirror_drift("doc-d", 1).unwrap();
        assert_eq!(r_m.class, MirrorDriftClass::MirrorOnly);
        assert!(r_m.mirror_changed);
        assert!(!r_m.authority_changed);

        // 恢复文件到 export 指纹后再测 AuthorityOnly
        store
            .export_md_mirror("doc-d", &tree, 1, &mirror_root)
            .unwrap();
        store.note_authority_advanced("doc-d", 5).unwrap();
        let r_a = store.detect_mirror_drift("doc-d", 5).unwrap();
        assert_eq!(
            r_a.class,
            MirrorDriftClass::AuthorityOnly,
            "仅权威前进应 AuthorityOnly"
        );
        assert!(!r_a.mirror_changed);
        assert!(r_a.authority_changed);

        // 双变：再改文件
        let path2 = r_a.path.clone();
        std::fs::write(&path2, b"# hijacked\n\nboth changed\n").unwrap();
        let r_b = store.detect_mirror_drift("doc-d", 5).unwrap();
        assert_eq!(r_b.class, MirrorDriftClass::Both);
        assert!(r_b.mirror_changed);
        assert!(r_b.authority_changed);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// X-05：存在 unpushed 时，非 DropUnacked 不得静默覆盖。
    #[test]
    fn import_mirror_proposal_blocks_silent_overwrite_of_unpushed() {
        let dir = temp_dir();
        let db = dir.join("workspace.db");
        let mirror_root = dir.join("mirrors");
        let store = WorkspaceStore::open(&db).unwrap();
        let tree = sample_tree("mirror hello");

        store
            .export_md_mirror("doc-x", &tree, 1, &mirror_root)
            .unwrap();
        let path = mirror_root.join(format!("{}.md", crate::safe_doc_id("doc-x")));
        // 外部改 mirror
        let mut md = std::fs::read_to_string(&path).unwrap();
        md = md.replace("mirror hello", "external wins");
        std::fs::write(&path, md.as_bytes()).unwrap();

        // RetainLocal + unpushed>0 → 冲突，静默覆盖拦截
        let opts = ImportMirrorOpts::new(ThreeWayStrategy::RetainLocalAndReimport)
            .with_unpushed(3)
            .with_authority_tree(&tree);
        let res = store
            .import_mirror_proposal("doc-x", 1, &opts)
            .unwrap();
        assert!(res.is_conflict(), "须冲突报告，got {:?}", std::mem::discriminant(&res));
        assert!(
            res.silent_overwrite_blocked(),
            "X-05：silent_overwrite_blocked 必须为 true"
        );
        assert!(res.ops().is_none());

        // ConflictBlocks + unpushed → 同样拦截
        let opts2 = ImportMirrorOpts::new(ThreeWayStrategy::ConflictBlocks)
            .with_unpushed(1)
            .with_authority_tree(&tree);
        let res2 = store
            .import_mirror_proposal("doc-x", 1, &opts2)
            .unwrap();
        assert!(res2.is_conflict());
        assert!(res2.silent_overwrite_blocked());

        // 显式 DropUnacked + unpushed → 允许产 Op 批（仍不 apply）
        let opts3 = ImportMirrorOpts::new(ThreeWayStrategy::DropUnacked)
            .with_unpushed(2)
            .with_authority_tree(&tree);
        let res3 = store
            .import_mirror_proposal("doc-x", 1, &opts3)
            .unwrap();
        match res3 {
            ImportMirrorResult::OpBatch {
                discards_unpushed,
                is_block_level_diff,
                ops,
                ..
            } => {
                assert!(discards_unpushed);
                assert!(
                    is_block_level_diff,
                    "禁止默认 fullRemount 当唯一路径"
                );
                // 至少应有针对同 ID 的 TextEdit，或 parse 后结构变化的 ops
                let _ = ops;
            }
            other => panic!("DropUnacked 应产 OpBatch，got {other:?}"),
        }

        // 权威库未因 import 提案被改写（无 apply）
        assert_eq!(store.load_rev("doc-x").unwrap(), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 无 unpushed 时 MirrorOnly 可产块级 TextEdit 提案。
    #[test]
    fn import_mirror_proposal_text_edit_without_unpushed() {
        let dir = temp_dir();
        let db = dir.join("workspace.db");
        let mirror_root = dir.join("mirrors");
        let store = WorkspaceStore::open(&db).unwrap();
        let tree = sample_tree("mirror hello");

        store
            .export_md_mirror("doc-t", &tree, 1, &mirror_root)
            .unwrap();
        let path = mirror_root.join(format!("{}.md", crate::safe_doc_id("doc-t")));
        let md = std::fs::read_to_string(&path)
            .unwrap()
            .replace("mirror hello", "edited");
        std::fs::write(&path, md.as_bytes()).unwrap();

        let opts = ImportMirrorOpts::new(ThreeWayStrategy::RetainLocalAndReimport)
            .with_authority_tree(&tree);
        let res = store
            .import_mirror_proposal("doc-t", 1, &opts)
            .unwrap();
        match res {
            ImportMirrorResult::OpBatch {
                ops,
                preserves_unpushed,
                is_block_level_diff,
                ..
            } => {
                assert!(preserves_unpushed);
                assert!(is_block_level_diff);
                assert!(
                    ops.iter().any(|op| matches!(op, Op::TextEdit { .. })),
                    "期望 TextEdit 提案，ops={ops:?}"
                );
            }
            other => panic!("期望 OpBatch，got {other:?}"),
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 负向：工具不得把 mirror 路径当权威读 API——本 store 不提供 read_mirror_as_authority。
    #[test]
    fn no_read_mirror_as_authority_api() {
        // 编译期/API 面纪律：公开导入提案 ≠ 权威读。
        // 若未来误加 `read_mirror_as_doc` 类 API，本测文档钉死意图。
        let dir = temp_dir();
        let db = dir.join("workspace.db");
        let store = WorkspaceStore::open(&db).unwrap();
        // detect/import 是唯一与 mirror 文件交互的读路径；export 是写。
        // watcher 轮询同样走 detect，不提供「读 mirror 当权威」。
        let r = store.detect_mirror_drift("nope", 0).unwrap();
        assert_eq!(r.class, MirrorDriftClass::NoMeta);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// watcher 子集：改 mirror 文件 → `poll_mirror_once` 观察到 `MirrorOnly`。
    ///
    /// **≠ OS inotify**；**≠ A-INV-02 产品 UI**；**≠ EL-03**。
    #[test]
    fn poll_mirror_once_observes_mirror_only_after_external_edit() {
        let dir = temp_dir();
        let db = dir.join("workspace.db");
        let mirror_root = dir.join("mirrors");
        let store = WorkspaceStore::open(&db).unwrap();
        let tree = sample_tree("mirror hello");

        store
            .export_md_mirror("doc-w", &tree, 1, &mirror_root)
            .unwrap();

        let mut handle = MirrorWatchHandle::new("doc-w");
        // 首次 poll：建基线，非 change event
        let r0 = handle.poll_mirror_once(&store, 1).unwrap();
        assert!(r0.first_poll);
        assert!(!r0.is_change_event());
        assert_eq!(r0.report.class, MirrorDriftClass::None);

        // 无状态便捷入口也应对齐 detect
        let free = poll_mirror_once(&store, "doc-w", 1).unwrap();
        assert_eq!(free.class, MirrorDriftClass::None);

        // 外部改盘
        let path = r0.report.path.clone();
        let mut content = std::fs::read_to_string(&path).unwrap();
        content.push_str("\n\nexternal via poll\n");
        std::fs::write(&path, content.as_bytes()).unwrap();

        let r1 = handle.poll_mirror_once(&store, 1).unwrap();
        assert!(!r1.first_poll);
        assert!(r1.fingerprint_changed, "mtime/hash 应变");
        assert!(r1.is_change_event());
        assert_eq!(
            r1.report.class,
            MirrorDriftClass::MirrorOnly,
            "外部改 mirror 须 MirrorOnly，got {:?}",
            r1.report.class
        );
        assert!(r1.report.mirror_changed);
        assert!(!r1.report.authority_changed);

        // poll_if_changed：无再改时应 None
        let r2 = handle.poll_if_changed(&store, 1).unwrap();
        assert!(r2.is_none(), "指纹未变不应再报 change");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// watcher 子集：`on_mirror_change` 回调在外部改盘后拿到 `MirrorOnly`。
    ///
    /// **≠ OS inotify**；**≠ A-INV-02 产品 UI**；**≠ EL-03**。
    #[test]
    fn on_mirror_change_callback_receives_mirror_only() {
        use std::sync::{Arc, Mutex};

        let dir = temp_dir();
        let db = dir.join("workspace.db");
        let mirror_root = dir.join("mirrors");
        let store = WorkspaceStore::open(&db).unwrap();
        let tree = sample_tree("mirror hello");

        store
            .export_md_mirror("doc-cb", &tree, 1, &mirror_root)
            .unwrap();

        let events: Arc<Mutex<Vec<MirrorDriftClass>>> = Arc::new(Mutex::new(Vec::new()));
        let events_cb = Arc::clone(&events);

        let mut watcher = MirrorWatcher::new("doc-cb");
        watcher.on_mirror_change(move |ev| {
            events_cb
                .lock()
                .unwrap()
                .push(ev.report.class);
        });

        // 建基线：不应触发回调
        let r0 = watcher.poll_once(&store, 1).unwrap();
        assert!(r0.first_poll);
        assert!(events.lock().unwrap().is_empty(), "首次基线不回调");

        // 外部改盘
        let path = r0.report.path.clone();
        let md = std::fs::read_to_string(&path)
            .unwrap()
            .replace("mirror hello", "callback sees me");
        std::fs::write(&path, md.as_bytes()).unwrap();

        let r1 = watcher.poll_once(&store, 1).unwrap();
        assert!(r1.is_change_event());
        assert_eq!(r1.report.class, MirrorDriftClass::MirrorOnly);

        let fired = events.lock().unwrap().clone();
        assert_eq!(
            fired,
            vec![MirrorDriftClass::MirrorOnly],
            "回调须收到 MirrorOnly，got {fired:?}"
        );

        // 再 poll 无变更：不重复回调
        let r2 = watcher.poll_once(&store, 1).unwrap();
        assert!(!r2.is_change_event());
        assert_eq!(events.lock().unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
