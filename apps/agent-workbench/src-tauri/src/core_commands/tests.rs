//! core_commands 测试（core_commands.rs 拆分）：命令门禁/搜索索引/压缩/工具组。

#![allow(clippy::disallowed_methods)] // 测试临时目录清理，非产品物理删除路径

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
        let result = core_rebuild_search_index(app.handle().clone(), Some(oversized), state).await;
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
