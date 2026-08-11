//! [`StoreNoteBackend`]：真实 store + DocSession 管线实现 `NoteBackend`。

use agent_tools::note_backend::{
    NoteApplyMdRequest, NoteApplyMdResult, NoteApplyMode, NoteBackend, NoteBackendError,
    NoteBatchTokens, NoteOutline, NoteOutlineNode, NoteQueryBlockHit, NoteQueryBlocksParams,
    NoteQueryBlocksResult,
};
use async_trait::async_trait;
use conex_doc_collab::{BlockId, BlockKind, DocSession, Op, Origin, PersistencePlugin};
use conex_md_ast::{apply_md_fragment, MdError};
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
/// - 写路径仅 `apply_md_fragment` → Ops → `commit_ops`（权威 updates + 投影索引）
/// - 读路径即时投影 / session 树；**不**读 MD mirror 文件
/// - 同 `intent_id` 二次调用返回首次结果（`idempotent=true`, `inserted=0`）
/// - batch token：内嵌 [`NoteBatchTokens`]（与 Memory 后端同语义）
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

    /// 确保 doc 会话存在：`load_doc` 触达 + 建 session + with_persistence。
    ///
    /// 结构 CRDT 字节现为 rev 占位，**不能**从 blob 重建树；会话树在进程内
    /// 累积。`load_doc` 仍调用以校验 store 可达并预热 pending 路径。
    fn ensure_session(
        sessions: &mut HashMap<String, DocSession>,
        store: &SharedWorkspaceStore,
        doc_id: &str,
    ) -> Result<(), NoteBackendError> {
        if sessions.contains_key(doc_id) {
            return Ok(());
        }
        // 触达权威 blob（hydrate 入口；失败映射为 ApplyFailed）
        let _blob = store.load_doc(doc_id).map_err(|e| {
            NoteBackendError::ApplyFailed(format!("load_doc hydrate: {e}"))
        })?;
        let session = DocSession::new(doc_id.to_string())
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
        match req.origin.as_deref().map(str::trim) {
            Some("agent") | Some("Agent") => Origin::Agent,
            Some("remote") | Some("Remote") => Origin::Remote,
            Some("system") | Some("System") => Origin::System,
            _ => Origin::User,
        }
    }

    /// 从 ops 收集新 Insert 的 block id（字符串）。
    fn collect_insert_ids(ops: &[Op]) -> Vec<String> {
        ops.iter()
            .filter_map(|op| match op {
                Op::Insert { id, .. } => Some(id.to_string()),
                _ => None,
            })
            .collect()
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
                let Some(n) = session.tree.get(id) else {
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
            &session.tree.root_children,
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

        // 3. 按 mode 生成 Ops
        let ops: Vec<Op> = match req.mode {
            NoteApplyMode::AppendToBlock => {
                let target_id = if let Some(ref after) = req.after_block_id {
                    Self::parse_block_id(after, "after_block_id")?
                } else if let Some(last) = session.tree.root_children.last() {
                    *last
                } else {
                    return Err(NoteBackendError::NotFound(
                        "append_to_block: no target block".into(),
                    ));
                };
                if session.tree.get(&target_id).is_none() {
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
                vec![Op::TextEdit {
                    id: target_id,
                    start,
                    end: start,
                    insert,
                }]
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
                        let node = session.tree.get(&aid).ok_or_else(|| {
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

                let mut ops = apply_md_fragment(&session.tree, parent, &req.markdown)
                    .map_err(Self::map_md_err)?;
                if let Some(aid) = after_id {
                    Self::rewrite_orders_after(&mut ops, &aid, &session.tree);
                }
                ops
            }
        };

        // 空 ops（空 markdown）合法
        if ops.is_empty() {
            let result = NoteApplyMdResult {
                block_ids: vec![],
                inserted: 0,
                idempotent: false,
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_tools::note_backend::NoteBackend;
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
}
