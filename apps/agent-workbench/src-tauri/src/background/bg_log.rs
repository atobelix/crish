//! SR-05 · 拆分 · ≠ EL · 域：日志（T-AB-09：TaskMeta/meta 落盘/LogWriter/
//! 轮转护栏/解码与提示检测/read_log 文件侧实现）。结构拆分轮仅搬移，不改
//! 语义；诚实边界句全保留于各实现处。接线：background.rs `mod bg_log;`。

use agent_tools::background::{BackgroundTaskInfo, TaskState};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::Duration;

// SR-05 拆分接线：file_info/read_chunk 已迁入 perf::fs（bg_log 原实现
// 迁移点；import 同步补全）
use crate::perf::fs::{file_info, read_chunk};

// ============================================================================
// 常量（T-AB-09 日志生命周期参数）
// ============================================================================

/// 行数索引 checkpoint 间隔：每写满 512 行在 `.meta.json` 记一次行号→偏移
/// 定位点（checkpoint 只做快速定位，不做精确断言——索引滞后时回退实际末尾）
pub(crate) const CHECKPOINT_INTERVAL_LINES: u64 = 512;
/// 日志轮转护栏：单文件超 100MB 截断头部（保尾语义与 A03 一致）
const LOG_MAX_BYTES: u64 = 100 * 1024 * 1024;
/// 轮转保留尾部字节数（截头保尾，行对齐）
const LOG_KEEP_BYTES: u64 = 64 * 1024 * 1024;
/// 轮转重命名重试次数（Windows 重命名要求目标路径无占用句柄，读者可能短暂持有）
const ROTATE_RENAME_RETRIES: u32 = 5;
/// 尾部读取回退预算：file_info 拿 size → 从尾回退 64KB
const TAIL_READ_BUDGET: u64 = 64 * 1024;
/// 精确行号顺序读预算：超预算即截断返回并置 truncated
const RANGE_READ_BUDGET: u64 = 8 * 1024 * 1024;

/// 日志物理行前缀（审计面标记；read_log / status.tail 返回去前缀的用户内容）
pub(crate) const OUT_PREFIX: &str = "[out]";
/// 日志物理行前缀（stderr）
pub(crate) const ERR_PREFIX: &str = "[err]";

/// 交互提示候选模式（T-AB-10 3）：行尾字面后缀匹配——对行尾做轻量「正则」，
/// 字面后缀等价于锚定行尾的匹配且避免转义错误。仅作候选提示（T-AB-10 4）。
const PROMPT_PATTERNS: &[&str] = &[
    "[Y/n]",
    "[y/N]",
    "Press Enter to continue",
    "(yes/no)",
    "请输入",
];

// ============================================================================
// meta.json（T-AB-09 3：创建即写初值；终态写 exit_code/finished_at；轮转标记）
// ============================================================================

/// `.meta.json` 内容（camelCase；终态由收尾写 exit_code/finished_at；
/// 任务终止不删 `.log`，本文件 T-AB-12 归档时清理）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskMeta {
    pub(crate) task_id: String,
    pub(crate) command: String,
    /// kebab-case 状态字符串（running/completed/failed/killed）
    pub(crate) status: String,
    pub(crate) started_at_ms: u64,
    pub(crate) finished_at_ms: Option<u64>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) line_count: u64,
    pub(crate) last_output_at_ms: u64,
    pub(crate) prompt: Option<String>,
    /// 行数→偏移 checkpoint（line=行号，offset=该行行首字节偏移）
    pub(crate) checkpoints: Vec<CheckpointEntry>,
    /// 轮转标记（单文件超 100MB 保尾截头后置位）
    pub(crate) rotated: bool,
    pub(crate) rotated_at_ms: Option<u64>,
    /// 轮转累计丢弃行数（近似）
    pub(crate) dropped_lines: u64,
    /// 日志文件当前字节数（writer 维护的写入偏移）
    pub(crate) log_bytes: u64,
}

/// checkpoint 条目：第 `line` 行的行首字节偏移为 `offset`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckpointEntry {
    pub(crate) line: u64,
    pub(crate) offset: u64,
}

impl TaskMeta {
    /// 由内存快照组装（写入点：创建 / 每 512 行 / 提示命中 / 终态）
    pub(crate) fn from_info(
        info: &BackgroundTaskInfo,
        checkpoints: Vec<CheckpointEntry>,
        log_bytes: u64,
        rotated: bool,
        rotated_at_ms: Option<u64>,
        dropped_lines: u64,
    ) -> Self {
        Self {
            task_id: info.task_id.clone(),
            command: info.command.clone(),
            status: task_state_str(&info.status).to_string(),
            started_at_ms: info.started_at_ms,
            finished_at_ms: info.finished_at_ms,
            exit_code: info.exit_code,
            line_count: info.line_count,
            last_output_at_ms: info.last_output_at_ms,
            prompt: info.prompt.clone(),
            checkpoints,
            rotated,
            rotated_at_ms,
            dropped_lines,
            log_bytes,
        }
    }
}

/// 读 meta（容错：缺失或解析失败 → None + debug 留痕；索引只做快速定位）
pub(crate) fn read_meta(path: &Path) -> Option<TaskMeta> {
    let raw = std::fs::read(path).ok()?;
    match serde_json::from_slice::<TaskMeta>(&raw) {
        Ok(meta) => Some(meta),
        Err(e) => {
            tracing::debug!(
                target: "background",
                error = %e,
                path = %path.display(),
                "任务 meta 解析失败，按缺失处理（checkpoint 回退实际末尾）"
            );
            None
        }
    }
}

/// 写 meta（UTF-8 无 BOM；父目录自动创建）
pub(crate) fn write_meta(path: &Path, meta: &TaskMeta) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建 meta 目录失败：{e}"))?;
        }
    }
    let raw = serde_json::to_string_pretty(meta).map_err(|e| format!("序列化 meta 失败：{e}"))?;
    std::fs::write(path, raw).map_err(|e| format!("写 meta 失败：{e}"))
}

/// 便捷写入点：从内存快照组 meta 并落盘（失败仅 warn，不阻断转发循环）
pub(crate) fn write_meta_now(
    info: &Arc<RwLock<BackgroundTaskInfo>>,
    meta_path: &Path,
    checkpoints: &[CheckpointEntry],
    log_bytes: u64,
    rotated: bool,
    rotated_at_ms: Option<u64>,
    dropped_lines: u64,
) {
    let Ok(guard) = info.read() else {
        return;
    };
    let meta = TaskMeta::from_info(
        &guard,
        checkpoints.to_vec(),
        log_bytes,
        rotated,
        rotated_at_ms,
        dropped_lines,
    );
    drop(guard);
    if let Err(e) = write_meta(meta_path, &meta) {
        tracing::warn!(
            target: "background",
            error = %e,
            path = %meta_path.display(),
            "任务 meta 落盘失败"
        );
    }
}

/// 状态 → kebab-case 字符串（与 TaskState 序列化口径一致）
pub(crate) fn task_state_str(state: &TaskState) -> &'static str {
    match state {
        TaskState::Running => "running",
        TaskState::Completed => "completed",
        TaskState::Failed => "failed",
        TaskState::Killed => "killed",
    }
}

// ============================================================================
// 日志写者（T-AB-09 1：双流落盘；转发器独占，非异步上下文）
// ============================================================================

/// 日志文件写者：追加句柄 + 写入偏移 + 末行行首偏移 + 落盘失败降级标记。
///
/// 偏移口径：`offset` = 已成功写入的字节数（= 文件物理末尾）；checkpoint 需要
/// 行首偏移，故 `last_start` 记录上一行写入前的偏移。
#[derive(Debug, Default)]
pub(crate) struct LogWriter {
    pub(crate) file: Option<std::fs::File>,
    /// 下一写入字节偏移（文件物理末尾；轮转后重置为保尾字节数）
    pub(crate) offset: u64,
    /// 最近一行行首偏移（终态 checkpoint 用；None = 尚无任何行）
    pub(crate) last_start: Option<u64>,
    /// 落盘失败降级标记：warn 一次后不再尝试写盘，内存面继续（不阻断任务）
    pub(crate) broken: bool,
}

impl LogWriter {
    /// 追加一个日志物理行：`<prefix><line>\n`。失败（磁盘满等）→ 降级内存面。
    pub(crate) fn append_line(&mut self, path: &Path, prefix: &str, line: &str) {
        if self.file.is_none() {
            if self.broken {
                return;
            }
            self.file = open_log_append(path);
            if self.file.is_none() {
                self.broken = true;
                tracing::warn!(
                    target: "background",
                    path = %path.display(),
                    "任务日志落盘失败，降级为内存预览（不阻断任务执行）"
                );
                return;
            }
        }
        let file = self.file.as_mut().expect("append_line 前已确保 file 存在");
        self.last_start = Some(self.offset);
        let result = file
            .write_all(prefix.as_bytes())
            .and_then(|_| file.write_all(line.as_bytes()))
            .and_then(|_| file.write_all(b"\n"));
        match result {
            Ok(()) => self.offset += (prefix.len() + line.len() + 1) as u64,
            Err(e) => {
                tracing::warn!(
                    target: "background",
                    error = %e,
                    "任务日志写入失败，降级为内存预览（不阻断任务执行）"
                );
                self.file = None;
                self.broken = true;
            }
        }
    }

    /// 终态收尾：flush 到磁盘（best-effort，保证退出后文件可读）
    pub(crate) fn sync(&mut self) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.sync_all();
        }
    }

    /// 轮转前关闭追加句柄（Windows 重命名要求路径无占用句柄）
    fn close(&mut self) {
        self.file = None;
    }

    /// 轮转后重新打开追加句柄（失败 → 降级标记）
    fn reopen(&mut self, path: &Path) {
        self.file = open_log_append(path);
        self.broken = self.file.is_none();
    }
}

/// 以追加模式打开日志文件（自动建父目录；失败 → None）
fn open_log_append(path: &Path) -> Option<std::fs::File> {
    if let Some(parent) = path.parent() {
        if !parent.exists() && std::fs::create_dir_all(parent).is_err() {
            return None;
        }
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

/// 日志轮转护栏（T-AB-09 5）：单文件超 100MB 保尾截头（保留末 64MB，行对齐）。
///
/// 仅转发器在 checkpoint 时调用（无并发写者）。实现：关闭追加句柄 → 读取尾部
/// LOG_KEEP_BYTES 字节 → 丢弃首个不完整行（行对齐）→ 写临时文件 → 重命名替换
/// （Windows 重命名需目标无占用句柄：读者可能短暂持有，有限重试；重试失败则
/// 本轮回转放弃，下个 checkpoint 再试）。轮转后行号从 1 重新编号。
///
/// 返回值：成功 → 新文件行数（调用方负责同步 info.line_count 与清空 checkpoints）；
/// 失败 → None（warn，保持原文件继续追加）。
#[allow(clippy::disallowed_methods)] // 轮转清理 .log.rot 临时文件（任务日志内部
                                     // 索引整理，非用户文件，豁免裸删除）
pub(crate) fn maybe_rotate_log(
    log_path: &Path,
    log: &mut LogWriter,
    info: &Arc<RwLock<BackgroundTaskInfo>>,
) -> Option<u64> {
    if log.offset <= LOG_MAX_BYTES {
        return None;
    }
    log.close();
    let size = std::fs::metadata(log_path).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        // 文件异常为空：直接放弃本轮（offset 与物理大小不一致属极端异常）
        log.reopen(log_path);
        tracing::warn!(
            target: "background",
            path = %log_path.display(),
            "日志轮转跳过：文件大小为 0（偏移与物理大小不一致）"
        );
        return None;
    }
    let keep_from = size.saturating_sub(LOG_KEEP_BYTES);
    let mut data = Vec::with_capacity(LOG_KEEP_BYTES as usize);
    if let Err(e) = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::open(log_path)?;
        file.seek(SeekFrom::Start(keep_from))?;
        file.take(LOG_KEEP_BYTES).read_to_end(&mut data)?;
        Ok(())
    })() {
        log.reopen(log_path);
        tracing::warn!(
            target: "background",
            error = %e,
            "日志轮转读取尾部失败，本轮放弃（下个 checkpoint 重试）"
        );
        return None;
    }
    // 行对齐：keep_from 可能落在行中间 → 丢弃首个不完整行
    if keep_from > 0 {
        if let Some(idx) = data.iter().position(|&b| b == b'\n') {
            data.drain(..=idx);
        } else {
            data.clear();
        }
    }
    let new_lines = data.iter().filter(|&&b| b == b'\n').count() as u64;
    let temp = log_path.with_extension("log.rot");
    if let Err(e) = std::fs::write(&temp, &data) {
        log.reopen(log_path);
        tracing::warn!(
            target: "background",
            error = %e,
            "日志轮转临时文件写入失败，本轮放弃"
        );
        return None;
    }
    // Windows：重命名替换要求路径无占用句柄；读者打开窗口通常为毫秒级，有限重试
    let mut rename_result = std::fs::rename(&temp, log_path);
    for _ in 0..ROTATE_RENAME_RETRIES {
        match &rename_result {
            Ok(()) => break,
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
        rename_result = std::fs::rename(&temp, log_path);
    }
    if let Err(e) = rename_result {
        let _ = std::fs::remove_file(&temp);
        log.reopen(log_path);
        tracing::warn!(
            target: "background",
            error = %e,
            "日志轮转重命名失败（存在占用句柄），本轮放弃，下个 checkpoint 重试"
        );
        return None;
    }
    log.reopen(log_path);
    log.offset = data.len() as u64;
    log.last_start = None;
    if let Ok(mut guard) = info.write() {
        // 轮转后行号重新从 1 编号：内存计数与文件自洽
        guard.line_count = new_lines;
    }
    Some(new_lines)
}

// ============================================================================
// 编码与提示检测（T-AB-10 3/4）
// ============================================================================

/// 控制台字节解码（与 agent-tools shell.rs:1286-1291 同一口径：先按 UTF-8，
/// 失败 lossy，保证中文输出在 Windows 管道下不回退）
pub(crate) fn decode_console_bytes(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => String::from_utf8_lossy(raw).into_owned(),
    }
}

/// 去掉日志物理行前缀（`[out]`/`[err]`），还原用户可见内容
pub(crate) fn strip_log_prefix(line: &str) -> String {
    line.strip_prefix(OUT_PREFIX)
        .or_else(|| line.strip_prefix(ERR_PREFIX))
        .unwrap_or(line)
        .to_string()
}

/// 日志物理行（`<前缀><内容>\n`）→ 用户可见内容（去前缀、去换行）
fn file_line_to_user(raw: &[u8]) -> String {
    let mut s = decode_console_bytes(raw);
    if s.ends_with('\n') {
        s.pop();
    }
    strip_log_prefix(&s)
}

/// 行尾提示检测：仅匹配行尾（trim 尾随空白后后缀匹配），行中出现不算命中。
/// 检测结果仅作「候选提示」——由 AI 判断是否发送输入（T-AB-10 4 误报控制）。
pub(crate) fn detect_prompt(line: &str) -> bool {
    let trimmed = line.trim_end();
    PROMPT_PATTERNS.iter().any(|p| trimmed.ends_with(p))
}

// ── read_log 文件侧实现（T-AB-09 2）─────────────────────────────────────────

/// 尾部读取：从文件尾回退 64KB，拆完整行，取最后 max_lines 行。
///
/// 完整行边界：向前探 1 字节判定 chunk 首字节是否为行首（精确边界）；尾部半行
/// （append 进行中）直接丢弃。返回 `(行内容, 首行号, truncated)`。
pub(crate) fn read_log_tail(
    path: &Path,
    total_lines: u64,
    max_lines: u64,
) -> (Vec<String>, u64, bool) {
    let size = match file_info(path) {
        Ok(info) => info.size,
        Err(e) => {
            tracing::warn!(target: "background", error = %e, "read_log 文件信息读取失败");
            return (Vec::new(), 0, false);
        }
    };
    if size == 0 {
        return (Vec::new(), 0, false);
    }
    let budget = size.min(TAIL_READ_BUDGET);
    let start = size - budget;
    // 精确行边界：探测 chunk 前一字节是否为 \n（是 → chunk 首字节恰为行首）
    let starts_at_line_boundary = start == 0
        || read_chunk(path, start - 1, 1)
            .map(|c| c.data.first() == Some(&b'\n'))
            .unwrap_or(false);
    let chunk = match read_chunk(path, start, budget as usize) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(target: "background", error = %e, "read_log 尾部读取失败");
            return (Vec::new(), 0, false);
        }
    };
    // 按 \n 拆段：每段 = 一个物理行内容（前缀 + 内容，不含换行）；
    // 末尾段丢弃——\n 结尾时是 split 产生的空段（非行），否则是 append 中的
    // 半行（完整行边界语义）。空行（连续 \n）作为独立行保留。
    let mut segments: Vec<&[u8]> = chunk.data.split(|&b| b == b'\n').collect();
    segments.pop();
    // 首段可能为「行中起读」的半行（回退起点不在行首）→ 丢弃
    let mut lines: Vec<String> = segments
        .into_iter()
        .enumerate()
        .filter(|(idx, _)| starts_at_line_boundary || *idx > 0)
        .map(|(_, seg)| file_line_to_user(seg))
        .collect();
    // 取最后 max_lines 行
    let skip = lines.len().saturating_sub(max_lines as usize);
    if skip > 0 {
        lines.drain(..skip);
    }
    let first_line = if lines.is_empty() {
        0
    } else {
        total_lines.saturating_sub(lines.len() as u64) + 1
    };
    (lines, first_line, size > TAIL_READ_BUDGET)
}

/// 精确行号读取：checkpoint 二分定位行首偏移 → 顺序读 64KB 块，跳过起始行前
/// 的行，收集 max_lines 行。索引只做快速定位：读到索引末尾（chunk 为空且
/// 未满足请求）回退文件实际开头重读；EOF 尾部半行不计数。
/// 返回 `(行内容, 首行号, truncated)`；空结果首行号为 0。
pub(crate) fn read_log_range(
    path: &Path,
    meta_path: &Path,
    total_lines: u64,
    mut start_line: u64,
    max_lines: u64,
) -> (Vec<String>, u64, bool) {
    if start_line == 0 {
        start_line = 1; // 防御：行号从 1 起
    }
    if start_line > total_lines {
        return (Vec::new(), 0, false);
    }
    // 二分定位：最大的 checkpoint.line <= start_line（无则从文件头起读）
    let (mut offset, cur_line) = {
        let mut best_offset = 0;
        let mut best_line = 1;
        if let Some(meta) = read_meta(meta_path) {
            for ck in &meta.checkpoints {
                if ck.line <= start_line && ck.line >= best_line {
                    best_offset = ck.offset;
                    best_line = ck.line;
                }
            }
        }
        (best_offset, best_line)
    };
    let mut skipped = start_line - cur_line;
    let mut out: Vec<String> = Vec::new();
    let mut pending: Vec<u8> = Vec::with_capacity(65536);
    let mut read_total: u64 = 0;
    let mut truncated = false;
    let mut restarted = false;
    while out.len() < max_lines as usize {
        if read_total >= RANGE_READ_BUDGET {
            truncated = true;
            break;
        }
        let chunk_size = (RANGE_READ_BUDGET - read_total).min(65536) as usize;
        let chunk = match read_chunk(path, offset, chunk_size) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(target: "background", error = %e, "read_log 顺序读取失败");
                break;
            }
        };
        if chunk.data.is_empty() {
            if !restarted && skipped > 0 && out.is_empty() && offset > 0 {
                // 索引定位失效（轮转/崩溃滞后）：回退文件实际开头重读
                restarted = true;
                offset = 0;
                skipped = start_line - 1;
                pending.clear();
                continue;
            }
            break; // EOF：索引末尾即文件实际末尾
        }
        offset += chunk.data.len() as u64;
        read_total += chunk.data.len() as u64;
        pending.extend_from_slice(&chunk.data);
        // 拆出完整行（含 \n）：drain 掉已完整的行，残余（无 \n 的段）留在
        // pending 等待下一块拼接（跨块行按行解码，UTF-8 不跨行截断）
        let complete_len = {
            let mut end = 0;
            while end < pending.len() {
                match pending[end..].iter().position(|&b| b == b'\n') {
                    Some(pos) => end += pos + 1,
                    None => break,
                }
            }
            end
        };
        if complete_len > 0 {
            let drained: Vec<u8> = pending.drain(..complete_len).collect();
            let mut line_start = 0;
            for (i, &b) in drained.iter().enumerate() {
                if b == b'\n' {
                    let line_bytes = drained[line_start..=i].to_vec();
                    if skipped > 0 {
                        skipped -= 1;
                    } else {
                        out.push(file_line_to_user(&line_bytes));
                        if out.len() >= max_lines as usize {
                            break;
                        }
                    }
                    line_start = i + 1;
                }
            }
        }
        if out.len() >= max_lines as usize {
            break;
        }
    }
    let first_line = if out.is_empty() { 0 } else { start_line };
    (out, first_line, truncated)
}
