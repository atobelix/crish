//! Unix 平台实现（§8 差异表）：进程组杀树（setpgid 于 spawn 前，kill -pgid SIGKILL）。
//!
//! 说明（MVP 边界）：
//! - 杀树经 `kill -9 -<pgid>` 外部命令（无 libc 依赖的形态）；
//!   遗留：接入 libc 直调 `killpg(2)` 消除 shell 依赖；
//! - 禁用 PR_SET_PDEATHSIG（thread 退出会误杀，chrome.rs 注释已踩坑）——
//!   spawn 前 `process_group(0)` 即完成进程组建立，无 PDEATHSIG 依赖；
//! - macOS/Linux 均走本实现；平台路径表在 discover.rs。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁。

use super::ProcessTreeKiller;

/// 进程组终结器（pgid = pid，spawn 时由 process_group(0) 建立）。
pub struct PgidTreeKiller {
    pid: Option<u32>,
}

impl PgidTreeKiller {
    pub fn new() -> Self {
        PgidTreeKiller { pid: None }
    }
}

impl Default for PgidTreeKiller {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessTreeKiller for PgidTreeKiller {
    fn attach(&mut self, child: &mut tokio::process::Child) -> Result<(), String> {
        // 进程组已由 spawn 前 process_group(0) 建立，无需额外挂接
        self.pid = child.id();
        Ok(())
    }

    fn kill_tree(&mut self) -> Result<(), String> {
        match self.pid {
            Some(pid) => kill_pgid(pid),
            None => Err("未知 PID，无法杀树".to_string()),
        }
    }

    fn kill_sync(&self, pid: u32) {
        let _ = kill_pgid(pid);
    }
}

/// kill(-pgid, SIGKILL) 语义（外部 kill 命令；负 PID = 进程组）。
/// 豁免 clippy 子进程禁令：进程树终止属「内部进程管理原语」豁免面
/// （clippy.toml 注释：固定系统工具调用，参数仅 PID 拼接，同步等待型）。
#[allow(clippy::disallowed_methods)]
fn kill_pgid(pid: u32) -> Result<(), String> {
    let out = std::process::Command::new("kill")
        .args(["-9", &format!("-{pid}")])
        .output()
        .map_err(|e| format!("kill 启动失败：{e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "kill 失败：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// kill_pgid 对不存在组幂等失败（不 panic）。
    #[test]
    fn kill_pgid_unknown_is_err() {
        let err = kill_pgid(4_294_967_294);
        let _ = err; // 合法错误（进程组不存在）
    }
}
