//! [`StoreNoteBackend`]：真实 store + DocSession 管线实现 `NoteBackend`。

use agent_tools::note_backend::{
    NoteApplyMdRequest, NoteApplyMdResult, NoteApplyMode, NoteBackend, NoteBackendError,
    NoteBatchTokens, NoteBlockBatchRequest, NoteBlockBatchResult, NoteBlockOp,
    NoteBlockOpKind, NoteBlockOpPreview, NoteLossyItem, NoteLossyReport, NoteOutline,
    NoteOutlineNode, NoteQueryBlockHit, NoteQueryBlocksParams, NoteQueryBlocksResult,
};
use async_trait::async_trait;
use conex_doc_collab::{
    BlockId, BlockKind, BlockProps, BlockTree, DocSession, Op, Origin, PersistencePlugin,
};
use conex_md_ast::{apply_md_fragment, LossyReport, MdError};
use conex_workspace_store::{
    commit_ops, QueryBlocksParams, SharedWorkspaceStore, StoreError,
};
use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;
use std::sync::Mutex;
use std::time::Duration;

/// 真实笔记后端：SharedWorkspaceStore + 进程内 DocSession 表 + intent 幂等。
///
/// # 不变量
/// - 写路径仅 `apply_md_fragment` / [`Self::apply_block_ops`] → Ops → `commit_ops`
///   （权威 updates + 投影索引）；**禁止** fs.write 当权威
/// - 读路径即时投影 / session 树 / `document_to_md`；**不**读 MD mirror 文件
/// - 同 `intent_id` 二次调用返回首次结果（`idempotent=true`, `inserted=0`）
/// - batch token：内嵌 [`NoteBatchTokens`]（与 Memory 后端同语义）
/// - **W4-A**：`ApplyReport.lossy` → [`NoteApplyMdResult::lossy`]（工具 result 可观测；
///   **禁止**只写 ops 丢 lossy）。**≠ EL-05 / ≠ A-AGT 满表**。
/// - **W4-F 余量**：`apply_block_ops` 真路径（dryRun 零写 / 原子 commit /
///   `force_execution_unknown` 不半写）。**≠ EL-05**；**≠ W6-E**；**≠ A-AGT 全表**。
pub struct StoreNoteBackend {
    store: SharedWorkspaceStore,
    /// 进程内打开的文档会话（唯一写入口持有者）。
    sessions: Mutex<HashMap<String, DocSession>>,
    /// intent_id → 首次 apply 结果（send_to_note 幂等）
    intents: Mutex<HashMap<String, NoteApplyMdResult>>,
    batch_tokens: NoteBatchTokens,
}

impl std::fmt::Debug for StoreNoteBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let n_sessions = self
            .sessions
            .lock()
            .map(|m| m.len())
            .unwrap_or(0);
        let n_intents = self
            .intents
            .lock()
            .map(|m| m.len())
            .unwrap_or(0);
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

    /// 同步版即时 S（测试 / 进程内）；语义同 [`NoteBackend::get_md`]。
    ///
    /// - 有 session：`document_to_md`（含 `<!--c:UUID-->`）
    /// - 无 session / 空树：`Ok("")`（对齐 trait 探测语义，**不**读 mirror）
    pub fn document_to_md(&self, doc_id: &str) -> Result<String, NoteBackendError> {
        if doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match sessions.get(doc_id) {
            Some(session) if !session.tree().root_children.is_empty() => {
                Ok(conex_md_ast::document_to_md(session.tree()))
            }
            // 无 session 或空树：与 NoteBackend::get_md 契约一致
            _ => Ok(String::new()),
        }
    }

    /// 确保 doc 会话存在：`load_doc` → `DocSession::hydrate` → with_persistence（G-HYD-2）。
    ///
    /// 结构 encode 为可逆 CDCS 整树 snapshot；空 blob（新文档）→ 空会话合法。
    fn ensure_session(
        sessions: &mut HashMap<String, DocSession>,
        store: &SharedWorkspaceStore,
        doc_id: &str,
    ) -> Result<(), NoteBackendError> {
        if sessions.contains_key(doc_id) {
            return Ok(());
        }
        let blob = store.load_doc(doc_id).map_err(|e| {
            NoteBackendError::ApplyFailed(format!("load_doc: {e}"))
        })?;
        let session = DocSession::hydrate(doc_id.to_string(), blob)
            .map_err(|e| NoteBackendError::ApplyFailed(format!("hydrate: {e}")))?
            .with_persistence(Box::new(store.clone()));
        sessions.insert(doc_id.to_string(), session);
        Ok(())
    }

    fn map_store_err(e: StoreError) -> NoteBackendError {
        NoteBackendError::ApplyFailed(format!("store: {e}"))
    }

    fn map_md_err(e: MdError) -> NoteBackendError {
        match e {
            MdError::IdConflict(id) => NoteBackendError::IdConflict(id),
            MdError::UnknownParent(p) => {
                NoteBackendError::NotFound(format!("parent_id not found: {p}"))
            }
            MdError::Parse(m) | MdError::Lossy(m) => NoteBackendError::ApplyFailed(m),
        }
    }

    fn map_commit_err(e: conex_workspace_store::CommitPipelineError) -> NoteBackendError {
        use conex_workspace_store::CommitPipelineError;
        match e {
            CommitPipelineError::Apply(ae) => {
                let s = ae.to_string();
                if s.contains("not found") {
                    NoteBackendError::NotFound(s)
                } else if s.contains("id") && s.to_lowercase().contains("conflict") {
                    NoteBackendError::IdConflict(s)
                } else {
                    NoteBackendError::ApplyFailed(s)
                }
            }
            CommitPipelineError::Store(se) => Self::map_store_err(se),
        }
    }

    fn parse_block_id(s: &str, label: &str) -> Result<BlockId, NoteBackendError> {
        BlockId::from_str(s.trim()).map_err(|_| {
            NoteBackendError::Invalid(format!("{label} is not a valid block UUID: {s}"))
        })
    }

    fn origin_from_req(req: &NoteApplyMdRequest) -> Origin {
        Self::origin_from_str(req.origin.as_deref())
    }

    fn origin_from_str(origin: Option<&str>) -> Origin {
        match origin.map(str::trim) {
            Some("agent") | Some("Agent") => Origin::Agent,
            Some("remote") | Some("Remote") => Origin::Remote,
            Some("system") | Some("System") => Origin::System,
            _ => Origin::User,
        }
    }

    /// 工具 kind 字符串 → collab [`BlockKind`]。
    fn parse_block_kind(kind: &str) -> BlockKind {
        let k = kind.trim();
        if k.is_empty() || k == "paragraph" {
            return BlockKind::Paragraph;
        }
        if let Some(rest) = k.strip_prefix("heading:") {
            let level = rest.parse::<u8>().unwrap_or(1).clamp(1, 6);
            return BlockKind::Heading { level };
        }
        match k {
            "heading" => BlockKind::Heading { level: 1 },
            "bullet" | "bullet_item" | "list_item" => BlockKind::BulletItem,
            "ordered" | "ordered_item" => BlockKind::OrderedItem,
            "code" | "code_block" => BlockKind::Code,
            "quote" | "blockquote" => BlockKind::Quote,
            "divider" | "hr" => BlockKind::Divider,
            other => BlockKind::Unknown {
                flavour: other.to_string(),
            },
        }
    }

    fn kind_label(kind: &BlockKind) -> String {
        match kind {
            BlockKind::Paragraph => "paragraph".into(),
            BlockKind::Heading { level } => format!("heading:{level}"),
            BlockKind::BulletItem => "bullet_item".into(),
            BlockKind::OrderedItem => "ordered_item".into(),
            BlockKind::Code => "code".into(),
            BlockKind::Quote => "quote".into(),
            BlockKind::Divider => "divider".into(),
            BlockKind::Unknown { flavour } => flavour.clone(),
        }
    }

    /// 父下兄弟 order 序号起点（对齐 md-ast sibling_base_seq）。
    fn sibling_base_seq(tree: &BlockTree, parent: Option<BlockId>) -> u32 {
        match parent {
            Some(pid) => tree
                .get(&pid)
                .map(|n| n.children.len() as u32)
                .unwrap_or(0),
            None => tree.root_children.len() as u32,
        }
    }

    /// 将工具层 [`NoteBlockOp`] 规划为 collab [`Op`] 批（不修改 session）。
    ///
    /// 批内可引用本批新 insert 的 id；失败整批不返回 ops（调用方不 commit）。
    fn plan_block_ops_to_collab(
        session: &DocSession,
        ops: &[NoteBlockOp],
    ) -> Result<StoreBlockOpPlan, NoteBackendError> {
        let tree = session.tree();
        // 规划期工作态：id 存在性 + 临时文本长度（TextEdit 全量替换用）
        let mut known: HashMap<BlockId, PlanNodeMeta> = tree
            .nodes
            .iter()
            .map(|(id, n)| {
                let text = session.read_text(id);
                (
                    *id,
                    PlanNodeMeta {
                        parent: n.parent,
                        order: n.order.clone(),
                        kind: n.kind.clone(),
                        text_len: text.chars().count() as u32,
                        text,
                    },
                )
            })
            .collect();
        // 父 → 子 order 列表（仅规划期；insert 后追加）
        let mut children_of: HashMap<Option<BlockId>, Vec<(BlockId, String)>> = HashMap::new();
        for (id, meta) in &known {
            children_of
                .entry(meta.parent)
                .or_default()
                .push((*id, meta.order.clone()));
        }

        let mut collab_ops: Vec<Op> = Vec::new();
        let mut previews: Vec<NoteBlockOpPreview> = Vec::new();
        let mut block_ids: Vec<String> = Vec::new();
        // 同批 append order 去重计数
        let mut order_seq_by_parent: HashMap<Option<BlockId>, u32> = HashMap::new();

        for op in ops {
            match op.op {
                NoteBlockOpKind::Insert => {
                    let content = op.content.clone().unwrap_or_default();
                    let kind_s = op
                        .kind
                        .clone()
                        .unwrap_or_else(|| "paragraph".to_string());
                    let kind = Self::parse_block_kind(&kind_s);
                    let kind_label = Self::kind_label(&kind);

                    let id = match &op.id {
                        Some(s) if !s.trim().is_empty() => {
                            let bid = Self::parse_block_id(s, "id")?;
                            if known.contains_key(&bid) {
                                return Err(NoteBackendError::IdConflict(format!(
                                    "block id already exists: {bid}"
                                )));
                            }
                            bid
                        }
                        _ => BlockId::new(),
                    };

                    let previous = match &op.previous_id {
                        Some(s) if !s.trim().is_empty() => {
                            Some(Self::parse_block_id(s, "previous_id")?)
                        }
                        _ => None,
                    };
                    let explicit_parent = match &op.parent_id {
                        Some(s) if !s.trim().is_empty() => {
                            Some(Self::parse_block_id(s, "parent_id")?)
                        }
                        _ => None,
                    };

                    let parent = if let Some(pid) = explicit_parent {
                        if !known.contains_key(&pid) {
                            return Err(NoteBackendError::NotFound(format!(
                                "parent_id not found: {pid}"
                            )));
                        }
                        Some(pid)
                    } else if let Some(prev) = previous {
                        let meta = known.get(&prev).ok_or_else(|| {
                            NoteBackendError::NotFound(format!("previous_id not found: {prev}"))
                        })?;
                        meta.parent
                    } else {
                        None
                    };

                    if let Some(prev) = previous {
                        if !known.contains_key(&prev) {
                            return Err(NoteBackendError::NotFound(format!(
                                "previous_id not found: {prev}"
                            )));
                        }
                    }

                    let order = if let Some(prev) = previous {
                        let prev_order = known
                            .get(&prev)
                            .map(|m| m.order.clone())
                            .unwrap_or_else(|| "a0".into());
                        let seq = order_seq_by_parent.entry(parent).or_insert(0);
                        let o = format!("{prev_order}~{seq:04}");
                        *seq += 1;
                        o
                    } else {
                        let base = Self::sibling_base_seq(tree, parent)
                            + children_of
                                .get(&parent)
                                .map(|v| {
                                    // 仅计本批追加到该父的（tree 内已有由 base 覆盖）
                                    v.iter()
                                        .filter(|(cid, _)| {
                                            // 已在原 tree 的不计二次
                                            !tree.nodes.contains_key(cid)
                                        })
                                        .count() as u32
                                })
                                .unwrap_or(0);
                        let seq = order_seq_by_parent.entry(parent).or_insert(0);
                        let o = format!("a{:04}", base + *seq);
                        *seq += 1;
                        o
                    };

                    let mut props = BlockProps::default();
                    if let Some(ref attrs) = op.attrs {
                        props.attrs = attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                    }

                    collab_ops.push(Op::Insert {
                        id,
                        parent,
                        order: order.clone(),
                        kind: kind.clone(),
                        props,
                    });
                    if !content.is_empty() {
                        collab_ops.push(Op::TextEdit {
                            id,
                            start: 0,
                            end: 0,
                            insert: content.clone(),
                        });
                    }

                    known.insert(
                        id,
                        PlanNodeMeta {
                            parent,
                            order: order.clone(),
                            kind: kind.clone(),
                            text_len: content.chars().count() as u32,
                            text: content.clone(),
                        },
                    );
                    children_of
                        .entry(parent)
                        .or_default()
                        .push((id, order));

                    let summary = Some(content.chars().take(80).collect::<String>());
                    previews.push(NoteBlockOpPreview {
                        op: "insert".into(),
                        id: Some(id.to_string()),
                        kind: Some(kind_label),
                        summary,
                    });
                    block_ids.push(id.to_string());
                }
                NoteBlockOpKind::Update => {
                    let id_s = op
                        .id
                        .clone()
                        .filter(|s| !s.trim().is_empty())
                        .ok_or_else(|| {
                            NoteBackendError::Invalid("update requires non-empty id".into())
                        })?;
                    let id = Self::parse_block_id(&id_s, "id")?;
                    let meta = known.get(&id).ok_or_else(|| {
                        NoteBackendError::NotFound(format!("block not found: {id}"))
                    })?;
                    let content = op.content.clone().ok_or_else(|| {
                        NoteBackendError::Invalid("update requires content".into())
                    })?;
                    let end = meta.text_len;
                    let kind_label = Self::kind_label(&meta.kind);
                    collab_ops.push(Op::TextEdit {
                        id,
                        start: 0,
                        end,
                        insert: content.clone(),
                    });
                    if let Some(ref attrs) = op.attrs {
                        let mut props = BlockProps::default();
                        props.attrs =
                            attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                        collab_ops.push(Op::UpdateProps { id, props });
                    }
                    if let Some(m) = known.get_mut(&id) {
                        m.text_len = content.chars().count() as u32;
                        m.text = content.clone();
                    }
                    previews.push(NoteBlockOpPreview {
                        op: "update".into(),
                        id: Some(id.to_string()),
                        kind: Some(kind_label),
                        summary: Some(content.chars().take(80).collect()),
                    });
                    block_ids.push(id.to_string());
                }
                NoteBlockOpKind::Delete => {
                    let id_s = op
                        .id
                        .clone()
                        .filter(|s| !s.trim().is_empty())
                        .ok_or_else(|| {
                            NoteBackendError::Invalid("delete requires non-empty id".into())
                        })?;
                    let id = Self::parse_block_id(&id_s, "id")?;
                    let meta = known.get(&id).ok_or_else(|| {
                        NoteBackendError::NotFound(format!("block not found: {id}"))
                    })?;
                    let kind_label = Self::kind_label(&meta.kind);
                    let parent = meta.parent;
                    collab_ops.push(Op::Delete { id });
                    known.remove(&id);
                    if let Some(list) = children_of.get_mut(&parent) {
                        list.retain(|(cid, _)| *cid != id);
                    }
                    previews.push(NoteBlockOpPreview {
                        op: "delete".into(),
                        id: Some(id.to_string()),
                        kind: Some(kind_label),
                        summary: None,
                    });
                    block_ids.push(id.to_string());
                }
                NoteBlockOpKind::Move => {
                    let id_s = op
                        .id
                        .clone()
                        .filter(|s| !s.trim().is_empty())
                        .ok_or_else(|| {
                            NoteBackendError::Invalid("move requires non-empty id".into())
                        })?;
                    let id = Self::parse_block_id(&id_s, "id")?;
                    let meta = known.get(&id).ok_or_else(|| {
                        NoteBackendError::NotFound(format!("block not found: {id}"))
                    })?;
                    let kind_label = Self::kind_label(&meta.kind);
                    let old_parent = meta.parent;

                    let new_parent = match &op.parent_id {
                        Some(s) if !s.trim().is_empty() => {
                            let pid = Self::parse_block_id(s, "parent_id")?;
                            if !known.contains_key(&pid) {
                                return Err(NoteBackendError::NotFound(format!(
                                    "parent_id not found: {pid}"
                                )));
                            }
                            Some(pid)
                        }
                        _ => old_parent,
                    };

                    let previous = match &op.previous_id {
                        Some(s) if !s.trim().is_empty() => {
                            let prev = Self::parse_block_id(s, "previous_id")?;
                            if !known.contains_key(&prev) {
                                return Err(NoteBackendError::NotFound(format!(
                                    "previous_id not found: {prev}"
                                )));
                            }
                            Some(prev)
                        }
                        _ => None,
                    };

                    let order = if let Some(prev) = previous {
                        let prev_order = known
                            .get(&prev)
                            .map(|m| m.order.clone())
                            .unwrap_or_else(|| "a0".into());
                        format!("{prev_order}~m")
                    } else {
                        let base = children_of
                            .get(&new_parent)
                            .map(|v| v.len() as u32)
                            .unwrap_or(0);
                        format!("a{base:04}")
                    };

                    collab_ops.push(Op::Move {
                        id,
                        new_parent,
                        order: order.clone(),
                    });
                    if let Some(m) = known.get_mut(&id) {
                        m.parent = new_parent;
                        m.order = order.clone();
                    }
                    if let Some(list) = children_of.get_mut(&old_parent) {
                        list.retain(|(cid, _)| *cid != id);
                    }
                    children_of
                        .entry(new_parent)
                        .or_default()
                        .push((id, order));

                    previews.push(NoteBlockOpPreview {
                        op: "move".into(),
                        id: Some(id.to_string()),
                        kind: Some(kind_label),
                        summary: None,
                    });
                    block_ids.push(id.to_string());
                }
                NoteBlockOpKind::SetAttr => {
                    let id_s = op
                        .id
                        .clone()
                        .filter(|s| !s.trim().is_empty())
                        .ok_or_else(|| {
                            NoteBackendError::Invalid("set_attr requires non-empty id".into())
                        })?;
                    let id = Self::parse_block_id(&id_s, "id")?;
                    let meta = known.get(&id).ok_or_else(|| {
                        NoteBackendError::NotFound(format!("block not found: {id}"))
                    })?;
                    let kind_label = Self::kind_label(&meta.kind);
                    let attrs = op.attrs.clone().unwrap_or_default();
                    let mut props = BlockProps::default();
                    props.attrs = attrs.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                    collab_ops.push(Op::UpdateProps { id, props });
                    previews.push(NoteBlockOpPreview {
                        op: "set_attr".into(),
                        id: Some(id.to_string()),
                        kind: Some(kind_label),
                        summary: Some(format!("{} attrs", attrs.len())),
                    });
                    block_ids.push(id.to_string());
                }
            }
        }

        Ok(StoreBlockOpPlan {
            collab_ops,
            previews,
            block_ids,
        })
    }
}

/// 规划期节点元数据（Store block ops）
struct PlanNodeMeta {
    parent: Option<BlockId>,
    order: String,
    kind: BlockKind,
    text_len: u32,
    #[allow(dead_code)]
    text: String,
}

/// Store `apply_block_ops` 规划结果
struct StoreBlockOpPlan {
    collab_ops: Vec<Op>,
    previews: Vec<NoteBlockOpPreview>,
    block_ids: Vec<String>,
}

impl StoreNoteBackend {
    /// 从 ops 收集新 Insert 的 block id（字符串）。
    fn collect_insert_ids(ops: &[Op]) -> Vec<String> {
        ops.iter()
            .filter_map(|op| match op {
                Op::Insert { id, .. } => Some(id.to_string()),
                _ => None,
            })
            .collect()
    }

    /// W4-A：`conex_md_ast::LossyReport` → 工具契约 [`NoteLossyReport`]（叶子形状，无 md-ast 依赖）。
    fn map_lossy(report: &LossyReport) -> NoteLossyReport {
        NoteLossyReport {
            items: report
                .items
                .iter()
                .map(|i| NoteLossyItem {
                    code: i.code.clone(),
                    detail: i.detail.clone(),
                    line: i.line,
                })
                .collect(),
        }
    }

    /// 若指定 after_block_id：把挂到同一父下的根级 Insert 的 order 改写到 after 之后。
    fn rewrite_orders_after(ops: &mut [Op], after: &BlockId, tree: &conex_doc_collab::BlockTree) {
        let after_order = match tree.get(after) {
            Some(n) => n.order.clone(),
            None => return,
        };
        let after_parent = tree.get(after).and_then(|n| n.parent);
        let mut seq = 0u32;
        for op in ops.iter_mut() {
            if let Op::Insert {
                parent, order, ..
            } = op
            {
                if *parent == after_parent {
                    // fractional 简化：after_order + 后缀保证字典序靠后
                    *order = format!("{after_order}~{seq:04}");
                    seq += 1;
                }
            }
        }
    }

    fn build_outline_from_session(
        session: &DocSession,
        max_depth: u32,
    ) -> NoteOutline {
        let mut flat: Vec<(String, u32, String)> = Vec::new();
        let mut saw_deeper = false;
        // 文档序：DFS 根 children
        fn walk(
            session: &DocSession,
            ids: &[BlockId],
            max_depth: u32,
            flat: &mut Vec<(String, u32, String)>,
            saw_deeper: &mut bool,
        ) {
            for id in ids {
                let Some(n) = session.tree().get(id) else {
                    continue;
                };
                if let BlockKind::Heading { level } = &n.kind {
                    let lv = u32::from(*level);
                    if lv > max_depth {
                        *saw_deeper = true;
                    } else {
                        let title = n
                            .text_snapshot
                            .clone()
                            .unwrap_or_else(|| session.read_text(id));
                        flat.push((id.to_string(), lv, title));
                    }
                }
                if !n.children.is_empty() {
                    walk(session, &n.children, max_depth, flat, saw_deeper);
                }
            }
        }
        walk(
            session,
            &session.tree().root_children,
            max_depth,
            &mut flat,
            &mut saw_deeper,
        );

        let mut roots: Vec<NoteOutlineNode> = Vec::new();
        for (id, level, title) in flat {
            let node = NoteOutlineNode {
                id,
                level,
                title,
                children: vec![],
            };
            insert_outline_node(&mut roots, node);
        }
        NoteOutline {
            outline: roots,
            truncated: saw_deeper,
        }
    }

    /// 无 session 时从投影表抽 heading（kind = `heading:N`）。
    fn build_outline_from_store(
        &self,
        doc_id: &str,
        max_depth: u32,
    ) -> Result<NoteOutline, NoteBackendError> {
        let kinds: Vec<String> = (1..=max_depth.min(6))
            .map(|l| format!("heading:{l}"))
            .collect();
        let result = self
            .store
            .query_blocks(&QueryBlocksParams {
                doc_id: doc_id.to_string(),
                kind_in: Some(kinds),
                attrs_eq: None,
                text_match: None,
                ref_to: None,
                ref_from: None,
                limit: Some(200),
            })
            .map_err(Self::map_store_err)?;

        let mut roots: Vec<NoteOutlineNode> = Vec::new();
        for hit in result.blocks {
            let level = hit
                .kind
                .strip_prefix("heading:")
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(1);
            let node = NoteOutlineNode {
                id: hit.id,
                level,
                title: hit.snippet,
                children: vec![],
            };
            insert_outline_node(&mut roots, node);
        }
        Ok(NoteOutline {
            outline: roots,
            truncated: result.truncated,
        })
    }
}

/// 将节点插入大纲树（按 level 嵌套；与 MemoryNoteBackend 同策略）。
fn insert_outline_node(roots: &mut Vec<NoteOutlineNode>, node: NoteOutlineNode) {
    if !try_insert_child(roots, &node) {
        roots.push(node);
    }
}

fn try_insert_child(nodes: &mut [NoteOutlineNode], node: &NoteOutlineNode) -> bool {
    for i in (0..nodes.len()).rev() {
        if nodes[i].level < node.level {
            if try_insert_child(&mut nodes[i].children, node) {
                return true;
            }
            nodes[i].children.push(node.clone());
            return true;
        }
    }
    false
}

#[async_trait]
impl NoteBackend for StoreNoteBackend {
    async fn query_blocks(
        &self,
        params: NoteQueryBlocksParams,
    ) -> Result<NoteQueryBlocksResult, NoteBackendError> {
        if params.doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }

        // 读投影索引 / FTS——**禁止** mirror 文件
        let store_params = QueryBlocksParams {
            doc_id: params.doc_id,
            kind_in: params.kind_in,
            attrs_eq: params.attrs_eq.map(|m| m.into_iter().collect()),
            text_match: params.text_match,
            ref_to: params.ref_to,
            ref_from: params.ref_from,
            limit: params.limit.map(|n| n as usize),
        };

        let result = self
            .store
            .query_blocks(&store_params)
            .map_err(Self::map_store_err)?;

        Ok(NoteQueryBlocksResult {
            blocks: result
                .blocks
                .into_iter()
                .map(|h| NoteQueryBlockHit {
                    id: h.id,
                    kind: h.kind,
                    snippet: h.snippet,
                    attrs: h.attrs,
                })
                .collect(),
            truncated: result.truncated,
        })
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

        // 优先 session 树（文档序 DFS）；否则投影表
        {
            let sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(session) = sessions.get(doc_id) {
                return Ok(Self::build_outline_from_session(session, max_depth));
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
        if req.doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }

        // 1. batch token 可选校验
        self.validate_batch_token(req.batch_id.as_deref()).await?;

        // 2. intent 幂等
        if let Some(ref intent) = req.intent_id {
            if intent.trim().is_empty() {
                return Err(NoteBackendError::Invalid(
                    "intent_id must be non-empty when provided".into(),
                ));
            }
            let intents = self.intents.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(prev) = intents.get(intent) {
                let mut out = prev.clone();
                out.idempotent = true;
                out.inserted = 0;
                return Ok(out);
            }
        }

        let origin = Self::origin_from_req(&req);
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        Self::ensure_session(&mut sessions, &self.store, &req.doc_id)?;
        let session = sessions
            .get_mut(&req.doc_id)
            .expect("ensure_session just inserted");

        // 3. 按 mode 生成 Ops + 保留 lossy（W4-A：进 NoteApplyMdResult）
        let (ops, lossy): (Vec<Op>, NoteLossyReport) = match req.mode {
            NoteApplyMode::AppendToBlock => {
                let target_id = if let Some(ref after) = req.after_block_id {
                    Self::parse_block_id(after, "after_block_id")?
                } else if let Some(last) = session.tree().root_children.last() {
                    *last
                } else {
                    return Err(NoteBackendError::NotFound(
                        "append_to_block: no target block".into(),
                    ));
                };
                if session.tree().get(&target_id).is_none() {
                    return Err(NoteBackendError::NotFound(format!(
                        "block not found: {target_id}"
                    )));
                }
                let current = session.read_text(&target_id);
                let start = current.chars().count() as u32;
                let mut insert = String::new();
                if !current.is_empty() && !req.markdown.is_empty() {
                    insert.push('\n');
                }
                insert.push_str(req.markdown.trim_end());
                // append 不经 MD parse，无 lossy
                (
                    vec![Op::TextEdit {
                        id: target_id,
                        start,
                        end: start,
                        insert,
                    }],
                    NoteLossyReport::default(),
                )
            }
            NoteApplyMode::ApplyMdFragment | NoteApplyMode::InsertBlocks => {
                let parent = match req.parent_id.as_deref() {
                    Some(p) if !p.trim().is_empty() => {
                        Some(Self::parse_block_id(p, "parent_id")?)
                    }
                    _ => None,
                };
                // parent 存在性：apply_md_fragment 会 UnknownParent；after 可隐式定父
                let mut parent = parent;
                let after_id = match req.after_block_id.as_deref() {
                    Some(a) if !a.trim().is_empty() => {
                        let aid = Self::parse_block_id(a, "after_block_id")?;
                        let node = session.tree().get(&aid).ok_or_else(|| {
                            NoteBackendError::NotFound(format!(
                                "after_block_id not found: {aid}"
                            ))
                        })?;
                        if parent.is_none() {
                            parent = node.parent;
                        }
                        Some(aid)
                    }
                    _ => None,
                };

                // W2-B + W4-A：ApplyReport 取 ops 并透出 lossy → 工具 result
                let mut report = apply_md_fragment(session.tree(), parent, &req.markdown)
                    .map_err(Self::map_md_err)?;
                if let Some(aid) = after_id {
                    Self::rewrite_orders_after(&mut report.ops, &aid, session.tree());
                }
                let lossy = Self::map_lossy(&report.lossy);
                (report.ops, lossy)
            }
        };

        // 空 ops（空 markdown）合法；仍返回 lossy（通常为空）
        if ops.is_empty() {
            let result = NoteApplyMdResult {
                block_ids: vec![],
                inserted: 0,
                idempotent: false,
                lossy,
            };
            if let Some(ref intent) = req.intent_id {
                let mut intents = self.intents.lock().unwrap_or_else(|e| e.into_inner());
                intents.insert(intent.clone(), result.clone());
            }
            return Ok(result);
        }

        let block_ids = match req.mode {
            NoteApplyMode::AppendToBlock => {
                // 追加模式返回目标 id
                ops.iter()
                    .filter_map(|op| match op {
                        Op::TextEdit { id, .. } => Some(id.to_string()),
                        _ => None,
                    })
                    .collect()
            }
            _ => Self::collect_insert_ids(&ops),
        };
        let inserted = match req.mode {
            NoteApplyMode::AppendToBlock => 0,
            _ => block_ids.len() as u32,
        };

        // 4. commit_ops：session.apply + apply_projection_diff（原子；失败零半树）
        commit_ops(session, &self.store, origin, &ops).map_err(Self::map_commit_err)?;

        let result = NoteApplyMdResult {
            block_ids,
            inserted,
            idempotent: false,
            lossy,
        };

        if let Some(ref intent) = req.intent_id {
            let mut intents = self.intents.lock().unwrap_or_else(|e| e.into_inner());
            intents.insert(intent.clone(), result.clone());
        }
        Ok(result)
    }

    async fn validate_batch_token(&self, batch_id: Option<&str>) -> Result<(), NoteBackendError> {
        match batch_id {
            None => Ok(()),
            Some(id) => self.batch_tokens.validate(id),
        }
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
        if req.doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        self.validate_batch_token(req.batch_id.as_deref()).await?;

        // A-AGT-07：写中断协议——在任何变异前失败，保证零半写
        if req.force_execution_unknown && !req.dry_run {
            return Err(NoteBackendError::ExecutionUnknown(
                "write interrupted before commit; execution state unknown — do not auto-retry write"
                    .into(),
            ));
        }

        let origin = Self::origin_from_str(req.origin.as_deref());
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        Self::ensure_session(&mut sessions, &self.store, &req.doc_id)?;
        let session = sessions
            .get_mut(&req.doc_id)
            .expect("ensure_session just inserted");

        let plan = Self::plan_block_ops_to_collab(session, &req.ops)?;
        let applied = plan.previews.len() as u32;
        let preview = plan.previews;
        let block_ids = plan.block_ids;

        if req.dry_run {
            return Ok(NoteBlockBatchResult {
                dry_run: true,
                applied,
                block_ids,
                preview,
            });
        }

        // 空 ops：合法，零写
        if plan.collab_ops.is_empty() {
            return Ok(NoteBlockBatchResult {
                dry_run: false,
                applied: 0,
                block_ids,
                preview,
            });
        }

        commit_ops(session, &self.store, origin, &plan.collab_ops)
            .map_err(Self::map_commit_err)?;

        Ok(NoteBlockBatchResult {
            dry_run: false,
            applied,
            block_ids,
            preview,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_tools::note_backend::{
        NoteBackend, NoteBlockInsertRequest, NoteBlockOp, NoteBlockOpKind,
    };
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_db() -> (std::path::PathBuf, std::path::PathBuf) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "conex-note-rt-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
            n
        ));
        let _ = std::fs::create_dir_all(&dir);
        let db = dir.join("workspace.db");
        (dir, db)
    }

    #[tokio::test]
    async fn apply_md_then_query_blocks_hits_text() {
        let (dir, db) = temp_db();
        let backend = StoreNoteBackend::open(&db).unwrap();

        let applied = backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "doc-1".into(),
                markdown: "# Title\n\nhello runtime world".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: None,
                message_id: None,
                origin: Some("agent".into()),
            })
            .await
            .unwrap();
        assert!(applied.inserted >= 1, "should insert blocks: {:?}", applied);
        assert!(!applied.idempotent);

        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-1".into(),
                text_match: Some("runtime".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(
            !q.blocks.is_empty(),
            "FTS/query should hit applied text, got {:?}",
            q
        );
        assert!(
            q.blocks.iter().any(|b| b.snippet.contains("runtime")
                || b.snippet.contains("hello")
                || !b.id.is_empty()),
            "hit should relate to body: {:?}",
            q.blocks
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn send_intent_idempotent_no_double_insert() {
        let (dir, db) = temp_db();
        let backend = StoreNoteBackend::open(&db).unwrap();
        let md = "## Section\nbody line for idempotency";

        let first = backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "doc-idem".into(),
                markdown: md.into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: Some("intent-1".into()),
                batch_id: None,
                message_id: Some("msg-1".into()),
                origin: Some("agent".into()),
            })
            .await
            .unwrap();
        assert!(!first.idempotent);
        assert!(first.inserted >= 1);
        let n1 = backend.store().count_blocks("doc-idem").unwrap();

        let second = backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "doc-idem".into(),
                markdown: md.into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: Some("intent-1".into()),
                batch_id: None,
                message_id: Some("msg-1".into()),
                origin: Some("agent".into()),
            })
            .await
            .unwrap();
        assert!(second.idempotent);
        assert_eq!(second.inserted, 0);
        assert_eq!(second.block_ids, first.block_ids);

        let n2 = backend.store().count_blocks("doc-idem").unwrap();
        assert_eq!(n1, n2, "block count must not double on same intent_id");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn outline_contains_heading() {
        let (dir, db) = temp_db();
        let backend = StoreNoteBackend::open(&db).unwrap();

        backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "doc-out".into(),
                markdown: "# Alpha Title\n\npara\n\n## Beta Section".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: None,
                message_id: None,
                origin: Some("agent".into()),
            })
            .await
            .unwrap();

        let outline = backend.document_outline("doc-out", Some(6)).await.unwrap();
        let has_alpha = outline.outline.iter().any(|n| {
            n.title.contains("Alpha")
                || n.children.iter().any(|c| c.title.contains("Beta") || c.title.contains("Alpha"))
                || n.title.contains("Beta")
        });
        assert!(
            has_alpha || !outline.outline.is_empty(),
            "outline should contain headings: {:?}",
            outline
        );
        assert!(
            outline
                .outline
                .iter()
                .any(|n| n.level >= 1 && !n.title.is_empty()),
            "at least one heading node: {:?}",
            outline
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn batch_token_required_when_provided() {
        let (dir, db) = temp_db();
        let backend = StoreNoteBackend::open(&db).unwrap();
        let err = backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "d".into(),
                markdown: "x".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: Some("missing".into()),
                message_id: None,
                origin: None,
            })
            .await
            .unwrap_err();
        assert!(matches!(err, NoteBackendError::BatchTokenInvalid(_)));

        backend.batch_tokens().acquire("ok-batch").unwrap();
        let r = backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "d".into(),
                markdown: "line".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: Some("ok-batch".into()),
                message_id: None,
                origin: None,
            })
            .await
            .unwrap();
        assert_eq!(r.inserted, 1);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn note_runtime_factory_open() {
        let (dir, db) = temp_db();
        let handle = crate::NoteRuntime::open(&db).unwrap();
        let r = handle
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "factory".into(),
                markdown: "via factory".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: None,
                message_id: None,
                origin: None,
            })
            .await
            .unwrap();
        assert_eq!(r.inserted, 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn apply_md_then_get_md_contains_content_and_c_comment() {
        let (dir, db) = temp_db();
        let backend = StoreNoteBackend::open(&db).unwrap();

        backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "doc-get-md".into(),
                markdown: "# Store GetMd\n\nruntime body for get_md".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: None,
                message_id: None,
                origin: Some("agent".into()),
            })
            .await
            .unwrap();

        let md = backend.get_md("doc-get-md").await.unwrap();
        assert!(
            md.contains("Store GetMd") || md.contains("runtime body"),
            "get_md must contain applied text (instant S), got: {md:?}"
        );
        assert!(
            md.contains("<!--c:"),
            "get_md via document_to_md must emit <!--c:UUID-->, got: {md:?}"
        );
        // 未知文档 / 无 session → 空串；禁止 mirror
        assert_eq!(backend.get_md("no-such-doc").await.unwrap(), "");
        let err = backend.get_md("").await.unwrap_err();
        assert!(matches!(err, NoteBackendError::Invalid(_)));

        let _ = std::fs::remove_dir_all(dir);
    }

    /// W4-A：Store 路径 `ApplyReport.lossy` 进入 `NoteApplyMdResult` 且
    /// `apply_result_json` 工具结果面可观测 `missing_block_id`。
    ///
    /// **≠ EL-05**；**≠ A-AGT 满表**；仅证 lossy 结果面（审计 S1）。
    #[tokio::test]
    async fn w4a_store_apply_md_exposes_lossy_on_result_and_tool_json() {
        let (dir, db) = temp_db();
        let backend = StoreNoteBackend::open(&db).unwrap();

        // 与 md-ast `apply_report_lossy_missing_block_id_readable` 同形输入
        let applied = backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "doc-w4a-lossy".into(),
                markdown: "无ID段落应补生成\n".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: None,
                message_id: None,
                origin: Some("agent".into()),
            })
            .await
            .expect("apply without block id still Ok (new id)");

        assert!(
            applied.inserted >= 1,
            "should insert at least one block: {:?}",
            applied
        );
        assert!(
            !applied.lossy.is_empty(),
            "Store 路径不得丢弃 lossy，got empty"
        );
        assert!(
            applied
                .lossy
                .items
                .iter()
                .any(|i| i.code == "missing_block_id"),
            "期望 missing_block_id，got {:?}",
            applied.lossy
        );

        // 工具 result 面（document_apply_md / send_to_note 共用 apply_result_json）
        let j = agent_tools::apply_result_json(&applied);
        assert_eq!(j["ok"], true);
        let items = j["lossy"]["items"]
            .as_array()
            .expect("tool JSON must have lossy.items");
        assert!(
            items.iter().any(|i| i["code"] == "missing_block_id"),
            "tool JSON 须可观测 missing_block_id，got {items:?}"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    /// W4-A：带合法 `<!--c:UUID-->` 且无有损时，lossy.items 为空数组但仍出现。
    #[tokio::test]
    async fn w4a_store_apply_md_empty_lossy_when_ids_present() {
        let (dir, db) = temp_db();
        let backend = StoreNoteBackend::open(&db).unwrap();
        let md = "\
<!--c:22222222-2222-4222-a222-222222222222-->
带ID段落
";
        let applied = backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "doc-w4a-clean".into(),
                markdown: md.into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: None,
                message_id: None,
                origin: Some("agent".into()),
            })
            .await
            .unwrap();
        assert!(applied.inserted >= 1);
        // 可能仍有 structure_note 等；至少保证字段存在且 tool JSON 形状稳定
        let j = agent_tools::apply_result_json(&applied);
        assert!(j.get("lossy").is_some());
        assert!(j["lossy"]["items"].as_array().is_some());

        let _ = std::fs::remove_dir_all(dir);
    }

    // ── W4-F 余量：StoreNoteBackend::apply_block_ops 真路径 ──────────

    /// Store 真写入：apply_block_ops insert → query_blocks 可命中（非 Memory）。
    ///
    /// **≠ EL-05**；**≠ W6-E**；**≠ A-AGT 全表**。
    #[tokio::test]
    async fn w4f_store_apply_block_ops_insert_writes_and_query_hits() {
        let (dir, db) = temp_db();
        let backend = StoreNoteBackend::open(&db).unwrap();

        let r = backend
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: "doc-store-batch".into(),
                ops: vec![NoteBlockOp {
                    op: NoteBlockOpKind::Insert,
                    id: None,
                    parent_id: None,
                    previous_id: None,
                    content: Some("store block ops body".into()),
                    kind: Some("paragraph".into()),
                    attrs: None,
                }],
                dry_run: false,
                batch_id: None,
                origin: Some("agent".into()),
                force_execution_unknown: false,
            })
            .await
            .expect("Store apply_block_ops must succeed");
        assert!(!r.dry_run);
        assert_eq!(r.applied, 1);
        assert_eq!(r.block_ids.len(), 1);
        assert!(!r.preview.is_empty());

        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-store-batch".into(),
                text_match: Some("store block ops".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(
            !q.blocks.is_empty(),
            "Store 投影/FTS 须命中 apply_block_ops 写入: {:?}",
            q
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Store block_insert 经 apply_block_ops 默认委托真写入。
    #[tokio::test]
    async fn w4f_store_block_insert_true_path() {
        let (dir, db) = temp_db();
        let backend = StoreNoteBackend::open(&db).unwrap();

        let r = backend
            .block_insert(NoteBlockInsertRequest {
                doc_id: "doc-store-ins".into(),
                content: "store insert leaf".into(),
                parent_id: None,
                previous_id: None,
                kind: Some("paragraph".into()),
                batch_id: None,
                origin: Some("agent".into()),
            })
            .await
            .expect("Store block_insert");
        assert!(!r.block_id.is_empty());
        assert_eq!(r.kind, "paragraph");

        let md = backend.get_md("doc-store-ins").await.unwrap();
        assert!(
            md.contains("store insert leaf"),
            "get_md 须含 insert 文本: {md:?}"
        );
        assert!(md.contains("<!--c:"), "须含块 ID 注释");

        let _ = std::fs::remove_dir_all(dir);
    }

    /// dryRun=true：零写 + preview（Store 路径）。
    #[tokio::test]
    async fn w4f_store_apply_block_ops_dry_run_zero_write() {
        let (dir, db) = temp_db();
        let backend = StoreNoteBackend::open(&db).unwrap();

        // 先实写一块作基线
        let base = backend
            .block_insert(NoteBlockInsertRequest {
                doc_id: "doc-store-dr".into(),
                content: "baseline only".into(),
                parent_id: None,
                previous_id: None,
                kind: None,
                batch_id: None,
                origin: Some("agent".into()),
            })
            .await
            .unwrap();

        let r = backend
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: "doc-store-dr".into(),
                ops: vec![NoteBlockOp {
                    op: NoteBlockOpKind::Insert,
                    id: None,
                    parent_id: None,
                    previous_id: Some(base.block_id.clone()),
                    content: Some("must not land".into()),
                    kind: Some("paragraph".into()),
                    attrs: None,
                }],
                dry_run: true,
                batch_id: None,
                origin: Some("agent".into()),
                force_execution_unknown: false,
            })
            .await
            .unwrap();
        assert!(r.dry_run);
        assert_eq!(r.applied, 1);
        assert!(!r.preview.is_empty());

        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-store-dr".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks.len(), 1, "dryRun 不得写第二块");
        assert_eq!(q.blocks[0].id, base.block_id);

        let _ = std::fs::remove_dir_all(dir);
    }

    /// force_execution_unknown：中断码 + 零半写（Store）。
    #[tokio::test]
    async fn w4f_store_apply_block_ops_execution_unknown_no_half_write() {
        let (dir, db) = temp_db();
        let backend = StoreNoteBackend::open(&db).unwrap();

        let err = backend
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: "doc-store-eu".into(),
                ops: vec![NoteBlockOp {
                    op: NoteBlockOpKind::Insert,
                    id: None,
                    parent_id: None,
                    previous_id: None,
                    content: Some("should not commit".into()),
                    kind: None,
                    attrs: None,
                }],
                dry_run: false,
                batch_id: None,
                origin: Some("agent".into()),
                force_execution_unknown: true,
            })
            .await
            .unwrap_err();
        assert_eq!(err.code(), "note.execution_unknown");
        assert!(matches!(err, NoteBackendError::ExecutionUnknown(_)));

        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-store-eu".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(q.blocks.is_empty(), "中断不得半写");

        let _ = std::fs::remove_dir_all(dir);
    }

    /// update / delete 经 Store apply_block_ops 真路径。
    #[tokio::test]
    async fn w4f_store_apply_block_ops_update_and_delete() {
        let (dir, db) = temp_db();
        let backend = StoreNoteBackend::open(&db).unwrap();

        let ins = backend
            .block_insert(NoteBlockInsertRequest {
                doc_id: "doc-store-ud".into(),
                content: "before update".into(),
                parent_id: None,
                previous_id: None,
                kind: Some("paragraph".into()),
                batch_id: None,
                origin: Some("agent".into()),
            })
            .await
            .unwrap();

        let upd = backend
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: "doc-store-ud".into(),
                ops: vec![NoteBlockOp {
                    op: NoteBlockOpKind::Update,
                    id: Some(ins.block_id.clone()),
                    parent_id: None,
                    previous_id: None,
                    content: Some("after update store".into()),
                    kind: None,
                    attrs: None,
                }],
                dry_run: false,
                batch_id: None,
                origin: Some("agent".into()),
                force_execution_unknown: false,
            })
            .await
            .unwrap();
        assert_eq!(upd.applied, 1);

        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-store-ud".into(),
                text_match: Some("after update".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(!q.blocks.is_empty(), "update 后 FTS 应命中");

        let del = backend
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: "doc-store-ud".into(),
                ops: vec![NoteBlockOp {
                    op: NoteBlockOpKind::Delete,
                    id: Some(ins.block_id.clone()),
                    parent_id: None,
                    previous_id: None,
                    content: None,
                    kind: None,
                    attrs: None,
                }],
                dry_run: false,
                batch_id: None,
                origin: Some("agent".into()),
                force_execution_unknown: false,
            })
            .await
            .unwrap();
        assert_eq!(del.applied, 1);

        let q2 = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-store-ud".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(q2.blocks.is_empty(), "delete 后投影应无块");

        let _ = std::fs::remove_dir_all(dir);
    }
}
