//! decompress_context 工具（T-41，00-plan §7.2 / 01 分析 §2.3）
//!
//! 语义：**读操作**——按 block_id 从 compression_blocks（+事件流原文回放）
//! 提取被压缩消息的原文，**不替换对话、不动上下文前缀**（缓存前缀稳定，
//! I1 兼容）。返回原文 = **原始字节**（不经 clean 清洗管线），工具描述
//! 写明，防模型认知差（P2-6 / 评审 02 N6）。
//!
//! 会话作用域决策（T-41 裁决）：decompress 的会话域**恒为当前会话**
//! （ctx.session_id），不设 sessionId 入参面——按块精确取回 + 会话绑定
//! 由注入的 store 实现侧执行，工具面 fail-closed 最简，无跨会话泄露面。
//!
//! 落文件决策（V1，安全面优先，P1-6 落地）：
//! - `inline: true` → 恒经工具结果通道返回文本（不经落盘）；
//! - `inline: false` 且满足「output_dir 已注入 **且** 主 agent 身份
//!   （write_claim_holder 为 None——子代理 run 会注入 run id）」→ 落文件
//!   （`<产出目录>/<blockId 净化>.txt`，完整原文），返回路径；
//! - 其余情况（无 output_dir / 子代理上下文）→ **回退 inline**（安全面
//!   优先，写文件权只在主 agent + 产出目录面存在）。
//!
//! `full` 语义：inline 返回时 true = 完整原文、false = 预览（前 200 行 +
//! 提示）；落文件恒写完整原文（文件体积无碍）。
//!
//! 存储注入：`ctx.compression_store`（None = common.unsupported；引擎侧
//! 轮次 6 注入）。审计面（P2-7）走既有 audit/middleware 面，本工具不
//! 特殊处理。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::output_dir::{sanitize_session_id, OutputDirResolver};
use crate::tools::{optional_bool, require_string};
use async_trait::async_trait;
use conex_types::error::codes;

/// inline 预览行数上限（full=false 时）
const PREVIEW_MAX_LINES: usize = 200;

/// decompress_context 工具（dangerous=false，只读，进子 agent 只读集；
/// 落文件路径仅主 agent + output_dir 注入面可用）
pub(crate) struct DecompressContextTool {
    def: ToolDefinition,
}

impl DecompressContextTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "decompress_context".to_string(),
                description: "按 blockId 取回被压缩上下文消息的原文（只读回放，不替换对话、不动前缀）。返回**原始字节**（不经清洗管线，可能与 wire 面清洗后的文本不同）。inline=true 经文本通道返回（默认预览，full=true 完整）；inline=false 且主 agent + 产出目录可用时落文件返回路径，否则回退 inline。会话作用域恒为当前会话。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "blockId": { "type": "string", "description": "压缩块 id（压缩时生成的块引用 / search_context 命中返回）" },
                        "inline": { "type": "boolean", "description": "true = 经文本通道返回（缺省 false；无产出目录或子代理上下文时自动回退 inline）" },
                        "full": { "type": "boolean", "description": "inline 返回时 true = 完整原文，false = 前 200 行预览（缺省 false）" }
                    },
                    "required": ["blockId"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

/// inline 预览：前 `max_lines` 行 + 截断提示（full=false 时）
fn preview_text(text: &str, max_lines: usize) -> (String, bool) {
    let total = text.lines().count();
    if total <= max_lines {
        return (text.to_string(), false);
    }
    let head: Vec<&str> = text.lines().take(max_lines).collect();
    (
        format!(
            "{}\n… (共 {total} 行，使用 full=true 获取完整原文)",
            head.join("\n")
        ),
        true,
    )
}

#[async_trait]
impl Tool for DecompressContextTool {
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
        let block_id = require_string(&args, "blockId")?;
        let inline = optional_bool(&args, "inline").unwrap_or(false);
        let full = optional_bool(&args, "full").unwrap_or(false);
        let Some(store) = &ctx.compression_store else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "compression store 未注入：压缩块原文服务未装配（引擎侧注入 CompressionContextStore 后可用）",
            ));
        };
        let content = store
            .decompress_block(&ctx.session_id, &block_id)
            .map_err(|e| ToolError::execution_failed("decompress_context", e))?
            .ok_or_else(|| {
                ToolError::new(
                    codes::TOOL_NOT_FOUND,
                    format!("block not found: {block_id}（当前会话压缩块中无此 id）"),
                )
            })?;

        // 落文件资格：仅主 agent（write_claim_holder=None）+ output_dir 注入
        let can_write_file = !inline
            && ctx.write_claim_holder.is_none()
            && ctx.output_dir.is_some();

        if can_write_file {
            // 落文件：完整原文（不经 clean），返回路径
            let resolver: &dyn OutputDirResolver = ctx
                .output_dir
                .as_deref()
                .expect("can_write_file 已保证注入");
            let resolved = resolver.resolve(&ctx.session_id, None);
            let dir = resolved.dir.dir.clone();
            std::fs::create_dir_all(&dir).map_err(|e| {
                ToolError::execution_failed("decompress_context", format!("创建产出目录失败: {e}"))
            })?;
            let file_name = format!("{}.txt", sanitize_session_id(&block_id));
            let file_path = dir.join(file_name);
            std::fs::write(&file_path, content.text.as_bytes()).map_err(|e| {
                ToolError::execution_failed("decompress_context", format!("写文件失败: {e}"))
            })?;
            let byte_count = content.text.len();
            let note = "原文已落文件（原始字节，不经 clean 清洗管线）；取回后如需精确片段可 inline=true + full=true";
            return Ok(serde_json::json!({
                "blockId": content.block_id,
                "inline": false,
                "full": true,
                "path": file_path.to_string_lossy(),
                "byteCount": byte_count,
                "note": note,
                "text": format!("{note}\npath: {}\nbyteCount: {byte_count}", file_path.to_string_lossy()),
            }));
        }

        // inline 返回（显式 inline / 无产出目录 / 子代理上下文回退）
        let (text, truncated) = if full {
            (content.text.clone(), false)
        } else {
            preview_text(&content.text, PREVIEW_MAX_LINES)
        };
        let note = if inline {
            "inline 原文返回（原始字节，不经 clean）"
        } else {
            "无产出目录或子代理只读上下文：回退 inline 返回（安全面优先，落文件仅主 agent + output_dir 注入面）"
        };
        Ok(serde_json::json!({
            "blockId": content.block_id,
            "inline": true,
            "full": full,
            "byteCount": content.text.len(),
            "truncated": truncated,
            "note": note,
            "text": text,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compression_store::{BlockContent, CompressionContextStore, BlockHit};
    use crate::context::{create_mock_tool_context, ToolContext};
    use crate::tools::output_dir::{AgentOutputDir, OutputDirResolver, ResolveOutputDirResult};
    use conex_test_utils::TempWorkspace;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::Arc;

    /// 假 store（命中 / 未命中 / 错误三态可控）
    #[derive(Debug)]
    struct FakeCompressionStore {
        blocks: Vec<(String, String)>,
        fail_decompress: bool,
    }

    impl FakeCompressionStore {
        fn new(blocks: Vec<(String, String)>) -> Self {
            Self {
                blocks,
                fail_decompress: false,
            }
        }
    }

    impl CompressionContextStore for FakeCompressionStore {
        fn search_blocks(
            &self,
            _session_id: &str,
            _query: &str,
            _limit: usize,
        ) -> Result<Vec<BlockHit>, String> {
            Ok(vec![])
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

    /// 假产出目录解析器（指向临时目录，惰性：不创建）
    #[derive(Debug)]
    struct FakeOutputDirResolver {
        dir: PathBuf,
    }

    impl OutputDirResolver for FakeOutputDirResolver {
        fn resolve(
            &self,
            _session_id: &str,
            _folder: Option<&str>,
        ) -> ResolveOutputDirResult {
            ResolveOutputDirResult {
                dir: AgentOutputDir {
                    session_id: "mock-session".to_string(),
                    root: self.dir.clone(),
                    dir: self.dir.clone(),
                    user_specified: false,
                },
                first_resolve: false,
                dir_created: false,
            }
        }
    }

    fn ctx_with_store(
        ws: &TempWorkspace,
        store: Option<Arc<dyn CompressionContextStore>>,
        output_dir: Option<Arc<dyn OutputDirResolver>>,
        write_claim_holder: Option<String>,
    ) -> ToolContext {
        ToolContext {
            workspace_root: ws.path().clone(),
            compression_store: store,
            output_dir,
            write_claim_holder,
            ..create_mock_tool_context()
        }
    }

    #[tokio::test]
    async fn inline_returns_raw_text() {
        let ws = TempWorkspace::new("dctx_inline");
        let store: Arc<dyn CompressionContextStore> = Arc::new(FakeCompressionStore::new(vec![(
            "cb-1-1".to_string(),
            "原始原文内容\n第二行\n".to_string(),
        )]));
        let tool = DecompressContextTool::new();
        let out = tool
            .execute(
                &ctx_with_store(&ws, Some(store), None, None),
                json!({ "blockId": "cb-1-1", "inline": true }),
            )
            .await
            .unwrap();
        assert_eq!(out["blockId"], "cb-1-1");
        assert_eq!(out["inline"], true);
        assert!(out["text"].as_str().unwrap().contains("原始原文内容"));
        assert_eq!(out["truncated"], false);
        assert_eq!(out["byteCount"], "原始原文内容\n第二行\n".len());
    }

    #[tokio::test]
    async fn inline_default_falls_back_without_output_dir() {
        let ws = TempWorkspace::new("dctx_fallback");
        let store: Arc<dyn CompressionContextStore> = Arc::new(FakeCompressionStore::new(vec![(
            "cb-1".to_string(),
            "content".to_string(),
        )]));
        let tool = DecompressContextTool::new();
        // inline 缺省 false，但无 output_dir → 回退 inline（安全面优先）
        let out = tool
            .execute(
                &ctx_with_store(&ws, Some(store), None, None),
                json!({ "blockId": "cb-1" }),
            )
            .await
            .unwrap();
        assert_eq!(out["inline"], true, "无产出目录应回退 inline");
        assert!(out["note"].as_str().unwrap().contains("回退 inline"));
        assert!(out["text"].as_str().unwrap().contains("content"));
    }

    #[tokio::test]
    async fn subagent_never_writes_file_even_with_output_dir() {
        let ws = TempWorkspace::new("dctx_subagent");
        let store: Arc<dyn CompressionContextStore> = Arc::new(FakeCompressionStore::new(vec![(
            "cb-1".to_string(),
            "subagent sees this".to_string(),
        )]));
        let out_dir = ws.path().join("outputs");
        let resolver: Arc<dyn OutputDirResolver> = Arc::new(FakeOutputDirResolver { dir: out_dir.clone() });
        let tool = DecompressContextTool::new();
        // 子代理上下文（write_claim_holder 注入 run id）→ 即使 output_dir
        // 可用也不落文件（P1-6：子代理只读集无写文件权）
        let ctx = ctx_with_store(
            &ws,
            Some(store),
            Some(resolver),
            Some("sub-run-1".to_string()),
        );
        let out = tool.execute(&ctx, json!({ "blockId": "cb-1" })).await.unwrap();
        assert_eq!(out["inline"], true, "子代理必须回退 inline");
        assert!(!out_dir.exists(), "子代理不得写文件");
    }

    #[tokio::test]
    async fn main_agent_writes_file_when_output_dir_injected() {
        let ws = TempWorkspace::new("dctx_file");
        let store: Arc<dyn CompressionContextStore> = Arc::new(FakeCompressionStore::new(vec![(
            "cb-2-1".to_string(),
            "完整原文 A\n完整原文 B\n".to_string(),
        )]));
        let out_dir = ws.path().join("outputs");
        let resolver: Arc<dyn OutputDirResolver> =
            Arc::new(FakeOutputDirResolver { dir: out_dir.clone() });
        let tool = DecompressContextTool::new();
        let out = tool
            .execute(
                &ctx_with_store(&ws, Some(store), Some(resolver), None),
                json!({ "blockId": "cb-2-1" }),
            )
            .await
            .unwrap();
        assert_eq!(out["inline"], false, "主 agent + output_dir 应落文件");
        let path = PathBuf::from(out["path"].as_str().unwrap());
        assert!(path.exists(), "文件应已写入: {}", path.display());
        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written, "完整原文 A\n完整原文 B\n", "落文件=完整原文");
        // 文件名 = 净化后的 blockId
        assert_eq!(path.file_name().unwrap().to_string_lossy(), "cb-2-1.txt");
        assert_eq!(out["byteCount"], written.len());
    }

    #[tokio::test]
    async fn inline_true_wins_over_file_path() {
        let ws = TempWorkspace::new("dctx_inline_wins");
        let store: Arc<dyn CompressionContextStore> = Arc::new(FakeCompressionStore::new(vec![(
            "cb-1".to_string(),
            "inline content".to_string(),
        )]));
        let out_dir = ws.path().join("outputs");
        let resolver: Arc<dyn OutputDirResolver> =
            Arc::new(FakeOutputDirResolver { dir: out_dir.clone() });
        let tool = DecompressContextTool::new();
        // 主 agent + output_dir 均可用，但 inline=true 显式强制 inline
        let out = tool
            .execute(
                &ctx_with_store(&ws, Some(store), Some(resolver), None),
                json!({ "blockId": "cb-1", "inline": true }),
            )
            .await
            .unwrap();
        assert_eq!(out["inline"], true);
        assert!(!out_dir.exists(), "inline=true 不落盘");
    }

    #[tokio::test]
    async fn preview_truncated_without_full() {
        let ws = TempWorkspace::new("dctx_preview");
        let long = (0..250).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let store: Arc<dyn CompressionContextStore> =
            Arc::new(FakeCompressionStore::new(vec![("cb-1".to_string(), long.clone())]));
        let tool = DecompressContextTool::new();
        // inline + full=false → 预览（前 200 行 + 提示）
        let out = tool
            .execute(
                &ctx_with_store(&ws, Some(store), None, None),
                json!({ "blockId": "cb-1", "inline": true }),
            )
            .await
            .unwrap();
        assert_eq!(out["truncated"], true);
        let text = out["text"].as_str().unwrap();
        assert!(text.contains("使用 full=true 获取完整原文"));
        assert!(text.contains("line 199"));
        assert!(!text.contains("line 249"), "预览应截断");
        // full=true → 完整原文
        let out2 = tool
            .execute(
                &ctx_with_store(&ws, None, None, None),
                json!({ "blockId": "cb-1", "inline": true, "full": true }),
            )
            .await
            .unwrap_err();
        // store 未注入 → 未接线错误优先（full 语义在注入面后生效）
        assert_eq!(out2.code(), "common.unsupported");
    }

    #[tokio::test]
    async fn block_not_found_errors() {
        let ws = TempWorkspace::new("dctx_notfound");
        let store: Arc<dyn CompressionContextStore> =
            Arc::new(FakeCompressionStore::new(vec![]));
        let tool = DecompressContextTool::new();
        let err = tool
            .execute(
                &ctx_with_store(&ws, Some(store), None, None),
                json!({ "blockId": "ghost" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.not_found");
        assert!(err.to_string().contains("ghost"));
    }

    #[tokio::test]
    async fn store_missing_returns_unsupported() {
        let ws = TempWorkspace::new("dctx_nostore");
        let tool = DecompressContextTool::new();
        let err = tool
            .execute(
                &ctx_with_store(&ws, None, None, None),
                json!({ "blockId": "cb-1" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "common.unsupported");
        assert!(err.to_string().contains("compression store 未注入"));
    }

    #[tokio::test]
    async fn store_error_propagated() {
        let ws = TempWorkspace::new("dctx_err");
        let mut store = FakeCompressionStore::new(vec![("cb-1".to_string(), "x".to_string())]);
        store.fail_decompress = true;
        let store: Arc<dyn CompressionContextStore> = Arc::new(store);
        let tool = DecompressContextTool::new();
        let err = tool
            .execute(
                &ctx_with_store(&ws, Some(store), None, None),
                json!({ "blockId": "cb-1" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.execution_failed");
        assert!(err.to_string().contains("decompress backend down"));
    }

    #[tokio::test]
    async fn missing_block_id_invalid_input() {
        let ws = TempWorkspace::new("dctx_arg");
        let tool = DecompressContextTool::new();
        let err = tool
            .execute(&ctx_with_store(&ws, None, None, None), json!({}))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
    }

    #[test]
    fn tool_is_readonly_registered() {
        let tool = DecompressContextTool::new();
        assert!(!tool.definition().dangerous, "只读工具 dangerous=false");
        assert!(!tool.definition().fatal_on_error);
    }
}
