use std::collections::{HashMap, HashSet};

use conex_types::checkpoint::{CheckpointPayload, LeafCheckpointState, CHECKPOINT_PAYLOAD_KEY};

use super::{SessionRecord, SessionTreeEntry, SessionTreeEntryKind, SessionTreeError};

/// 会话树（追加 / 分叉 / 叶子移动 / 分支放弃摘要）
///
/// 结构对齐 packages/agent-orchestrator/src/session-tree.ts：
/// - entries 保持插入序（父必须先于子出现）；
/// - current_leaf_id 为当前活动叶子指针（append 自动推进）；
/// - last_inserted_id 供「无显式当前叶子时恢复到最后插入条目」使用。
///
/// 与 TS 的分歧说明：条目 id 由调用方显式提供（TS 自动生成随机 id），
/// 以便上层生成幂等 id 并与持久化事件对齐。
#[derive(Debug, Clone)]
pub struct SessionTree {
    /// 会话标识
    pub(super) session_id: String,
    /// 分支历史条目（插入序）
    pub(super) entries: Vec<SessionTreeEntry>,
    /// 条目 id → entries 下标映射（O(1) 查找与 O(D) 路径回溯）
    entry_index: HashMap<String, usize>,
    /// 当前活动叶子指针
    pub(super) current_leaf_id: Option<String>,
    /// 最后插入的条目 id
    last_inserted_id: Option<String>,
}

impl PartialEq for SessionTree {
    fn eq(&self, other: &Self) -> bool {
        self.session_id == other.session_id
            && self.entries == other.entries
            && self.current_leaf_id == other.current_leaf_id
            && self.last_inserted_id == other.last_inserted_id
    }
}

impl SessionTree {
    /// 新建空会话树
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            entries: Vec::new(),
            entry_index: HashMap::new(),
            current_leaf_id: None,
            last_inserted_id: None,
        }
    }

    /// 会话标识
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// 当前叶子 id（None = 根前位置）
    pub fn current_leaf_id(&self) -> Option<&str> {
        self.current_leaf_id.as_deref()
    }

    /// 全部分支历史条目（插入序，父先于子）
    pub fn entries(&self) -> &[SessionTreeEntry] {
        &self.entries
    }

    /// 按 id 查条目（O(1) 索引查表）
    pub fn entry(&self, id: &str) -> Option<&SessionTreeEntry> {
        if let Some(&idx) = self.entry_index.get(id) {
            if let Some(entry) = self.entries.get(idx) {
                if entry.id == id {
                    return Some(entry);
                }
            }
        }
        self.entries.iter().find(|e| e.id == id)
    }

    /// 追加新分支：新节点挂在当前叶子下，当前叶子指针推进到新节点
    /// （session-tree.test.ts:7 语义）
    pub fn append(
        &mut self,
        id: impl Into<String>,
        payload: serde_json::Value,
    ) -> Result<SessionTreeEntry, SessionTreeError> {
        let entry = self.create_node(id, self.current_leaf_id.clone(), payload)?;
        self.push_entry(entry.clone());
        Ok(entry)
    }

    /// 分叉：从指定节点派生新叶子（parent = from_leaf_id），当前叶子
    /// 指针推进到新叶子；原分支路径不被改写（session-tree.test.ts:19 语义）
    pub fn fork(
        &mut self,
        from_leaf_id: &str,
        id: impl Into<String>,
        payload: serde_json::Value,
    ) -> Result<SessionTreeEntry, SessionTreeError> {
        if self.entry(from_leaf_id).is_none() {
            return Err(SessionTreeError::NotFound {
                id: from_leaf_id.to_string(),
            });
        }
        let entry = self.create_node(id, Some(from_leaf_id.to_string()), payload)?;
        self.push_entry(entry.clone());
        Ok(entry)
    }

    /// 叶子移动：当前叶子指针迁移到 target_leaf_id（None = 根前位置），
    /// 不新增条目（session-tree.test.ts:33 语义）。
    ///
    /// expected_current_leaf 为乐观并发校验：Some(期望值) 时若当前叶子
    /// 与期望不一致则失败（rewind 移动叶子步骤使用，防止并发分支改写）。
    pub fn move_leaf(
        &mut self,
        target_leaf_id: Option<&str>,
        expected_current_leaf: Option<&str>,
    ) -> Result<(), SessionTreeError> {
        if let Some(expected) = expected_current_leaf {
            if self.current_leaf_id.as_deref() != Some(expected) {
                return Err(SessionTreeError::ExpectedLeafMismatch {
                    expected: expected.to_string(),
                    actual: self.current_leaf_id.clone(),
                });
            }
        }
        if let Some(target) = target_leaf_id {
            if self.entry(target).is_none() {
                return Err(SessionTreeError::NotFound {
                    id: target.to_string(),
                });
            }
        }
        self.current_leaf_id = target_leaf_id.map(str::to_string);
        Ok(())
    }

    /// 放弃当前分支：在 target 下挂一个分支摘要条目，当前叶子推进到
    /// 摘要条目（对齐 session-tree.test.ts:47 的回滚语义）
    pub fn abandon_branch_with_summary(
        &mut self,
        target_leaf_id: Option<&str>,
        id: impl Into<String>,
        summary: impl Into<String>,
        details: Option<serde_json::Value>,
    ) -> Result<SessionTreeEntry, SessionTreeError> {
        let target = target_leaf_id.map(str::to_string);
        if let Some(t) = &target {
            if self.entry(t).is_none() {
                return Err(SessionTreeError::NotFound { id: t.clone() });
            }
        }
        let id = id.into();
        if self.entry(&id).is_some() {
            return Err(SessionTreeError::DuplicateId { id });
        }
        let entry = SessionTreeEntry {
            id,
            parent_id: target,
            created_at: crate::now_ms(),
            kind: SessionTreeEntryKind::BranchSummary {
                summary: summary.into(),
                abandoned_leaf_id: self.current_leaf_id.clone(),
                details,
            },
        };
        self.push_entry(entry.clone());
        Ok(entry)
    }

    /// 恢复当前叶子：source 为 None 时恢复到最后插入的条目（与 TS
    /// restoreLeaf(undefined) 语义一致）；显式叶子则校验存在性
    /// （session-tree.test.ts:86 / :110 语义）
    pub fn restore_leaf(&mut self, source: Option<&str>) -> Result<(), SessionTreeError> {
        let requested = match source {
            Some(id) => Some(id.to_string()),
            None => self.last_inserted_id.clone(),
        };
        if let Some(id) = &requested {
            if self.entry(id).is_none() {
                return Err(SessionTreeError::NotFound { id: id.clone() });
            }
        }
        self.current_leaf_id = requested;
        Ok(())
    }

    /// 读取从根到指定叶子的分支路径引用链（内部 O(D) 零克隆回溯）
    fn traverse_branch_refs(
        &self,
        leaf_id: Option<&str>,
    ) -> Result<Vec<&SessionTreeEntry>, SessionTreeError> {
        let leaf_id = match leaf_id {
            Some(id) => id,
            None => return Ok(Vec::new()),
        };
        let mut path = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        let mut current = self
            .entry(leaf_id)
            .ok_or_else(|| SessionTreeError::NotFound {
                id: leaf_id.to_string(),
            })?;
        loop {
            if !seen.insert(current.id.as_str()) {
                return Err(SessionTreeError::Cycle {
                    id: current.id.clone(),
                });
            }
            path.push(current);
            current = match &current.parent_id {
                Some(parent) => match self.entry(parent) {
                    Some(entry) => entry,
                    None => {
                        return Err(SessionTreeError::InvalidState {
                            message: format!("条目 {} 的父节点 {} 缺失", current.id, parent),
                        });
                    }
                },
                None => break,
            };
        }
        path.reverse();
        Ok(path)
    }

    /// 读取从根到指定叶子的分支路径（None = 空路径；环检测防御，
    /// session-tree.test.ts:156 语义）
    pub fn read_branch_path(
        &self,
        leaf_id: Option<&str>,
    ) -> Result<Vec<SessionTreeEntry>, SessionTreeError> {
        let refs = self.traverse_branch_refs(leaf_id)?;
        Ok(refs.into_iter().cloned().collect())
    }

    /// 仅读取从根到指定叶子的分支节点 ID 路径（O(D) 零 payload 克隆，供持锁临界区快速提取路径 ID）
    pub fn read_branch_path_ids(
        &self,
        leaf_id: Option<&str>,
    ) -> Result<Vec<String>, SessionTreeError> {
        let refs = self.traverse_branch_refs(leaf_id)?;
        Ok(refs.into_iter().map(|e| e.id.clone()).collect())
    }

    // ===== C1 checkpoint 叶子 payload（M5A 最小落库面） =====
    //
    // 会话树主写权归 C6（M6）；本面只读写叶子节点 payload 的
    // `checkpoint` 保留键（[CHECKPOINT_PAYLOAD_KEY]），不触碰 payload
    // 其它字段与树结构。采集端（session-loop safe_point.rs）产出
    // [CheckpointPayload]，经 [Self::set_leaf_checkpoint] 落库，
    // 恢复端（M5B）经 [Self::read_leaf_checkpoint] 判定优先恢复。

    /// 读取叶子 payload 中的检查点（C1 / M5A 最小读面）。
    ///
    /// 三态语义（fail-open，不 panic）：
    /// - leaf_id 为 None 时取当前叶子；条目不存在 / 非节点 / 无
    ///   `checkpoint` 键 / 值为 null → [LeafCheckpointState::Absent]
    ///   （无检查点，保持现状）；
    /// - 值存在且解析成功 → [LeafCheckpointState::Present]（恢复时
    ///   优先消费）；
    /// - 值存在但解析失败 → [LeafCheckpointState::Corrupt]（损坏降级
    ///   普通会话，message 供「检查点失效」通知）。
    pub fn read_leaf_checkpoint(&self, leaf_id: Option<&str>) -> LeafCheckpointState {
        let entry = match leaf_id {
            Some(id) => self.entry(id),
            None => self
                .current_leaf_id
                .as_deref()
                .and_then(|id| self.entry(id)),
        };
        let Some(entry) = entry else {
            return LeafCheckpointState::Absent;
        };
        let SessionTreeEntryKind::Node { payload } = &entry.kind else {
            return LeafCheckpointState::Absent;
        };
        let Some(value) = payload.get(CHECKPOINT_PAYLOAD_KEY) else {
            return LeafCheckpointState::Absent;
        };
        if value.is_null() {
            return LeafCheckpointState::Absent;
        }
        match serde_json::from_value::<CheckpointPayload>(value.clone()) {
            Ok(checkpoint) => LeafCheckpointState::Present(checkpoint),
            Err(err) => LeafCheckpointState::Corrupt(format!("检查点载荷解析失败: {err}")),
        }
    }

    /// 写入叶子 payload 的检查点字段（C1 / M5A 最小写面）。
    ///
    /// 只新增/更新 `checkpoint` 键，payload 其它字段原样保留（最小
    /// 落库面：checkpoint payload 字段）。条目不存在 → NotFound；
    /// 条目非节点或 payload 非 JSON 对象 → InvalidState。
    pub fn set_leaf_checkpoint(
        &mut self,
        leaf_id: &str,
        checkpoint: &CheckpointPayload,
    ) -> Result<(), SessionTreeError> {
        let idx = self
            .entry_index
            .get(leaf_id)
            .copied()
            .filter(|&i| self.entries.get(i).is_some_and(|e| e.id == leaf_id))
            .or_else(|| self.entries.iter().position(|e| e.id == leaf_id))
            .ok_or_else(|| SessionTreeError::NotFound {
                id: leaf_id.to_string(),
            })?;
        let entry = &mut self.entries[idx];
        let SessionTreeEntryKind::Node { payload } = &mut entry.kind else {
            return Err(SessionTreeError::InvalidState {
                message: format!("条目 {leaf_id} 不是会话节点，不能写入检查点"),
            });
        };
        let object = payload
            .as_object_mut()
            .ok_or_else(|| SessionTreeError::InvalidState {
                message: format!("条目 {leaf_id} 的 payload 不是 JSON 对象，不能写入检查点"),
            })?;
        let value =
            serde_json::to_value(checkpoint).map_err(|err| SessionTreeError::InvalidState {
                message: format!("检查点序列化失败: {err}"),
            })?;
        object.insert(CHECKPOINT_PAYLOAD_KEY.to_string(), value);
        Ok(())
    }

    /// 序列化为会话记录（快照 / 重启恢复用）
    pub fn to_session_record(&self) -> SessionRecord {
        SessionRecord {
            session_id: self.session_id.clone(),
            current_leaf_id: self.current_leaf_id.clone(),
            branches: self.entries.clone(),
            // 会话树本身不持有上下文元数据（压缩护栏由事件流/快照携带，
            // 恢复后经 SessionRecord.context_meta 重建）
            context_meta: None,
        }
    }

    /// 从会话记录还原会话树（含结构校验，见 [Self::from_entries]）
    pub fn from_session_record(record: SessionRecord) -> Result<Self, SessionTreeError> {
        Self::from_entries(record.session_id, record.branches, record.current_leaf_id)
    }

    /// 从条目列表 + 当前叶子构造会话树（重启恢复 / 快照还原路径）
    ///
    /// 结构校验对齐 session-tree.test.ts:121-227：
    /// - 重复 id → DuplicateId；
    /// - 父必须先于子出现 → InvalidState；
    /// - 分支摘要的 abandoned_leaf_id（非空时）必须已出现 → NotFound。
    pub fn from_entries(
        session_id: String,
        entries: Vec<SessionTreeEntry>,
        current_leaf_id: Option<String>,
    ) -> Result<Self, SessionTreeError> {
        // 两阶段校验（与 TS loadEntries 一致：容量淘汰与结构校验解耦）
        let mut entry_index = HashMap::with_capacity(entries.len());
        for (idx, entry) in entries.iter().enumerate() {
            if entry_index.contains_key(&entry.id) {
                return Err(SessionTreeError::DuplicateId {
                    id: entry.id.clone(),
                });
            }
            if let Some(parent) = &entry.parent_id {
                if !entry_index.contains_key(parent) {
                    return Err(SessionTreeError::InvalidState {
                        message: format!(
                            "条目 {} 的父节点 {} 必须先于子条目出现",
                            entry.id, parent
                        ),
                    });
                }
            }
            if let SessionTreeEntryKind::BranchSummary {
                abandoned_leaf_id: Some(abandoned),
                ..
            } = &entry.kind
            {
                if !entry_index.contains_key(abandoned) {
                    return Err(SessionTreeError::NotFound {
                        id: abandoned.clone(),
                    });
                }
            }
            entry_index.insert(entry.id.clone(), idx);
        }
        let last_inserted_id = entries.last().map(|e| e.id.clone());
        let mut tree = Self {
            session_id,
            entries,
            entry_index,
            current_leaf_id: None,
            last_inserted_id,
        };
        tree.restore_leaf(current_leaf_id.as_deref())?;
        Ok(tree)
    }

    /// 构造节点条目（id 唯一性校验 + 父节点存在性由调用方保证）
    fn create_node(
        &mut self,
        id: impl Into<String>,
        parent_id: Option<String>,
        payload: serde_json::Value,
    ) -> Result<SessionTreeEntry, SessionTreeError> {
        let id = id.into();
        if self.entry(&id).is_some() {
            return Err(SessionTreeError::DuplicateId { id });
        }
        Ok(SessionTreeEntry::node(id, parent_id, payload))
    }

    /// 追加条目并推进 last_inserted / current_leaf（appendEntry 语义）
    fn push_entry(&mut self, entry: SessionTreeEntry) {
        let idx = self.entries.len();
        self.entry_index.insert(entry.id.clone(), idx);
        self.last_inserted_id = Some(entry.id.clone());
        self.current_leaf_id = Some(entry.id.clone());
        self.entries.push(entry);
    }
}
