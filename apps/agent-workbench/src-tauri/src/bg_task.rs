//! SR-05 · 拆分 · ≠ EL · 域：任务生命周期（BackgroundTaskManager 实现面：
//! adopt/list/status/read_log/send_input + task_summary 摘要模板；kill 见
//! bg_kill.rs，转发管线见 bg_writer.rs）。结构拆分轮仅搬移，任务状态机
//! 语义零改动。接线：background.rs `mod bg_task;`。

use crate::process::now_millis;
use agent_tools::background::{
    BackgroundAdoptRequest, BackgroundTaskInfo, BackgroundTaskManager, BackgroundTaskRef,
    BackgroundTaskStatus, KillResult, LogSlice, TaskState,
};
use agent_tools::definition::ToolError;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::Mutex as TokioMutex;

use super::bg_events::spawn_resource_monitor_loop;
use super::bg_log::{read_log_range, read_log_tail, write_meta_now};
use super::bg_registry::{BackgroundTaskRegistry, OutputPreview, TaskHandle};
use super::bg_writer::{finish_task, forward_streams};

// ============================================================================
// 摘要模板（T-AB-09 4：REQ-A05 摘要，R-AB3 唤醒注入消费）
// ============================================================================

/// 任务摘要模板：`任务 <id> 已运行 <duration>，日志已累积 <line_count> 行，
/// 最近输出时间 <timestamp>`。status() 组装并 trace 留痕，R-AB3 作为
/// 唤醒注入（PendingNudgeChannel 通知正文）消费。
pub(crate) fn task_summary(info: &BackgroundTaskInfo, duration_ms: u64) -> String {
    format!(
        "任务 {} 已运行 {}，日志已累积 {} 行，最近输出时间 {}",
        info.task_id, duration_ms, info.line_count, info.last_output_at_ms
    )
}

#[async_trait::async_trait]
impl BackgroundTaskManager for BackgroundTaskRegistry {
    /// adopt：登记任务 + 接线 daemon Job（Windows，best-effort）+ 建 meta +
    /// 启动转发循环（落盘 + 预览 + 计数 + checkpoint + 提示检测）。
    ///
    /// 诚实边界：Windows 8+ 支持嵌套 Job，本机实测分配成功（宿主 Job 包裹不阻断）；
    /// 若宿主 Job 禁止嵌套，分配会返回拒绝——接线失败仅 warn 降级（孤儿保护退化
    /// 为显式 kill 路径），不阻断注册。调用方契约（T-AB-02）：child 必须以
    /// `kill_on_drop(false)` spawn。stdin：`child.stdin.take()` 托管进
    /// `TaskHandle.stdin`（T-AB-10 1）；若 spawn 侧未开管道（当前 shell.rs:753
    /// 为 `Stdio::null()`），槽位为空，send_input 按 stdin_closed 分类。
    async fn adopt(&self, req: BackgroundAdoptRequest) -> Result<BackgroundTaskRef, ToolError> {
        let task_id = format!("task-{}", self.task_seq.fetch_add(1, Ordering::Relaxed));
        let log_path = self.log_root.join(format!("{task_id}.log"));
        let meta_path = self.log_root.join(format!("{task_id}.meta.json"));
        let started_at_ms = now_millis() as u64;
        let command = Self::summarize_command(&req.command);
        let cwd = req.cwd.display().to_string();

        // Windows：daemon Job 接线（best-effort；失败降级不阻断）
        #[cfg(windows)]
        if let Some(pid) = req.child.id() {
            if let Err(e) = crate::process::assign_pid_to_daemon_job(pid) {
                tracing::warn!(
                    target: "background",
                    task_id = %task_id,
                    pid,
                    error = %e,
                    "assign daemon task to job failed; 孤儿保护降级（显式 kill 路径兜底）"
                );
            }
        }

        let mut child = req.child;
        let pid = child.id().unwrap_or(0);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin_slot = Arc::new(TokioMutex::new(child.stdin.take()));

        let info = Arc::new(RwLock::new(BackgroundTaskInfo {
            task_id: task_id.clone(),
            // clone：adopt 后的 notify_started 仍需要 command/cwd 引用
            // （info 构造优先 move 进快照，事件发射点用副本）
            command: command.clone(),
            cwd: cwd.clone(),
            status: TaskState::Running,
            started_at_ms,
            duration_ms: 0,
            finished_at_ms: None,
            exit_code: None,
            log_path: log_path.display().to_string(),
            line_count: 0,
            last_output_at_ms: started_at_ms,
            is_daemon: req.is_daemon,
            resource: None, // R-AB3 采样
            prompt: None,   // T-AB-10 提示检测就位
            owner_run_id: req.owner_run_id.clone(),
            suspicious: false, // 14-T2a wire：采样循环按健康判定置位
        }));
        let child_slot = Arc::new(Mutex::new(Some(child)));
        let preview = Arc::new(Mutex::new(OutputPreview::default()));

        // meta 创建即写初值（T-AB-09 3；失败仅 warn，不阻断注册）
        write_meta_now(&info, &meta_path, &[], 0, false, None, 0);

        // 转发循环：双流 → 落盘 + 内存预览 + 行计数 + checkpoint + 提示检测；
        // EOF 全闭后收尾（wait + 终态 meta + stdin 槽清空 + 状态机 +
        // Crashed 通知）。Arc 循环安全：writer 持 shared 克隆，任务完成即释放，
        // 无泄漏。
        let notifier = self
            .notifier
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        // T-AB-17 七事件发射点一：adopt 成功即发 task-started（Critical 必达；
        // owner_run_id 未归属 → 空串占位——任务归属经 payload.ownerRunId 表达）
        notifier.notify_started(
            &task_id,
            &command,
            &cwd,
            req.owner_run_id.as_deref().unwrap_or_default(),
            req.is_daemon,
        );
        let resource_monitor = req.resource_monitor;
        let writer = tokio::spawn({
            let info = Arc::clone(&info);
            let child_slot = Arc::clone(&child_slot);
            let preview = Arc::clone(&preview);
            let stdin_slot = Arc::clone(&stdin_slot);
            let log_path = log_path.clone();
            let meta_path = meta_path.clone();
            let notifier = notifier.clone();
            async move {
                let state = forward_streams(
                    &info, &preview, stdout, stderr, &log_path, &meta_path, &notifier,
                )
                .await;
                finish_task(
                    &info,
                    &child_slot,
                    &stdin_slot,
                    &meta_path,
                    state,
                    &notifier,
                    resource_monitor,
                )
                .await;
            }
        });

        // 资源采样循环（T-AB-15 3）：仅启用 resourceMonitor 的任务挂载；
        // 与转发器同属 tokio runtime 的独立任务（不额外开 OS 线程），
        // 采样开销微秒级（JobObject FFI / /proc 读）。
        let sampler = if resource_monitor {
            Some(spawn_resource_monitor_loop(
                Arc::clone(&info),
                pid,
                log_path.with_extension("samples.jsonl"),
                notifier.clone(),
                self.resource_config,
                task_id.clone(),
                self.sampler.clone(),
            ))
        } else {
            None
        };

        let handle = Arc::new(TaskHandle {
            info,
            pid,
            child: child_slot,
            writer,
            sampler,
            preview,
            stdin: stdin_slot,
            diagnostics: Arc::new(Mutex::new(Vec::new())),
            notifier,
        });
        self.tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(task_id.clone(), Arc::clone(&handle));
        // 容量兜底（T-AB-12 5）：超上限 FIFO 淘汰最旧条目（运行中先终止）。
        // 在登记之后执行——新任务永不成为本轮淘汰对象。
        self.evict_overflow().await;

        Ok(BackgroundTaskRef { task_id, log_path })
    }

    async fn list(&self, include_finished: bool) -> Result<Vec<BackgroundTaskInfo>, ToolError> {
        // 惰性清扫（T-AB-12 1「list 调用时同样惰性过滤」）：不依赖归档循环
        // 线程的到达时序——每次 list 前清一遍到期终态条目（n ≤ 200，代价 O(n)）。
        // 已归档条目自此不可见（list/status/read_log 均 NotFound 附归档指引）。
        self.archive_expired();
        let tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        let now = now_millis() as u64;
        let mut out: Vec<BackgroundTaskInfo> = Vec::with_capacity(tasks.len());
        for handle in tasks.values() {
            let mut info = handle
                .info
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            if !include_finished && Self::is_terminal(info.status) {
                continue;
            }
            // 运行中任务：duration 实时计算（终态由 writer 固化）
            if info.finished_at_ms.is_none() {
                info.duration_ms = now.saturating_sub(info.started_at_ms);
            }
            out.push(info);
        }
        // 稳定序：started_at 降序（新在前，前端 sortBackgroundTasksByStartedAt 同口径）
        out.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms));
        Ok(out)
    }

    /// status：状态快照 + 尾部（内存预览，无 [out]/[err] 前缀）+ 摘要模板。
    ///
    /// 终态 flush 自洽（T-AB-09 6）：状态翻转为终态发生在 writer 任务内、全部
    /// 落盘与 meta 收尾之后——本方法读到终态即代表 tail/line_count 与文件一致，
    /// 无需额外 await writer JoinHandle（屏障即终态翻转本身）。
    async fn status(&self, task_id: &str) -> Result<BackgroundTaskStatus, ToolError> {
        let handle = self.get_handle(task_id)?;
        let info = handle.info.read().unwrap_or_else(|p| p.into_inner());
        let tail = {
            let preview = handle.preview.lock().unwrap_or_else(|p| p.into_inner());
            preview.tail_lines(20).join("\n")
        };
        let now = now_millis() as u64;
        let duration_ms = info
            .finished_at_ms
            .map(|f| f.saturating_sub(info.started_at_ms))
            .unwrap_or_else(|| now.saturating_sub(info.started_at_ms));
        // 终止诊断留痕（T-AB-11：kill 两阶段留痕；透传冻结字段
        // termination_diagnostics）
        let termination_diagnostics = {
            let guard = handle.diagnostics.lock().unwrap_or_else(|p| p.into_inner());
            guard.clone()
        };
        // 摘要模板（REQ-A05；R-AB3 唤醒注入消费，先经 trace 留痕）
        let summary = task_summary(&info, duration_ms);
        tracing::trace!(
            target: "background",
            task_id = %info.task_id,
            summary = %summary,
            "任务状态摘要"
        );
        Ok(BackgroundTaskStatus {
            task_id: info.task_id.clone(),
            status: info.status,
            exit_code: info.exit_code,
            log_path: info.log_path.clone(),
            duration_ms,
            line_count: info.line_count,
            last_output_at_ms: info.last_output_at_ms,
            resource: info.resource.clone(),
            tail,
            prompt: info.prompt.clone(),
            termination_diagnostics,
        })
    }

    /// read_log：按行范围读取（REQ-A05，T-AB-09 2）。
    ///
    /// - `start_line=None`：尾部读取——`file_info` 拿 size → `read_chunk` 从尾回退
    ///   64KB → 本地拆行取最后 max_lines 行（完整行边界，容忍 append 半行）；
    /// - `start_line=Some(n)`：`.meta.json` checkpoint 二分定位行首偏移 →
    ///   `read_chunk` 顺序读（索引只做快速定位，读到索引末尾回退文件实际末尾）；
    /// - 返回行内容为「去前缀」的用户可见文本；行号指文件物理行号（1-indexed）；
    /// - 空结果约定：start_line=0 / end_line=0（无返回行）。
    async fn read_log(
        &self,
        task_id: &str,
        start_line: Option<u64>,
        max_lines: u64,
    ) -> Result<LogSlice, ToolError> {
        let handle = self.get_handle(task_id)?;
        let (log_path, total_lines) = {
            let guard = handle.info.read().unwrap_or_else(|p| p.into_inner());
            (PathBuf::from(guard.log_path.clone()), guard.line_count)
        };
        if max_lines == 0 {
            return Ok(LogSlice {
                task_id: task_id.to_string(),
                start_line: 0,
                end_line: 0,
                total_lines,
                lines: Vec::new(),
                truncated: false,
            });
        }
        // 日志文件尚未创建（任务尚无输出，或落盘降级）：返回空切片
        if !log_path.exists() {
            return Ok(LogSlice {
                task_id: task_id.to_string(),
                start_line: 0,
                end_line: 0,
                total_lines: 0,
                lines: Vec::new(),
                truncated: false,
            });
        }
        let meta_path = log_path.with_extension("meta.json");
        let (lines, first_line, truncated) = match start_line {
            None => read_log_tail(&log_path, total_lines, max_lines),
            Some(n) => read_log_range(&log_path, &meta_path, total_lines, n, max_lines),
        };
        let end_line = if lines.is_empty() {
            0
        } else {
            first_line + lines.len() as u64 - 1
        };
        Ok(LogSlice {
            task_id: task_id.to_string(),
            start_line: first_line,
            end_line,
            total_lines,
            lines,
            truncated,
        })
    }

    /// send_input：向任务 stdin 写入（T-AB-10 2）。
    ///
    /// - 默认末尾追加 `\n`；`append_newline=false` 显式关闭；
    /// - 失败分类：task_not_found（NotFound）/ stdin_closed（BrokenPipe 后清空
    ///   Option，后续调用继续返回 stdin_closed）/ 成功；
    /// - tokio 非阻塞写入（背压由管道缓冲自然承担，不影响子进程执行）。
    async fn send_input(
        &self,
        task_id: &str,
        text: &str,
        append_newline: bool,
    ) -> Result<(), ToolError> {
        let handle = self.get_handle(task_id)?;
        // 双写竞态（T-AB-10 5）：Mutex 串行化；写入失败清空 Option
        let mut guard = handle.stdin.lock().await;
        let Some(mut stdin) = guard.take() else {
            // 槽位为空：管道从未接通（spawn 未开管道）或已关闭（进程退出 / BrokenPipe）
            return Err(Self::stdin_closed(task_id));
        };
        let mut payload = String::with_capacity(text.len() + 1);
        payload.push_str(text);
        if append_newline {
            payload.push('\n');
        }
        use tokio::io::AsyncWriteExt;
        let mut res = stdin.write_all(payload.as_bytes()).await;
        if res.is_ok() {
            res = stdin.flush().await;
        }
        match res {
            Ok(()) => {
                *guard = Some(stdin);
                Ok(())
            }
            Err(e) => {
                // 写入失败（BrokenPipe 等）：槽位已 take，置空保持（后续调用
                // 走「槽位为空 → stdin_closed」分支，不再触碰管道）
                tracing::debug!(
                    target: "background",
                    task_id = %task_id,
                    error = %e,
                    "stdin 写入失败，槽位清空（stdin_closed）"
                );
                Err(Self::stdin_closed(task_id))
            }
        }
    }

    /// 两阶段终止（委托 bg_kill::kill_task 内部实现）
    async fn kill(&self, task_id: &str) -> Result<KillResult, ToolError> {
        super::bg_kill::kill_task(self, task_id).await
    }
}
