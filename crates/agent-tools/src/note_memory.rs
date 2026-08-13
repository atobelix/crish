//! 进程内 [`MemoryNoteBackend`]（SD-01 纵向切开 · **SD-28** query/apply/batch）
//!
//! dev/test + 可注入 ToolContext；**≠** Store 真路径，**≠ EL-05**，**≠ W6-E**。
//! 写路径经 `apply_md_fragment` / `apply_block_ops`（plan → commit）。
//!
//! # SD-28 分模
//! - [`query`]：`query_blocks` / `document_outline` / `get_md` + 即时 S
//! - [`apply`]：`apply_md_fragment`（intent 幂等；仅此 MD 写入口）
//! - [`batch`]：`apply_block_ops`（W4-F；dryRun 零写；仅 `plan_block_ops`）
//!
//! # 诚实边界
//! - Memory 测绿 **禁关**生产 A-AGT / EL-05
//! - **≠** 宣称 Store 后端完成；**≠** 第二套写锥

#[path = "note_memory_query.rs"]
mod query;
#[path = "note_memory_apply.rs"]
mod apply;
#[path = "note_memory_batch.rs"]
mod batch;

use crate::note_backend::NoteBackend;
use crate::note_md_parse::parse_heading_level_from_text;
use crate::note_plan_ops::{MemBlock, MemDoc};
use crate::note_types::{
    NoteApplyMdRequest, NoteApplyMdResult, NoteBackendError, NoteBatchTokens,
    NoteBlockBatchRequest, NoteBlockBatchResult, NoteOutline, NoteQueryBlocksParams,
    NoteQueryBlocksResult,
};
use async_trait::async_trait;
use serde_json::{Map, Value as JsonValue};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// 毒丸恢复计数（B1-3 观测化：docs 锁中毒恢复次数；对齐 registry.rs
/// 「tracing::error! 成对 + 计数」样板，零新依赖；本文件 3 处 docs 锁共用）
static POISON_RECOVERIES: AtomicU64 = AtomicU64::new(0);

/// 毒丸恢复计数读取（毒化测断言用；S3 埋点消费面就绪后解除 cfg(test)）
#[cfg(test)]
pub(crate) fn poison_recovery_count() -> u64 {
    POISON_RECOVERIES.load(Ordering::Relaxed)
}

/// 进程内笔记后端（dev/test + 可注入 ToolContext）
///
/// - `query_blocks` / `document_outline` / `get_md`：内存过滤 / 即时序列化
/// - `apply_md_fragment`：极简 MD 按行插段落 / 识别 ATX 标题；支持 intent 幂等
/// - batch token：内嵌 [`NoteBatchTokens`]
///
/// # 诚实边界
/// - Memory 测绿 **禁关**生产 A-AGT / EL-05
/// - **≠** 宣称 Store 后端完成
/// - **SD-28** · **≠ EL-05** · **≠ W6-E**
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
        let mut docs = self.docs.lock().unwrap_or_else(|e| {
            // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-3 观测化）
            tracing::error!("MemoryNoteBackend docs 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
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
        let mut docs = self.docs.lock().unwrap_or_else(|e| {
            // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-3 观测化）
            tracing::error!("MemoryNoteBackend docs 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        if let Some(doc) = docs.get_mut(doc_id) {
            if let Some(b) = doc.blocks.iter_mut().find(|b| b.id == block_id) {
                b.attrs = attrs;
            }
        }
    }

    /// 为块设置引用目标（测试：ref 过滤）
    pub fn set_block_refs(&self, doc_id: &str, block_id: &str, refs_to: Vec<String>) {
        let mut docs = self.docs.lock().unwrap_or_else(|e| {
            // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-3 观测化）
            tracing::error!("MemoryNoteBackend docs 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
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

    fn ensure_doc<'a>(docs: &'a mut HashMap<String, MemDoc>, doc_id: &str) -> &'a mut MemDoc {
        docs.entry(doc_id.to_string()).or_default()
    }
}

#[async_trait]
impl NoteBackend for MemoryNoteBackend {
    async fn query_blocks(
        &self,
        params: NoteQueryBlocksParams,
    ) -> Result<NoteQueryBlocksResult, NoteBackendError> {
        self.run_query_blocks(params)
    }

    async fn document_outline(
        &self,
        doc_id: &str,
        max_depth: Option<u32>,
    ) -> Result<NoteOutline, NoteBackendError> {
        self.run_document_outline(doc_id, max_depth)
    }

    async fn get_md(&self, doc_id: &str) -> Result<String, NoteBackendError> {
        self.run_get_md(doc_id)
    }

    async fn apply_md_fragment(
        &self,
        req: NoteApplyMdRequest,
    ) -> Result<NoteApplyMdResult, NoteBackendError> {
        self.run_apply_md_fragment(req)
    }

    async fn validate_batch_token(&self, batch_id: Option<&str>) -> Result<(), NoteBackendError> {
        self.run_validate_batch_token(batch_id)
    }

    /// W4-F：块级批 ops；dryRun 零写；force_execution_unknown 中断不半写
    async fn apply_block_ops(
        &self,
        req: NoteBlockBatchRequest,
    ) -> Result<NoteBlockBatchResult, NoteBackendError> {
        self.run_apply_block_ops(req)
    }
}

/// 毒化测日志捕获（B1-3 观测化验收：LogCapture + with_capture 同形复制，
/// 对齐 `crates/session-loop/tests/observability.rs:15-61`；tracing-subscriber
/// 为 workspace 既有依赖，仅 dev 面启用）
#[cfg(test)]
pub(super) mod capture {
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    /// 捕获日志的内存缓冲（fmt writer 共享同一缓冲）
    #[derive(Default)]
    pub struct LogCapture {
        lines: Mutex<Vec<String>>,
    }

    impl LogCapture {
        fn push(&self, line: &str) {
            self.lines.lock().unwrap().push(line.to_string());
        }
        fn snapshot(&self) -> Vec<String> {
            self.lines.lock().unwrap().clone()
        }
    }

    /// fmt writer：Arc 包装共享缓冲
    struct ArcWriter(Arc<LogCapture>);

    impl Write for ArcWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            // fmt 会以行调用；按行切分逐行记录
            let text = String::from_utf8_lossy(buf);
            for line in text.lines() {
                self.0.push(line);
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// 在捕获 subscriber 下执行闭包，返回捕获行（毒化测仅断言 error 级）
    pub fn with_capture<F, R>(f: F) -> (R, Vec<String>)
    where
        F: FnOnce() -> R,
    {
        let capture = Arc::new(LogCapture::default());
        let writer = capture.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(move || ArcWriter(writer.clone()))
            .with_max_level(tracing::Level::ERROR)
            .with_ansi(false)
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        let result = f();
        let lines = capture.snapshot();
        (result, lines)
    }
}

#[cfg(test)]
mod tests {
    use super::capture::with_capture;
    use super::*;

    /// B1-3 毒化测：docs 锁中毒后 seed_doc 正常完成（不 panic）+ error
    /// 日志出现 + 毒丸恢复计数 +1（三要素）
    #[test]
    fn poisoned_docs_lock_seed_doc_recovers_with_log_and_count() {
        let backend = MemoryNoteBackend::new();
        let before = poison_recovery_count();
        crate::test_support::poison_std_lock(&backend.docs);
        let ((), lines) = with_capture(|| {
            // 毒化后写路径仍正常完成（恢复语义不变：不 panic、不传播）
            backend.seed_doc(
                "poison-doc",
                vec![("b1".into(), "paragraph".into(), "正文".into())],
            );
        });
        assert!(
            lines.iter().any(|l| l.contains("锁中毒")),
            "缺少锁中毒 error 日志，捕获：\n{}",
            lines.join("\n")
        );
        assert_eq!(
            poison_recovery_count(),
            before + 1,
            "docs 锁中毒恢复必须计数 +1"
        );
    }
}
