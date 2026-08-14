//! SR-05 · 拆分 · ≠ EL · 域：转发管线（forward_streams/write_output_line/
//! finish_task + read_buf/LogState）。结构拆分轮仅搬移，转发/收尾顺序
//! （meta 落盘 → stdin 清空 → 状态翻转）零改动。接线：background.rs `mod bg_writer;`。

use crate::process::now_millis;
use crate::resource::TaskNotifier;
use agent_tools::background::{BackgroundTaskInfo, TaskState};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::Mutex as TokioMutex;

use super::bg_log::{
    decode_console_bytes, detect_prompt, maybe_rotate_log, read_log_tail, task_state_str,
    write_meta, write_meta_now, CheckpointEntry, LogWriter, TaskMeta, CHECKPOINT_INTERVAL_LINES,
    ERR_PREFIX, OUT_PREFIX,
};
use super::bg_registry::OutputPreview;

// ── 转发循环与收尾 ───────────────────────────────────────────────────────────

/// 单流读取 helper：`reader` 为 None（未接管道）时返回 EOF（Ok(0)）。
async fn read_buf<R: AsyncBufRead + Unpin>(
    reader: Option<&mut R>,
    buf: &mut Vec<u8>,
) -> std::io::Result<usize> {
    match reader {
        Some(r) => r.read_until(b'\n', buf).await,
        None => Ok(0),
    }
}

/// 转发循环的收尾状态（转交 finish_task 消费）
pub(crate) struct LogState {
    log: LogWriter,
    checkpoints: Vec<CheckpointEntry>,
    rotated: bool,
    rotated_at_ms: Option<u64>,
    dropped_lines: u64,
}

/// stdout/stderr → 落盘 + 内存预览 + 行计数 + checkpoint + 提示检测
/// 转发循环（双流并行，管道满不死锁；EOF 全闭即返回）。
///
/// 顺序口径：stdout/stderr 是两条独立管道，本循环用 select 交替读取，
/// 落盘顺序为「到达序」近似（同一次 select 内先就绪者先写）。
pub(crate) async fn forward_streams(
    info: &Arc<RwLock<BackgroundTaskInfo>>,
    preview: &Arc<Mutex<OutputPreview>>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
    log_path: &Path,
    meta_path: &Path,
    notifier: &TaskNotifier,
) -> LogState {
    let mut out = stdout.map(tokio::io::BufReader::new);
    let mut err = stderr.map(tokio::io::BufReader::new);
    let mut out_line = Vec::with_capacity(4096);
    let mut err_line = Vec::with_capacity(4096);
    let mut log = LogWriter::default();
    let mut checkpoints: Vec<CheckpointEntry> = Vec::new();
    let mut rotated = false;
    let mut rotated_at_ms: Option<u64> = None;
    let mut dropped_lines: u64 = 0;

    loop {
        let out_open = out.is_some();
        let err_open = err.is_some();
        if !out_open && !err_open {
            break;
        }
        tokio::select! {
            r = read_buf(out.as_mut(), &mut out_line), if out_open => {
                match r {
                    Ok(0) => { out = None; }
                    Ok(_) => {
                        write_output_line(
                            info, preview, &mut log, log_path, meta_path,
                            &mut checkpoints, &mut rotated, &mut rotated_at_ms,
                            &mut dropped_lines, &mut out_line, false, notifier,
                        );
                    }
                    Err(e) => {
                        tracing::debug!(target: "background", error = %e, "stdout 读取失败，提前 EOF");
                        out = None;
                    }
                }
            }
            r = read_buf(err.as_mut(), &mut err_line), if err_open => {
                match r {
                    Ok(0) => { err = None; }
                    Ok(_) => {
                        write_output_line(
                            info, preview, &mut log, log_path, meta_path,
                            &mut checkpoints, &mut rotated, &mut rotated_at_ms,
                            &mut dropped_lines, &mut err_line, true, notifier,
                        );
                    }
                    Err(e) => {
                        tracing::debug!(target: "background", error = %e, "stderr 读取失败，提前 EOF");
                        err = None;
                    }
                }
            }
        }
    }
    LogState {
        log,
        checkpoints,
        rotated,
        rotated_at_ms,
        dropped_lines,
    }
}

/// 行级累积：剥离行尾 \r\n → 解码（decode_console_bytes 口径）→ 落盘（带
/// `[out]`/`[err]` 前缀）→ 行计数 + 最近输出时间 → 预览 → 周期 checkpoint →
/// 行尾提示检测。空行也是行（行计数语义），不跳过。
// G2 允许理由（clippy::too_many_arguments）：参数为任务输出流水线上下文
// 聚合注入（任务信息/预览/日志写入器/路径/检查点/轮转状态/丢弃计数等），
// 各参数来源独立，收缩将退化为全局态或拆分 struct 而收益低。
#[allow(clippy::too_many_arguments)]
fn write_output_line(
    info: &Arc<RwLock<BackgroundTaskInfo>>,
    preview: &Arc<Mutex<OutputPreview>>,
    log: &mut LogWriter,
    log_path: &Path,
    meta_path: &Path,
    checkpoints: &mut Vec<CheckpointEntry>,
    rotated: &mut bool,
    rotated_at_ms: &mut Option<u64>,
    dropped_lines: &mut u64,
    raw: &mut Vec<u8>,
    is_err: bool,
    notifier: &TaskNotifier,
) {
    while matches!(raw.last(), Some(b'\n') | Some(b'\r')) {
        raw.pop();
    }
    let line = decode_console_bytes(raw);
    raw.clear();
    let prefix = if is_err { ERR_PREFIX } else { OUT_PREFIX };
    // 记录本行行首偏移（checkpoint 用：精确行号读取从行首起读）
    let start_offset = log.offset;
    log.append_line(log_path, prefix, &line);

    let now = now_millis() as u64;
    let line_count;
    let prompt_hit = {
        let Ok(mut guard) = info.write() else {
            return;
        };
        guard.line_count += 1;
        guard.last_output_at_ms = now;
        line_count = guard.line_count;
        if guard.prompt.is_none() && detect_prompt(&line) {
            // 命中行作为候选提示就位（T-AB-10 3；通知接线留 R-AB3）
            guard.prompt = Some(line.clone());
            true
        } else {
            false
        }
    };
    // T-AB-17 七事件发射点二：行计数后发 task-output（100ms 节流窗口聚合，
    // 见 [crate::resource::TaskNotifier::notify_output]；line 尚未被预览 move）
    let task_id = info
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .task_id
        .clone();
    notifier.notify_output(&task_id, &line, line_count);
    if let Ok(mut preview_guard) = preview.lock() {
        preview_guard.push_line(line);
    }

    // 周期落盘点：每 512 行 checkpoint + 轮转护栏检查
    if line_count % CHECKPOINT_INTERVAL_LINES == 0 {
        if let Some(new_total) = maybe_rotate_log(log_path, log, info) {
            // 轮转成功：行号从 1 重新编号，旧 checkpoint 全部失效
            checkpoints.clear();
            *rotated = true;
            *rotated_at_ms = Some(now_millis() as u64);
            *dropped_lines = dropped_lines.saturating_add(line_count.saturating_sub(new_total));
        } else {
            checkpoints.push(CheckpointEntry {
                line: line_count,
                offset: start_offset,
            });
        }
        write_meta_now(
            info,
            meta_path,
            checkpoints,
            log.offset,
            *rotated,
            *rotated_at_ms,
            *dropped_lines,
        );
    }
    if prompt_hit {
        // 提示命中即落 meta（与 checkpoint 写入幂等，多写一次无害）
        write_meta_now(
            info,
            meta_path,
            checkpoints,
            log.offset,
            *rotated,
            *rotated_at_ms,
            *dropped_lines,
        );
    }
}

/// 收尾：双流 EOF 后取 child 收口（wait），写终态 meta（exit_code/finished_at），
/// 清空 stdin 槽位（终态后 send_input 确定性 stdin_closed），推进状态机，
/// 最后投递 Crashed 通知（T-AB-16 3：仅 resourceMonitor 任务）。
///
/// 顺序即屏障：状态翻转为终态是收尾的最后一步（全部落盘、sync、meta 均已
/// 完成）——status()/list() 读到终态即保证 tail/line_count 与文件自洽
/// （T-AB-09 6）。锁不在 await 点持有。
pub(crate) async fn finish_task(
    info: &Arc<RwLock<BackgroundTaskInfo>>,
    child: &Arc<Mutex<Option<Child>>>,
    stdin_slot: &Arc<TokioMutex<Option<ChildStdin>>>,
    meta_path: &Path,
    mut state: LogState,
    notifier: &TaskNotifier,
    resource_monitor: bool,
) {
    // 1) 日志文件 sync（退出后文件可读）
    state.log.sync();
    // 2) 收口子进程（wait）
    let child = child
        .lock()
        .map(|mut guard| guard.take())
        .unwrap_or(None);
    let (task_state, exit_code) = match child {
        Some(mut child) => match child.wait().await {
            Ok(status) => {
                if status.success() {
                    (TaskState::Completed, status.code())
                } else {
                    (TaskState::Failed, status.code())
                }
            }
            Err(e) => {
                tracing::warn!(
                    target: "background",
                    error = %e,
                    "wait 子进程收口失败，按 Failed 收场"
                );
                (TaskState::Failed, None)
            }
        },
        // child 被 kill 提前取走（T-AB-11：kill 两阶段终止持有子进程句柄做
        // wait；本路径按 Killed 收尾，kill 随后以权威值幂等覆盖）
        None => (TaskState::Killed, None),
    };
    let finished_at_ms = now_millis() as u64;

    // 3) 终态 meta：exit_code / finished_at / 最终行数 / 补末行 checkpoint
    let meta = {
        let Ok(guard) = info.read() else {
            return;
        };
        let mut checkpoints = state.checkpoints;
        if let Some(start) = state.log.last_start {
            // 补终态 checkpoint（末行行首偏移），精确行号读取在文件末尾附近
            // 免于从头扫描；与既有条目行号相同则跳过（幂等）
            if !checkpoints.iter().any(|c| c.line == guard.line_count) {
                checkpoints.push(CheckpointEntry {
                    line: guard.line_count,
                    offset: start,
                });
            }
        }
        let mut meta = TaskMeta::from_info(
            &guard,
            checkpoints,
            state.log.offset,
            state.rotated,
            state.rotated_at_ms,
            state.dropped_lines,
        );
        drop(guard);
        meta.status = task_state_str(&task_state).to_string();
        meta.finished_at_ms = Some(finished_at_ms);
        meta.exit_code = exit_code;
        meta
    };
    if let Err(e) = write_meta(meta_path, &meta) {
        tracing::warn!(
            target: "background",
            error = %e,
            path = %meta_path.display(),
            "终态 meta 落盘失败"
        );
    }

    // 4) 关闭 stdin 槽位（终态后注入确定性失败，不依赖 BrokenPipe 时序）
    if let Ok(mut guard) = stdin_slot.try_lock() {
        *guard = None;
    }

    // 5) 状态翻转（屏障最后一步）
    if let Ok(mut info_guard) = info.write() {
        info_guard.status = task_state;
        info_guard.exit_code = exit_code;
        info_guard.finished_at_ms = Some(finished_at_ms);
        info_guard.duration_ms = finished_at_ms.saturating_sub(info_guard.started_at_ms);
    }

    // 6) 终态通知（T-AB-16 3 + T-AB-17 七事件）：仅 resourceMonitor 任务。
    //    非零退出 → Crashed（notify_failed，附最后 20 行日志）；零退出 →
    //    task-completed。尾部日志复用 read_log_tail（read_log(None, 20) 的
    //    底层实现，T-AB-09；日志文件已在 1) sync，文件内容完整）。终态只
    //    发生一次，通知天然不重复；Crashed 不自动杀、不自动降级超时（通知
    //    由 AI 裁决，见 notifier 文案）。
    if resource_monitor {
        if let Some(code) = exit_code {
            let (task_id, log_path, line_count, started_at_ms) = {
                let guard = info.read().unwrap_or_else(|p| p.into_inner());
                (
                    guard.task_id.clone(),
                    PathBuf::from(guard.log_path.clone()),
                    guard.line_count,
                    guard.started_at_ms,
                )
            };
            let duration_ms = finished_at_ms.saturating_sub(started_at_ms);
            if code == 0 {
                notifier.notify_completed(&task_id, code, duration_ms, line_count);
            } else {
                let (tail, _, _) = read_log_tail(&log_path, line_count, 20);
                notifier.notify_failed(&task_id, code, &tail.join("\n"), duration_ms);
            }
        }
    }
}
