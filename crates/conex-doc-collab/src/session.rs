//! DocSession：唯一 apply / hydrate 入口（写锥闭合 · G-INV / G-HYD）。
//!
//! - 结构：自研块树 Op（MV-01…04 / 环检测 / 删胜）
//! - 文本：私有 [`crate::text_engine::TextEngine`]（yrs + 热集/冷藏，H1）
//! - 同批原子：预校验失败整批零改树/零改文本（A-INV-09a）
//! - **P-H2（18 补丁 / 01 §2.4.1 方案 A）**：`on_committed` / 同批突变失败 →
//!   树 + 文本引擎 + rev + last_tx 回滚到 apply 前快照，零半提交；
//!   **CT-01 CAS Conflict 亦走 P-H2 回滚**（只是又一种失败）
//! - 删块同步释放文本引擎（A-INV-09c）
//! - 超长单块（M2 / A-HUGE）：`T_HUGE` 亚阈保持单叶；超阈同事务分段叶子（`split_of`）
//! - **结构 encode**：整树可逆 CDCS snapshot（G-HYD-1），**禁止** `rev.to_le_bytes()` 占位
//! - **hydrate**：`load_doc` blob → 重建树 + 冷文本登记（G-HYD-2）
//! - **写锥**：`tree` / `rev` 非 `pub` 可写；远端文本合入走同源 `on_committed`
//! - **Undo v1（W1-U）**：一次成功 `apply` 批 = 一步；`undo(filter)` 可按 origin 过滤；
//!   栈仅 `User`/`Agent`；跨冷 undo 结构正确（A-MEM-04）；删块 undo 恢复文本（A-INV-09c）
//!
//! 并发 move 规则见 `docs/block-workspace-architecture/plans/specs/concurrent-move-rules.md`
//! 与 18 §M1。超长策略见 `docs/.../specs/huge-block-policy.md`。
//!
//! **SR-06g · 拆分 · ≠ EL**：本文件为薄门面（结构 / 错误 / 常量 / 访问器 /
//! 跨写路径统一 commit 面 + P-H2 快照）。逻辑域经 `#[path]` 扁平模接线（无孤儿）：
//! - [`session_apply`]：CRDT apply 主路径 + 同事务分段
//! - [`session_validate`]：整批预校验 + 环检测
//! - [`session_undo`]：undo + 远端文本合入
//! - [`session_hydrate`]：hydrate 重建
//! - 测试旁挂 `session_tests*.rs`（`#[path]` 接入，零删除零改写）
//!
//! 拆分只切不修：公开 API 不 break（lib.rs re-export 不变）；**CT-01 CAS 已接线**
//!（emit_commit 期望版本参数 + 三写路径传入本次写前 rev，见 [`Self::emit_commit`]）。

use crate::block_id::BlockId;
use crate::events::BlockUpsert;
use crate::ir::{BlockNode, BlockTree};
use crate::op::Origin;
use crate::persistence::{CommitBatch, EncodedUpdate, PersistencePlugin, UpdateKind};
use crate::structure_codec::{encode_structure_payload, StructureCodecError};
use crate::text_engine::{TextEngine, TextEngineCheckpoint, TextEngineError};
use crate::tx::TxId;
use thiserror::Error;

#[path = "session_apply.rs"]
mod session_apply;

#[path = "session_hydrate.rs"]
mod session_hydrate;

#[path = "session_undo.rs"]
mod session_undo;

#[path = "session_validate.rs"]
mod session_validate;

// ─── P-H2 内存快照（方案 A：clone 树 + TextEngine 检查点）────────────────

/// apply / apply_remote 突变前的可恢复内存态（P-H2 · 18 补丁默认路径）。
///
/// 含：Structure（`BlockTree`）、rev、TextEngine 检查点、成功观测字段。
/// **不**含 persistence 插件句柄（插件外部状态由调用方/store 负责）。
///
/// 亦作为 Undo v1 栈条目的「apply 前」快照（W1-U）。
#[derive(Clone)]
struct MemorySnapshot {
    tree: BlockTree,
    rev: u64,
    text: TextEngineCheckpoint,
    last_tx_id: Option<TxId>,
    last_text_updates: Vec<TextUpdatePayload>,
}

/// Undo 栈一步：对应一次成功的本地 `apply` 批（W1-U / 01 §1.6）。
#[derive(Clone)]
struct UndoEntry {
    origin: Origin,
    /// 该批 apply **之前**的可恢复态。
    pre: MemorySnapshot,
}

// ─── M2 / A-HUGE 阈值 ───────────────────────────────────────────────

/// 单叶子文本超长硬阈默认值（UTF-8 字节，256 KiB）。
pub const DEFAULT_T_HUGE: usize = 256 * 1024;
/// 分段目标段大小默认值（UTF-8 字节，128 KiB）；须 ≤ `T_HUGE`。
pub const DEFAULT_T_SEGMENT: usize = 128 * 1024;
/// `T_HUGE` 配置下限钳制（64 KiB）。
pub const MIN_T_HUGE: usize = 64 * 1024;
/// `T_HUGE` 配置上限钳制（16 MiB）。
pub const MAX_T_HUGE: usize = 16 * 1024 * 1024;

/// 将配置字节数钳到 `MIN_T_HUGE..=MAX_T_HUGE`。
#[inline]
pub fn clamp_huge_threshold(bytes: usize) -> usize {
    bytes.clamp(MIN_T_HUGE, MAX_T_HUGE)
}

/// 按 `max_bytes` 切 UTF-8 安全段：优先在 `\n` 边界；否则在 Unicode 标量（char）边界。
///
/// 禁止切开 UTF-8 多字节序列；单 char 若极端超过 `max_bytes` 则整字独占一段。
/// 段拼接 equals 原文（A-HUGE-07 基础）。
pub fn partition_utf8(text: &str, max_bytes: usize) -> Vec<String> {
    let max_bytes = max_bytes.max(1);
    if text.is_empty() {
        return vec![String::new()];
    }
    if text.len() <= max_bytes {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        if rest.len() <= max_bytes {
            out.push(rest.to_string());
            break;
        }
        // 硬上界：不越过 max_bytes，且落在 char 边界
        let mut hard = max_bytes;
        while hard > 0 && !rest.is_char_boundary(hard) {
            hard -= 1;
        }
        if hard == 0 {
            // 理论上仅 max_bytes < 某 char 字节长时；强制整 char
            hard = rest.chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        }
        let window = &rest[..hard];
        // 优先最后一个换行（含 `\n` 在本段尾）
        let cut = match window.rfind('\n') {
            Some(pos) if pos + 1 > 0 => pos + 1,
            _ => hard,
        };
        let cut = if cut == 0 { hard } else { cut };
        out.push(rest[..cut].to_string());
        rest = &rest[cut..];
    }
    out
}

/// 段叶子 props 键：`split_of` → 逻辑锚点 BlockId 字符串。
const ATTR_SPLIT_OF: &str = "split_of";

/// 上次成功 apply 产生的叶子文本 update 载荷（公开只读；**禁止**含 yrs 类型，A-INV-05）。
///
/// 供 W1-F 双 peer 互推真实文本 update：`apply_remote_text_update(block_id, &bytes)`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextUpdatePayload {
    pub block_id: BlockId,
    /// yrs encode_state_as_update_v1 字节（不透明；调用方不得解析为 yrs 类型）。
    pub bytes: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum ApplyError {
    #[error("schema: {0}")]
    Schema(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("persist: {0}")]
    Persist(String),
    #[error("invariant: {0}")]
    Invariant(String),
    #[error("undo: {0}")]
    Undo(#[from] UndoError),
}

/// `DocSession::undo` 失败（W1-U）。
#[derive(Debug, Error, PartialEq, Eq)]
pub enum UndoError {
    /// 栈空，或 filter 导致无可撤步。
    #[error("undo stack empty")]
    Empty,
    /// 栈顶 origin 与 filter 不匹配（A-COL-04：不偷偷撤错源）。
    #[error("undo origin mismatch: expected {expected:?}, top is {actual:?}")]
    OriginMismatch { expected: Origin, actual: Origin },
    #[error("undo persist: {0}")]
    Persist(String),
}

/// `DocSession::hydrate` 失败（G-HYD-2）：载荷不可解码时**禁止**静默空会话当成功。
#[derive(Debug, Error, PartialEq, Eq)]
pub enum HydrateError {
    #[error("corrupt hydrate blob: {0}")]
    Corrupt(String),
}

impl From<StructureCodecError> for HydrateError {
    fn from(e: StructureCodecError) -> Self {
        HydrateError::Corrupt(e.to_string())
    }
}

impl From<TextEngineError> for ApplyError {
    fn from(e: TextEngineError) -> Self {
        match e {
            TextEngineError::OffsetOutOfRange => ApplyError::Schema("text offset".into()),
            TextEngineError::NotRegistered(id) => ApplyError::NotFound(id),
            TextEngineError::UpdateDecode(m) | TextEngineError::UpdateApply(m) => {
                ApplyError::Schema(format!("text update: {m}"))
            }
            TextEngineError::NoUndoHistory | TextEngineError::NoRedoHistory => {
                ApplyError::Undo(UndoError::Empty)
            }
        }
    }
}

/// 文档会话：权威树 + rev **仅**经 `apply` / `hydrate` / 统一 commit 面写入（A-INV-01）。
///
/// 写锥：`tree` / `rev` **非** `pub` 可写字段；外部只能 `tree()` / `rev()` 只读访问。
/// Undo v1：[`Self::undo`] 只撤本地 `User`/`Agent` 成功批（`Remote`/`System` 不入栈）。
pub struct DocSession {
    pub doc_id: String,
    /// 权威块树（写锥封闭：非 pub 可写）。
    tree: BlockTree,
    /// 单调修订号（写锥封闭：非 pub 可写）。
    rev: u64,
    persistence: Option<Box<dyn PersistencePlugin>>,
    /// 叶子文本引擎（crate 内私有字段；不暴露 yrs 类型）。
    text_engine: TextEngine,
    /// 上次成功 apply 的事务 id（A-INV-09b 观测）。
    last_tx_id: Option<TxId>,
    /// 上次成功 apply 产生的文本 update（W1-F / 无 yrs 类型外泄）。
    last_text_updates: Vec<TextUpdatePayload>,
    /// 单叶 UTF-8 字节超长阈（`T_HUGE`）；默认 256 KiB，钳制 64KiB..=16MiB。
    huge_threshold: usize,
    /// Undo v1 栈（W1-U）：仅 `User`/`Agent` 成功 apply 入栈。
    undo_stack: Vec<UndoEntry>,
}

// SAFETY: DocSession 内部通过受控访问或 Mutex 包装保护，可在线程间安全传递
#[allow(unsafe_code)]
unsafe impl Send for DocSession {}

impl DocSession {
    pub fn new(doc_id: impl Into<String>) -> Self {
        Self {
            doc_id: doc_id.into(),
            tree: BlockTree::default(),
            rev: 0,
            persistence: None,
            text_engine: TextEngine::default(),
            last_tx_id: None,
            last_text_updates: Vec::new(),
            huge_threshold: DEFAULT_T_HUGE,
            undo_stack: Vec::new(),
        }
    }

    /// 只读块树（写锥：禁止外部赋值 `session.tree = …`）。
    #[inline]
    pub fn tree(&self) -> &BlockTree {
        &self.tree
    }

    /// 只读修订号（写锥：禁止外部赋值 `session.rev = …`）。
    #[inline]
    pub fn rev(&self) -> u64 {
        self.rev
    }

    /// Undo 栈深度（W1-U 观测 / 测试）。
    #[inline]
    pub fn undo_len(&self) -> usize {
        self.undo_stack.len()
    }

    /// 上次成功 `apply` 的 [`TxId`]（失败 apply 不更新）。
    pub fn last_tx_id(&self) -> Option<TxId> {
        self.last_tx_id
    }

    /// 上次成功 `apply` 产生的叶子文本 update 字节（按块；无 yrs 类型）。
    ///
    /// 结构-only 批则为空切片。W1-F harness 用此互推真实文本 update。
    pub fn last_commit_text_updates(&self) -> &[TextUpdatePayload] {
        &self.last_text_updates
    }

    pub fn with_persistence(mut self, p: Box<dyn PersistencePlugin>) -> Self {
        self.persistence = Some(p);
        self
    }

    /// 配置文本热集上界（默认 512 = H1 `DEFAULT_MAX_HOT`；测试可用小值验证 A-MEM）。
    pub fn with_text_max_hot(mut self, max_hot: usize) -> Self {
        self.text_engine = TextEngine::with_max_hot(max_hot);
        self
    }

    /// 配置超长单块阈 `T_HUGE`（UTF-8 字节）。
    ///
    /// 传入值钳制到 [`MIN_T_HUGE`]..=[`MAX_T_HUGE`]；不回溯已分段树，仅影响后续判定。
    pub fn with_huge_threshold(mut self, bytes: usize) -> Self {
        self.huge_threshold = clamp_huge_threshold(bytes);
        self
    }

    /// 运行时更新 `T_HUGE`（钳制同上；不回溯已分段树）。
    pub fn set_huge_threshold(&mut self, bytes: usize) {
        self.huge_threshold = clamp_huge_threshold(bytes);
    }

    /// 当前 `T_HUGE`（UTF-8 字节）。
    pub fn huge_threshold(&self) -> usize {
        self.huge_threshold
    }

    /// 分段目标段大小 `T_SEGMENT`：默认 128 KiB，且不超过当前 `T_HUGE`。
    pub fn segment_target(&self) -> usize {
        DEFAULT_T_SEGMENT.min(self.huge_threshold)
    }

    /// 活动 YText 实例数（A-MEM-01 观测；不外泄 yrs 句柄）。
    pub fn text_hot_count(&self) -> usize {
        self.text_engine.hot_count()
    }

    /// 热集上界。
    pub fn text_max_hot(&self) -> usize {
        self.text_engine.max_hot()
    }

    /// 读叶子文本（冷热均可；A-MEM-02）。
    pub fn read_text(&self, id: &BlockId) -> String {
        self.text_engine.read_text(*id)
    }

    /// 块是否在文本热集。
    pub fn text_is_hot(&self, id: &BlockId) -> bool {
        self.text_engine.is_hot(*id)
    }

    /// 文本引擎是否仍登记该块（删后应为 false，A-INV-09c）。
    pub fn text_is_registered(&self, id: &BlockId) -> bool {
        self.text_engine.is_registered(*id)
    }

    /// 显式 touch 热块（窗口/焦点）；未热 no-op。
    pub fn text_touch(&mut self, id: &BlockId) {
        self.text_engine.touch(*id);
    }

    /// pin 块（驱逐时跳过）；composing/焦点路径用。
    pub fn text_pin(&mut self, id: &BlockId) {
        self.text_engine.pin(*id);
    }

    pub fn text_unpin(&mut self, id: &BlockId) {
        self.text_engine.unpin(*id);
    }

    /// P-H2：捕获 apply 前可恢复内存态（树 clone + 文本引擎检查点 + rev/观测）。
    fn capture_memory_snapshot(&self) -> MemorySnapshot {
        MemorySnapshot {
            tree: self.tree.clone(),
            rev: self.rev,
            text: self.text_engine.checkpoint(),
            last_tx_id: self.last_tx_id,
            last_text_updates: self.last_text_updates.clone(),
        }
    }

    /// P-H2：整域回滚到快照（零半提交）。
    fn restore_memory_snapshot(&mut self, snap: MemorySnapshot) {
        self.tree = snap.tree;
        self.rev = snap.rev;
        self.text_engine.restore(snap.text);
        self.last_tx_id = snap.last_tx_id;
        self.last_text_updates = snap.last_text_updates;
    }

    /// 同源 commit：写 Structure（整树 CDCS）+ 可选 Text updates，并调 `on_committed_expect`。
    ///
    /// 三个写路径（apply / undo / 远端文本合入）统一汇入本面；失败由调用方
    /// P-H2 快照回滚。**CT-01 CAS**：`expect_rev` = 本次写前会话 rev（increment 前），
    /// 经存储层条件更新比对；陈旧写 → [`crate::persistence::PersistError::Conflict`] →
    /// `ApplyError::Persist`（消息含稳定 `conflict` 标识，供上层错误码透传链消费）。
    fn emit_commit(
        &self,
        origin: Origin,
        tx_id: TxId,
        rev: u64,
        expect_rev: Option<u64>,
        text_payloads: &[TextUpdatePayload],
    ) -> Result<(), ApplyError> {
        let Some(p) = &self.persistence else {
            return Ok(());
        };
        let mut updates = vec![EncodedUpdate {
            bytes: encode_structure_payload(rev, &self.tree),
            kind: UpdateKind::Structure,
        }];
        for pld in text_payloads {
            updates.push(EncodedUpdate {
                bytes: pld.bytes.clone(),
                kind: UpdateKind::Text,
            });
        }
        let batch = CommitBatch {
            tx_id,
            origin,
            updates,
            snapshot_tick: false,
        };
        p.on_committed_expect(&self.doc_id, &batch, expect_rev)
            .map_err(|e| ApplyError::Persist(e.to_string()))?;
        Ok(())
    }
}

/// 投影索引 / FTS 依赖 `plain_text`；冷热路径均以 `text_snapshot` 为准。
fn block_to_upsert(n: &BlockNode) -> BlockUpsert {
    BlockUpsert {
        id: n.id,
        kind: n.kind.clone(),
        props: n.props.clone(),
        children: n.children.clone(),
        order: n.order.clone(),
        parent: n.parent,
        plain_text: n.text_snapshot.clone().unwrap_or_default(),
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
