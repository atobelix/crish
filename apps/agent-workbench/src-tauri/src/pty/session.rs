//! PTY session registry and lifecycle.
//!
//! Thread model & 3-state machine (Active / Detached / Dead):
//! - Create opens a native PTY, spawns the shell, stores master/writer/killer in Active state.
//! - A dedicated OS thread reads master → emits `workbench://pty-output`.
//! - On stdout bytes > 0, automatically refreshes `session.touch()` liveness timestamp.
//! - On EOF / read error the reader sets `Dead`, waits for child, emits `workbench://pty-exit`.
//! - Front-end tab switch/refresh transitions session to `Detached`, keeping child alive
//!   with a 2-hour grace period for background builds/compilations.
//! - Kill removes the session and signals the child.
//!
//! 错误统一为 `CoreError`（IPC 面唯一协议）：会话不存在 → `NotFound`，
//! 其余内部失败 → `Internal`。

use super::utf8_buffer::Utf8ChunkBuffer;
use conex_types::CoreError;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

/// PTY 会话最大允许容量（单桌面窗口上限 16）
pub(crate) const MAX_PTY_SESSIONS: usize = 16;

/// 前端前台失联判定超时（2 分钟无任何活动/心跳 → 转为 Detached 托管）
pub(crate) const ACTIVE_IDLE_TIMEOUT_MS: u64 = 120_000;

/// Detached 游离态托管宽限期（2 小时无任何 stdout 输出与重连 → 安全 GC 回收）
pub(crate) const DETACHED_GC_GRACE_MS: u64 = 7_200_000;

// ── event payloads ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyOutputEvent {
    pty_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyExitEvent {
    pub(crate) pty_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) exit_code: Option<u32>,
}

// ── 3-state liveness state machine ───────────────────────────────────────────

/// PTY 三态生命周期状态机
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PtyLivenessState {
    /// 活跃连接态：前端正在展示且心跳正常
    Active,
    /// 游离保留态：前端 Tab 已切走/组件卸载，但底层子进程仍在运行（保留输出流与自动续约）
    Detached,
    /// 终态：子进程已退出
    Dead,
}

// ── session ──────────────────────────────────────────────────────────────────

pub(crate) struct PtySession {
    /// Frontend association key (not used for routing; for diagnostics).
    #[allow(dead_code)]
    pub(crate) session_key: String,
    pub(crate) writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub(crate) master: Box<dyn MasterPty + Send>,
    pub(crate) killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    /// 最近一次活跃时刻（键盘输入、Ping、或 stdout 输出）
    pub(crate) last_activity_at_ms: AtomicU64,
    /// 状态标志（Active / Detached / Dead）
    pub(crate) state: Mutex<PtyLivenessState>,
    /// 游离断连起始时刻（Active -> Detached 时更新）
    pub(crate) detached_at_ms: AtomicU64,
    /// 在 Windows ConPTY 下，slave 持有伪控制台句柄（HPCON）。
    /// 若过早 drop 会触发 ClosePseudoConsole 导致子进程秒死；
    /// 必须在会话生命周期内随 PtySession 保活。
    #[allow(dead_code)]
    pub(crate) _slave: Option<Box<dyn portable_pty::SlavePty + Send>>,
}

impl PtySession {
    #[allow(dead_code)]
    pub(crate) fn new(
        session_key: String,
        writer: Box<dyn Write + Send>,
        master: Box<dyn MasterPty + Send>,
        killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
        now_ms: u64,
    ) -> Self {
        Self {
            session_key,
            writer: Arc::new(Mutex::new(writer)),
            master,
            killer: Mutex::new(killer),
            last_activity_at_ms: AtomicU64::new(now_ms),
            state: Mutex::new(PtyLivenessState::Active),
            detached_at_ms: AtomicU64::new(0),
            _slave: None,
        }
    }

    /// 刷新活跃时刻（stdout 输出 >0 字节、键盘输入、ping 等自动调用）
    pub(crate) fn touch(&self) {
        self.touch_at(crate::server::now_ms());
    }

    pub(crate) fn touch_at(&self, now: u64) {
        self.last_activity_at_ms.store(now, Ordering::Relaxed);
    }

    pub(crate) fn set_state(&self, new_state: PtyLivenessState) {
        self.set_state_at(new_state, crate::server::now_ms());
    }

    pub(crate) fn set_state_at(&self, new_state: PtyLivenessState, now: u64) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if *guard == PtyLivenessState::Active && new_state == PtyLivenessState::Detached {
            self.detached_at_ms.store(now, Ordering::Relaxed);
        }
        *guard = new_state;
    }

    pub(crate) fn state(&self) -> PtyLivenessState {
        *self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn last_activity_at_ms(&self) -> u64 {
        self.last_activity_at_ms.load(Ordering::Relaxed)
    }

    pub(crate) fn detached_at_ms(&self) -> u64 {
        self.detached_at_ms.load(Ordering::Relaxed)
    }

    /// 判定是否应被 30s GC 回收：
    /// - Active: 前台若 >120s 无活动，GC 自动置为 Detached 托管，但不立即 kill；
    /// - Detached: 游离态且超过 2 小时（7,200,000ms）无任何 stdout 输出与重连，返回 true 安全回收；
    /// - Dead: 已退出，返回 true 立即回收。
    pub(crate) fn is_gc_eligible(&self, now_ms: u64) -> bool {
        let state = self.state();
        let last_act = self.last_activity_at_ms();
        let detached_at = self.detached_at_ms();
        match state {
            PtyLivenessState::Active => {
                if now_ms.saturating_sub(last_act) > ACTIVE_IDLE_TIMEOUT_MS {
                    self.set_state_at(PtyLivenessState::Detached, now_ms);
                }
                false
            }
            PtyLivenessState::Detached => {
                now_ms.saturating_sub(detached_at) > DETACHED_GC_GRACE_MS
                    && now_ms.saturating_sub(last_act) > DETACHED_GC_GRACE_MS
            }
            PtyLivenessState::Dead => true,
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Best-effort terminate; ignore errors (process may already be gone).
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}

// ── registry ─────────────────────────────────────────────────────────────────

static REGISTRY: OnceLock<Mutex<HashMap<String, PtySession>>> = OnceLock::new();
static PTY_SEQ: AtomicU64 = AtomicU64::new(1);

fn registry() -> &'static Mutex<HashMap<String, PtySession>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Generate a unique `pty-…` id (pure; unit-testable without a PTY).
pub(crate) fn next_pty_id() -> String {
    let seq = PTY_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("pty-{seq}-{nanos}")
}

// ── shell / cwd helpers ──────────────────────────────────────────────────────

fn which_on_path(name: &str) -> bool {
    let Ok(path) = std::env::var("PATH") else {
        return false;
    };
    for dir in std::env::split_paths(&path) {
        let p = dir.join(name);
        if p.is_file() {
            return true;
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{name}.exe"));
            if exe.is_file() {
                return true;
            }
        }
    }
    false
}

fn resolve_cwd(cwd: Option<&str>) -> PathBuf {
    if let Some(raw) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(raw);
        if p.is_dir() {
            return p;
        }
        tracing::warn!(
            target: "pty",
            requested_cwd = raw,
            "传入的 PTY 工作目录不存在或非目录，启动安全降级链"
        );
    }
    if let Ok(app) = crate::host_paths::app_dir() {
        let root = crate::host_paths::workspace_root(&app);
        if root.is_dir() {
            return root;
        }
    }
    // FIN-07: 无工作区启动时安全降级为用户目录 (~)，严禁回退到 src-tauri 或 panic
    if let Some(home) = dirs::home_dir() {
        if home.is_dir() {
            return home;
        }
    }
    if let Ok(cur) = std::env::current_dir() {
        if cur.is_dir() {
            return cur;
        }
    }
    PathBuf::from(".")
}

/// Default interactive shell: Windows prefers pwsh then powershell.exe; Unix bash/$SHELL.
fn build_shell_command(cwd: &Path) -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut cmd = if which_on_path("pwsh") || which_on_path("pwsh.exe") {
            CommandBuilder::new("pwsh.exe")
        } else if let Ok(pf) = std::env::var("ProgramFiles") {
            let pwsh7_path = Path::new(&pf).join("PowerShell").join("7").join("pwsh.exe");
            if pwsh7_path.is_file() {
                CommandBuilder::new(pwsh7_path)
            } else if let Ok(root) = std::env::var("SystemRoot") {
                let system_ps = Path::new(&root)
                    .join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe");
                if system_ps.is_file() {
                    CommandBuilder::new(system_ps)
                } else {
                    CommandBuilder::new("powershell.exe")
                }
            } else {
                CommandBuilder::new("powershell.exe")
            }
        } else if let Ok(root) = std::env::var("SystemRoot") {
            let system_ps = Path::new(&root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            if system_ps.is_file() {
                CommandBuilder::new(system_ps)
            } else {
                CommandBuilder::new("powershell.exe")
            }
        } else {
            CommandBuilder::new("powershell.exe")
        };
        cmd.cwd(cwd);
        // Prefer UTF-8 for child tools
        cmd.env("PYTHONUTF8", "1");
        cmd.env("PYTHONIOENCODING", "utf-8");
        cmd
    }

    #[cfg(not(windows))]
    {
        let program = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty() && Path::new(s).is_file())
            .unwrap_or_else(|| {
                if Path::new("/bin/bash").is_file() {
                    "/bin/bash".into()
                } else {
                    "/bin/sh".into()
                }
            });
        let mut cmd = CommandBuilder::new(program);
        cmd.cwd(cwd);
        cmd.env("PYTHONUTF8", "1");
        cmd.env("PYTHONIOENCODING", "utf-8");
        // Interactive-ish: login shell when using bash
        if cmd
            .get_argv()
            .first()
            .map(|a| a.to_string_lossy().contains("bash"))
            .unwrap_or(false)
        {
            cmd.arg("-i");
        }
        cmd
    }
}

/// PTY 会话不存在的统一错误（NotFound 语义）。
fn not_found_error(pty_id: &str) -> CoreError {
    CoreError::NotFound(format!("pty not found: {pty_id}"))
}

// ── lifecycle ────────────────────────────────────────────────────────────────

pub(crate) fn create_session(
    app: AppHandle,
    session_key: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, CoreError> {
    // 1. 容量硬顶拦截（最多 16 个 PTY 实例）
    {
        let reg = registry()
            .lock()
            .map_err(|e| CoreError::Internal(format!("pty registry lock: {e}")))?;
        if reg.len() >= MAX_PTY_SESSIONS {
            return Err(CoreError::InvalidInput(format!(
                "PTY session capacity exceeded: maximum {MAX_PTY_SESSIONS} active sessions allowed"
            )));
        }
    }

    let cwd_path = resolve_cwd(cwd.as_deref());
    let pty_id = next_pty_id();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| CoreError::Internal(format!("pty open failed: {e}")))?;

    let cmd = build_shell_command(&cwd_path);
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| CoreError::Internal(format!("pty spawn shell failed: {e}")))?;

    // Orphan protection (crash path). Graceful Exit still uses kill_all; dock unmount does not kill.
    // Windows: shared PTY Job Object + KILL_ON_JOB_CLOSE — see process.rs (cross-ref daemon job).
    // Unix: best-effort process group so tree can be signalled as a unit if needed later.
    #[cfg(windows)]
    {
        if let Err(e) = crate::process::init_pty_job_object() {
            tracing::warn!(
                target: "pty",
                error = %e,
                "pty job object init failed; host crash may leave shell orphans"
            );
        }
        // `as_raw_handle` is on portable_pty::Child (Windows); available via dyn Child.
        match child.as_raw_handle() {
            Some(handle) => {
                if let Err(e) = crate::process::assign_child_to_pty_job_object(handle) {
                    tracing::warn!(
                        target: "pty",
                        error = %e,
                        "assign pty shell to job failed; host crash may leave shell orphans"
                    );
                }
            }
            None => {
                tracing::warn!(
                    target: "pty",
                    "pty child has no process handle; cannot assign to job object"
                );
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(pid) = child.process_id() {
            if let Err(e) = crate::process::set_child_process_group(pid) {
                tracing::warn!(
                    target: "pty",
                    pid,
                    error = %e,
                    "setpgid for pty shell failed"
                );
            }
        }
    }

    // Windows ConPTY: pair.slave 持有伪控制台句柄（HPCON），若立即 drop 会直接 ClosePseudoConsole 杀掉子进程！
    // 必须随 PtySession 保活；Unix 平台保持 drop 惯例。
    #[cfg(windows)]
    let slave_holder = Some(pair.slave);
    #[cfg(not(windows))]
    let slave_holder = {
        drop(pair.slave);
        None
    };

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| CoreError::Internal(format!("pty clone reader failed: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| CoreError::Internal(format!("pty take writer failed: {e}")))?;

    let killer = child.clone_killer();

    let session = PtySession {
        session_key,
        writer: Arc::new(Mutex::new(writer)),
        master: pair.master,
        killer: Mutex::new(killer),
        last_activity_at_ms: AtomicU64::new(crate::server::now_ms()),
        state: Mutex::new(PtyLivenessState::Active),
        detached_at_ms: AtomicU64::new(0),
        _slave: slave_holder,
    };

    {
        let mut reg = registry()
            .lock()
            .map_err(|e| CoreError::Internal(format!("pty registry lock: {e}")))?;
        reg.insert(pty_id.clone(), session);
    }

    // Reader + wait thread. Emits output then exit; marks Dead on EOF / error.
    let emit_id = pty_id.clone();
    let app_reader = app.clone();
    thread::Builder::new()
        .name(format!("pty-read-{pty_id}"))
        .spawn(move || {
            let mut buf = [0u8; 8192];
            let mut decoder = Utf8ChunkBuffer::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let flushed = decoder.flush_lossy();
                        if !flushed.is_empty() {
                            let _ = app_reader.emit(
                                "workbench://pty-output",
                                PtyOutputEvent {
                                    pty_id: emit_id.clone(),
                                    data: flushed,
                                },
                            );
                        }
                        // 子进程退出
                        if let Ok(reg) = registry().lock() {
                            if let Some(sess) = reg.get(&emit_id) {
                                sess.set_state(PtyLivenessState::Dead);
                            }
                        }
                        break;
                    }
                    Ok(n) => {
                        // 只要产生输出（stdout > 0 字节），自动续约活性，绝不误杀正在进行的长编译任务！
                        if let Ok(reg) = registry().lock() {
                            if let Some(sess) = reg.get(&emit_id) {
                                sess.touch();
                            }
                        }
                        let data = decoder.push(&buf[..n]);
                        if !data.is_empty() {
                            tracing::trace!(
                                target: "pty",
                                pty_id = %emit_id,
                                bytes = n,
                                "pty output chunk"
                            );
                            let _ = app_reader.emit(
                                "workbench://pty-output",
                                PtyOutputEvent {
                                    pty_id: emit_id.clone(),
                                    data,
                                },
                            );
                        }
                    }
                    Err(e) => {
                        let flushed = decoder.flush_lossy();
                        if !flushed.is_empty() {
                            let _ = app_reader.emit(
                                "workbench://pty-output",
                                PtyOutputEvent {
                                    pty_id: emit_id.clone(),
                                    data: flushed,
                                },
                            );
                        }
                        tracing::debug!(
                            target: "pty",
                            pty_id = %emit_id,
                            error = %e,
                            "pty reader ended"
                        );
                        if let Ok(reg) = registry().lock() {
                            if let Some(sess) = reg.get(&emit_id) {
                                sess.set_state(PtyLivenessState::Dead);
                            }
                        }
                        break;
                    }
                }
            }

            let exit_code = match child.wait() {
                Ok(status) => Some(status.exit_code()),
                Err(e) => {
                    tracing::debug!(
                        target: "pty",
                        pty_id = %emit_id,
                        error = %e,
                        "pty wait failed"
                    );
                    None
                }
            };

            let _ = app_reader.emit(
                "workbench://pty-exit",
                PtyExitEvent {
                    pty_id: emit_id.clone(),
                    exit_code,
                },
            );

            // Remove session if still present (kill may have raced).
            if let Ok(mut reg) = registry().lock() {
                reg.remove(&emit_id);
            }
        })
        .map_err(|e| CoreError::Internal(format!("pty reader thread spawn failed: {e}")))?;

    tracing::info!(
        target: "pty",
        pty_id = %pty_id,
        cols,
        rows,
        cwd = %cwd_path.display(),
        "pty session created"
    );

    Ok(pty_id)
}

pub(crate) fn write_session(pty_id: &str, data: &[u8]) -> Result<(), CoreError> {
    let writer_arc = {
        let reg = registry()
            .lock()
            .map_err(|e| CoreError::Internal(format!("pty registry lock: {e}")))?;
        let session = reg.get(pty_id).ok_or_else(|| not_found_error(pty_id))?;
        session.touch();
        session.writer.clone()
    };

    let mut writer = writer_arc
        .lock()
        .map_err(|e| CoreError::Internal(format!("pty writer lock: {e}")))?;
    writer
        .write_all(data)
        .map_err(|e| CoreError::Internal(format!("pty write failed: {e}")))?;
    writer
        .flush()
        .map_err(|e| CoreError::Internal(format!("pty flush failed: {e}")))?;
    Ok(())
}

pub(crate) fn resize_session(pty_id: &str, cols: u16, rows: u16) -> Result<(), CoreError> {
    let reg = registry()
        .lock()
        .map_err(|e| CoreError::Internal(format!("pty registry lock: {e}")))?;
    let session = reg.get(pty_id).ok_or_else(|| not_found_error(pty_id))?;
    session.touch();
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| CoreError::Internal(format!("pty resize failed: {e}")))
}

/// 前端切 Tab/组件卸载时调用：将会话置为 Detached 游离态（后台托管，享受 2 小时宽限期）
pub(crate) fn detach_session(pty_id: &str) -> Result<(), CoreError> {
    let reg = registry()
        .lock()
        .map_err(|e| CoreError::Internal(format!("pty registry lock: {e}")))?;
    let session = reg.get(pty_id).ok_or_else(|| not_found_error(pty_id))?;
    session.set_state(PtyLivenessState::Detached);
    tracing::debug!(target: "pty", pty_id, "pty session detached to background");
    Ok(())
}

/// 前端切回 Tab 时调用：将会话重新附着为 Active 活跃态并刷新活性
pub(crate) fn attach_session(pty_id: &str) -> Result<(), CoreError> {
    let reg = registry()
        .lock()
        .map_err(|e| CoreError::Internal(format!("pty registry lock: {e}")))?;
    let session = reg.get(pty_id).ok_or_else(|| not_found_error(pty_id))?;
    session.set_state(PtyLivenessState::Active);
    session.touch();
    tracing::debug!(target: "pty", pty_id, "pty session attached to foreground");
    Ok(())
}

/// 前端心跳 Ping 刷新活性时刻
pub(crate) fn touch_session(pty_id: &str) -> Result<(), CoreError> {
    let reg = registry()
        .lock()
        .map_err(|e| CoreError::Internal(format!("pty registry lock: {e}")))?;
    let session = reg.get(pty_id).ok_or_else(|| not_found_error(pty_id))?;
    session.touch();
    Ok(())
}

/// 查询会话当前生命周期状态
#[allow(dead_code)]
pub(crate) fn get_session_state(pty_id: &str) -> Result<PtyLivenessState, CoreError> {
    let reg = registry()
        .lock()
        .map_err(|e| CoreError::Internal(format!("pty registry lock: {e}")))?;
    let session = reg.get(pty_id).ok_or_else(|| not_found_error(pty_id))?;
    Ok(session.state())
}

/// 30s 周期 GC 扫描清理超期或已终止的 PTY 会话
pub(crate) fn run_gc_sweep(now_ms: u64) -> Vec<String> {
    let mut to_kill = Vec::new();
    if let Ok(reg) = registry().lock() {
        for (id, session) in reg.iter() {
            if session.is_gc_eligible(now_ms) {
                to_kill.push(id.clone());
            }
        }
    }
    for id in &to_kill {
        let _ = kill_session(id);
    }
    to_kill
}

pub(crate) fn kill_session(pty_id: &str) -> Result<(), CoreError> {
    let mut reg = registry()
        .lock()
        .map_err(|e| CoreError::Internal(format!("pty registry lock: {e}")))?;
    match reg.remove(pty_id) {
        Some(session) => {
            // Drop kills via Drop impl; also explicit for clarity.
            if let Ok(mut k) = session.killer.lock() {
                let _ = k.kill();
            }
            drop(session);
            tracing::info!(target: "pty", pty_id = %pty_id, "pty session killed");
            Ok(())
        }
        None => Err(not_found_error(pty_id)),
    }
}

pub(crate) fn kill_all() {
    let mut reg = match registry().lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let count = reg.len();
    let sessions: Vec<PtySession> = reg.drain().map(|(_, s)| s).collect();
    drop(reg);
    for session in sessions {
        if let Ok(mut k) = session.killer.lock() {
            let _ = k.kill();
        }
        drop(session);
    }
    if count > 0 {
        tracing::info!(target: "pty", count, "killed all pty sessions");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_cwd_fallbacks() {
        let non_exist = resolve_cwd(Some("Z:\\path\\not\\exist\\123456_random"));
        assert!(non_exist.is_dir(), "降级后的路径必须真实存在！");

        let empty = resolve_cwd(Some("   "));
        assert!(empty.is_dir(), "空白参数必须降级到合法目录");

        let none = resolve_cwd(None);
        assert!(none.is_dir(), "None 参数必须降级到合法目录");
    }
}
