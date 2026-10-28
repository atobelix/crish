//! 核心工具命令（旧 6 命令 + Worker 组下沉 + JSONL 追加）与共享 State。
//!
//! 本文件是 Tauri 壳的命令面实现之一，职责边界（PE-03 T03.3 错误协议统一后）：
//! - 旧 6 命令（E1 工具组）：`core_search_files` / `core_rebuild_search_index` /
//!   `core_compact_messages` / `core_count_tokens` / `core_check_command` /
//!   `core_compute_diff`——错误统一为 `CoreError {kind, detail}`（`crate::core_error`）；
//! - Worker 组下沉（Stream E）：`core_hash_compute` / `core_base64_*` /
//!   `core_detect_encoding` / `core_decode_text` / `core_parse_diff` /
//!   `core_messages_to_jsonl` / `core_jsonl_to_messages` / `core_text_encode`——
//!   复用 `perf` 模块实现，CPU 密集走 `spawn_blocking`；
//! - 共享 State：`SharedSearchState`（搜索索引 Arc 交换）、`SharedGatekeeper`
//!   （命令闸门编译一次复用）、`SharedCompactionState`（PE-01 T01.2 压缩能力接线标记，
//!   供 `core_get_status.compactionReady` 读取，未接线如实 false）；
//! - `check_command_verdict`：把闸门检查结果包装为结构化裁决（{allowed,
//!   requiresApproval, blocked, reason}），供 run 循环 / sidecar 复用。

use conex_compaction::compaction::CompactionEngine;
use conex_diff::diff_engine::DiffEngine;
use conex_sandbox::gatekeeper::{CommandGatekeeper, GatekeeperResult};
use conex_search::fuzzy::FuzzyMatcher;
use conex_search::search::{search_files, search_files_parallel};
use conex_search::walker::build_directory_index;
use conex_types::{CompactionResult, DiffResult, FileHit, Message};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use tauri::State;

use crate::fs_commands::types::path_is_same_or_child;
use crate::workspace::WorkspaceRegistry;
use conex_run::core_error::CoreError;

/// 并行搜索阈值（文件数 ≥ 该值走并行实现）。
const SEARCH_PARALLEL_THRESHOLD: usize = 1000;
/// 搜索查询最大长度（S-15/S-16 参数上限，防超长查询拖垮模糊匹配）。
const SEARCH_QUERY_MAX_LEN: usize = 1024;
/// 搜索索引重建根路径最大长度。
const SEARCH_ROOT_MAX_LEN: usize = 4096;

/// 重建搜索索引响应（serde camelCase → `{ fileCount }`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildSearchIndexResponse {
    pub file_count: usize,
}

// ===== 共享 State（main.rs manage 接线）=====

/// 共享搜索状态：Arc 交换实现零拷贝读（读方持有旧 Arc 不受重建影响）。
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

/// 共享命令闸门状态（U-GATE：包装进程级 SHARED_GATEKEEPER，不再 per-call new()）。
pub struct SharedGatekeeper {
    pub gatekeeper: &'static conex_sandbox::gatekeeper::CommandGatekeeper,
}

impl SharedGatekeeper {
    pub fn new() -> Self {
        Self {
            gatekeeper: &conex_sandbox::gatekeeper::SHARED_GATEKEEPER,
        }
    }
}

impl Default for SharedGatekeeper {
    fn default() -> Self {
        Self::new()
    }
}

/// 压缩能力接线标记（PE-01 T01.2：未接线 = false，不硬编码 true）。
///
/// main.rs 在把压缩能力（conex-compaction 纯内存）接线时 `set_ready(true)`；
/// `core_get_status` 经 `State<SharedCompactionState>` 读取 `compactionReady`。
pub struct SharedCompactionState {
    ready: AtomicBool,
}

impl SharedCompactionState {
    /// 新建（默认未接线）。
    pub fn new() -> Self {
        Self {
            ready: AtomicBool::new(false),
        }
    }

    /// 标记压缩能力接线状态。
    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::Relaxed);
    }

    /// 当前压缩能力是否已接线。
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Relaxed)
    }
}

impl Default for SharedCompactionState {
    fn default() -> Self {
        Self::new()
    }
}

// ===== 旧 6 命令（E1 工具组，错误协议 CoreError）=====

/// 模糊搜索文件索引（query + limit；索引为空返回空列表，不报错）。
///
/// 托管形态：`State<'_, Arc<SharedSearchState>>`（main.rs manage Arc——
/// C21 接线：本地服务后端经 Arc clone 共享同一实例，索引重建立即可见）。
#[tauri::command]
pub async fn core_search_files(
    query: String,
    limit: Option<usize>,
    state: State<'_, Arc<SharedSearchState>>,
) -> Result<Vec<FileHit>, CoreError> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err(CoreError::InvalidInput(
            "query must not be empty".to_string(),
        ));
    }
    if query.len() > SEARCH_QUERY_MAX_LEN {
        return Err(CoreError::InvalidInput(format!(
            "query too long (max {SEARCH_QUERY_MAX_LEN})"
        )));
    }
    // Arc clone 廉价（引用计数 +1，零数据拷贝），读锁短持有后即释放
    let files = state
        .files
        .read()
        .map_err(|e| CoreError::Internal(format!("search index lock: {e}")))?
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
    .map_err(|e| CoreError::Internal(format!("search task failed: {e}")))?;
    Ok(hits)
}

/// 重建常驻搜索索引（gitignored 遍历；完成后原子交换 Arc）。
///
/// F4 F5-03 修复：`root` 必须 ∈ WorkspaceRegistry 已授权根子树（canonicalize
/// 后与全部已授权根前缀包含匹配，越界拒绝）——与 `list_directory` 沙箱语义
/// 一致，防任意目录建索引（全盘文件名枚举信息泄漏 + spawn_blocking 长时间
/// 占线程）。校验失败 → `CoreError::InvalidInput`（detail 含 workspace_not_granted）。
///
/// `R: tauri::Runtime` 泛型：测试注入 MockRuntime 可直接调用（tauri 2 官方
/// 支持命令参数泛型化），生产走 Wry。
#[tauri::command]
pub async fn core_rebuild_search_index<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    root: Option<String>,
    state: State<'_, Arc<SharedSearchState>>,
) -> Result<RebuildSearchIndexResponse, CoreError> {
    // 沙箱校验（仿 git.rs resolve_git_cwd 模式）：canonicalize + is_dir + 已授权根子树；缺省自动回退授权根
    let canonical_root = resolve_index_root(&app, root.as_deref())?;
    let built = tokio::task::spawn_blocking(move || build_directory_index(&canonical_root))
        .await
        .map_err(|e| CoreError::Internal(format!("rebuild task failed: {e}")))?;
    let count = built.len();
    // 原子交换 Arc：持旧 Arc 的读者不受影响
    *state
        .files
        .write()
        .map_err(|e| CoreError::Internal(format!("search index lock: {e}")))? = Arc::new(built);
    Ok(RebuildSearchIndexResponse { file_count: count })
}

/// 索引 root 沙箱校验：canonicalize 后必须 ∈ WorkspaceRegistry 已授权根子树。
/// 缺省或空值时回退至首个已授权活动工作区根。
fn resolve_index_root<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    root: Option<&str>,
) -> Result<String, CoreError> {
    use tauri::Manager as _;
    let reg = app.try_state::<WorkspaceRegistry>().ok_or_else(|| {
        CoreError::Internal(
            "WorkspaceRegistry is not managed; main.rs setup must call app.manage(WorkspaceRegistry::init()...)"
                .to_string(),
        )
    })?;
    let roots = reg.roots();

    let target_root = match root {
        Some(r) => {
            let trimmed = r.trim();
            if trimmed.is_empty() {
                if let Some(active) = reg.active_root().or_else(|| roots.first().cloned()) {
                    active.to_string_lossy().into_owned()
                } else {
                    return Err(CoreError::InvalidInput(
                        "root path is empty and no workspace roots registered".to_string(),
                    ));
                }
            } else {
                if trimmed.len() > SEARCH_ROOT_MAX_LEN {
                    return Err(CoreError::InvalidInput(format!(
                        "root path too long (max {SEARCH_ROOT_MAX_LEN})"
                    )));
                }
                trimmed.to_string()
            }
        }
        None => {
            if let Some(active) = reg.active_root().or_else(|| roots.first().cloned()) {
                active.to_string_lossy().into_owned()
            } else {
                return Err(CoreError::InvalidInput(
                    "root path is empty and no workspace roots registered".to_string(),
                ));
            }
        }
    };

    let path = Path::new(&target_root);
    let canonical = path.canonicalize().map_err(|e| {
        CoreError::InvalidInput(format!(
            "workspace_not_granted: cannot resolve root `{target_root}`: {e}"
        ))
    })?;
    if !canonical.is_dir() {
        return Err(CoreError::InvalidInput(format!(
            "workspace_not_granted: root is not a directory: `{target_root}`"
        )));
    }
    if roots
        .iter()
        .any(|authorized| path_is_same_or_child(&canonical, authorized))
    {
        return Ok(canonical.to_string_lossy().into_owned());
    }
    Err(CoreError::InvalidInput(format!(
        "workspace_not_granted: root is outside the authorized workspace root: `{target_root}`"
    )))
}

/// 上下文压缩（maxTokens 消息数组 → 压缩结果）。
#[tauri::command]
pub async fn core_compact_messages(
    messages: Vec<Message>,
    max_tokens: usize,
) -> Result<CompactionResult, CoreError> {
    if max_tokens == 0 {
        return Err(CoreError::InvalidInput(
            "max_tokens must be greater than 0".to_string(),
        ));
    }
    let result = tokio::task::spawn_blocking(move || {
        let engine = CompactionEngine::new(max_tokens);
        engine.compact(&messages)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("compact task failed: {e}")))?;
    Ok(result)
}

/// 文本 token 估算。
#[tauri::command]
pub async fn core_count_tokens(text: String) -> Result<usize, CoreError> {
    let count = tokio::task::spawn_blocking(move || conex_compaction::count_tokens(&text))
        .await
        .map_err(|e| CoreError::Internal(format!("token count task failed: {e}")))?;
    Ok(count)
}

/// 命令闸门检查（Allowed / Blocked / RequiresApproval，serde camelCase）。
#[tauri::command]
pub async fn core_check_command(
    cmd: String,
    args: Vec<String>,
    gatekeeper_state: State<'_, SharedGatekeeper>,
) -> Result<GatekeeperResult, CoreError> {
    if cmd.trim().is_empty() {
        return Err(CoreError::InvalidInput("cmd must not be empty".to_string()));
    }
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let result = gatekeeper_state.gatekeeper.check_command(&cmd, &args_ref);
    Ok(result)
}

/// 计算两个文本的 diff（DiffResult：hunks / addedLines / removedLines）。
#[tauri::command]
pub async fn core_compute_diff(
    old_text: String,
    new_text: String,
) -> Result<DiffResult, CoreError> {
    let result = tokio::task::spawn_blocking(move || DiffEngine::diff(&old_text, &new_text))
        .await
        .map_err(|e| CoreError::Internal(format!("diff task failed: {e}")))?;
    Ok(result)
}

// ===== 命令闸门结构化裁决 =====

/// 命令检查裁决（结构化包装 `GatekeeperResult`，供 run 循环 / sidecar 复用）。
///
/// 与 `core_check_command`（返回 GatekeeperResult 字符串字面量，对齐前端
/// `rustCore.ts` 的 GatekeeperResult 类型）并存：本结构为内部决策面
/// （允许/需审批/拦截 + 人读原因），不直接走 IPC。
///
/// G11a 备注：run 循环 / sidecar 接线未落地，当前仅测试覆盖
/// （check_command_verdict_maps_all_results）——非 test 构建 dead_code 静音。
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandVerdict {
    pub allowed: bool,
    pub requires_approval: bool,
    pub blocked: bool,
    /// 人读原因（allowed 时 None）
    pub reason: Option<&'static str>,
}

/// 检查一条命令并产出结构化裁决。
#[cfg_attr(not(test), allow(dead_code))]
pub fn check_command_verdict(
    gatekeeper: &CommandGatekeeper,
    cmd: &str,
    args: &[&str],
) -> CommandVerdict {
    match gatekeeper.check_command(cmd, args) {
        GatekeeperResult::Allowed => CommandVerdict {
            allowed: true,
            requires_approval: false,
            blocked: false,
            reason: None,
        },
        GatekeeperResult::RequiresApproval => CommandVerdict {
            allowed: false,
            requires_approval: true,
            blocked: false,
            reason: Some("requires approval"),
        },
        GatekeeperResult::Blocked => CommandVerdict {
            allowed: false,
            requires_approval: false,
            blocked: true,
            reason: Some("blocked by safety red-line gatekeeper"),
        },
    }
}

// ===== Stream E：Worker 池下沉 + JSONL 追加 =====
//
// 6 个 `core_*` 命令复用 perf 模块实现，错误统一为 CoreError；perf_* 别名保留兼容。
// 3 个新命令（core_messages_to_jsonl / core_jsonl_to_messages / core_text_encode）
// 用 serde_json / encoding_rs 实现，CPU 密集走 spawn_blocking。
//
// 失败统一为 CoreError，JS 侧按 error.kind 分类：
//   - InvalidInput: 参数校验失败
//   - Encoding: 编解码失败（base64 / 文本编码）
//   - Io: JSONL 追加的存储/IO 失败
//   - Internal: 内部错误（spawn_blocking join 失败 / 序列化失败）

/// 计算 SHA-256 哈希，返回小写 hex 字符串（复用 perf::hash）。
#[tauri::command]
pub async fn core_hash_compute(
    data: Vec<u8>,
    algorithm: Option<String>,
) -> Result<String, CoreError> {
    let result =
        tokio::task::spawn_blocking(move || crate::perf::hash::perf_hash_compute(data, algorithm))
            .await
            .map_err(|e| CoreError::Internal(format!("core_hash_compute join: {e}")))??;
    Ok(result)
}

/// Base64 编码 bytes → 字符串（复用 perf::hash）。
#[tauri::command]
pub async fn core_base64_encode(
    data: Vec<u8>,
    config: Option<String>,
) -> Result<String, CoreError> {
    let result =
        tokio::task::spawn_blocking(move || crate::perf::hash::perf_base64_encode(data, config))
            .await
            .map_err(|e| CoreError::Internal(format!("core_base64_encode join: {e}")))??;
    Ok(result)
}

/// Base64 解码字符串 → bytes（复用 perf::hash）。
#[tauri::command]
pub async fn core_base64_decode(
    encoded: String,
    config: Option<String>,
) -> Result<Vec<u8>, CoreError> {
    let result =
        tokio::task::spawn_blocking(move || crate::perf::hash::perf_base64_decode(encoded, config))
            .await
            .map_err(|e| CoreError::Internal(format!("core_base64_decode join: {e}")))??;
    Ok(result)
}

/// 检测 bytes 编码（BOM + chardetng 统计推断；复用 perf::encoding）。
#[tauri::command]
pub async fn core_detect_encoding(
    data: Vec<u8>,
) -> Result<crate::perf::encoding::EncodingDetectResult, CoreError> {
    let result =
        tokio::task::spawn_blocking(move || crate::perf::encoding::perf_encoding_detect(data))
            .await
            .map_err(|e| CoreError::Internal(format!("core_detect_encoding join: {e}")))??;
    Ok(result)
}

/// 把 bytes 解码为 UTF-8 字符串（无效字节替换为 U+FFFD；复用 perf::encoding）。
#[tauri::command]
pub async fn core_decode_text(
    data: Vec<u8>,
    encoding: Option<String>,
) -> Result<String, CoreError> {
    let result = tokio::task::spawn_blocking(move || {
        crate::perf::encoding::perf_encoding_decode(data, encoding)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("core_decode_text join: {e}")))??;
    Ok(result)
}

/// 解析 unified diff 文本为结构化结果（复用 perf::diff）。
#[tauri::command]
pub async fn core_parse_diff(
    unified_diff: String,
    max_lines: Option<u32>,
) -> Result<crate::perf::diff::DiffResult, CoreError> {
    let result = tokio::task::spawn_blocking(move || {
        crate::perf::diff::perf_diff_parse(unified_diff, max_lines)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("core_parse_diff join: {e}")))??;
    Ok(result)
}

/// 消息数组 → JSONL 字符串（每行一个 JSON 对象；替代 io-worker messages.to-jsonl）。
#[tauri::command]
pub async fn core_messages_to_jsonl(messages: Vec<serde_json::Value>) -> Result<String, CoreError> {
    let result = tokio::task::spawn_blocking(move || -> Result<String, CoreError> {
        let mut buf = String::with_capacity(messages.len() * 256);
        for msg in &messages {
            let line = serde_json::to_string(msg)
                .map_err(|e| CoreError::Internal(format!("serialize message: {e}")))?;
            buf.push_str(&line);
            buf.push('\n');
        }
        // 移除末尾多余换行（与 JS messages.map(m => JSON.stringify(m)).join('\n') 等价）
        if buf.ends_with('\n') {
            buf.pop();
        }
        Ok(buf)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("core_messages_to_jsonl join: {e}")))?;
    result
}

/// JSONL 文本 → 消息数组（兼容 JSON 数组格式；跳过空行与非法行）。
#[tauri::command]
pub async fn core_jsonl_to_messages(text: String) -> Result<Vec<serde_json::Value>, CoreError> {
    let result =
        tokio::task::spawn_blocking(move || -> Result<Vec<serde_json::Value>, CoreError> {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Ok(Vec::new());
            }
            // 优先尝试 JSON 数组（历史格式）
            if trimmed.starts_with('[') {
                let parsed: Vec<serde_json::Value> = serde_json::from_str(trimmed)
                    .map_err(|e| CoreError::Internal(format!("parse JSON array: {e}")))?;
                return Ok(parsed);
            }
            // JSONL 路径：逐行解析，跳过空行与非法行（str::lines 兼容 \r\n / \n）
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

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // 测试临时目录清理，非产品物理删除路径
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::workspace::{RegisterSource, WorkspaceRegistry};

    /// 临时目录基座（测试后自动清理；G2 禁令豁免同 workspace.rs 测试惯例）。
    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let base = std::env::temp_dir();
            for attempt in 0..100 {
                let nanos = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("system time before UNIX_EPOCH")
                    .as_nanos();
                let path = base.join(format!(
                    "conex-search-index-{}-{nanos}-{attempt}",
                    std::process::id()
                ));
                if fs::create_dir(&path).is_ok() {
                    return Self { path };
                }
            }
            panic!("failed to create temporary test directory");
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    /// 构造 mock app：托管 SharedSearchState（Arc 形态，对齐 main.rs ⑤）+
    /// 仅授权 auth_root 的注册表。
    fn mock_app_with_registry(
        state: Arc<SharedSearchState>,
        reg: WorkspaceRegistry,
    ) -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .manage(reg)
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app")
    }

    /// 注册表：config_dir 注入临时目录 + Dialog 授权 auth_root（其余目录均未授权）。
    fn registry_authorizing(temp: &TestDir, auth_root: &Path) -> WorkspaceRegistry {
        let config_dir = temp.path().join("config");
        fs::create_dir_all(&config_dir).expect("create config dir");
        let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
        reg.register(auth_root, RegisterSource::Dialog)
            .expect("dialog register auth_root");
        reg
    }

    #[test]
    fn shared_compaction_state_defaults_false() {
        let state = SharedCompactionState::new();
        assert!(!state.is_ready(), "未接线压缩 = false（诚实化）");
        state.set_ready(true);
        assert!(state.is_ready());
    }

    #[test]
    fn check_command_verdict_maps_all_results() {
        let gatekeeper = CommandGatekeeper::new();
        let blocked = check_command_verdict(&gatekeeper, "rm", &["-rf", "/"]);
        assert!(blocked.blocked && !blocked.allowed && !blocked.requires_approval);
        assert_eq!(
            blocked.reason,
            Some("blocked by safety red-line gatekeeper")
        );

        let approval = check_command_verdict(&gatekeeper, "git", &["push", "--force"]);
        assert!(
            approval.requires_approval && !approval.allowed && !approval.blocked,
            "git push --force 应需审批"
        );

        let allowed = check_command_verdict(&gatekeeper, "git", &["status"]);
        assert!(allowed.allowed && !allowed.requires_approval && !allowed.blocked);
        assert!(allowed.reason.is_none());
    }

    #[test]
    fn search_validation_rejects_empty_query() {
        use tauri::Manager as _;
        let state = Arc::new(SharedSearchState::new());
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state = app.state::<Arc<SharedSearchState>>();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let result = core_search_files("   ".to_string(), None, state).await;
            assert!(matches!(result, Err(CoreError::InvalidInput(_))));
        });
    }

    /// T4.4-R1（红 → 绿）：root 不在任何已授权根子树 → 拒绝
    /// `InvalidInput`（detail 含 workspace_not_granted 文案），且索引不重建。
    #[test]
    fn rebuild_search_index_rejects_unapproved_root() {
        use tauri::Manager as _;
        let temp = TestDir::new();
        let auth_root = temp.path().join("auth");
        let outside_root = temp.path().join("outside");
        fs::create_dir_all(&auth_root).expect("create auth root");
        fs::write(auth_root.join("a.txt"), "x").expect("write a");
        fs::create_dir_all(&outside_root).expect("create outside root");
        fs::write(outside_root.join("b.txt"), "y").expect("write b");

        let state = Arc::new(SharedSearchState::new());
        let app = mock_app_with_registry(state, registry_authorizing(&temp, &auth_root));
        let state = app.state::<Arc<SharedSearchState>>();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let result = core_rebuild_search_index(
                app.handle().clone(),
                Some(outside_root.to_string_lossy().into_owned()),
                state.clone(),
            )
            .await;
            match result {
                Err(CoreError::InvalidInput(detail)) => {
                    assert!(
                        detail.contains("workspace_not_granted"),
                        "detail 应含 workspace_not_granted 文案：{detail}"
                    );
                }
                other => panic!("未授权 root 应被拒绝（workspace_not_granted），实际 {other:?}"),
            }
            // 索引不得被重建（保持初始空状态）
            assert!(
                state.files.read().expect("index lock").is_empty(),
                "越界 root 不得重建索引"
            );
        });
    }

    /// T4.4-R2（放行）：root = 授权根（含 1 个文件）→ Ok 且 file_count ≥ 1。
    #[test]
    fn rebuild_search_index_allows_authorized_root() {
        use tauri::Manager as _;
        let temp = TestDir::new();
        let auth_root = temp.path().join("auth");
        let sub = auth_root.join("sub");
        fs::create_dir_all(&sub).expect("create sub");
        fs::write(auth_root.join("a.txt"), "x").expect("write a");
        fs::write(sub.join("b.txt"), "y").expect("write b");

        let state = Arc::new(SharedSearchState::new());
        let app = mock_app_with_registry(state, registry_authorizing(&temp, &auth_root));
        let state = app.state::<Arc<SharedSearchState>>();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let result = core_rebuild_search_index(
                app.handle().clone(),
                Some(auth_root.to_string_lossy().into_owned()),
                state,
            )
            .await;
            let resp = result.expect("授权根应允许建索引");
            assert!(resp.file_count >= 1, "file_count: {}", resp.file_count);
        });
    }

    /// T4.4-R2b（默认回退）：root = None 时自动回退至已授权工作区根构建索引。
    #[test]
    fn rebuild_search_index_defaults_to_registered_workspace_root() {
        use tauri::Manager as _;
        let temp = TestDir::new();
        let auth_root = temp.path().join("auth");
        fs::create_dir_all(&auth_root).expect("create auth root");
        fs::write(auth_root.join("file.txt"), "hello").expect("write file");

        let state = Arc::new(SharedSearchState::new());
        let app = mock_app_with_registry(state, registry_authorizing(&temp, &auth_root));
        let state = app.state::<Arc<SharedSearchState>>();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let result = core_rebuild_search_index(app.handle().clone(), None, state).await;
            let resp = result.expect("缺省 root 时应自动回退到已授权根");
            assert_eq!(resp.file_count, 1);
        });
    }

    /// T4.4-R3（回归契约）：超长 root 仍拒绝（既有长度校验保持）。
    #[test]
    fn rebuild_search_index_rejects_empty_or_oversized_root() {
        use tauri::Manager as _;
        let temp = TestDir::new();
        let auth_root = temp.path().join("auth");
        fs::create_dir_all(&auth_root).expect("create auth root");

        let state = Arc::new(SharedSearchState::new());
        let app = mock_app_with_registry(state, registry_authorizing(&temp, &auth_root));
        let state = app.state::<Arc<SharedSearchState>>();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let oversized = "x".repeat(SEARCH_ROOT_MAX_LEN + 1);
            let result =
                core_rebuild_search_index(app.handle().clone(), Some(oversized), state).await;
            assert!(matches!(result, Err(CoreError::InvalidInput(_))));
        });
    }

    #[test]
    fn compact_rejects_zero_budget() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let result = core_compact_messages(Vec::new(), 0).await;
            assert!(matches!(result, Err(CoreError::InvalidInput(_))));
        });
    }

    #[test]
    fn check_command_rejects_empty_cmd() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            use tauri::Manager as _;
            let state = SharedGatekeeper::new();
            let app = tauri::test::mock_builder()
                .manage(state)
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .expect("mock app");
            let state = app.state::<SharedGatekeeper>();
            let result = core_check_command("  ".to_string(), Vec::new(), state).await;
            assert!(matches!(result, Err(CoreError::InvalidInput(_))));
        });
    }

    // ── Stream E 回归（对齐旧测试断言）──
    // 注：原 map_perf_err 桥接测试随桥接删除而移除——String→CoreError 映射
    // 已下沉至 perf 模块（kind 语义由 perf::hash / perf::encoding 单测守护）。

    #[test]
    fn core_hash_compute_matches_perf() {
        let data = b"hello".to_vec();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let hash = runtime
            .block_on(core_hash_compute(data.clone(), None))
            .unwrap();
        let perf = crate::perf::hash::perf_hash_compute(data, None).unwrap();
        assert_eq!(hash, perf);
        assert_eq!(
            hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn core_base64_roundtrip() {
        let data = b"hello world".to_vec();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let encoded = runtime
            .block_on(core_base64_encode(data.clone(), None))
            .unwrap();
        assert_eq!(encoded, "aGVsbG8gd29ybGQ=");
        let decoded = runtime.block_on(core_base64_decode(encoded, None)).unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn core_messages_to_jsonl_roundtrip() {
        let messages = vec![
            serde_json::json!({ "id": "m1", "text": "hello" }),
            serde_json::json!({ "id": "m2", "text": "world" }),
        ];
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let jsonl = runtime
            .block_on(core_messages_to_jsonl(messages.clone()))
            .unwrap();
        assert!(jsonl.contains('\n'));
        assert_eq!(jsonl.lines().count(), 2);

        let parsed = runtime.block_on(core_jsonl_to_messages(jsonl)).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["id"], "m1");
        assert_eq!(parsed[1]["text"], "world");
    }

    #[test]
    fn core_jsonl_to_messages_skips_bad_lines() {
        let jsonl = "{\"a\":1}\nnot-json\n{\"b\":2}\n";
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let parsed = runtime
            .block_on(core_jsonl_to_messages(jsonl.to_string()))
            .unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["a"], 1);
        assert_eq!(parsed[1]["b"], 2);
    }
}
