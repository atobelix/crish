//! SR-05 · 拆分 · ≠ EL · 域：两阶段终止（T-AB-11：kill + poll_exit 轮询
//! 等待 helper + 优雅/强制窗口常量）。结构拆分轮仅搬移，kill 语义零改动。
//! 接线：background.rs `mod bg_kill;`。

use crate::process::now_millis;
use agent_tools::background::{KillResult, TaskState};
use agent_tools::definition::ToolError;
use std::time::Duration;
use tokio::process::Child;

use super::bg_log::{read_meta, write_meta, TaskMeta};
use super::bg_registry::{BackgroundTaskRegistry, WRITER_DRAIN_TIMEOUT};

/// 两阶段终止阶段一：优雅请求后的等待窗口（5s，超时升级强制）。
const KILL_GRACEFUL_WINDOW: Duration = Duration::from_secs(5);
/// 两阶段终止阶段二：强制终止后的等待窗口（5s，仍不退出 → Failed）。
const KILL_FORCE_WINDOW: Duration = Duration::from_secs(5);

/// 两阶段终止（T-AB-11）：优雅（`terminate_process_tree_graceful`）→
/// 5s 等待窗口 → 强制（`terminate_process_tree`），KillResult 三态返回。
///
/// 状态机联动与纪律：kill 成功 → status=Killed、finished_at 落 meta（.log
/// 保留）；收尾顺序遵循 writer 同款纪律——「meta 落盘 → stdin 清空 →
/// 状态翻转」，且**先 await writer 收口**（writer 的 child 槽为 None 时按
/// Killed 收尾，kill 随后以权威值（真实 exit_code）幂等覆盖）。
///
/// 边界：
/// - 终态任务 → AlreadyExited（携带自然退出码），不强行升级；
/// - kill 与自然退出竞态（try_wait 命中 / writer 已取走子进程）→
///   AlreadyExited，不强行升级（进程已不在，升级无意义）；
/// - 任务已归档 → NotFound（.log 保留，错误消息附可恢复指引）；
/// - Windows 优雅阶段不保证成功（本机实测：taskkill 无 /F 对控制台程序
///   必然返回「只能强制终止」——优雅失败即跳过等待直接升级，省 5s；
///   测试以「两阶段路径可执行」而非「优雅一定成功」为准）。
///
/// 职责分离：kill 不关闭 daemon Job 句柄（Job 管宿主崩溃兜底，关闭会影响
/// 其他任务；两条路径职责分离——Job 管「宿主崩溃」，kill 管「任务终止」）。
pub(crate) async fn kill_task(
    registry: &BackgroundTaskRegistry,
    task_id: &str,
) -> Result<KillResult, ToolError> {
    let handle = registry.get_handle(task_id)?;
    // 终态短路：AlreadyExited（不触碰子进程槽，writer 已收口）
    {
        let info = handle
            .info
            .read()
            .unwrap_or_else(|p| p.into_inner());
        if BackgroundTaskRegistry::is_terminal(info.status) {
            return Ok(KillResult::AlreadyExited {
                task_id: task_id.to_string(),
                    exit_code: info.exit_code,
                });
            }
        }
        // 独占取子进程（kill 与 writer 的 finish_task 二选一拿到所有权；
        // 竞态窗口内 writer 已取走 → 按 AlreadyExited 处理，不强行升级）
        let child = handle
            .child
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        let Some(mut child) = child else {
            let exit_code = handle
                .info
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .exit_code;
            return Ok(KillResult::AlreadyExited {
                task_id: task_id.to_string(),
                exit_code,
            });
        };

        // 1) try_wait 先查一次（可省 5s：进程可能已自然退出——竞态收敛为
        //    AlreadyExited；子进程放回槽位，writer 正常收口为 Completed/Failed）
        match child.try_wait() {
            Ok(Some(status)) => {
                *handle
                    .child
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some(child);
                return Ok(KillResult::AlreadyExited {
                    task_id: task_id.to_string(),
                    exit_code: status.code(),
                });
            }
            Ok(None) => {}
            Err(e) => {
                *handle
                    .child
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some(child);
                return Ok(KillResult::Failed {
                    task_id: task_id.to_string(),
                    reason: format!("进程状态探测失败：{e}"),
                });
            }
        }

        // 2) 阶段一：优雅终止请求（进程树；Windows taskkill 无 /F）
        let graceful_at_ms = now_millis() as u64;
        let graceful = crate::process::terminate_process_tree_graceful(handle.pid);
        let mut diagnostics = vec![format!(
            "优雅终止请求已发送（pid={}，发送时间={}ms，结果={}）",
            handle.pid,
            graceful_at_ms,
            if graceful.is_ok() { "已受理" } else { "未生效" }
        )];

        // 3) 等待窗口（轮询式，不移动子进程所有权——窗口未退出可继续升级等待）。
        //    优雅未生效（Windows 控制台进程的典型路径，本机实测 taskkill 无 /F
        //    对 powershell/cmd 必失败）→ 跳过 5s 等待直接升级
        let graceful_exit = match &graceful {
            Ok(()) => poll_exit(&mut child, KILL_GRACEFUL_WINDOW).await,
            Err(_reason) => None, // 优雅未生效 → 直接升级
        };

        // 4) 阶段二（升级）或优雅成功收口
        let (exit_code, via_force) = match graceful_exit {
            Some(status) => (status.code(), false),
            None => {
                let escalate_at_ms = now_millis() as u64;
                let escalate_reason = match &graceful {
                    Ok(()) => "5s 优雅等待超时".to_string(),
                    Err(reason) => format!("优雅请求未生效（{reason}）"),
                };
                // 阶段二：强制树杀（Windows taskkill /F /T；Unix 侧与优雅同型
                // ——SIGTERM，对忽略信号的进程双方均无效，见 Unix 平台限制）
                let forced = crate::process::terminate_process_tree(handle.pid);
                diagnostics.push(format!(
                    "强制终止升级（原因：{escalate_reason}，升级时间={escalate_at_ms}ms，结果={})",
                    if forced.is_ok() { "已执行" } else { "失败" }
                ));
                match forced {
                    Ok(()) => match poll_exit(&mut child, KILL_FORCE_WINDOW).await {
                        Some(status) => (status.code(), true),
                        None => {
                            // 强制后仍不退出（极顽固进程 / 句柄异常）：
                            // 放回槽位，writer 保持生命周期；Failed 留痕
                            *handle
                                .child
                                .lock()
                                .unwrap_or_else(|p| p.into_inner()) = Some(child);
                            return Ok(KillResult::Failed {
                                task_id: task_id.to_string(),
                                reason: format!(
                                    "强制终止已执行但 {} 毫秒内未退出",
                                    KILL_FORCE_WINDOW.as_millis()
                                ),
                            });
                        }
                    },
                    Err(e) => {
                        // 强制失败：进程可能已消失（竞态），put back 由 writer
                        // 收口，返回 Failed
                        *handle
                            .child
                            .lock()
                            .unwrap_or_else(|p| p.into_inner()) = Some(child);
                        return Ok(KillResult::Failed {
                            task_id: task_id.to_string(),
                            reason: format!("强制终止失败：{e}"),
                        });
                    }
                }
            }
        };

        // 5) 收口：等 writer 完成（kill 已取走子进程 → writer 的 finish_task 走
        //    child=None 的 Killed 收尾路径，快速完成）。JoinHandle 在 Arc 共享
        //    所有权下无法移动/可变借用（join 需要所有权），以 is_finished 轮询
        //    + async sleep 让步替代；窗口内未完成（孙进程持管道等极端）放弃
        //    等待，不阻塞调用方
        drop(child);
        {
            let deadline = tokio::time::Instant::now() + WRITER_DRAIN_TIMEOUT;
            while !handle.writer.is_finished() {
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }

        // 6) 终态联动（纪律：meta 落盘 → stdin 清空 → 状态翻转）
        let finished_at_ms = now_millis() as u64;
        {
            // 6a) meta 落盘：基于磁盘现有 meta（保留 checkpoint/轮转字段）更新
            //     终态；磁盘 meta 缺失（极端）则按内存快照组装基本 meta
            let meta_path = registry
                .log_root
                .join(format!("{task_id}.meta.json"));
            let mut meta = read_meta(&meta_path).unwrap_or_else(|| {
                let info = handle
                    .info
                    .read()
                    .unwrap_or_else(|p| p.into_inner());
                TaskMeta::from_info(&info, Vec::new(), 0, false, None, 0)
            });
            meta.status = "killed".to_string();
            meta.finished_at_ms = Some(finished_at_ms);
            meta.exit_code = exit_code;
            if let Err(e) = write_meta(&meta_path, &meta) {
                tracing::warn!(
                    target: "background",
                    task_id = %task_id,
                    error = %e,
                    "kill 终态 meta 落盘失败（.log 保留不受影响）"
                );
            }
            // 6b) stdin 槽清空（终态后注入确定性 stdin_closed）
            if let Ok(mut guard) = handle.stdin.try_lock() {
                *guard = None;
            }
            // 6c) 状态翻转（屏障最后一步；writer 若尚未收口其 finish_task 仅
            //     重复写同值 Killed，不产生状态回退）
            if let Ok(mut info) = handle.info.write() {
                info.status = TaskState::Killed;
                info.exit_code = exit_code;
                info.finished_at_ms = Some(finished_at_ms);
                info.duration_ms = finished_at_ms.saturating_sub(info.started_at_ms);
            }
        }
        // 诊断留痕入槽（status().termination_diagnostics 透传；clone 保留
        // 局部变量供 task-killed 事件发射使用）
        if let Ok(mut guard) = handle.diagnostics.lock() {
            *guard = diagnostics.clone();
        }
        // T-AB-17 七事件发射点五：kill 成功 → task-killed（Critical 必达；
        // via_force/diagnostics 已就绪——两阶段留痕非空时透传，空则 None）
        handle.notifier.notify_killed(
            task_id,
            via_force,
            if diagnostics.is_empty() {
                None
            } else {
                Some(diagnostics.join("\n"))
            },
        );

        Ok(KillResult::Killed {
            task_id: task_id.to_string(),
            via_force,
        })
    }

// ── 两阶段终止等待 helper（T-AB-11）─────────────────────────────────────────

/// 轮询式等待子进程退出：每 100ms `try_wait` 一次，窗口内退出 → 退出状态；
/// 未退出 → None。与 `Child::wait()`（移动所有权）不同，本 helper 不移动
/// child——窗口未退出时调用方保留句柄，可继续走升级路径再次等待。
/// try_wait 探测失败（句柄异常）按「继续等待」处理（窗口到点自然返回 None）。
async fn poll_exit(child: &mut Child, window: Duration) -> Option<std::process::ExitStatus> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) | Err(_) => {
                if tokio::time::Instant::now() >= deadline {
                    return None;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}
