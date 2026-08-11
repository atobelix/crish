//! DocSession：唯一 apply 入口。
//!
//! - 结构：自研块树 Op（MV-01…04 / 环检测 / 删胜）
//! - 文本：私有 [`crate::text_engine::TextEngine`]（yrs + 热集/冷藏，H1）
//! - 同批原子：预校验失败整批零改树/零改文本（A-INV-09a）
//! - 删块同步释放文本引擎（A-INV-09c）
//! - 超长单块（M2 / A-HUGE）：`T_HUGE` 亚阈保持单叶；超阈同事务分段叶子（`split_of`）
//!
//! 并发 move 规则见 `docs/block-workspace-architecture/plans/specs/concurrent-move-rules.md`
//! 与 18 §M1。超长策略见 `docs/.../specs/huge-block-policy.md`。

use crate::block_id::BlockId;
use crate::events::{BlockUpsert, DocEvent, ProjectionDiff};
use crate::ir::{BlockNode, BlockProps, BlockTree};
use crate::op::{Op, Origin};
use crate::persistence::{CommitBatch, EncodedUpdate, PersistencePlugin, UpdateKind};
use crate::text_engine::{simulate_char_edit, TextEngine, TextEngineError};
use crate::tx::{TxGuard, TxId};
use std::collections::{HashMap, HashSet};
use thiserror::Error;

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

pub struct DocSession {
    pub doc_id: String,
    pub tree: BlockTree,
    pub rev: u64,
    persistence: Option<Box<dyn PersistencePlugin>>,
    /// 叶子文本引擎（crate 内私有字段；不暴露 yrs 类型）。
    text_engine: TextEngine,
    /// 上次成功 apply 的事务 id（A-INV-09b 观测）。
    last_tx_id: Option<TxId>,
    /// 上次成功 apply 产生的文本 update（W1-F / 无 yrs 类型外泄）。
    last_text_updates: Vec<TextUpdatePayload>,
    /// 单叶 UTF-8 字节超长阈（`T_HUGE`）；默认 256 KiB，钳制 64KiB..=16MiB。
    huge_threshold: usize,
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
        }
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
    /// 不经结构 Op；成功后 bump rev 并同步 `text_snapshot`。
    pub fn apply_remote_text_update(
        &mut self,
        id: BlockId,
        bytes: &[u8],
    ) -> Result<(), ApplyError> {
        if !self.tree.nodes.contains_key(&id) {
            return Err(ApplyError::NotFound(id.to_string()));
        }
        let new_text = self.text_engine.apply_remote_update(id, bytes)?;
        if let Some(n) = self.tree.nodes.get_mut(&id) {
            n.text_snapshot = Some(new_text);
        }
        self.rev += 1;
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
    pub fn apply(&mut self, origin: Origin, ops: &[Op]) -> Result<DocEvent, ApplyError> {
        let tx = TxGuard::begin();
        let tx_id = tx.id();

        // 预校验（结构 + 文本偏移模拟）：失败则整批不改树/不改文本（A-INV-09a）
        self.validate_batch(ops)?;

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

        // M2 / A-HUGE-02：同事务尾部对超阈文本叶自动分段（主路径）；失败则整批已无法回滚用户
        // Op——分段本身设计为确定性/不失败。预校验已保证用户 Op 可成功。
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
        self.last_tx_id = Some(tx_id);
        self.last_text_updates = text_payloads.clone();

        if let Some(p) = &self.persistence {
            let mut updates = vec![EncodedUpdate {
                // 结构侧尚无独立 CRDT encode；占位标记 + tx 同源（A-INV-09b）
                bytes: rev.to_le_bytes().to_vec(),
                kind: UpdateKind::Structure,
            }];
            for pld in &text_payloads {
                updates.push(EncodedUpdate {
                    bytes: pld.bytes.clone(),
                    kind: UpdateKind::Text,
                });
            }
            if updates.len() == 1 && !text_touches.is_empty() {
                // 文本变了但未能 encode（极端冷）时仍记 Combined 标记
                updates[0].kind = UpdateKind::Combined;
            }
            let batch = CommitBatch {
                tx_id,
                origin,
                updates,
                snapshot_tick: false,
            };
            p.on_committed(&self.doc_id, &batch)
                .map_err(|e| ApplyError::Persist(e.to_string()))?;
        }

        tx.commit();

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

    /// A-MEM-02/04（会话层）：冷块可读 + 再编辑。
    #[test]
    fn a_mem_02_04_session_cold_read_and_reheat() {
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
}
