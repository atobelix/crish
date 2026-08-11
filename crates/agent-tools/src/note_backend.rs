//! 笔记后端契约（W4-A/B：NoteBackend trait + 引擎/测试注入）
//!
//! agent-tools 保持叶子依赖哲学：**不**硬依赖 `conex-doc-collab` /
//! `conex-workspace-store`。真实 store/DocSession 由引擎侧实现本 trait
//! 并经 [`crate::context::ToolContext::note_backend`] 注入；本 crate 仅定义
//! 契约、serde 线格式类型与进程内 [`MemoryNoteBackend`]（dev/test）。
//!
//! # 不变量
//! - 写路径仅经 `apply_md_fragment`（事务化 apply 语义由实现方保证）；
//!   **禁止**工具侧 `fs.write` 后当笔记权威。
//! - 读路径即时 S(树)；**禁止**默认 disk mirror。
//! - `send_to_note` 幂等：同一 `intent_id` 不双插。
//! - batch token：会话内 `batch_id` 占用/释放；非法/过期拒绝写。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};
use std::collections::HashMap;
use std::fmt::Debug;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ==================== 错误 ====================

/// 笔记后端错误（工具层映射为 ok=false / ToolError）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteBackendError {
    /// 后端未接线（通常由工具在 Option=None 时直接返回，不经 trait）
    Unwired,
    /// 文档 / 块不存在
    NotFound(String),
    /// 入参非法
    Invalid(String),
    /// apply / 解析失败（零半树由实现方保证）
    ApplyFailed(String),
    /// 块 id 冲突
    IdConflict(String),
    /// batch token 非法（未占用 / 未知）
    BatchTokenInvalid(String),
    /// batch token 已过期
    BatchTokenExpired(String),
}

impl NoteBackendError {
    /// 稳定错误码字面量（工具 JSON / 日志）
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unwired => "note.unwired",
            Self::NotFound(_) => "note.not_found",
            Self::Invalid(_) => "note.invalid",
            Self::ApplyFailed(_) => "note.apply_failed",
            Self::IdConflict(_) => "note.id_conflict",
            Self::BatchTokenInvalid(_) => "note.batch_token_invalid",
            Self::BatchTokenExpired(_) => "note.batch_token_expired",
        }
    }

    /// 人读消息
    pub fn message(&self) -> String {
        match self {
            Self::Unwired => "note backend not wired".to_string(),
            Self::NotFound(m)
            | Self::Invalid(m)
            | Self::ApplyFailed(m)
            | Self::IdConflict(m)
            | Self::BatchTokenInvalid(m)
            | Self::BatchTokenExpired(m) => m.clone(),
        }
    }
}

impl std::fmt::Display for NoteBackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code(), self.message())
    }
}

impl std::error::Error for NoteBackendError {}

// ==================== query_blocks 类型（snake_case 线格式）====================

/// `query_blocks` 入参（对齐 store / TS 契约）
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct NoteQueryBlocksParams {
    pub doc_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind_in: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attrs_eq: Option<Map<String, JsonValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_match: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// 单条命中块摘要
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteQueryBlockHit {
    pub id: String,
    pub kind: String,
    pub snippet: String,
    #[serde(default)]
    pub attrs: Map<String, JsonValue>,
}

/// `query_blocks` 出参
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteQueryBlocksResult {
    pub blocks: Vec<NoteQueryBlockHit>,
    pub truncated: bool,
}

// ==================== document_outline 类型 ====================

/// 大纲节点
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteOutlineNode {
    pub id: String,
    pub level: u32,
    pub title: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<NoteOutlineNode>,
}

/// 文档大纲
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteOutline {
    pub outline: Vec<NoteOutlineNode>,
    pub truncated: bool,
}

// ==================== apply_md 类型 ====================

/// apply / send_to_note 写入模式
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NoteApplyMode {
    /// 解析 MD 为块并插入（默认）
    #[default]
    ApplyMdFragment,
    /// 插入块（与 apply_md_fragment 在 Memory 后端等价：按行插段落）
    InsertBlocks,
    /// 追加到已有块文本
    AppendToBlock,
}

impl NoteApplyMode {
    /// 从工具入参字符串解析；未知 → Invalid
    pub fn parse(s: &str) -> Result<Self, NoteBackendError> {
        match s {
            "apply_md_fragment" | "apply-md-fragment" => Ok(Self::ApplyMdFragment),
            "insert_blocks" | "insert-blocks" => Ok(Self::InsertBlocks),
            "append_to_block" | "append-to-block" => Ok(Self::AppendToBlock),
            other => Err(NoteBackendError::Invalid(format!(
                "unknown apply mode: {other}"
            ))),
        }
    }
}

/// `apply_md_fragment` / `document_apply_md` 请求
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteApplyMdRequest {
    pub doc_id: String,
    pub markdown: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_block_id: Option<String>,
    #[serde(default)]
    pub mode: NoteApplyMode,
    /// 幂等键（send_to_note 的 intent_id；document_apply_md 可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent_id: Option<String>,
    /// 会话 batch token（可选校验）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    /// 源消息 id（send_to_note 透传，不参与写入逻辑）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// 来源：user | agent
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// apply 结果
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteApplyMdResult {
    /// 新插入（或幂等返回）的块 id 列表
    pub block_ids: Vec<String>,
    /// 本次实际新插入的块数（幂等 hit 时为 0）
    pub inserted: u32,
    /// 是否命中幂等缓存（同 intent_id 重复调用）
    pub idempotent: bool,
}

// ==================== batch token ====================

/// 默认 batch token TTL（会话内轻量过期）
pub const DEFAULT_BATCH_TOKEN_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug)]
struct BatchTokenEntry {
    expires_at: Instant,
}

/// 会话内 `batch_id` 占用与释放（轻量真实实现）
///
/// - [`Self::acquire`]：登记 batch_id，重复占用视为刷新 TTL
/// - [`Self::validate`]：存在且未过期则 Ok；未知 → Invalid；过期 → Expired 并剔除
/// - [`Self::release`]：主动释放
#[derive(Debug, Default)]
pub struct NoteBatchTokens {
    inner: Mutex<HashMap<String, BatchTokenEntry>>,
    ttl: Duration,
}

impl NoteBatchTokens {
    /// 使用默认 TTL 构造
    pub fn new() -> Self {
        Self::with_ttl(DEFAULT_BATCH_TOKEN_TTL)
    }

    /// 自定义 TTL（测试可注入短过期）
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    /// 占用 / 刷新 batch_id
    pub fn acquire(&self, batch_id: &str) -> Result<(), NoteBackendError> {
        if batch_id.trim().is_empty() {
            return Err(NoteBackendError::BatchTokenInvalid(
                "batch_id must be non-empty".into(),
            ));
        }
        let mut map = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.insert(
            batch_id.to_string(),
            BatchTokenEntry {
                expires_at: Instant::now() + self.ttl,
            },
        );
        Ok(())
    }

    /// 校验 batch_id：存在且未过期
    pub fn validate(&self, batch_id: &str) -> Result<(), NoteBackendError> {
        if batch_id.trim().is_empty() {
            return Err(NoteBackendError::BatchTokenInvalid(
                "batch_id must be non-empty".into(),
            ));
        }
        let mut map = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match map.get(batch_id) {
            Some(entry) if entry.expires_at > Instant::now() => Ok(()),
            Some(_) => {
                map.remove(batch_id);
                Err(NoteBackendError::BatchTokenExpired(format!(
                    "batch_id expired: {batch_id}"
                )))
            }
            None => Err(NoteBackendError::BatchTokenInvalid(format!(
                "batch_id not acquired: {batch_id}"
            ))),
        }
    }

    /// 释放 batch_id（幂等）
    pub fn release(&self, batch_id: &str) {
        let mut map = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.remove(batch_id);
    }

    /// 当前有效（未过期）token 数（测试用）
    pub fn active_count(&self) -> usize {
        let mut map = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        map.retain(|_, e| e.expires_at > now);
        map.len()
    }
}

// ==================== NoteBackend trait ====================

/// 笔记后端契约（dyn trait + 引擎/测试注入）
///
/// ToolContext 派生 Debug，trait 对象须可打印（对齐 CompressionContextStore）。
#[async_trait]
pub trait NoteBackend: Send + Sync + Debug {
    /// 组合查询块摘要
    async fn query_blocks(
        &self,
        params: NoteQueryBlocksParams,
    ) -> Result<NoteQueryBlocksResult, NoteBackendError>;

    /// 文档标题大纲
    async fn document_outline(
        &self,
        doc_id: &str,
        max_depth: Option<u32>,
    ) -> Result<NoteOutline, NoteBackendError>;

    /// 事务化 apply MD 片段（写路径唯一入口）
    async fn apply_md_fragment(
        &self,
        req: NoteApplyMdRequest,
    ) -> Result<NoteApplyMdResult, NoteBackendError>;

    /// 可选 batch token 校验钩子（默认：无 batch_id 则放行；有则 Invalid——
    /// 生产实现可覆写；[`MemoryNoteBackend`] 走真实 [`NoteBatchTokens`]）
    async fn validate_batch_token(&self, batch_id: Option<&str>) -> Result<(), NoteBackendError> {
        match batch_id {
            None => Ok(()),
            Some(id) if id.trim().is_empty() => Err(NoteBackendError::BatchTokenInvalid(
                "batch_id must be non-empty".into(),
            )),
            Some(_) => Err(NoteBackendError::BatchTokenInvalid(
                "batch token validation not supported by this backend".into(),
            )),
        }
    }
}

// ==================== MemoryNoteBackend ====================

/// 进程内块（Memory 伪实现）
#[derive(Debug, Clone)]
struct MemBlock {
    id: String,
    kind: String,
    text: String,
    attrs: Map<String, JsonValue>,
    /// 该块引用的目标 id 列表（ref_from 查询）
    refs_to: Vec<String>,
    /// heading level（paragraph = 0）
    level: u32,
}

/// 进程内文档
#[derive(Debug, Default)]
struct MemDoc {
    blocks: Vec<MemBlock>,
}

/// 进程内笔记后端（dev/test + 可注入 ToolContext）
///
/// - `query_blocks` / `document_outline`：内存过滤
/// - `apply_md_fragment`：极简 MD 按行插段落 / 识别 AT 标题；支持 intent 幂等
/// - batch token：内嵌 [`NoteBatchTokens`]
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

/// 极简 MD 行 → 块草案（kind, text, level）
fn parse_md_lines(markdown: &str) -> Vec<(String, String, u32)> {
    let mut out = Vec::new();
    for line in markdown.lines() {
        let trimmed = line.trim_end();
        if trimmed.trim().is_empty() {
            continue;
        }
        if let Some(level) = parse_atx_heading(trimmed) {
            let title = trimmed
                .trim_start_matches('#')
                .trim()
                .to_string();
            out.push(("heading".to_string(), title, level));
        } else {
            out.push(("paragraph".to_string(), trimmed.to_string(), 0));
        }
    }
    // 空 markdown → 不插块（合法 no-op 插入 0）
    out
}

fn parse_atx_heading(line: &str) -> Option<u32> {
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() && bytes[i] == b'#' {
        i += 1;
    }
    if i == 0 || i > 6 {
        return None;
    }
    // ATX 后须空白或行尾
    if i < bytes.len() && bytes[i] != b' ' && bytes[i] != b'\t' {
        return None;
    }
    Some(i as u32)
}

fn parse_heading_level_from_text(_text: &str) -> Option<u32> {
    // seed 时 level 由调用方 kind 决定；此处兜底 1
    Some(1)
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
        // (level, index_path into roots tree) — 用递归插入简化
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

// ==================== 工具辅助：错误 → JSON / ToolError ====================

/// 将后端错误映射为工具执行失败（写工具）；读工具更常返回 ok=false
pub fn backend_err_to_tool_err(
    tool_name: &str,
    err: NoteBackendError,
) -> crate::definition::ToolError {
    use crate::definition::ToolError;
    match &err {
        NoteBackendError::Invalid(m) | NoteBackendError::BatchTokenInvalid(m) => {
            ToolError::invalid_input(m.clone())
        }
        NoteBackendError::Unwired => ToolError::execution_failed(tool_name, err.message()),
        other => ToolError::execution_failed(tool_name, format!("{}: {}", other.code(), other.message())),
    }
}

/// 成功 apply 结果 → 工具 JSON
pub fn apply_result_json(result: &NoteApplyMdResult) -> JsonValue {
    serde_json::json!({
        "ok": true,
        "block_ids": result.block_ids,
        "inserted": result.inserted,
        "idempotent": result.idempotent,
    })
}

/// Arc 包装助手
pub type NoteBackendHandle = Arc<dyn NoteBackend>;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_query_and_apply_outline() {
        let backend = MemoryNoteBackend::new();
        backend.seed_doc(
            "doc-1",
            vec![
                ("h1".into(), "heading".into(), "Title".into()),
                ("p1".into(), "paragraph".into(), "hello world".into()),
            ],
        );

        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-1".into(),
                text_match: Some("hello".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks.len(), 1);
        assert_eq!(q.blocks[0].id, "p1");

        let applied = backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "doc-1".into(),
                markdown: "## Section\nbody line".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: Some("intent-1".into()),
                batch_id: None,
                message_id: None,
                origin: Some("agent".into()),
            })
            .await
            .unwrap();
        assert_eq!(applied.inserted, 2);
        assert!(!applied.idempotent);

        // 幂等
        let again = backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "doc-1".into(),
                markdown: "## Section\nbody line".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: Some("intent-1".into()),
                batch_id: None,
                message_id: None,
                origin: Some("agent".into()),
            })
            .await
            .unwrap();
        assert!(again.idempotent);
        assert_eq!(again.inserted, 0);
        assert_eq!(again.block_ids, applied.block_ids);

        let outline = backend.document_outline("doc-1", Some(6)).await.unwrap();
        assert!(
            outline.outline.iter().any(|n| n.title == "Title")
                || outline
                    .outline
                    .iter()
                    .any(|n| n.children.iter().any(|c| c.title == "Section")
                        || n.title == "Section"),
            "outline should contain headings: {:?}",
            outline
        );
    }

    #[test]
    fn batch_tokens_acquire_validate_release_expire() {
        let tokens = NoteBatchTokens::with_ttl(Duration::from_millis(50));
        assert!(tokens.validate("b1").is_err());
        tokens.acquire("b1").unwrap();
        tokens.validate("b1").unwrap();
        tokens.release("b1");
        assert!(matches!(
            tokens.validate("b1"),
            Err(NoteBackendError::BatchTokenInvalid(_))
        ));

        tokens.acquire("b2").unwrap();
        std::thread::sleep(Duration::from_millis(80));
        assert!(matches!(
            tokens.validate("b2"),
            Err(NoteBackendError::BatchTokenExpired(_))
        ));
    }

    #[tokio::test]
    async fn memory_apply_requires_valid_batch_when_provided() {
        let backend = MemoryNoteBackend::new();
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
    }
}
