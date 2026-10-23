//! search_context 工具（T-40，00-plan §7.1 / 01 分析 §2.3）
//!
//! 语义：**只搜「已压缩块」（compression_blocks 会话作用域），不搜上下文
//! 可见消息**——模型看得见的就不浪费工具调用（对齐 billion-context-pi
//! search_context）。命中返回块索引条目（blockId / summary 片段 /
//! dropped 数 / generation / height）+ 恢复指引（decompress_context）。
//!
//! 会话作用域决策（T-40 裁决）：`ToolContext.session_id` 即当前会话标识，
//! 工具以它为缺省会话域；显式 `sessionId` 入参**必须与当前会话一致**，
//! 否则拒绝（tool.invalid_input）——只读工具进子 agent 只读集，跨会话
//! 检索会泄露他会话敏感信息（评审 02 N5），由工具面 fail-closed 兜底；
//! 查询后端（CompressionContextStore 实现）按 session_id 绑定会话域。
//!
//! 存储注入：`ctx.compression_store: Option<Arc<dyn CompressionContextStore>>`
//! （None = 未接线，返回 common.unsupported 结构化错误——引擎侧轮次 6
//! 注入 conex-db 实现）。排序契约：命中按 generation 降序（稳定排序，
//! 同代保持后端序）。limit 钳制 1..=100。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::{optional_string, optional_u64, require_string};
use async_trait::async_trait;
use conex_types::error::codes;

// 契约与 Arc 仅在测试/注入面直接引用（lib 面经 ctx 字段类型消费）
#[cfg(test)]
use crate::compression_store::CompressionContextStore;
#[cfg(test)]
use std::sync::Arc;

/// 缺省返回条数上限
const DEFAULT_LIMIT: usize = 20;
/// limit 上限（对齐 fuzzy_find 的 100 钳制惯例，防滥用）
const MAX_LIMIT: usize = 100;
/// summary 片段截断长度（char 边界）
const SUMMARY_FRAGMENT_CHARS: usize = 200;

/// search_context 工具（dangerous=false，只读，进子 agent 只读集）
pub(crate) struct SearchContextTool {
    def: ToolDefinition,
}

impl SearchContextTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "search_context".to_string(),
                description: "在已压缩上下文块中检索（只搜 compression_blocks 已压缩历史，不搜上下文可见消息；会话作用域限定当前会话）。命中返回块索引条目（blockId / summary 片段 / dropped 数 / generation / height）+ 恢复指引 decompress_context。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "检索关键词（匹配块摘要全文）" },
                        "limit": { "type": "number", "description": "返回条数上限，默认 20，上限 100" },
                        "sessionId": { "type": "string", "description": "会话作用域，缺省当前会话；显式指定必须与当前会话一致，否则拒绝" }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for SearchContextTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError> {
        let query = require_string(&args, "query")?;
        let limit = (optional_u64(&args, "limit").unwrap_or(DEFAULT_LIMIT as u64) as usize)
            .clamp(1, MAX_LIMIT);
        // 会话作用域：缺省当前会话；显式指定必须一致（跨会话 fail-closed）
        let session = optional_string(&args, "sessionId").unwrap_or_else(|| ctx.session_id.clone());
        if session != ctx.session_id {
            return Err(ToolError::invalid_input(format!(
                "sessionId 作用域校验失败：当前会话 {session_id:?}，请求 {session:?}（只读工具不允许跨会话检索）",
                session_id = ctx.session_id
            )));
        }
        let Some(store) = &ctx.compression_store else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "compression store 未注入：压缩块检索服务未装配（引擎侧注入 CompressionContextStore 后可用）",
            ));
        };
        let mut hits = store
            .search_blocks(&session, &query, limit)
            .map_err(|e| ToolError::execution_failed("search_context", e))?;
        // 排序契约：generation 降序（稳定，同代保持后端序）
        hits.sort_by_key(|a| std::cmp::Reverse(a.generation));
        let truncated = hits.len() >= limit;

        let items: Vec<serde_json::Value> = hits
            .iter()
            .map(|h| {
                serde_json::json!({
                    "blockId": h.block_id,
                    "generation": h.generation,
                    "height": h.height,
                    "summary": h.summary,
                    "droppedCount": h.dropped_count,
                    "state": h.state,
                })
            })
            .collect();
        let text = if hits.is_empty() {
            format!("query: {query}\nsessionId: {session}\nlimit: {limit}\nhits: 0\n\n(no hits：压缩块中无匹配，可尝试 decompress_context 按 blockId 取回)").to_string()
        } else {
            let mut lines = vec![
                format!("query: {query}"),
                format!("sessionId: {session}"),
                format!("limit: {limit}"),
                format!("hits: {}", hits.len()),
                if truncated {
                    "truncated: true（已达上限，可缩小范围或增加 limit）".to_string()
                } else {
                    String::new()
                },
                String::new(),
            ];
            for h in &hits {
                let frag: String = h.summary.chars().take(SUMMARY_FRAGMENT_CHARS).collect();
                let frag = if h.summary.chars().count() > SUMMARY_FRAGMENT_CHARS {
                    format!("{frag}…")
                } else {
                    frag
                };
                lines.push(h.block_id.clone());
                lines.push(format!(
                    "  generation: {}, height: {}, dropped: {}, state: {}",
                    h.generation, h.height, h.dropped_count, h.state
                ));
                lines.push(format!("  {frag}"));
                lines.push(format!(
                    "  恢复: decompress_context(blockId=\"{}\")",
                    h.block_id
                ));
                lines.push(String::new());
            }
            lines.join("\n")
        };

        Ok(serde_json::json!({
            "query": query,
            "sessionId": session,
            "limit": limit,
            "hits": items,
            "truncated": truncated,
            "text": text,
        }))
    }
}

/// 构造注入压缩存储的测试用上下文（无 store 时为 None）
#[cfg(test)]
pub(crate) fn ctx_with_store(
    ws: &conex_test_utils::TempWorkspace,
    store: Option<Arc<dyn CompressionContextStore>>,
) -> ToolContext {
    ToolContext {
        workspace_root: ws.path().clone(),
        compression_store: store,
        ..crate::context::create_mock_tool_context()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compression_store::{BlockContent, BlockHit};
    use conex_test_utils::TempWorkspace;
    use serde_json::json;

    /// 假 store（测试域：命中/未命中/错误三态可控，行为确定性）
    #[derive(Debug)]
    struct FakeCompressionStore {
        blocks: Vec<(String, String)>,
        fail_search: bool,
        fail_decompress: bool,
    }

    impl FakeCompressionStore {
        fn new(blocks: Vec<(String, String)>) -> Self {
            Self {
                blocks,
                fail_search: false,
                fail_decompress: false,
            }
        }
    }

    impl CompressionContextStore for FakeCompressionStore {
        fn search_blocks(
            &self,
            _session_id: &str,
            query: &str,
            limit: usize,
        ) -> Result<Vec<BlockHit>, String> {
            if self.fail_search {
                return Err("search backend down".to_string());
            }
            Ok(self
                .blocks
                .iter()
                .filter(|(_, text)| text.contains(query))
                .map(|(id, _)| BlockHit {
                    block_id: id.clone(),
                    generation: 1,
                    height: 1,
                    summary: format!("摘要[{id}]"),
                    dropped_count: 3,
                    state: "committed".to_string(),
                })
                .take(limit)
                .collect())
        }

        fn decompress_block(
            &self,
            _session_id: &str,
            block_id: &str,
        ) -> Result<Option<BlockContent>, String> {
            if self.fail_decompress {
                return Err("decompress backend down".to_string());
            }
            Ok(self
                .blocks
                .iter()
                .find(|(id, _)| id == block_id)
                .map(|(id, text)| BlockContent {
                    block_id: id.clone(),
                    text: text.clone(),
                }))
        }
    }

    #[tokio::test]
    async fn search_hits_with_recovery_guidance() {
        let ws = TempWorkspace::new("sctx_hit");
        let store: Arc<dyn CompressionContextStore> = Arc::new(FakeCompressionStore::new(vec![
            ("cb-1-1".to_string(), "fizz 内容".to_string()),
            ("cb-2-1".to_string(), "buzz 内容".to_string()),
        ]));
        let tool = SearchContextTool::new();
        let out = tool
            .execute(
                &ctx_with_store(&ws, Some(store)),
                json!({ "query": "fizz" }),
            )
            .await
            .unwrap();
        let hits = out["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["blockId"], "cb-1-1");
        assert_eq!(hits[0]["droppedCount"], 3);
        assert_eq!(hits[0]["state"], "committed");
        let text = out["text"].as_str().unwrap();
        assert!(
            text.contains("decompress_context(blockId=\"cb-1-1\")"),
            "恢复指引: {text}"
        );
        assert!(text.contains("generation: 1"));
    }

    #[tokio::test]
    async fn search_sorted_by_generation_desc() {
        let ws = TempWorkspace::new("sctx_sort");
        struct GenStore(Vec<(String, u32, String)>);
        impl std::fmt::Debug for GenStore {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "GenStore")
            }
        }
        impl CompressionContextStore for GenStore {
            fn search_blocks(
                &self,
                _session_id: &str,
                _query: &str,
                limit: usize,
            ) -> Result<Vec<BlockHit>, String> {
                // 后端按倒序返回（generation 升序），工具侧须稳定排成降序
                Ok(self
                    .0
                    .iter()
                    .map(|(id, gen, _)| BlockHit {
                        block_id: id.clone(),
                        generation: *gen,
                        height: 1,
                        summary: String::new(),
                        dropped_count: 0,
                        state: "committed".to_string(),
                    })
                    .take(limit)
                    .collect())
            }
            fn decompress_block(
                &self,
                _session_id: &str,
                _block_id: &str,
            ) -> Result<Option<BlockContent>, String> {
                Ok(None)
            }
        }
        let store: Arc<dyn CompressionContextStore> = Arc::new(GenStore(vec![
            ("cb-1".to_string(), 1, String::new()),
            ("cb-3".to_string(), 3, String::new()),
            ("cb-2".to_string(), 2, String::new()),
        ]));
        let tool = SearchContextTool::new();
        let out = tool
            .execute(&ctx_with_store(&ws, Some(store)), json!({ "query": "x" }))
            .await
            .unwrap();
        let ids: Vec<&str> = out["hits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h["blockId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["cb-3", "cb-2", "cb-1"], "generation 降序");
    }

    #[tokio::test]
    async fn search_no_hits_empty_result() {
        let ws = TempWorkspace::new("sctx_miss");
        let store: Arc<dyn CompressionContextStore> = Arc::new(FakeCompressionStore::new(vec![(
            "cb-1".to_string(),
            "x".to_string(),
        )]));
        let tool = SearchContextTool::new();
        let out = tool
            .execute(&ctx_with_store(&ws, Some(store)), json!({ "query": "zzz" }))
            .await
            .unwrap();
        assert_eq!(out["hits"].as_array().unwrap().len(), 0);
        assert_eq!(out["truncated"], false);
        assert!(out["text"].as_str().unwrap().contains("no hits"));
    }

    #[tokio::test]
    async fn search_limit_capped_at_max() {
        let ws = TempWorkspace::new("sctx_limit");
        let blocks: Vec<(String, String)> = (0..150)
            .map(|i| (format!("cb-{i}"), format!("needle-{i}")))
            .collect();
        let store: Arc<dyn CompressionContextStore> = Arc::new(FakeCompressionStore::new(blocks));
        let tool = SearchContextTool::new();
        // limit=1000 钳制到 100（Fake 后端 take(limit)，钳制生效则恒 ≤100）
        let out = tool
            .execute(
                &ctx_with_store(&ws, Some(store)),
                json!({ "query": "needle", "limit": 1000 }),
            )
            .await
            .unwrap();
        assert_eq!(out["hits"].as_array().unwrap().len(), 100);
        assert_eq!(out["truncated"], true);
    }

    #[tokio::test]
    async fn search_store_missing_returns_unsupported() {
        let ws = TempWorkspace::new("sctx_nostore");
        let tool = SearchContextTool::new();
        let err = tool
            .execute(&ctx_with_store(&ws, None), json!({ "query": "x" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "common.unsupported");
        assert!(err.to_string().contains("compression store 未注入"));
    }

    #[tokio::test]
    async fn search_store_error_propagated() {
        let ws = TempWorkspace::new("sctx_err");
        let mut store = FakeCompressionStore::new(vec![("cb-1".to_string(), "x".to_string())]);
        store.fail_search = true;
        let store: Arc<dyn CompressionContextStore> = Arc::new(store);
        let tool = SearchContextTool::new();
        let err = tool
            .execute(&ctx_with_store(&ws, Some(store)), json!({ "query": "x" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.execution_failed");
        assert!(err.to_string().contains("search backend down"));
    }

    #[tokio::test]
    async fn search_missing_query_invalid_input() {
        let ws = TempWorkspace::new("sctx_query");
        let tool = SearchContextTool::new();
        let err = tool
            .execute(&ctx_with_store(&ws, None), json!({}))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
    }

    #[tokio::test]
    async fn search_cross_session_rejected() {
        let ws = TempWorkspace::new("sctx_session");
        let store: Arc<dyn CompressionContextStore> = Arc::new(FakeCompressionStore::new(vec![]));
        let tool = SearchContextTool::new();
        let err = tool
            .execute(
                &ctx_with_store(&ws, Some(store)),
                json!({ "query": "x", "sessionId": "other-session" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        assert!(err.to_string().contains("作用域校验失败"));
    }

    #[tokio::test]
    async fn search_default_session_is_current() {
        let ws = TempWorkspace::new("sctx_cur");
        let store: Arc<dyn CompressionContextStore> = Arc::new(FakeCompressionStore::new(vec![(
            "cb-1".to_string(),
            "x".to_string(),
        )]));
        let tool = SearchContextTool::new();
        // mock 会话 id 固定 "mock-session"；显式传当前会话 → 放行
        let out = tool
            .execute(
                &ctx_with_store(&ws, Some(store)),
                json!({ "query": "x", "sessionId": "mock-session" }),
            )
            .await
            .unwrap();
        assert_eq!(out["sessionId"], "mock-session");
    }

    #[test]
    fn tool_is_readonly_registered() {
        let tool = SearchContextTool::new();
        assert!(!tool.definition().dangerous, "只读工具 dangerous=false");
        assert!(!tool.definition().fatal_on_error);
    }
}
