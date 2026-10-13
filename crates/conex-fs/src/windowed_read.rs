//! 窗口感知文件读（U-READ · D2 唯一 SSOT）
//!
//! 壳 `read_file_content` 与 agent-tools `read_file` **必须**消费本模块，
//! 禁止再在调用方各写一份「整文件 `std::fs::read` → `lines().collect()`」。
//!
//! 设计边界：
//! - UTF-8：分块流式读，仅物化窗口行；全文 `total_lines` / `total_chars`
//!   在扫描过程中迭代计数（不物化全文 `Vec<&str>` / 全文 `String`）；
//! - UTF-16（BOM）：按需整读解码后再切窗（编码路径；UTF-16 无 BOM 不支持）；
//! - 二进制：前缀探测（NUL / 可选 shell 启发式），禁止整文件读入后才判；
//! - 超大文件窗口读：I/O 仍可能扫全文以计行（诚实边界），但**峰值内存**
//!   仅窗口 + 固定缓冲，不驻留全文。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 读分块大小（与壳 G3 默认 8KB 对齐）
const READ_CHUNK_BYTES: usize = 8 * 1024;

/// 默认二进制探测前缀（壳 G3：`BINARY_SCAN_BYTES=8KB` 量级）
pub const DEFAULT_BINARY_PROBE_BYTES: usize = 8192;

/// 窗口读选项
#[derive(Debug, Clone)]
pub struct WindowReadOptions {
    /// 1-indexed 起始行（缺省 1）
    pub start_line: usize,
    /// 1-indexed 结束行（闭区间；`None` = 窗口起点 + `max_lines`）
    pub end_line: Option<usize>,
    /// 0-indexed 续读偏移（与 `start_line-1` 取 max）
    pub content_offset: usize,
    /// 窗口最大行数
    pub max_lines: usize,
    /// 文件大小硬限（`Some` 且 `metadata.len()` 超限时拒绝；壳预览用）
    pub max_file_bytes: Option<u64>,
    /// 二进制探测前缀字节数
    pub binary_probe_bytes: usize,
    /// 二进制时返回错误（壳）而非 `is_binary` 结果（工具）
    pub reject_binary: bool,
    /// 非法 UTF-8 / 未识别编码时返回错误（壳严格）而非 lossy（工具）
    pub strict_encoding: bool,
    /// 允许 UTF-16 BOM 解码（工具）；壳保持严格 UTF-8 口径
    pub allow_utf16: bool,
}

impl Default for WindowReadOptions {
    fn default() -> Self {
        Self {
            start_line: 1,
            end_line: None,
            content_offset: 0,
            max_lines: 800,
            max_file_bytes: None,
            binary_probe_bytes: DEFAULT_BINARY_PROBE_BYTES,
            reject_binary: false,
            strict_encoding: false,
            allow_utf16: true,
        }
    }
}

/// 解码编码标签（对齐既有 wire：`utf-8` / `utf-16le` / `utf-16be` / `binary`）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    Binary,
}

impl WindowEncoding {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Utf8 => "utf-8",
            Self::Utf16Le => "utf-16le",
            Self::Utf16Be => "utf-16be",
            Self::Binary => "binary",
        }
    }
}

/// 窗口读结果
#[derive(Debug)]
pub struct WindowReadResult {
    /// 窗口文本（行以 `\n` 连接，末行不带尾换行）
    pub text: String,
    /// 全文精确行数（`str::lines()` 语义）
    pub total_lines: usize,
    /// 全文精确字符数（含换行符）
    pub total_chars: usize,
    /// 窗口后仍有内容（content_truncated 语义）
    pub content_truncated: bool,
    /// 下一续读偏移（0-indexed 行数 = 已返回完整行数起点）
    pub next_content_offset: usize,
    /// 窗口实际行数
    pub shown_lines: usize,
    /// 1-indexed 窗口起始行
    pub window_start_line: usize,
    /// 1-indexed 窗口结束行（闭区间；空窗时 = start-1）
    pub window_end_line: usize,
    pub encoding: WindowEncoding,
    pub is_binary: bool,
    pub has_bom: bool,
    /// 解码是否发生 U+FFFD 替换（工具 lossy 路径）
    pub lossy_replaced: bool,
    /// 文件字节数
    pub file_bytes: u64,
    /// 窗口末行在源文件中是否带尾换行（壳截断语义用）
    pub ends_with_newline_in_window: bool,
    /// 源文件是否以换行结尾（壳：未截断时保留尾换行）
    pub file_ends_with_newline: bool,
}

/// 窗口读错误
#[derive(Debug)]
pub enum WindowReadError {
    Io(std::io::Error),
    /// `metadata.is_dir()` 等非文件形态
    NotAFile,
    FileTooLarge {
        size: u64,
        limit: u64,
    },
    Binary,
    UnsupportedEncoding,
}

impl std::fmt::Display for WindowReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "{e}"),
            Self::NotAFile => write!(f, "Path is not a file"),
            Self::FileTooLarge { size, limit } => {
                write!(
                    f,
                    "File is too large to preview safely ({size} bytes, limit {limit} bytes)."
                )
            }
            Self::Binary => write!(
                f,
                "File appears to be binary and cannot be previewed as text."
            ),
            Self::UnsupportedEncoding => {
                write!(
                    f,
                    "File is not valid UTF-8 text and cannot be previewed safely."
                )
            }
        }
    }
}

impl std::error::Error for WindowReadError {}

/// 窗口感知读（唯一 SSOT）。调用方只做参数解析 / 路径 guard / 响应组装。
pub fn windowed_read(
    path: &Path,
    opts: &WindowReadOptions,
) -> Result<WindowReadResult, WindowReadError> {
    let metadata = std::fs::metadata(path).map_err(WindowReadError::Io)?;
    if !metadata.is_file() {
        return Err(WindowReadError::NotAFile);
    }
    let file_bytes = metadata.len();
    if let Some(limit) = opts.max_file_bytes {
        if file_bytes > limit {
            return Err(WindowReadError::FileTooLarge {
                size: file_bytes,
                limit,
            });
        }
    }

    let mut file = File::open(path).map_err(WindowReadError::Io)?;
    let probe_len = opts.binary_probe_bytes.max(4);
    let mut probe = vec![0_u8; probe_len as usize];
    let probe_read = file.read(&mut probe).map_err(WindowReadError::Io)?;
    probe.truncate(probe_read);

    // UTF-16 BOM → 整读解码后切窗（编码路径；工具 allow_utf16）
    if opts.allow_utf16 && probe.starts_with(&[0xFF, 0xFE]) {
        return read_utf16_window(path, file_bytes, true, opts);
    }
    if opts.allow_utf16 && probe.starts_with(&[0xFE, 0xFF]) {
        return read_utf16_window(path, file_bytes, false, opts);
    }

    // 二进制探测（NUL + 壳启发式）
    if is_probably_binary(&probe, opts.reject_binary) {
        if opts.reject_binary {
            return Err(WindowReadError::Binary);
        }
        return Ok(empty_binary_result(file_bytes));
    }

    // 严格编码：前缀非法 UTF-8 序列 → 拒绝（KFS-05：对齐至完整 UTF-8 字符边界后再做探测校验）
    let probe_utf8_slice = if (probe.len() as u64) < file_bytes {
        truncate_utf8_bytes_at_char_boundary(&probe, probe.len())
    } else {
        &probe[..]
    };
    if opts.strict_encoding && utf8_has_invalid_sequence(probe_utf8_slice) {
        return Err(WindowReadError::UnsupportedEncoding);
    }
    if !opts.allow_utf16 && probe.starts_with(&[0xFF, 0xFE]) {
        // 壳：UTF-16 走非 UTF-8 拒绝（与 latin1 同码）
        return Err(WindowReadError::UnsupportedEncoding);
    }

    // 回退到文件开头；UTF-8 BOM 剥离后进入流式窗口读
    file.seek(SeekFrom::Start(0)).map_err(WindowReadError::Io)?;
    let mut bom = [0_u8; 3];
    let bom_read = file.read(&mut bom).map_err(WindowReadError::Io)?;
    let has_bom = bom_read >= 3 && bom == [0xEF, 0xBB, 0xBF];
    if !has_bom {
        file.seek(SeekFrom::Start(0)).map_err(WindowReadError::Io)?;
    }
    read_utf8_windowed(file, file_bytes, opts, has_bom)
}

/// KFS-05：寻找字节切片在 `max_bytes` 以内的最大安全 UTF-8 字符边界偏移。
///
/// 若 `max_bytes` 恰好落在多字节 UTF-8 字符（2~4 字节）的中间，向前回退至该字符起始字节，
/// 保证截断后的切片绝不产生半个多字节字符、乱码（`U+FFFD`）或切片 panic。
#[inline]
pub fn floor_utf8_char_boundary(bytes: &[u8], max_bytes: usize) -> usize {
    let limit = max_bytes.min(bytes.len());
    if limit == 0 {
        return 0;
    }
    if limit == bytes.len() {
        return match std::str::from_utf8(bytes) {
            Ok(_) => bytes.len(),
            Err(err) if err.error_len().is_none() => err.valid_up_to(),
            Err(_) => bytes.len(),
        };
    }

    // 若下一个字节不是 UTF-8 续字节（10xxxxxx），则 limit 已经是字符边界
    if (bytes[limit] & 0b1100_0000) != 0b1000_0000 {
        return limit;
    }

    // 向前回退最多 3 个续字节，定位多字节字符的首字节
    let mut cursor = limit;
    let min_pos = limit.saturating_sub(3);
    while cursor > min_pos && (bytes[cursor - 1] & 0b1100_0000) == 0b1000_0000 {
        cursor -= 1;
    }
    if cursor > 0 && (bytes[cursor - 1] & 0b1100_0000) != 0b1000_0000 {
        cursor - 1
    } else {
        limit
    }
}

/// KFS-05：在多字节 UTF-8 字符边界上安全截断字节切片。
#[inline]
pub fn truncate_utf8_bytes_at_char_boundary(bytes: &[u8], max_bytes: usize) -> &[u8] {
    let boundary = floor_utf8_char_boundary(bytes, max_bytes);
    &bytes[..boundary]
}

/// KFS-05：在多字节 UTF-8 字符边界上安全截断字符串切片，杜绝非字符边界切片 panic。
#[inline]
pub fn truncate_utf8_at_char_boundary(s: &str, max_bytes: usize) -> &str {
    if max_bytes >= s.len() {
        return s;
    }
    let mut idx = max_bytes;
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    &s[..idx]
}

/// KFS-05：跨分块边界的流式 UTF-8 拼接器。
///
/// 通过 4 字节栈上尾缓冲 `utf8_tail` 缝合跨越 `READ_CHUNK_BYTES` 边界的多字节 UTF-8 序列，
/// 直接解码进 `current_line`，消除整行 `Vec<u8>` 二次拷贝并保证多字节字符零截断乱码。
fn append_utf8_chunk_with_tail(
    mut slice: &[u8],
    is_line_end: bool,
    utf8_tail: &mut [u8; 4],
    utf8_tail_len: &mut usize,
    current_line: &mut String,
    lossy_replaced: &mut bool,
) {
    // 1. 先缝合上一分块遗留的未完成多字节前缀（1..=3 字节）
    while *utf8_tail_len > 0 && !slice.is_empty() {
        let take = slice.len().min(4);
        let mut combined = [0_u8; 7];
        combined[..*utf8_tail_len].copy_from_slice(&utf8_tail[..*utf8_tail_len]);
        combined[*utf8_tail_len..*utf8_tail_len + take].copy_from_slice(&slice[..take]);
        let comb_len = *utf8_tail_len + take;

        match std::str::from_utf8(&combined[..comb_len]) {
            Ok(valid) => {
                current_line.push_str(valid);
                *utf8_tail_len = 0;
                slice = &slice[take..];
            }
            Err(err) if err.valid_up_to() > 0 => {
                let valid_len = err.valid_up_to();
                if let Ok(valid) = std::str::from_utf8(&combined[..valid_len]) {
                    current_line.push_str(valid);
                }
                let consumed = valid_len - *utf8_tail_len;
                *utf8_tail_len = 0;
                slice = &slice[consumed..];
            }
            Err(err) => match err.error_len() {
                Some(err_len) => {
                    current_line.push('\u{FFFD}');
                    *lossy_replaced = true;
                    if err_len < *utf8_tail_len {
                        utf8_tail.copy_within(err_len..*utf8_tail_len, 0);
                        *utf8_tail_len -= err_len;
                    } else {
                        let consumed = err_len - *utf8_tail_len;
                        *utf8_tail_len = 0;
                        slice = &slice[consumed..];
                    }
                }
                None => {
                    // combined 仍不足一个完整多字节字符（slice 极短）
                    utf8_tail[*utf8_tail_len..comb_len].copy_from_slice(&slice[..take]);
                    *utf8_tail_len = comb_len;
                    slice = &[];
                    break;
                }
            },
        }
    }

    // 2. 解码当前分块主体
    while !slice.is_empty() {
        match std::str::from_utf8(slice) {
            Ok(valid) => {
                current_line.push_str(valid);
                break;
            }
            Err(err) => {
                let valid_len = err.valid_up_to();
                if valid_len > 0 {
                    if let Ok(valid) = std::str::from_utf8(&slice[..valid_len]) {
                        current_line.push_str(valid);
                    }
                    slice = &slice[valid_len..];
                }
                match err.error_len() {
                    Some(err_len) => {
                        current_line.push('\u{FFFD}');
                        *lossy_replaced = true;
                        slice = &slice[err_len..];
                    }
                    None => {
                        // 分块尾部存在被截断的合法多字节前缀（1..=3 字节）
                        if is_line_end {
                            current_line.push('\u{FFFD}');
                            *lossy_replaced = true;
                        } else {
                            let rem_len = slice.len();
                            utf8_tail[..rem_len].copy_from_slice(slice);
                            *utf8_tail_len = rem_len;
                        }
                        break;
                    }
                }
            }
        }
    }

    // 3. 若已到达行尾/文件尾但仍有残余半字符前缀，按 lossy 语义置换为 U+FFFD
    if is_line_end && *utf8_tail_len > 0 {
        current_line.push('\u{FFFD}');
        *lossy_replaced = true;
        *utf8_tail_len = 0;
    }
}

/// UTF-8 流式窗口读：仅物化窗口行并统计窗口字符；视口外行跳过冗余缓冲克隆与字符计数（KFS-05, KFS-10）。
fn read_utf8_windowed(
    mut file: File,
    file_bytes: u64,
    opts: &WindowReadOptions,
    has_bom: bool,
) -> Result<WindowReadResult, WindowReadError> {
    let window_start0 = (opts.start_line.saturating_sub(1)).max(opts.content_offset);
    let window_end0_exclusive = opts
        .end_line
        .map(|e| e.saturating_sub(1) + 1) // 1-indexed inclusive → exclusive 0-indexed
        .unwrap_or(window_start0.saturating_add(opts.max_lines))
        .max(window_start0);

    let estimated_window_cap = window_end0_exclusive
        .saturating_sub(window_start0)
        .min(opts.max_lines)
        .min(1024);
    let mut window_lines: Vec<String> = Vec::with_capacity(estimated_window_cap);
    let mut total_lines = 0_usize;
    let mut total_chars = 0_usize;
    let mut line_idx = 0_usize;
    let mut current_line = String::new();
    let mut utf8_tail = [0_u8; 4];
    let mut utf8_tail_len = 0_usize;
    let mut in_window_line_started = false;
    let mut outside_line_non_empty = false;
    let mut ends_with_newline_in_window = false;
    let mut lossy_replaced = false;
    let mut buffer = vec![0_u8; READ_CHUNK_BYTES];
    let mut file_ends_with_newline = false;

    loop {
        let read = file.read(&mut buffer).map_err(WindowReadError::Io)?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        let mut start = 0_usize;
        while start < chunk.len() {
            // KFS-10：一旦越过窗口末尾，剩余字节流直接按块统计换行符，跳过逐行切片
            if line_idx >= window_end0_exclusive {
                let rest = &chunk[start..];
                let newlines = rest.iter().filter(|&&b| b == b'\n').count();
                total_lines += newlines;
                line_idx += newlines;
                if rest.last() == Some(&b'\n') {
                    outside_line_non_empty = false;
                    file_ends_with_newline = true;
                } else {
                    outside_line_non_empty = true;
                    file_ends_with_newline = false;
                }
                break;
            }

            let in_window = line_idx >= window_start0 && line_idx < window_end0_exclusive;
            match chunk[start..].iter().position(|&b| b == b'\n') {
                Some(rel) => {
                    let end = start + rel;
                    if in_window {
                        let mut line_slice = &chunk[start..end];
                        if !in_window_line_started && utf8_tail_len == 0 {
                            if line_slice.last() == Some(&b'\r') {
                                line_slice = &line_slice[..line_slice.len() - 1];
                            }
                            let (line, lossy) = decode_line_utf8(line_slice);
                            if lossy {
                                lossy_replaced = true;
                            }
                            total_chars += line.chars().count() + 1; // +1 for \n
                            window_lines.push(line);
                        } else {
                            append_utf8_chunk_with_tail(
                                line_slice,
                                true,
                                &mut utf8_tail,
                                &mut utf8_tail_len,
                                &mut current_line,
                                &mut lossy_replaced,
                            );
                            if current_line.ends_with('\r') {
                                current_line.pop();
                            }
                            total_chars += current_line.chars().count() + 1; // +1 for \n
                            window_lines.push(std::mem::take(&mut current_line));
                            in_window_line_started = false;
                        }
                        ends_with_newline_in_window = true;
                    } else {
                        outside_line_non_empty = false;
                    }
                    total_lines += 1;
                    line_idx += 1;
                    file_ends_with_newline = true;
                    start = end + 1;
                }
                None => {
                    if in_window {
                        in_window_line_started = true;
                        append_utf8_chunk_with_tail(
                            &chunk[start..],
                            false,
                            &mut utf8_tail,
                            &mut utf8_tail_len,
                            &mut current_line,
                            &mut lossy_replaced,
                        );
                    } else {
                        outside_line_non_empty = true;
                    }
                    file_ends_with_newline = false;
                    start = chunk.len();
                }
            }
        }
    }

    // 尾部无换行的最后一行
    if in_window_line_started || outside_line_non_empty {
        if in_window_line_started {
            append_utf8_chunk_with_tail(
                &[],
                true,
                &mut utf8_tail,
                &mut utf8_tail_len,
                &mut current_line,
                &mut lossy_replaced,
            );
            if current_line.ends_with('\r') {
                current_line.pop();
            }
            total_chars += current_line.chars().count();
            window_lines.push(current_line);
            ends_with_newline_in_window = false;
        }
        total_lines += 1;
        file_ends_with_newline = false;
    }

    // 严格模式：窗口内 lossy 已置位 → 拒绝（壳口径）
    if opts.strict_encoding && lossy_replaced {
        return Err(WindowReadError::UnsupportedEncoding);
    }

    let content_truncated = total_lines > window_start0 + window_lines.len();
    let next_content_offset = (window_start0 + window_lines.len()).min(total_lines);
    let shown_lines = window_lines.len();
    let text = window_lines.join("\n");

    Ok(WindowReadResult {
        text,
        total_lines,
        total_chars,
        content_truncated,
        next_content_offset,
        shown_lines,
        window_start_line: window_start0 + 1,
        window_end_line: if shown_lines == 0 {
            window_start0
        } else {
            window_start0 + shown_lines
        },
        encoding: WindowEncoding::Utf8,
        is_binary: false,
        has_bom,
        lossy_replaced,
        file_bytes,
        ends_with_newline_in_window,
        file_ends_with_newline,
    })
}

fn decode_line_utf8(line_bytes: &[u8]) -> (String, bool) {
    match std::str::from_utf8(line_bytes) {
        Ok(s) => (s.to_string(), false),
        Err(_) => (String::from_utf8_lossy(line_bytes).into_owned(), true),
    }
}

/// KFS-11：UTF-16 流式块级解码与窗口读取（BOM 路径；调用方已确认 2 字节 BOM）。
///
/// 采用固定 16KB 缓冲按块流式读取，携带跨块奇数字节与代理对（Surrogate Pair）状态，
/// 仅物化窗口内文本行，消除全文件 `Vec<u8>` / `Vec<u16>` / `String` 驻留。
fn read_utf16_window(
    path: &Path,
    file_bytes: u64,
    little_endian: bool,
    opts: &WindowReadOptions,
) -> Result<WindowReadResult, WindowReadError> {
    let mut file = File::open(path).map_err(WindowReadError::Io)?;
    // 跳过 2 字节 UTF-16 BOM
    file.seek(SeekFrom::Start(2)).map_err(WindowReadError::Io)?;

    let window_start0 = (opts.start_line.saturating_sub(1)).max(opts.content_offset);
    let window_end0_exclusive = opts
        .end_line
        .map(|e| e.saturating_sub(1) + 1)
        .unwrap_or(window_start0.saturating_add(opts.max_lines))
        .max(window_start0);

    let estimated_window_cap = window_end0_exclusive
        .saturating_sub(window_start0)
        .min(opts.max_lines)
        .min(1024);
    let mut window_lines: Vec<String> = Vec::with_capacity(estimated_window_cap);
    let mut pending_units: Vec<u16> = Vec::with_capacity(128);
    let mut total_lines = 0_usize;
    let mut total_chars = 0_usize;
    let mut line_idx = 0_usize;
    let mut in_window_line_started = false;
    let mut outside_line_non_empty = false;
    let mut ends_with_newline_in_window = false;
    let mut file_ends_with_newline = false;
    let mut lossy_replaced = false;
    let mut pending_high_surrogate = false;
    let mut carry_byte: Option<u8> = None;
    let mut buffer = vec![0_u8; READ_CHUNK_BYTES * 2]; // 16KB 流式块缓冲

    let flush_utf16_line = |units: &mut Vec<u16>,
                            lossy_replaced: &mut bool,
                            total_chars: &mut usize,
                            with_newline: bool|
     -> String {
        if units.last() == Some(&0x000D) {
            units.pop();
        }
        let line = match String::from_utf16(units) {
            Ok(s) => s,
            Err(_) => {
                *lossy_replaced = true;
                String::from_utf16_lossy(units)
            }
        };
        *total_chars += line.chars().count() + usize::from(with_newline);
        units.clear();
        line
    };

    loop {
        let read = file.read(&mut buffer).map_err(WindowReadError::Io)?;
        if read == 0 {
            break;
        }
        let mut slice = &buffer[..read];

        // 拼接上一块遗留的单字节，确保双字节对齐
        let mut first_unit: Option<u16> = None;
        if let Some(prev) = carry_byte.take() {
            let b1 = slice[0];
            slice = &slice[1..];
            first_unit = Some(if little_endian {
                u16::from_le_bytes([prev, b1])
            } else {
                u16::from_be_bytes([prev, b1])
            });
        }
        if slice.len() % 2 == 1 {
            carry_byte = slice.last().copied();
            slice = &slice[..slice.len() - 1];
        }

        let iter = first_unit.into_iter().chain(slice.chunks_exact(2).map(|c| {
            if little_endian {
                u16::from_le_bytes([c[0], c[1]])
            } else {
                u16::from_be_bytes([c[0], c[1]])
            }
        }));

        for u in iter {
            // 流式校验 UTF-16 代理对合法性（确保严格模式下视口外非法序列同样可检出）
            if pending_high_surrogate {
                if (0xDC00..=0xDFFF).contains(&u) {
                    pending_high_surrogate = false;
                } else {
                    lossy_replaced = true;
                    pending_high_surrogate = (0xD800..=0xDBFF).contains(&u);
                }
            } else if (0xD800..=0xDBFF).contains(&u) {
                pending_high_surrogate = true;
            } else if (0xDC00..=0xDFFF).contains(&u) {
                lossy_replaced = true;
            }

            let in_window = line_idx >= window_start0 && line_idx < window_end0_exclusive;
            if u == 0x000A {
                if in_window {
                    let line = flush_utf16_line(
                        &mut pending_units,
                        &mut lossy_replaced,
                        &mut total_chars,
                        true,
                    );
                    window_lines.push(line);
                    in_window_line_started = false;
                    ends_with_newline_in_window = true;
                } else {
                    outside_line_non_empty = false;
                }
                total_lines += 1;
                line_idx += 1;
                file_ends_with_newline = true;
            } else {
                if in_window {
                    in_window_line_started = true;
                    pending_units.push(u);
                } else {
                    outside_line_non_empty = true;
                }
                file_ends_with_newline = false;
            }
        }
    }

    if carry_byte.is_some() || pending_high_surrogate {
        lossy_replaced = true;
    }

    if in_window_line_started || outside_line_non_empty {
        if in_window_line_started {
            let line = flush_utf16_line(
                &mut pending_units,
                &mut lossy_replaced,
                &mut total_chars,
                false,
            );
            window_lines.push(line);
            ends_with_newline_in_window = false;
        }
        total_lines += 1;
        file_ends_with_newline = false;
    }

    if opts.strict_encoding && lossy_replaced {
        return Err(WindowReadError::UnsupportedEncoding);
    }

    let shown_lines = window_lines.len();
    let text_window = window_lines.join("\n");
    let content_truncated = window_start0 + shown_lines < total_lines;

    Ok(WindowReadResult {
        text: text_window,
        total_lines,
        total_chars,
        content_truncated,
        next_content_offset: (window_start0 + shown_lines).min(total_lines),
        shown_lines,
        window_start_line: window_start0 + 1,
        window_end_line: if shown_lines == 0 {
            window_start0
        } else {
            window_start0 + shown_lines
        },
        encoding: if little_endian {
            WindowEncoding::Utf16Le
        } else {
            WindowEncoding::Utf16Be
        },
        is_binary: false,
        has_bom: true,
        lossy_replaced,
        file_bytes,
        ends_with_newline_in_window,
        file_ends_with_newline,
    })
}

fn empty_binary_result(file_bytes: u64) -> WindowReadResult {
    WindowReadResult {
        text: String::new(),
        total_lines: 0,
        total_chars: 0,
        content_truncated: false,
        next_content_offset: 0,
        shown_lines: 0,
        window_start_line: 1,
        window_end_line: 0,
        encoding: WindowEncoding::Binary,
        is_binary: true,
        has_bom: false,
        lossy_replaced: false,
        file_bytes,
        ends_with_newline_in_window: false,
        file_ends_with_newline: false,
    }
}

fn utf8_has_invalid_sequence(bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => false,
        // 截断的合法前缀（chunk 边界）不算非法序列
        Err(err) => err.error_len().is_some(),
    }
}

/// 二进制启发式：NUL 必判；`strict_probe`（壳）附加 magic + 控制字符占比
fn is_probably_binary(bytes: &[u8], strict_probe: bool) -> bool {
    if bytes.contains(&0) {
        return true;
    }
    if !strict_probe {
        return false;
    }
    const BINARY_MAGICS: &[&[u8]] = &[
        b"\x89PNG\r\n\x1A\n",
        b"\xFF\xD8\xFF",
        b"GIF87a",
        b"GIF89a",
        b"%PDF-",
        b"PK\x03\x04",
    ];
    if BINARY_MAGICS
        .iter()
        .any(|magic| bytes.len() >= magic.len() && bytes.starts_with(magic))
    {
        return true;
    }
    let sample_len = bytes.len().min(DEFAULT_BINARY_PROBE_BYTES);
    if sample_len == 0 {
        return false;
    }
    let suspicious = bytes[..sample_len]
        .iter()
        .filter(|byte| matches!(byte, 1..=8 | 14..=31))
        .count();
    suspicious * 100 / sample_len > 5
}

/// 按字符预算钳制窗口文本到完整行边界（与 agent-tools `clamp_text_by_lines` 同语义，
/// 供工具消费侧复用；返回 (保留文本, 保留完整行数, 是否钳制)）。
pub fn clamp_window_text_by_chars(
    text: &str,
    limit_chars: usize,
    limit_lines: usize,
) -> (String, usize, bool) {
    if text.is_empty() {
        return (String::new(), 0, false);
    }
    let mut kept: Vec<&str> = Vec::with_capacity(limit_lines.min(1024));
    let mut used_chars = 0usize;
    let mut char_truncated = false;
    let mut line_truncated = false;

    for (idx, line) in text.lines().enumerate() {
        if idx >= limit_lines {
            line_truncated = true;
            break;
        }
        if !char_truncated {
            let need = line.chars().count() + usize::from(!kept.is_empty());
            if used_chars + need <= limit_chars {
                used_chars += need;
                kept.push(line);
            } else {
                char_truncated = true;
            }
        }
    }

    let truncated = line_truncated || char_truncated;
    if !truncated {
        let total_lines = kept.len();
        // 若源文本无 `\r\n` 且未截断，直接克隆或按行连接保持原语义
        return (kept.join("\n"), total_lines, false);
    }
    (kept.join("\n"), kept.len(), true)
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use std::io::Write;

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("conex_windowed_read_{name}"));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.txt");
        let mut f = File::create(&path).unwrap();
        f.write_all(bytes).unwrap();
        path
    }

    fn default_opts() -> WindowReadOptions {
        WindowReadOptions {
            max_lines: 800,
            ..Default::default()
        }
    }

    #[test]
    fn windowed_read_utf8_line_window() {
        let content = (1..=20)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let path = write_temp("utf8_window", content.as_bytes());
        let mut opts = default_opts();
        opts.start_line = 3;
        opts.end_line = Some(5);
        let r = windowed_read(&path, &opts).unwrap();
        assert_eq!(r.text, "line 3\nline 4\nline 5");
        assert_eq!(r.total_lines, 20);
        assert!(r.content_truncated);
        assert_eq!(r.shown_lines, 3);
        assert_eq!(r.window_start_line, 3);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn windowed_read_max_lines_default_window() {
        let content = (1..=1000)
            .map(|i| format!("line {i:04}"))
            .collect::<Vec<_>>()
            .join("\n");
        let path = write_temp("utf8_max", content.as_bytes());
        let opts = default_opts();
        let r = windowed_read(&path, &opts).unwrap();
        assert_eq!(r.shown_lines, 800);
        assert!(r.content_truncated);
        assert_eq!(r.next_content_offset, 800);
        assert_eq!(r.total_lines, 1000);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn windowed_read_content_offset_resume() {
        let content = (1..=10)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let path = write_temp("utf8_off", content.as_bytes());
        let mut opts = default_opts();
        opts.max_lines = 5;
        opts.content_offset = 5;
        let r = windowed_read(&path, &opts).unwrap();
        assert_eq!(r.text, "line 6\nline 7\nline 8\nline 9\nline 10");
        assert!(!r.content_truncated);
        assert_eq!(r.next_content_offset, 10);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn windowed_read_binary_reject_and_reference() {
        let path = write_temp("bin", &[0u8, 1u8, 2u8]);
        let mut reject = default_opts();
        reject.reject_binary = true;
        reject.strict_encoding = true;
        assert!(matches!(
            windowed_read(&path, &reject),
            Err(WindowReadError::Binary)
        ));
        let mut ref_mode = default_opts();
        ref_mode.reject_binary = false;
        let r = windowed_read(&path, &ref_mode).unwrap();
        assert!(r.is_binary);
        assert_eq!(r.file_bytes, 3);
        assert_eq!(r.encoding, WindowEncoding::Binary);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn windowed_read_utf16le_window() {
        let mut bytes = vec![0xFF, 0xFE];
        for u in "u1\nu2\nu3\nu4\nu5\n".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        let path = write_temp("utf16", &bytes);
        let mut opts = default_opts();
        opts.start_line = 2;
        opts.end_line = Some(3);
        opts.allow_utf16 = true;
        let r = windowed_read(&path, &opts).unwrap();
        assert_eq!(r.encoding, WindowEncoding::Utf16Le);
        assert_eq!(r.text, "u2\nu3");
        assert_eq!(r.total_lines, 5);
        assert_eq!(r.window_start_line, 2);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn windowed_read_strict_rejects_latin1() {
        let path = write_temp("latin1", &[0x66, 0xE9, 0x67]);
        let mut opts = default_opts();
        opts.strict_encoding = true;
        opts.reject_binary = true;
        opts.allow_utf16 = false;
        assert!(matches!(
            windowed_read(&path, &opts),
            Err(WindowReadError::UnsupportedEncoding)
        ));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn windowed_read_out_of_range_empty_window() {
        let path = write_temp("oor", b"a\nb\nc\n");
        let mut opts = default_opts();
        opts.start_line = 99;
        let r = windowed_read(&path, &opts).unwrap();
        assert_eq!(r.text, "");
        assert_eq!(r.total_lines, 3);
        assert_eq!(r.next_content_offset, 3);
        assert!(!r.content_truncated);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn windowed_read_empty_file() {
        let path = write_temp("empty", b"");
        let r = windowed_read(&path, &default_opts()).unwrap();
        assert_eq!(r.text, "");
        assert_eq!(r.total_lines, 0);
        assert_eq!(r.total_chars, 0);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn windowed_read_file_too_large() {
        let path = write_temp("large", b"abcdef");
        let mut opts = default_opts();
        opts.max_file_bytes = Some(3);
        assert!(matches!(
            windowed_read(&path, &opts),
            Err(WindowReadError::FileTooLarge { .. })
        ));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn windowed_read_large_file_only_keeps_window_bytes() {
        // 200KB 文本 · 10 行窗口：结果文本远小于全文（峰值内存探针代理）
        let mut content = String::new();
        for i in 0..50_000 {
            content.push_str(&format!("L{i:06} padding-padding-padding\n"));
        }
        let path = write_temp("big", content.as_bytes());
        let mut opts = default_opts();
        opts.start_line = 1;
        opts.max_lines = 10;
        let r = windowed_read(&path, &opts).unwrap();
        assert_eq!(r.shown_lines, 10);
        assert!(r.content_truncated);
        assert!(
            r.text.len() < 1024,
            "窗口文本应远小于全文: {}",
            r.text.len()
        );
        assert!(r.total_lines > 40_000);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn clamp_window_text_respects_line_boundary() {
        let text = "aaaa\nbbbb\ncccc";
        let (shown, n, trunc) = clamp_window_text_by_chars(text, 5, 10);
        assert_eq!(shown, "aaaa");
        assert_eq!(n, 1);
        assert!(trunc);
    }

    #[test]
    fn windowed_read_utf8_spanning_chunk_boundary_strict() {
        let mut content = String::new();
        while content.len() < 8190 {
            content.push_str("这是一个用于测试 8KB chunk 边界的行，包含中文字符。\n");
        }
        content.push_str("【跨越边界】这是一行非常长的包含中文多字节字符的行，它正好跨越了 8192 字节边界，验证拼接无损。\n");
        content.push_str("这是边界之后的后续行。\n");

        let path = write_temp("spanning_utf8", content.as_bytes());
        let mut opts = default_opts();
        opts.strict_encoding = true;
        let r = windowed_read(&path, &opts).expect("应成功读取跨越 8KB 边界的 UTF-8 文本");
        assert!(!r.lossy_replaced);
        assert!(r
            .text
            .contains("【跨越边界】这是一行非常长的包含中文多字节字符的行"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn windowed_read_agents_md_real_file() {
        let repo_agents = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("AGENTS.md");
        if repo_agents.exists() {
            let mut opts = default_opts();
            opts.strict_encoding = true;
            let r = windowed_read(&repo_agents, &opts)
                .expect("AGENTS.md 必须可由 windowed_read 严格模式成功读取");
            assert!(!r.lossy_replaced);
            assert!(r.text.contains("Conex / Crish — Agent 协作指令"));
        }
    }

    #[test]
    fn utf8_char_boundary_truncation_never_panics_or_corrupts_multibyte() {
        // 包含 ASCII(1B)、拉丁扩展(2B: é)、中文(3B: 中)、Emoji(4B: 🚀)
        let sample = "Aé中🚀B";
        let bytes = sample.as_bytes();
        // 合法字符边界偏移集合：0(""), 1("A"), 3("Aé"), 6("Aé中"), 10("Aé中🚀"), 11("Aé中🚀B")
        let expected_boundaries = [0, 1, 1, 3, 3, 3, 6, 6, 6, 6, 10, 11, 11];
        for (limit, &expected) in expected_boundaries.iter().enumerate() {
            let truncated_str = truncate_utf8_at_char_boundary(sample, limit);
            assert_eq!(truncated_str.len(), expected, "str limit={limit}");
            let truncated_bytes = truncate_utf8_bytes_at_char_boundary(bytes, limit);
            assert_eq!(truncated_bytes.len(), expected, "bytes limit={limit}");
            assert!(
                std::str::from_utf8(truncated_bytes).is_ok(),
                "截断后的字节切片必须是合法 UTF-8 (limit={limit})"
            );
        }
    }

    #[test]
    fn windowed_read_utf8_4byte_emoji_straddling_every_chunk_offset() {
        // 验证 4 字节 UTF-8 Emoji 在 8192 字节边界的任意切分位置（1+3、2+2、3+1）均无损拼接
        for prefix_pad in [8189_usize, 8190, 8191] {
            let mut content = "x".repeat(prefix_pad);
            content.push_str("🚀🎉中文字段跨越边界\r\n第二行正常内容\n");
            let path = write_temp(&format!("emoji_boundary_{prefix_pad}"), content.as_bytes());
            let mut opts = default_opts();
            opts.strict_encoding = true;
            let r = windowed_read(&path, &opts).unwrap();
            assert!(!r.lossy_replaced, "pad={prefix_pad} 不应触发 lossy 替换");
            assert_eq!(r.total_lines, 2);
            assert!(r.text.ends_with("🚀🎉中文字段跨越边界\n第二行正常内容"));
            let _ = std::fs::remove_dir_all(path.parent().unwrap());
        }
    }

    #[test]
    fn windowed_read_utf16_streaming_surrogate_pairs_and_window() {
        // 构造跨越 16KB 块边界的 UTF-16BE 内容（含 4 字节代理对 Emoji 🚀 与 CRLF）
        let mut bytes = vec![0xFE, 0xFF]; // UTF-16BE BOM
        let mut lines_expected = Vec::new();
        for i in 1..=300 {
            let line = format!("第{i:04}行-🚀-测试UTF16流式块解码");
            lines_expected.push(line.clone());
            for u in format!("{line}\r\n").encode_utf16() {
                bytes.extend_from_slice(&u.to_be_bytes());
            }
        }
        let path = write_temp("utf16be_stream", &bytes);
        let mut opts = default_opts();
        opts.start_line = 150;
        opts.end_line = Some(152);
        opts.allow_utf16 = true;
        opts.strict_encoding = true;
        let r = windowed_read(&path, &opts).unwrap();
        assert_eq!(r.encoding, WindowEncoding::Utf16Be);
        assert_eq!(r.total_lines, 300);
        assert_eq!(r.shown_lines, 3);
        assert!(r.content_truncated);
        assert!(!r.lossy_replaced);
        assert_eq!(r.text, lines_expected[149..152].join("\n"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
