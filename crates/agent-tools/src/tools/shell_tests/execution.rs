use super::super::shell_invoke::{
    base64_encode, build_windows_powershell_script, parse_mode, ShellMode,
};
use super::super::shell_output::{
    clamp_output_bytes, format_command_result, high_output_suggestion, OutputAccumulator,
};
use super::super::*;
use super::{ctx, tool};
use crate::context::ToolContext;
use conex_shared::perf_budget::{SHELL_ACCUM_HARD_CAP_FACTOR, SHELL_MAX_OUTPUT_BYTES_DEFAULT};
use conex_test_utils::TempWorkspace;
use serde_json::json;

/// 平台无关大输出命令（写 N 个字符到 stdout，单行）
fn big_output_cmd(ch: char, count: usize) -> String {
    if cfg!(windows) {
        format!("'{}' * {count}", ch)
    } else {
        format!("printf '{ch}%.0s' {{1..{count}}}")
    }
}

#[tokio::test]
async fn shell_echo_succeeds() {
    let ws = TempWorkspace::new("shell_echo");
    let t = tool();
    let command = if cfg!(windows) {
        "Write-Output hello-shell"
    } else {
        "echo hello-shell"
    };
    let out = t
        .execute(&ctx(&ws), json!({ "command": command }))
        .await
        .unwrap();
    assert_eq!(out["timedOut"], false);
    assert_eq!(out["exitCode"], 0);
    let stdout = out["stdout"].as_str().unwrap();
    assert!(stdout.contains("hello-shell"), "stdout: {stdout}");
    assert!(out["text"].as_str().unwrap().contains("hello-shell"));
}

#[tokio::test]
async fn shell_timeout_kills_and_marks() {
    let ws = TempWorkspace::new("shell_timeout");
    let t = ShellCommandTool::new(30_000, 200_000, None);
    let command = if cfg!(windows) {
        "Start-Sleep -Seconds 10"
    } else {
        "sleep 10"
    };
    let out = t
        .execute(&ctx(&ws), json!({ "command": command, "timeoutMs": 2000 }))
        .await
        .unwrap();
    assert_eq!(out["timedOut"], true);
    assert!(out["stderr"].as_str().unwrap().contains("超时"));
}

#[tokio::test]
async fn shell_cwd_must_be_valid() {
    let ws = TempWorkspace::new("shell_cwd");
    let t = tool();
    let err = t
        .execute(
            &ctx(&ws),
            json!({ "command": "echo hi", "cwd": "no/such/dir" }),
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not a directory"));
    // 越界 cwd 拒绝
    let err = t
        .execute(
            &ctx(&ws),
            json!({ "command": "echo hi", "cwd": "../outside" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.path_escape");
}

#[tokio::test]
async fn shell_exit_code_captured() {
    let ws = TempWorkspace::new("shell_exit");
    let t = tool();
    let out = t
        .execute(&ctx(&ws), json!({ "command": "exit 42" }))
        .await
        .unwrap();
    assert_eq!(out["exitCode"], 42);
    assert!(out["text"].as_str().unwrap().contains("(exit 42)"));
}

#[test]
fn base64_encoder_matches_standard() {
    assert_eq!(base64_encode(b""), "");
    assert_eq!(base64_encode(b"f"), "Zg==");
    assert_eq!(base64_encode(b"fo"), "Zm8=");
    assert_eq!(base64_encode(b"foo"), "Zm9v");
    assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    // 中文 UTF-8 与 Unicode 转义混合
    assert_eq!(base64_encode("你好".as_bytes()), "5L2g5aW9");
}

#[test]
fn powershell_script_wraps_command_base64() {
    let script = build_windows_powershell_script("echo hi | Out-String");
    assert!(script.contains("scriptblock"));
    assert!(script.contains("FromBase64String"));
    // 原始命令不直接出现在脚本中（防注入）
    assert!(!script.contains("Out-String"));
}

#[test]
fn clamp_output_caps_at_limit() {
    let raw = vec![b'a'; 1000];
    let (text, truncated) = clamp_output_bytes(&raw, 100);
    assert!(truncated);
    assert!(text.contains("[output truncated: 900 bytes omitted]"));
    assert!(text.starts_with("aaa"));
    assert!(text.ends_with("aaa"));

    let (text, truncated) = clamp_output_bytes(&raw, 2000);
    assert!(!truncated);
    assert_eq!(text.len(), 1000);
}

#[test]
fn format_result_annotations() {
    assert_eq!(format_command_result("out", "", Some(0), false), "out");
    assert_eq!(format_command_result("", "", Some(0), false), "(无输出)");
    assert_eq!(
        format_command_result("out", "", Some(3), false),
        "out\n\n(exit 3)"
    );
    assert_eq!(format_command_result("", "", Some(3), false), "(exit 3)");
    assert_eq!(
        format_command_result("out", "", None, true),
        "out\n\n(命令超时)"
    );
}

/// 任务卡验收：`git status` 正常执行（非删除命令不受影响；临时工作区非
/// git 仓库时 git 自身以 128 退出，断言关键是「真实执行而非被拦截」）
#[tokio::test]
async fn git_status_executes_normally() {
    let ws = TempWorkspace::new("shell_s4_git");
    let t = tool();
    let out = t
        .execute(&ctx(&ws), json!({ "command": "git status" }))
        .await
        .unwrap();
    assert!(
        out.get("redirected").is_none(),
        "非删除命令结果不得带重定向标记"
    );
    assert_eq!(out["timedOut"], false);
    assert!(out["exitCode"].is_number(), "git 应真实执行并产生退出码");
}

/// 任务卡验收：1MB 输出 → truncated=true、logPath 非空、文件为完整原始输出
#[tokio::test]
async fn shell_output_full_log_saved() {
    let ws = TempWorkspace::new("shell_spill");
    let t = tool();
    let ctx = ToolContext {
        log_root: Some(ws.path().join("logs")),
        ..ctx(&ws)
    };
    let command = big_output_cmd('y', 1_048_576);
    let out = t
        .execute(
            &ctx,
            json!({ "command": command, "timeoutMs": 30000, "maxOutputBytes": 100000 }),
        )
        .await
        .unwrap();
    assert_eq!(out["truncated"], true, "1MB 输出应判定截断");
    let log_path = out["logPath"]
        .as_str()
        .expect("截断应回填 logPath")
        .to_string();
    let file_bytes = std::fs::read(&log_path).expect("完整日志文件应存在");
    assert_eq!(
        file_bytes.iter().filter(|&&b| b == b'y').count(),
        1_048_576,
        "日志文件必须为完整原始输出"
    );
    let text = out["text"].as_str().unwrap();
    assert!(
        text.contains("输出已截断，完整日志保存在"),
        "text 尾部应追加完整日志指引"
    );
    assert!(text.contains("可通过文件读取工具查看完整内容"));
}

/// 任务卡验收：注入不可写 log_root——命令仍成功执行且 logPath 缺失
/// （不 panic 不失败，best-effort 降级）
#[tokio::test]
async fn shell_output_spill_failure_degrades() {
    let ws = TempWorkspace::new("shell_spill_fail");
    let t = tool();
    // log_root 指向「文件」而非目录 → create_dir_all 失败 → 降级无 logPath
    let file_path = ws.path().join("not-a-dir");
    std::fs::write(&file_path, "x").unwrap();
    let ctx = ToolContext {
        log_root: Some(file_path),
        ..ctx(&ws)
    };
    let command = big_output_cmd('z', 1_048_576);
    let out = t
        .execute(
            &ctx,
            json!({ "command": command, "timeoutMs": 30000, "maxOutputBytes": 100000 }),
        )
        .await
        .unwrap();
    assert_eq!(out["truncated"], true);
    assert!(
        out.get("logPath").is_none(),
        "写盘失败应无 logPath（不失败不 panic）"
    );
    assert_eq!(out["timedOut"], false, "命令仍成功执行");
}

/// 任务卡验收：spawn 的子进程环境含 PAGER=cat
#[tokio::test]
async fn shell_pager_env_set() {
    let ws = TempWorkspace::new("shell_pager");
    let t = tool();
    let command = if cfg!(windows) {
        "Write-Output $env:PAGER"
    } else {
        "echo $PAGER"
    };
    let out = t
        .execute(&ctx(&ws), json!({ "command": command }))
        .await
        .unwrap();
    assert_eq!(out["timedOut"], false);
    assert!(
        out["stdout"].as_str().unwrap().contains("cat"),
        "子进程环境必须含 PAGER=cat"
    );
}

/// 高输出命令建议（纯函数）：git log 无 -n / git diff 无 --stat 命中，
/// 带限制参数不命中
#[test]
fn high_output_suggestion_forms() {
    assert!(high_output_suggestion("git log").is_some());
    assert!(high_output_suggestion("git log --oneline").is_none());
    assert!(high_output_suggestion("git log -n 5").is_none());
    assert!(high_output_suggestion("git log --max-count=10").is_none());
    assert!(high_output_suggestion("git diff").is_some());
    assert!(high_output_suggestion("git diff --stat").is_none());
    assert!(high_output_suggestion("git show").is_some());
    assert!(high_output_suggestion("git status").is_none());
    assert!(high_output_suggestion("npm test").is_none());
}

/// 任务卡验收：`git status` + cwd 参数正常执行（不被 cd 拦截误伤）
#[tokio::test]
async fn shell_git_status_with_cwd_executes() {
    let ws = TempWorkspace::new("shell_cd_cwd_ok");
    ws.write_file("sub/.keep", "");
    let t = tool();
    let out = t
        .execute(&ctx(&ws), json!({ "command": "git status", "cwd": "sub" }))
        .await
        .unwrap();
    assert_eq!(out["timedOut"], false);
    assert!(
        out["exitCode"].is_number(),
        "git 应真实执行并产生退出码（临时目录非 git 仓库时 128）"
    );
}

/// 任务卡验收：`git -C` 形态不误拦（不依赖进程内目录状态的形态放行）
#[tokio::test]
async fn shell_git_dash_c_not_blocked() {
    let ws = TempWorkspace::new("shell_cd_gitc");
    ws.write_file("sub/.keep", "");
    let t = tool();
    let out = t
        .execute(&ctx(&ws), json!({ "command": "git -C sub status" }))
        .await
        .unwrap();
    assert_eq!(out["timedOut"], false);
    assert!(out["exitCode"].is_number(), "git -C 形态不得被 cd 拦截误伤");
}

/// mode 入参解析：未知值结构化报错，缺省 sync
#[test]
fn parse_mode_rejects_unknown_and_defaults_sync() {
    let err = parse_mode(&json!({ "mode": "async" })).unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("auto-background"));
    assert_eq!(parse_mode(&json!({})).unwrap(), ShellMode::Sync);
    assert_eq!(
        parse_mode(&json!({ "mode": "auto-background" })).unwrap(),
        ShellMode::AutoBackground
    );
    assert_eq!(
        parse_mode(&json!({ "mode": "daemon" })).unwrap(),
        ShellMode::Daemon
    );
}

/// F3-16：maxOutputBytes u64→usize 钳制——32 位平台裸 `as usize` 截断
/// 失真防护（win32 x64 平台截断不可复现，恒等路径；32 位分支编译期
/// 锁定：4GiB+1 不得截断为 1，钳到 usize::MAX）
#[test]
fn max_output_bytes_clamped_to_usize_range() {
    assert_eq!(clamp_u64_to_usize(0), 0);
    assert_eq!(clamp_u64_to_usize(123), 123);
    assert_eq!(clamp_u64_to_usize(u64::MAX), usize::MAX);
    #[cfg(target_pointer_width = "32")]
    {
        assert_eq!(
            clamp_u64_to_usize(0x1_0000_0000),
            usize::MAX,
            "32 位：4GiB+1 必须钳到 usize::MAX（裸截断为 1 会静默截断输出）"
        );
        assert_ne!(clamp_u64_to_usize(0x1_0000_0000), 1);
    }
}

/// DIM-04: 输出超限溢出落盘测试
#[tokio::test]
async fn shell_output_spills_to_log_root_when_truncated() {
    let ws = TempWorkspace::new("shell_spill_ws");
    let log_ws = TempWorkspace::new("shell_log_ws");
    let t = tool();
    let ctx = ToolContext {
        log_root: Some(log_ws.path().clone()),
        session_id: "test-sess-spill".to_string(),
        ..ctx(&ws)
    };
    let cmd = if cfg!(windows) {
        "Write-Output '1234567890abcdefghijklmnopqrstuvwxyz'"
    } else {
        "echo '1234567890abcdefghijklmnopqrstuvwxyz'"
    };
    let res = t
        .execute(
            &ctx,
            json!({
                "command": cmd,
                "maxOutputBytes": 10
            }),
        )
        .await
        .unwrap();

    assert_eq!(res["truncated"], true);
    assert!(res.get("logPath").is_some());
    let log_path_str = res["logPath"].as_str().unwrap();
    let log_path = std::path::PathBuf::from(log_path_str);
    assert!(log_path.exists(), "溢出日志文件应已落盘");
}

/// U-MEM / 10-S1：OutputAccumulator 完成前内存 hard_cap——累计超
/// `SHELL_MAX_OUTPUT_BYTES_DEFAULT * SHELL_ACCUM_HARD_CAP_FACTOR` 后
/// 停止 bytes 增长（overflowed=true），preview 继续有界累积（INV-B5）
#[test]
fn output_accumulator_hard_cap_bounds_memory() {
    let hard_cap = SHELL_MAX_OUTPUT_BYTES_DEFAULT * SHELL_ACCUM_HARD_CAP_FACTOR;
    let mut acc = OutputAccumulator::new();
    let chunk = vec![b'x'; 64 * 1024];
    // 超过 hard_cap 的累计追加
    for _ in 0..((hard_cap / (64 * 1024)) + 4) {
        acc.append(&chunk, 0);
    }
    assert!(acc.overflowed(), "超 hard_cap 后必须触顶标记");
    let (_text, truncated) = acc.preview_text(SHELL_MAX_OUTPUT_BYTES_DEFAULT);
    assert!(truncated, "hard_cap 触顶后 preview_text 必须报告截断");
}

/// U-MEM：hard_cap 内正常累积不触顶（小输出零行为变化回归）
#[test]
fn output_accumulator_under_hard_cap_no_overflow() {
    let mut acc = OutputAccumulator::new();
    acc.append(b"hello world", 0);
    assert!(!acc.overflowed(), "hard_cap 内不得触顶");
    let (text, truncated) = acc.preview_text(SHELL_MAX_OUTPUT_BYTES_DEFAULT);
    assert!(!truncated, "限内输出不得截断");
    assert_eq!(text, "hello world");
}
