//! 进程树终止原语（强制 / 优雅，Windows 与 Unix 双实现；自 process.rs 原样搬迁）

use std::process::{Command, Stdio};

// ==================== Process Termination ====================

// G2 禁令豁免（clippy.toml 豁免面「内部进程管理原语」）：taskkill /PID /T /F
// 进程树强制终止（T-AB-06 孤儿保护显式 kill 路径）——命令对象为固定系统工具、
// 参数仅 PID 数字拼接（无用户自由参数）；output() 同步等待型，子进程不脱离
// 会话存活，与 spawn 禁令意图（防未 enroll 常驻子进程）不同。
#[allow(clippy::disallowed_methods)]
#[cfg(target_os = "windows")]
pub(crate) fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let output = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start taskkill: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

// G2 禁令豁免（clippy.toml 豁免面「内部进程管理原语」）：kill -TERM 进程树
// 终止（Unix 分支，同 Windows taskkill 语义）——固定系统工具 + PID 数字参数，
// output() 同步等待型，子进程不脱离会话存活。
#[allow(clippy::disallowed_methods)]
#[cfg(not(target_os = "windows"))]
pub(crate) fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let output = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start kill: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

// ── 优雅终止变体（T-AB-06）───────────────────────────────────────────────────
// 与 terminate_process_tree（强制）配对，供 R-AB2 两阶段终止（优雅 → 5s → 强制）
// 消费。返回 Result<(), String>，与 terminate_process_tree 同型（:323 同款）。

/// 优雅终止整个进程树：Windows `taskkill /PID <pid> /T`（去掉 /F，向进程树发送
/// 关闭请求）；Unix `kill -TERM <pid>`（SIGTERM 即优雅请求）。
///
/// Windows 诚实边界（本机已实测，登记新发现）：taskkill 无 /F 时通过 WM_CLOSE
/// 请求关闭**有顶层窗口且响应关闭消息**的进程；对控制台程序（powershell/cmd
/// 等）返回「只能通过强制终止」错误且进程不退出。调用方应把 Err 视为
/// 「优雅请求未生效」，随后按两阶段语义升级强制终止（R-AB2 T-AB-11 落地）。
// 本轮交付原语供 R-AB2 消费（测试已覆盖真实语义）；非测试构建暂未接线 →
// 显式豁免 dead_code。
// G2 禁令豁免（clippy.toml 豁免面「内部进程管理原语」）：taskkill /PID /T
// 进程树优雅终止（R-AB2 T-AB-11 两阶段终止优雅路径）——固定系统工具 + PID
// 数字参数，output() 同步等待型，子进程不脱离会话存活。
#[allow(dead_code)] // R-AB2 T-AB-11 两阶段终止消费
#[allow(clippy::disallowed_methods)]
#[cfg(target_os = "windows")]
pub(crate) fn terminate_process_tree_graceful(pid: u32) -> Result<(), String> {
    let output = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start taskkill: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[allow(dead_code)] // R-AB2 T-AB-11 两阶段终止消费（Unix 侧与强制路径同型）
#[cfg(not(target_os = "windows"))]
pub(crate) fn terminate_process_tree_graceful(pid: u32) -> Result<(), String> {
    // Unix 默认 kill -TERM 即优雅请求，与强制路径同型（无 /KILL 升级项）
    terminate_process_tree(pid)
}
