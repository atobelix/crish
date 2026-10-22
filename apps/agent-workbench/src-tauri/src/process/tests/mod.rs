//! process 单元测试（自 process.rs 内联 `mod tests` 原样搬迁，按主题分文件）；
//! 本文件保留两个子文件共用的子进程等待 / 存活探测 helper。

// G2 禁令豁免：测试 mod——真实 spawn 探测命令门禁语义（11 红线下目标
// 断言 Blocked）+ pid 存活探测（tasklist / kill -0，T-AB-06/07 验收辅助），
// 非产品执行面；测试 mod 内 allow + 理由（对齐 clippy.toml 豁免面）。
#![allow(clippy::disallowed_methods)]
use super::*;

mod jobs_and_terminate;
mod shell;

/// 等待子进程在窗口内退出（std 轮询，供真实 spawn 测试用）。
fn wait_child_exit(child: &mut std::process::Child, window: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + window;
    loop {
        if child.try_wait().expect("try_wait").is_some() {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// 进程是否存活（Windows tasklist 过滤；Unix kill -0）。
#[cfg(windows)]
fn pid_is_alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}")])
        .output()
        .expect("tasklist must run");
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

#[cfg(not(windows))]
fn pid_is_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
