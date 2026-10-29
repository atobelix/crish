//! git 参数白名单 / refspec 防护 / 输出截断 / 错误协议回归。
#![allow(clippy::disallowed_methods)] // 测试临时目录清理，非产品物理删除路径

use super::*;

#[test]
fn whitelist_has_fifteen_subcommands() {
    assert_eq!(ALLOWED_SUBCOMMANDS.len(), 15);
    assert_eq!(
        ALLOWED_SUBCOMMANDS,
        &[
            "status",
            "diff",
            "add",
            "reset",
            "checkout",
            "clean",
            "commit",
            "push",
            "branch",
            "restore",
            "mv",
            "rm",
            "stash",
            "log",
            "rev-parse",
        ]
    );
}

/// T07.3 用例 1：`["add","--","x;calc.exe"]` → 通过校验且路径字面量化。
#[test]
fn literal_pathspec_prefix_added_after_separator() {
    let args = vec![
        "add".to_string(),
        "--".to_string(),
        "x;calc.exe".to_string(),
    ];
    let validated = validate_git_args(&args).expect("valid");
    assert_eq!(validated, vec!["add", "--", ":(literal)x;calc.exe"]);
}

/// T07.3 用例 2：元字符文件名全字面量进数组。
#[test]
fn literal_pathspec_handles_shell_metachars() {
    for name in [
        "a$(whoami).txt",
        "a\"b\\|c&d'e(f)g",
        "hello`world.txt",
        "%USERPROFILE%",
        "x;calc.exe",
    ] {
        let args = vec!["add".to_string(), "--".to_string(), name.to_string()];
        let validated = validate_git_args(&args).expect("valid");
        assert_eq!(validated[2], format!(":(literal){name}"));
    }
}

/// T07.3 用例 3：提交信息字面量进数组。
#[test]
fn commit_message_passes_verbatim() {
    let msg = "hello\"; calc.exe\"";
    let args = vec!["commit".to_string(), "-m".to_string(), msg.to_string()];
    let validated = validate_git_args(&args).expect("valid");
    assert_eq!(validated, vec!["commit", "-m", msg]);
}

/// T07.3 用例 4：force 类 flag 拒绝。
#[test]
fn force_flags_rejected() {
    for args in [
        vec!["push".to_string(), "--force".to_string()],
        vec!["push".to_string(), "-f".to_string()],
        vec!["push".to_string(), "--force-with-lease".to_string()],
        vec!["reset".to_string(), "--hard".to_string()],
    ] {
        let err = validate_git_args(&args).expect_err("force flag must be rejected");
        assert!(err.starts_with(ERR_ARG_NOT_ALLOWED), "err: {err}");
    }
}

/// T07.3 用例 4 变体：clean 递归强删 flag 拒绝（只允许 -f）。
#[test]
fn clean_rejects_recursive_force_flags() {
    for flag in ["-rf", "-r", "-f -r", "--force", "-x"] {
        let args = vec!["clean".to_string(), flag.to_string()];
        let err = validate_git_args(&args).expect_err("clean flag must be rejected");
        assert!(err.starts_with(ERR_ARG_NOT_ALLOWED), "err: {err}");
    }
    let args = vec!["clean".to_string(), "-f".to_string()];
    assert!(validate_git_args(&args).is_ok());
}

/// T07.3 用例 5：pathspec 魔法前缀拒绝。
#[test]
fn pathspec_magic_prefixes_rejected() {
    for name in [":(top)", ":!glob", ":(exclude)secret", "^foo"] {
        let args = vec!["add".to_string(), "--".to_string(), name.to_string()];
        let err = validate_git_args(&args).expect_err("magic pathspec must be rejected");
        assert!(err.starts_with(ERR_ARG_NOT_ALLOWED), "err: {err}");
    }
}

/// T07.3 用例 7：NUL 字节与超长参数拒绝。
#[test]
fn nul_and_oversize_args_rejected() {
    let nul = vec!["add".to_string(), "--".to_string(), "a\0b".to_string()];
    let err = validate_git_args(&nul).expect_err("NUL must be rejected");
    assert!(err.starts_with(ERR_ARG_NOT_ALLOWED));

    let long = vec![
        "commit".to_string(),
        "-m".to_string(),
        "x".repeat(MAX_ARG_LEN + 1),
    ];
    let err = validate_git_args(&long).expect_err("oversize must be rejected");
    assert!(err.starts_with(ERR_ARG_NOT_ALLOWED));
}

/// P1-S4 红测试：`+` 前缀 refspec（git 原生 force 语义，等价 --force）
/// 必须拒绝——绕过 C-04「拒绝 force push」承诺。
#[test]
fn push_plus_refspec_rejected() {
    for args in [
        vec![
            "push".to_string(),
            "origin".to_string(),
            "+refs/heads/main:main".to_string(),
        ],
        vec!["push".to_string(), "+refs/heads/main:main".to_string()],
        vec![
            "push".to_string(),
            "origin".to_string(),
            "+main".to_string(),
        ],
        vec![
            "push".to_string(),
            "origin".to_string(),
            "+main:main".to_string(),
        ],
    ] {
        let err = validate_git_args(&args).expect_err("+refspec（force）必须拒绝");
        assert!(err.starts_with(ERR_ARG_NOT_ALLOWED), "err: {err}");
    }
}

/// P1-S4 红测试：空 src 删除形态（`:refs/heads/x`）与孤立 refspec
/// （`main:`）必须拒绝——可删除远端分支。
#[test]
fn push_delete_ref_rejected() {
    for args in [
        vec![
            "push".to_string(),
            "origin".to_string(),
            ":refs/heads/x".to_string(),
        ],
        vec!["push".to_string(), ":refs/heads/x".to_string()],
        vec![
            "push".to_string(),
            "origin".to_string(),
            ":main".to_string(),
        ],
        vec![
            "push".to_string(),
            "origin".to_string(),
            "main:".to_string(),
        ],
        // 攻击性复核：非 heads 目标面（tag/remote 面）与多冒号畸形 refspec
        vec![
            "push".to_string(),
            "origin".to_string(),
            "main:refs/tags/v1".to_string(),
        ],
        vec![
            "push".to_string(),
            "origin".to_string(),
            "main:refs/remotes/origin/main".to_string(),
        ],
        vec![
            "push".to_string(),
            "origin".to_string(),
            "a:b:c".to_string(),
        ],
        // 数量上限：3 个位置参数拒绝
        vec![
            "push".to_string(),
            "origin".to_string(),
            "main".to_string(),
            "dev".to_string(),
        ],
    ] {
        let err = validate_git_args(&args).expect_err("删除类/畸形 refspec 必须拒绝");
        assert!(err.starts_with(ERR_ARG_NOT_ALLOWED), "err: {err}");
    }
}

/// P1-S4 契约：合法 push 形态保持放行（无参 / remote / remote+refspec）。
#[test]
fn push_normal_refspec_passes() {
    for args in [
        vec!["push".to_string()],
        vec!["push".to_string(), "origin".to_string()],
        vec!["push".to_string(), "origin".to_string(), "main".to_string()],
        vec![
            "push".to_string(),
            "origin".to_string(),
            "main:main".to_string(),
        ],
        vec![
            "push".to_string(),
            "origin".to_string(),
            "HEAD:refs/heads/main".to_string(),
        ],
        vec![
            "push".to_string(),
            "origin".to_string(),
            "feature/x:refs/heads/feature/x".to_string(),
        ],
    ] {
        let validated = validate_git_args(&args)
            .unwrap_or_else(|e| panic!("case {args:?} must pass, got: {e}"));
        assert_eq!(validated, args);
    }
}

/// T07.3 用例 4 变体：非白名单子命令拒绝。
#[test]
fn unknown_subcommand_rejected() {
    let args = vec!["fetch".to_string(), "--all".to_string()];
    let err = validate_git_args(&args).expect_err("fetch not in whitelist");
    assert!(err.starts_with(ERR_ARG_NOT_ALLOWED));
    let err = validate_git_args(&[]).expect_err("empty args rejected");
    assert!(err.starts_with(ERR_ARG_NOT_ALLOWED));
}

/// 前端实际调用组合回归：status / diff / reset / checkout / clean / branch / push。
#[test]
fn frontend_git_invocations_pass() {
    let cases: Vec<Vec<&str>> = vec![
        vec!["status", "--porcelain=v1", "-b", "--untracked-files=normal"],
        vec![
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--cached",
            "--",
            "src/main.rs",
        ],
        vec!["diff", "--no-color", "--no-ext-diff", "--", "a/b.txt"],
        vec!["add", "-A"],
        vec!["add", "--", "src/new.rs"],
        vec!["reset", "HEAD", "--", "src/main.rs"],
        vec!["reset", "HEAD"],
        vec!["checkout", "feature-x"],
        vec!["checkout", "--", "src/main.rs"],
        vec!["clean", "-f", "--", "src/tmp.txt"],
        vec!["branch", "--no-color"],
        vec!["commit", "-m", "feat: 提交信息"],
        vec!["push"],
        vec!["rev-parse", "--show-toplevel"],
        vec!["log", "--oneline"],
    ];
    for case in cases {
        let args: Vec<String> = case.iter().map(|s| s.to_string()).collect();
        let validated = validate_git_args(&args)
            .unwrap_or_else(|e| panic!("case {case:?} must pass, got: {e}"));
        // 路径参数必须全部字面量化
        if let Some(idx) = validated.iter().position(|a| a == "--") {
            for path in &validated[idx + 1..] {
                assert!(path.starts_with(":(literal)"), "path {path} not literal");
            }
        }
    }
}

/// flag 集外未知 flag 拒绝。
#[test]
fn unknown_flags_rejected() {
    for args in [
        vec!["status".to_string(), "--short".to_string()],
        vec!["status".to_string(), "--porcelain=v2".to_string()],
        vec!["diff".to_string(), "--stat".to_string()],
        vec!["branch".to_string(), "--merged".to_string()],
    ] {
        let err = validate_git_args(&args).expect_err("unknown flag must be rejected");
        assert!(err.starts_with(ERR_ARG_NOT_ALLOWED), "err: {err}");
    }
}

/// 分支名校验：合法/非法样例。
#[test]
fn branch_name_validation() {
    assert!(is_valid_branch_name("feature-x"));
    assert!(is_valid_branch_name("release/1.2.3"));
    assert!(is_valid_branch_name("HEAD"));
    assert!(is_valid_branch_name("a_b.c/d-e"));
    assert!(!is_valid_branch_name("-feature"));
    assert!(!is_valid_branch_name(""));
    assert!(!is_valid_branch_name("bad name"));
    assert!(!is_valid_branch_name("bad;name"));
}

/// 输出截断：>256KB 标记截断，头尾保留。
#[test]
fn output_clamped_at_256kb() {
    let raw = vec![b'a'; MAX_OUTPUT_BYTES + 1];
    let (text, truncated) = clamp_output_bytes(&raw);
    assert!(truncated);
    assert!(text.contains("[output truncated: 1 bytes omitted]"));
    assert!(text.starts_with('a'));
    assert!(text.ends_with('a'));

    let small = b"ok".to_vec();
    let (text, truncated) = clamp_output_bytes(&small);
    assert!(!truncated);
    assert_eq!(text, "ok");
}

// ── PS-04 T4.5（F4 F1-02）：错误协议统一 CoreError ──

/// 协议断言：错误必须按 CoreError `{kind, detail}` 形状序列化（前端可
/// 按 kind 分类），且 kind 为预期值、detail 保留现文案。
fn assert_core_error_kind<T: std::fmt::Debug>(
    result: Result<T, CoreError>,
    expected_kind: &str,
    detail_hint: &str,
) {
    let err = result.expect_err("必须返回错误");
    let json = serde_json::to_value(&err).expect("错误必须可序列化");
    assert_eq!(
        json.get("kind").and_then(|v| v.as_str()),
        Some(expected_kind),
        "错误必须按 CoreError {{kind,detail}} 协议序列化（当前形态 {json}），detail 应含 {detail_hint}"
    );
    let detail = json
        .get("detail")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(
        detail.contains(detail_hint),
        "detail 应保留 {detail_hint} 文案：{detail}"
    );
}

/// T4.5-R1（红 → 绿）：空 cwd（参数校验类）→ `CoreError::InvalidInput`，
/// serde 形状 `{kind: "InvalidInput", detail: ...}`。
#[tokio::test]
async fn workbench_git_run_empty_cwd_returns_core_error() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let result = workbench_git_run(
        app.handle().clone(),
        String::new(),
        vec!["status".to_string()],
        None,
    )
    .await;
    assert_core_error_kind(result, "InvalidInput", "cwd is empty");
}

/// T4.5-R1（红 → 绿）变体：越界 cwd（工作区外，路径/注册表类）→
/// `CoreError::InvalidInput`，detail 保留 workspace_not_granted 文案。
#[tokio::test]
async fn workbench_git_run_outside_cwd_returns_core_error() {
    use crate::workspace::{RegisterSource, WorkspaceRegistry};
    let base = std::env::temp_dir().join(format!(
        "conex-git-cwd-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let auth_root = base.join("auth");
    let outside = base.join("outside");
    std::fs::create_dir_all(&auth_root).expect("create auth root");
    std::fs::create_dir(&outside).expect("create outside dir");
    let config_dir = base.join("config");
    std::fs::create_dir_all(&config_dir).expect("create config dir");
    let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
    reg.register(&auth_root, RegisterSource::Dialog)
        .expect("dialog register auth_root");
    let app = tauri::test::mock_builder()
        .manage(reg)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let result = workbench_git_run(
        app.handle().clone(),
        outside.to_string_lossy().into_owned(),
        vec!["status".to_string()],
        None,
    )
    .await;
    assert_core_error_kind(result, "InvalidInput", "workspace_not_granted");
    let _ = std::fs::remove_dir_all(&base);
}

/// 原生选择授权后的根可通过 Git cwd 守卫并执行 git；未选根仍拒绝。
#[tokio::test]
async fn selected_workspace_root_allows_git_and_rejects_unselected_root() {
    use crate::workspace::{RegisterSource, WorkspaceRegistry};
    let base = std::env::temp_dir().join(format!(
        "conex-git-selected-workspace-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let selected = base.join("selected");
    let unselected = base.join("unselected");
    let config_dir = base.join("config");
    std::fs::create_dir_all(&selected).expect("create selected root");
    std::fs::create_dir(&unselected).expect("create unselected root");
    std::fs::create_dir(&config_dir).expect("create config directory");

    let git_init = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&selected)
        .output()
        .expect("git must be available for the desktop Git integration");
    assert!(
        git_init.status.success(),
        "git init failed: {}",
        String::from_utf8_lossy(&git_init.stderr)
    );

    let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
    reg.register(&selected, RegisterSource::Dialog)
        .expect("simulate the native dialog result being registered in Rust");
    let app = tauri::test::mock_builder()
        .manage(reg)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");

    let result = workbench_git_run(
        app.handle().clone(),
        selected.to_string_lossy().into_owned(),
        vec!["status".to_string()],
        None,
    )
    .await
    .expect("selected root must pass the Git authorization guard");
    assert!(result.ok, "git status failed: {}", result.stderr);

    let denied = workbench_git_run(
        app.handle().clone(),
        unselected.to_string_lossy().into_owned(),
        vec!["status".to_string()],
        None,
    )
    .await;
    assert_core_error_kind(denied, "InvalidInput", "workspace_not_granted");
    let _ = std::fs::remove_dir_all(&base);
}
