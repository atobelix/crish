//! Interactive PTY sessions for the desktop terminal panel.
//!
//! Spawns a real shell (PowerShell / pwsh on Windows, bash on Unix) via
//! `portable-pty` (ConPTY on Windows) and streams I/O to the frontend.
//!
//! Lifecycle & 3-state management:
//! - `Active / Detached / Dead` three-state state machine.
//! - OS stdout output automatically refreshes activity timestamp via `session.touch()`.
//! - Frontend Tab switch or unmount detaches session to background with a 2-hour grace period.
//! - Background 30s GC loop collects expired detached (>2h idle) and dead sessions.
//! - Hard capacity cap: max 16 active sessions per instance.
//!
//! Orphan protection (Windows): each shell is assigned to a shared app PTY Job Object
//! with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` at spawn (`session.rs` → `process::init_pty_job_object`
//! / `assign_child_to_pty_job_object`). Host crash closes the job handle → OS kills the tree.
//! Daemon/sidecar uses a **separate** job — see `process.rs` Job Objects section.
//! Explicit `kill_all_sessions` on `RunEvent::Exit` remains; dock unmount must not kill PTYs.
//!
//! Events:
//! - `workbench://pty-output` — `{ ptyId, data }`
//! - `workbench://pty-exit`   — `{ ptyId, exitCode? }`
//!
//! 错误统一为 `CoreError`（IPC 面唯一协议，PE-03 T03.3）：
//! 创建命令（含进程拉起 / Job 分配）走 `spawn_blocking` 避免阻塞命令线程；
//! 写入 / 调整 / 终止为轻量注册表操作，保持同步。

mod session;

use conex_types::CoreError;
use serde::Serialize;
use tauri::AppHandle;

#[cfg(test)]
pub(crate) use session::next_pty_id;

const MAX_WRITE_BYTES: usize = 64 * 1024;

// ── command results ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyCreateResult {
    pub(crate) pty_id: String,
}

// ── Tauri commands ───────────────────────────────────────────────────────────

/// Create a PTY, spawn the default shell, start output streaming.
///
/// Frontend: `invoke('workbench_pty_create', { sessionKey, cols, rows, cwd? })`
#[tauri::command]
pub(crate) async fn workbench_pty_create(
    app: AppHandle,
    session_key: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<PtyCreateResult, CoreError> {
    let cols = cols.max(1);
    let rows = rows.max(1);
    // 进程拉起（openpty + spawn shell + Job 分配）为阻塞 IO，走 spawn_blocking。
    let pty_id = tokio::task::spawn_blocking(move || {
        session::create_session(app, session_key, cols, rows, cwd)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("workbench_pty_create join: {e}")))??;
    Ok(PtyCreateResult { pty_id })
}

/// Write UTF-8 data to the PTY master (user keystrokes / paste).
/// Cap: 64 KiB per call.
#[tauri::command]
pub(crate) fn workbench_pty_write(pty_id: String, data: String) -> Result<(), CoreError> {
    if data.len() > MAX_WRITE_BYTES {
        return Err(CoreError::InvalidInput(format!(
            "write too large: {} bytes (max {MAX_WRITE_BYTES})",
            data.len()
        )));
    }
    session::write_session(&pty_id, data.as_bytes())
}

/// Resize the PTY window (cols × rows).
#[tauri::command]
pub(crate) fn workbench_pty_resize(pty_id: String, cols: u16, rows: u16) -> Result<(), CoreError> {
    let cols = cols.max(1);
    let rows = rows.max(1);
    session::resize_session(&pty_id, cols, rows)
}

/// Detach PTY to background (e.g. Tab switch / unmount).
#[allow(dead_code)]
#[tauri::command]
pub(crate) fn workbench_pty_detach(pty_id: String) -> Result<(), CoreError> {
    session::detach_session(&pty_id)
}

/// Re-attach PTY from background to foreground.
#[allow(dead_code)]
#[tauri::command]
pub(crate) fn workbench_pty_attach(pty_id: String) -> Result<(), CoreError> {
    session::attach_session(&pty_id)
}

/// Ping PTY session to refresh heartbeat.
#[allow(dead_code)]
#[tauri::command]
pub(crate) fn workbench_pty_ping(pty_id: String) -> Result<(), CoreError> {
    session::touch_session(&pty_id)
}

/// Kill the PTY child and remove it from the registry.
#[tauri::command]
pub(crate) fn workbench_pty_kill(pty_id: String) -> Result<(), CoreError> {
    session::kill_session(&pty_id)
}

/// Kill every live PTY. Invoked from `main` on `RunEvent::Exit`.
///
/// Graceful path: explicit kill via ChildKiller. Crash path (Windows): PTY Job Object
/// `KILL_ON_JOB_CLOSE` in `process.rs` (not the daemon job).
pub(crate) fn kill_all_sessions() {
    session::kill_all();
}

/// 启动后台 30s 周期 PTY GC 协程，回收超期游离会话（>2h 无输出）与 Dead 会话
pub(crate) fn spawn_pty_gc_loop(_app: AppHandle) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        interval.tick().await;
        loop {
            interval.tick().await;
            let now = crate::server::now_ms();
            let killed = session::run_gc_sweep(now);
            if !killed.is_empty() {
                tracing::info!(
                    target: "pty",
                    count = killed.len(),
                    "PTY GC swept expired/dead sessions"
                );
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::session::PtyLivenessState;
    use std::collections::HashSet;
    use std::io::{Read, Write};

    #[derive(Debug)]
    struct NoopKiller;
    impl portable_pty::ChildKiller for NoopKiller {
        fn kill(&mut self) -> Result<(), std::io::Error> {
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(NoopKiller)
        }
    }

    struct NoopMaster;
    impl portable_pty::MasterPty for NoopMaster {
        fn resize(&self, _size: portable_pty::PtySize) -> Result<(), anyhow::Error> {
            Ok(())
        }
        fn get_size(&self) -> Result<portable_pty::PtySize, anyhow::Error> {
            Ok(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
        }
        fn try_clone_reader(&self) -> Result<Box<dyn Read + Send>, anyhow::Error> {
            Ok(Box::new(std::io::empty()))
        }
        fn take_writer(&self) -> Result<Box<dyn Write + Send>, anyhow::Error> {
            Ok(Box::new(std::io::sink()))
        }
    }

    fn new_mock_session(now_ms: u64) -> session::PtySession {
        session::PtySession::new(
            "mock-key".to_string(),
            Box::new(std::io::sink()),
            Box::new(NoopMaster),
            Box::new(NoopKiller),
            now_ms,
        )
    }

    #[test]
    fn pty_id_uniqueness() {
        let mut seen = HashSet::new();
        for _ in 0..256 {
            let id = next_pty_id();
            assert!(seen.insert(id.clone()), "duplicate pty id: {id}");
            assert!(id.starts_with("pty-"), "id format: {id}");
        }
    }

    #[test]
    fn write_size_cap_constant() {
        assert_eq!(MAX_WRITE_BYTES, 64 * 1024);
    }

    #[test]
    fn pty_capacity_constant() {
        assert_eq!(session::MAX_PTY_SESSIONS, 16);
    }

    #[test]
    fn kill_all_sessions_empty_registry_is_safe() {
        // Exit hook may run with zero PTYs; must not panic.
        kill_all_sessions();
        kill_all_sessions();
    }

    #[test]
    fn pty_write_rejects_oversized_payload() {
        // 命令层校验：超过 64 KiB 的写入在触碰注册表之前即拒绝（InvalidInput）。
        let oversized = "x".repeat(MAX_WRITE_BYTES + 1);
        let result = workbench_pty_write("pty-any".to_string(), oversized);
        match result {
            Err(CoreError::InvalidInput(msg)) => assert!(msg.contains("write too large")),
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    /// §8.3 对抗性测试：PTY 切 Tab 与长编译任务保活断言
    #[test]
    fn adversarial_pty_detached_and_output_keepalive() {
        let now = 1_000_000u64;
        let session = new_mock_session(now);

        // 1. 模拟前端组件卸载（切 Tab）
        session.set_state_at(PtyLivenessState::Detached, now);
        assert_eq!(session.state(), PtyLivenessState::Detached);
        assert_eq!(session.detached_at_ms(), now);

        // 2. 模拟 10 分钟内子进程持续产生 stdout 输出并 touch
        for i in 1..=10 {
            let out_time = now + i * 60_000;
            session.touch_at(out_time); // 读线程读到数据自动 touch
            let last_act = session.last_activity_at_ms();
            assert_eq!(last_act, out_time);
        }

        // 3. 验证 30s 周期 GC 扫描时，由于 last_activity 持续刷新，绝对不执行 kill
        let gc_now = now + 600_000; // 10 分钟后
        let should_kill = session.is_gc_eligible(gc_now);
        assert!(
            !should_kill,
            "持续产生 stdout 的 Detached 编译任务绝对不得被 GC 误杀！"
        );

        // 4. 模拟长达 2 小时无任何 stdout 输出且无连接
        let gc_after_2h = now + 600_000 + 7_200_001; // 上次输出 2 小时后
        let should_kill_expired = session.is_gc_eligible(gc_after_2h);
        assert!(
            should_kill_expired,
            "超期 2 小时无任何 stdout 输出与连接的游离会话必须被 GC 回收！"
        );
    }

    #[test]
    fn pty_state_transitions_active_detached_dead() {
        let t0 = 1_000_000u64;
        let session = new_mock_session(t0);
        assert_eq!(session.state(), PtyLivenessState::Active);

        // Active -> Detached
        session.set_state_at(PtyLivenessState::Detached, t0 + 10_000);
        assert_eq!(session.state(), PtyLivenessState::Detached);
        assert_eq!(session.detached_at_ms(), t0 + 10_000);

        // Detached -> Active (re-attach)
        session.set_state_at(PtyLivenessState::Active, t0 + 20_000);
        assert_eq!(session.state(), PtyLivenessState::Active);

        // Active -> Dead
        session.set_state_at(PtyLivenessState::Dead, t0 + 30_000);
        assert_eq!(session.state(), PtyLivenessState::Dead);
        assert!(session.is_gc_eligible(t0 + 30_000));
    }

    #[test]
    fn pty_active_idle_transitions_to_detached_on_gc() {
        let t0 = 1_000_000u64;
        let session = new_mock_session(t0);

        // Active 态在 120s 内不转 Detached
        assert!(!session.is_gc_eligible(t0 + 60_000));
        assert_eq!(session.state(), PtyLivenessState::Active);

        // Active 态超过 120s 无活动，GC 自动置为 Detached 托管，但不 kill
        assert!(!session.is_gc_eligible(t0 + 120_001));
        assert_eq!(session.state(), PtyLivenessState::Detached);
    }
}

