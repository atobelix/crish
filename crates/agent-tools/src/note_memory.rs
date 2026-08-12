//! 进程内 [`MemoryNoteBackend`]（SD-01 纵向切开）
//!
//! dev/test + 可注入 ToolContext；**≠** Store 真路径，**≠ EL-05**。
//! 写路径经 `apply_md_fragment` / `apply_block_ops`（plan → commit）。

use crate::note_backend::NoteBackend;
use crate::note_md_parse::{parse_heading_level_from_text, parse_md_lines};
use crate::note_plan_ops::{
    apply_planned_ops, plan_block_ops, MemBlock, MemDoc,
};
use crate::note_types::{
    NoteApplyMdRequest, NoteApplyMdResult, NoteApplyMode, NoteBackendError, NoteBatchTokens,
    NoteBlockBatchRequest, NoteBlockBatchResult, NoteBlockOpPreview, NoteLossyReport, NoteOutline,
    NoteOutlineNode, NoteQueryBlockHit, NoteQueryBlocksParams, NoteQueryBlocksResult,
};
use async_trait::async_trait;
use serde_json::{Map, Value as JsonValue};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// 进程内笔记后端（dev/test + 可注入 ToolContext）
///
/// - `query_blocks` / `document_outline` / `get_md`：内存过滤 / 即时序列化
/// - `apply_md_fragment`：极简 MD 按行插段落 / 识别 ATX 标题；支持 intent 幂等
/// - batch token：内嵌 [`NoteBatchTokens`]
///
/// # 诚实边界
/// - Memory 测绿 **禁关**生产 A-AGT / EL-05
/// - **≠** 宣称 Store 后端完成
#[derive(Debug)]
pub struct MemoryNoteBackend {
    docs: Mutex<HashMap<String, MemDoc>>,
    /// intent_id → 首次 apply 结果（幂等）
    intents: Mutex<HashMap<String, NoteApplyMdResult>>,
    batch_tokens: NoteBatchTokens,
    id_seq: AtomicU64,
}

impl Default for MemoryNoteBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryNoteBackend {
    /// 空后端
    pub fn new() -> Self {
        Self {
            docs: Mutex::new(HashMap::new()),
            intents: Mutex::new(HashMap::new()),
            batch_tokens: NoteBatchTokens::new(),
            id_seq: AtomicU64::new(1),
        }
    }

    /// 自定义 batch TTL
    pub fn with_batch_ttl(ttl: Duration) -> Self {
        Self {
            docs: Mutex::new(HashMap::new()),
            intents: Mutex::new(HashMap::new()),
            batch_tokens: NoteBatchTokens::with_ttl(ttl),
            id_seq: AtomicU64::new(1),
        }
    }

    /// 预置文档块（测试夹具）
    pub fn seed_doc(&self, doc_id: &str, blocks: Vec<(String, String, String)>) {
        // (id, kind, text)
        let mut docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
        let mem = docs.entry(doc_id.to_string()).or_default();
        for (id, kind, text) in blocks {
            let level = if kind == "heading" {
                parse_heading_level_from_text(&text).unwrap_or(1)
            } else {
                0
            };
            mem.blocks.push(MemBlock {
                id,
                kind,
                text,
                attrs: Map::new(),
                refs_to: Vec::new(),
                level,
            });
        }
    }

    /// 为块追加属性（测试）
    pub fn set_block_attrs(&self, doc_id: &str, block_id: &str, attrs: Map<String, JsonValue>) {
        let mut docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(doc) = docs.get_mut(doc_id) {
            if let Some(b) = doc.blocks.iter_mut().find(|b| b.id == block_id) {
                b.attrs = attrs;
            }
        }
    }

    /// 为块设置引用目标（测试：ref 过滤）
    pub fn set_block_refs(&self, doc_id: &str, block_id: &str, refs_to: Vec<String>) {
        let mut docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(doc) = docs.get_mut(doc_id) {
            if let Some(b) = doc.blocks.iter_mut().find(|b| b.id == block_id) {
                b.refs_to = refs_to;
            }
        }
    }

    /// 暴露 batch token 管理（测试 / 会话装配）
    pub fn batch_tokens(&self) -> &NoteBatchTokens {
        &self.batch_tokens
    }

    fn next_id(&self) -> String {
        let n = self.id_seq.fetch_add(1, Ordering::SeqCst);
        format!("mem-block-{n}")
    }

    fn ensure_doc<'a>(
        docs: &'a mut HashMap<String, MemDoc>,
        doc_id: &str,
    ) -> &'a mut MemDoc {
        docs.entry(doc_id.to_string()).or_default()
    }
}

#[async_trait]
impl NoteBackend for MemoryNoteBackend {
    async fn query_blocks(
        &self,
        params: NoteQueryBlocksParams,
    ) -> Result<NoteQueryBlocksResult, NoteBackendError> {
        if params.doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let limit = params
            .limit
            .unwrap_or(50)
            .clamp(1, 200) as usize;

        let docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
        let doc = match docs.get(&params.doc_id) {
            Some(d) => d,
            None => {
                return Ok(NoteQueryBlocksResult {
                    blocks: vec![],
                    truncated: false,
                });
            }
        };

        let kind_filter: Option<std::collections::HashSet<&str>> = params
            .kind_in
            .as_ref()
            .map(|v| v.iter().map(|s| s.as_str()).collect());

        let mut hits: Vec<NoteQueryBlockHit> = Vec::new();
        for b in &doc.blocks {
            if let Some(ref kinds) = kind_filter {
                if !kinds.is_empty() && !kinds.contains(b.kind.as_str()) {
                    continue;
                }
            }
            if let Some(ref text) = params.text_match {
                if !text.is_empty() && !b.text.contains(text.as_str()) {
                    continue;
                }
            }
            if let Some(ref attrs_eq) = params.attrs_eq {
                let mut ok = true;
                for (k, v) in attrs_eq {
                    match b.attrs.get(k) {
                        Some(bv) if bv == v => {}
                        _ => {
                            ok = false;
                            break;
                        }
                    }
                }
                if !ok {
                    continue;
                }
            }
            // ref_to：谁引用了该块 → 块的 refs_to 含目标
            if let Some(ref target) = params.ref_to {
                if !target.is_empty() && !b.refs_to.iter().any(|r| r == target) {
                    continue;
                }
            }
            // ref_from：该块引用了谁 → 源块 id 匹配且有出边（返回被引用目标）
            // 简化：ref_from=X 时返回 X 的 refs_to 指向的块
            if let Some(ref source) = params.ref_from {
                if !source.is_empty() {
                    // 当前块必须是 source 引用的目标之一
                    let source_block = doc.blocks.iter().find(|x| x.id == *source);
                    match source_block {
                        Some(src) if src.refs_to.iter().any(|r| r == &b.id) => {}
                        _ => continue,
                    }
                }
            }

            hits.push(NoteQueryBlockHit {
                id: b.id.clone(),
                kind: b.kind.clone(),
                snippet: b.text.chars().take(200).collect(),
                attrs: b.attrs.clone(),
            });
        }

        let truncated = hits.len() > limit;
        if truncated {
            hits.truncate(limit);
        }
        Ok(NoteQueryBlocksResult { blocks: hits, truncated })
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

        let docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
        let doc = match docs.get(doc_id) {
            Some(d) => d,
            None => {
                return Ok(NoteOutline {
                    outline: vec![],
                    truncated: false,
                });
            }
        };

        // 收集 heading 扁平列表
        let mut flat: Vec<(String, u32, String)> = Vec::new();
        let mut saw_deeper = false;
        for b in &doc.blocks {
            if b.kind != "heading" || b.level == 0 {
                continue;
            }
            if b.level > max_depth {
                saw_deeper = true;
                continue;
            }
            flat.push((b.id.clone(), b.level, b.text.clone()));
        }

        // 栈式建树
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

        Ok(NoteOutline {
            outline: roots,
            truncated: saw_deeper,
        })
    }

    async fn get_md(&self, doc_id: &str) -> Result<String, NoteBackendError> {
        if doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
        let Some(doc) = docs.get(doc_id) else {
            // 无文档 = 空树即时 S；禁止 mirror 回退
            return Ok(String::new());
        };
        Ok(serialize_mem_doc_to_md(doc))
    }

    async fn apply_md_fragment(
        &self,
        req: NoteApplyMdRequest,
    ) -> Result<NoteApplyMdResult, NoteBackendError> {
        if req.doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }

        // batch token 可选校验
        self.validate_batch_token(req.batch_id.as_deref()).await?;

        // 幂等：同 intent_id 返回首次结果
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

        let drafts = parse_md_lines(&req.markdown);

        let mut docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
        let doc = Self::ensure_doc(&mut docs, &req.doc_id);

        // append_to_block：把 markdown 追加到 after_block_id 或末块
        if req.mode == NoteApplyMode::AppendToBlock {
            let target_id = req
                .after_block_id
                .clone()
                .or_else(|| doc.blocks.last().map(|b| b.id.clone()));
            let Some(tid) = target_id else {
                return Err(NoteBackendError::NotFound(
                    "append_to_block: no target block".into(),
                ));
            };
            let block = doc
                .blocks
                .iter_mut()
                .find(|b| b.id == tid)
                .ok_or_else(|| {
                    NoteBackendError::NotFound(format!("block not found: {tid}"))
                })?;
            if !block.text.is_empty() && !req.markdown.is_empty() {
                block.text.push('\n');
            }
            block.text.push_str(req.markdown.trim_end());
            let result = NoteApplyMdResult {
                block_ids: vec![tid],
                inserted: 0,
                idempotent: false,
                // Memory 不走真实 P：无 lossy 透出（Store 路径才有 W4-A 真 lossy）
                lossy: NoteLossyReport::default(),
            };
            drop(docs);
            if let Some(ref intent) = req.intent_id {
                let mut intents = self.intents.lock().unwrap_or_else(|e| e.into_inner());
                intents.insert(intent.clone(), result.clone());
            }
            return Ok(result);
        }

        // after_block_id 定位插入点
        let mut insert_at = doc.blocks.len();
        if let Some(ref after) = req.after_block_id {
            match doc.blocks.iter().position(|b| b.id == *after) {
                Some(i) => insert_at = i + 1,
                None => {
                    return Err(NoteBackendError::NotFound(format!(
                        "after_block_id not found: {after}"
                    )));
                }
            }
        }

        // parent_id：Memory 后端仅作存在性校验（扁平列表，不建父子边）
        if let Some(ref parent) = req.parent_id {
            if !doc.blocks.iter().any(|b| b.id == *parent) {
                // 允许 parent 为虚拟根：不存在时若文档非空则报错；空文档放行
                if !doc.blocks.is_empty() {
                    return Err(NoteBackendError::NotFound(format!(
                        "parent_id not found: {parent}"
                    )));
                }
            }
        }

        let mut block_ids = Vec::with_capacity(drafts.len());
        let mut new_blocks = Vec::with_capacity(drafts.len());
        for (kind, text, level) in drafts {
            let id = self.next_id();
            // id 冲突保护（极低概率）
            if doc.blocks.iter().any(|b| b.id == id)
                || new_blocks.iter().any(|b: &MemBlock| b.id == id)
            {
                return Err(NoteBackendError::IdConflict(format!(
                    "block id conflict: {id}"
                )));
            }
            block_ids.push(id.clone());
            new_blocks.push(MemBlock {
                id,
                kind,
                text,
                attrs: Map::new(),
                refs_to: Vec::new(),
                level,
            });
        }

        let inserted = new_blocks.len() as u32;
        for (offset, block) in new_blocks.into_iter().enumerate() {
            doc.blocks.insert(insert_at + offset, block);
        }

        let result = NoteApplyMdResult {
            block_ids,
            inserted,
            idempotent: false,
            // Memory 行解析伪实现：不产生 md-ast LossyReport（≠ Store 真路径）
            lossy: NoteLossyReport::default(),
        };

        drop(docs);
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

    /// W4-F：块级批 ops；dryRun 零写；force_execution_unknown 中断不半写
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

        // 在锁外规划（仅读当前树做校验）；成功后再一次提交
        let plan = {
            let docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
            let existing = docs.get(&req.doc_id).map(|d| d.blocks.as_slice());
            plan_block_ops(existing, &req.ops, || self.next_id())?
        };

        let preview: Vec<NoteBlockOpPreview> = plan
            .previews
            .iter()
            .cloned()
            .collect();
        let block_ids = plan.block_ids.clone();
        let applied = plan.previews.len() as u32;

        if req.dry_run {
            return Ok(NoteBlockBatchResult {
                dry_run: true,
                applied,
                block_ids,
                preview,
            });
        }

        // 原子提交：整批写入（Memory 扁平列表；≠ Store 真事务，仅测形状）
        {
            let mut docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
            let doc = Self::ensure_doc(&mut docs, &req.doc_id);
            apply_planned_ops(doc, plan.mutations)?;
        }

        Ok(NoteBlockBatchResult {
            dry_run: false,
            applied,
            block_ids,
            preview,
        })
    }
}

/// Memory 文档 → 即时 Conex-MD 风格串（含 `<!--c:id-->`；id 可为非 UUID）
fn serialize_mem_doc_to_md(doc: &MemDoc) -> String {
    let mut out = String::new();
    for (i, b) in doc.blocks.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        // 与生产 `<!--c:UUID-->` 同形；Memory 伪 id 仍写出，便于 Agent 定位块
        out.push_str(&format!("<!--c:{}-->\n", b.id));
        match b.kind.as_str() {
            "heading" => {
                let level = b.level.clamp(1, 6) as usize;
                let hashes: String = std::iter::repeat('#').take(level.max(1)).collect();
                if b.text.is_empty() {
                    out.push_str(&hashes);
                } else {
                    out.push_str(&format!("{hashes} {}", b.text));
                }
            }
            _ => out.push_str(&b.text),
        }
        out.push('\n');
    }
    out
}

/// 将节点插入大纲树（按 level 嵌套）
fn insert_outline_node(roots: &mut Vec<NoteOutlineNode>, node: NoteOutlineNode) {
    if roots.is_empty() || node.level <= roots.last().map(|r| r.level).unwrap_or(1) {
        // 与根同级或更浅 → 作为新根（简化：始终尝试挂到最深可挂父）
        // 更精确：找最后一个 level < node.level 的路径
    }
    // 递归：从 roots 找最深的 level < node.level 的节点挂 children
    if !try_insert_child(roots, &node) {
        roots.push(node);
    }
}

fn try_insert_child(nodes: &mut [NoteOutlineNode], node: &NoteOutlineNode) -> bool {
    // 从后往前找可挂父
    for i in (0..nodes.len()).rev() {
        if nodes[i].level < node.level {
            // 先尝试挂到该节点的子树
            if try_insert_child(&mut nodes[i].children, node) {
                return true;
            }
            nodes[i].children.push(node.clone());
            return true;
        }
    }
    false
}
