//! DocSession：唯一 apply / hydrate 入口（写锥闭合 · G-INV / G-HYD）。
//!
//! - 结构：自研块树 Op（MV-01…04 / 环检测 / 删胜）
//! - 文本：私有 [`crate::text_engine::TextEngine`]（yrs + 热集/冷藏，H1）
//! - 同批原子：预校验失败整批零改树/零改文本（A-INV-09a）
//! - **P-H2（18 补丁 / 01 §2.4.1 方案 A）**：`on_committed` / 同批突变失败 →
//!   树 + 文本引擎 + rev + last_tx 回滚到 apply 前快照，零半提交
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

use crate::block_id::BlockId;
use crate::events::{BlockUpsert, DocEvent, ProjectionDiff};
use crate::ir::{BlockNode, BlockProps, BlockTree};
use crate::op::{Op, Origin};
use crate::persistence::{
    CommitBatch, EncodedUpdate, HydrateBlob, PersistencePlugin, UpdateKind,
};
use crate::structure_codec::{
    decode_structure_from_snapshot, decode_structure_payload, encode_structure_payload,
    is_structure_payload, StructureCodecError,
};
use crate::text_engine::{
    simulate_char_edit, TextEngine, TextEngineCheckpoint, TextEngineError,
};
use crate::tx::{TxGuard, TxId};
use std::collections::{HashMap, HashSet};
use thiserror::Error;

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

    /// 从 `PersistencePlugin::load_doc` 的 blob 重建会话（G-HYD-2）。
    ///
    /// 成功不变量：树无环语义由载荷保证；各叶 `text_snapshot` 登记为冷文本；
    /// `rev` 取自最后一帧结构 snapshot。空 blob → 空会话（新文档合法）。
    ///
    /// 载荷不可解码 → [`HydrateError::Corrupt`]，**禁止**静默 `new` 空树当成功。
    pub fn hydrate(doc_id: impl Into<String>, blob: HydrateBlob) -> Result<Self, HydrateError> {
        let mut session = Self::new(doc_id);
        session.ingest_hydrate_blob(blob)?;
        Ok(session)
    }

    /// 消费 hydrate blob（可在已有 session 上替换权威态；通常仅 `hydrate` 构造路径调用）。
    fn ingest_hydrate_blob(&mut self, blob: HydrateBlob) -> Result<(), HydrateError> {
        let has_snap = blob.snapshot.as_ref().is_some_and(|s| !s.is_empty());
        let has_pending = !blob.pending.is_empty();
        if !has_snap && !has_pending {
            return Ok(());
        }

        let mut tree = BlockTree::default();
        let mut rev = 0u64;
        let mut got_structure = false;

        if let Some(snap) = &blob.snapshot {
            if !snap.is_empty() {
                match decode_structure_from_snapshot(snap) {
                    Ok(s) => {
                        rev = s.rev;
                        tree = s.tree;
                        got_structure = true;
                    }
                    Err(StructureCodecError::Empty) if has_pending => {
                        // snapshot 帧无结构（仅历史文本帧）→ 交给 pending
                    }
                    Err(e) => return Err(e.into()),
                }
            }
        }

        for u in &blob.pending {
            match u.kind {
                UpdateKind::Structure | UpdateKind::Combined => {
                    if !is_structure_payload(&u.bytes) {
                        return Err(HydrateError::Corrupt(
                            "pending structure bytes are not CDCS payload".into(),
                        ));
                    }
                    let s = decode_structure_payload(&u.bytes)?;
                    rev = s.rev;
                    tree = s.tree;
                    got_structure = true;
                }
                UpdateKind::Text => {
                    // 文本权威以结构内 text_snapshot 为准；yrs pending 不强制热合入
                    // （A-MEM-02 冷可读；热集按需 rehydrate）
                }
            }
        }

        if !got_structure {
            return Err(HydrateError::Corrupt(
                "hydrate blob has data but no recoverable structure snapshot".into(),
            ));
        }

        self.tree = tree;
        self.rev = rev;
        // 按节点 text_snapshot 登记 TextEngine 冷文本（不强制全热，G-HYD-2 / A-MEM-02）
        self.text_engine = TextEngine::with_max_hot(self.text_engine.max_hot());
        for (id, node) in &self.tree.nodes {
            let text = node.text_snapshot.clone().unwrap_or_default();
            self.text_engine.init_block_with_text(*id, text);
        }
        // hydrate 重建权威后清空内存 undo（跨进程无栈；进程内冷边界 undo 见 W1-U 热集测）
        self.undo_stack.clear();
        Ok(())
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

    /// 远端文本 update 合入指定块（冷块先 rehydrate，A-MEM-03）。
    ///
    /// 写锥：成功后与 `apply` **同源** `on_committed`（结构可逆 snapshot + Text 字节），
    /// 禁止静默涨 rev 不落盘（A-INV-01 / W1-A）。
    ///
    /// **P-H2**：`on_committed` 失败 → 树/文本/rev/last_tx 回滚到合入前（方案 A 快照）。
    pub fn apply_remote_text_update(
        &mut self,
        id: BlockId,
        bytes: &[u8],
    ) -> Result<(), ApplyError> {
        if !self.tree.nodes.contains_key(&id) {
            return Err(ApplyError::NotFound(id.to_string()));
        }
        // P-H2：突变前快照
        let pre = self.capture_memory_snapshot();
        match self.apply_remote_text_update_inner(id, bytes) {
            Ok(()) => Ok(()),
            Err(e) => {
                self.restore_memory_snapshot(pre);
                Err(e)
            }
        }
    }

    fn apply_remote_text_update_inner(
        &mut self,
        id: BlockId,
        bytes: &[u8],
    ) -> Result<(), ApplyError> {
        let new_text = self.text_engine.apply_remote_update(id, bytes)?;
        if let Some(n) = self.tree.nodes.get_mut(&id) {
            n.text_snapshot = Some(new_text);
        }
        self.rev += 1;
        let rev = self.rev;
        let tx_id = TxId::new();
        self.last_tx_id = Some(tx_id);
        self.last_text_updates = vec![TextUpdatePayload {
            block_id: id,
            bytes: bytes.to_vec(),
        }];

        // 统一 commit 面：结构可逆 + 文本 update
        self.emit_commit(
            Origin::Remote,
            tx_id,
            rev,
            &[TextUpdatePayload {
                block_id: id,
                bytes: bytes.to_vec(),
            }],
        )?;
        Ok(())
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

    /// 同源 commit：写 Structure（整树 CDCS）+ 可选 Text updates，并调 `on_committed`。
    fn emit_commit(
        &self,
        origin: Origin,
        tx_id: TxId,
        rev: u64,
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
        p.on_committed(&self.doc_id, &batch)
            .map_err(|e| ApplyError::Persist(e.to_string()))?;
        Ok(())
    }

    /// 规划将超长叶拆为多段叶子的 Op 序列（**不**修改会话状态）。
    ///
    /// - 块不存在 → [`ApplyError::NotFound`]
    /// - `utf8_len < T_HUGE` → 空 Vec（A-HUGE-01：无需拆）
    /// - 否则：首段原地 `TextEdit` + 后续 `Insert`/`TextEdit`（`props.attrs["split_of"]=锚点`）
    ///
    /// 调用方可将返回值送入 [`Self::apply`]；首段已 ≤ `T_SEGMENT` 时不会再次触发自动分段。
    pub fn plan_split_huge(&self, id: BlockId) -> Result<Vec<Op>, ApplyError> {
        if !self.tree.nodes.contains_key(&id) {
            return Err(ApplyError::NotFound(id.to_string()));
        }
        let text = self.read_text(&id);
        if text.len() < self.huge_threshold {
            return Ok(Vec::new());
        }
        let segs = partition_utf8(&text, self.segment_target());
        if segs.len() <= 1 {
            return Ok(Vec::new());
        }
        let node = self
            .tree
            .nodes
            .get(&id)
            .ok_or_else(|| ApplyError::NotFound(id.to_string()))?;
        let parent = node.parent;
        let base_order = node.order.clone();
        let kind = node.kind.clone();
        let char_len = text.chars().count() as u32;
        let anchor = id;

        let mut ops = Vec::with_capacity(1 + (segs.len() - 1) * 2);
        // 首段：原地替换全文
        ops.push(Op::TextEdit {
            id,
            start: 0,
            end: char_len,
            insert: segs[0].clone(),
        });
        for (i, seg) in segs.iter().enumerate().skip(1) {
            let seg_id = BlockId::new();
            let mut props = BlockProps::default();
            props.attrs.insert(
                ATTR_SPLIT_OF.into(),
                serde_json::Value::String(anchor.to_string()),
            );
            ops.push(Op::Insert {
                id: seg_id,
                parent,
                order: segment_order(&base_order, i),
                kind: kind.clone(),
                props,
            });
            ops.push(Op::TextEdit {
                id: seg_id,
                start: 0,
                end: 0,
                insert: seg.clone(),
            });
        }
        Ok(ops)
    }

    /// 唯一权威写入口。
    ///
    /// **P-H2（18 补丁 · 方案 A 快照回滚）**：预校验通过后、突变前捕获
    /// Structure+Text+rev；`on_committed` / 同批 huge split / 突变中途 **任一失败**
    /// → 整域回滚到 apply 前，返回错误且 **零半提交**（树/文本/rev ≡ apply 前）。
    ///
    /// **Undo v1**：成功且 `origin ∈ {User, Agent}` 时，将 apply 前快照压入 undo 栈
    ///（一次 apply 批 = 一步；Agent 千次 Op 同批仍一步）。`Remote`/`System` 不入栈。
    pub fn apply(&mut self, origin: Origin, ops: &[Op]) -> Result<DocEvent, ApplyError> {
        let tx = TxGuard::begin();
        let tx_id = tx.id();

        // 预校验（结构 + 文本偏移模拟）：失败则整批不改树/不改文本（A-INV-09a）
        self.validate_batch(ops)?;

        // P-H2：apply 前可恢复快照（默认主路径；与两阶段 prepare 等价「失败见旧态」）
        let pre = self.capture_memory_snapshot();
        match self.apply_after_validate(origin, ops, tx_id) {
            Ok(event) => {
                // W1-U：仅本地 User/Agent 入栈；失败路径不入栈
                if matches!(origin, Origin::User | Origin::Agent) {
                    self.undo_stack.push(UndoEntry { origin, pre });
                }
                tx.commit();
                Ok(event)
            }
            Err(e) => {
                self.restore_memory_snapshot(pre);
                Err(e)
            }
        }
    }

    /// Undo v1：撤销栈顶一步（一次 apply 批）。
    ///
    /// - `filter = None`：撤栈顶（无论 User/Agent）
    /// - `filter = Some(o)`：仅当栈顶 origin == o 时撤，否则 [`UndoError::OriginMismatch`]
    ///   （A-COL-04：可按 origin 过滤，不误撤）
    /// - 恢复结构 + 文本 plain 权威；**rev 单调 +1** 并走同源 `on_committed`
    /// - 跨热集冷藏：结构正确；文本以栈内 plain 快照为准（细粒度 yrs 史允许截断，A-MEM-04）
    /// - 删块步被撤 → 块与文本按快照恢复（A-INV-09c 后半）
    /// - `on_committed` 失败 → 内存态与栈深度回滚到 undo 前（P-H2 同向）
    ///
    /// **redo 本波未交付**。
    pub fn undo(&mut self, filter: Option<Origin>) -> Result<DocEvent, UndoError> {
        let top = self.undo_stack.last().ok_or(UndoError::Empty)?;
        if let Some(expected) = filter {
            if top.origin != expected {
                return Err(UndoError::OriginMismatch {
                    expected,
                    actual: top.origin,
                });
            }
        }
        let entry = self
            .undo_stack
            .pop()
            .expect("undo_stack 非空（已 last 检查）");

        // persist 失败时回滚到 undo 前内存态，并把 entry 压回栈
        let pre_undo = self.capture_memory_snapshot();
        let rev_before = self.rev;

        // 恢复树与文本 plain；不回退 rev 历史值（协同单调）
        self.tree = entry.pre.tree.clone();
        self.text_engine.restore(entry.pre.text.clone());
        self.rev = rev_before.saturating_add(1);
        let rev = self.rev;

        let tx = TxGuard::begin();
        let tx_id = tx.id();
        self.last_tx_id = Some(tx_id);
        self.last_text_updates = Vec::new();

        // 结构 snapshot 已含 text_snapshot；文本 update 可空
        if let Err(e) = self.emit_commit(Origin::System, tx_id, rev, &[]) {
            self.restore_memory_snapshot(pre_undo);
            self.undo_stack.push(entry);
            return Err(UndoError::Persist(e.to_string()));
        }
        tx.commit();

        let upserts: Vec<BlockUpsert> = self.tree.nodes.values().map(block_to_upsert).collect();
        let text_touches: Vec<BlockId> = upserts.iter().map(|u| u.id).collect();

        Ok(DocEvent::Projection {
            diff: ProjectionDiff {
                doc_id: self.doc_id.clone(),
                rev,
                upserts,
                removes: vec![],
                text_touches,
                full_rebuild: true,
            },
        })
    }

    /// 预校验已通过后的突变 + persist（失败由 [`Self::apply`] 统一回滚）。
    fn apply_after_validate(
        &mut self,
        origin: Origin,
        ops: &[Op],
        tx_id: TxId,
    ) -> Result<DocEvent, ApplyError> {
        let mut upserts = Vec::new();
        let mut removes = Vec::new();
        let mut text_touches = Vec::new();
        let mut text_payloads: Vec<TextUpdatePayload> = Vec::new();

        for op in ops {
            match op {
                Op::Insert {
                    id,
                    parent,
                    order,
                    kind,
                    props,
                } => {
                    let node = BlockNode {
                        id: *id,
                        parent: *parent,
                        order: order.clone(),
                        kind: kind.clone(),
                        props: props.clone(),
                        text_snapshot: Some(String::new()),
                        children: vec![],
                    };
                    if let Some(pid) = parent {
                        if let Some(p) = self.tree.nodes.get_mut(pid) {
                            p.children.push(*id);
                        } else {
                            return Err(ApplyError::NotFound(pid.to_string()));
                        }
                    } else {
                        self.tree.root_children.push(*id);
                    }
                    upserts.push(block_to_upsert(&node));
                    self.tree.nodes.insert(*id, node);
                    // 叶子文本：登记空快照，默认冷（H1）
                    self.text_engine.init_block(*id);
                    // 同父 order 全序：插入后按 fractional 字典序重排兄弟
                    self.tree.resort_children_of(*parent);
                }
                Op::UpdateProps { id, props } => {
                    let n = self
                        .tree
                        .nodes
                        .get_mut(id)
                        .ok_or_else(|| ApplyError::NotFound(id.to_string()))?;
                    n.props = props.clone();
                    upserts.push(block_to_upsert(n));
                }
                Op::Move {
                    id,
                    new_parent,
                    order,
                } => {
                    self.apply_move(*id, *new_parent, order)?;
                    if let Some(n) = self.tree.nodes.get(id) {
                        upserts.push(block_to_upsert(n));
                    }
                }
                Op::Delete { id } => {
                    let removed = self.apply_delete(*id)?;
                    for rid in &removed {
                        // A-INV-09c：同步释放文本引擎
                        self.text_engine.release_block(*rid);
                    }
                    removes.extend(removed);
                }
                Op::TextEdit {
                    id,
                    start,
                    end,
                    insert,
                } => {
                    // char 偏移 → TextEngine（yrs）；失败路径不应走到此处（已 validate）
                    let new_text = self
                        .text_engine
                        .apply_edit(*id, *start, *end, insert)
                        .map_err(ApplyError::from)?;
                    let n = self
                        .tree
                        .nodes
                        .get_mut(id)
                        .ok_or_else(|| ApplyError::NotFound(id.to_string()))?;
                    n.text_snapshot = Some(new_text);
                    text_touches.push(*id);
                    upserts.push(block_to_upsert(n));
                    // CommitBatch / last_commit_text_updates：yrs encode 字节（无类型外泄）
                    if let Some(bytes) = self.text_engine.encode_state_update(*id) {
                        text_payloads.push(TextUpdatePayload {
                            block_id: *id,
                            bytes,
                        });
                    }
                }
            }
        }

        // M2 / A-HUGE-02：同事务尾部对超阈文本叶自动分段；失败 → 外层 P-H2 整批回滚
        // （原子域 = 用户 Op + 自动 split + on_committed，18 P-H2）
        let mut split_candidates: Vec<BlockId> = text_touches.clone();
        split_candidates.sort_by_key(|id| id.as_uuid());
        split_candidates.dedup();
        for cid in split_candidates {
            self.maybe_split_huge_in_tx(
                cid,
                &mut upserts,
                &mut text_touches,
                &mut text_payloads,
            )?;
        }

        self.rev += 1;
        let rev = self.rev;

        // 无论是否挂 persistence，都记录同源 tx + 文本 update（A-INV-09b / W1-F）
        // 若随后 on_committed 失败，外层 restore 会抹掉这些观测字段
        self.last_tx_id = Some(tx_id);
        self.last_text_updates = text_payloads.clone();

        // G-HYD-1：结构 bytes = 整树可逆 CDCS snapshot（非 rev LE 占位）
        // P-H2：此处 Err → 外层回滚树/文本/rev
        self.emit_commit(origin, tx_id, rev, &text_payloads)?;

        Ok(DocEvent::Projection {
            diff: ProjectionDiff {
                doc_id: self.doc_id.clone(),
                rev,
                upserts,
                removes,
                text_touches,
                full_rebuild: false,
            },
        })
    }

    /// 整批预校验：结构 + 文本偏移顺序模拟；失败零改状态（A-INV-09a）。
    fn validate_batch(&self, ops: &[Op]) -> Result<(), ApplyError> {
        let deleted = self.expand_deletes(ops);
        // 同批内先前 Insert 的 id，允许后续 Op 引用
        let mut inserted: HashSet<BlockId> = HashSet::new();
        // 同批文本模拟（含新插入的空串）
        let mut sim_text: HashMap<BlockId, String> = HashMap::new();

        for op in ops {
            match op {
                Op::Insert { id, parent, .. } => {
                    if let Some(pid) = parent {
                        self.ensure_parent_alive(*pid, &deleted, &inserted)?;
                    }
                    inserted.insert(*id);
                    sim_text.insert(*id, String::new());
                }
                Op::Move {
                    id,
                    new_parent,
                    ..
                } => {
                    // 被删节点不可再 move；目标父被删 → 删胜，NotFound 整批失败
                    if deleted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                    if !self.tree.nodes.contains_key(id) && !inserted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                    if let Some(np) = new_parent {
                        self.ensure_parent_alive(*np, &deleted, &inserted)?;
                        if self.would_create_cycle(*id, Some(*np)) {
                            return Err(ApplyError::Invariant("move cycle".into()));
                        }
                    }
                }
                Op::UpdateProps { id, .. } => {
                    if deleted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                    if !self.tree.nodes.contains_key(id) && !inserted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                }
                Op::TextEdit {
                    id,
                    start,
                    end,
                    insert,
                } => {
                    if deleted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                    if !self.tree.nodes.contains_key(id) && !inserted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                    let current = if let Some(t) = sim_text.get(id) {
                        t.clone()
                    } else if self.text_engine.is_registered(*id) {
                        self.text_engine.read_text(*id)
                    } else if let Some(n) = self.tree.nodes.get(id) {
                        n.text_snapshot.clone().unwrap_or_default()
                    } else {
                        String::new()
                    };
                    let next = simulate_char_edit(&current, *start, *end, insert)
                        .map_err(ApplyError::from)?;
                    sim_text.insert(*id, next);
                }
                Op::Delete { id } => {
                    if !self.tree.nodes.contains_key(id) && !inserted.contains(id) {
                        return Err(ApplyError::NotFound(id.to_string()));
                    }
                }
            }
        }
        Ok(())
    }

    /// 父节点须存活：已在树或同批已插入，且不在同批删除闭包内。
    fn ensure_parent_alive(
        &self,
        pid: BlockId,
        deleted: &HashSet<BlockId>,
        inserted: &HashSet<BlockId>,
    ) -> Result<(), ApplyError> {
        if deleted.contains(&pid) {
            return Err(ApplyError::NotFound(pid.to_string()));
        }
        if self.tree.nodes.contains_key(&pid) || inserted.contains(&pid) {
            Ok(())
        } else {
            Err(ApplyError::NotFound(pid.to_string()))
        }
    }

    /// 同批 Delete 展开为子树闭包（删胜：整棵子树视为不可再作 move 目标）。
    fn expand_deletes(&self, ops: &[Op]) -> HashSet<BlockId> {
        let mut deleted = HashSet::new();
        for op in ops {
            if let Op::Delete { id } = op {
                let mut stack = vec![*id];
                while let Some(cur) = stack.pop() {
                    if deleted.insert(cur) {
                        if let Some(n) = self.tree.nodes.get(&cur) {
                            stack.extend(n.children.iter().copied());
                        }
                    }
                }
            }
        }
        deleted
    }

    /// MV-02 / MV-04：若把 `id` 挂到 `new_parent` 下会使 `id` 成为自身祖先则成环。
    fn would_create_cycle(&self, id: BlockId, new_parent: Option<BlockId>) -> bool {
        let Some(mut cur) = new_parent else {
            return false;
        };
        // 沿 parent 链上溯：碰到 id 即环（含 new_parent == id）
        loop {
            if cur == id {
                return true;
            }
            match self.tree.nodes.get(&cur) {
                Some(n) => match n.parent {
                    Some(p) => cur = p,
                    None => return false,
                },
                // 父不存在另由 NotFound 处理
                None => return false,
            }
        }
    }

    fn apply_move(
        &mut self,
        id: BlockId,
        new_parent: Option<BlockId>,
        order: &str,
    ) -> Result<(), ApplyError> {
        // 目标节点必须存在
        if !self.tree.nodes.contains_key(&id) {
            return Err(ApplyError::NotFound(id.to_string()));
        }
        // 新父必须存在（delete vs move：被删后到此应 NotFound）
        if let Some(np) = new_parent {
            if !self.tree.nodes.contains_key(&np) {
                return Err(ApplyError::NotFound(np.to_string()));
            }
        }
        // 防环（MV-02/MV-04）
        if self.would_create_cycle(id, new_parent) {
            return Err(ApplyError::Invariant("move cycle".into()));
        }

        let old_parent = self.tree.nodes.get(&id).unwrap().parent;

        // 从旧父移除
        if let Some(op) = old_parent {
            if let Some(p) = self.tree.nodes.get_mut(&op) {
                p.children.retain(|c| *c != id);
            }
        } else {
            self.tree.root_children.retain(|c| *c != id);
        }

        // 挂新父
        if let Some(np) = new_parent {
            // 上文已确认存在
            if let Some(p) = self.tree.nodes.get_mut(&np) {
                p.children.push(id);
            }
        } else {
            self.tree.root_children.push(id);
        }

        let n = self.tree.nodes.get_mut(&id).unwrap();
        n.parent = new_parent;
        n.order = order.to_string();

        // 按 order 字典序重排新父兄弟（MV-01 全序稳定）
        self.tree.resort_children_of(new_parent);
        Ok(())
    }

    /// 删除节点及子树；返回被删 id 列表（含根）。
    fn apply_delete(&mut self, id: BlockId) -> Result<Vec<BlockId>, ApplyError> {
        let mut stack = vec![id];
        let mut to_rm = Vec::new();
        while let Some(cur) = stack.pop() {
            if let Some(n) = self.tree.nodes.get(&cur) {
                stack.extend(n.children.iter().copied());
            }
            to_rm.push(cur);
        }
        for rid in &to_rm {
            if let Some(n) = self.tree.nodes.get(rid) {
                if let Some(pid) = n.parent {
                    if let Some(p) = self.tree.nodes.get_mut(&pid) {
                        p.children.retain(|c| c != rid);
                    }
                } else {
                    self.tree.root_children.retain(|c| c != rid);
                }
            }
            self.tree.nodes.remove(rid);
        }
        Ok(to_rm)
    }

    /// 同事务内：若 `id` 文本 UTF-8 字节 ≥ `T_HUGE`，拆为多段叶子（A-HUGE-02 主路径）。
    ///
    /// 最小结构：首段即 anchor（id 不变），后续兄弟 `props.split_of = anchor`，order 紧邻。
    fn maybe_split_huge_in_tx(
        &mut self,
        id: BlockId,
        upserts: &mut Vec<BlockUpsert>,
        text_touches: &mut Vec<BlockId>,
        text_payloads: &mut Vec<TextUpdatePayload>,
    ) -> Result<(), ApplyError> {
        if !self.tree.nodes.contains_key(&id) {
            return Ok(());
        }
        // 已被同批删除则跳过
        let text = self.read_text(&id);
        // A-HUGE-01：亚阈保持单叶
        if text.len() < self.huge_threshold {
            return Ok(());
        }
        let segs = partition_utf8(&text, self.segment_target());
        if segs.len() <= 1 {
            return Ok(());
        }

        let (parent, base_order, kind) = {
            let n = self
                .tree
                .nodes
                .get(&id)
                .ok_or_else(|| ApplyError::NotFound(id.to_string()))?;
            (n.parent, n.order.clone(), n.kind.clone())
        };
        let anchor = id;

        // 首段：原地改写文本
        self.set_block_text_and_record(id, &segs[0], upserts, text_touches, text_payloads)?;

        // 后续段：Insert 兄弟 + 写文本
        for (i, seg) in segs.iter().enumerate().skip(1) {
            let seg_id = BlockId::new();
            let mut props = BlockProps::default();
            props.attrs.insert(
                ATTR_SPLIT_OF.into(),
                serde_json::Value::String(anchor.to_string()),
            );
            let order = segment_order(&base_order, i);
            let node = BlockNode {
                id: seg_id,
                parent,
                order: order.clone(),
                kind: kind.clone(),
                props: props.clone(),
                text_snapshot: Some(String::new()),
                children: vec![],
            };
            if let Some(pid) = parent {
                if let Some(p) = self.tree.nodes.get_mut(&pid) {
                    p.children.push(seg_id);
                } else {
                    return Err(ApplyError::NotFound(pid.to_string()));
                }
            } else {
                self.tree.root_children.push(seg_id);
            }
            self.tree.nodes.insert(seg_id, node);
            self.text_engine.init_block(seg_id);
            self.tree.resort_children_of(parent);

            self.set_block_text_and_record(
                seg_id,
                seg,
                upserts,
                text_touches,
                text_payloads,
            )?;
            if let Some(n) = self.tree.nodes.get(&seg_id) {
                upserts.push(block_to_upsert(n));
            }
        }

        // 刷新 anchor upsert（order/children 侧可能未变，文本已变）
        if let Some(n) = self.tree.nodes.get(&id) {
            upserts.push(block_to_upsert(n));
        }
        Ok(())
    }

    /// 整叶替换文本并同步 tree 快照 / touches / encode。
    fn set_block_text_and_record(
        &mut self,
        id: BlockId,
        text: &str,
        upserts: &mut Vec<BlockUpsert>,
        text_touches: &mut Vec<BlockId>,
        text_payloads: &mut Vec<TextUpdatePayload>,
    ) -> Result<(), ApplyError> {
        let current = self.text_engine.read_text(id);
        let char_len = current.chars().count() as u32;
        let new_text = self
            .text_engine
            .apply_edit(id, 0, char_len, text)
            .map_err(ApplyError::from)?;
        if let Some(n) = self.tree.nodes.get_mut(&id) {
            n.text_snapshot = Some(new_text);
            upserts.push(block_to_upsert(n));
        }
        text_touches.push(id);
        if let Some(bytes) = self.text_engine.encode_state_update(id) {
            // 同一块多次写：保留最后一次 encode
            text_payloads.retain(|p| p.block_id != id);
            text_payloads.push(TextUpdatePayload {
                block_id: id,
                bytes,
            });
        }
        Ok(())
    }
}

/// 段叶子 order：在 anchor `base` 之后、通常仍小于下一字典兄弟（`base` < `base~s0001` < …）。
fn segment_order(base: &str, segment_index: usize) -> String {
    format!("{base}~s{segment_index:04}")
}

fn block_to_upsert(n: &BlockNode) -> BlockUpsert {
    BlockUpsert {
        id: n.id,
        kind: n.kind.clone(),
        props: n.props.clone(),
        children: n.children.clone(),
        order: n.order.clone(),
        parent: n.parent,
        // 投影索引 / FTS 依赖此字段；冷热路径均以 text_snapshot 为准
        plain_text: n.text_snapshot.clone().unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::a_inv_09::{A_INV_09A, A_INV_09C};
    use crate::ir::{BlockKind, BlockProps, cmp_order};
    use crate::persistence::MemoryPersistence;
    use std::cmp::Ordering;

    fn insert_root(s: &mut DocSession, id: BlockId, order: &str) {
        s.apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: order.into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
    }

    fn insert_child(s: &mut DocSession, id: BlockId, parent: BlockId, order: &str) {
        s.apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: Some(parent),
                order: order.into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
    }

    #[test]
    fn insert_and_text_edit_single_tx() {
        let mut s = DocSession::new("d1").with_persistence(Box::new(MemoryPersistence::default()));
        let id = BlockId::new();
        s.apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "hi".into(),
            }],
        )
        .unwrap();
        assert_eq!(
            s.tree.get(&id).unwrap().text_snapshot.as_deref(),
            Some("hi")
        );
        assert_eq!(s.read_text(&id), "hi");
        assert!(s.text_is_hot(&id));
    }

    #[test]
    fn batch_fails_atomically_on_missing_parent() {
        let mut s = DocSession::new("d1");
        let id = BlockId::new();
        let missing = BlockId::new();
        let err = s
            .apply(
                Origin::Agent,
                &[Op::Insert {
                    id,
                    parent: Some(missing),
                    order: "a0".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                }],
            )
            .unwrap_err();
        assert!(matches!(err, ApplyError::NotFound(_)));
        assert!(s.tree.nodes.is_empty());
    }

    #[test]
    fn delete_releases_node_a_inv_09c() {
        let mut s = DocSession::new("d1");
        let id = BlockId::new();
        s.apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
        s.apply(Origin::User, &[Op::Delete { id }]).unwrap();
        assert!(s.tree.nodes.is_empty());
        assert!(!s.text_is_registered(&id));
    }

    /// MV-01：同父并发 order 插入 → 全序稳定（字典序），无环。
    #[test]
    fn mv01_same_parent_order_inserts_stable() {
        let mut s = DocSession::new("d1");
        let parent = BlockId::new();
        let a = BlockId::new();
        let b = BlockId::new();
        let c = BlockId::new();
        insert_root(&mut s, parent, "a0");

        // 同批乱序 order 插入：应用后兄弟应按 fractional 字典序排列
        s.apply(
            Origin::User,
            &[
                Op::Insert {
                    id: b,
                    parent: Some(parent),
                    order: "a2".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
                Op::Insert {
                    id: a,
                    parent: Some(parent),
                    order: "a0".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
                Op::Insert {
                    id: c,
                    parent: Some(parent),
                    order: "a1".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
            ],
        )
        .unwrap();

        let children = &s.tree.get(&parent).unwrap().children;
        assert_eq!(children, &[a, c, b], "order a0 < a1 < a2 决定全序");
        assert_eq!(cmp_order("a0", "a1"), Ordering::Less);
        // 无环：子节点 parent 均为 parent
        for id in children {
            assert_eq!(s.tree.get(id).unwrap().parent, Some(parent));
        }
    }

    /// MV-02 基础：A→B 子 与 反向会成环时拒（单端 apply 路径）。
    #[test]
    fn mv02_cross_parent_cycle_rejected() {
        let mut s = DocSession::new("d1");
        let a = BlockId::new();
        let b = BlockId::new();
        insert_root(&mut s, a, "a0");
        insert_child(&mut s, b, a, "a0"); // B under A

        // 再把 A 移到 B 下 → 成环
        let err = s
            .apply(
                Origin::Remote,
                &[Op::Move {
                    id: a,
                    new_parent: Some(b),
                    order: "a0".into(),
                }],
            )
            .unwrap_err();
        assert!(matches!(err, ApplyError::Invariant(_)));
        // 树未变
        assert_eq!(s.tree.get(&a).unwrap().parent, None);
        assert_eq!(s.tree.get(&b).unwrap().parent, Some(a));
    }

    /// MV-03：同批 delete(A) + move(B under A) → 删胜；整批 NotFound，原子回滚。
    #[test]
    fn mv03_same_batch_delete_wins_over_move_under_deleted() {
        let mut s = DocSession::new("d1");
        let a = BlockId::new();
        let b = BlockId::new();
        insert_root(&mut s, a, "a0");
        insert_root(&mut s, b, "a1");
        let rev_before = s.rev;
        let nodes_before = s.tree.nodes.len();

        // 顺序：先 delete 后 move；预校验展开删除闭包后 move 目标 NotFound
        let err = s
            .apply(
                Origin::Remote,
                &[
                    Op::Delete { id: a },
                    Op::Move {
                        id: b,
                        new_parent: Some(a),
                        order: "a0".into(),
                    },
                ],
            )
            .unwrap_err();
        assert!(matches!(err, ApplyError::NotFound(_)));
        assert_eq!(s.rev, rev_before, "失败不增 rev");
        assert_eq!(s.tree.nodes.len(), nodes_before, "整批原子：节点数不变");
        assert!(s.tree.nodes.contains_key(&a));
        assert_eq!(s.tree.get(&b).unwrap().parent, None);

        // 反序 ops 同样整批失败（删闭包与顺序无关）
        let err2 = s
            .apply(
                Origin::Remote,
                &[
                    Op::Move {
                        id: b,
                        new_parent: Some(a),
                        order: "a0".into(),
                    },
                    Op::Delete { id: a },
                ],
            )
            .unwrap_err();
        assert!(matches!(err2, ApplyError::NotFound(_)));
        assert!(s.tree.nodes.contains_key(&a));
        assert_eq!(s.tree.get(&b).unwrap().parent, None);
    }

    /// MV-03 变体：跨事务 delete 后再 move → NotFound（目标不存在）。
    #[test]
    fn mv03_sequential_delete_then_move_not_found() {
        let mut s = DocSession::new("d1");
        let a = BlockId::new();
        let b = BlockId::new();
        insert_root(&mut s, a, "a0");
        insert_root(&mut s, b, "a1");
        s.apply(Origin::User, &[Op::Delete { id: a }]).unwrap();

        let err = s
            .apply(
                Origin::Remote,
                &[Op::Move {
                    id: b,
                    new_parent: Some(a),
                    order: "a0".into(),
                }],
            )
            .unwrap_err();
        assert!(matches!(err, ApplyError::NotFound(_)));
        assert_eq!(s.tree.get(&b).unwrap().parent, None);
    }

    /// MV-04：move 到自身子孙 → 拒。
    #[test]
    fn mv04_move_under_descendant_rejected() {
        let mut s = DocSession::new("d1");
        let a = BlockId::new();
        let b = BlockId::new();
        let c = BlockId::new();
        insert_root(&mut s, a, "a0");
        insert_child(&mut s, b, a, "a0");
        insert_child(&mut s, c, b, "a0"); // A → B → C

        // A 移到 C 下（子孙）
        let err = s
            .apply(
                Origin::User,
                &[Op::Move {
                    id: a,
                    new_parent: Some(c),
                    order: "a0".into(),
                }],
            )
            .unwrap_err();
        assert!(matches!(err, ApplyError::Invariant(_)));

        // 自身作为 parent
        let err_self = s
            .apply(
                Origin::User,
                &[Op::Move {
                    id: a,
                    new_parent: Some(a),
                    order: "a0".into(),
                }],
            )
            .unwrap_err();
        assert!(matches!(err_self, ApplyError::Invariant(_)));

        // 合法：C 移到根下
        s.apply(
            Origin::User,
            &[Op::Move {
                id: c,
                new_parent: None,
                order: "a9".into(),
            }],
        )
        .unwrap();
        assert_eq!(s.tree.get(&c).unwrap().parent, None);
        assert!(s.tree.root_children.contains(&c));
    }

    /// A-INV-09a：同批 TextEdit + 故意失败 Op → 树与文本均不变。
    #[test]
    fn a_inv_09a_text_edit_plus_failing_op_atomic() {
        let _ = A_INV_09A;
        let mut s = DocSession::new("d1");
        let id = BlockId::new();
        insert_root(&mut s, id, "a0");
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "base".into(),
            }],
        )
        .unwrap();
        let rev_before = s.rev;
        let text_before = s.read_text(&id);
        let hot_before = s.text_hot_count();
        let missing = BlockId::new();

        let err = s
            .apply(
                Origin::User,
                &[
                    Op::TextEdit {
                        id,
                        start: 0,
                        end: 4,
                        insert: "CHANGED".into(),
                    },
                    Op::Move {
                        id,
                        new_parent: Some(missing),
                        order: "a0".into(),
                    },
                ],
            )
            .unwrap_err();
        assert!(matches!(err, ApplyError::NotFound(_)));
        assert_eq!(s.rev, rev_before);
        assert_eq!(s.read_text(&id), text_before);
        assert_eq!(
            s.tree.get(&id).unwrap().text_snapshot.as_deref(),
            Some(text_before.as_str())
        );
        assert_eq!(s.text_hot_count(), hot_before);
    }

    /// A-INV-09a 变体：非法文本偏移 + 合法结构 Op 同批 → 全拒。
    #[test]
    fn a_inv_09a_bad_text_offset_rejects_whole_batch() {
        let mut s = DocSession::new("d1");
        let id = BlockId::new();
        let id2 = BlockId::new();
        insert_root(&mut s, id, "a0");
        let rev_before = s.rev;
        let nodes_before = s.tree.nodes.len();

        let err = s
            .apply(
                Origin::User,
                &[
                    Op::TextEdit {
                        id,
                        start: 99,
                        end: 99,
                        insert: "x".into(),
                    },
                    Op::Insert {
                        id: id2,
                        parent: None,
                        order: "a1".into(),
                        kind: BlockKind::Paragraph,
                        props: BlockProps::default(),
                    },
                ],
            )
            .unwrap_err();
        assert!(matches!(err, ApplyError::Schema(_)));
        assert_eq!(s.rev, rev_before);
        assert_eq!(s.tree.nodes.len(), nodes_before);
        assert!(!s.tree.nodes.contains_key(&id2));
        assert!(!s.text_is_registered(&id2));
    }

    /// A-INV-09c：Delete 后 TextEngine 无该 id；热计数下降。
    #[test]
    fn a_inv_09c_delete_releases_text_engine() {
        let _ = A_INV_09C;
        let mut s = DocSession::new("d1");
        let id = BlockId::new();
        insert_root(&mut s, id, "a0");
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "hot".into(),
            }],
        )
        .unwrap();
        assert!(s.text_is_hot(&id));
        assert_eq!(s.text_hot_count(), 1);

        s.apply(Origin::User, &[Op::Delete { id }]).unwrap();
        assert!(!s.text_is_registered(&id));
        assert!(!s.text_is_hot(&id));
        assert_eq!(s.text_hot_count(), 0);
        assert!(s.tree.nodes.is_empty());
    }

    /// A-MEM-01 / W6-C：默认热集上界常量导出为 512，且 DocSession 默认采用该值。
    #[test]
    fn a_mem_01_default_max_hot_constant_is_512() {
        use crate::a_mem;
        use crate::DEFAULT_MAX_HOT;
        assert_eq!(DEFAULT_MAX_HOT, 512, "H1 默认热集上界须为 512");
        assert_eq!(a_mem::DEFAULT_MAX_HOT, DEFAULT_MAX_HOT);
        assert_eq!(a_mem::A_MEM_01, "A-MEM-01");
        let s = DocSession::new("d1");
        assert_eq!(
            s.text_max_hot(),
            DEFAULT_MAX_HOT,
            "DocSession::new 默认 text_max_hot 须等于 DEFAULT_MAX_HOT"
        );
        // 退化治理 ID 可引用（数值比较见 perf-baseline.md）
        assert_eq!(crate::a_perf::A_PERF_DEG_01, "A-PERF-DEG-01");
    }

    /// A-MEM-01（会话层）：max_hot=8，编辑超限后 hot_count 受界。
    #[test]
    fn a_mem_01_session_hot_bounded() {
        let mut s = DocSession::new("d1").with_text_max_hot(8);
        let mut ids = Vec::new();
        for i in 0..24 {
            let id = BlockId::new();
            insert_root(&mut s, id, &format!("a{i:02}"));
            s.apply(
                Origin::User,
                &[Op::TextEdit {
                    id,
                    start: 0,
                    end: 0,
                    insert: "x".into(),
                }],
            )
            .unwrap();
            ids.push(id);
        }
        assert!(s.text_hot_count() <= 8);
        assert_eq!(s.text_max_hot(), 8);
        // 最近编辑仍热
        assert!(s.text_is_hot(ids.last().unwrap()));
    }

    /// A-MEM-02（会话层）：冷块可读 + 再编辑变热。
    ///
    /// **≠ A-MEM-04**：本测无 undo；跨冷 undo 契约见 W1-U / `pseudo-assert-register.md`。
    #[test]
    fn a_mem_02_session_cold_read_and_reheat() {
        let mut s = DocSession::new("d1").with_text_max_hot(1);
        let a = BlockId::new();
        let b = BlockId::new();
        insert_root(&mut s, a, "a0");
        insert_root(&mut s, b, "a1");
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id: a,
                start: 0,
                end: 0,
                insert: "alpha".into(),
            }],
        )
        .unwrap();
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id: b,
                start: 0,
                end: 0,
                insert: "beta".into(),
            }],
        )
        .unwrap();
        assert!(!s.text_is_hot(&a));
        assert_eq!(s.read_text(&a), "alpha");
        assert_eq!(
            s.tree.get(&a).unwrap().text_snapshot.as_deref(),
            Some("alpha")
        );
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id: a,
                start: 0,
                end: 5,
                insert: "ALPHA".into(),
            }],
        )
        .unwrap();
        assert!(s.text_is_hot(&a));
        assert_eq!(s.read_text(&a), "ALPHA");
    }

    /// CommitBatch 文本变更携带 Text 类 update（A-INV-09b 同源 tx_id）。
    #[test]
    fn commit_batch_includes_text_update_bytes() {
        struct Cap(std::sync::Arc<std::sync::Mutex<Option<CommitBatch>>>);
        impl PersistencePlugin for Cap {
            fn load_doc(
                &self,
                _: &str,
            ) -> Result<crate::persistence::HydrateBlob, crate::persistence::PersistError>
            {
                Ok(Default::default())
            }
            fn on_committed(
                &self,
                _: &str,
                c: &CommitBatch,
            ) -> Result<(), crate::persistence::PersistError> {
                *self.0.lock().unwrap() = Some(c.clone());
                Ok(())
            }
            fn flush_hint(&self, _: &str) -> Result<(), crate::persistence::PersistError> {
                Ok(())
            }
        }
        let last = std::sync::Arc::new(std::sync::Mutex::new(None::<CommitBatch>));
        let mut s = DocSession::new("d1").with_persistence(Box::new(Cap(last.clone())));
        let id = BlockId::new();
        s.apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "hi".into(),
            }],
        )
        .unwrap();
        let batch = last.lock().unwrap().clone().expect("commit");
        assert!(
            batch
                .updates
                .iter()
                .any(|u| matches!(u.kind, UpdateKind::Text) && !u.bytes.is_empty()),
            "应含非空 Text update 字节"
        );
        // 结构标记与 Text 同批、同 tx_id
        assert!(batch.updates.iter().any(|u| matches!(u.kind, UpdateKind::Structure)));
        assert_eq!(s.last_tx_id(), Some(batch.tx_id));
        assert_eq!(s.last_commit_text_updates().len(), 1);
        assert_eq!(s.last_commit_text_updates()[0].block_id, id);
        assert!(!s.last_commit_text_updates()[0].bytes.is_empty());
        let _ = MemoryPersistence::default();
    }

    /// A-INV-09b：一次 apply 的 CommitBatch 中 structure 与 text updates 共享同一 `tx_id`。
    #[test]
    fn a_inv_09b_structure_and_text_share_tx_id() {
        use crate::a_inv_09::A_INV_09B;
        let _ = A_INV_09B;
        struct Cap(std::sync::Arc<std::sync::Mutex<Option<CommitBatch>>>);
        impl PersistencePlugin for Cap {
            fn load_doc(
                &self,
                _: &str,
            ) -> Result<crate::persistence::HydrateBlob, crate::persistence::PersistError>
            {
                Ok(Default::default())
            }
            fn on_committed(
                &self,
                _: &str,
                c: &CommitBatch,
            ) -> Result<(), crate::persistence::PersistError> {
                *self.0.lock().unwrap() = Some(c.clone());
                Ok(())
            }
            fn flush_hint(&self, _: &str) -> Result<(), crate::persistence::PersistError> {
                Ok(())
            }
        }
        let last = std::sync::Arc::new(std::sync::Mutex::new(None::<CommitBatch>));
        let mut s = DocSession::new("d1").with_persistence(Box::new(Cap(last.clone())));
        let id = BlockId::new();
        // 同批：结构 Insert + 文本 TextEdit → 单一 CommitBatch / 单一 tx_id
        s.apply(
            Origin::User,
            &[
                Op::Insert {
                    id,
                    parent: None,
                    order: "a0".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
                Op::TextEdit {
                    id,
                    start: 0,
                    end: 0,
                    insert: "same-tx".into(),
                },
            ],
        )
        .unwrap();
        let batch = last.lock().unwrap().clone().expect("commit");
        let session_tx = s.last_tx_id().expect("last_tx_id");
        assert_eq!(batch.tx_id, session_tx, "CommitBatch.tx_id 与 session 同源");
        let has_struct = batch
            .updates
            .iter()
            .any(|u| matches!(u.kind, UpdateKind::Structure));
        let has_text = batch
            .updates
            .iter()
            .any(|u| matches!(u.kind, UpdateKind::Text) && !u.bytes.is_empty());
        assert!(has_struct, "同批须含 Structure 标记");
        assert!(has_text, "同批须含 Text update");
        // 全部 updates 挂在同一 batch.tx_id 下（结构体单字段，即共享）
        assert_eq!(s.read_text(&id), "same-tx");
        assert_eq!(s.last_commit_text_updates().len(), 1);
        assert_eq!(s.last_commit_text_updates()[0].block_id, id);
    }

    // ─── A-HUGE / M2 ────────────────────────────────────────────────

    /// 拼接 anchor 及其 `split_of` 兄弟正文（按 order）。
    fn join_split_chain(s: &DocSession, anchor: BlockId) -> String {
        let parent = s.tree.get(&anchor).and_then(|n| n.parent);
        let siblings: Vec<BlockId> = match parent {
            Some(pid) => s
                .tree
                .get(&pid)
                .map(|n| n.children.clone())
                .unwrap_or_default(),
            None => s.tree.root_children.clone(),
        };
        let mut parts = Vec::new();
        for sid in siblings {
            if sid == anchor {
                parts.push(s.read_text(&sid));
                continue;
            }
            let is_seg = s
                .tree
                .get(&sid)
                .and_then(|n| n.props.attrs.get(ATTR_SPLIT_OF))
                .and_then(|v| v.as_str())
                .map(|x| x == anchor.to_string())
                .unwrap_or(false);
            if is_seg {
                parts.push(s.read_text(&sid));
            }
        }
        parts.concat()
    }

    fn count_split_segments(s: &DocSession, anchor: BlockId) -> usize {
        let parent = s.tree.get(&anchor).and_then(|n| n.parent);
        let siblings: Vec<BlockId> = match parent {
            Some(pid) => s
                .tree
                .get(&pid)
                .map(|n| n.children.clone())
                .unwrap_or_default(),
            None => s.tree.root_children.clone(),
        };
        let mut n = 0;
        for sid in siblings {
            if sid == anchor {
                n += 1;
                continue;
            }
            let is_seg = s
                .tree
                .get(&sid)
                .and_then(|node| node.props.attrs.get(ATTR_SPLIT_OF))
                .and_then(|v| v.as_str())
                .map(|x| x == anchor.to_string())
                .unwrap_or(false);
            if is_seg {
                n += 1;
            }
        }
        n
    }

    /// A-HUGE-01：亚阈文本保持单叶，无 `split_of` 子段。
    #[test]
    fn a_huge_01_below_threshold_stays_single_leaf() {
        let _ = crate::a_huge::A_HUGE_01;
        let mut s = DocSession::new("d1");
        assert_eq!(s.huge_threshold(), DEFAULT_T_HUGE);
        let id = BlockId::new();
        insert_root(&mut s, id, "a0");
        let payload = "x".repeat(1024); // 1 KiB ≪ 256 KiB
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: payload.clone(),
            }],
        )
        .unwrap();
        assert_eq!(s.read_text(&id), payload);
        assert_eq!(s.tree.nodes.len(), 1, "亚阈不得强制分段");
        assert!(s
            .tree
            .get(&id)
            .unwrap()
            .props
            .attrs
            .get(ATTR_SPLIT_OF)
            .is_none());
        assert!(s.plan_split_huge(id).unwrap().is_empty());
    }

    /// A-HUGE-01 变体：刚好低于 T_HUGE 仍单叶。
    #[test]
    fn a_huge_01_just_below_threshold_single() {
        let thr = MIN_T_HUGE;
        let mut s = DocSession::new("d1").with_huge_threshold(thr);
        assert_eq!(s.huge_threshold(), thr);
        let id = BlockId::new();
        insert_root(&mut s, id, "a0");
        let payload = "a".repeat(thr - 1);
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: payload.clone(),
            }],
        )
        .unwrap();
        assert_eq!(s.tree.nodes.len(), 1);
        assert_eq!(s.read_text(&id).len(), thr - 1);
        assert_eq!(count_split_segments(&s, id), 1);
    }

    /// A-HUGE-02：一次插入超大字符串 → 同事务自动分段，拼接 equals 原文。
    #[test]
    fn a_huge_02_auto_split_on_huge_insert() {
        let _ = crate::a_huge::A_HUGE_02;
        let thr = MIN_T_HUGE; // 64 KiB，便于测试
        let mut s = DocSession::new("d1").with_huge_threshold(thr);
        let id = BlockId::new();
        insert_root(&mut s, id, "a0");
        // 约 2.5 × T_HUGE → 多段
        let payload = "b".repeat(thr * 2 + thr / 2);
        let nodes_before = s.tree.nodes.len();
        s.apply(
            Origin::Agent,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: payload.clone(),
            }],
        )
        .unwrap();
        let segs = count_split_segments(&s, id);
        assert!(segs > 1, "超阈应分段，got segs={segs}");
        assert!(s.tree.nodes.len() > nodes_before);
        assert_eq!(join_split_chain(&s, id), payload, "拼接 equals 原文");
        // 每段 ≤ T_SEGMENT
        let seg_max = s.segment_target();
        let parent = s.tree.get(&id).unwrap().parent;
        let siblings = match parent {
            Some(pid) => s.tree.get(&pid).unwrap().children.clone(),
            None => s.tree.root_children.clone(),
        };
        for sid in siblings {
            let is_chain = sid == id
                || s.tree
                    .get(&sid)
                    .and_then(|n| n.props.attrs.get(ATTR_SPLIT_OF))
                    .and_then(|v| v.as_str())
                    .map(|x| x == id.to_string())
                    .unwrap_or(false);
            if is_chain {
                assert!(
                    s.read_text(&sid).len() <= seg_max,
                    "段 {} 超 T_SEGMENT",
                    sid
                );
            }
        }
        // 后续段带 split_of
        let has_split_of = s.tree.nodes.values().any(|n| {
            n.id != id
                && n.props
                    .attrs
                    .get(ATTR_SPLIT_OF)
                    .and_then(|v| v.as_str())
                    == Some(&id.to_string())
        });
        assert!(has_split_of);
    }

    /// A-HUGE-02：超阈写入与失败 Op 同批 → 整批失败、零半树。
    #[test]
    fn a_huge_02_failed_batch_no_half_tree() {
        let thr = MIN_T_HUGE;
        let mut s = DocSession::new("d1").with_huge_threshold(thr);
        let id = BlockId::new();
        insert_root(&mut s, id, "a0");
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "seed".into(),
            }],
        )
        .unwrap();
        let rev_before = s.rev;
        let nodes_before = s.tree.nodes.len();
        let text_before = s.read_text(&id);
        let missing = BlockId::new();
        let huge = "z".repeat(thr + 1024);

        let err = s
            .apply(
                Origin::Agent,
                &[
                    Op::TextEdit {
                        id,
                        start: 0,
                        end: 4,
                        insert: huge,
                    },
                    Op::Move {
                        id,
                        new_parent: Some(missing),
                        order: "a0".into(),
                    },
                ],
            )
            .unwrap_err();
        assert!(matches!(err, ApplyError::NotFound(_)));
        assert_eq!(s.rev, rev_before);
        assert_eq!(s.tree.nodes.len(), nodes_before, "零半树：节点数不变");
        assert_eq!(s.read_text(&id), text_before);
        assert!(!s.tree.nodes.values().any(|n| n
            .props
            .attrs
            .contains_key(ATTR_SPLIT_OF)));
    }

    /// `plan_split_huge` 可测：先以高阈写入单叶，再降阈规划/应用 Op。
    #[test]
    fn plan_split_huge_ops_apply_cleanly() {
        let thr = MIN_T_HUGE;
        // 高阈写入 → 保持单叶（A-HUGE-01）
        let mut s = DocSession::new("d1").with_huge_threshold(MAX_T_HUGE);
        let id = BlockId::new();
        insert_root(&mut s, id, "a0");
        let payload = "c".repeat(thr * 2 + 4096);
        assert!(payload.len() < MAX_T_HUGE);
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: payload.clone(),
            }],
        )
        .unwrap();
        assert_eq!(s.tree.nodes.len(), 1, "高阈下应仍为单叶");

        // 降阈后 plan 应给出多 Op
        s.set_huge_threshold(thr);
        let plan = s.plan_split_huge(id).unwrap();
        assert!(
            plan.len() >= 3,
            "至少 TextEdit 首段 + Insert + TextEdit，got {}",
            plan.len()
        );
        assert!(matches!(plan[0], Op::TextEdit { .. }));

        s.apply(Origin::System, &plan).unwrap();
        assert!(count_split_segments(&s, id) > 1);
        assert_eq!(join_split_chain(&s, id), payload);
        // 已分段后再次 plan 为空
        assert!(s.plan_split_huge(id).unwrap().is_empty());
    }

    /// `with_huge_threshold` 钳制 64KiB..=16MiB。
    #[test]
    fn huge_threshold_clamped() {
        let s = DocSession::new("d1").with_huge_threshold(1);
        assert_eq!(s.huge_threshold(), MIN_T_HUGE);
        let s2 = DocSession::new("d1").with_huge_threshold(usize::MAX);
        assert_eq!(s2.huge_threshold(), MAX_T_HUGE);
        let s3 = DocSession::new("d1").with_huge_threshold(128 * 1024);
        assert_eq!(s3.huge_threshold(), 128 * 1024);
        assert_eq!(s3.segment_target(), DEFAULT_T_SEGMENT.min(128 * 1024));
    }

    #[test]
    fn partition_utf8_prefers_newline_and_roundtrips() {
        let text = format!("{}\n{}", "a".repeat(100), "b".repeat(100));
        let parts = partition_utf8(&text, 120);
        assert!(parts.len() >= 2);
        assert_eq!(parts.concat(), text);
        // 中文 char 边界
        let cjk = "你好世界".repeat(20);
        let parts2 = partition_utf8(&cjk, 17);
        assert_eq!(parts2.concat(), cjk);
        for p in &parts2 {
            assert!(p.len() <= 17 || p.chars().count() == 1);
        }
    }

    /// 含换行的超长文本分段后拼接 equals（边界安全）。
    #[test]
    fn a_huge_split_with_newlines_roundtrip() {
        let thr = MIN_T_HUGE;
        let mut s = DocSession::new("d1").with_huge_threshold(thr);
        let id = BlockId::new();
        insert_root(&mut s, id, "a0");
        let line = format!("{}\n", "行".repeat(1000));
        let payload = line.repeat(40); // 远超 64KiB
        assert!(payload.len() >= thr);
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: payload.clone(),
            }],
        )
        .unwrap();
        assert!(count_split_segments(&s, id) > 1);
        assert_eq!(join_split_chain(&s, id), payload);
    }

    // ─── G-HYD / W1-H：结构可逆 encode + hydrate ───────────────────

    /// G-HYD-1：结构 EncodedUpdate **不是** `rev.to_le_bytes()` 占位，且可解码。
    #[test]
    fn g_hyd_01_structure_encode_not_rev_placeholder() {
        use crate::structure_codec::{decode_structure_payload, is_structure_payload};
        let last = std::sync::Arc::new(std::sync::Mutex::new(None::<CommitBatch>));
        struct Cap(std::sync::Arc<std::sync::Mutex<Option<CommitBatch>>>);
        impl PersistencePlugin for Cap {
            fn load_doc(
                &self,
                _: &str,
            ) -> Result<crate::persistence::HydrateBlob, crate::persistence::PersistError>
            {
                Ok(Default::default())
            }
            fn on_committed(
                &self,
                _: &str,
                c: &CommitBatch,
            ) -> Result<(), crate::persistence::PersistError> {
                *self.0.lock().unwrap() = Some(c.clone());
                Ok(())
            }
            fn flush_hint(&self, _: &str) -> Result<(), crate::persistence::PersistError> {
                Ok(())
            }
        }
        let mut s = DocSession::new("g-hyd-1").with_persistence(Box::new(Cap(last.clone())));
        let id = BlockId::new();
        s.apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
        let batch = last.lock().unwrap().clone().expect("commit");
        let structure = batch
            .updates
            .iter()
            .find(|u| matches!(u.kind, UpdateKind::Structure))
            .expect("须含 Structure update");
        let rev = s.rev;
        assert_ne!(
            structure.bytes,
            rev.to_le_bytes().to_vec(),
            "禁止结构 bytes = rev LE 占位"
        );
        assert!(
            structure.bytes.len() > 8,
            "结构载荷须长于 8 字节 rev 占位"
        );
        assert!(
            is_structure_payload(&structure.bytes),
            "须为 CDCS 结构 magic"
        );
        let snap = decode_structure_payload(&structure.bytes).expect("可解码");
        assert_eq!(snap.rev, rev);
        assert!(snap.tree.nodes.contains_key(&id));
        assert_eq!(snap.tree.root_children, vec![id]);
    }

    /// G-HYD-2：apply → persist → hydrate → 树同构。
    #[test]
    fn g_hyd_02_apply_persist_hydrate_tree_isomorphic() {
        use crate::structure_codec::structure_eq;
        let mem = MemoryPersistence::default();
        // 用 Arc 共享同一 MemoryPersistence 状态：Box 会移走所有权，故直接用闭包插件
        let blob_slot = std::sync::Arc::new(std::sync::Mutex::new(
            crate::persistence::HydrateBlob::default(),
        ));
        let last = std::sync::Arc::new(std::sync::Mutex::new(None::<CommitBatch>));
        struct MemP {
            blob: std::sync::Arc<std::sync::Mutex<crate::persistence::HydrateBlob>>,
            last: std::sync::Arc<std::sync::Mutex<Option<CommitBatch>>>,
        }
        impl PersistencePlugin for MemP {
            fn load_doc(
                &self,
                _: &str,
            ) -> Result<crate::persistence::HydrateBlob, crate::persistence::PersistError>
            {
                Ok(self.blob.lock().unwrap().clone())
            }
            fn on_committed(
                &self,
                _: &str,
                c: &CommitBatch,
            ) -> Result<(), crate::persistence::PersistError> {
                *self.last.lock().unwrap() = Some(c.clone());
                let mut blob = self.blob.lock().unwrap();
                for u in &c.updates {
                    if matches!(u.kind, UpdateKind::Structure | UpdateKind::Combined) {
                        blob.snapshot = Some(u.bytes.clone());
                        blob.pending.clear();
                    }
                }
                Ok(())
            }
            fn flush_hint(&self, _: &str) -> Result<(), crate::persistence::PersistError> {
                Ok(())
            }
        }
        let mut s = DocSession::new("g-hyd-2").with_persistence(Box::new(MemP {
            blob: blob_slot.clone(),
            last: last.clone(),
        }));
        let a = BlockId::new();
        let b = BlockId::new();
        s.apply(
            Origin::User,
            &[
                Op::Insert {
                    id: a,
                    parent: None,
                    order: "a0".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
                Op::Insert {
                    id: b,
                    parent: Some(a),
                    order: "a0".into(),
                    kind: BlockKind::Heading { level: 2 },
                    props: BlockProps::default(),
                },
                Op::TextEdit {
                    id: a,
                    start: 0,
                    end: 0,
                    insert: "parent-text".into(),
                },
            ],
        )
        .unwrap();
        let expected_tree = s.tree.clone();
        let expected_rev = s.rev;
        assert_eq!(expected_rev, 1);
        assert!(last.lock().unwrap().is_some());

        let blob = blob_slot.lock().unwrap().clone();
        assert!(blob.snapshot.is_some());
        let restored = DocSession::hydrate("g-hyd-2", blob).expect("hydrate");
        assert!(
            structure_eq(restored.tree(), &expected_tree),
            "hydrate 后树须同构（id/parent/order/kind/props/children/text_snapshot）"
        );
        assert_eq!(restored.rev(), expected_rev);
        assert_eq!(restored.tree().get(&a).unwrap().parent, None);
        assert_eq!(restored.tree().get(&b).unwrap().parent, Some(a));
        assert_eq!(
            restored.tree().get(&a).unwrap().kind,
            BlockKind::Paragraph
        );
        // 避免 unused 告警
        let _ = mem;
    }

    /// G-HYD-3 / A-MEM-02 方向：hydrate 后冷 `text_snapshot` 可读。
    #[test]
    fn g_hyd_03_text_snapshot_readable_after_hydrate() {
        let blob_slot = std::sync::Arc::new(std::sync::Mutex::new(
            crate::persistence::HydrateBlob::default(),
        ));
        struct MemP(std::sync::Arc<std::sync::Mutex<crate::persistence::HydrateBlob>>);
        impl PersistencePlugin for MemP {
            fn load_doc(
                &self,
                _: &str,
            ) -> Result<crate::persistence::HydrateBlob, crate::persistence::PersistError>
            {
                Ok(self.0.lock().unwrap().clone())
            }
            fn on_committed(
                &self,
                _: &str,
                c: &CommitBatch,
            ) -> Result<(), crate::persistence::PersistError> {
                let mut blob = self.0.lock().unwrap();
                for u in &c.updates {
                    if matches!(u.kind, UpdateKind::Structure | UpdateKind::Combined) {
                        blob.snapshot = Some(u.bytes.clone());
                        blob.pending.clear();
                    }
                }
                Ok(())
            }
            fn flush_hint(&self, _: &str) -> Result<(), crate::persistence::PersistError> {
                Ok(())
            }
        }
        let mut s = DocSession::new("g-hyd-3").with_persistence(Box::new(MemP(blob_slot.clone())));
        let id = BlockId::new();
        s.apply(
            Origin::User,
            &[
                Op::Insert {
                    id,
                    parent: None,
                    order: "a0".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
                Op::TextEdit {
                    id,
                    start: 0,
                    end: 0,
                    insert: "cold-readable-after-hydrate".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(s.read_text(&id), "cold-readable-after-hydrate");

        let blob = blob_slot.lock().unwrap().clone();
        let restored = DocSession::hydrate("g-hyd-3", blob).unwrap();
        // 冷登记：默认不热，但可读（A-MEM-02）
        assert!(
            !restored.text_is_hot(&id),
            "hydrate 后默认冷，不强制全热"
        );
        assert_eq!(
            restored.read_text(&id),
            "cold-readable-after-hydrate",
            "冷 text_snapshot 须可读"
        );
        assert_eq!(
            restored.tree().get(&id).unwrap().text_snapshot.as_deref(),
            Some("cold-readable-after-hydrate")
        );
        assert!(restored.text_is_registered(&id));
    }

    /// 空 blob hydrate → 空会话（新文档合法）；非空不可解码 → Corrupt。
    #[test]
    fn g_hyd_empty_and_corrupt_blob() {
        let empty = DocSession::hydrate("e", crate::persistence::HydrateBlob::default()).unwrap();
        assert!(empty.tree().nodes.is_empty());
        assert_eq!(empty.rev(), 0);

        let bad = crate::persistence::HydrateBlob {
            snapshot: Some(42u64.to_le_bytes().to_vec()),
            pending: vec![],
        };
        match DocSession::hydrate("bad", bad) {
            Ok(_) => panic!("rev LE 占位不得 hydrate 成功"),
            Err(err) => assert!(matches!(err, HydrateError::Corrupt(_))),
        }
    }

    /// 远端文本合入须走 on_committed（写锥 / 统一 commit 面）。
    #[test]
    fn apply_remote_text_update_emits_on_committed() {
        let last = std::sync::Arc::new(std::sync::Mutex::new(None::<CommitBatch>));
        struct Cap(std::sync::Arc<std::sync::Mutex<Option<CommitBatch>>>);
        impl PersistencePlugin for Cap {
            fn load_doc(
                &self,
                _: &str,
            ) -> Result<crate::persistence::HydrateBlob, crate::persistence::PersistError>
            {
                Ok(Default::default())
            }
            fn on_committed(
                &self,
                _: &str,
                c: &CommitBatch,
            ) -> Result<(), crate::persistence::PersistError> {
                *self.0.lock().unwrap() = Some(c.clone());
                Ok(())
            }
            fn flush_hint(&self, _: &str) -> Result<(), crate::persistence::PersistError> {
                Ok(())
            }
        }
        let mut s = DocSession::new("remote-commit").with_persistence(Box::new(Cap(last.clone())));
        let id = BlockId::new();
        s.apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
        // 造一份 text update：先本地写再取 encode
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "local".into(),
            }],
        )
        .unwrap();
        let bytes = s.last_commit_text_updates()[0].bytes.clone();
        *last.lock().unwrap() = None;
        s.apply_remote_text_update(id, &bytes).unwrap();
        let batch = last.lock().unwrap().clone().expect("remote 须 on_committed");
        assert!(matches!(batch.origin, Origin::Remote));
        assert!(batch
            .updates
            .iter()
            .any(|u| matches!(u.kind, UpdateKind::Structure)
                && crate::structure_codec::is_structure_payload(&u.bytes)));
        assert!(batch
            .updates
            .iter()
            .any(|u| matches!(u.kind, UpdateKind::Text) && !u.bytes.is_empty()));
    }

    /// P-H2 / A-INV-09a：`on_committed` 第二次失败 → 树/文本/rev 与失败前 ≡，零半提交。
    ///
    /// MockPersistence：第 1 次成功（Insert 落盘），第 2 次 TextEdit 返回 Persist 错；
    /// 断言内存权威未前进（方案 A 快照回滚，非逆 op）。
    #[test]
    fn p_h2_persist_fail_rolls_back_tree_and_text() {
        use crate::a_inv_09::A_INV_09A;
        use crate::persistence::PersistError;
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

        let _ = A_INV_09A; // 验收锚：A-INV-09a + 18 补丁 P-H2

        /// MockPersistence：第 N 次 `on_committed` 起失败（计数从 1；P-H2 第二次失败）。
        struct FailAfterN {
            n: usize,
            calls: AtomicUsize,
        }
        impl PersistencePlugin for FailAfterN {
            fn load_doc(
                &self,
                _: &str,
            ) -> Result<crate::persistence::HydrateBlob, PersistError> {
                Ok(Default::default())
            }
            fn on_committed(
                &self,
                _: &str,
                _: &CommitBatch,
            ) -> Result<(), PersistError> {
                let c = self.calls.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                if c >= self.n {
                    Err(PersistError::Io("p_h2 mock persist fail".into()))
                } else {
                    Ok(())
                }
            }
            fn flush_hint(&self, _: &str) -> Result<(), PersistError> {
                Ok(())
            }
        }

        // n=2：第二次 on_committed 失败
        let mut s = DocSession::new("p-h2").with_persistence(Box::new(FailAfterN {
            n: 2,
            calls: AtomicUsize::new(0),
        }));
        let id = BlockId::new();

        // 第一次 apply（Insert）→ on_committed 成功
        s.apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .expect("first apply (insert) must succeed");

        // 基线：apply 前快照（第二次失败后须 ≡）
        let rev_before = s.rev();
        let tree_before = s.tree().clone();
        let text_before = s.read_text(&id);
        let tx_before = s.last_tx_id();
        let text_upd_before = s.last_commit_text_updates().to_vec();
        assert_eq!(rev_before, 1);
        assert_eq!(text_before, "");
        assert!(s.tree().nodes.contains_key(&id));

        // 第二次 apply（TextEdit）→ on_committed 失败 → 须整域回滚
        let err = s
            .apply(
                Origin::User,
                &[Op::TextEdit {
                    id,
                    start: 0,
                    end: 0,
                    insert: "should-not-stick".into(),
                }],
            )
            .expect_err("second apply must fail on persist");
        assert!(
            matches!(err, ApplyError::Persist(_)),
            "须为 Persist 错，got: {err:?}"
        );

        // 树 / 文本 / rev / 观测字段 ≡ 第二次 apply 前
        assert_eq!(s.rev(), rev_before, "rev 不得半前进");
        assert_eq!(
            s.tree(),
            &tree_before,
            "树结构须与 persist 失败前同构"
        );
        assert_eq!(
            s.read_text(&id),
            text_before,
            "文本引擎 plain text 须回滚"
        );
        assert_eq!(
            s.tree().get(&id).and_then(|n| n.text_snapshot.as_deref()),
            tree_before.get(&id).and_then(|n| n.text_snapshot.as_deref()),
            "树内 text_snapshot 须回滚"
        );
        assert_eq!(s.last_tx_id(), tx_before, "失败批不得污染 last_tx_id");
        assert_eq!(
            s.last_commit_text_updates(),
            text_upd_before.as_slice(),
            "失败批不得污染 last_text_updates"
        );
        // 半提交禁令：不得残留失败批写入的文本
        assert_ne!(s.read_text(&id), "should-not-stick");
    }

    // ─── W1-U · Undo v1（A-COL-04 / A-MEM-04 / A-INV-09c 后半）────────

    /// A-COL-04：`undo(filter)` 按 origin 过滤；栈顶不匹配不误撤。
    ///
    /// 场景：User 批 + Agent 批 → `undo(Some(User))` 在栈顶为 Agent 时
    /// `OriginMismatch` → `undo(None)` 撤 Agent → `undo(Some(User))` 撤 User。
    /// Remote/System 不入栈。
    #[test]
    fn a_col_04_undo_origin_filter() {
        use crate::a_col::A_COL_04;
        assert_eq!(A_COL_04, "A-COL-04");

        let mut s = DocSession::new("a-col-04");
        let user_id = BlockId::new();
        let agent_id = BlockId::new();

        // User 批：插入 user_id
        s.apply(
            Origin::User,
            &[Op::Insert {
                id: user_id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
        assert_eq!(s.undo_len(), 1);
        assert!(s.tree().nodes.contains_key(&user_id));

        // Agent 批：插入 agent_id（栈顶变为 Agent）
        s.apply(
            Origin::Agent,
            &[Op::Insert {
                id: agent_id,
                parent: None,
                order: "a1".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
        assert_eq!(s.undo_len(), 2);
        assert!(s.tree().nodes.contains_key(&agent_id));

        // Remote 不入栈
        let remote_id = BlockId::new();
        s.apply(
            Origin::Remote,
            &[Op::Insert {
                id: remote_id,
                parent: None,
                order: "a2".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
        assert_eq!(s.undo_len(), 2, "Remote 不得入 undo 栈");
        assert!(s.tree().nodes.contains_key(&remote_id));

        // System 不入栈
        let sys_id = BlockId::new();
        s.apply(
            Origin::System,
            &[Op::Insert {
                id: sys_id,
                parent: None,
                order: "a3".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
        assert_eq!(s.undo_len(), 2, "System 不得入 undo 栈");

        // 栈顶为 Agent：undo(Some(User)) → OriginMismatch，不误撤
        let err = s.undo(Some(Origin::User)).expect_err("须 OriginMismatch");
        assert_eq!(
            err,
            UndoError::OriginMismatch {
                expected: Origin::User,
                actual: Origin::Agent,
            }
        );
        assert_eq!(s.undo_len(), 2, "OriginMismatch 不得弹栈");
        assert!(
            s.tree().nodes.contains_key(&agent_id),
            "不得误撤 Agent 批"
        );
        assert!(s.tree().nodes.contains_key(&user_id));

        // undo(None) 撤栈顶 Agent
        let rev_before = s.rev();
        s.undo(None).expect("undo(None) 撤栈顶");
        assert_eq!(s.undo_len(), 1);
        assert!(!s.tree().nodes.contains_key(&agent_id), "Agent 批已撤");
        assert!(s.tree().nodes.contains_key(&user_id));
        // Remote/System 节点仍在（未入栈，undo 不碰它们；但 undo 恢复的是 Agent apply 前快照
        // → 快照时刻 remote/sys 尚不存在，故一并消失——符合「整批 pre 快照」语义）
        assert_eq!(s.rev(), rev_before + 1, "undo 后 rev 单调 +1");

        // undo(Some(User)) 撤 User
        s.undo(Some(Origin::User)).expect("撤 User 批");
        assert_eq!(s.undo_len(), 0);
        assert!(!s.tree().nodes.contains_key(&user_id));

        // 空栈
        assert_eq!(s.undo(None).unwrap_err(), UndoError::Empty);
    }

    /// A-MEM-04：跨冷 undo——小 max_hot 逼冷后 undo；结构正确；文本 plain 恢复。
    ///
    /// **禁止**用 reheat 测冒充：本测断言 undo 后结构 + plain，而非冷→热编辑路径。
    /// 细粒度 yrs 击键史在冷藏后允许截断；undo 以栈内 plain 快照为准。
    #[test]
    fn a_mem_04_undo_across_cold_restores_structure_and_plain_text() {
        use crate::a_mem::A_MEM_04;
        assert_eq!(A_MEM_04, "A-MEM-04");

        // max_hot=1：第二块热编辑会把第一块冷藏
        let mut s = DocSession::new("a-mem-04").with_text_max_hot(1);
        let a = BlockId::new();
        let b = BlockId::new();

        // 批1：插入 A + 文本 "alpha-v1"
        s.apply(
            Origin::User,
            &[
                Op::Insert {
                    id: a,
                    parent: None,
                    order: "a0".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
                Op::TextEdit {
                    id: a,
                    start: 0,
                    end: 0,
                    insert: "alpha-v1".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(s.read_text(&a), "alpha-v1");

        // 批2：编辑 A → "alpha-v2"
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id: a,
                start: 0,
                end: 8,
                insert: "alpha-v2".into(),
            }],
        )
        .unwrap();
        assert_eq!(s.read_text(&a), "alpha-v2");
        let rev_after_v2 = s.rev();

        // 批3：插入 B + 文本，逼 A 冷藏（跨冷边界）
        s.apply(
            Origin::User,
            &[
                Op::Insert {
                    id: b,
                    parent: None,
                    order: "a1".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
                Op::TextEdit {
                    id: b,
                    start: 0,
                    end: 0,
                    insert: "beta".into(),
                },
            ],
        )
        .unwrap();
        assert!(
            !s.text_is_hot(&a),
            "A 须已冷藏（max_hot=1，B 占热槽）"
        );
        assert_eq!(s.read_text(&a), "alpha-v2", "冷块仍可读 plain");
        assert!(s.text_is_hot(&b));
        assert_eq!(s.undo_len(), 3);

        // 在 A 仍冷时 undo 栈顶（撤 B）——跨冷后的第一步
        let rev_before = s.rev();
        s.undo(None).unwrap();
        assert!(!s.tree().nodes.contains_key(&b), "结构：B 已撤");
        assert!(s.tree().nodes.contains_key(&a), "结构：A 仍在");
        assert_eq!(s.read_text(&a), "alpha-v2", "plain 仍为 v2");
        assert_eq!(s.rev(), rev_before + 1);

        // 再 undo 批2（v1→v2）：文本以 plain 快照恢复为 v1
        s.undo(None).unwrap();
        assert!(s.tree().nodes.contains_key(&a), "跨冷 undo 后结构仍含 A");
        assert_eq!(
            s.read_text(&a),
            "alpha-v1",
            "文本以 plain 快照恢复（yrs 击键史可截断）"
        );
        assert_eq!(
            s.tree().get(&a).and_then(|n| n.text_snapshot.as_deref()),
            Some("alpha-v1")
        );
        assert!(s.rev() > rev_after_v2, "undo 路径 rev 单调前进");
    }

    /// A-INV-09c 后半：Insert+TextEdit → Delete → undo → 块与文本恢复。
    #[test]
    fn a_inv_09c_undo_restores_deleted_block_and_text() {
        use crate::a_inv_09::A_INV_09C;
        let _ = A_INV_09C;

        let mut s = DocSession::new("a-inv-09c-undo");
        let id = BlockId::new();

        // 同批 Insert + TextEdit
        s.apply(
            Origin::User,
            &[
                Op::Insert {
                    id,
                    parent: None,
                    order: "a0".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
                Op::TextEdit {
                    id,
                    start: 0,
                    end: 0,
                    insert: "keep-me".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(s.read_text(&id), "keep-me");
        assert!(s.text_is_registered(&id));
        assert_eq!(s.undo_len(), 1);

        // Delete 释放文本槽（09c 前半）
        s.apply(Origin::User, &[Op::Delete { id }]).unwrap();
        assert!(!s.tree().nodes.contains_key(&id));
        assert!(!s.text_is_registered(&id));
        assert_eq!(s.undo_len(), 2);

        // undo Delete → 块与文本恢复（09c 后半）
        let rev_before = s.rev();
        s.undo(None).unwrap();
        assert!(s.tree().nodes.contains_key(&id), "块须恢复");
        assert!(s.text_is_registered(&id), "文本槽须恢复");
        assert_eq!(s.read_text(&id), "keep-me", "文本 plain 须恢复");
        assert_eq!(
            s.tree().get(&id).and_then(|n| n.text_snapshot.as_deref()),
            Some("keep-me")
        );
        assert_eq!(s.rev(), rev_before + 1);
        assert_eq!(s.undo_len(), 1);

        // 再 undo 创建批 → 空树
        s.undo(None).unwrap();
        assert!(!s.tree().nodes.contains_key(&id));
        assert!(!s.text_is_registered(&id));
        assert_eq!(s.undo_len(), 0);
    }

    /// W1-U 辅：undo persist 失败时内存态与栈深度回滚。
    #[test]
    fn undo_persist_fail_rolls_back_stack_and_state() {
        use crate::persistence::PersistError;
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

        struct FailUndoCommit {
            /// 允许成功的 on_committed 次数；之后失败。
            allow: usize,
            calls: AtomicUsize,
        }
        impl PersistencePlugin for FailUndoCommit {
            fn load_doc(
                &self,
                _: &str,
            ) -> Result<crate::persistence::HydrateBlob, PersistError> {
                Ok(Default::default())
            }
            fn on_committed(
                &self,
                _: &str,
                _: &CommitBatch,
            ) -> Result<(), PersistError> {
                let n = self.calls.fetch_add(1, AtomicOrdering::SeqCst);
                if n >= self.allow {
                    Err(PersistError::Io("undo persist fail".into()))
                } else {
                    Ok(())
                }
            }
            fn flush_hint(&self, _: &str) -> Result<(), PersistError> {
                Ok(())
            }
        }

        // allow=1：仅第一次 apply 的 commit 成功；undo 的 emit_commit 失败
        let mut s = DocSession::new("undo-persist").with_persistence(Box::new(FailUndoCommit {
            allow: 1,
            calls: AtomicUsize::new(0),
        }));
        let id = BlockId::new();
        s.apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
        assert_eq!(s.undo_len(), 1);
        let rev = s.rev();
        let nodes = s.tree().nodes.len();

        let err = s.undo(None).expect_err("undo persist must fail");
        assert!(matches!(err, UndoError::Persist(_)));
        assert_eq!(s.undo_len(), 1, "失败须压回栈");
        assert_eq!(s.rev(), rev, "rev 不得半前进");
        assert_eq!(s.tree().nodes.len(), nodes);
        assert!(s.tree().nodes.contains_key(&id));
    }
}
