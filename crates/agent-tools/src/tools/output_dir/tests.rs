// G2 禁令豁免：测试临时目录/临时库清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use super::*;
use crate::context::{create_mock_tool_context, ExploreDocsQuotaContext, ToolContext};
use crate::definition::Tool;
use conex_test_utils::TempWorkspace;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

/// 2026-08-05T00:00:00Z 的 epoch 秒（20670 天 × 86400）
const FIXED_EPOCH_2026_08_05: i64 = 1_785_888_000;

/// 测试用 session_meta 后端（conex-db dev-dependency；对齐
/// revert_guard.rs:268-309 的测试内参考实现模式——生产实现归引擎侧）
#[derive(Clone)]
struct SessionMetaOutputDirStore {
    db: conex_db::LocalDb,
}

impl std::fmt::Debug for SessionMetaOutputDirStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionMetaOutputDirStore")
    }
}

impl OutputDirStore for SessionMetaOutputDirStore {
    fn load(&self, session_id: &str) -> Option<String> {
        self.db
            .get_session_meta(&crate::explore_quota::session_meta_key_of(
                session_id,
                SESSION_META_KEY_OUTPUT_DIR,
            ))
            .ok()
            .flatten()
    }

    fn save(&self, session_id: &str, value: &str) -> Result<(), String> {
        self.db
            .set_session_meta(
                &crate::explore_quota::session_meta_key_of(session_id, SESSION_META_KEY_OUTPUT_DIR),
                value,
            )
            .map_err(|e| format!("session_meta 落库失败：{e}"))
    }
}

/// 固定时间环境：固定时钟（2026-08-05T00:00:00Z）+ 固定偏移（本地 +8 时区）
fn fixed_workspace(root: PathBuf, store: Arc<dyn OutputDirStore>) -> OutputWorkspace {
    OutputWorkspace::with_time(
        root,
        store,
        || SystemTime::UNIX_EPOCH + Duration::from_secs(FIXED_EPOCH_2026_08_05 as u64),
        || 480,
    )
}

/// 工具执行上下文（已注入产出目录服务）
fn tool_ctx(ws: &TempWorkspace, resolver: Arc<dyn OutputDirResolver>) -> ToolContext {
    ToolContext {
        session_id: "sess-1".to_string(),
        workspace_root: ws.path().clone(),
        output_dir: Some(resolver),
        ..create_mock_tool_context()
    }
}

// ===== 纯函数：日期前缀 =====

/// 日期前缀：零填充 + 本地偏移（固定时间注入的确定性断言）
#[test]
fn format_date_prefix_zero_padded_with_offset() {
    let fixed = SystemTime::UNIX_EPOCH + Duration::from_secs(FIXED_EPOCH_2026_08_05 as u64);
    // 偏移 0（UTC）：2026-08-05
    assert_eq!(format_date_prefix(fixed, 0), "2026-08-05");
    // 偏移 +8 小时：同日不变
    assert_eq!(format_date_prefix(fixed, 480), "2026-08-05");
    // 月/日零填充：2026-01-03
    let jan3 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_767_398_400);
    assert_eq!(format_date_prefix(jan3, 0), "2026-01-03");
    // epoch 起点
    assert_eq!(format_date_prefix(SystemTime::UNIX_EPOCH, 0), "1970-01-01");
}

/// 日期前缀：跨日边界（本地时区下零点偏移导致日期漂移的确定性断言）
#[test]
fn format_date_prefix_crosses_midnight() {
    let late =
        SystemTime::UNIX_EPOCH + Duration::from_secs((FIXED_EPOCH_2026_08_05 + 84_600) as u64);
    assert_eq!(format_date_prefix(late, 0), "2026-08-05");
    // 23:30 UTC + 1 小时偏移 → 本地次日
    assert_eq!(format_date_prefix(late, 60), "2026-08-06");
    // 00:30 UTC - 1 小时偏移 → 本地前一日
    let early =
        SystemTime::UNIX_EPOCH + Duration::from_secs((FIXED_EPOCH_2026_08_05 + 1_800) as u64);
    assert_eq!(format_date_prefix(early, -60), "2026-08-04");
}

// ===== 纯函数：会话标识净化 =====

/// 净化：剥离 `\/:*?"<>|` 与控制字符（C0 + DEL），其余字符保留
#[test]
fn sanitize_session_id_strips_bad_chars() {
    let dirty = "a/b\\c:d*e?f\"g<h>i|j";
    assert_eq!(sanitize_session_id(dirty), "abcdefghij");
    let controls = "a\x00b\x01c\x1fd\x7fe";
    assert_eq!(sanitize_session_id(controls), "abcde");
    // 合法字符（含中文与连字符）保留
    assert_eq!(
        sanitize_session_id("会话-2026-08-04-9f2a"),
        "会话-2026-08-04-9f2a"
    );
    // 空串保持空（退化场景由调用方处理）
    assert_eq!(sanitize_session_id(""), "");
}

// ===== 目录名格式与默认路径生成 =====

/// 默认路径：`.agent-outputs/<YYYY-MM-DD>-<净化会话标识>/`，
/// 目录名格式正则断言（本地时区 + 净化）
#[test]
fn default_dir_name_matches_format_regex() {
    let ws = TempWorkspace::new("out_dir_default");
    let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
    let svc = fixed_workspace(ws.path().clone(), store);

    let result = svc.resolve("sess-1/with:bad\\chars", None);
    assert!(result.first_resolve, "首次解析标记必须为 true");
    let name = result
        .dir
        .dir
        .file_name()
        .expect("目录名应存在")
        .to_string_lossy()
        .into_owned();
    // 目录名格式：YYYY-MM-DD 前缀（零填充）+ 净化后的会话标识
    let re = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}-").expect("格式正则应合法");
    assert!(re.is_match(&name), "目录名 {name:?} 应含日期前缀");
    assert_eq!(name, "2026-08-05-sess-1withbadchars");
    assert_eq!(
        result.dir.dir,
        ws.path()
            .join(".agent-outputs")
            .join("2026-08-05-sess-1withbadchars")
    );
    // 产出根 = <workspace_root>/.agent-outputs
    assert_eq!(result.dir.root, ws.path().join(".agent-outputs"));
    // 惰性：不建目录
    assert!(!result.dir_created);
    assert!(!result.dir.dir.exists(), "惰性：resolve 后目录不得存在");
    assert!(
        !ws.path().join(".agent-outputs").exists(),
        "惰性：产出根不得被创建"
    );
}

// ===== session_meta 往返（conex-db dev-dependency） =====

/// session_meta 往返：resolve 落库 → 键命中返回同一路径；键编码
/// `{session_id}:output_dir`；空 session_id 退化字面键
#[test]
fn session_meta_roundtrip_and_key_encoding() {
    let db = conex_db::LocalDb::open_in_memory().expect("打开内存库");
    let store = Arc::new(SessionMetaOutputDirStore { db: db.clone() });
    let svc = fixed_workspace(PathBuf::from("C:/work"), store);

    let first = svc.resolve("sess-1", None);
    assert!(first.first_resolve);
    // 键编码对齐 explore_quota.rs:43-49 的 session_meta_key_of
    let key = crate::explore_quota::session_meta_key_of("sess-1", SESSION_META_KEY_OUTPUT_DIR);
    assert_eq!(key, "sess-1:output_dir");
    let raw = db
        .get_session_meta(&key)
        .expect("读取 meta")
        .expect("首次解析必须落库");
    // 值格式：JSON {"path","userSpecified"}
    let (path, user_specified) = parse_output_dir_meta(Some(&raw)).expect("解析持久化值");
    assert_eq!(path, first.dir.dir);
    assert!(!user_specified);

    // 空 session_id 退化字面键（单会话引擎形态）
    svc.resolve("", None);
    assert!(
        db.get_session_meta(SESSION_META_KEY_OUTPUT_DIR)
            .expect("读取字面键")
            .is_some(),
        "空 session_id 必须退化字面键落库"
    );
}

// ===== 幂等：目录名会话首次 resolve 冻结 =====

/// 幂等：跨日再调用不漂移（时钟推进后仍返回首次冻结的路径）
#[test]
fn idempotent_same_path_across_days() {
    let ws = TempWorkspace::new("out_dir_idem");
    let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
    // 可推进时钟：2026-08-05 → 次日
    let now_secs = Arc::new(AtomicI64::new(FIXED_EPOCH_2026_08_05));
    let clock_secs = Arc::clone(&now_secs);
    let svc = OutputWorkspace::with_time(
        ws.path().clone(),
        store,
        move || {
            SystemTime::UNIX_EPOCH + Duration::from_secs(clock_secs.load(Ordering::Relaxed) as u64)
        },
        || 480,
    );

    let first = svc.resolve("sess-1", None);
    assert!(first.first_resolve);
    // 跨日推进后二次解析：meta 命中，路径不变
    now_secs.store(FIXED_EPOCH_2026_08_05 + 86_400, Ordering::Relaxed);
    let second = svc.resolve("sess-1", None);
    assert!(!second.first_resolve, "二次解析必须为 meta 命中");
    assert_eq!(second.dir.dir, first.dir.dir, "跨日调用路径不得漂移");
    assert_eq!(
        second.dir.dir.file_name().unwrap().to_string_lossy(),
        "2026-08-05-sess-1",
        "目录名冻结在首次解析日期"
    );
}

// ===== 显式 folder 优先 =====

/// 显式 folder：直接使用（不创建）+ 写 session_meta，后续默认沿用
#[test]
fn explicit_folder_priority_and_persisted() {
    let ws = TempWorkspace::new("out_dir_explicit");
    let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
    let svc = fixed_workspace(ws.path().clone(), Arc::clone(&store));

    let explicit = ws.path().join("docs/reports/规划");
    let result = svc.resolve("sess-1", Some(&explicit.to_string_lossy()));
    assert!(result.first_resolve);
    assert_eq!(result.dir.dir, explicit);
    assert!(result.dir.user_specified);
    assert!(!result.dir_created);

    // 后续默认沿用用户指定路径（无 folder 调用命中 meta）
    let again = svc.resolve("sess-1", None);
    assert!(!again.first_resolve);
    assert_eq!(again.dir.dir, explicit, "用户指定路径必须默认沿用");
    assert!(
        again.dir.user_specified,
        "user_specified 必须随持久化值恢复"
    );

    // 未指定会话（sess-2）不受影响：走默认生成
    let other = svc.resolve("sess-2", None);
    assert!(other.first_resolve);
    assert_eq!(
        other.dir.dir,
        ws.path().join(".agent-outputs").join("2026-08-05-sess-2")
    );
}

// ===== 损坏值容错 =====

/// 持久化值损坏：按首次处理重新生成（不 panic）
#[test]
fn corrupt_meta_tolerated() {
    let ws = TempWorkspace::new("out_dir_corrupt");
    let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
    store.save("sess-1", "not-json{{{").expect("写入损坏值");
    let svc = fixed_workspace(ws.path().clone(), store);
    let result = svc.resolve("sess-1", None);
    assert!(result.first_resolve, "损坏值按首次处理重新生成");
    assert_eq!(
        result.dir.dir,
        ws.path().join(".agent-outputs").join("2026-08-05-sess-1")
    );
}

// ===== 并发首次调用：先写者胜 =====

/// 多 run 并发首次 resolve：同会话返回同一路径（确定性路径名 +
/// 存储互斥保证先写者胜）
#[test]
fn concurrent_first_resolve_same_path() {
    let ws = TempWorkspace::new("out_dir_conc");
    let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
    let svc = Arc::new(fixed_workspace(ws.path().clone(), store));

    let handles: Vec<_> = (0..8)
        .map(|_| {
            let svc = Arc::clone(&svc);
            std::thread::spawn(move || svc.resolve("sess-1", None).dir.dir)
        })
        .collect();
    let paths: Vec<PathBuf> = handles
        .into_iter()
        .map(|h| h.join().expect("线程应正常结束"))
        .collect();
    for p in &paths {
        assert_eq!(*p, paths[0], "并发首次解析必须收敛到同一路径");
    }
    assert_eq!(
        paths[0],
        ws.path().join(".agent-outputs").join("2026-08-05-sess-1")
    );
}

// ===== 工具面 =====

/// 未接线：ctx.output_dir = None → common.unsupported（不 panic）
#[tokio::test]
async fn tool_unplugged_returns_unsupported() {
    let ws = TempWorkspace::new("out_dir_tool_none");
    let tool = ResolveOutputDirTool::new();
    let ctx = ToolContext {
        workspace_root: ws.path().clone(),
        ..create_mock_tool_context()
    };
    let err = tool
        .execute(&ctx, serde_json::json!({}))
        .await
        .expect_err("未接线必须报错");
    assert_eq!(err.code(), "common.unsupported");
    assert!(err.to_string().contains("未接线"), "错误必须明示未接线");
}

/// 默认解析：输出形状 path / userSpecified / dirCreated / text，
/// path 为工作区相对展示路径（尾斜杠）
#[tokio::test]
async fn tool_default_resolve_output_shape() {
    let ws = TempWorkspace::new("out_dir_tool_def");
    let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
    let svc: Arc<dyn OutputDirResolver> = Arc::new(fixed_workspace(ws.path().clone(), store));
    let tool = ResolveOutputDirTool::new();
    let ctx = tool_ctx(&ws, svc);

    let out = tool
        .execute(&ctx, serde_json::json!({}))
        .await
        .expect("默认解析应成功");
    assert_eq!(out["path"], ".agent-outputs/2026-08-05-sess-1/");
    assert_eq!(out["userSpecified"], false);
    assert_eq!(out["dirCreated"], false);
    let text = out["text"].as_str().expect("text 必须存在");
    assert!(text.contains("首次写入时自动创建"), "必须说明惰性创建语义");
    assert!(
        !ws.path().join(".agent-outputs").exists(),
        "工具调用不得创建目录"
    );
}

/// 显式 folder：解析返回指定路径且落 meta（后续默认沿用）；
/// 工作区外 folder 拒绝（tool.path_escape）
#[tokio::test]
async fn tool_explicit_folder_and_outside_rejected() {
    let ws = TempWorkspace::new("out_dir_tool_ex");
    let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
    let svc: Arc<dyn OutputDirResolver> = Arc::new(fixed_workspace(ws.path().clone(), store));
    let tool = ResolveOutputDirTool::new();
    let ctx = tool_ctx(&ws, svc);

    // 工作区内（尚不存在）的目录：直接返回（惰性不创建）
    let folder = ws.path().join("docs/reports");
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({ "folder": folder.to_string_lossy() }),
        )
        .await
        .expect("工作区内 folder 应放行");
    assert_eq!(out["userSpecified"], true);
    assert_eq!(
        out["path"].as_str().expect("path 必须存在"),
        "docs/reports/",
        "展示路径应为工作区相对路径"
    );
    assert!(out["text"].as_str().unwrap().contains("用户指定路径已生效"));

    // 越界 folder：tool.path_escape
    let err = tool
        .execute(&ctx, serde_json::json!({ "folder": "../outside" }))
        .await
        .expect_err("越界 folder 必须拒绝");
    assert_eq!(err.code(), "tool.path_escape");

    // 空白 folder：invalid_input
    let err = tool
        .execute(&ctx, serde_json::json!({ "folder": "   " }))
        .await
        .expect_err("空白 folder 必须拒绝");
    assert_eq!(err.code(), "tool.invalid_input");
}

/// 只读子代理：不允许自选输出目录——folder 参数忽略，仅返回主 agent
/// 规划的产出目录（对齐「按主 agent 规划」语义）
#[tokio::test]
async fn tool_readonly_subagent_cannot_choose_folder() {
    let ws = TempWorkspace::new("out_dir_tool_ro");
    let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
    let svc: Arc<dyn OutputDirResolver> = Arc::new(fixed_workspace(ws.path().clone(), store));
    let tool = ResolveOutputDirTool::new();
    let mut ctx = tool_ctx(&ws, svc);
    // 探索类（read-only）子代理上下文：配额上下文装配 = 只读信号
    ctx.explore_docs_quota = Some(ExploreDocsQuotaContext {
        session_id: "sess-1".to_string(),
        run_id: "run-researcher-1".to_string(),
        granted: false,
        quota: 1,
        store: None,
    });

    // 带 folder 调用：folder 被忽略，返回默认（主 agent 规划）目录
    let out = tool
        .execute(&ctx, serde_json::json!({ "folder": "C:/outside/evil" }))
        .await
        .expect("只读子代理调用不应失败");
    assert_eq!(
        out["path"].as_str().expect("path 必须存在"),
        ".agent-outputs/2026-08-05-sess-1/",
        "只读子代理必须返回主 agent 规划的产出目录"
    );
    assert_eq!(out["userSpecified"], false);
    let text = out["text"].as_str().expect("text 必须存在");
    assert!(text.contains("folder 参数已忽略"), "必须明示 folder 被忽略");

    // 无 folder 调用：正常返回默认目录
    let plain = tool
        .execute(&ctx, serde_json::json!({}))
        .await
        .expect("只读子代理默认调用应成功");
    assert_eq!(
        plain["path"], out["path"],
        "只读子代理路径与主 agent 规划一致"
    );
}

/// 非法字符净化：工具级调用携带含非法字符的 session_id → 目录名净化、
/// session_meta 键仍用原始标识（键稳定性）
#[tokio::test]
async fn tool_sanitizes_session_id_in_dir_name() {
    let ws = TempWorkspace::new("out_dir_tool_san");
    let db = conex_db::LocalDb::open_in_memory().expect("打开内存库");
    let store: Arc<dyn OutputDirStore> = Arc::new(SessionMetaOutputDirStore { db: db.clone() });
    let svc: Arc<dyn OutputDirResolver> = Arc::new(fixed_workspace(ws.path().clone(), store));
    let tool = ResolveOutputDirTool::new();
    let ctx = ToolContext {
        session_id: "s/1\\2:3*4".to_string(),
        workspace_root: ws.path().clone(),
        output_dir: Some(svc),
        ..create_mock_tool_context()
    };

    let out = tool
        .execute(&ctx, serde_json::json!({}))
        .await
        .expect("净化后的解析应成功");
    assert_eq!(out["path"], ".agent-outputs/2026-08-05-s1234/");
    // 键仍按原始 session_id 编码（幂等稳定）
    let key = crate::explore_quota::session_meta_key_of("s/1\\2:3*4", SESSION_META_KEY_OUTPUT_DIR);
    assert!(
        db.get_session_meta(&key).expect("读 meta").is_some(),
        "meta 键必须用原始标识"
    );
}
