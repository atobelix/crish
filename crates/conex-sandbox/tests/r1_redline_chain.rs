//! PS-01 命令红线绕过链修复——集成回归测试（T1.5，红测试先行载体）。
//!
//! R1 安全复核（R1-security-recheck.md §一）实测：下列 8 形态经
//! `CommandGatekeeper::check_command` 全部返回 Allowed（修复前）。本文件
//! 在 gatekeeper 层（与 R1 实测同口径）钉死修复后必须全部 Blocked；
//! 对照组验证门禁本身不失灵，负例验证边界形态不误伤。
//!
//! 断言全部基于 `CommandGatekeeper::check_command(cmd, &[])` 返回值
//! （任务书 T1.5 验收标准；`check_command_with_context` 变体 cwd 与
//! workspace_root 相同，仅验证上下文路径不降级红线）。

use conex_sandbox::gatekeeper::{CommandGatekeeper, GatekeeperResult};

fn gk() -> CommandGatekeeper {
    CommandGatekeeper::new()
}

fn blocked(cmd: &str) {
    assert_eq!(
        gk().check_command(cmd, &[]),
        GatekeeperResult::Blocked,
        "命令 {cmd:?} 必须被红线拦截（Blocked）"
    );
}

fn allowed(cmd: &str) {
    assert_eq!(
        gk().check_command(cmd, &[]),
        GatekeeperResult::Allowed,
        "命令 {cmd:?} 必须放行（Allowed，不误伤）"
    );
}

// ===== 8/8 绕过形态：修复后必须全部 Blocked =====

#[test]
fn r1_chain_cmd_subst_blocked() {
    // 形态 1：$() 命令替换包裹（双引号内）
    blocked("echo \"$(rm -rf -- /)\"");
}

#[test]
fn r1_chain_backtick_blocked() {
    // 形态 2：反引号命令替换包裹
    blocked("echo `rm -rf -- /`");
}

#[test]
fn r1_chain_newline_printf_blocked() {
    // 形态 3：换行分隔（Unix）——printf x\n/bin/rm -rf -- /（真实换行符）
    blocked("printf x\n/bin/rm -rf -- /");
}

#[test]
fn r1_chain_ps_alias_newline_blocked() {
    // 形态 4：换行 + PS 删除别名 ri（Remove-Item 别名）——真实换行符
    blocked("Write-Output x\nri C:\\ -Recurse -Force");
}

#[test]
fn r1_chain_iex_blocked() {
    // 形态 5：iex 包裹（Invoke-Expression 别名）
    blocked("iex 'rm -rf -- /'");
}

#[test]
fn r1_chain_invoke_expression_blocked() {
    // 形态 6：Invoke-Expression 包裹
    blocked("Invoke-Expression 'rm -rf -- /'");
}

#[test]
fn r1_chain_start_process_blocked() {
    // 形态 7：Start-Process 包裹（间接启动 cmd 执行内层）
    blocked("Start-Process cmd -ArgumentList '/c rm -rf -- /'");
}

#[test]
fn r1_chain_encoded_command_blocked() {
    // 形态 8：-EncodedCommand base64 隐藏（R2 修订样本：
    // cgBtACAALQByAGYAIAAtAC0AIAAvAA== = UTF-16LE base64("rm -rf -- /")）
    blocked("powershell -EncodedCommand cgBtACAALQByAGYAIAAtAC0AIAAvAA==");
}

// ===== 对照组：门禁本身不失灵 =====

#[test]
fn r1_chain_control_baselines() {
    blocked("rm -rf -- /");
    blocked("sudo rm -rf /");
}

// ===== 上下文变体：cwd 与 workspace_root 相同时 8 形态仍 Blocked =====

#[test]
fn r1_chain_context_variant() {
    let gk = gk();
    let cmds = [
        "echo \"$(rm -rf -- /)\"",
        "echo `rm -rf -- /`",
        "printf x\n/bin/rm -rf -- /",
        "Write-Output x\nri C:\\ -Recurse -Force",
        "iex 'rm -rf -- /'",
        "Invoke-Expression 'rm -rf -- /'",
        "Start-Process cmd -ArgumentList '/c rm -rf -- /'",
        "powershell -EncodedCommand cgBtACAALQByAGYAIAAtAC0AIAAvAA==",
    ];
    for cmd in cmds {
        assert_eq!(
            gk.check_command_with_context(cmd, &[], "/workspace", "/workspace"),
            GatekeeperResult::Blocked,
            "上下文变体：命令 {cmd:?} 必须仍 Blocked"
        );
    }
}

// ===== 负例：边界形态不误伤 =====

#[test]
fn r1_chain_negative_newline_in_quotes() {
    // 引号内真实换行不拆段（quote 状态机），echo "a\nb" 保持单段 Normal
    allowed("echo \"a\nb\"");
}

#[test]
fn r1_chain_negative_env_var() {
    // 变量引用不是命令替换：$HOME 不提取；&& 链其余段 Normal → Allowed
    allowed("echo $HOME && git status");
}
