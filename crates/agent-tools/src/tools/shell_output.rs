//! shell 工具 · 输出侧（读取 / 累积 / 结果构造 / 落盘）（SR-06a-2 拆分子模块）
//!
//! 逻辑域：T-AB-01 有界预览累积器（头/尾 24KB）、同步路径双管道读取
//! （stream_until_deadline / drain_available）、同步/超时结果构造、截断落盘
//! （spill_full_output）、高输出建议、G8 截断基准（clamp_output_bytes）。
//! 输出形状与拆分前逐字节一致。
//! 诚实边界：仅结构拆分，语义零改动（≠ EL-01…10 / ≠ 打开完成 / ≠ 结构债清零）。

use crate::definition::ToolError;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};

use super::shell_invoke::decode_console_bytes;

/// 流式输出内存预览上限（T-AB-01：头部/尾部各 24KB，结果侧不驻留全量字节）
const PREVIEW_HEAD_BYTES: usize = 24 * 1024;
/// 流式输出内存预览上限（T-AB-01：尾部 24KB）
const PREVIEW_TAIL_BYTES: usize = 24 * 1024;

/// 超时结果构造（T-AB-02：sync 树杀路径与 S1 流式路径共用同一形状——
/// timedOut=true + 超时文案，对齐改造前语义，防两路径漂移）
pub(crate) fn build_timeout_result(
    command: &str,
    cwd: &Path,
    shell_label: &str,
    timeout_ms: u64,
    duration_ms: u64,
) -> serde_json::Value {
    let stderr = format!("(命令超时，已终止 · {timeout_ms}ms)");
    serde_json::json!({
        "command": command,
        "cwd": cwd.display().to_string(),
        "shell": shell_label,
        "exitCode": null,
        "stdout": "",
        "stderr": stderr,
        "timedOut": true,
        "truncated": false,
        "durationMs": duration_ms,
        "mode": "sync",
        "text": stderr,
    })
}

/// 流式读取结果（T-AB-01）
pub(crate) enum StreamEnd {
    /// 双管道 EOF，进程已可回收
    Completed,
    /// 等待窗口耗尽（尚未完成）
    TimedOut,
}

/// 双管道流式读取直到 deadline 或双 EOF（T-AB-01）
///
/// fill_buf/consume 语义：每次 fill_buf 返回缓冲内全部可用数据，consume
/// 全部消费——BufReader 内不残留未消费字节，窗口超时后 into_inner 收回
/// 管道移交 registry 时不丢已读数据。两个管道在 select! 中交替消费，
/// 任一管道持续输出不会阻塞另一管道（管道缓冲死锁防护）。
pub(crate) async fn stream_until_deadline(
    out_reader: &mut BufReader<tokio::process::ChildStdout>,
    err_reader: &mut BufReader<tokio::process::ChildStderr>,
    acc_out: &mut OutputAccumulator,
    acc_err: &mut OutputAccumulator,
    deadline: tokio::time::Instant,
) -> StreamEnd {
    let mut out_eof = false;
    let mut err_eof = false;
    loop {
        if tokio::time::Instant::now() >= deadline {
            return StreamEnd::TimedOut;
        }
        if out_eof && err_eof {
            return StreamEnd::Completed;
        }
        let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
        tokio::select! {
            _ = tokio::time::sleep(remain) => {
                return StreamEnd::TimedOut;
            }
            r = drain_available(out_reader, acc_out), if !out_eof => {
                // 读取错误按 EOF 处理（管道异常不致命，进程退出码仍可回收）
                out_eof = r.unwrap_or(true);
            }
            r = drain_available(err_reader, acc_err), if !err_eof => {
                err_eof = r.unwrap_or(true);
            }
        }
    }
}

/// 消费当前可用数据（fill_buf → append → consume，循环至管道暂空或 EOF）；
/// 返回 true = 已 EOF。管道写满不会阻塞子进程（持续读取即死锁防护）。
async fn drain_available<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    acc: &mut OutputAccumulator,
) -> std::io::Result<bool> {
    loop {
        let buf = reader.fill_buf().await?;
        if buf.is_empty() {
            return Ok(true);
        }
        acc.append(buf, epoch_millis_now());
        let len = buf.len();
        reader.consume(len);
    }
}

/// 纪元毫秒（流式循环维护 last_output_at_ms 用）
pub(crate) fn epoch_millis_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 流式输出累积器（T-AB-01）
///
/// - `bytes`：全量字节——clamp 与截断落盘（T-AB-03）需要，命令完成后即释放；
/// - `preview`：有界内存预览（头 24KB + 尾 24KB）——截断时结果侧展示内容，
///   原始全量字节不驻留结果；
/// - `lines` / `last_output_at_ms`：行计数与最近输出时间（后台化预留，
///   R-AB3 资源监控消费）。
pub(crate) struct OutputAccumulator {
    bytes: Vec<u8>,
    preview: BoundedPreview,
    lines: u64,
    last_output_at_ms: u64,
}

impl OutputAccumulator {
    pub(crate) fn new() -> Self {
        Self {
            bytes: Vec::new(),
            preview: BoundedPreview::new(),
            lines: 0,
            last_output_at_ms: 0,
        }
    }

    /// 追加一个数据块（更新全量字节 / 有界预览 / 行计数 / 最近输出时间）
    pub(crate) fn append(&mut self, chunk: &[u8], now_ms: u64) {
        self.bytes.extend_from_slice(chunk);
        self.preview.append(chunk);
        self.lines += chunk.iter().filter(|&&b| b == b'\n').count() as u64;
        if !chunk.is_empty() {
            self.last_output_at_ms = now_ms;
        }
    }

    /// 预览文本：头 24KB + 截断标记 + 尾 24KB（未截断时为全量）
    fn preview_text(&self, max_output_bytes: usize) -> (String, bool) {
        if self.bytes.len() <= max_output_bytes {
            return (decode_console_bytes(&self.bytes), false);
        }
        let omitted = self
            .bytes
            .len()
            .saturating_sub(self.preview.head.len() + self.preview.tail.len());
        let text = format!(
            "{}\n\n[output truncated: {omitted} bytes omitted]\n\n{}",
            decode_console_bytes(&self.preview.head),
            decode_console_bytes(&self.preview.tail),
        );
        (text, true)
    }
}

/// 有界内存预览（头部/尾部各 24KB，T-AB-01）
struct BoundedPreview {
    head: Vec<u8>,
    tail: Vec<u8>,
}

impl BoundedPreview {
    fn new() -> Self {
        Self {
            head: Vec::new(),
            tail: Vec::new(),
        }
    }

    fn append(&mut self, chunk: &[u8]) {
        if self.head.len() < PREVIEW_HEAD_BYTES {
            let take = (PREVIEW_HEAD_BYTES - self.head.len()).min(chunk.len());
            self.head.extend_from_slice(&chunk[..take]);
        }
        self.tail.extend_from_slice(chunk);
        if self.tail.len() > PREVIEW_TAIL_BYTES {
            let over = self.tail.len() - PREVIEW_TAIL_BYTES;
            self.tail.drain(..over);
        }
    }
}

/// 同步结果构造（T-AB-01/03）：截断判定 + 有界预览结果 + 截断落盘 + 建议
// G2 允许理由（clippy::too_many_arguments）：参数为命令执行上下文聚合注入
// （命令/cwd/退出码/时长/双输出累加器/截断上限/日志根/会话号），各参数来源
// 独立，收缩将退化为全局态或拆分 struct 而收益低。
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_sync_result(
    command: &str,
    cwd: &Path,
    shell_label: &str,
    exit_code: Option<i32>,
    duration_ms: u64,
    acc_out: &OutputAccumulator,
    acc_err: &OutputAccumulator,
    max_output_bytes: usize,
    log_root: Option<&Path>,
    session_id: &str,
) -> Result<serde_json::Value, ToolError> {
    // T-AB-01：窗口内完成 = 输出与改造前逐字节一致（未截断时全量字节）；
    // 截断时结果展示有界预览（头/尾 24KB），全量字节仅用于落盘
    let (stdout, trunc_out) = acc_out.preview_text(max_output_bytes);
    let (stderr, trunc_err) = acc_err.preview_text(max_output_bytes);
    let truncated = trunc_out || trunc_err;

    // T-AB-03：截断落盘（best-effort）——log_root 为 None 或写盘失败 → 仅
    // 截断 + 无 logPath，命令不失败（对齐 perf/jsonl.rs:49-72 错误风格）
    let log_path = if truncated {
        spill_full_output(log_root, session_id, &acc_out.bytes, &acc_err.bytes)
    } else {
        None
    };

    let mut text = format_command_result(&stdout, &stderr, exit_code, false);
    if let Some(lp) = &log_path {
        text.push_str(&format!(
            "\n\n输出已截断，完整日志保存在 {lp}，可通过文件读取工具查看完整内容"
        ));
    }
    // T-AB-03：高输出命令建议（纯函数，不引入调度逻辑）
    if truncated {
        if let Some(suggestion) = high_output_suggestion(command) {
            text.push_str(&format!("\n提示：{suggestion}"));
        }
    }

    let mut v = serde_json::json!({
        "command": command,
        "cwd": cwd.display().to_string(),
        "shell": shell_label,
        "exitCode": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "timedOut": false,
        "truncated": truncated,
        "durationMs": duration_ms,
        "mode": "sync",
        "text": text,
    });
    if let Some(lp) = log_path {
        v["logPath"] = serde_json::Value::String(lp);
    }
    Ok(v)
}

/// 截断落盘（T-AB-03）：`<log_root>/sessions/<session_id>/<ts>-<seq>.log`，
/// 写入原始完整字节（stdout + stderr 顺序拼接）；失败返回 None（不失败）
fn spill_full_output(
    log_root: Option<&Path>,
    session_id: &str,
    stdout: &[u8],
    stderr: &[u8],
) -> Option<String> {
    let root = log_root?;
    let dir = root.join("sessions").join(session_id);
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    let seq = SPILL_SEQ.fetch_add(1, Ordering::SeqCst);
    let path = dir.join(format!("{ts}-{seq}.log"));
    let mut full = Vec::with_capacity(stdout.len() + stderr.len());
    full.extend_from_slice(stdout);
    full.extend_from_slice(stderr);
    if std::fs::write(&path, &full).is_err() {
        return None;
    }
    Some(path.display().to_string())
}

/// 截断落盘文件序号（进程级单调递增；会话内唯一）
static SPILL_SEQ: AtomicU64 = AtomicU64::new(0);

/// 高输出命令建议（T-AB-03，纯函数）：检测已知高输出形态（git log 无 -n /
/// git diff 无 --stat 等），追加「建议添加限制参数」提示——不引入调度逻辑
pub(crate) fn high_output_suggestion(command: &str) -> Option<String> {
    let lower = command.to_lowercase();
    if lower.contains("git log")
        && !lower.contains("-n")
        && !lower.contains("--max-count")
        && !lower.contains("--oneline")
        && !lower.contains("--stat")
    {
        return Some(
            "git log 输出可能较大，建议添加 -n <行数>（或 --oneline）限制输出行数".to_string(),
        );
    }
    if (lower.contains("git diff") || lower.contains("git show"))
        && !lower.contains("--stat")
        && !lower.contains("--name-only")
    {
        return Some("git diff/git show 输出可能较大，建议添加 --stat 或 --name-only 限制输出".to_string());
    }
    None
}

/// 输出截断：保留头尾各一半，中间省略（对齐 workbench clamp_output_bytes）
///
/// T-AB-01 改造后结果侧改由 OutputAccumulator::preview_text（有界 24KB
/// 头尾预览）承担，本函数保留为纯函数基准（G8 截断不回归，测试覆盖）
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn clamp_output_bytes(raw: &[u8], max_bytes: usize) -> (String, bool) {
    if raw.len() <= max_bytes {
        return (decode_console_bytes(raw), false);
    }
    let half = max_bytes / 2;
    let head = &raw[..half];
    let tail = &raw[raw.len() - half..];
    let omitted = raw.len() - head.len() - tail.len();
    let text = format!(
        "{}\n\n[output truncated: {omitted} bytes omitted]\n\n{}",
        decode_console_bytes(head),
        decode_console_bytes(tail),
    );
    (text, true)
}

/// 结果正文（对齐 TS formatCommandResult：正文 + 超时/退出码尾注）
pub(crate) fn format_command_result(
    stdout: &str,
    stderr: &str,
    exit_code: Option<i32>,
    timed_out: bool,
) -> String {
    let output = [stdout.trim_end(), stderr.trim_end()]
        .iter()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    if timed_out {
        return if output.is_empty() {
            "(命令超时)".to_string()
        } else {
            format!("{output}\n\n(命令超时)")
        };
    }
    if let Some(code) = exit_code {
        if code != 0 {
            return if output.is_empty() {
                format!("(exit {code})")
            } else {
                format!("{output}\n\n(exit {code})")
            };
        }
    }
    if output.is_empty() {
        "(无输出)".to_string()
    } else {
        output
    }
}
