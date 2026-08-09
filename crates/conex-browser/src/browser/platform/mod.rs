//! 平台差异收敛层（维度 10 §8 差异表）
//!
//! 主逻辑零 `cfg!`（接口化隔离）：进程管理侧只面对两个能力——
//! 1. `ProcessTreeKiller`：杀进程树（Windows Job Object 主方案 + taskkill 兜底；
//!    unix killpg 语义）；
//! 2. `spawn_command`：按平台附加 spawn 前参数（Windows CREATE_SUSPENDED 供 Job
//!    挂接前冻结；unix process_group(0) 供 killpg 杀树）。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁；Windows API 调用全部
//! `#[allow(unsafe_code)]` 局部化（与 agent-provider credentials.rs 同款）。

use std::path::Path;
use tokio::process::Command;

#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
mod unix;

/// 进程树终结器（spawn 时创建，生命周期绑定进程）。
pub trait ProcessTreeKiller: Send {
    /// 挂接（spawn 后立即调用）：
    /// - Windows：创建 Job Object + AssignProcessToJobObject + 恢复主线程
    ///   （CREATE_SUSPENDED 冻结窗口内完成挂接，KILL_ON_JOB_CLOSE 语义）；
    /// - unix：无操作（进程组已由 spawn 前 process_group(0) 建立）。
    fn attach(&mut self, child: &mut tokio::process::Child) -> Result<(), String>;
    /// 杀整棵树（失败返回原因，调用方记录 warning）。
    fn kill_tree(&mut self) -> Result<(), String>;
    /// 同步兜底（Drop 路径）：不依赖 async 运行时。
    fn kill_sync(&self, pid: u32);
}

/// 新建平台终结器。
pub fn new_killer() -> Box<dyn ProcessTreeKiller> {
    platform_impl::new_killer()
}

/// 按平台构造 spawn 命令（附加 kill 所需的 spawn 前参数）。
pub fn spawn_command(binary: &Path) -> Command {
    platform_impl::spawn_command(binary)
}

#[cfg(windows)]
mod platform_impl {
    use super::*;

    pub fn spawn_command(binary: &Path) -> Command {
        let mut cmd = Command::new(binary);
        // CREATE_SUSPENDED：冻结主线程，挂接 Job 后再恢复（§8 差异表主方案）；
        // creation_flags 为 tokio Command 原生方法（Windows）
        cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_SUSPENDED);
        cmd
    }

    pub fn new_killer() -> Box<dyn ProcessTreeKiller> {
        Box::new(crate::browser::platform::windows::JobTreeKiller::new())
    }
}

#[cfg(not(windows))]
mod platform_impl {
    use super::*;

    pub fn spawn_command(binary: &Path) -> Command {
        let mut cmd = Command::new(binary);
        // 子进程自建进程组（setpgid 语义）：杀树用 kill(-pgid, SIGKILL)；
        // process_group 为 tokio Command 原生方法（unix）
        cmd.process_group(0);
        cmd
    }

    pub fn new_killer() -> Box<dyn ProcessTreeKiller> {
        Box::new(crate::browser::platform::unix::PgidTreeKiller::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// kill_sync 对不存在的 PID 幂等（不 panic）。
    #[test]
    fn kill_sync_unknown_pid_is_noop() {
        let killer = new_killer();
        killer.kill_sync(4_294_967_294);
    }

    /// 终结器创建不失败。
    #[test]
    fn killer_constructs() {
        let _ = new_killer();
    }

    /// spawn_command 可构造（不 spawn）。
    #[test]
    fn spawn_command_constructs() {
        let _ = spawn_command(Path::new("not-a-real-binary"));
    }
}
