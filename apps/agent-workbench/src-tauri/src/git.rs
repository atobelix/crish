//! git 参数数组执行命令（PE-07 T07.3：git 注入修复，C-02/C-03/C-04）
//!
//! `workbench_git_run(cwd, gitArgs, timeoutMs)`：替代前端 `gitApi.ts` 的
//! PowerShell 拼串（`git -C ${q(cwd)} ${gitArgs.map(q).join(' ')}`）。
//!
//! 安全语义：
//! 1. cwd 经 WorkspaceRegistry 校验：canonicalize 后必须 ∈ 已授权根子树，
//!    否则 `workspace_not_granted`（B1 信任锚）。
//! 2. 参数 schema 白名单（B2 进程执行）：首参 ∈ 15 项子命令白名单；
//!    逐子命令声明允许 flag 集，未知 / 危险 flag（push -f/--force、
//!    reset --hard、clean 递归强删等）→ `arg_not_allowed`（C-04 服务端兜底）。
//! 3. `--` 之后为路径参数：强制加 `:(literal)` 字面量 pathspec 前缀
//!    （git 原生防 pathspec magic），拒绝以 `:`/`^` 起始的参数；
//!    全参拒绝 NUL、长度 ≤ 8KB。
//! 4. 执行：`Command::new("git").args(...)` 参数数组直传，禁 shell；
//!    stdin 空、Windows CREATE_NO_WINDOW；超时默认 30s、上限 120s，
//!    超时杀进程树（复用 process.rs terminate_process_tree）；
//!    输出各 256KB 截断（头尾各半）。
//!
//! 命令需集成 agent 在 main.rs 注册（make_handlers）+ State 依赖：
//! `crate::workspace::WorkspaceRegistry`（setup 时 app.manage）。

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command as TokioCommand;
use tokio::time::{timeout, Duration};

/// 输出截断上限（每流 256KB）
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
/// 参数长度上限（单个数组元素，8KB）
const MAX_ARG_LEN: usize = 8 * 1024;
/// 默认超时（毫秒）
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// 超时上限（毫秒）
const MAX_TIMEOUT_MS: u64 = 120_000;
/// 超时下限（毫秒，避免瞬时竞态）
const MIN_TIMEOUT_MS: u64 = 1_000;

/// 错误码：参数被白名单拒绝
const ERR_ARG_NOT_ALLOWED: &str = "arg_not_allowed";
/// 错误码：cwd 未授权
const ERR_WORKSPACE_NOT_GRANTED: &str = "workspace_not_granted";

/// 子命令白名单（15 项，首参必须精确匹配）
const ALLOWED_SUBCOMMANDS: &[&str] = &[
    "status", "diff", "add", "reset", "checkout", "clean", "commit", "push", "branch",
    "restore", "mv", "rm", "stash", "log", "rev-parse",
];

/// 逐子命令允许 flag 集（`--` 分隔符之前；精确匹配）
const FLAGS_STATUS: &[&str] = &["--porcelain=v1", "-b", "--untracked-files=normal", "--no-color"];
const FLAGS_DIFF: &[&str] = &["--no-color", "--no-ext-diff", "--cached"];
const FLAGS_ADD: &[&str] = &["-A"];
const FLAGS_RESET: &[&str] = &[];
const FLAGS_CHECKOUT: &[&str] = &[];
const FLAGS_CLEAN: &[&str] = &["-f"];
const FLAGS_COMMIT: &[&str] = &["-m"];
const FLAGS_PUSH: &[&str] = &[];
const FLAGS_BRANCH: &[&str] = &["--no-color"];
const FLAGS_RESTORE: &[&str] = &["--staged"];
const FLAGS_MV: &[&str] = &[];
const FLAGS_RM: &[&str] = &["--cached"];
const FLAGS_STASH: &[&str] = &[];
const FLAGS_LOG: &[&str] = &["--no-color", "--oneline"];
const FLAGS_REV_PARSE: &[&str] = &["--show-toplevel", "--abbrev-ref", "--short"];

/// 子命令规格：允许 flag 集 + 位置参数规则
struct SubcommandSpec {
    flags: &'static [&'static str],
    /// 位置参数（`--` 之前）：None = 不允许；Some(规则)
    positional: PositionalRule,
}

/// 位置参数规则（`--` 分隔符之前）
enum PositionalRule {
    /// 不允许任何位置参数（如 status/diff/add）
    None,
    /// 仅允许固定字面量（如 reset 的 `HEAD`）
    Only(&'static [&'static str]),
    /// 分支名（正则：`^[A-Za-z0-9._/-]{1,255}$` 且不以 `-` 开头）
    BranchName,
    /// 任意单值参数（如 commit -m 的消息在 flag 后单独校验）
    BareValue,
    /// 有限个数普通位置参数（push 的 remote/refspec 等，上限 2）
    Count(usize),
    /// stash 子命令：首位置参数 ∈ {push, list, pop, apply, drop}
    StashSubcommand,
}

fn spec_for(subcommand: &str) -> Option<SubcommandSpec> {
    let spec = match subcommand {
        "status" => SubcommandSpec {
            flags: FLAGS_STATUS,
            positional: PositionalRule::None,
        },
        "diff" => SubcommandSpec {
            flags: FLAGS_DIFF,
            positional: PositionalRule::None,
        },
        "add" => SubcommandSpec {
            flags: FLAGS_ADD,
            positional: PositionalRule::None,
        },
        "reset" => SubcommandSpec {
            flags: FLAGS_RESET,
            positional: PositionalRule::Only(&["HEAD"]),
        },
        "checkout" => SubcommandSpec {
            flags: FLAGS_CHECKOUT,
            positional: PositionalRule::BranchName,
        },
        "clean" => SubcommandSpec {
            flags: FLAGS_CLEAN,
            positional: PositionalRule::None,
        },
        "commit" => SubcommandSpec {
            flags: FLAGS_COMMIT,
            positional: PositionalRule::BareValue,
        },
        "push" => SubcommandSpec {
            flags: FLAGS_PUSH,
            positional: PositionalRule::Count(2),
        },
        "branch" => SubcommandSpec {
            flags: FLAGS_BRANCH,
            positional: PositionalRule::BranchName,
        },
        "restore" => SubcommandSpec {
            flags: FLAGS_RESTORE,
            positional: PositionalRule::None,
        },
        "mv" => SubcommandSpec {
            flags: FLAGS_MV,
            positional: PositionalRule::Count(2),
        },
        "rm" => SubcommandSpec {
            flags: FLAGS_RM,
            positional: PositionalRule::None,
        },
        "stash" => SubcommandSpec {
            flags: FLAGS_STASH,
            positional: PositionalRule::StashSubcommand,
        },
        "log" => SubcommandSpec {
            flags: FLAGS_LOG,
            positional: PositionalRule::None,
        },
        "rev-parse" => SubcommandSpec {
            flags: FLAGS_REV_PARSE,
            positional: PositionalRule::Only(&["HEAD"]),
        },
        _ => return None,
    };
    Some(spec)
}

/// git 命令执行结果（camelCase 序列化，对齐 gitApi.ts 契约）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRunResult {
    ok: bool,
    stdout: String,
    stderr: String,
    timed_out: bool,
    truncated: bool,
}

/// 本机 git 命令：参数数组执行，禁 shell（T07.3 C-02 修复）。
#[tauri::command]
// G2 禁令豁免（clippy.toml 文件头「豁免面」）：git 白名单执行面——固定二进制
// `git` + 参数 schema 白名单（validate_git_args）+ 工作区注册表 cwd 校验，
// 无任意命令面，是本壳 git 命令的唯一执行点。
#[allow(clippy::disallowed_methods)]
pub(crate) async fn workbench_git_run(
    app: tauri::AppHandle,
    cwd: String,
    git_args: Vec<String>,
    timeout_ms: Option<u64>,
) -> Result<GitRunResult, String> {
    // 1. cwd 校验：canonicalize 后必须 ∈ WorkspaceRegistry 已授权根子树
    let git_cwd = resolve_git_cwd(&app, &cwd)?;

    // 2. 参数 schema 白名单校验（返回经 `:(literal)` 处理后的参数）
    let validated = validate_git_args(&git_args)?;

    // 3. 超时 clamp：默认 30s，上限 120s
    let timeout_ms = timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);

    // 4. 执行：参数数组直传，无任何外壳解释面
    let mut child_cmd = TokioCommand::new("git");
    child_cmd
        .args(&validated)
        .current_dir(&git_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        child_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = child_cmd
        .spawn()
        .map_err(|e| format!("failed to spawn git: {e}"))?;
    let child_pid = child.id();

    let wait_fut = child.wait_with_output();
    let timed = timeout(Duration::from_millis(timeout_ms), wait_fut).await;

    match timed {
        Ok(Ok(output)) => {
            let (stdout, trunc_out) = clamp_output_bytes(&output.stdout);
            let (stderr, trunc_err) = clamp_output_bytes(&output.stderr);
            Ok(GitRunResult {
                ok: output.status.success(),
                stdout,
                stderr,
                timed_out: false,
                truncated: trunc_out || trunc_err,
            })
        }
        Ok(Err(e)) => Err(format!("git wait failed: {e}")),
        Err(_elapsed) => {
            // 超时：杀进程树（taskkill /T /F，Unix kill -TERM）
            if let Some(pid) = child_pid {
                let _ = crate::process::terminate_process_tree(pid);
            }
            Ok(GitRunResult {
                ok: false,
                stdout: String::new(),
                stderr: format!("(git 命令超时，已终止 · {timeout_ms}ms)"),
                timed_out: true,
                truncated: false,
            })
        }
    }
}

/// cwd 校验：canonicalize 后必须 ∈ 已授权根子树（P-01 注册表）。
fn resolve_git_cwd(app: &tauri::AppHandle, cwd: &str) -> Result<PathBuf, String> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return Err(format!("{ERR_WORKSPACE_NOT_GRANTED}: cwd is empty"));
    }
    if cwd.contains('\0') {
        return Err(format!("{ERR_WORKSPACE_NOT_GRANTED}: cwd contains NUL byte"));
    }
    let path = Path::new(cwd);
    let canonical = path.canonicalize().map_err(|e| {
        format!("{ERR_WORKSPACE_NOT_GRANTED}: cannot resolve cwd `{cwd}`: {e}")
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "{ERR_WORKSPACE_NOT_GRANTED}: cwd is not a directory: `{cwd}`"
        ));
    }

    let reg = crate::workspace::registry(app)
        .map_err(|e| format!("{}: {}", e.code, e.message))?;
    let roots = reg.roots();
    if roots.iter().any(|root| is_same_or_child(&canonical, root)) {
        return Ok(canonical);
    }
    Err(format!(
        "{ERR_WORKSPACE_NOT_GRANTED}: cwd is outside the authorized workspace root: `{cwd}`"
    ))
}

/// 参数 schema 白名单校验。返回转换后的参数（路径参数已加 `:(literal)` 前缀）。
/// 未知 flag / 危险 flag / 越界 pathspec → `arg_not_allowed`。
fn validate_git_args(git_args: &[String]) -> Result<Vec<String>, String> {
    if git_args.is_empty() {
        return Err(format!("{ERR_ARG_NOT_ALLOWED}: empty git args"));
    }
    // 首参：子命令白名单（精确匹配）
    let subcommand = git_args[0].as_str();
    if !ALLOWED_SUBCOMMANDS.contains(&subcommand) {
        return Err(format!(
            "{ERR_ARG_NOT_ALLOWED}: subcommand `{subcommand}` is not in the whitelist"
        ));
    }
    if subcommand.contains('\0') || subcommand.len() > MAX_ARG_LEN {
        return Err(format!("{ERR_ARG_NOT_ALLOWED}: subcommand too long or contains NUL"));
    }

    let spec = spec_for(subcommand).expect("whitelist implies spec exists");
    let mut validated: Vec<String> = Vec::with_capacity(git_args.len());
    validated.push(subcommand.to_string());

    // 逐参数扫描：`--` 之前为 flag / 位置参数，`--` 之后为路径参数
    let mut i = 1;
    let mut after_separator = false;
    let mut positionals_seen: usize = 0;
    // commit -m 的消息值（-m 之后的单值参数）
    let mut pending_commit_message: Option<usize> = None;

    while i < git_args.len() {
        let arg = &git_args[i];
        if arg.contains('\0') {
            return Err(format!("{ERR_ARG_NOT_ALLOWED}: argument contains NUL byte"));
        }
        if arg.len() > MAX_ARG_LEN {
            return Err(format!(
                "{ERR_ARG_NOT_ALLOWED}: argument exceeds {MAX_ARG_LEN} bytes"
            ));
        }

        if after_separator {
            // `--` 之后的路径参数：字面量化 + 拒绝 magic 前缀
            validated.push(literal_pathspec(arg)?);
            i += 1;
            continue;
        }

        if arg == "--" {
            after_separator = true;
            validated.push("--".to_string());
            i += 1;
            continue;
        }

        if arg.starts_with('-') {
            // flag：必须在当前子命令允许集内
            if !spec.flags.contains(&arg.as_str()) {
                return Err(format!(
                    "{ERR_ARG_NOT_ALLOWED}: flag `{arg}` is not allowed for `{subcommand}`"
                ));
            }
            if subcommand == "commit" && arg == "-m" {
                // -m 后的下一个参数为消息值（位置参数，BareValue 语义）
                pending_commit_message = Some(i + 1);
            }
            validated.push(arg.clone());
            i += 1;
            continue;
        }

        // 位置参数（`--` 之前）
        match spec.positional {
            PositionalRule::None => {
                return Err(format!(
                    "{ERR_ARG_NOT_ALLOWED}: unexpected argument `{arg}` for `{subcommand}`"
                ));
            }
            PositionalRule::Only(allowed) => {
                if !allowed.contains(&arg.as_str()) {
                    return Err(format!(
                        "{ERR_ARG_NOT_ALLOWED}: argument `{arg}` is not allowed for `{subcommand}`"
                    ));
                }
                positionals_seen += 1;
                validated.push(arg.clone());
            }
            PositionalRule::BranchName => {
                if !is_valid_branch_name(arg) {
                    return Err(format!(
                        "{ERR_ARG_NOT_ALLOWED}: invalid branch name `{arg}`"
                    ));
                }
                positionals_seen += 1;
                validated.push(arg.clone());
            }
            PositionalRule::BareValue => {
                if subcommand == "commit" && pending_commit_message == Some(i) {
                    // 提交信息：字面量进数组本就无注入面，校验仅为资源上限
                    positionals_seen += 1;
                    validated.push(arg.clone());
                } else {
                    return Err(format!(
                        "{ERR_ARG_NOT_ALLOWED}: unexpected argument `{arg}` for `{subcommand}`"
                    ));
                }
            }
            PositionalRule::Count(max) => {
                if positionals_seen >= max {
                    return Err(format!(
                        "{ERR_ARG_NOT_ALLOWED}: too many arguments for `{subcommand}`"
                    ));
                }
                positionals_seen += 1;
                validated.push(arg.clone());
            }
            PositionalRule::StashSubcommand => {
                const STASH_ACTIONS: &[&str] = &["push", "list", "pop", "apply", "drop"];
                if positionals_seen == 0 {
                    if !STASH_ACTIONS.contains(&arg.as_str()) {
                        return Err(format!(
                            "{ERR_ARG_NOT_ALLOWED}: invalid stash action `{arg}`"
                        ));
                    }
                } else if positionals_seen > 1 {
                    return Err(format!(
                        "{ERR_ARG_NOT_ALLOWED}: too many arguments for `stash`"
                    ));
                }
                positionals_seen += 1;
                validated.push(arg.clone());
            }
        }
        i += 1;
    }

    Ok(validated)
}

/// 路径参数字面量化：拒绝 `:` / `^` 起始（防 pathspec 魔法），强制加 `:(literal)`。
fn literal_pathspec(arg: &str) -> Result<String, String> {
    if arg.starts_with(':') || arg.starts_with('^') {
        return Err(format!(
            "{ERR_ARG_NOT_ALLOWED}: pathspec magic prefix not allowed: `{arg}`"
        ));
    }
    Ok(format!(":(literal){arg}"))
}

/// 分支名校验：`^[A-Za-z0-9._/-]{1,255}$` 且不以 `-` 开头。
fn is_valid_branch_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 255 || name.starts_with('-') {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
}

/// 输出截断：保留头尾各一半，中间省略（对齐 process.rs clamp_output_bytes）。
fn clamp_output_bytes(raw: &[u8]) -> (String, bool) {
    if raw.len() <= MAX_OUTPUT_BYTES {
        return (decode_console_bytes(raw), false);
    }
    let half = MAX_OUTPUT_BYTES / 2;
    let head = &raw[..half];
    let tail = &raw[raw.len() - half..];
    let omitted = raw.len() - head.len() - tail.len();
    let text = format!(
        "{}\n\n[output truncated: {omitted} bytes omitted]\n\n{}",
        decode_console_bytes(head),
        decode_console_bytes(tail),
    );
    (text, true)
}

/// 控制台字节解码：先按 UTF-8，失败 lossy（Windows 控制台偶发本机代码页）。
fn decode_console_bytes(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => String::from_utf8_lossy(raw).into_owned(),
    }
}

/// 路径包含性判断（组件边界，Windows 大小写不敏感 + \\?\ 剥离），
/// 与 fs_commands::types::path_is_same_or_child 语义一致。
fn is_same_or_child(path: &Path, root: &Path) -> bool {
    crate::fs_commands::types::path_is_same_or_child(path, root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_has_fifteen_subcommands() {
        assert_eq!(ALLOWED_SUBCOMMANDS.len(), 15);
        assert_eq!(
            ALLOWED_SUBCOMMANDS,
            &[
                "status", "diff", "add", "reset", "checkout", "clean", "commit", "push",
                "branch", "restore", "mv", "rm", "stash", "log", "rev-parse",
            ]
        );
    }

    /// T07.3 用例 1：`["add","--","x;calc.exe"]` → 通过校验且路径字面量化。
    #[test]
    fn literal_pathspec_prefix_added_after_separator() {
        let args = vec!["add".to_string(), "--".to_string(), "x;calc.exe".to_string()];
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
            let args = vec![
                "add".to_string(),
                "--".to_string(),
                name.to_string(),
            ];
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
            let args = vec![
                "add".to_string(),
                "--".to_string(),
                name.to_string(),
            ];
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
            vec!["diff", "--no-color", "--no-ext-diff", "--cached", "--", "src/main.rs"],
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
            let validated = validate_git_args(&args).unwrap_or_else(|e| {
                panic!("case {case:?} must pass, got: {e}")
            });
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
}
