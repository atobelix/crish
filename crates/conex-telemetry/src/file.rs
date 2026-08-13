//! 日志文件层（PE-04 T04.1-1 建 / T04.6-1 扩展）。
//!
//! 轮转策略（**决策记录，PE-04 T04.6**）：
//! - **时间维度**：按日单文件 `{prefix}.{YYYYMMDD}.log`，日期变化即切换
//!   新文件、不覆盖历史（T04.1-1 现状，满足「按日轮转」）；
//! - **体积维度**（本任务新增）：单文件超过 [`MAX_SINGLE_FILE_BYTES`]
//!   （10MB）切分到 `{prefix}.{YYYYMMDD}.{n}.log`（按日+大小双条件）；
//!   单条日志超过 [`MAX_LOG_LINE_BYTES`]（8KB）在写入前截断；
//! - **总量维度**（本任务新增）：[`cleanup_logs`] 启动时执行一次——
//!   普通日志保留 [`LogRetention::max_age_days`]（7）天、目录总量不超过
//!   [`LogRetention::max_total_bytes`]（50MB），crash 文件保留最近
//!   [`LogRetention::crash_keep_count`]（3）个。
//!
//! **不引入新依赖**（PE-10 约束）：tracing-appender 的依赖声明由 PE-10
//! 统一落，此处用现有 std 实现全部轮转/清理能力，无需等待。
//!
//! 失败策略：文件打开失败 → 返回空目标（[`FileSink::Null`]）且不 panic
//! ——日志不可用不能阻断应用启动（PE-04 R3）。

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tracing_subscriber::fmt::writer::MakeWriter;

use crate::format::truncate_string;

/// 单条日志上限（T04.6-1：防单条爆量，超长行截断到 8KB）
pub(crate) const MAX_LOG_LINE_BYTES: usize = 8 * 1024;

/// 单个日志文件体积上限（T04.6-1：10MB；超出切分到 `{prefix}.{date}.{n}.log`）
pub(crate) const MAX_SINGLE_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// 文件层配置（[`crate::init_default`] 的 `file` 参数）。
#[derive(Debug, Clone)]
pub struct FileConfig {
    /// 日志目录（初始化时 `create_dir_all`，失败由调用方降级为仅 stderr）
    pub dir: PathBuf,
    /// 文件名前缀（如 `"workbench"` → `workbench.20260801.log`）
    pub file_name_prefix: String,
}

/// 按日 + 大小双条件轮转写入器（T04.1-1 按日 / T04.6-1 加大小上限）。
///
/// 每次写调用打开当日文件句柄（append 模式），日期变化时自然写入新
/// 文件（文件名带 UTC 日期键，天然不覆盖历史）；当日文件超过
/// [`MAX_SINGLE_FILE_BYTES`] 时切分到 `{prefix}.{YYYYMMDD}.{n}.log`。
/// 性能代价：每条记录多一次 open/close 系统调用——本阶段可接受；
/// tracing-appender 接入后改为独立线程 + 非阻塞写（待 PE-10 声明依赖）。
pub(crate) struct DailyFileWriter {
    dir: PathBuf,
    prefix: String,
    state: Mutex<DailyState>,
}

/// B1-6 毒丸恢复计数原语：文件层降级恢复事件累计次数（锁毒化恢复 +
/// 打开失败降级两类事件共用；只在毒化/降级分支 `fetch_add`，正常路径
/// 零开销；计数不受 `error_reported` 去重影响——每次事件都累计，去重
/// 仅防日志刷屏；供本 crate 毒化测断言 + S3 埋点消费）
static FILE_LAYER_RECOVERIES: AtomicU64 = AtomicU64::new(0);

/// 文件层降级恢复累计计数（B1-6：毒丸恢复观测化；当前消费者 = 本 crate
/// 毒化测，S3 埋点消费为后续切片，届时移除 allow）
#[allow(dead_code)]
pub(crate) fn file_layer_recovery_count() -> u64 {
    FILE_LAYER_RECOVERIES.load(Ordering::Relaxed)
}

/// 文件层滚动状态。
struct DailyState {
    /// 当前文件名对应的日期键（YYYYMMDD）；`None` = 尚未写入
    day_key: Option<String>,
    /// 当日分片号（0 = 未分片；超过大小上限后递增）
    part: u32,
    /// 是否已打印过打开失败（防每个事件刷屏）
    error_reported: bool,
}

impl DailyFileWriter {
    pub(crate) fn new(dir: PathBuf, prefix: String) -> Self {
        Self {
            dir,
            prefix,
            state: Mutex::new(DailyState {
                day_key: None,
                part: 0,
                error_reported: false,
            }),
        }
    }

    /// 当日文件路径：分片 0 = `{prefix}.{YYYYMMDD}.log`，
    /// 分片 n>0 = `{prefix}.{YYYYMMDD}.{n}.log`
    fn file_path(&self, today: &str, part: u32) -> PathBuf {
        if part == 0 {
            self.dir.join(format!("{}.{}.log", self.prefix, today))
        } else {
            self.dir.join(format!("{}.{}.{}.log", self.prefix, today, part))
        }
    }
}

/// 写入目标：真实文件，或空目标（打开失败时降级，保证 writer 恒可用）。
/// `pub(crate)`：出现在公共 trait（MakeWriter）关联类型中，不能为私有。
pub(crate) enum FileSink {
    File(std::fs::File),
    Null,
}

impl Write for FileSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            FileSink::File(f) => f.write(buf),
            FileSink::Null => Ok(buf.len()),
        }
    }

    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        match self {
            FileSink::File(f) => {
                if buf.len() > MAX_LOG_LINE_BYTES {
                    // 单条上限（T04.6-1）：超长行截断到 8KB，防止单条爆量。
                    // 截断实现放 write_all（tracing fmt 经 write_fmt → write_all
                    // 逐事件整行写入）；write 保持诚实计数，避免 write_all
                    // 把剩余字节续写回文件（short write 会触发循环续写）。
                    // 截断后补回换行（fmt 整行输出以 \n 结尾）。
                    let mut out = Vec::with_capacity(MAX_LOG_LINE_BYTES + 1);
                    match std::str::from_utf8(buf) {
                        Ok(s) => {
                            out.extend_from_slice(truncate_string(s, MAX_LOG_LINE_BYTES).as_bytes())
                        }
                        // 非 UTF-8 意外输入：按字节截断兜底
                        Err(_) => out.extend_from_slice(&buf[..MAX_LOG_LINE_BYTES]),
                    }
                    if !out.ends_with(b"\n") {
                        out.push(b'\n');
                    }
                    f.write_all(&out)
                } else {
                    f.write_all(buf)
                }
            }
            FileSink::Null => Ok(()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            FileSink::File(f) => f.flush(),
            FileSink::Null => Ok(()),
        }
    }
}

impl MakeWriter<'_> for DailyFileWriter {
    type Writer = FileSink;

    fn make_writer(&self) -> Self::Writer {
        let mut state = self.state.lock().unwrap_or_else(|e| {
            tracing::error!("日志文件层 state 锁中毒，按恢复模式继续：{e}");
            FILE_LAYER_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        let today = today_key();
        // 日期变化 → 重置分片号（新文件开始，实现按日轮转）
        if state.day_key.as_deref() != Some(today.as_str()) {
            state.day_key = Some(today.clone());
            state.part = 0;
        }
        // 大小轮转（T04.6-1）：从当前分片起找第一个未超上限的文件
        // （正常路径 0 次循环；上限边界必落在某分片末尾，见 MAX_SINGLE_FILE_BYTES）
        loop {
            let path = self.file_path(&today, state.part);
            match open_log_file(&path) {
                Ok(f) => {
                    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
                    if size >= MAX_SINGLE_FILE_BYTES {
                        // 当前分片已达体积上限 → 切分到下一个分片
                        state.part += 1;
                        continue;
                    }
                    state.error_reported = false;
                    return FileSink::File(f);
                }
                Err(e) => {
                    // 写失败不 panic：降级为空目标，仅首次打印原因
                    // （error_reported 去重防刷屏，REV-02 口径保留）；
                    // 计数不受去重影响（每次降级都累计）
                    if !state.error_reported {
                        tracing::error!("日志文件层不可用，降级为空目标：{e}");
                        state.error_reported = true;
                    }
                    FILE_LAYER_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                    return FileSink::Null;
                }
            }
        }
    }
}

/// 以追加模式打开日志文件（不存在则创建）
fn open_log_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new().create(true).append(true).open(path)
}

/// 当前 UTC 日期键（YYYYMMDD）。
///
/// 标准库无日期格式化；用「儒略日 → 公历」的 `civil_from_days` 算法
/// （Howard Hinnant）自算，避免引入 chrono 依赖。日界取 UTC。
pub(crate) fn today_key() -> String {
    let (year, month, day) = civil_from_days(today_days());
    format!("{:04}{:02}{:02}", year, month, day)
}

/// 今日距 1970-01-01 的天数（UTC）
fn today_days() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64 / 86_400)
        .unwrap_or(0)
}

/// 日志保留策略（T04.6-1 默认值；启动时由 main.rs 传入 [`cleanup_logs`]）
#[derive(Debug, Clone, Copy)]
pub struct LogRetention {
    /// 普通日志文件最长保留天数（默认 7；按文件名内嵌日期键判龄，
    /// 解析失败回退文件修改时间）
    pub max_age_days: u32,
    /// 日志目录总大小上限（默认 50MB；超出后按日期旧 → 新删除普通日志，
    /// crash 文件不受总量清理影响）
    pub max_total_bytes: u64,
    /// crash 文件保留个数（默认 3：保留最近 3 个，其余删除）
    pub crash_keep_count: usize,
}

impl Default for LogRetention {
    fn default() -> Self {
        Self {
            max_age_days: 7,
            max_total_bytes: 50 * 1024 * 1024,
            crash_keep_count: 3,
        }
    }
}

/// 清理日志目录（T04.6-1：启动时执行一次；纯函数，可单测）。
///
/// 策略（对应任务书「日志清理策略：保留最近 N 个日志文件，启动时清理旧的」）：
/// 1. `crash-*.log` 按文件名时间戳排序，保留最近
///    [`LogRetention::crash_keep_count`] 个，其余删除；
/// 2. 按日轮转文件（`{prefix}.{YYYYMMDD}.log` / `{prefix}.{YYYYMMDD}.{n}.log`）
///    超过 [`LogRetention::max_age_days`] 天的删除；
/// 3. 剩余文件总大小超过 [`LogRetention::max_total_bytes`] 时，按日期
///    旧 → 新删除普通日志，直到总量不超限。
///
/// 返回被删除的文件名（测试断言用）；目录不存在 / 读取失败返回空列表。
#[allow(clippy::disallowed_methods)]
// G2 禁令豁免（clippy.toml 文件头「豁免面」）：日志保留策略轮转——清理对象是
// 本进程自管的日志文件（crash 保留 N 份 / 按日龄清理 / 总量上限），按策略
// 物理删除是日志子系统自身语义，进回收站/快照反而留下无意义的旧日志。
pub fn cleanup_logs(dir: &Path, retention: &LogRetention) -> Vec<String> {
    let mut deleted = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return deleted;
    };
    let mut logs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "log"))
        .collect();

    // 1. crash 文件：文件名 `crash-YYYYMMDD-HHMMSS-<thread>.log`，
    //    字典序 = 时间序（固定宽度时间戳），保留最近 N 个
    let mut crashes: Vec<PathBuf> = logs
        .iter()
        .filter(|p| file_name(p).starts_with("crash-"))
        .cloned()
        .collect();
    crashes.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    for old in crashes.iter().skip(retention.crash_keep_count) {
        if fs::remove_file(old).is_ok() {
            deleted.push(file_name(old));
        }
    }
    logs.retain(|p| !file_name(p).starts_with("crash-"));

    // 2. 年龄清理：普通日志按日期键判龄（解析失败回退修改时间）
    let today = today_days();
    logs.retain(|p| {
        let age_days = file_age_days(p, today);
        if age_days > i64::from(retention.max_age_days) {
            if fs::remove_file(p).is_ok() {
                deleted.push(file_name(p));
            }
            false
        } else {
            true
        }
    });

    // 3. 总量清理：旧 → 新删除直到总大小 ≤ 上限
    let total: u64 = logs
        .iter()
        .filter_map(|p| fs::metadata(p).ok().map(|m| m.len()))
        .sum();
    if total > retention.max_total_bytes {
        let mut ordered = logs;
        ordered.sort_by_key(|p| (file_date_key(p), file_name(p)));
        let mut remaining = total;
        for p in &ordered {
            if remaining <= retention.max_total_bytes {
                break;
            }
            if let Ok(m) = fs::metadata(p) {
                remaining = remaining.saturating_sub(m.len());
            }
            if fs::remove_file(p).is_ok() {
                deleted.push(file_name(p));
            }
        }
    }
    deleted
}

/// 取文件名（默认空串，防御异常路径）
fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 从按日轮转文件名提取日期键：`{prefix}.{YYYYMMDD}.log` /
/// `{prefix}.{YYYYMMDD}.{n}.log` → `YYYYMMDD`；无法解析返回 `None`
fn file_date_key(p: &Path) -> Option<String> {
    let name = file_name(p);
    let key = name.split_once('.').map(|(_, rest)| rest)?;
    let key = key.get(..8)?;
    if key.len() == 8 && key.bytes().all(|b| b.is_ascii_digit()) {
        Some(key.to_string())
    } else {
        None
    }
}

/// 文件年龄（天）。优先按文件名日期键；解析失败回退修改时间与今天的差
fn file_age_days(p: &Path, today: i64) -> i64 {
    if let Some(key) = file_date_key(p) {
        if let Some(days) = parse_day_key(&key) {
            return today - days;
        }
    }
    let mtime_days = fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64 / 86_400)
        .unwrap_or(0);
    today - mtime_days
}

/// 解析 `YYYYMMDD` → 距 1970-01-01 天数（校验合法性；非法返回 None）
fn parse_day_key(key: &str) -> Option<i64> {
    if key.len() != 8 || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let year: i64 = key[0..4].parse().ok()?;
    let month: u32 = key[4..6].parse().ok()?;
    let day: u32 = key[6..8].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

/// 公历 (年, 月, 日) → 距 1970-01-01 天数（Howard Hinnant 的
/// `days_from_civil`，[`civil_from_days`] 的逆运算）
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (i64::from(m) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 时间戳键（YYYYMMDD-HHMMSS，UTC），用于崩溃文件命名（T04.1-3）。
pub(crate) fn timestamp_key() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = tod / 3600;
    let minute = (tod % 3600) / 60;
    let second = tod % 60;
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        year, month, day, hour, minute, second
    )
}

/// 天数（自 1970-01-01）→ 公历 (年, 月, 日)，UTC。
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    // Howard Hinnant 的 civil_from_days 算法（C++11 起 std::chrono 同款）
    let z = days_since_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use std::sync::Arc;

    /// 独立临时目录（测试并发安全：进程 id + 纳秒时间戳唯一）
    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "crish-telemetry-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// N 天前的日期键（YYYYMMDD）
    fn days_ago_key(n: u32) -> String {
        let (y, m, d) = civil_from_days(today_days() - i64::from(n));
        format!("{y:04}{m:02}{d:02}")
    }

    fn write_file(dir: &Path, name: &str, bytes: u64) {
        let path = dir.join(name);
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&vec![b'x'; bytes as usize])
            .unwrap();
    }

    #[test]
    fn civil_from_days_epoch_is_1970_01_01() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }

    #[test]
    fn civil_from_days_known_date() {
        // 2026-08-01 = 20666 天（1970-01-01 起算）
        assert_eq!(civil_from_days(20666), (2026, 8, 1));
    }

    #[test]
    fn civil_from_days_leap_year() {
        // 2024-02-29（闰年）= 19782 天
        assert_eq!(civil_from_days(19782), (2024, 2, 29));
    }

    #[test]
    fn civil_from_days_negative() {
        // 1969-12-31 = -1 天
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    #[test]
    fn days_from_civil_is_inverse_of_civil_from_days() {
        // 与 civil_from_days 互逆（含闰年与负值边界）
        for days in [-1, 0, 20666, 19782, 100_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days, "days={days}");
        }
    }

    #[test]
    fn timestamps_are_fixed_width() {
        let ts = timestamp_key();
        assert_eq!(ts.len(), 15, "YYYYMMDD-HHMMSS 共 15 字符，实际 {}", ts);
        assert!(ts.contains('-'));
    }

    // ── T04.6-1 轮转行为 ──

    /// 单条上限：超过 8KB 的日志行在写入前截断（带省略号，保留换行）
    #[test]
    fn file_sink_truncates_oversized_line() {
        let dir = temp_dir("trunc");
        let path = dir.join("t.log");
        let sink = FileSink::File(
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .unwrap(),
        );
        let mut sink = sink;
        let big = vec![b'a'; MAX_LOG_LINE_BYTES * 2];
        sink.write_all(&big).unwrap();
        sink.flush().unwrap();
        let content = fs::read(&path).unwrap();
        assert!(
            content.len() <= MAX_LOG_LINE_BYTES + 1,
            "截断后不超过上限：{}",
            content.len()
        );
        assert!(
            content.ends_with(b"...\n"),
            "超长行应带省略号并保留换行"
        );
    }

    /// 短行不截断（行为不回归）
    #[test]
    fn file_sink_keeps_short_line() {
        let dir = temp_dir("short");
        let path = dir.join("t.log");
        let sink = FileSink::File(
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .unwrap(),
        );
        let mut sink = sink;
        let line = b"hello world\n";
        sink.write_all(line).unwrap();
        sink.flush().unwrap();
        assert_eq!(fs::read(&path).unwrap(), line);
    }

    /// 大小轮转：当日分片超过 10MB 后，下一次写切分到分片 1
    #[test]
    fn daily_writer_splits_file_at_size_cap() {
        let dir = temp_dir("size");
        let writer = DailyFileWriter::new(dir.clone(), "workbench".to_string());
        // 预写当日文件到超过单文件上限
        let today = today_key();
        let p0 = dir.join(format!("workbench.{today}.log"));
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p0)
            .unwrap();
        let chunk = vec![b'x'; 64 * 1024];
        let mut written = 0u64;
        while written <= MAX_SINGLE_FILE_BYTES {
            f.write_all(&chunk).unwrap();
            written += chunk.len() as u64;
        }
        drop(f);

        let sink = writer.make_writer();
        assert!(
            matches!(sink, FileSink::File(_)),
            "日志目录可写时不应降级为空目标"
        );
        assert!(
            dir.join(format!("workbench.{today}.1.log")).exists(),
            "超限后应切分到分片 1"
        );
        assert_eq!(writer.state.lock().unwrap().part, 1, "分片号应为 1");
        let _ = fs::remove_dir_all(&dir);
    }

    // ── T04.6-1 清理策略 ──

    /// 年龄清理：超过 7 天的按日文件删除，7 天内保留
    #[test]
    fn cleanup_removes_old_daily_files_keeps_recent() {
        let dir = temp_dir("age");
        let today = today_key();
        let five_ago = days_ago_key(5);
        let ten_ago = days_ago_key(10);
        write_file(&dir, &format!("workbench.{today}.log"), 100);
        write_file(&dir, &format!("workbench.{five_ago}.log"), 100);
        write_file(&dir, &format!("workbench.{ten_ago}.log"), 100);

        let deleted = cleanup_logs(&dir, &LogRetention::default());
        assert!(deleted.contains(&format!("workbench.{ten_ago}.log")));
        assert!(!deleted.contains(&format!("workbench.{today}.log")));
        assert!(!deleted.contains(&format!("workbench.{five_ago}.log")));
        assert!(dir.join(format!("workbench.{today}.log")).exists());
        assert!(dir.join(format!("workbench.{five_ago}.log")).exists());
        assert!(!dir.join(format!("workbench.{ten_ago}.log")).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// crash 文件：保留最近 3 个（文件名时间戳新旧），其余删除
    #[test]
    fn cleanup_keeps_recent_crash_files() {
        let dir = temp_dir("crash");
        let names = [
            "crash-20260701-000000-main.log",
            "crash-20260720-000000-main.log",
            "crash-20260725-000000-main.log",
            "crash-20260801-120000-main.log",
        ];
        for name in &names {
            write_file(&dir, name, 10);
        }
        let deleted = cleanup_logs(&dir, &LogRetention::default());
        assert!(deleted.contains(&names[0].to_string()), "最旧 crash 应删除");
        assert!(deleted.len() == 1, "只删最旧 1 个：{:?}", deleted);
        for name in &names[1..] {
            assert!(dir.join(name).exists(), "{name} 应保留");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// 总量上限：超过上限后按日期旧 → 新删除普通日志，直到总量不超限
    #[test]
    fn cleanup_enforces_total_size_cap() {
        let dir = temp_dir("total");
        let today = today_key();
        let one_ago = days_ago_key(1);
        let two_ago = days_ago_key(2);
        // 每文件 200 字节，总 600；上限 300 → 需删到 ≤300（删最旧 1 个后 400
        // 仍超 → 再删 → 200 达标）
        write_file(&dir, &format!("workbench.{two_ago}.log"), 200);
        write_file(&dir, &format!("workbench.{one_ago}.log"), 200);
        write_file(&dir, &format!("workbench.{today}.log"), 200);

        let retention = LogRetention {
            max_total_bytes: 300,
            ..LogRetention::default()
        };
        let deleted = cleanup_logs(&dir, &retention);
        assert!(deleted.contains(&format!("workbench.{two_ago}.log")));
        assert!(deleted.contains(&format!("workbench.{one_ago}.log")));
        assert!(!dir.join(format!("workbench.{two_ago}.log")).exists());
        assert!(!dir.join(format!("workbench.{one_ago}.log")).exists());
        assert!(dir.join(format!("workbench.{today}.log")).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 目录不存在：返回空列表不 panic
    #[test]
    fn cleanup_missing_dir_is_noop() {
        let dir = std::env::temp_dir().join(format!(
            "crish-telemetry-missing-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let deleted = cleanup_logs(&dir, &LogRetention::default());
        assert!(deleted.is_empty());
    }

    // ── B1-6 毒丸恢复观测化 ──

    /// 串行化 B1-6 毒化/降级测（两测共享 `FILE_LAYER_RECOVERIES` 模块计数，
    /// 并行线程会相互干扰 diff 断言——计数语义不变，仅测试面串行）
    static RECOVERY_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// 毒化 std `Mutex`（持锁线程内 panic → PoisonError 注入；与
    /// agent-tools test_support::poison_std_lock 同形，测试注入用）
    fn poison_std_lock<T: Send>(lock: &Mutex<T>) {
        let _ = std::panic::catch_unwind(|| {
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    let _guard = lock.lock().unwrap();
                    panic!("模拟持锁 panic（毒化锁）");
                });
            });
        });
    }

    /// 捕获日志的内存缓冲（fmt writer 共享同一缓冲；对齐
    /// session-loop/tests/observability.rs 的 LogCapture 模式）
    #[derive(Default)]
    struct LogCapture {
        lines: Mutex<Vec<String>>,
    }

    impl LogCapture {
        fn push(&self, line: &str) {
            self.lines.lock().unwrap().push(line.to_string());
        }
        fn snapshot(&self) -> Vec<String> {
            self.lines.lock().unwrap().clone()
        }
    }

    /// fmt writer：Arc 包装共享缓冲
    struct ArcWriter(Arc<LogCapture>);

    impl std::io::Write for ArcWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            // fmt 会以行调用；按行切分逐行记录
            let text = String::from_utf8_lossy(buf);
            for line in text.lines() {
                self.0.push(line);
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// 在捕获 subscriber 下执行闭包，返回 (结果, 捕获行)
    fn with_capture<F, R>(f: F) -> (R, Vec<String>)
    where
        F: FnOnce() -> R,
    {
        let capture = Arc::new(LogCapture::default());
        let writer = capture.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(move || ArcWriter(writer.clone()))
            .with_max_level(tracing::Level::INFO)
            .with_ansi(false)
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        let result = f();
        let lines = capture.snapshot();
        (result, lines)
    }

    /// 毒化测（B1-6 验收 1，三要素：正常返回 + 日志 + 计数）：state 锁
    /// 毒化后 make_writer 仍正常返回可写 sink（恢复式继续，不 panic），
    /// 并发出 tracing::error 日志、降级恢复计数 +1
    #[test]
    fn poisoned_state_lock_recovers_with_log_and_count() {
        let _serial = RECOVERY_TEST_LOCK.lock().unwrap();
        let dir = temp_dir("poison");
        let writer = DailyFileWriter::new(dir.clone(), "workbench".to_string());
        poison_std_lock(&writer.state);
        let before = file_layer_recovery_count();

        let (sink, lines) = with_capture(|| writer.make_writer());

        assert!(
            matches!(sink, FileSink::File(_)),
            "毒化后仍正常返回可写文件 sink"
        );
        let joined = lines.join("\n");
        assert!(
            joined.contains("锁中毒"),
            "应捕获锁中毒 error 日志：\n{joined}"
        );
        assert_eq!(
            file_layer_recovery_count(),
            before + 1,
            "毒化恢复计数应 +1"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 去重不回归（B1-6 验收 2）：打开失败连发多条仅 1 条日志
    /// （error_reported 去重保留），但计数累计多条（计数不受去重影响）
    #[test]
    fn open_failure_logs_once_but_count_accumulates() {
        let _serial = RECOVERY_TEST_LOCK.lock().unwrap();
        // 目录路径被普通文件占据 → 打开日志文件恒失败 → 降级 FileSink::Null
        let dir = temp_dir("dedup");
        let blocker = dir.join("blocker");
        fs::write(&blocker, b"not a dir").unwrap();

        let writer = DailyFileWriter::new(blocker.clone(), "workbench".to_string());
        let before = file_layer_recovery_count();

        let (sinks, lines) = with_capture(|| (0..3).map(|_| writer.make_writer()).collect::<Vec<_>>());

        assert!(
            sinks.iter().all(|s| matches!(s, FileSink::Null)),
            "打开失败应全部降级为空目标"
        );
        let joined = lines.join("\n");
        let occurrences = joined.matches("日志文件层不可用").count();
        assert_eq!(
            occurrences, 1,
            "error_reported 去重：连发多条仅 1 条日志，实际：\n{joined}"
        );
        assert_eq!(
            file_layer_recovery_count(),
            before + 3,
            "计数不受去重影响：3 次降级应累计 3"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
