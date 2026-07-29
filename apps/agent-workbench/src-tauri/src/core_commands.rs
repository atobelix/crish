use conex_compaction::compaction::CompactionEngine;
use conex_diff::diff_engine::DiffEngine;
use conex_sandbox::gatekeeper::{CommandGatekeeper, GatekeeperResult};
use conex_search::fuzzy::FuzzyMatcher;
use conex_search::search::{search_files, search_files_parallel};
use conex_search::walker::build_directory_index;
use conex_types::{CompactionResult, CoreError, DiffResult, FileHit, Message};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};
use tauri::State;

const SEARCH_PARALLEL_THRESHOLD: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RustCoreStatus {
    pub search_index_ready: bool,
    pub db_ready: bool,
    pub compaction_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildSearchIndexResponse {
    pub file_count: usize,
}

/// Shared search state using Arc for zero-copy reads across commands.
pub struct SharedSearchState {
    pub files: RwLock<Arc<Vec<String>>>,
}

impl SharedSearchState {
    pub fn new() -> Self {
        Self {
            files: RwLock::new(Arc::new(Vec::new())),
        }
    }
}

impl Default for SharedSearchState {
    fn default() -> Self {
        Self::new()
    }
}

/// Shared gatekeeper state (compiled once, reused across commands).
pub struct SharedGatekeeper {
    pub gatekeeper: CommandGatekeeper,
}

impl SharedGatekeeper {
    pub fn new() -> Self {
        Self {
            gatekeeper: CommandGatekeeper::new(),
        }
    }
}

impl Default for SharedGatekeeper {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub async fn core_search_files(
    query: String,
    limit: Option<usize>,
    state: State<'_, SharedSearchState>,
) -> Result<Vec<FileHit>, String> {
    // Arc clone is cheap (reference count increment, no data copy)
    let files = state
        .files
        .read()
        .map_err(|e| format!("search index lock: {e}"))?
        .clone();
    let limit = limit.unwrap_or(20);
    let hits = tokio::task::spawn_blocking(move || {
        let matcher = FuzzyMatcher::new(false);
        if files.len() >= SEARCH_PARALLEL_THRESHOLD {
            search_files_parallel(&query, &files, limit, &matcher)
        } else {
            search_files(&query, &files, limit, &matcher)
        }
    })
    .await
    .map_err(|e| format!("search task failed: {e}"))?;
    Ok(hits)
}

#[tauri::command]
pub async fn core_rebuild_search_index(
    root: String,
    state: State<'_, SharedSearchState>,
) -> Result<RebuildSearchIndexResponse, String> {
    let root = root.trim().to_string();
    if root.is_empty() {
        return Err("root path is empty".to_string());
    }
    let built = tokio::task::spawn_blocking(move || build_directory_index(&root))
        .await
        .map_err(|e| format!("rebuild task failed: {e}"))?;
    let count = built.len();
    // Swap the Arc atomically — readers holding the old Arc are unaffected
    *state
        .files
        .write()
        .map_err(|e| format!("search index lock: {e}"))? = Arc::new(built);
    Ok(RebuildSearchIndexResponse { file_count: count })
}

#[tauri::command]
pub async fn core_compact_messages(
    messages: Vec<Message>,
    max_tokens: usize,
) -> Result<CompactionResult, String> {
    let result = tokio::task::spawn_blocking(move || {
        let engine = CompactionEngine::new(max_tokens);
        engine.compact(&messages)
    })
    .await
    .map_err(|e| format!("compact task failed: {e}"))?;
    Ok(result)
}

#[tauri::command]
pub async fn core_count_tokens(text: String) -> Result<usize, String> {
    let count = tokio::task::spawn_blocking(move || conex_compaction::count_tokens(&text))
        .await
        .map_err(|e| format!("token count task failed: {e}"))?;
    Ok(count)
}

#[tauri::command]
pub async fn core_check_command(
    cmd: String,
    args: Vec<String>,
    gatekeeper_state: State<'_, SharedGatekeeper>,
) -> Result<GatekeeperResult, String> {
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let result = gatekeeper_state.gatekeeper.check_command(&cmd, &args_ref);
    Ok(result)
}

#[tauri::command]
pub async fn core_compute_diff(
    old_text: String,
    new_text: String,
) -> Result<DiffResult, String> {
    let result = tokio::task::spawn_blocking(move || DiffEngine::diff(&old_text, &new_text))
        .await
        .map_err(|e| format!("diff task failed: {e}"))?;
    Ok(result)
}

#[tauri::command]
pub async fn core_get_status(
    state: State<'_, SharedSearchState>,
    db_state: State<'_, crate::session_commands::SharedDb>,
) -> Result<RustCoreStatus, String> {
    let count = state.files.read().map(|g| g.len()).unwrap_or(0);
    Ok(RustCoreStatus {
        search_index_ready: count > 0,
        db_ready: db_state.db_ready(),
        compaction_ready: true,
    })
}

// ===== Stream E: Worker 池下沉 + 错误协议统一 =====
//
// 6 个 `core_*` 命令复用 perf 模块的实现,把 `Result<T, String>` 转为
// `Result<T, CoreError>`,统一错误协议。perf_* 别名保留兼容,新代码应优先用 core_*。
//
// 3 个新命令(`core_messages_to_jsonl` / `core_jsonl_to_messages` / `core_text_encode`)
// 用 serde_json 实现,CPU 密集走 spawn_blocking。
//
// 所有命令的失败统一为 CoreError,JS 侧可按 error.kind 分类处理:
//   - InvalidInput: 参数校验失败
//   - Encoding: 编解码失败(base64 / 文本编码)
//   - Internal: 内部错误(spawn_blocking join 失败 / 序列化失败)

/// 把 perf 模块的 `Result<T, String>` 转换为 `Result<T, CoreError>`。
///
/// String 错误统一映射为 `CoreError::Internal`(perf 模块返回的字符串已是用户可读消息,
/// 不再细分 InvalidInput/Encoding,避免误归类)。
fn map_perf_err(e: String) -> CoreError {
    CoreError::Internal(e)
}

/// 计算 SHA-256 哈希,返回小写 hex 字符串。
///
/// 复用 `perf::hash::perf_hash_compute`,错误统一为 CoreError。
#[tauri::command]
pub async fn core_hash_compute(
    data: Vec<u8>,
    algorithm: Option<String>,
) -> Result<String, CoreError> {
    let result = tokio::task::spawn_blocking(move || {
        crate::perf::hash::perf_hash_compute(data, algorithm)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("core_hash_compute join: {e}")))?
    .map_err(map_perf_err)?;
    Ok(result)
}

/// Base64 编码 bytes → 字符串。
///
/// 复用 `perf::hash::perf_base64_encode`。
#[tauri::command]
pub async fn core_base64_encode(
    data: Vec<u8>,
    config: Option<String>,
) -> Result<String, CoreError> {
    let result = tokio::task::spawn_blocking(move || {
        crate::perf::hash::perf_base64_encode(data, config)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("core_base64_encode join: {e}")))?
    .map_err(map_perf_err)?;
    Ok(result)
}

/// Base64 解码字符串 → bytes。
///
/// 复用 `perf::hash::perf_base64_decode`。
#[tauri::command]
pub async fn core_base64_decode(
    encoded: String,
    config: Option<String>,
) -> Result<Vec<u8>, CoreError> {
    let result = tokio::task::spawn_blocking(move || {
        crate::perf::hash::perf_base64_decode(encoded, config)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("core_base64_decode join: {e}")))?
    .map_err(map_perf_err)?;
    Ok(result)
}

/// 检测 bytes 的编码(BOM + chardetng 统计推断)。
///
/// 复用 `perf::encoding::perf_encoding_detect`,返回 `{ encoding, confidence, hasBom }`。
#[tauri::command]
pub async fn core_detect_encoding(
    data: Vec<u8>,
) -> Result<crate::perf::encoding::EncodingDetectResult, CoreError> {
    let result = tokio::task::spawn_blocking(move || {
        crate::perf::encoding::perf_encoding_detect(data)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("core_detect_encoding join: {e}")))?
    .map_err(map_perf_err)?;
    Ok(result)
}

/// 把 bytes 解码为 UTF-8 字符串。
///
/// 复用 `perf::encoding::perf_encoding_decode`,无效字节替换为 U+FFFD。
#[tauri::command]
pub async fn core_decode_text(
    data: Vec<u8>,
    encoding: Option<String>,
) -> Result<String, CoreError> {
    let result = tokio::task::spawn_blocking(move || {
        crate::perf::encoding::perf_encoding_decode(data, encoding)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("core_decode_text join: {e}")))?
    .map_err(map_perf_err)?;
    Ok(result)
}

/// 解析 unified diff 文本为结构化结果。
///
/// 复用 `perf::diff::perf_diff_parse`,返回 `{ files, truncated }`。
/// 输出 shape 对齐 Rust 标准(perf::diff::DiffResult),JS 侧需相应对齐。
#[tauri::command]
pub async fn core_parse_diff(
    unified_diff: String,
    max_lines: Option<u32>,
) -> Result<crate::perf::diff::DiffResult, CoreError> {
    let result = tokio::task::spawn_blocking(move || {
        crate::perf::diff::perf_diff_parse(unified_diff, max_lines)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("core_parse_diff join: {e}")))?
    .map_err(map_perf_err)?;
    Ok(result)
}

/// 把消息数组序列化为 JSONL 字符串(每行一个 JSON 对象)。
///
/// 替代 io-worker 的 `messages.to-jsonl` case。CPU 密集(大量消息时)走 spawn_blocking。
#[tauri::command]
pub async fn core_messages_to_jsonl(
    messages: Vec<serde_json::Value>,
) -> Result<String, CoreError> {
    let result = tokio::task::spawn_blocking(move || -> Result<String, CoreError> {
        let mut buf = String::with_capacity(messages.len() * 256);
        for msg in &messages {
            let line = serde_json::to_string(msg)
                .map_err(|e| CoreError::Internal(format!("serialize message: {e}")))?;
            buf.push_str(&line);
            buf.push('\n');
        }
        // 移除末尾多余换行(与 JS messages.map(m => JSON.stringify(m)).join('\n') 等价)
        if buf.ends_with('\n') {
            buf.pop();
        }
        Ok(buf)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("core_messages_to_jsonl join: {e}")))?;
    result
}

/// 把 JSONL 文本解析为消息数组。
///
/// 兼容 JSON 数组格式(`[...]`)与 JSONL 格式(每行一个 JSON 对象)。
/// 跳过空行与非法行(与 io-worker `jsonl.to-messages` 行为一致)。
#[tauri::command]
pub async fn core_jsonl_to_messages(
    text: String,
) -> Result<Vec<serde_json::Value>, CoreError> {
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<serde_json::Value>, CoreError> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        // 优先尝试 JSON 数组(历史格式)
        if trimmed.starts_with('[') {
            let parsed: Vec<serde_json::Value> = serde_json::from_str(trimmed)
                .map_err(|e| CoreError::Internal(format!("parse JSON array: {e}")))?;
            return Ok(parsed);
        }
        // JSONL 路径:逐行解析,跳过空行与非法行。
        // `str::lines` 自动处理 `\r\n` 与 `\n` 两种行尾。
        let mut out: Vec<serde_json::Value> = Vec::new();
        for line in trimmed.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<serde_json::Value>(line) {
                Ok(v) => out.push(v),
                Err(_) => continue,
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("core_jsonl_to_messages join: {e}")))?;
    result
}

/// 把 UTF-8 字符串编码为目标编码的 bytes。
///
/// - `encoding = None`(默认): 用 TextEncoder 等价的 UTF-8 编码
/// - `encoding = Some(label)`: 用 encoding_rs 编码到指定字符集(如 "gb18030" / "shift_jis")
///
/// 替代 io-worker 的 `text.encode` case(原 case 忽略 encoding 参数,是 bug)。
#[tauri::command]
pub async fn core_text_encode(
    text: String,
    encoding: Option<String>,
) -> Result<Vec<u8>, CoreError> {
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, CoreError> {
        match encoding {
            None => Ok(text.into_bytes()),
            Some(label) => {
                let enc = encoding_rs::Encoding::for_label(label.as_bytes())
                    .ok_or_else(|| CoreError::Encoding(format!("unsupported encoding: {label}")))?;
                let (cow, _, _) = enc.encode(&text);
                Ok(cow.into_owned())
            }
        }
    })
    .await
    .map_err(|e| CoreError::Internal(format!("core_text_encode join: {e}")))?;
    result
}

#[cfg(test)]
mod stream_e_tests {
    use super::*;

    #[test]
    fn map_perf_err_preserves_message() {
        let err = map_perf_err("base64 decode failed: invalid byte".to_string());
        match err {
            CoreError::Internal(msg) => assert!(msg.contains("base64")),
            other => panic!("expected Internal, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn core_hash_compute_matches_perf() {
        let data = b"hello".to_vec();
        let core = core_hash_compute(data.clone(), None).await.unwrap();
        let perf = crate::perf::hash::perf_hash_compute(data, None).unwrap();
        assert_eq!(core, perf);
        assert_eq!(
            core,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[tokio::test]
    async fn core_base64_roundtrip() {
        let data = b"hello world".to_vec();
        let encoded = core_base64_encode(data.clone(), None).await.unwrap();
        assert_eq!(encoded, "aGVsbG8gd29ybGQ=");
        let decoded = core_base64_decode(encoded, None).await.unwrap();
        assert_eq!(decoded, data);
    }

    #[tokio::test]
    async fn core_base64_decode_invalid_returns_error() {
        let result = core_base64_decode("!!!invalid!!!".to_string(), None).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            CoreError::Internal(_) => {}
            other => panic!("expected Internal, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn core_detect_encoding_utf8_bom() {
        let data = b"\xEF\xBB\xBFhello".to_vec();
        let result = core_detect_encoding(data).await.unwrap();
        assert_eq!(result.encoding, "UTF-8");
        assert!(result.has_bom);
    }

    #[tokio::test]
    async fn core_decode_text_auto_detect() {
        let data = b"hello world".to_vec();
        let result = core_decode_text(data, None).await.unwrap();
        assert_eq!(result, "hello world");
    }

    #[tokio::test]
    async fn core_decode_text_unsupported_encoding() {
        let data = b"hello".to_vec();
        let result = core_decode_text(data, Some("nonexistent-encoding".to_string())).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn core_parse_diff_simple() {
        let input = "\
diff --git a/src/main.rs b/src/main.rs
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,4 @@
 fn main() {
-    println!(\"hello\");
+    println!(\"hello world\");
 }
";
        let result = core_parse_diff(input.to_string(), None).await.unwrap();
        assert!(!result.files.is_empty());
        assert_eq!(result.files[0].old_path, "src/main.rs");
    }

    #[tokio::test]
    async fn core_messages_to_jsonl_roundtrip() {
        let messages = vec![
            serde_json::json!({ "id": "m1", "text": "hello" }),
            serde_json::json!({ "id": "m2", "text": "world" }),
        ];
        let jsonl = core_messages_to_jsonl(messages.clone()).await.unwrap();
        assert!(jsonl.contains('\n'));
        assert_eq!(jsonl.lines().count(), 2);

        let parsed = core_jsonl_to_messages(jsonl).await.unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["id"], "m1");
        assert_eq!(parsed[1]["text"], "world");
    }

    #[tokio::test]
    async fn core_messages_to_jsonl_empty() {
        let jsonl = core_messages_to_jsonl(vec![]).await.unwrap();
        assert_eq!(jsonl, "");
    }

    #[tokio::test]
    async fn core_jsonl_to_messages_accepts_json_array() {
        let json_array = r#"[{"id":"m1"},{"id":"m2"}]"#;
        let parsed = core_jsonl_to_messages(json_array.to_string()).await.unwrap();
        assert_eq!(parsed.len(), 2);
    }

    #[tokio::test]
    async fn core_jsonl_to_messages_skips_bad_lines() {
        let jsonl = "{\"a\":1}\nnot-json\n{\"b\":2}\n";
        let parsed = core_jsonl_to_messages(jsonl.to_string()).await.unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["a"], 1);
        assert_eq!(parsed[1]["b"], 2);
    }

    #[tokio::test]
    async fn core_jsonl_to_messages_empty() {
        let parsed = core_jsonl_to_messages("".to_string()).await.unwrap();
        assert!(parsed.is_empty());

        let parsed = core_jsonl_to_messages("   \n  \n".to_string()).await.unwrap();
        assert!(parsed.is_empty());
    }

    #[tokio::test]
    async fn core_text_encode_utf8_default() {
        let bytes = core_text_encode("hello".to_string(), None).await.unwrap();
        assert_eq!(bytes, b"hello");
    }

    #[tokio::test]
    async fn core_text_encode_unsupported_returns_encoding_error() {
        let result = core_text_encode("hello".to_string(), Some("nonexistent".to_string())).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            CoreError::Encoding(_) => {}
            other => panic!("expected Encoding, got {other:?}"),
        }
    }
}
