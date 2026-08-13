//! write_paths · 测试旁挂（SR-06a-5 外置；`#[path]` 接线，无孤儿）
//!
//! 写路径互斥纪律测全保留（零删除，测试资产保护铁律 §9）：
//! claim/释放/同持有者豁免/Overlaps 组件边界与大小写折叠/TTL 清扫/并发互斥/
//! 工具接线冲突拒绝/硬沙箱越权判定/两机制串行叠加/未接线回归。

use super::*;
use crate::context::{create_mock_tool_context, ToolContext};
use crate::definition::Tool;
use crate::tools::epoch_millis;
use crate::tools::fs::WriteFileTool;
use conex_test_utils::TempWorkspace;
use conex_types::error::codes;
use serde_json::json;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

/// 测试用会话上下文：workspace_root 指向临时工作区
fn mock_ctx(ws: &TempWorkspace) -> ToolContext {
    ToolContext {
        workspace_root: ws.path().clone(),
        ..create_mock_tool_context()
    }
}

#[test]
fn claim_and_release_roundtrip() {
    let ws = TempWorkspace::new("wp_roundtrip");
    let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
    assert!(reg.active_claims().is_empty());

    let guard = reg.claim_one("runA", "src/lib.rs", ClaimMode::Write).unwrap();
    assert_eq!(reg.active_claims().len(), 1);
    let claim = &reg.active_claims()[0];
    assert_eq!(claim.holder, "runA");
    assert_eq!(claim.session_id, "s1");
    assert_eq!(claim.mode, ClaimMode::Write);
    assert!(claim.path.is_absolute());
    assert_eq!(claim.path, ws.path().join("src/lib.rs"));
    assert!(claim.claimed_at_ms > 0);
    assert!(claim.expires_at_ms > claim.claimed_at_ms);

    drop(guard);
    assert!(reg.active_claims().is_empty(), "守卫 Drop 后声明必须释放");
}

#[test]
fn release_holder_idempotent() {
    let ws = TempWorkspace::new("wp_release");
    let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
    let _g = reg.claim_one("runA", "a.txt", ClaimMode::Write).unwrap();
    reg.release_holder("runA");
    assert!(reg.active_claims().is_empty());
    // 幂等：重复释放不报错
    reg.release_holder("runA");
    // 只释放指定持有者
    let _g2 = reg.claim_one("runA", "a.txt", ClaimMode::Write).unwrap();
    let _g3 = reg.claim_one("runB", "b.txt", ClaimMode::Write).unwrap();
    reg.release_holder("runB");
    let holders: Vec<String> = reg.active_claims().iter().map(|c| c.holder.clone()).collect();
    assert_eq!(holders, ["runA".to_string()]);
}

#[test]
fn overlaps_prefix_dir_vs_file_conflict() {
    let ws = TempWorkspace::new("wp_prefix");
    ws.write_file("a/b/c.txt", "x");
    let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
    // A 声明目录 a/b/，B 声明其下文件 → 冲突
    let _a = reg.claim_one("runA", "a/b", ClaimMode::Write).unwrap();
    let err = reg.claim_one("runB", "a/b/c.txt", ClaimMode::Write).unwrap_err();
    assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT);
    assert!(err.to_string().contains("runA"), "冲突信息必须含占用者");
    assert!(err.to_string().contains("write"), "冲突信息必须含模式");
    assert!(err.to_string().contains("有效期至"), "冲突信息必须含时间");
    drop(_a);
    // 反向：A 声明文件，B 声明其父目录 → 同样冲突
    let _a = reg.claim_one("runA", "a/b/c.txt", ClaimMode::Write).unwrap();
    let err = reg.claim_one("runB", "a/b", ClaimMode::Write).unwrap_err();
    assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT);
}

#[test]
fn overlaps_same_path_conflict() {
    let ws = TempWorkspace::new("wp_same");
    ws.write_file("x.txt", "x");
    let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
    let _a = reg.claim_one("runA", "x.txt", ClaimMode::Delete).unwrap();
    let err = reg.claim_one("runB", "x.txt", ClaimMode::Write).unwrap_err();
    assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT);
}

#[test]
fn overlaps_no_conflict_siblings_and_component_boundary() {
    let ws = TempWorkspace::new("wp_siblings");
    ws.write_file("a/x.txt", "x");
    ws.write_file("a/y.txt", "y");
    let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
    // 兄弟文件互不冲突
    let _a = reg.claim_one("runA", "a/x.txt", ClaimMode::Write).unwrap();
    reg.claim_one("runB", "a/y.txt", ClaimMode::Write).unwrap();
    // 组件边界：a/b 与 a/bc 不冲突（前缀必须在组件边界）
    reg.claim_one("runB", "a/bc.txt", ClaimMode::Write).unwrap();
}

#[cfg(windows)]
#[test]
fn overlaps_case_insensitive_on_windows() {
    let ws = TempWorkspace::new("wp_case");
    ws.write_file("Src/File.txt", "x");
    let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
    let _a = reg.claim_one("runA", "src/file.txt", ClaimMode::Write).unwrap();
    let err = reg.claim_one("runB", "SRC/FILE.TXT", ClaimMode::Write).unwrap_err();
    assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT, "Windows 语义大小写折叠");
}

#[test]
fn same_holder_reclaim_and_extension_allowed() {
    let ws = TempWorkspace::new("wp_self");
    let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
    let _a = reg.claim_one("runA", "src", ClaimMode::Write).unwrap();
    // 同持有者声明自身路径内的文件：不冲突（子代理可写自己声明范围内）
    reg.claim_one("runA", "src/lib.rs", ClaimMode::Write).unwrap();
    // 同持有者重复声明同路径：去重续期（只留一条）
    let g = reg.claim_one("runA", "src", ClaimMode::Write).unwrap();
    let claims = reg.active_claims();
    let same: Vec<_> = claims
        .iter()
        .filter(|c| c.holder == "runA" && c.path == ws.path().join("src"))
        .collect();
    assert_eq!(same.len(), 1, "同持有者同路径重复声明应去重");
    drop(g);
}

#[test]
fn expired_claim_released_automatically() {
    let ws = TempWorkspace::new("wp_expire");
    let reg = Arc::new(WritePathRegistry::with_ttl("s1", ws.path(), 100));
    let _a = reg.claim_one("runA", "a.txt", ClaimMode::Write).unwrap();
    let err = reg.claim_one("runB", "a.txt", ClaimMode::Write).unwrap_err();
    assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT, "未到期必须冲突");
    // 显式时钟推进：到期清扫（不依赖真实 sleep）
    let now = epoch_millis(Some(SystemTime::now()));
    let swept = reg.expire_stale_at(now + 1_000);
    assert_eq!(swept, 1, "过期声明必须被清扫");
    reg.claim_one("runB", "a.txt", ClaimMode::Write).unwrap();
}

#[test]
fn expired_claim_does_not_block_new_claim_lazily() {
    let ws = TempWorkspace::new("wp_expire_lazy");
    let reg = Arc::new(WritePathRegistry::with_ttl("s1", ws.path(), 80));
    let _a = reg.claim_one("runA", "a.txt", ClaimMode::Write).unwrap();
    // 真实时间流逝（短 TTL）：claim 内部先清扫过期声明再判冲突
    std::thread::sleep(Duration::from_millis(150));
    reg.claim_one("runB", "a.txt", ClaimMode::Write).unwrap();
}

#[test]
fn glob_and_workspace_escape_rejected() {
    let ws = TempWorkspace::new("wp_validate");
    let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
    // glob 拒绝
    let err = reg.claim_one("runA", "src/*.rs", ClaimMode::Write).unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("通配符"));
    // 工作区外绝对路径拒绝
    let outside = std::env::temp_dir().join("wp_outside_target.txt");
    let err = reg
        .claim_one("runA", &outside.display().to_string(), ClaimMode::Write)
        .unwrap_err();
    assert_eq!(err.code(), "tool.path_escape");
    // `..` 越界拒绝
    let err = reg.claim_one("runA", "../escape.txt", ClaimMode::Write).unwrap_err();
    assert_eq!(err.code(), "tool.path_escape");
    // 不存在的目标允许声明（写新文件场景）
    reg.claim_one("runA", "new/dir/fresh.txt", ClaimMode::Write).unwrap();
}

#[test]
fn check_conflict_reports_structured_info() {
    let ws = TempWorkspace::new("wp_preflight");
    let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
    let _a = reg.claim_one("runA", "docs", ClaimMode::Write).unwrap();
    let conflict = reg
        .check_conflict("runB", &ws.path().join("docs/readme.md"))
        .expect("preflight 必须命中冲突");
    assert_eq!(conflict.conflicting.holder, "runA");
    assert_eq!(conflict.requested_path, ws.path().join("docs/readme.md"));
    assert!(conflict.conflicting.expires_at_ms > 0);
    // 同持有者预检不命中
    assert!(reg.check_conflict("runA", &ws.path().join("docs/readme.md")).is_none());
}

#[tokio::test]
async fn concurrent_two_holders_same_file_one_rejected() {
    // I4-M3 验收：并发两子代理同文件冲突——同一时刻只有一方可声明
    let ws = TempWorkspace::new("wp_concurrent");
    let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
    let reg_a = Arc::clone(&reg);
    let reg_b = Arc::clone(&reg);
    let t1 = tokio::spawn(async move {
        // 子代理 A 声明并持有 100ms（模拟写文件过程）
        let guard = reg_a.claim_one("runA", "shared.txt", ClaimMode::Write).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(guard);
        true
    });
    let t2 = tokio::spawn(async move {
        // 子代理 B 稍后尝试声明同一文件 → 必须被拒绝
        tokio::time::sleep(Duration::from_millis(20)).await;
        reg_b.claim_one("runB", "shared.txt", ClaimMode::Write).is_err()
    });
    let (r1, r2) = tokio::join!(t1, t2);
    assert!(r1.unwrap(), "A 应成功完成");
    assert!(r2.unwrap(), "并发同路径声明必须被拒绝");
}

#[tokio::test]
async fn unwired_context_no_enforcement() {
    // 未接线（write_claims = None）：写工具保持现状行为，不强制互斥
    let ws = TempWorkspace::new("wp_unwired");
    let tool = WriteFileTool::new();
    tool.execute(&mock_ctx(&ws), json!({ "path": "a.txt", "content": "hi" }))
        .await
        .unwrap();
    assert_eq!(ws.read_file("a.txt"), "hi");
}

#[tokio::test]
async fn write_file_rejects_conflicting_holder() {
    // I4-M3 验收：写工具执行前检查 registry——冲突 → 拒绝执行（谁占用/何时）
    let ws = TempWorkspace::new("wp_tool_conflict");
    let registry = Arc::new(WritePathRegistry::new("s1", ws.path()));
    // 子代理 A 长期声明 src/（run_subagent write_paths 语义）
    let _a_guard = registry.claim_one("runA", "src", ClaimMode::Write).unwrap();

    // 子代理 B 的执行上下文：同注册表、不同持有者
    let ctx_b = ToolContext {
        workspace_root: ws.path().clone(),
        write_claims: Some(Arc::clone(&registry)),
        write_claim_holder: Some("runB".to_string()),
        explore_docs_quota: None,
        ..create_mock_tool_context()
    };
    let tool = WriteFileTool::new();
    let err = tool
        .execute(&ctx_b, json!({ "path": "src/lib.rs", "content": "x" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT);
    assert!(err.to_string().contains("runA"), "错误必须说明谁占用");
    assert!(!ws.path().join("src/lib.rs").exists(), "冲突拒绝时不得写盘");

    // 释放后同调用重试成功
    drop(_a_guard);
    tool.execute(&ctx_b, json!({ "path": "src/lib.rs", "content": "x" }))
        .await
        .unwrap();
    assert_eq!(ws.read_file("src/lib.rs"), "x");
    // 工具执行期声明随执行结束释放（不残留记账）
    assert!(registry.active_claims().is_empty());
}

#[tokio::test]
async fn write_file_own_holder_allowed_within_declared_paths() {
    // 同持有者（子代理自身）在其声明范围内写入：允许
    let ws = TempWorkspace::new("wp_self_write");
    let registry = Arc::new(WritePathRegistry::new("s1", ws.path()));
    let _a_guard = registry.claim_one("runA", "src", ClaimMode::Write).unwrap();
    let ctx_a = ToolContext {
        workspace_root: ws.path().clone(),
        write_claims: Some(Arc::clone(&registry)),
        write_claim_holder: Some("runA".to_string()),
        explore_docs_quota: None,
        ..create_mock_tool_context()
    };
    let tool = WriteFileTool::new();
    tool.execute(&ctx_a, json!({ "path": "src/main.rs", "content": "fn main() {}" }))
        .await
        .unwrap();
    assert!(ws.path().join("src/main.rs").is_file());
}

// ===== T-D-08：硬沙箱（WritePathPolicy + check_write_allowance）=====

/// Unrestricted（不限制路径）→ 任何目标放行
#[test]
fn allowance_unrestricted_allows_everything() {
    let policy = WritePathPolicy::Unrestricted;
    assert!(check_write_allowance(&policy, Path::new("C:/any/where.txt")).is_ok());
    assert!(check_write_allowance(&policy, Path::new("相对/路径.txt")).is_ok());
}

/// Allowed 命中/未命中：docs/a.md 放行、src/main.rs 拒绝（tool.write_not_allowed，
/// 载荷含目标路径与允许范围提示）
#[test]
fn allowance_matches_prefix_and_rejects_outside() {
    let ws = TempWorkspace::new("wp_allowance");
    let policy = WritePathPolicy::from_entries(ws.path(), vec!["docs/".to_string()]).unwrap();
    // 命中：白名单前缀 docs/ 下的文件与目录自身均放行
    assert!(check_write_allowance(&policy, &ws.path().join("docs/a.md")).is_ok());
    assert!(check_write_allowance(&policy, &ws.path().join("docs")).is_ok());
    assert!(check_write_allowance(&policy, &ws.path().join("docs/sub/nested.md")).is_ok());
    // 未命中：src/main.rs 不在允许范围 → tool.write_not_allowed
    let err = check_write_allowance(&policy, &ws.path().join("src/main.rs")).unwrap_err();
    assert_eq!(err.requested_path, ws.path().join("src/main.rs"));
    assert!(!err.allowed.is_empty(), "载荷必须含允许范围提示");
    let tool_err = err.into_tool_error();
    assert_eq!(tool_err.code(), codes::TOOL_WRITE_NOT_ALLOWED);
    assert!(tool_err.to_string().contains("src/main.rs"), "消息须含目标路径");
    assert!(tool_err.to_string().contains("docs"), "消息须含允许范围");
    assert!(tool_err.to_string().contains("主 agent"), "消息须含申请指引");
}

/// 前缀边界：a/b 与 a/bc 不误匹配（组件边界）、a/b 与 a/b/c.txt 命中
#[test]
fn allowance_component_boundary_no_false_positive() {
    let ws = TempWorkspace::new("wp_allowance_boundary");
    let policy = WritePathPolicy::from_entries(ws.path(), vec!["a/b".to_string()]).unwrap();
    assert!(check_write_allowance(&policy, &ws.path().join("a/b")).is_ok());
    assert!(check_write_allowance(&policy, &ws.path().join("a/b/c.txt")).is_ok());
    assert!(check_write_allowance(&policy, &ws.path().join("a/bc")).is_err());
    assert!(check_write_allowance(&policy, &ws.path().join("a/bc.txt")).is_err());
    assert!(check_write_allowance(&policy, &ws.path().join("a/bc/d.txt")).is_err());
    let err = check_write_allowance(&policy, &ws.path().join("a/bc/d.txt")).unwrap_err();
    assert_eq!(
        err.into_tool_error().code(),
        codes::TOOL_WRITE_NOT_ALLOWED,
        "未命中必须返回 tool.write_not_allowed"
    );
}

/// Windows 语义：大小写折叠（复用 normalize_for_compare）
#[cfg(windows)]
#[test]
fn allowance_case_folding_on_windows() {
    let ws = TempWorkspace::new("wp_allowance_case");
    let policy =
        WritePathPolicy::from_entries(ws.path(), vec!["Src/File.TXT".to_string()]).unwrap();
    assert!(check_write_allowance(&policy, &ws.path().join("src/file.txt")).is_ok());
    assert!(check_write_allowance(&policy, &ws.path().join("SRC/FILE.TXT")).is_ok());
    assert!(check_write_allowance(&policy, &ws.path().join("src/other.md")).is_err());
}

/// 显式空允许集 = 全部拒绝（fail-closed 兜底）
#[test]
fn allowance_empty_whitelist_denies_all() {
    let policy = WritePathPolicy::Allowed(Vec::new());
    let err = check_write_allowance(&policy, Path::new("anything")).unwrap_err();
    assert!(err.allowed.is_empty());
    assert_eq!(err.into_tool_error().code(), codes::TOOL_WRITE_NOT_ALLOWED);
}

/// from_entries：空列表 → Unrestricted（REQ-D04 口径）；glob/越界条目拒绝；
/// 相对条目解析为规范化绝对路径
#[test]
fn from_entries_empty_unrestricted_and_bad_entries_rejected() {
    let ws = TempWorkspace::new("wp_from_entries");
    assert_eq!(
        WritePathPolicy::from_entries(ws.path(), Vec::new()).unwrap(),
        WritePathPolicy::Unrestricted,
        "空条目列表 = 不做路径限制（REQ-D04）"
    );
    let err = WritePathPolicy::from_entries(ws.path(), vec!["docs/*.md".to_string()])
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input", "glob 条目必须拒绝");
    let err = WritePathPolicy::from_entries(ws.path(), vec!["../outside".to_string()])
        .unwrap_err();
    assert_eq!(err.code(), "tool.path_escape", "越界条目必须拒绝");
    let policy = WritePathPolicy::from_entries(ws.path(), vec!["docs/".to_string()]).unwrap();
    let WritePathPolicy::Allowed(paths) = policy else {
        panic!("非空条目必须为 Allowed");
    };
    assert_eq!(paths, vec![ws.path().join("docs")], "条目必须解析为绝对路径");
}

/// 注册表策略载体：with_write_policy 装配 / 缺省不装配
#[test]
fn registry_policy_roundtrip() {
    let ws = TempWorkspace::new("wp_policy_reg");
    let policy = WritePathPolicy::from_entries(ws.path(), vec!["docs/".to_string()]).unwrap();
    let reg = Arc::new(WritePathRegistry::new("s1", ws.path()).with_write_policy(policy));
    match reg.write_policy() {
        Some(WritePathPolicy::Allowed(paths)) => {
            assert_eq!(paths, &vec![ws.path().join("docs")]);
        }
        other => panic!("装配后必须为 Allowed，实际 {other:?}"),
    }
    let plain = Arc::new(WritePathRegistry::new("s2", ws.path()));
    assert!(plain.write_policy().is_none(), "缺省注册表不装配策略");
}

/// 工具级硬沙箱：Allowed(["docs/"]) 下写 src/main.rs → tool.write_not_allowed、
/// 写 docs/a.md 放行（权限层生效，与 Prompt 无关）
#[tokio::test]
async fn write_file_respects_hard_sandbox() {
    let ws = TempWorkspace::new("wp_sandbox");
    let registry = Arc::new(
        WritePathRegistry::new("s1", ws.path()).with_write_policy(
            WritePathPolicy::from_entries(ws.path(), vec!["docs/".to_string()]).unwrap(),
        ),
    );
    let ctx = ToolContext {
        workspace_root: ws.path().clone(),
        write_claims: Some(Arc::clone(&registry)),
        write_claim_holder: Some("runA".to_string()),
        explore_docs_quota: None,
        ..create_mock_tool_context()
    };
    let tool = WriteFileTool::new();
    // 越权写：src/main.rs 不在允许集 → tool.write_not_allowed，不得写盘
    let err = tool
        .execute(&ctx, json!({ "path": "src/main.rs", "content": "x" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), codes::TOOL_WRITE_NOT_ALLOWED);
    assert!(!ws.path().join("src/main.rs").exists(), "越权拒绝时不得写盘");
    // 白名单内写 docs/a.md → 放行
    tool.execute(&ctx, json!({ "path": "docs/a.md", "content": "x" }))
        .await
        .unwrap();
    assert_eq!(ws.read_file("docs/a.md"), "x");
}

/// 两机制串行叠加：白名单放行但被占用 → 仍 tool.write_path_conflict
/// （先越权拒绝、再冲突拒绝；错误码必须区分——越权 vs 冲突）
#[tokio::test]
async fn sandbox_and_conflict_serial_stack() {
    let ws = TempWorkspace::new("wp_sandbox_serial");
    let registry = Arc::new(
        WritePathRegistry::new("s1", ws.path()).with_write_policy(
            WritePathPolicy::from_entries(ws.path(), vec!["docs/".to_string()]).unwrap(),
        ),
    );
    // 子代理 A 长期声明 docs/（白名单内，占用者 B 的互斥面）
    let _a_guard = registry.claim_one("runA", "docs", ClaimMode::Write).unwrap();
    let ctx_b = ToolContext {
        workspace_root: ws.path().clone(),
        write_claims: Some(Arc::clone(&registry)),
        write_claim_holder: Some("runB".to_string()),
        explore_docs_quota: None,
        ..create_mock_tool_context()
    };
    let tool = WriteFileTool::new();
    // 越权优先：src/main.rs 不在允许集 → tool.write_not_allowed（不落互斥检查）
    let err = tool
        .execute(&ctx_b, json!({ "path": "src/main.rs", "content": "x" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), codes::TOOL_WRITE_NOT_ALLOWED);
    // 白名单放行但被占用 → tool.write_path_conflict（互斥拒绝，机制串行生效）
    let err = tool
        .execute(&ctx_b, json!({ "path": "docs/a.md", "content": "x" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT);
    assert!(err.to_string().contains("runA"));
    assert!(!ws.path().join("docs/a.md").exists(), "冲突拒绝时不得写盘");
    // 占用释放后：白名单内放行
    drop(_a_guard);
    tool.execute(&ctx_b, json!({ "path": "docs/a.md", "content": "x" }))
        .await
        .unwrap();
    assert_eq!(ws.read_file("docs/a.md"), "x");
}

/// 未装配策略（未接线 / 注册表无策略）：写工具保持现状行为（回归）
#[tokio::test]
async fn unwired_policy_context_no_enforcement() {
    let ws = TempWorkspace::new("wp_policy_unwired");
    let tool = WriteFileTool::new();
    tool.execute(&mock_ctx(&ws), json!({ "path": "anywhere.txt", "content": "hi" }))
        .await
        .unwrap();
    assert_eq!(ws.read_file("anywhere.txt"), "hi");
    // 注册表接线但未装配策略：同样不强制
    let registry = Arc::new(WritePathRegistry::new("s1", ws.path()));
    let ctx = ToolContext {
        workspace_root: ws.path().clone(),
        write_claims: Some(registry),
        write_claim_holder: Some("runA".to_string()),
        explore_docs_quota: None,
        ..create_mock_tool_context()
    };
    tool.execute(&ctx, json!({ "path": "out.txt", "content": "hi" }))
        .await
        .unwrap();
    assert_eq!(ws.read_file("out.txt"), "hi");
}
