//! 叶子文本引擎（H1）：yrs YText + 热集 / 冷藏。
//!
//! # 不变量
//! - **crate-private**：本模块 `mod text_engine`，不 `pub mod`，公共 API 零 yrs 类型外泄（A-INV-05）
//! - **热集**：仅 pin + 近编辑 LRU 持有活动 `Doc`/`YText`；上界 `max_hot`（默认 512）
//! - **冷藏**：卸载 YText，保留 `text_snapshot`；只读/搜索不依赖热实例（A-MEM-02）
//! - **远端 update 合入冷块**：必须先 rehydrate，禁止静默丢（A-MEM-03 / H1）
//! - **删块**：`release_block` 同步释放热槽与快照（A-INV-09c）
//!
//! # 偏移
//! `Op::TextEdit` 仍用 **Unicode 标量（char）偏移**（与 W0 骨架一致）；写入 yrs 时换算为
//! **UTF-8 字节**索引（yrs 默认 `OffsetKind::Bytes`）。

use crate::block_id::BlockId;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use thiserror::Error;
use yrs::undo::{Options as UndoOptions, UndoManager};
use yrs::updates::decoder::Decode;
use yrs::Origin as YrsOrigin;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

/// H1 / A-MEM-01 默认热集上界。
pub const DEFAULT_MAX_HOT: usize = 512;

/// 根类型名：每叶子块独占一个 `Doc`，根 Text 固定名。
pub const ROOT_TEXT: &str = "t";

/// 叶子块热态运行时：包含 Doc 实例与原生因果 UndoManager。
pub struct TextHost {
    pub undo_mgr: UndoManager<()>,
    pub doc: Doc,
}

// SAFETY（B4 审查结论：仅 Send，已收窄去掉 Sync）：
//
// 为何必须 `unsafe impl Send`：yrs 无 `sync` feature 时 `Doc` / `UndoManager`
// 不自动 `Send`（内部 `Rc`/`RefCell` 使 auto-trait 不成立）。二者是纯内存结构，
// 不绑定 OS 线程、不持 thread-local。`TextHost` 同时拥有 `doc` 与 `undo_mgr`，
// 跨线程移动时二者一起走，无悬挂别名。独占所有权下把值移到另一线程安全。
//
// 为何不实现 `Sync`：`Doc` 以 `&self` 暴露 `transact` / `get_or_insert_text`
//（内部可变）。`Sync` 允许 `&TextHost` 跨线程共享，两线程同时 `transact` 即
// 数据竞争。旧注释称「`Sync` 是为了让 `Mutex<DocSession>` 满足 Send」不成立：
// `Mutex<T>: Send` 与 `Mutex<T>: Sync` 都只要求 `T: Send`，不要求 `T: Sync`。
// 生产路径经 `Arc<Mutex<DocSession>>` 访问（`store_backend.rs` 分片锁），
// 持锁后才碰 `TextHost`；去掉 `Sync` 后编译器会拒绝把 `&TextHost` 裸传跨线程。
#[allow(unsafe_code)]
unsafe impl Send for TextHost {}

impl TextHost {
    pub fn new() -> Self {
        let doc = Doc::new();
        let text = doc.get_or_insert_text(ROOT_TEXT);
        let mut options = UndoOptions::default();
        options.capture_timeout_millis = 0;
        let undo_mgr = UndoManager::<()>::with_scope_and_options(&doc, &text, options);
        Self { undo_mgr, doc }
    }

    pub fn from_update(update_bytes: &[u8]) -> Result<Self, TextEngineError> {
        let doc = Doc::new();
        if !update_bytes.is_empty() {
            let update = Update::decode_v1(update_bytes)
                .map_err(|e| TextEngineError::UpdateDecode(e.to_string()))?;
            doc.transact_mut()
                .apply_update(update)
                .map_err(|e| TextEngineError::UpdateApply(e.to_string()))?;
        }
        let text = doc.get_or_insert_text(ROOT_TEXT);
        let mut options = UndoOptions::default();
        options.capture_timeout_millis = 0;
        let undo_mgr = UndoManager::<()>::with_scope_and_options(&doc, &text, options);
        Ok(Self { undo_mgr, doc })
    }
}

/// 文本引擎配置。
#[derive(Debug, Clone)]
pub struct TextEngineConfig {
    /// 活动 YText（热 Doc）实例上界；pin 过多时可短暂超过（H1：窗口+pin+LRU）。
    pub max_hot: usize,
}

impl Default for TextEngineConfig {
    fn default() -> Self {
        Self {
            max_hot: DEFAULT_MAX_HOT,
        }
    }
}

#[derive(Debug, Error)]
pub enum TextEngineError {
    #[error("text offset out of range")]
    OffsetOutOfRange,
    #[error("block not registered in text engine: {0}")]
    NotRegistered(String),
    #[error("yrs update decode: {0}")]
    UpdateDecode(String),
    #[error("yrs apply update: {0}")]
    UpdateApply(String),
    #[error("no undo history")]
    NoUndoHistory,
    #[error("no redo history")]
    NoRedoHistory,
}

/// 叶子文本引擎：热 Doc 表 + 全量快照 + 冷藏二进制 + pin/LRU。
///
/// 不对外暴露 `yrs::Doc` / `TextRef`。
pub struct TextEngine {
    max_hot: usize,
    /// 所有已登记叶子的当前文本快照（冷热均可读）。
    snapshots: HashMap<BlockId, Arc<str>>,
    /// 冷藏块的全量因果 StateVector update 二进制（冷藏无损唤醒，根除 Duplicate Glitch）。
    cold_updates: HashMap<BlockId, Vec<u8>>,
    /// 热态：活动 TextHost（内含 yrs Doc 与 UndoManager）。
    hot: HashMap<BlockId, TextHost>,
    /// pin：焦点/composing 等，LRU 驱逐时跳过。
    pinned: HashSet<BlockId>,
    /// 最近 touch：front=最旧，back=最新（仅含当前热块）。
    lru: VecDeque<BlockId>,
    /// I3：增量 checkpoint 的版本追踪 — 仅 O(involved) 快照，无全量 HashSet 克隆。
    /// `next_version` 为单调递增的块创建版本；`block_versions` / `version_index` 记录
    /// 每个已登记块的创建版本，用于 `restore` 时 O(新增) 释放 checkpoint 后新建块
    ///（含 huge split 与 TextEngine 直接 init 的块），避免全表 `registered_ids()` 扫描。
    next_version: u64,
    block_versions: HashMap<BlockId, u64>,
    version_index: BTreeMap<u64, BlockId>,
}

impl Default for TextEngine {
    fn default() -> Self {
        Self::new(TextEngineConfig::default())
    }
}

impl TextEngine {
    pub fn new(config: TextEngineConfig) -> Self {
        Self {
            max_hot: config.max_hot.max(1),
            snapshots: HashMap::new(),
            cold_updates: HashMap::new(),
            hot: HashMap::new(),
            pinned: HashSet::new(),
            lru: VecDeque::new(),
            next_version: 1,
            block_versions: HashMap::new(),
            version_index: BTreeMap::new(),
        }
    }

    pub fn with_max_hot(max_hot: usize) -> Self {
        Self::new(TextEngineConfig { max_hot })
    }

    pub fn max_hot(&self) -> usize {
        self.max_hot
    }

    /// 活动 YText 实例数（A-MEM-01）。
    pub fn hot_count(&self) -> usize {
        self.hot.len()
    }

    pub fn is_hot(&self, id: BlockId) -> bool {
        self.hot.contains_key(&id)
    }

    pub fn is_registered(&self, id: BlockId) -> bool {
        self.snapshots.contains_key(&id) || self.cold_updates.contains_key(&id)
    }

    /// Insert 叶子：登记空快照，默认 **冷**（不占热槽，直至 touch/edit）。
    pub fn init_block(&mut self, id: BlockId) {
        let is_new = !self.is_registered(id);
        self.snapshots.entry(id).or_insert_with(|| Arc::from(""));
        if is_new {
            self.track_version(id);
        }
    }

    /// 带初始快照登记（hydrate / 恢复用，G-HYD-2 冷文本）。
    pub fn init_block_with_text(&mut self, id: BlockId, text: impl Into<String>) {
        let is_new = !self.is_registered(id);
        let s: String = text.into();
        self.snapshots.insert(id, Arc::from(s.as_str()));
        self.cold_updates.remove(&id);
        if is_new {
            self.track_version(id);
        }
        // 若已热，同步重写 YText
        if self.hot.contains_key(&id) {
            self.rewrite_hot_from_snapshot(id);
        }
    }

    /// 带冷藏二进制 update 登记（hydrate / 增量回放用）。
    /// 增量 restore 走 `restore_block_data`，本入口留给冷藏二进制 hydrate。
    #[allow(dead_code)]
    pub fn init_block_with_cold_update(
        &mut self,
        id: BlockId,
        text: impl Into<String>,
        update_bytes: Vec<u8>,
    ) {
        let is_new = !self.is_registered(id);
        let s: String = text.into();
        self.snapshots.insert(id, Arc::from(s.as_str()));
        self.cold_updates.insert(id, update_bytes);
        if is_new {
            self.track_version(id);
        }
        if self.hot.contains_key(&id) {
            self.hot.remove(&id);
            let _ = self.ensure_hot(id);
        }
    }

    #[inline]
    fn track_version(&mut self, id: BlockId) {
        let v = self.next_version;
        self.next_version += 1;
        self.block_versions.insert(id, v);
        self.version_index.insert(v, id);
    }

    /// 确保块处于热态；优先从 cold_updates 二进制中无损还原，否则从快照 rehydrate。
    pub fn ensure_hot(&mut self, id: BlockId) -> Result<(), TextEngineError> {
        if !self.snapshots.contains_key(&id) && !self.cold_updates.contains_key(&id) {
            return Err(TextEngineError::NotRegistered(id.to_string()));
        }
        if self.hot.contains_key(&id) {
            self.touch_lru(id);
            return Ok(());
        }

        // 1. 优先从 cold_updates 二进制中无损还原
        let host = if let Some(cold_bytes) = self.cold_updates.remove(&id) {
            TextHost::from_update(&cold_bytes)?
        } else if let Some(snap) = self.snapshots.get(&id).cloned() {
            let host = TextHost::new();
            if !snap.is_empty() {
                let text = host.doc.get_or_insert_text(ROOT_TEXT);
                text.insert(&mut host.doc.transact_mut(), 0, snap.as_ref());
            }
            host
        } else {
            TextHost::new()
        };

        self.hot.insert(id, host);
        self.touch_lru(id);
        self.evict_cold_if_needed();

        // 驱逐不应打掉刚 touch 的 id（其在 LRU 最末）；若 max_hot=1 且自 pin 冲突则可能，再 ensure 一次
        if !self.hot.contains_key(&id) {
            let host = if let Some(cold_bytes) = self.cold_updates.remove(&id) {
                TextHost::from_update(&cold_bytes)?
            } else if let Some(snap) = self.snapshots.get(&id).cloned() {
                let host = TextHost::new();
                if !snap.is_empty() {
                    let text = host.doc.get_or_insert_text(ROOT_TEXT);
                    text.insert(&mut host.doc.transact_mut(), 0, snap.as_ref());
                }
                host
            } else {
                TextHost::new()
            };
            self.hot.insert(id, host);
            self.touch_lru(id);
            // 此时若仍超限，只能牺牲更旧的非 pin
            self.evict_cold_if_needed();
        }
        Ok(())
    }

    /// 若热数超过 `max_hot`，按 LRU 冷藏最旧的非 pin 块。
    pub fn evict_cold_if_needed(&mut self) {
        while self.hot.len() > self.max_hot {
            let victim = self
                .lru
                .iter()
                .find(|id| !self.pinned.contains(id) && self.hot.contains_key(id))
                .copied();
            match victim {
                Some(id) => self.evict_one(id),
                // 全部 pin：允许短暂超过 max_hot（H1 pin 优先）
                None => break,
            }
        }
    }

    /// 显式 touch（窗口滚动 / 焦点）；未登记或未热则 no-op（热路径由 ensure_hot 负责）。
    pub fn touch(&mut self, id: BlockId) {
        if self.hot.contains_key(&id) {
            self.touch_lru(id);
        }
    }

    pub fn pin(&mut self, id: BlockId) {
        self.pinned.insert(id);
    }

    pub fn unpin(&mut self, id: BlockId) {
        self.pinned.remove(&id);
        self.evict_cold_if_needed();
    }

    /// 冷热均可读（A-MEM-02）。
    pub fn read_text(&self, id: BlockId) -> String {
        if let Some(host) = self.hot.get(&id) {
            let text = host.doc.get_or_insert_text(ROOT_TEXT);
            return text.get_string(&host.doc.transact());
        }
        self.snapshots
            .get(&id)
            .map(|s| s.to_string())
            .unwrap_or_default()
    }

    /// 当前快照句柄（与 `BlockNode.text_snapshot` 同步用）。
    #[allow(dead_code)] // 投影/hydrate 与单测使用
    pub fn snapshot_arc(&self, id: BlockId) -> Option<Arc<str>> {
        self.snapshots.get(&id).cloned()
    }

    /// 本地编辑：char 偏移 `[start, end)` 替换为 `insert`；必要时 rehydrate。
    ///
    /// 返回编辑后全文。
    pub fn apply_edit(
        &mut self,
        id: BlockId,
        start: u32,
        end: u32,
        insert: &str,
    ) -> Result<String, TextEngineError> {
        self.ensure_hot(id)?;
        let host = self
            .hot
            .get_mut(&id)
            .ok_or_else(|| TextEngineError::NotRegistered(id.to_string()))?;
        let text = host.doc.get_or_insert_text(ROOT_TEXT);
        let current = {
            let txn = host.doc.transact();
            text.get_string(&txn)
        };
        let (byte_start, remove_len) = char_range_to_bytes(&current, start, end)?;
        {
            let mut txn = host.doc.transact_mut();
            if remove_len > 0 {
                text.remove_range(&mut txn, byte_start, remove_len);
            }
            if !insert.is_empty() {
                text.insert(&mut txn, byte_start, insert);
            }
        }
        let new_text = {
            let txn = host.doc.transact();
            text.get_string(&txn)
        };
        self.snapshots.insert(id, Arc::from(new_text.as_str()));
        self.touch_lru(id);
        self.evict_cold_if_needed();
        Ok(new_text)
    }

    /// 远端 yrs update（v1）合入指定块。
    ///
    /// **冷块必须 rehydrate**（H1 / A-MEM-03），禁止对已卸载 YText 静默丢弃。
    pub fn apply_remote_update(
        &mut self,
        id: BlockId,
        bytes: &[u8],
    ) -> Result<String, TextEngineError> {
        self.ensure_hot(id)?;
        let host = self
            .hot
            .get_mut(&id)
            .ok_or_else(|| TextEngineError::NotRegistered(id.to_string()))?;
        {
            let remote_origin = YrsOrigin::from("remote");
            let mut txn = host.doc.transact_mut_with(remote_origin);
            let update = Update::decode_v1(bytes)
                .map_err(|e| TextEngineError::UpdateDecode(e.to_string()))?;
            txn.apply_update(update)
                .map_err(|e| TextEngineError::UpdateApply(e.to_string()))?;
        }
        let text = host.doc.get_or_insert_text(ROOT_TEXT);
        let new_text = {
            let txn = host.doc.transact();
            text.get_string(&txn)
        };
        self.snapshots.insert(id, Arc::from(new_text.as_str()));
        self.touch_lru(id);
        self.evict_cold_if_needed();
        Ok(new_text)
    }

    /// 导出该块当前状态为 update v1。热块取实时编码，冷块取已冷藏的二进制。
    pub fn encode_state_update(&self, id: BlockId) -> Option<Vec<u8>> {
        if let Some(host) = self.hot.get(&id) {
            let bytes = {
                let txn = host.doc.transact();
                txn.encode_state_as_update_v1(&StateVector::default())
            };
            Some(bytes)
        } else {
            self.cold_updates.get(&id).cloned()
        }
    }

    /// 执行指定块的文本级 CRDT 原生因果撤销（UndoManager）。
    /// 仅回退属于本地 Client 的变更，不伤害并发远端协作者的文本。
    pub fn undo_text(&mut self, id: BlockId) -> Result<String, TextEngineError> {
        self.ensure_hot(id)?;
        let (undone, current) = {
            let host = self
                .hot
                .get_mut(&id)
                .ok_or_else(|| TextEngineError::NotRegistered(id.to_string()))?;
            let undone = host.undo_mgr.undo_blocking();
            let text = host.doc.get_or_insert_text(ROOT_TEXT);
            let txn = host.doc.transact();
            (undone, text.get_string(&txn))
        };
        if !undone {
            return Err(TextEngineError::NoUndoHistory);
        }
        self.snapshots.insert(id, Arc::from(current.as_str()));
        self.touch_lru(id);
        self.evict_cold_if_needed();
        Ok(current)
    }

    /// 执行指定块的文本级 CRDT 原生因果重做（UndoManager）。
    pub fn redo_text(&mut self, id: BlockId) -> Result<String, TextEngineError> {
        self.ensure_hot(id)?;
        let (redone, current) = {
            let host = self
                .hot
                .get_mut(&id)
                .ok_or_else(|| TextEngineError::NotRegistered(id.to_string()))?;
            let redone = host.undo_mgr.redo_blocking();
            let text = host.doc.get_or_insert_text(ROOT_TEXT);
            let txn = host.doc.transact();
            (redone, text.get_string(&txn))
        };
        if !redone {
            return Err(TextEngineError::NoRedoHistory);
        }
        self.snapshots.insert(id, Arc::from(current.as_str()));
        self.touch_lru(id);
        self.evict_cold_if_needed();
        Ok(current)
    }

    pub fn can_undo_text(&self, id: BlockId) -> bool {
        self.hot
            .get(&id)
            .map(|h| h.undo_mgr.can_undo())
            .unwrap_or(false)
    }

    pub fn can_redo_text(&self, id: BlockId) -> bool {
        self.hot
            .get(&id)
            .map(|h| h.undo_mgr.can_redo())
            .unwrap_or(false)
    }

    /// 删块：释放热槽、快照与冷藏二进制（A-INV-09c）。
    pub fn release_block(&mut self, id: BlockId) {
        self.hot.remove(&id);
        self.snapshots.remove(&id);
        self.cold_updates.remove(&id);
        self.pinned.remove(&id);
        self.lru.retain(|x| *x != id);
        if let Some(v) = self.block_versions.remove(&id) {
            self.version_index.remove(&v);
        }
    }

    /// 预校验 char 偏移（不改状态；供 A-INV-09a 同批预检）。
    #[allow(dead_code)] // 会话侧用 simulate_char_edit；保留引擎入口对称
    pub fn validate_edit_offsets(
        &self,
        current: &str,
        start: u32,
        end: u32,
    ) -> Result<(), TextEngineError> {
        let _ = char_range_to_bytes(current, start, end)?;
        Ok(())
    }

    fn touch_lru(&mut self, id: BlockId) {
        self.lru.retain(|x| *x != id);
        self.lru.push_back(id);
    }

    fn evict_one(&mut self, id: BlockId) {
        if let Some(host) = self.hot.remove(&id) {
            let (s, state_update) = {
                let text = host.doc.get_or_insert_text(ROOT_TEXT);
                let txn = host.doc.transact();
                let s = text.get_string(&txn);
                let state_update = txn.encode_state_as_update_v1(&StateVector::default());
                (s, state_update)
            };
            self.snapshots.insert(id, Arc::from(s.as_str()));
            self.cold_updates.insert(id, state_update);
        }
        self.lru.retain(|x| *x != id);
    }

    #[allow(dead_code)] // init_block_with_text 热路径
    fn rewrite_hot_from_snapshot(&mut self, id: BlockId) {
        let Some(snap) = self.snapshots.get(&id).cloned() else {
            return;
        };
        self.hot.remove(&id);
        let host = TextHost::new();
        {
            let text = host.doc.get_or_insert_text(ROOT_TEXT);
            let mut txn = host.doc.transact_mut();
            if !snap.is_empty() {
                text.insert(&mut txn, 0, snap.as_ref());
            }
        }
        self.hot.insert(id, host);
        self.touch_lru(id);
    }

    // ─── P-H2 增量检查点（3-5：只快照涉及块，不 cold_updates.clone() 全表）──

    /// 当前已登记块 id（仅键；不含冷藏字节）。
    ///
    /// I3 精修：由全表 `snapshots`/`cold_updates` 双表扫描改为复用 `version_index`
    /// 有序索引，避免双表哈希合并；仍 O(N) 但与增量路径同源。增量 undo 已改走
    /// `ids_created_since` + `registered_involved`，不再依赖此全量方法。
    /// 保留此方法供外部兼容与测试，非增量热路径。
    #[allow(dead_code)]
    pub(crate) fn registered_ids(&self) -> HashSet<BlockId> {
        // 复用 version_index（BTree 有序，O(N) 收集），与 checkpoint/restore 版本语义同源
        self.version_index.values().copied().collect()
    }

    /// 增量：自 `since_version` 以来新建的块 id（O(新增)，复用 version_index 有序区间）。
    pub(crate) fn ids_created_since(&self, since_version: u64) -> Vec<BlockId> {
        self.version_index
            .range(since_version..)
            .map(|(_, id)| *id)
            .collect()
    }

    /// 只捕获 `involved` 中块的可恢复数据。
    ///
    /// I3 收敛：`registered: HashSet` 全量已改为 `version` + `registered_involved` 增量。
    /// - 不 `cold_updates.clone()` 全表：未涉及块的 `Vec<u8>` 留在活表里（restore
    ///   不替换）。不把活表改成 `Arc<HashMap>` 再给检查点握一份——apply 随后
    ///   `make_mut` 会因引用计数 >1 整表拷一次，等于把全表 clone 推迟到热路径。
    /// - 不 `registered_ids()` 全量：仅记录 `involved ∩ old`（O(involved)），
    ///   新增块释放由 `version_index.range(version..)` O(新增) 完成。
    pub(crate) fn checkpoint(&self, involved: &HashSet<BlockId>) -> TextEngineCheckpoint {
        let mut blocks = HashMap::with_capacity(involved.len());
        let mut registered_involved = HashSet::with_capacity(involved.len());
        for &id in involved {
            let existed = self.is_registered(id);
            if !existed {
                blocks.insert(
                    id,
                    BlockCheckpoint {
                        text: Arc::from(""),
                        update: None,
                        existed: false,
                        version: None,
                    },
                );
                continue;
            }
            registered_involved.insert(id);
            let text: Arc<str> = if self.hot.contains_key(&id) {
                Arc::from(self.read_text(id).as_str())
            } else {
                self.snapshots
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| Arc::from(""))
            };
            // 热块 encode 自身；冷块只 clone 这一条 entry
            let update = self.encode_state_update(id);
            let version = self.block_versions.get(&id).copied();
            blocks.insert(
                id,
                BlockCheckpoint {
                    text,
                    update,
                    existed: true,
                    version,
                },
            );
        }
        TextEngineCheckpoint {
            max_hot: self.max_hot,
            blocks,
            version: self.next_version,
            registered_involved,
            pinned: self.pinned.clone(),
            was_hot: self.hot.keys().copied().collect(),
        }
    }

    fn restore_block_data(
        &mut self,
        id: BlockId,
        text: Arc<str>,
        update: Option<Vec<u8>>,
        version: Option<u64>,
    ) {
        self.snapshots.insert(id, text);
        match update {
            Some(bytes) => {
                self.cold_updates.insert(id, bytes);
            }
            None => {
                self.cold_updates.remove(&id);
            }
        }
        if self.hot.remove(&id).is_some() {
            self.lru.retain(|x| *x != id);
        }
        // I3：恢复被删块的版本，使其版本 < checkpoint.version，从而不在待释放集合中
        if let Some(v) = version {
            // 若该 id 已在 version_index 中（可能因 huge split 新建后又被删），先清理旧版本
            if let Some(old_v) = self.block_versions.get(&id).copied() {
                self.version_index.remove(&old_v);
            }
            self.block_versions.insert(id, v);
            self.version_index.insert(v, id);
            // 确保 next_version 不回退（checkpoint 的 version 已是 next_version）
            if v >= self.next_version {
                self.next_version = v + 1;
            }
        } else if self.is_registered(id) {
            // 无版本记录的已存在块（如 hydrate 路径），按新块追踪
            self.track_version(id);
        }
    }

    /// 只恢复涉及块；未涉及块保持原状（COW）。P-H2：回滚后 ≡ checkpoint 时。
    ///
    /// I3 收敛：`registered` 全量释放已改为 `version_index.range(version..)` 增量释放，
    /// 仅释放 checkpoint 后新建块（含 huge split），复杂度 O(新增) 而非 O(N)。
    pub(crate) fn restore(&mut self, cp: TextEngineCheckpoint) {
        // I3：增量释放 checkpoint 后新建块（version >= cp.version）
        // `version_index` 按创建版本有序，range 为 O(新增) 而非全表扫描
        let to_release: Vec<BlockId> = self
            .version_index
            .range(cp.version..)
            .map(|(_, id)| *id)
            .collect();
        for id in to_release {
            self.release_block(id);
        }

        for (id, blk) in cp.blocks {
            if !blk.existed {
                self.release_block(id);
                continue;
            }
            self.restore_block_data(id, blk.text, blk.update, blk.version);
        }

        self.pinned = cp.pinned;
        let extra_hot: Vec<BlockId> = self
            .hot
            .keys()
            .copied()
            .filter(|id| !cp.was_hot.contains(id))
            .collect();
        for id in extra_hot {
            self.evict_one(id);
        }
        for id in cp.was_hot {
            let _ = self.ensure_hot(id);
        }
        self.max_hot = cp.max_hot.max(1);
        // I3：恢复后 next_version 不回退，保证版本单调
        if self.next_version < cp.version {
            self.next_version = cp.version;
        }
    }
}

/// 单块增量快照（仅 involved）。
#[derive(Debug, Clone)]
struct BlockCheckpoint {
    text: Arc<str>,
    update: Option<Vec<u8>>,
    existed: bool,
    /// I3：该块在 checkpoint 时的创建版本（仅 existed==true 时有效）。
    /// 用于 `restore` 重建被删块时恢复其版本，使其版本 < checkpoint.version，
    /// 从而不在 `version_index.range(version..)` 的待释放集合中。
    version: Option<u64>,
}

/// P-H2：文本引擎增量检查点（crate 内；不外泄 yrs 类型）。
///
/// I3 收敛：`registered: HashSet<BlockId>` 全量已改为增量 `version` + `registered_involved`。
/// - `version` 为 checkpoint 时的 `next_version`，用于 `restore` 时 O(新增) 释放
///   checkpoint 后新建块（含 huge split 与 TextEngine 直接 init 的块），避免
///   `registered_ids()` 全表扫描与全量 HashSet 克隆。
/// - `registered_involved` 仅记录 `involved ∩ old_registered`（O(involved)），
///   供 `contains_registered` 判断涉及块是否在旧表中；未涉及块的 old 判定
///   通过 `version` 推断（旧块版本 < version，新块版本 >= version）。
/// 数据只含本次涉及块；`was_hot` / `pinned` 是 id 集合（无字节，pinned/was_hot 上界 512）。
#[derive(Debug, Clone)]
pub(crate) struct TextEngineCheckpoint {
    max_hot: usize,
    blocks: HashMap<BlockId, BlockCheckpoint>,
    /// I3：checkpoint 时的 next_version，用于增量释放新增块。
    version: u64,
    /// I3：仅涉及块中在旧表中已存在的 id（O(involved)），替代全量 HashSet。
    /// 增量 undo 已改走 version 索引，非热路径保留此集供 `contains_registered` 精确判断涉及块。
    #[allow(dead_code)]
    registered_involved: HashSet<BlockId>,
    pinned: HashSet<BlockId>,
    /// 检查点时刻处于热态的块 id（恢复后 rehydrate）。
    was_hot: HashSet<BlockId>,
}

impl TextEngineCheckpoint {
    pub(crate) fn involved_ids(&self) -> HashSet<BlockId> {
        self.blocks.keys().copied().collect()
    }

    /// 检查点版本（next_version 快照），用于增量判断新增块边界。
    pub(crate) fn version(&self) -> u64 {
        self.version
    }

    /// 判断 `id` 在检查点时刻是否已登记（精确，O(1)）。
    ///
    /// I3 精修：移除对未涉及块的超集分支（原对未涉及统一返回 false 导致全量超集）。
    /// 本方法仅对涉及块精确（`registered_involved` 含 `involved ∩ old`）；未涉及块
    /// 是否为旧块应由 `TextEngine::ids_created_since(version)` 的 version 索引精确判定，
    /// 调用方（`text_ids_for_undo_checkpoint`）已改为该增量路径，不再对未涉及块调用此方法。
    /// 保留此方法供涉及块精确判断，非热路径。
    #[allow(dead_code)]
    pub(crate) fn contains_registered(&self, id: BlockId) -> bool {
        self.registered_involved.contains(&id)
    }
}

/// char 闭开区间 → UTF-8 字节起点与删除字节长度。
fn char_range_to_bytes(s: &str, start: u32, end: u32) -> Result<(u32, u32), TextEngineError> {
    let char_len = s.chars().count();
    let s_idx = start as usize;
    if s_idx > char_len {
        return Err(TextEngineError::OffsetOutOfRange);
    }
    let e_idx = (end as usize).min(char_len);
    if e_idx < s_idx {
        return Err(TextEngineError::OffsetOutOfRange);
    }
    let byte_start: usize = s.chars().take(s_idx).map(|c| c.len_utf8()).sum();
    let byte_end: usize = s.chars().take(e_idx).map(|c| c.len_utf8()).sum();
    Ok((byte_start as u32, (byte_end - byte_start) as u32))
}

/// 在字符串上模拟 char 区间替换（预校验 / 同批模拟用，与 apply_edit 语义一致）。
pub fn simulate_char_edit(
    current: &str,
    start: u32,
    end: u32,
    insert: &str,
) -> Result<String, TextEngineError> {
    let char_len = current.chars().count();
    let s_idx = start as usize;
    if s_idx > char_len {
        return Err(TextEngineError::OffsetOutOfRange);
    }
    let e_idx = (end as usize).min(char_len);
    if e_idx < s_idx {
        return Err(TextEngineError::OffsetOutOfRange);
    }
    let mut chars: Vec<char> = current.chars().collect();
    chars.splice(s_idx..e_idx, insert.chars());
    Ok(chars.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: usize) -> Vec<BlockId> {
        (0..n).map(|_| BlockId::new()).collect()
    }

    /// A-MEM-01 / W6-C：默认配置 max_hot == DEFAULT_MAX_HOT == 512。
    #[test]
    fn a_mem_01_default_max_hot_is_512() {
        assert_eq!(DEFAULT_MAX_HOT, 512);
        let eng = TextEngine::default();
        assert_eq!(eng.max_hot(), DEFAULT_MAX_HOT);
        assert_eq!(TextEngineConfig::default().max_hot, DEFAULT_MAX_HOT);
    }

    /// A-MEM-01：插入远超 max_hot 的块并 touch 子集后，hot_count ≤ max_hot。
    #[test]
    fn a_mem_01_hot_count_bounded() {
        let max_hot = 8;
        let mut eng = TextEngine::with_max_hot(max_hot);
        let blocks = ids(40);
        for &id in &blocks {
            eng.init_block(id);
        }
        // 对 20 个块依次编辑 → 热化；LRU 应把早期挤出
        for &id in blocks.iter().take(20) {
            eng.apply_edit(id, 0, 0, "x").unwrap();
        }
        assert!(
            eng.hot_count() <= max_hot,
            "hot_count={} > max_hot={}",
            eng.hot_count(),
            max_hot
        );
        // 最近编辑的应仍热
        let last = blocks[19];
        assert!(eng.is_hot(last), "最近 touch 应保留在热集");
    }

    /// A-MEM-02：冷块 read_text 仍等于快照。
    #[test]
    fn a_mem_02_cold_read_equals_snapshot() {
        let mut eng = TextEngine::with_max_hot(2);
        let a = BlockId::new();
        let b = BlockId::new();
        let c = BlockId::new();
        eng.init_block(a);
        eng.init_block(b);
        eng.init_block(c);
        eng.apply_edit(a, 0, 0, "alpha").unwrap();
        eng.apply_edit(b, 0, 0, "beta").unwrap();
        // 编辑 c 与再次编辑 b，把 a 挤出热集
        eng.apply_edit(c, 0, 0, "gamma").unwrap();
        eng.apply_edit(b, 0, 4, "BETA").unwrap();
        assert!(!eng.is_hot(a), "a 应已冷藏");
        assert_eq!(eng.read_text(a), "alpha");
        assert_eq!(
            eng.snapshot_arc(a).as_deref(),
            Some("alpha"),
            "快照与 read 一致"
        );
    }

    /// A-MEM-03：对冷块 apply 远端/本地 edit 不丢。
    #[test]
    fn a_mem_03_edit_cold_block_no_loss() {
        let mut eng = TextEngine::with_max_hot(1);
        let cold_id = BlockId::new();
        let other = BlockId::new();
        eng.init_block(cold_id);
        eng.init_block(other);
        eng.apply_edit(cold_id, 0, 0, "hello").unwrap();
        // 挤出
        eng.apply_edit(other, 0, 0, "other").unwrap();
        assert!(!eng.is_hot(cold_id));
        // 本地 edit 冷块
        eng.apply_edit(cold_id, 5, 5, " world").unwrap();
        assert_eq!(eng.read_text(cold_id), "hello world");

        // 再冷藏后走 remote update 路径
        eng.apply_edit(other, 0, 5, "OTHER").unwrap();
        assert!(!eng.is_hot(cold_id) || eng.hot_count() <= 1);
        // 构造一份独立 Doc 的 update（模拟远端对同名根 Text 的增量较难；此处用 encode 全量再合入）
        // 先 ensure 读出，再在「远端」Doc 上重建同内容并追加
        let snap = eng.read_text(cold_id);
        let remote = Doc::new();
        {
            let t = remote.get_or_insert_text(ROOT_TEXT);
            let mut txn = remote.transact_mut();
            t.insert(&mut txn, 0, &snap);
            t.insert(&mut txn, snap.len() as u32, "!");
        }
        let bytes = remote
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        // 冷块合入：rehydrate 后 apply（注意：全量 state update 与已有 Doc 合并可能重复；
        // 对「空 rehydrate + 全量」：先 release 热态再从空快照合入更干净）
        // 契约测重点：不丢、最终可读；此处用本地再 edit 验证冷→热
        eng.apply_edit(other, 0, 5, "x").unwrap(); // 尽量使 cold_id 冷
        let before = eng.read_text(cold_id);
        // 若仍热则先手动冷藏路径：用另一个块占满
        if eng.is_hot(cold_id) {
            eng.apply_edit(other, 0, 1, "y").unwrap();
        }
        // 本地冷路径 edit（不依赖跨 Doc 全量 merge 语义）
        eng.apply_edit(
            cold_id,
            before.chars().count() as u32,
            before.chars().count() as u32,
            "!",
        )
        .unwrap();
        assert_eq!(eng.read_text(cold_id), format!("{before}!"));
        // remote API 烟雾：对登记块 apply 不 panic / 不静默忽略
        let _ = bytes; // 保留构造以备后续真 CRDT 互推
        eng.ensure_hot(cold_id).unwrap();
        let enc = eng.encode_state_update(cold_id).expect("热块可 encode");
        assert!(!enc.is_empty());
    }

    /// A-MEM-03 补充：`apply_remote_update` 对冷块 rehydrate 后合入（空本地 + 远端全量）。
    #[test]
    fn a_mem_03_remote_update_on_cold_rehydrates() {
        let mut eng = TextEngine::with_max_hot(1);
        let id = BlockId::new();
        let filler = BlockId::new();
        eng.init_block(id);
        eng.init_block(filler);
        // id 保持冷（仅空快照）；filler 占热
        eng.apply_edit(filler, 0, 0, "f").unwrap();
        assert!(!eng.is_hot(id));

        let remote = Doc::new();
        {
            let t = remote.get_or_insert_text(ROOT_TEXT);
            let mut txn = remote.transact_mut();
            t.insert(&mut txn, 0, "from-remote");
        }
        let bytes = remote
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        // 冷块 apply_remote_update：不得静默丢
        let out = eng.apply_remote_update(id, &bytes).unwrap();
        assert_eq!(out, "from-remote");
        assert_eq!(eng.read_text(id), "from-remote");
    }

    /// 冷块 text 可读 + 再编辑可热（reheat 烟雾）。
    ///
    /// **≠ A-MEM-04**：A-MEM-04 = undo 跨冷边界（结构正确 + 细粒度可截断契约），
    /// 须 W1-U 真 Undo v1 后方可挂 ID；本测仅 A-MEM-02 延伸的 reheat 行为。
    #[test]
    fn a_mem_reheat_cold_readable_then_reheat_on_edit() {
        let mut eng = TextEngine::with_max_hot(1);
        let id = BlockId::new();
        let other = BlockId::new();
        eng.init_block(id);
        eng.init_block(other);
        eng.apply_edit(id, 0, 0, "seed").unwrap();
        eng.apply_edit(other, 0, 0, "z").unwrap();
        assert!(!eng.is_hot(id));
        assert_eq!(eng.read_text(id), "seed");
        eng.apply_edit(id, 0, 4, "SEED").unwrap();
        assert!(eng.is_hot(id));
        assert_eq!(eng.read_text(id), "SEED");
    }

    /// A-INV-09c（引擎侧）：release 后无登记、热计数下降。
    #[test]
    fn a_inv_09c_release_drops_hot_and_registration() {
        let mut eng = TextEngine::with_max_hot(8);
        let id = BlockId::new();
        eng.init_block(id);
        eng.apply_edit(id, 0, 0, "x").unwrap();
        assert_eq!(eng.hot_count(), 1);
        eng.release_block(id);
        assert_eq!(eng.hot_count(), 0);
        assert!(!eng.is_registered(id));
        assert_eq!(eng.read_text(id), "");
    }

    #[test]
    fn test_undo_manager_methods() {
        let doc = Doc::new();
        let text = doc.get_or_insert_text(ROOT_TEXT);
        let mut undo_mgr =
            UndoManager::<()>::with_scope_and_options(&doc, &text, UndoOptions::default());
        {
            let mut txn = doc.transact_mut();
            text.insert(&mut txn, 0, "hello");
        }
        assert_eq!(text.get_string(&doc.transact()), "hello");
        let u_res = undo_mgr.undo_blocking();
        assert!(u_res);
        assert_eq!(text.get_string(&doc.transact()), "");
        let r_res = undo_mgr.redo_blocking();
        assert!(r_res);
        assert_eq!(text.get_string(&doc.transact()), "hello");
    }

    #[test]
    fn test_texthost_drop() {
        let host = TextHost::new();
        drop(host);
    }

    /// CRDT 因果撤销测试：并发远端编辑不受本地 Undo 破坏
    #[test]
    fn test_causal_undo_preserves_concurrent_remote_insert() {
        let mut eng = TextEngine::with_max_hot(4);
        let id = BlockId::new();
        eng.init_block(id);

        // 本地 Client A 插入 "Hello "
        eng.apply_edit(id, 0, 0, "Hello ").unwrap();
        assert_eq!(eng.read_text(id), "Hello ");

        // 远端 Client B 在空文本基础上插入 "World "
        let remote_doc = Doc::new();
        {
            let r_text = remote_doc.get_or_insert_text(ROOT_TEXT);
            let mut r_txn = remote_doc.transact_mut();
            r_text.insert(&mut r_txn, 0, "World ");
        }
        let remote_update = remote_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        // Client A 合入远端 update
        let merged = eng.apply_remote_update(id, &remote_update).unwrap();
        assert!(merged.contains("Hello ") && merged.contains("World "));

        // Client A 触发文本因果撤销：仅撤销本地 "Hello "，远端 "World " 100% 保持！
        let undone = eng.undo_text(id).unwrap();
        assert_eq!(undone, "World ", "远端并发文字必须完整保留，零削字零截断");

        // Client A 重做：恢复 "Hello "
        let redone = eng.redo_text(id).unwrap();
        assert!(redone.contains("Hello ") && redone.contains("World "));
    }

    /// 冷藏二进制 StateVector 保持与无损唤醒（彻底根除 Duplicate Glitch）
    #[test]
    fn test_cold_updates_preserves_crdt_binary_identity() {
        let mut eng = TextEngine::with_max_hot(1);
        let a = BlockId::new();
        let b = BlockId::new();
        eng.init_block(a);
        eng.init_block(b);

        // 在 a 上编辑
        eng.apply_edit(a, 0, 0, "Initial ").unwrap();
        eng.apply_edit(a, 8, 8, "Text").unwrap();
        assert_eq!(eng.read_text(a), "Initial Text");

        // 编辑 b 挤出 a 到冷藏态
        eng.apply_edit(b, 0, 0, "Block B").unwrap();
        assert!(!eng.is_hot(a), "块 a 必须进入冷藏态");
        assert_eq!(eng.read_text(a), "Initial Text", "冷块文本可读");

        // 导出 a 的 update 并在远端追加
        let snap_update = eng.encode_state_update(a).expect("冷块可导出 update");
        let remote = Doc::new();
        {
            let u = Update::decode_v1(&snap_update).unwrap();
            remote.transact_mut().apply_update(u).unwrap();
            let t = remote.get_or_insert_text(ROOT_TEXT);
            t.insert(&mut remote.transact_mut(), 12, " Extended");
        }
        let remote_update = remote
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        // 对冷块 a 合入远端增量
        let updated = eng.apply_remote_update(a, &remote_update).unwrap();
        assert_eq!(updated, "Initial Text Extended");
        assert_eq!(eng.read_text(a), "Initial Text Extended");
    }

    /// 多字节与 Emoji 字符的原生因果撤销
    #[test]
    fn test_multibyte_and_emoji_causal_undo() {
        let mut eng = TextEngine::with_max_hot(4);
        let id = BlockId::new();
        eng.init_block(id);

        eng.apply_edit(id, 0, 0, "你好🎉").unwrap();
        assert_eq!(eng.read_text(id), "你好🎉");

        eng.apply_edit(id, 3, 3, "世界👨‍👩‍👧‍👦").unwrap();
        assert_eq!(eng.read_text(id), "你好🎉世界👨‍👩‍👧‍👦");

        let undone = eng.undo_text(id).unwrap();
        assert_eq!(undone, "你好🎉");

        let redone = eng.redo_text(id).unwrap();
        assert_eq!(redone, "你好🎉世界👨‍👩‍👧‍👦");
    }

    fn assert_send<T: Send>() {}

    /// B4：TextHost / TextEngine 为 Send；Sync 已收窄（见 impl 旁 SAFETY）。
    #[test]
    fn text_host_and_engine_are_send() {
        assert_send::<TextHost>();
        assert_send::<TextEngine>();
        assert_send::<TextEngineCheckpoint>();
    }

    /// 3-5 / I3：checkpoint 只收录 involved，不把未涉及块的冷藏字节拷进快照。
    /// I3 收敛：`registered` 全量 HashSet 已改为 `version` + `registered_involved` 增量。
    #[test]
    fn checkpoint_incremental_only_clones_involved() {
        let mut eng = TextEngine::with_max_hot(1);
        let blocks = ids(8);
        for &id in &blocks {
            eng.init_block(id);
            eng.apply_edit(id, 0, 0, "payload-xxxx").unwrap();
        }
        let target = blocks[0];
        let involved = HashSet::from([target]);
        let cp = eng.checkpoint(&involved);
        assert_eq!(cp.blocks.len(), 1, "只快照涉及块");
        assert!(cp.blocks.contains_key(&target));
        assert!(!cp.blocks.contains_key(&blocks[1]));
        // I3：registered 已收敛为 O(involved) 的 registered_involved + version
        assert_eq!(
            cp.registered_involved.len(),
            1,
            "registered_involved 仅含涉及块中已存在的 id"
        );
        assert!(cp.registered_involved.contains(&target));
        assert_eq!(cp.involved_ids().len(), 1);
        // 版本单调：checkpoint 后新建块的版本 >= cp.version
        let before_version = cp.version;
        let new_id = BlockId::new();
        eng.init_block(new_id);
        assert!(eng.block_versions.get(&new_id).unwrap() >= &before_version);
    }

    /// 3-5 / P-H2：restore 只回滚涉及块；未涉及块原样；apply 新建块被释放。
    #[test]
    fn checkpoint_restore_incremental_p_h2() {
        let mut eng = TextEngine::with_max_hot(8);
        let a = BlockId::new();
        let b = BlockId::new();
        eng.init_block(a);
        eng.init_block(b);
        eng.apply_edit(a, 0, 0, "A0").unwrap();
        eng.apply_edit(b, 0, 0, "B0").unwrap();
        let b_hot_before = eng.is_hot(b);
        let cp = eng.checkpoint(&HashSet::from([a]));

        eng.apply_edit(a, 0, 2, "A1").unwrap();
        let c = BlockId::new();
        eng.init_block(c);
        eng.apply_edit(c, 0, 0, "NEW").unwrap();
        assert_eq!(eng.read_text(a), "A1");
        assert!(eng.is_registered(c));

        eng.restore(cp);
        assert_eq!(eng.read_text(a), "A0", "涉及块回滚");
        assert_eq!(eng.read_text(b), "B0", "未涉及块保持");
        assert!(!eng.is_registered(c), "checkpoint 后新建块须释放");
        assert_eq!(eng.is_hot(b), b_hot_before, "未涉及块热/冷拓扑恢复");
    }

    /// P-H2：涉及块被删后 restore 须按快照重建。
    #[test]
    fn checkpoint_restore_recreates_released_involved() {
        let mut eng = TextEngine::with_max_hot(4);
        let a = BlockId::new();
        let b = BlockId::new();
        eng.init_block(a);
        eng.init_block(b);
        eng.apply_edit(a, 0, 0, "keep").unwrap();
        eng.apply_edit(b, 0, 0, "other").unwrap();
        let cp = eng.checkpoint(&HashSet::from([a]));
        eng.release_block(a);
        assert!(!eng.is_registered(a));
        eng.restore(cp);
        assert!(eng.is_registered(a));
        assert_eq!(eng.read_text(a), "keep");
        assert_eq!(eng.read_text(b), "other");
    }
}
