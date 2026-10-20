//! Unix 平台实现（§8 差异表）：进程组杀树（setpgid 于 spawn 前，killpg(-pgid, SIGKILL)）。
//!
//! 平台约束（G-10 收尾）：
//! - 杀树经 libc 直调 `killpg(2)`（POSIX 通用，macOS/Linux 均可用），无 shell
//!   依赖；`killpg(pgid, sig)` 等价 `kill(-pgid, sig)`（负 PID = 进程组）；
//! - 错误语义按 `kill(pid, 0)` 存活探测对齐：ESRCH（进程组不存在）= 探测为假，
//!   杀树目标已达成 → 幂等 Ok；EPERM（进程组存在但信号被拒）= 探测为真但杀不掉
//!   → Err（调用方告警）；
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
        // Drop 路径不得 panic、不得改变控制流；失败仅告警（可能是 EPERM 或进程组
        // 已随父进程消亡，后者由 killpg_result 幂等吞为 Ok）
        if let Err(e) = kill_pgid(pid) {
            tracing::warn!("同步兜底杀进程组失败（Drop 路径，进程可能残留）：{e}");
        }
    }
}

/// killpg(pgid, SIGKILL) 直调（libc，无 shell 依赖；G-10 收尾）。
/// libc 调用为 unsafe：错误经 errno 面（last_os_error）转出，无内存不安全面，
/// unsafe 局部化（workspace 逐处评审惯例）。
#[allow(unsafe_code)]
fn kill_pgid(pid: u32) -> Result<(), String> {
    // u32 → pid_t 溢出防护：超范围 PID 不可能存在，直接 Err，不进入 libc
    // （as 回绕会得到负 pgid，误伤其他进程组）
    let Ok(pgid) = libc::pid_t::try_from(pid) else {
        return Err(format!("PID {pid} 超出 pid_t 范围"));
    };
    let ret = unsafe { libc::killpg(pgid, libc::SIGKILL) };
    if ret == 0 {
        return Ok(());
    }
    let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    killpg_result(ret, errno)
}

/// killpg 返回码 → 结果映射（纯函数，可脱离 libc 单测）：
/// - 0：信号已投递（进程组存在，组内全部进程收到 SIGKILL）；
/// - ESRCH：进程组不存在 → Ok（幂等：与 `kill(pid, 0)` 存活探测语义对齐——
///   探测为假即目标已不存在，杀树目标视为达成，二次杀树不报错）；
/// - EPERM：进程组存在但无权限 → Err（探测语义下为「存活但不可杀」，需告警）；
/// - 其余 errno → Err（透传 errno 编号与名称，便于诊断）。
fn killpg_result(ret: i32, errno: i32) -> Result<(), String> {
    if ret == 0 {
        return Ok(());
    }
    match errno {
        libc::ESRCH => Ok(()),
        libc::EPERM => Err("killpg 权限不足（EPERM），进程组存在但信号被拒".to_string()),
        e => Err(format!("killpg 失败：errno={e}（{}）", errno_name(e))),
    }
}

/// errno → 名称映射（错误消息可读；常见值覆盖，未知透传编号）。
fn errno_name(errno: i32) -> &'static str {
    match errno {
        libc::EPERM => "EPERM",
        libc::ESRCH => "ESRCH",
        libc::EINVAL => "EINVAL",
        libc::EFAULT => "EFAULT",
        libc::EAGAIN => "EAGAIN",
        _ => "unknown",
    }
}

/// 测试门控：本文件仅非 Windows 平台编译（mod.rs 分派），libc 亦为 unix-only
/// 目标依赖；本机为 Windows 无法运行，由 CI ubuntu 覆盖。
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// 成功返回码映射为 Ok。
    #[test]
    fn killpg_result_ok() {
        assert!(killpg_result(0, 0).is_ok());
    }

    /// ESRCH（进程组不存在）幂等映射为 Ok：与 kill(pid,0) 存活探测语义对齐。
    #[test]
    fn killpg_result_esrch_is_idempotent_ok() {
        assert!(killpg_result(-1, libc::ESRCH).is_ok());
    }

    /// EPERM（组存在但信号被拒）必须为 Err 且消息可诊断。
    #[test]
    fn killpg_result_eperm_is_err() {
        let err = killpg_result(-1, libc::EPERM).unwrap_err();
        assert!(err.contains("EPERM"), "err = {err}");
    }

    /// 未知 errno 透传编号与名称。
    #[test]
    fn killpg_result_unknown_errno_is_err() {
        let err = killpg_result(-1, 9_999).unwrap_err();
        assert!(err.contains("9999"), "err = {err}");
        assert!(err.contains("unknown"), "err = {err}");
    }

    /// 超 pid_t 范围的 PID 在进入 libc 前被拦截（as 回绕会误伤其他进程组）。
    #[test]
    fn kill_pgid_oversized_pid_is_err() {
        let err = kill_pgid(u32::MAX).unwrap_err();
        assert!(err.contains("pid_t"), "err = {err}");
    }

    /// 真实场景：fork 子进程建立独立进程组 → killpg 直调杀组 → 二次杀幂等
    /// （ESRCH → Ok）→ 组内进程确已消亡（killpg(pgid, 0) 探测返回 ESRCH）。
    /// 本机为 Windows 不编译；由 CI ubuntu（Linux/macOS）覆盖。
    #[test]
    #[allow(unsafe_code)]
    fn kill_pgid_kills_group_and_is_idempotent() {
        // 同步管道：子进程 setpgid 完成（组已建立）后写就绪字节，父进程
        // 阻塞等待，消除 setpgid 与 killpg 之间的竞态
        let mut fds = [0i32; 2];
        let pipe_ret = unsafe { libc::pipe(fds.as_mut_ptr()) };
        assert_eq!(pipe_ret, 0, "pipe 创建失败");

        let child = unsafe { libc::fork() };
        assert!(child >= 0, "fork 失败");
        if child == 0 {
            // 子进程：自建进程组（与 spawn 前 process_group(0) 同语义）；
            // setpgid 成功后才写就绪字节（失败直接退出，父进程读到 EOF 即暴露）
            let ret = unsafe { libc::setpgid(0, 0) };
            if ret != 0 {
                unsafe { libc::_exit(2) };
            }
            let written =
                unsafe { libc::write(fds[1], b"x".as_ptr() as *const libc::c_void, 1) };
            if written != 1 {
                // 写就绪字节失败：直接退出，父进程读到 EOF 即断言失败（不静默通过）
                unsafe { libc::_exit(4) };
            }
            unsafe { libc::pause() };
            unsafe { libc::_exit(3) };
        }

        // 父进程：等子进程就绪字节（EOF 即子进程提前退出 → 直接失败）
        let mut buf = [0u8; 1];
        let n = unsafe { libc::read(fds[0], buf.as_mut_ptr() as *mut libc::c_void, 1) };
        assert_eq!(n, 1, "子进程未就绪（setpgid 前退出）");

        // 一次杀组：Ok（组存在，SIGKILL 已投递）
        let result = kill_pgid(child as u32);
        assert!(result.is_ok(), "一次杀组失败：{result:?}");

        // 组已消亡：killpg(pgid, 0) 存活探测返回 ESRCH
        let probe = unsafe { libc::killpg(child, 0) };
        assert_eq!(probe, -1, "杀组后进程组应不存在（killpg 探测应为 -1）");
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH),
            "杀组后进程组应不存在（探测 errno 应为 ESRCH）"
        );

        // 二次杀组：ESRCH 幂等映射为 Ok（不因目标已不存在而报错）
        let result2 = kill_pgid(child as u32);
        assert!(result2.is_ok(), "二次杀组应幂等成功：{result2:?}");

        // 回收子进程（SIGKILL 已杀，不产生僵尸）
        let mut status = 0;
        let waited = unsafe { libc::waitpid(child, &mut status, 0) };
        assert_eq!(waited, child, "waitpid 回收失败");
        assert!(libc::WIFSIGNALED(status) && libc::WTERMSIG(status) == libc::SIGKILL);

        unsafe { libc::close(fds[0]) };
        unsafe { libc::close(fds[1]) };
    }
}
