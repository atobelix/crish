//! shell 工具 · 前后台执行 / 流式状态机（SR-06a-2 拆分子模块）
//!
//! 逻辑域：三模式执行分流（sync 超时树杀 / auto-background 收养 / daemon
//! 立即转后台）、S1 流式状态机（unfold 逐块推送 / 预算 / abort / 超时）、
//! adopt 转移、进程树杀（terminate_process_tree）。子进程仅经命令门禁
//! （prepare）后产生。
//! 诚实边界：仅结构拆分，语义零改动（≠ EL-01…10 / ≠ 打开完成 / ≠ 结构债清零）。

use crate::background::{BackgroundAdoptRequest, BackgroundTaskManager};
use crate::context::{AbortToken, ToolContext};
use crate::definition::ToolError;
use crate::streaming::{terminal_only, ToolProgress, ToolStream, ToolStreamItem};
use futures_util::StreamExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::time::Duration;

use super::shell_invoke::{build_shell_invocation, decode_console_bytes, ShellMode};
use super::shell_output::{
    build_sync_result, build_timeout_result, stream_until_deadline, epoch_millis_now, StreamEnd,
    OutputAccumulator,
};
use super::PreparedCommand;

/// 执行命令并收集输出（T-AB-01 流式化 + T-AB-02 三模式）
// G2 允许理由（clippy::too_many_arguments）：参数为上下文聚合注入（命令/
// cwd/超时/输出上限/模式/等待时长/后台收养/日志根/会话号等），各参数来源
// 独立，收缩将退化为全局态或拆分 struct 而收益低。
// G2 禁令豁免（clippy.toml 文件头「豁免面」）：命令门禁执行面——本函数只被
// shell 工具调用，且调用前必经 CommandGatekeeper 检查（blocked/approval，
// 见本文件 execute），是「子进程经命令门禁」的门禁落地处本身。
#[allow(clippy::too_many_arguments, clippy::disallowed_methods)]
pub(crate) async fn run_command_maybe_background(
    command: &str,
    cwd: &std::path::Path,
    timeout_ms: u64,
    max_output_bytes: usize,
    mode: ShellMode,
    wait_ms: u64,
    is_daemon: bool,
    resource_monitor: bool,
    manager: Option<Arc<dyn BackgroundTaskManager>>,
    log_root: Option<PathBuf>,
    session_id: &str,
) -> Result<serde_json::Value, ToolError> {
    let (program, args, shell_label) =
        build_shell_invocation(command).map_err(|e| ToolError::execution_failed("shell_command", e))?;

    let mut child_cmd = TokioCommand::new(&program);
    child_cmd
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // T-AB-02：kill_on_drop(false)——后台化后 drop 不得连杀子进程；
        // 同步路径的超时树杀改为显式执行（见超时分支），两条路径不双杀
        .kill_on_drop(false);
    // Windows：隐藏控制台闪现（trait 方法已稳定，导入仅保编译兼容）
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        child_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // 子进程优先 UTF-8 输出（T-AB-03：PAGER=cat 防交互式分页器挂起）
    child_cmd.env("PYTHONUTF8", "1");
    child_cmd.env("PYTHONIOENCODING", "utf-8");
    child_cmd.env("PAGER", "cat");

    let mut child = child_cmd
        .spawn()
        .map_err(|e| ToolError::execution_failed("shell_command", format!("failed to spawn {shell_label}: {e}")))?;
    let child_pid = child.id();
    let started = std::time::Instant::now();

    // 模式 3（daemon）：spawn 后立即 adopt（is_daemon=true），管道原样留在
    // Child 内不取出；未接线（manager None）时回退同步语义（不报错）
    let effective_mode = if mode == ShellMode::Daemon {
        if let Some(mgr) = &manager {
            return adopt_child(
                Arc::clone(mgr),
                child,
                command,
                cwd,
                true,
                resource_monitor,
                shell_label,
            )
            .await;
        }
        ShellMode::Sync
    } else {
        mode
    };

    // T-AB-01：拆 stdout/stderr 两个 BufReader 流式读取（fill_buf/consume
    // 持续消费——管道写满不会阻塞子进程，且缓冲内不残留未消费字节，
    // 转后台移交管道时不丢数据）
    let out_pipe = child
        .stdout
        .take()
        .ok_or_else(|| ToolError::execution_failed("shell_command", "stdout pipe missing"))?;
    let err_pipe = child
        .stderr
        .take()
        .ok_or_else(|| ToolError::execution_failed("shell_command", "stderr pipe missing"))?;
    let mut out_reader = BufReader::new(out_pipe);
    let mut err_reader = BufReader::new(err_pipe);
    let mut acc_out = OutputAccumulator::new();
    let mut acc_err = OutputAccumulator::new();

    // 等待窗口：sync = timeoutMs（AI 显式设置的绝对上限）；auto-background =
    // min(waitMsBeforeAsync, timeoutMs)——timeoutMs 仍是等待上限，超窗一律
    // 不杀（转后台），「转后台任务默认无限运行」
    let window_ms = match effective_mode {
        ShellMode::Sync => timeout_ms,
        ShellMode::AutoBackground => wait_ms.min(timeout_ms),
        ShellMode::Daemon => unreachable!("daemon 已在上面短路"),
    };
    let deadline = tokio::time::Instant::now() + Duration::from_millis(window_ms);

    let streamed = stream_until_deadline(&mut out_reader, &mut err_reader, &mut acc_out, &mut acc_err, deadline).await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match streamed {
        // 窗口内完成：同步路径自行回收（wait 后 drop，无泄漏；无 adopt 调用）
        StreamEnd::Completed => {
            let exit_code = child.wait().await.ok().and_then(|s| s.code());
            build_sync_result(
                command,
                cwd,
                &shell_label,
                exit_code,
                duration_ms,
                &acc_out,
                &acc_err,
                max_output_bytes,
                log_root.as_deref(),
                session_id,
            )
        }
        // 窗口超时
        StreamEnd::TimedOut => {
            if effective_mode == ShellMode::AutoBackground {
                // 不杀：管道收回 Child → adopt 转移（所有权归 registry）。
                // 超时已完成读取的字节经 BufReader::into_inner 丢弃为空的缓冲
                // 无损失（fill_buf/consume 全程消费），registry 从管道续读
                child.stdout = Some(out_reader.into_inner());
                child.stderr = Some(err_reader.into_inner());
                match manager {
                    Some(manager) => {
                        adopt_child(
                            manager,
                            child,
                            command,
                            cwd,
                            is_daemon,
                            resource_monitor,
                            shell_label,
                        )
                        .await
                    }
                // 未接线环境：保持现状（超时即杀 + 树杀），零回归——
                // 管道已收回 child，reader 已被 into_inner 消费，无需再 drop
                None => {
                    if let Some(pid) = child_pid {
                        let _ = terminate_process_tree(pid);
                    }
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    Ok(build_timeout_result(
                        command,
                        cwd,
                        &shell_label,
                        timeout_ms,
                        duration_ms,
                    ))
                }
                }
            } else {
                // 同步模式：树杀语义不变（先 drop 流式 reader 句柄再树杀，
                // 避免句柄泄漏与子进程写端永久阻塞）
                drop(out_reader);
                drop(err_reader);
                if let Some(pid) = child_pid {
                    let _ = terminate_process_tree(pid);
                }
                let _ = child.kill().await;
                let _ = child.wait().await;
                Ok(build_timeout_result(
                    command,
                    cwd,
                    &shell_label,
                    timeout_ms,
                    duration_ms,
                ))
            }
        }
    }
}

// ==================== S1：流式执行（TOOLS-01 §3.1.6）====================

/// S1 流式执行主入口：spawn 后以状态机逐块读取双管道，进程退出后
/// Terminal 返回聚合结果（复用 build_sync_result → 与 execute 同步路径
/// 逐字节一致）。与 execute 的差异只在「读取与推送」：execute 的
/// stream_until_deadline 静默累积，本路径每个数据块单独推一条
/// ToolProgress::Text；预算 / abort / 超时语义均与 execute 对齐。
// G2 禁令豁免（clippy.toml 豁免面「内部进程管理原语」）：tokio spawn——
// 命令已过命令门禁（prepare）才产生进程，与 run_command_maybe_background
// 同一豁免面（函数级 allow + 理由）。
#[allow(clippy::disallowed_methods)]
pub(crate) async fn run_command_streaming(ctx: &ToolContext, c: PreparedCommand) -> ToolStream {
    let (program, shell_args, shell_label) =
        match build_shell_invocation(&c.command) {
            Ok(v) => v,
            Err(e) => return terminal_only(Err(ToolError::execution_failed("shell_command", e))),
        };

    let mut child_cmd = TokioCommand::new(&program);
    child_cmd
        .args(&shell_args)
        .current_dir(&c.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // T-AB-02：kill_on_drop(false)——abort / 超时收口由本路径显式杀
        // （kill_child），drop 不连杀（与 execute 同步路径同构，不双杀）
        .kill_on_drop(false);
    // Windows：隐藏控制台闪现（与 execute 同步路径同构）
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        child_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // 子进程优先 UTF-8 输出（T-AB-03：PAGER=cat 防交互式分页器挂起）
    child_cmd.env("PYTHONUTF8", "1");
    child_cmd.env("PYTHONIOENCODING", "utf-8");
    child_cmd.env("PAGER", "cat");

    let mut child = match child_cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return terminal_only(Err(ToolError::execution_failed(
                "shell_command",
                format!("failed to spawn {shell_label}: {e}"),
            )))
        }
    };
    let child_pid = child.id();
    let out_pipe = match child.stdout.take() {
        Some(pipe) => pipe,
        None => {
            return terminal_only(Err(ToolError::execution_failed(
                "shell_command",
                "stdout pipe missing",
            )))
        }
    };
    let err_pipe = match child.stderr.take() {
        Some(pipe) => pipe,
        None => {
            return terminal_only(Err(ToolError::execution_failed(
                "shell_command",
                "stderr pipe missing",
            )))
        }
    };

    let state = ShellStreamState::Running(RunningState {
        child,
        out_reader: BufReader::new(out_pipe),
        err_reader: BufReader::new(err_pipe),
        acc_out: OutputAccumulator::new(),
        acc_err: OutputAccumulator::new(),
        out_eof: false,
        err_eof: false,
        cum_bytes: 0,
        budget_exceeded: false,
        max_output_bytes: c.max_output_bytes,
        // sync 路径：等待窗口 = timeoutMs（AI 显式设置的绝对长跑防护上限）
        deadline: tokio::time::Instant::now() + Duration::from_millis(c.timeout_ms),
        timeout_ms: c.timeout_ms,
        command: c.command,
        cwd: c.cwd,
        shell_label,
        started: std::time::Instant::now(),
        log_root: ctx.log_root.clone(),
        session_id: ctx.session_id.clone(),
        abort_token: ctx.abort_token.clone(),
        child_pid,
    });
    futures_util::stream::unfold(state, ShellStreamState::step).boxed()
}

/// 流式运行期状态（ShellStreamState::Running 载荷，unfold 帧间持有）
struct RunningState {
    child: tokio::process::Child,
    out_reader: BufReader<tokio::process::ChildStdout>,
    err_reader: BufReader<tokio::process::ChildStderr>,
    acc_out: OutputAccumulator,
    acc_err: OutputAccumulator,
    out_eof: bool,
    err_eof: bool,
    /// 流式累计推送字节（stdout+stderr 合计；maxOutputBytes 累计预算）
    cum_bytes: usize,
    /// 预算超限标记：停止推送 Progress（管道仍持续排空防死锁）
    budget_exceeded: bool,
    max_output_bytes: usize,
    deadline: tokio::time::Instant,
    timeout_ms: u64,
    command: String,
    cwd: PathBuf,
    shell_label: String,
    started: std::time::Instant,
    log_root: Option<PathBuf>,
    session_id: String,
    abort_token: AbortToken,
    child_pid: Option<u32>,
}

/// 流式执行状态机
// G2 允许理由（clippy::large_enum_variant）：状态机实例同一时刻只有
// 一个（unfold 帧间独占转移），RunningState 大 / Done 为单元是单元素
// 哨兵的自然形状，装箱只会引入无谓堆分配与借用复杂度。
#[allow(clippy::large_enum_variant)]
enum ShellStreamState {
    /// 管道读取进行中（单帧 = 至多一条 Progress / 一个 Terminal）
    Running(RunningState),
    /// 已产出 Terminal，unfold 收口（返回 None）
    Done,
}

impl ShellStreamState {
    /// 单步推进（unfold 帧）：返回 (流项, 下一状态)；Done 收口为 None。
    ///
    /// 判定顺序（§3.1.6 流不变式：Progress* + Terminal 恒为末项）：
    /// 1. abort——每块读取前自查 ctx.abort_token，中止即停止推送、
    ///    杀进程尽快收口（已聚合字节进 Terminal，供非中止消费方兜底）；
    /// 2. 超时——sync 窗口（= timeoutMs）耗尽 → 树杀 + timedOut 结果收口
    ///    （与 execute 同步路径超时形状一致）；
    /// 3. 双管道 EOF——wait 回收 + 聚合结果收口（build_sync_result 复用）；
    /// 4. 读块循环——select 交替读 stdout/stderr 单块，每块推一条
    ///    Progress；预算超限帧不推送（push_chunk 返回 None）续帧排空。
    async fn step(self) -> Option<(ToolStreamItem, ShellStreamState)> {
        let mut r = match self {
            ShellStreamState::Running(r) => r,
            ShellStreamState::Done => return None,
        };

        // 1. abort（每块读取前自查）：中止即停止推送、杀进程尽快收口
        if r.abort_token.is_aborted() {
            kill_child(r.child, r.child_pid).await;
            let duration_ms = r.started.elapsed().as_millis() as u64;
            let terminal = build_sync_result(
                &r.command,
                &r.cwd,
                &r.shell_label,
                None,
                duration_ms,
                &r.acc_out,
                &r.acc_err,
                r.max_output_bytes,
                r.log_root.as_deref(),
                &r.session_id,
            );
            return Some((ToolStreamItem::Terminal(terminal), ShellStreamState::Done));
        }

        // 2-4：读块循环——直至产生可推帧（Progress）或收口（EOF 双端 / 超时）
        loop {
            // 双 EOF：输出已读尽 → wait 回收，聚合结果收口（与 execute
            // 同步路径同构：退出码 + stdout/stderr 捕获 + 截断 / 落盘）
            if r.out_eof && r.err_eof {
                let exit_code = r.child.wait().await.ok().and_then(|s| s.code());
                let duration_ms = r.started.elapsed().as_millis() as u64;
                let terminal = build_sync_result(
                    &r.command,
                    &r.cwd,
                    &r.shell_label,
                    exit_code,
                    duration_ms,
                    &r.acc_out,
                    &r.acc_err,
                    r.max_output_bytes,
                    r.log_root.as_deref(),
                    &r.session_id,
                );
                return Some((ToolStreamItem::Terminal(terminal), ShellStreamState::Done));
            }
            // 超时：等待窗口（sync = timeoutMs）耗尽 → 树杀 + timedOut 收口
            if tokio::time::Instant::now() >= r.deadline {
                kill_child(r.child, r.child_pid).await;
                let duration_ms = r.started.elapsed().as_millis() as u64;
                let terminal = Ok(build_timeout_result(
                    &r.command,
                    &r.cwd,
                    &r.shell_label,
                    r.timeout_ms,
                    duration_ms,
                ));
                return Some((ToolStreamItem::Terminal(terminal), ShellStreamState::Done));
            }
            let remain = r
                .deadline
                .saturating_duration_since(tokio::time::Instant::now());
            tokio::select! {
                // 等待窗口耗尽（与上方 now >= deadline 检查互补）
                _ = tokio::time::sleep(remain) => {
                    kill_child(r.child, r.child_pid).await;
                    let duration_ms = r.started.elapsed().as_millis() as u64;
                    let terminal = Ok(build_timeout_result(
                        &r.command,
                        &r.cwd,
                        &r.shell_label,
                        r.timeout_ms,
                        duration_ms,
                    ));
                    return Some((ToolStreamItem::Terminal(terminal), ShellStreamState::Done));
                }
                // stdout 块 → Progress（逐块推送，§3.1.8 逐块到达）
                res = read_one_chunk(&mut r.out_reader), if !r.out_eof => {
                    // 读取错误按 EOF 处理（管道异常不致命，退出码仍可回收）
                    let (chunk, eof) = res.unwrap_or_else(|_| (Vec::new(), true));
                    r.out_eof = eof;
                    if let Some(item) = push_chunk(&mut r, &chunk, false) {
                        return Some((item, ShellStreamState::Running(r)));
                    }
                }
                // stderr 块 → Progress（带 [stderr] 前缀）
                res = read_one_chunk(&mut r.err_reader), if !r.err_eof => {
                    let (chunk, eof) = res.unwrap_or_else(|_| (Vec::new(), true));
                    r.err_eof = eof;
                    if let Some(item) = push_chunk(&mut r, &chunk, true) {
                        return Some((item, ShellStreamState::Running(r)));
                    }
                }
            }
        }
    }
}

/// 累积一个数据块并（未超预算时）构造 Progress 帧：
/// - 无条件累积到聚合累积器（预览 / 行数 / 最近输出时间，T-AB-01 语义
///   不变；全量字节供截断落盘 spill_full_output，结果与 execute 一致）；
/// - 预算判定（§3.1.6）：累计推送字节 + 本块 ≤ maxOutputBytes 才推送；
///   超限置 budget_exceeded 并停止推送（本块及后续均不推）——「实时截断」，
///   结果仍经 build_sync_result 标记 truncated（与现状 200KB 语义一致）；
/// - stderr 块带 `[stderr] ` 前缀（展示面可区分；聚合结果 stderr 字段
///   独立捕获，形状不变）。
///
/// 返回 None = 本块未推送（EOF 空块 / 预算超限），调用方续帧排空管道。
fn push_chunk(r: &mut RunningState, chunk: &[u8], is_err: bool) -> Option<ToolStreamItem> {
    if chunk.is_empty() {
        return None;
    }
    let now_ms = epoch_millis_now();
    if is_err {
        r.acc_err.append(chunk, now_ms);
    } else {
        r.acc_out.append(chunk, now_ms);
    }
    if r.budget_exceeded {
        return None;
    }
    if r.cum_bytes + chunk.len() > r.max_output_bytes {
        r.budget_exceeded = true;
        return None;
    }
    r.cum_bytes += chunk.len();
    let text = if is_err {
        format!("[stderr] {}", decode_console_bytes(chunk))
    } else {
        decode_console_bytes(chunk)
    };
    Some(ToolStreamItem::Progress(ToolProgress::Text { text }))
}

/// 读取一个可用数据块（fill_buf → consume）：返回 (块内容, 是否 EOF)。
/// 每帧至多读一块 → 每块独立一条 Progress（逐块到达语义 §3.1.8）；
/// 块大小 ≤ BufReader 容量，与 drain_available 共用 fill_buf/consume
/// 语义（缓冲内不残留未消费字节）。
async fn read_one_chunk<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<(Vec<u8>, bool)> {
    let buf = reader.fill_buf().await?;
    if buf.is_empty() {
        return Ok((Vec::new(), true));
    }
    // 先取长度再复制：fill_buf 返回的切片借用 reader，consume 需要 &mut——
    // 复制与长度提前取值可解除借用（NLL）
    let len = buf.len();
    let chunk = buf.to_vec();
    reader.consume(len);
    Ok((chunk, false))
}

/// 收口杀进程（abort / 超时共用）：先树杀（Windows taskkill 树 / Unix
/// kill -TERM），再 kill + wait 回收——与 execute 同步路径超时分支同构
/// （kill_on_drop(false) 下必须显式杀，防孤儿进程）
async fn kill_child(mut child: tokio::process::Child, child_pid: Option<u32>) {
    if let Some(pid) = child_pid {
        let _ = terminate_process_tree(pid);
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// adopt 转移（T-AB-02）：Child 所有权交 registry；返回 background 结果信封
async fn adopt_child(
    manager: Arc<dyn BackgroundTaskManager>,
    child: tokio::process::Child,
    command: &str,
    cwd: &Path,
    is_daemon: bool,
    resource_monitor: bool,
    shell_label: String,
) -> Result<serde_json::Value, ToolError> {
    // 命令摘要（前 64 字符）
    let summary: String = command.chars().take(64).collect();
    let req = BackgroundAdoptRequest {
        child,
        command: summary,
        cwd: cwd.to_path_buf(),
        is_daemon,
        resource_monitor,
        // R-AB3 接线 owner_run_id（审计与过滤用，不级联杀）
        owner_run_id: None,
    };
    let result = manager.adopt(req).await.map_err(|e| {
        ToolError::new(
            e.code(),
            format!("后台托管失败（adopt）：{e}"),
        )
    })?;
    let text = format!("命令已转后台（task {}），可随时查询状态", result.task_id);
    Ok(serde_json::json!({
        "mode": "background",
        "taskId": result.task_id,
        "logPath": result.log_path.display().to_string(),
        "command": command,
        "cwd": cwd.display().to_string(),
        "shell": shell_label,
        "text": text,
    }))
}

/// 终止进程树：Windows taskkill 树杀，其它平台 kill -TERM
// G2 禁令豁免（clippy.toml 豁免面「内部进程管理原语」）：taskkill 树杀——
// 工具执行面终止原语：命令已过命令门禁才产生进程，树杀是执行后的生命周期
// 清理（同 process.rs terminate_process_tree 语义）；固定系统工具 + PID 数字
// 参数，output() 同步等待型，子进程不脱离会话存活。
#[allow(clippy::disallowed_methods)]
#[cfg(target_os = "windows")]
pub(crate) fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let output = std::process::Command::new("taskkill")
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

/// 终止进程树（Unix 简化版：kill -TERM）
// G2 禁令豁免（clippy.toml 豁免面「内部进程管理原语」）：kill -TERM 进程树
// 终止（Unix 分支，同 Windows taskkill 语义）——固定系统工具 + PID 数字参数，
// output() 同步等待型，子进程不脱离会话存活。
#[allow(clippy::disallowed_methods)]
#[cfg(not(target_os = "windows"))]
pub(crate) fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let output = std::process::Command::new("kill")
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
