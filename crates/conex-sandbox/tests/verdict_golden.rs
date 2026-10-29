//! R1 旧实现金样逐条对拍。
//!
//! 与旧值不同的行必须在 [`EXPECTED`] 中逐字段列出并写明理由；未列出的行必须与
//! 金样逐字段完全一致。放宽方向硬失败（门禁/权限降级、pure_read_only 0→1、
//! delete_targets 丢目标、has_indirect_delete 1→0、Redline→非 Redline、
//! 非 Normal→Normal）。

use conex_sandbox::gatekeeper::GatekeeperResult;
use conex_sandbox::verdict::{PermissionVerdict, WorkspaceCtx};
use conex_sandbox::{assess, ApprovalReason, CommandClass};

const CWD_IN: &str = "C:/work/project";
const ROOT: &str = "C:/work/project";
const CWD_OUT: &str = "C:/Windows/System32";

/// 新裁决的精确文本，与 [`permission_text`] 同格式：
/// `Allow` / `Deny:<reason>` / `RequireApproval:<category>:<summary>`。
/// 一条与旧金样不同的行。所有承载字段显式写出，禁止只写差值。
struct Expected {
    command: &'static str,
    gk: GatekeeperResult,
    gk_in: GatekeeperResult,
    gk_out: GatekeeperResult,
    permission: &'static str,
    pure_ro: bool,
    class: CommandClass,
    delete_targets: &'static [&'static str],
    indirect_delete: bool,
    git_forms: &'static [&'static str],
    decoded: &'static str,
    /// 为什么与旧值不同（变严或同级变化）。
    reason: &'static str,
}

/// 与旧金样不同的行。未列出的行必须逐字段等于旧值。
///
/// 表内每一行都完整写出新裁决的全部承载字段（含 gk/gk_in/gk_out）；
/// `blocked_row!` 只用于三处地板均为 Blocked 的常规条目，不平移任何字段。
const DENY_SEM: &str =
    "Deny:系统毁灭性操作已被安全策略严格阻断（Redline）：语义分类判定为确定性毁灭目标";
const DENY_DELETE: &str =
    "Deny:系统毁灭性操作已被安全策略严格阻断（Redline）：禁止对根目录或系统核心路径执行破坏性删除";
const DENY_NO_PRESERVE_ROOT: &str =
    "Deny:系统毁灭性操作已被安全策略严格阻断（Redline）：禁止使用 --no-preserve-root";

macro_rules! blocked_row {
    ($command:expr, $permission:expr, $class:expr, $delete_targets:expr, $reason:expr) => {
        Expected {
            command: $command,
            gk: GatekeeperResult::Blocked,
            gk_in: GatekeeperResult::Blocked,
            gk_out: GatekeeperResult::Blocked,
            permission: $permission,
            pure_ro: false,
            class: $class,
            delete_targets: $delete_targets,
            indirect_delete: false,
            git_forms: &[],
            decoded: "",
            reason: $reason,
        }
    };
}

const EXPECTED: &[Expected] = &[
    blocked_row!(
        "sudo rm -rf /",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：sudo 包裹内层 rm -rf /（旧 smart 仅给提权审批）"
    ),
    blocked_row!(
        "sudo bash -c 'rm -rf /'",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：sudo→bash -c 内层 rm -rf /"
    ),
    blocked_row!(
        "eval rm -rf /",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：eval 内层 rm -rf /"
    ),
    blocked_row!(
        "r`i C:\\ -Recurse -Force",
        DENY_DELETE,
        CommandClass::Redline,
        &["C:\\"],
        "语义红线：反引号归一为 ri→remove-item 后命中根目标+递归"
    ),
    blocked_row!(
        "R`em`ove-Item C:\\ -Force -Recurse",
        DENY_DELETE,
        CommandClass::Redline,
        &["C:\\"],
        "语义红线：反引号归一为 remove-item 后命中根目标+递归"
    ),
    blocked_row!(
        "& cmd /c rm -rf /",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：& 调用运算符→cmd /c 内层 rm -rf /"
    ),
    blocked_row!(
        "& cmd.exe /c format D:",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：&→cmd.exe /c format 系统盘"
    ),
    blocked_row!(
        "format",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：显式红线命令 format（旧 smart 仅审批）"
    ),
    blocked_row!(
        "dd",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：显式红线命令 dd（旧 smart 仅审批）"
    ),
    blocked_row!(
        "restart-computer",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：显式红线命令 restart-computer（旧 smart 仅对 -Force 拒绝）"
    ),
    blocked_row!(
        "echo \"$(rm -rf -- /)\"",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：命令替换包裹内容递归命中"
    ),
    blocked_row!(
        "echo \"$(bash -c 'rm -rf -- /')\"",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：命令替换内 bash -c 递归命中"
    ),
    blocked_row!(
        "echo `rm -rf -- /`",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：反引号包裹内容递归命中"
    ),
    blocked_row!(
        "iex 'rm -rf -- /'",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：iex 内层 rm -rf -- /"
    ),
    blocked_row!(
        "Invoke-Expression 'rm -rf -- /'",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：Invoke-Expression 内层 rm -rf -- /"
    ),
    blocked_row!(
        "IEX 'rm -rf -- /'",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：IEX 别名内层 rm -rf -- /"
    ),
    blocked_row!(
        "iex.exe 'rm -rf -- /'",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：iex.exe 归一后内层 rm -rf -- /"
    ),
    blocked_row!(
        "Start-Process cmd -ArgumentList '/c rm -rf -- /'",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：Start-Process→cmd /c 内层 rm -rf -- /"
    ),
    Expected {
        command: "ri C:\\temp\\f.txt",
        gk: GatekeeperResult::Allowed,
        gk_in: GatekeeperResult::Allowed,
        gk_out: GatekeeperResult::RequiresApproval,
        permission: "RequireApproval:DestructiveDelete:破坏性删除：C:\\temp\\f.txt",
        pure_ro: false,
        class: CommandClass::DeleteShape,
        delete_targets: &["C:\\temp\\f.txt"],
        indirect_delete: false,
        git_forms: &[],
        decoded: "",
        reason: "同级变化：统一 Segment 使 ri 归一为 remove-item，原因 UnsafeSideEffect→DestructiveDelete",
    },
    blocked_row!(
        "ri C:\\ -Recurse -Force",
        DENY_DELETE,
        CommandClass::Redline,
        &["C:\\"],
        "语义红线：ri 归一为 remove-item 后命中根目标+递归"
    ),
    blocked_row!(
        "$x = Remove-Item C:\\ -Recurse -Force",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：赋值参数扫描命中 remove-item 根删除（语义层红线）"
    ),
    blocked_row!(
        "$x = ri C:\\ -Recurse -Force",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：赋值参数扫描命中 ri→remove-item 根删除"
    ),
    Expected {
        command: "rm C:\\my\\ dir\\a.txt",
        gk: GatekeeperResult::Allowed,
        gk_in: GatekeeperResult::Allowed,
        gk_out: GatekeeperResult::RequiresApproval,
        permission: "RequireApproval:DestructiveDelete:破坏性删除：C:\\my dir\\a.txt",
        pure_ro: false,
        class: CommandClass::DeleteShape,
        delete_targets: &["C:\\my dir\\a.txt"],
        indirect_delete: false,
        git_forms: &[],
        decoded: "",
        reason: "同级变化：统一拆参把转义空白并入同一 token，审批目标文本由两个变为一个",
    },
    blocked_row!(
        "[System.Diagnostics.Process]::Start('cmd.exe', '/c del /f /q C:\\*')",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：反射启动 [System.Diagnostics.Process]::Start"
    ),
    blocked_row!(
        "rm -rf --no-preserve-root",
        DENY_NO_PRESERVE_ROOT,
        CommandClass::DeleteShape,
        &[],
        "floor 收口：旧 gatekeeper 未消费 smart 的 Deny，新地板 Blocked"
    ),
    blocked_row!(
        "bash -lc \"rm -rf /\"",
        DENY_DELETE,
        CommandClass::Normal,
        &[],
        "floor 收口：bash -lc 内层红线纳入地板（旧 gatekeeper 只看语义 Normal）"
    ),
    blocked_row!(
        "rm -r /etc",
        DENY_DELETE,
        CommandClass::DeleteShape,
        &["/etc"],
        "floor 收口：smart 的系统核心路径红线纳入地板"
    ),
    blocked_row!(
        "dd if=a of=./out.img",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：dd 属显式红线命令（旧 smart 仅审批）"
    ),
    blocked_row!(
        "Restart-Computer",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：显式红线命令 restart-computer"
    ),
    Expected {
        command: "\"r`i\" C:\\",
        gk: GatekeeperResult::Allowed,
        gk_in: GatekeeperResult::Allowed,
        gk_out: GatekeeperResult::RequiresApproval,
        permission: "RequireApproval:DestructiveDelete:破坏性删除：C:\\",
        pure_ro: false,
        class: CommandClass::DeleteShape,
        delete_targets: &["C:\\"],
        indirect_delete: false,
        git_forms: &[],
        decoded: "",
        reason: "同级变化：引号+反引号归一为 remove-item，原因 UnsafeSideEffect→DestructiveDelete",
    },
    blocked_row!(
        "powershell -ec {}",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：编码载荷不可解码"
    ),
    blocked_row!(
        "powershell -enc {}",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：编码载荷不可解码"
    ),
    blocked_row!(
        "pwsh -EncodedCommand {}",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：编码载荷不可解码"
    ),
    blocked_row!(
        "Write-Output x\nri C:\\ -Recurse -Force",
        DENY_DELETE,
        CommandClass::Redline,
        &["C:\\"],
        "语义红线：换行后第二段 ri 归一为 remove-item 根删除"
    ),
    blocked_row!(
        "rm -rf\\ /",
        DENY_DELETE,
        CommandClass::DeleteShape,
        &[],
        "floor 收口：转义空白并入 -rf / 后 smart 红线纳入地板（旧静态正则漏）"
    ),
    blocked_row!(
        "rm -rf -- /usr",
        DENY_DELETE,
        CommandClass::DeleteShape,
        &["/usr"],
        "floor 收口：smart 的系统核心路径红线纳入地板"
    ),
    blocked_row!(
        "rm -rf -- /bin",
        DENY_DELETE,
        CommandClass::DeleteShape,
        &["/bin"],
        "floor 收口：smart 的系统核心路径红线纳入地板"
    ),
    blocked_row!(
        "rm -rf /var",
        DENY_DELETE,
        CommandClass::DeleteShape,
        &["/var"],
        "floor 收口：smart 的系统核心路径红线纳入地板"
    ),
    blocked_row!(
        "rm -rf /var/log",
        DENY_DELETE,
        CommandClass::DeleteShape,
        &["/var/log"],
        "floor 收口：smart 的系统核心路径红线纳入地板"
    ),
    blocked_row!(
        "rm -rf /usr/bin",
        DENY_DELETE,
        CommandClass::DeleteShape,
        &["/usr/bin"],
        "floor 收口：smart 的系统核心路径红线纳入地板"
    ),
    blocked_row!(
        "rm -rf /boot",
        DENY_DELETE,
        CommandClass::DeleteShape,
        &["/boot"],
        "floor 收口：smart 的系统核心路径红线纳入地板"
    ),
    blocked_row!(
        "rm -rf /root",
        DENY_DELETE,
        CommandClass::DeleteShape,
        &["/root"],
        "floor 收口：smart 的系统核心路径红线纳入地板"
    ),
    blocked_row!(
        "rm -rf /sys",
        DENY_DELETE,
        CommandClass::DeleteShape,
        &["/sys"],
        "floor 收口：smart 的系统核心路径红线纳入地板"
    ),
    blocked_row!(
        "rm -rf /dev",
        DENY_DELETE,
        CommandClass::DeleteShape,
        &["/dev"],
        "floor 收口：smart 的系统核心路径红线纳入地板"
    ),
    blocked_row!(
        "rm -rf /lib",
        DENY_DELETE,
        CommandClass::DeleteShape,
        &["/lib"],
        "floor 收口：smart 的系统核心路径红线纳入地板"
    ),
    blocked_row!(
        "env rm -rf /",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：env 参数扫描命中 rm -rf /（旧 smart 放行）"
    ),
    blocked_row!(
        "env -i rm -rf /",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：env -i 参数扫描命中 rm -rf /"
    ),
    blocked_row!(
        "FOO=bar rm -rf /",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：赋值前缀参数扫描命中 rm -rf /"
    ),
    blocked_row!(
        "sudo env rm -rf /",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：sudo→env→rm 参数扫描"
    ),
    blocked_row!(
        "sudo -u root rm -rf /",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：sudo 参数内层扫描命中 rm -rf /"
    ),
    blocked_row!(
        "sudo -- rm -rf /",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：sudo -- 参数内层扫描命中 rm -rf /"
    ),
    blocked_row!(
        "command rm -rf /",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：command 前缀参数扫描命中 rm -rf /"
    ),
    blocked_row!(
        "busybox rm -rf /",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：busybox 前缀参数扫描命中 rm -rf /"
    ),
    blocked_row!(
        "Sudo RM -RF /",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：大小写变体归一后命中 rm -rf /"
    ),
    blocked_row!(
        "SuDo bash -c 'rm -rf /'",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：大小写变体 sudo→bash -c 内层"
    ),
    blocked_row!(
        "{ rm -rf /; }",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：scriptblock 包裹递归命中"
    ),
    blocked_row!(
        "$(rm -rf /)",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：命令替换递归命中"
    ),
    blocked_row!(
        "`rm -rf /`",
        DENY_DELETE,
        CommandClass::Redline,
        &["/"],
        "语义红线：反引号包裹+统一拆参后命中根目标"
    ),
    blocked_row!(
        "bash -lc 'rm -rf /'",
        DENY_DELETE,
        CommandClass::Normal,
        &[],
        "floor 收口：bash -lc 内层红线纳入地板（旧 gatekeeper 只看语义 Normal）"
    ),
    blocked_row!(
        "bash -c \"sudo rm -rf /\"",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：bash -c→sudo→rm -rf /"
    ),
    blocked_row!(
        "eval \"eval rm -rf /\"",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：eval 嵌套内层 rm -rf /"
    ),
    blocked_row!(
        "eval 'rm -rf /'",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：eval 内层 rm -rf /"
    ),
    blocked_row!(
        "& \"Remove-Item\" C:\\ -Recurse -Force",
        DENY_SEM,
        CommandClass::Redline,
        &["C:\\"],
        "语义红线：& 调用运算符→Remove-Item 根删除"
    ),
    blocked_row!(
        "& rm -rf /",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：& 调用运算符内层 rm -rf /"
    ),
    blocked_row!(
        "iex \"rm -rf /\"",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：iex 内层 rm -rf /"
    ),
    blocked_row!(
        "Invoke-Expression \"Remove-Item C:\\ -Recurse -Force\"",
        DENY_SEM,
        CommandClass::Redline,
        &["C:\\"],
        "语义红线：Invoke-Expression 内层 Remove-Item 根删除"
    ),
    blocked_row!(
        "IEX \"rm -rf /\"",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：IEX 别名内层 rm -rf /"
    ),
    Expected {
        command: "cmd /c del /f /q C:\\Windows\\Temp\\*",
        gk: GatekeeperResult::Blocked,
        gk_in: GatekeeperResult::Blocked,
        gk_out: GatekeeperResult::Blocked,
        permission: DENY_DELETE,
        pure_ro: false,
        class: CommandClass::Indirect,
        delete_targets: &["C:\\Windows\\Temp\\*"],
        indirect_delete: true,
        git_forms: &[],
        decoded: "",
        reason: "floor 收口：间接删除的 smart 红线纳入地板（旧 gatekeeper 仅审批）",
    },
    blocked_row!(
        "rm\u{a0}-rf /",
        DENY_DELETE,
        CommandClass::Redline,
        &["/"],
        "语义红线：U+00A0 空白变体经统一拆参识别为 rm -rf /"
    ),
    blocked_row!(
        "dd if=/dev/zero of=./file bs=1 count=1",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：dd 属显式红线命令"
    ),
    blocked_row!(
        "dd if=./a of=./b",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：dd 属显式红线命令"
    ),
    blocked_row!(
        "Restart-Computer -WhatIf",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：restart-computer 显式红线（旧 smart 仅对 -Force 拒绝）"
    ),
    blocked_row!(
        "Remove-Item -Path C:\\Windows\\* -Recurse -Force",
        DENY_DELETE,
        CommandClass::DeleteShape,
        &["C:\\Windows\\*"],
        "floor 收口：smart 的系统核心路径红线纳入地板"
    ),
    blocked_row!(
        "ri C:\\Windows -Recurse -Force",
        DENY_DELETE,
        CommandClass::DeleteShape,
        &["C:\\Windows"],
        "语义红线：ri 归一 remove-item 后命中系统核心路径；floor 同步 Blocked"
    ),
    blocked_row!(
        "doas rm -rf /",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：doas 前缀参数扫描命中 rm -rf /"
    ),
    blocked_row!(
        "pkexec rm -rf /",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：pkexec 前缀参数扫描命中 rm -rf /"
    ),
    blocked_row!(
        "bash -c 'echo $(rm -rf /)'",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：bash -c 内层命令替换递归"
    ),
    blocked_row!(
        "pwsh -Command \"iex 'rm -rf /'\"",
        DENY_SEM,
        CommandClass::Redline,
        &["/"],
        "语义红线：pwsh -Command→iex 内层 rm -rf /"
    ),
    blocked_row!(
        "echo \"`rm -rf /`\"",
        DENY_SEM,
        CommandClass::Redline,
        &[],
        "语义红线：双引号内反引号包裹递归命中"
    ),
];

#[test]
fn golden_rows_match_expected_or_old() {
    let text = include_str!("fixtures/verdict_golden.tsv");
    let rows = parse_rows(text);
    assert!(rows.len() >= 300, "金样行数不足：{}", rows.len());
    assert_eq!(
        rows.iter()
            .filter(|row| EXPECTED
                .iter()
                .any(|exp| exp.command == row.command.as_str()))
            .count(),
        EXPECTED.len(),
        "EXPECTED 含金样里不存在的命令"
    );
    let mut unexpected = Vec::new();
    let mut loose = Vec::new();
    for row in &rows {
        let measured = measure(&row.command);
        if let Some(exp) = EXPECTED
            .iter()
            .find(|exp| exp.command == row.command.as_str())
        {
            assert_explicit(exp, &measured);
            if !differs(row, &measured) {
                unexpected.push(format!("EXPECTED 条目与旧值完全相同：{}", row.command));
            }
        } else if differs(row, &measured) {
            unexpected.push(describe(row, &measured));
        }
        check_not_looser(row, &measured, &mut loose);
    }
    assert!(
        unexpected.is_empty(),
        "未列入 EXPECTED 的变更：\n{}",
        unexpected.join("\n")
    );
    assert!(loose.is_empty(), "放宽裁决：\n{}", loose.join("\n"));
}

/// R3 ①：金样每一行只要语义红线成立，地板必须是 Blocked。
#[test]
fn r3_redline_implies_blocked_floor() {
    let text = include_str!("fixtures/verdict_golden.tsv");
    for row in parse_rows(text) {
        let analysis = assess(&row.command);
        if analysis.redline.is_some() {
            assert_eq!(
                analysis.floor_verdict(None),
                GatekeeperResult::Blocked,
                "红线必须地板 Blocked：{}",
                display(&row.command)
            );
        }
    }
}

/// R3 ③：静态命中不等于语义红线。文本里出现 `rm -rf /` 只封锁地板，
/// 权限裁决保持 Allow。
#[test]
fn r3_static_hit_is_floor_only() {
    let analysis = assess("echo rm -rf /");
    assert!(analysis.redline.is_none(), "echo 文本不得判为语义红线");
    assert_eq!(
        analysis.permission_verdict(),
        PermissionVerdict::Allow,
        "静态命中不得把 Allow 变 Deny"
    );
    assert_eq!(
        analysis.floor_verdict(None),
        GatekeeperResult::Blocked,
        "静态命中必须由地板兜底"
    );
}

struct Row {
    command: String,
    gk: GatekeeperResult,
    gk_in: GatekeeperResult,
    gk_out: GatekeeperResult,
    smart_kind: String,
    smart_detail: String,
    pure_ro: bool,
    sem_class: CommandClass,
    delete_targets: String,
    indirect: bool,
    git_forms: String,
    decoded: String,
}

struct Measured {
    gk: GatekeeperResult,
    gk_in: GatekeeperResult,
    gk_out: GatekeeperResult,
    permission: String,
    pure_ro: bool,
    class: CommandClass,
    delete_targets: Vec<String>,
    indirect: bool,
    git_forms: Vec<String>,
    decoded: String,
}

fn measure(command: &str) -> Measured {
    let analysis = assess(command);
    let permission = permission_text(&analysis.permission_verdict());
    let in_ctx = WorkspaceCtx {
        cwd: CWD_IN,
        workspace_root: ROOT,
    };
    let out_ctx = WorkspaceCtx {
        cwd: CWD_OUT,
        workspace_root: ROOT,
    };
    Measured {
        gk: analysis.floor_verdict(None),
        gk_in: analysis.floor_verdict(Some(&in_ctx)),
        gk_out: analysis.floor_verdict(Some(&out_ctx)),
        permission,
        pure_ro: analysis.pure_read_only,
        class: analysis.overall,
        delete_targets: analysis.delete_targets.clone(),
        indirect: analysis.has_indirect_delete,
        git_forms: analysis.git_revert_forms.clone(),
        decoded: analysis.decoded_payload.clone().unwrap_or_default(),
    }
}

fn assert_explicit(exp: &Expected, measured: &Measured) {
    assert_eq!(measured.gk, exp.gk, "{} gk", exp.command);
    assert_eq!(measured.gk_in, exp.gk_in, "{} gk_in", exp.command);
    assert_eq!(measured.gk_out, exp.gk_out, "{} gk_out", exp.command);
    assert_eq!(
        measured.permission, exp.permission,
        "{} permission",
        exp.command
    );
    assert_eq!(measured.pure_ro, exp.pure_ro, "{} pure_ro", exp.command);
    assert_eq!(measured.class, exp.class, "{} class", exp.command);
    assert_eq!(
        measured.delete_targets,
        exp.delete_targets
            .iter()
            .map(|item| item.to_string())
            .collect::<Vec<_>>(),
        "{} delete_targets",
        exp.command
    );
    assert_eq!(
        measured.indirect, exp.indirect_delete,
        "{} indirect",
        exp.command
    );
    assert_eq!(
        measured.git_forms,
        exp.git_forms
            .iter()
            .map(|item| item.to_string())
            .collect::<Vec<_>>(),
        "{} git_forms",
        exp.command
    );
    assert_eq!(measured.decoded, exp.decoded, "{} decoded", exp.command);
    assert!(!exp.reason.is_empty(), "{} 缺少理由", exp.command);
}

fn differs(row: &Row, measured: &Measured) -> bool {
    measured.gk != row.gk
        || measured.gk_in != row.gk_in
        || measured.gk_out != row.gk_out
        || measured.permission != old_permission_text(row)
        || measured.pure_ro != row.pure_ro
        || measured.class != row.sem_class
        || join_unit(&measured.delete_targets) != row.delete_targets
        || measured.indirect != row.indirect
        || join_unit(&measured.git_forms) != row.git_forms
        || measured.decoded != row.decoded
}

fn check_not_looser(row: &Row, measured: &Measured, loose: &mut Vec<String>) {
    for (label, old, new) in [
        ("gk", row.gk, measured.gk),
        ("gk_in", row.gk_in, measured.gk_in),
        ("gk_out", row.gk_out, measured.gk_out),
    ] {
        if gate_rank(new) < gate_rank(old) {
            loose.push(format!("{} {label} {:?}→{:?}", row.command, old, new));
        }
    }
    if permission_rank(&measured.permission) < old_permission_rank(row) {
        loose.push(format!(
            "{} permission {}→{}",
            row.command,
            old_permission_text(row),
            measured.permission
        ));
    }
    if !row.pure_ro && measured.pure_ro {
        loose.push(format!("{} pure_read_only 0→1", row.command));
    }
    if row.sem_class == CommandClass::Redline && measured.class != CommandClass::Redline {
        loose.push(format!(
            "{} class Redline→{:?}",
            row.command, measured.class
        ));
    }
    if row.sem_class != CommandClass::Normal && measured.class == CommandClass::Normal {
        loose.push(format!("{} class {:?}→Normal", row.command, row.sem_class));
    }
    let old_targets: Vec<&str> = if row.delete_targets.is_empty() {
        Vec::new()
    } else {
        row.delete_targets.split('\u{1f}').collect()
    };
    for target in old_targets {
        if !measured.delete_targets.iter().any(|item| item == target) {
            loose.push(format!("{} delete_targets 丢失 {target}", row.command));
        }
    }
    if row.indirect && !measured.indirect {
        loose.push(format!("{} has_indirect_delete 1→0", row.command));
    }
}

fn describe(row: &Row, measured: &Measured) -> String {
    format!(
        "{} | 旧 gk {:?}/{:?}/{:?} perm {} pure {} class {:?} del [{}] ind {} git [{}] dec {:?} || 新 gk {:?}/{:?}/{:?} perm {} pure {} class {:?} del [{}] ind {} git [{}] dec {:?}",
        escape(&row.command),
        row.gk,
        row.gk_in,
        row.gk_out,
        old_permission_text(row),
        row.pure_ro,
        row.sem_class,
        row.delete_targets.replace('\u{1f}', "|"),
        row.indirect,
        row.git_forms.replace('\u{1f}', "|"),
        row.decoded,
        measured.gk,
        measured.gk_in,
        measured.gk_out,
        measured.permission,
        measured.pure_ro,
        measured.class,
        measured.delete_targets.join("|"),
        measured.indirect,
        measured.git_forms.join("|"),
        measured.decoded,
    )
}

fn permission_text(verdict: &PermissionVerdict) -> String {
    match verdict {
        PermissionVerdict::Allow => "Allow".to_string(),
        PermissionVerdict::Deny(reason) => format!("Deny:{}", reason.as_str()),
        PermissionVerdict::RequireApproval(reason) => {
            format!(
                "RequireApproval:{}:{}",
                approval_category(reason),
                reason.summary()
            )
        }
    }
}

fn old_permission_text(row: &Row) -> String {
    if row.smart_kind == "Allow" {
        "Allow".to_string()
    } else if row.smart_kind == "Deny" {
        format!("Deny:{}", row.smart_detail)
    } else {
        format!("{}:{}", row.smart_kind, row.smart_detail)
    }
}

fn old_permission_rank(row: &Row) -> i32 {
    if row.smart_kind == "Allow" {
        0
    } else if row.smart_kind == "Deny" {
        2
    } else {
        1
    }
}

fn permission_rank(text: &str) -> i32 {
    if text == "Allow" {
        0
    } else if text.starts_with("Deny:") {
        2
    } else {
        1
    }
}

fn gate_rank(value: GatekeeperResult) -> i32 {
    match value {
        GatekeeperResult::Allowed => 0,
        GatekeeperResult::RequiresApproval => 1,
        GatekeeperResult::Blocked => 2,
    }
}

fn join_unit(items: &[String]) -> String {
    items.join("\u{1f}")
}

fn approval_category(reason: &ApprovalReason) -> &'static str {
    match reason {
        ApprovalReason::DestructiveDelete { .. } => "DestructiveDelete",
        ApprovalReason::GitHistoryRewrite { .. } => "GitHistoryRewrite",
        ApprovalReason::PrivilegeEscalation { .. } => "PrivilegeEscalation",
        ApprovalReason::RemotePipeExecution { .. } => "RemotePipeExecution",
        ApprovalReason::PackagePublish { .. } => "PackagePublish",
        ApprovalReason::UnsafeSideEffect { .. } => "UnsafeSideEffect",
    }
}

fn parse_rows(text: &str) -> Vec<Row> {
    text.lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let cols: Vec<&str> = line.split('\t').collect();
            assert_eq!(cols.len(), 13, "列数不对：{line}");
            Row {
                command: unescape(cols[0]),
                gk: gate(cols[1]),
                gk_in: gate(cols[2]),
                gk_out: gate(cols[3]),
                smart_kind: unescape(cols[4]),
                smart_detail: unescape(cols[5]),
                pure_ro: cols[6] == "1",
                sem_class: class(cols[7]),
                delete_targets: unescape(cols[8]),
                indirect: cols[9] == "1",
                git_forms: unescape(cols[10]),
                decoded: unescape(cols[11]),
            }
        })
        .collect()
}

fn gate(name: &str) -> GatekeeperResult {
    match name {
        "Allowed" => GatekeeperResult::Allowed,
        "Blocked" => GatekeeperResult::Blocked,
        "RequiresApproval" => GatekeeperResult::RequiresApproval,
        other => panic!("未知门禁：{other}"),
    }
}

fn class(name: &str) -> CommandClass {
    match name {
        "Normal" => CommandClass::Normal,
        "Redline" => CommandClass::Redline,
        "Dangerous" => CommandClass::Dangerous,
        "DeleteShape" => CommandClass::DeleteShape,
        "GitRevertShape" => CommandClass::GitRevertShape,
        "Indirect" => CommandClass::Indirect,
        other => panic!("未知分类：{other}"),
    }
}

fn unescape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('\\') => out.push('\\'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn escape(command: &str) -> String {
    command.replace('\n', "\\n").replace('\r', "\\r")
}

fn display(command: &str) -> String {
    escape(command)
}
