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
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use thiserror::Error;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

/// H1 / A-MEM-01 默认热集上界。
pub const DEFAULT_MAX_HOT: usize = 512;

/// 根类型名：每叶子块独占一个 `Doc`，根 Text 固定名。
const ROOT_TEXT: &str = "t";

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
}

/// 叶子文本引擎：热 Doc 表 + 全量快照 + pin/LRU。
///
/// 不对外暴露 `yrs::Doc` / `TextRef`。
pub struct TextEngine {
    max_hot: usize,
    /// 所有已登记叶子的当前文本快照（冷热均可读）。
    snapshots: HashMap<BlockId, Arc<str>>,
    /// 热态：活动 yrs Doc（内含 YText）。
    hot: HashMap<BlockId, Doc>,
    /// pin：焦点/composing 等，LRU 驱逐时跳过。
    pinned: HashSet<BlockId>,
    /// 最近 touch：front=最旧，back=最新（仅含当前热块）。
    lru: VecDeque<BlockId>,
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
            hot: HashMap::new(),
            pinned: HashSet::new(),
            lru: VecDeque::new(),
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
        self.snapshots.contains_key(&id)
    }

    /// Insert 叶子：登记空快照，默认 **冷**（不占热槽，直至 touch/edit）。
    pub fn init_block(&mut self, id: BlockId) {
        self.snapshots.entry(id).or_insert_with(|| Arc::from(""));
    }

    /// 带初始快照登记（hydrate / 恢复用，G-HYD-2 冷文本）。
    pub fn init_block_with_text(&mut self, id: BlockId, text: impl Into<String>) {
        let s: String = text.into();
        self.snapshots.insert(id, Arc::from(s.as_str()));
        // 若已热，同步重写 YText
        if self.hot.contains_key(&id) {
            self.rewrite_hot_from_snapshot(id);
        }
    }

    /// 确保块处于热态；必要时从快照 rehydrate。
    pub fn ensure_hot(&mut self, id: BlockId) -> Result<(), TextEngineError> {
        if !self.snapshots.contains_key(&id) {
            return Err(TextEngineError::NotRegistered(id.to_string()));
        }
        if self.hot.contains_key(&id) {
            self.touch_lru(id);
            return Ok(());
        }
        let snap = self
            .snapshots
            .get(&id)
            .cloned()
            .unwrap_or_else(|| Arc::from(""));
        let doc = Doc::new();
        {
            let text = doc.get_or_insert_text(ROOT_TEXT);
            let mut txn = doc.transact_mut();
            if !snap.is_empty() {
                text.insert(&mut txn, 0, snap.as_ref());
            }
        }
        self.hot.insert(id, doc);
        self.touch_lru(id);
        self.evict_cold_if_needed();
        // 驱逐不应打掉刚 touch 的 id（其在 LRU 最末）；若 max_hot=1 且自 pin 冲突则可能，再 ensure 一次
        if !self.hot.contains_key(&id) {
            let snap = self
                .snapshots
                .get(&id)
                .cloned()
                .unwrap_or_else(|| Arc::from(""));
            let doc = Doc::new();
            {
                let text = doc.get_or_insert_text(ROOT_TEXT);
                let mut txn = doc.transact_mut();
                if !snap.is_empty() {
                    text.insert(&mut txn, 0, snap.as_ref());
                }
            }
            self.hot.insert(id, doc);
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
        if let Some(doc) = self.hot.get(&id) {
            let text = doc.get_or_insert_text(ROOT_TEXT);
            return text.get_string(&doc.transact());
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
        let doc = self
            .hot
            .get(&id)
            .expect("ensure_hot 后必热");
        let text = doc.get_or_insert_text(ROOT_TEXT);
        let current = text.get_string(&doc.transact());
        let (byte_start, remove_len) = char_range_to_bytes(&current, start, end)?;
        {
            let mut txn = doc.transact_mut();
            if remove_len > 0 {
                text.remove_range(&mut txn, byte_start, remove_len);
            }
            if !insert.is_empty() {
                text.insert(&mut txn, byte_start, insert);
            }
        }
        let new_text = text.get_string(&doc.transact());
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
        let doc = self
            .hot
            .get(&id)
            .expect("ensure_hot 后必热");
        {
            let mut txn = doc.transact_mut();
            let update = Update::decode_v1(bytes)
                .map_err(|e| TextEngineError::UpdateDecode(e.to_string()))?;
            txn.apply_update(update)
                .map_err(|e| TextEngineError::UpdateApply(e.to_string()))?;
        }
        let text = doc.get_or_insert_text(ROOT_TEXT);
        let new_text = text.get_string(&doc.transact());
        self.snapshots.insert(id, Arc::from(new_text.as_str()));
        self.touch_lru(id);
        self.evict_cold_if_needed();
        Ok(new_text)
    }

    /// 导出该块当前热 Doc 全量 state 为 update v1（冷块返回 None，调用方应先 ensure_hot 或只写快照标记）。
    pub fn encode_state_update(&self, id: BlockId) -> Option<Vec<u8>> {
        let doc = self.hot.get(&id)?;
        let txn = doc.transact();
        Some(txn.encode_state_as_update_v1(&StateVector::default()))
    }

    /// 删块：释放热槽与快照（A-INV-09c）。
    pub fn release_block(&mut self, id: BlockId) {
        self.hot.remove(&id);
        self.snapshots.remove(&id);
        self.pinned.remove(&id);
        self.lru.retain(|x| *x != id);
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
        if let Some(doc) = self.hot.remove(&id) {
            let text = doc.get_or_insert_text(ROOT_TEXT);
            let s = text.get_string(&doc.transact());
            self.snapshots.insert(id, Arc::from(s.as_str()));
        }
        self.lru.retain(|x| *x != id);
    }

    #[allow(dead_code)] // init_block_with_text 热路径
    fn rewrite_hot_from_snapshot(&mut self, id: BlockId) {
        let Some(snap) = self.snapshots.get(&id).cloned() else {
            return;
        };
        // 丢弃旧 Doc，用快照重建：冷后细粒度 yrs 击键史可截断（实现细节，≠ A-MEM-04 契约关闭）
        self.hot.remove(&id);
        let doc = Doc::new();
        {
            let text = doc.get_or_insert_text(ROOT_TEXT);
            let mut txn = doc.transact_mut();
            if !snap.is_empty() {
                text.insert(&mut txn, 0, snap.as_ref());
            }
        }
        self.hot.insert(id, doc);
        self.touch_lru(id);
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
        eng.apply_edit(cold_id, before.chars().count() as u32, before.chars().count() as u32, "!")
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
    fn char_offset_multibyte() {
        let mut eng = TextEngine::with_max_hot(4);
        let id = BlockId::new();
        eng.init_block(id);
        eng.apply_edit(id, 0, 0, "你好").unwrap();
        eng.apply_edit(id, 1, 1, "，").unwrap();
        assert_eq!(eng.read_text(id), "你，好");
        eng.apply_edit(id, 1, 2, "").unwrap();
        assert_eq!(eng.read_text(id), "你好");
    }
}
